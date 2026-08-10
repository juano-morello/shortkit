import 'reflect-metadata';

import { RequestMethod } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import helmet from 'helmet';

import { AppModule } from './app.module';
import { assertRuntimeRoleCannotBypassRls } from './db/rls';
import { readBuildCommitSha } from './health/build-commit';
import { errorLogFields, logger } from './observability/logger';

const DEFAULT_PORT = 3001;
const MIN_PORT = 1;
const MAX_PORT = 65535;

/**
 * How long precondition 2 gets to REACH the database before boot gives up (F-245).
 *
 * GC-3 pins Neon's free tier, whose compute scales to zero, and `db/client.ts` sets
 * `connectionTimeoutMillis` to 2000 — which F-149 established pg-pool applies to
 * ESTABLISHMENT, not only to queue wait. A cold wake that takes longer than that used to
 * exit the process, so the wake itself became the outage.
 *
 * Twenty seconds, and the ceiling is not arbitrary: `fly.toml`'s health check
 * `grace_period` is set to 30s so that a boot spending this whole budget still binds
 * before the platform starts failing the machine. Raising one means raising the other.
 */
const DATABASE_REACHABLE_BUDGET_MS = 20_000;

/** First backoff, then doubling to the cap. A local Postgres is usually up on attempt 2. */
const DATABASE_RETRY_MIN_MS = 250;
const DATABASE_RETRY_MAX_MS = 4000;

/**
 * The prefix every verdict `assertRuntimeRoleCannotBypassRls()` reaches ON ITS OWN begins
 * with: "DATABASE_URL connects as '…'" and "DATABASE_URL connected as a role that pg_roles
 * does not list." Anything else that function rejects with came from the driver — a refused
 * connection, a DNS failure, pg-pool's `timeout exceeded when trying to connect` — and is
 * a failure to ANSWER rather than an unsafe answer.
 *
 * FAILS SAFE IF IT DRIFTS. `db/rls.ts` is TASK-005's and its wording could change. A
 * verdict this stops recognising is treated as unreachable, so it is retried and then
 * refuses anyway — twenty seconds later, with a less precise log line. The reverse, a
 * connection failure mistaken for a verdict, is what would be dangerous, and no driver
 * error opens with this text.
 */
const RLS_VERDICT_PREFIX = 'DATABASE_URL connect';

type BootPrecondition = 'database_reachable' | 'runtime_role_cannot_bypass_rls';

/**
 * Carries WHICH precondition refused onto the log line. F-245: "the database could not be
 * reached" and "the runtime role can bypass RLS" were indistinguishable, and they call for
 * opposite responses — wait, versus fix the DSN and redeploy.
 */
class BootPreconditionError extends Error {
  readonly precondition: BootPrecondition;

  constructor(precondition: BootPrecondition, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'BootPreconditionError';
    this.precondition = precondition;
  }
}

/**
 * `PORT=""` is common when an unset variable is expanded into an env file, and
 * `??` would hand the empty string to `listen`, which Express reads as a pipe
 * path. Anything that is not a port number falls back to the default.
 */
function resolvePort(value: string | undefined): number {
  const port = Number(value);

  if (value === undefined || value.trim() === '' || !Number.isInteger(port)) {
    return DEFAULT_PORT;
  }

  if (port < MIN_PORT || port > MAX_PORT) {
    return DEFAULT_PORT;
  }

  return port;
}

/**
 * Held outside `bootstrap` so a failure raised after `NestFactory.create` can
 * still close what the container already opened. Once a provider holds a handle
 * — a pg pool, a Redis client, a timer — an unclosed container keeps the event
 * loop alive, and a process that only sets `exitCode` never exits: the platform
 * sees a live process, never restarts it, and the API is down while looking up.
 */
let app: INestApplication | undefined;

/**
 * Everything that has to be true before the process is allowed to serve, in the order it
 * is cheapest to find out. Both members refuse by throwing, which lands in `bootstrap`'s
 * `catch` below and exits non-zero — a Fly machine that exits non-zero fails the deploy
 * and the previous version keeps serving.
 *
 * ORDER, and why (recorded because F-116 asked for it):
 *
 *  1. `readBuildCommitSha()` — ADR-0027. A string comparison against a regex, no I/O, no
 *     allocation, no network. A mis-built image therefore fails before the process opens a
 *     database connection. ADR-0027 fixes this pair's order explicitly; the rest of the
 *     sequence was left open.
 *  2. `assertRuntimeRoleCannotBypassRls()` — F-116, ADR-0003. One transaction against
 *     `pg_roles` and `pg_class`. TASK-005 built it and disclosed that nothing called it,
 *     so until now a `DATABASE_URL` pointing at a superuser or any `BYPASSRLS` role
 *     started the API normally and every tenant-scoped query silently returned every
 *     tenant's rows — the one condition GC-5 exists to make impossible. The integration
 *     suite cannot catch it: `rls-fixture.ts` checks the role's attributes before the
 *     tests run, so it proves the POLICIES work while nothing proved the deployed PROCESS
 *     refused the wrong role.
 *
 * Both run before `NestFactory.create`. A container that has resolved its providers holds
 * handles, and there is nothing either check needs from the module graph.
 *
 * Refusal, not a warning. A process that logs and then serves traffic with RLS disabled is
 * worse than one that never came up, because only the second is visible.
 *
 * ============================================================================
 * "COULD NOT ANSWER" IS NOT "ANSWERED UNSAFELY" (F-245). ACCEPTED DECISION.
 * ============================================================================
 *
 * F-116 ruled on the unsafe-ANSWER case only, and this is where its ordering rationale was
 * recorded, so the cannot-ANSWER case is settled here beside it.
 *
 * Precondition 2 rejects for every reason `pg` can reject, and the first version of this
 * function treated all of them alike. Two facts make that expensive: GC-3 pins Neon's free
 * tier, which scales its compute to zero, and F-149 established that `db/client.ts`'s
 * 2000 ms `connectionTimeoutMillis` bounds connection ESTABLISHMENT. A cold wake at
 * restart therefore exited 1 — and before this file opened any connection at boot, the
 * same outage left the process up with `/health` answering 200, self-recovering when the
 * database came back.
 *
 * WHAT IT DOES NOW:
 *
 *  - A rejection carrying an unsafe VERDICT refuses immediately. That is F-116 unchanged;
 *    retrying a wrong role only delays a refusal that is already certain.
 *  - A rejection that is a failure to REACH the database is retried with backoff for
 *    `DATABASE_REACHABLE_BUDGET_MS`, so the refusal fires on a wrong role rather than on a
 *    slow one. Every attempt writes a `warn` line naming the attempt and the wait.
 *  - The two refusals are distinguishable by machine, not only by prose: the line carries
 *    `boot_precondition: "database_reachable"` or `"runtime_role_cannot_bypass_rls"`.
 *
 * AND THE PART THAT IS A JUDGEMENT RATHER THAN A MECHANISM. After the budget is spent the
 * process still exits 1. Twenty seconds of consecutive unreachability is an outage rather
 * than a cold wake, and a process that boots without ever having answered precondition 2
 * is a process serving tenant data with RLS unverified — the exact hole F-116 exists to
 * close, and one nothing later re-checks. The cost is real and is priced in `fly.toml`:
 * `auto_start_machines` is `true`, so a machine that exhausted Fly's restart budget during
 * a database outage is woken by the next incoming request instead of by a human.
 *
 * Reversing this decision is one constant and one boolean; a reviewer who wants the
 * opposite trade should say so rather than widening the budget.
 */
async function assertBootPreconditions(): Promise<void> {
  readBuildCommitSha();

  await assertRuntimeRoleIsSafe();
}

/**
 * Precondition 2, with the reachability half retried. See the block above for why the two
 * halves are separated and why the budget ends in a refusal.
 */
async function assertRuntimeRoleIsSafe(): Promise<void> {
  const deadline = Date.now() + DATABASE_REACHABLE_BUDGET_MS;
  let wait = DATABASE_RETRY_MIN_MS;
  let attempts = 0;

  for (;;) {
    attempts += 1;

    try {
      await assertRuntimeRoleCannotBypassRls();
      return;
    } catch (error: unknown) {
      if (error instanceof Error && error.message.startsWith(RLS_VERDICT_PREFIX)) {
        // The check answered, and the answer is unsafe. Its own message is the diagnosis
        // and is kept verbatim; the original is on `cause`.
        throw new BootPreconditionError('runtime_role_cannot_bypass_rls', error.message, {
          cause: error,
        });
      }

      if (Date.now() + wait >= deadline) {
        throw new BootPreconditionError(
          'database_reachable',
          `the database could not be reached in ${String(attempts)} attempt(s) over ` +
            `${String(DATABASE_REACHABLE_BUDGET_MS)}ms, so whether the runtime role can ` +
            'bypass row-level security is unknown and the process will not serve. Last ' +
            `failure: ${describeCause(error)}`,
          { cause: error },
        );
      }

      logger.warn(
        {
          boot_precondition: 'database_reachable',
          attempt: attempts,
          retry_in_ms: wait,
          ...errorLogFields(error, { includeMessage: true }),
        },
        'the database could not be reached at boot, retrying',
      );

      await delay(wait);
      wait = Math.min(wait * 2, DATABASE_RETRY_MAX_MS);
    }
  }
}

/**
 * `includeMessage: true` throughout this file's boot path, for the reason written at the
 * `bootstrap().catch` below: nothing has served a request, and the message is the
 * diagnosis. A `pg` connect failure names the database host and port, which is
 * infrastructure and is what the operator needs.
 */
function describeCause(error: unknown): string {
  const { err_name, err_message } = errorLogFields(error, { includeMessage: true });

  return err_message === undefined ? err_name : `${err_name}: ${err_message}`;
}

async function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function bootstrap(): Promise<void> {
  await assertBootPreconditions();

  app = await NestFactory.create(AppModule);

  // ============================================================================
  // SECURITY HEADERS (F-243 clause 2, ADR-0022, `logging-and-headers.md` invariant 4).
  // ============================================================================
  //
  // ON THE APP AND BEFORE THE GLOBAL PREFIX, which is the contract's own wording and is
  // load-bearing rather than stylistic: this is Express middleware on the underlying
  // instance, so it runs for EVERY response the process writes — the routed 200, the
  // branded 404 `ApiExceptionFilter` builds, and anything mounted outside the Nest module
  // graph (ADR-0013). Middleware registered inside a module covers the routed responses and
  // misses the error ones, which is the half that goes wrong quietly.
  //
  // `frameguard: { action: 'deny' }` IS NOT HELMET'S DEFAULT. helmet sends `SAMEORIGIN`;
  // the contract's header table says `DENY`, and the table wins. Everything else on that
  // table is helmet's own default and is left alone: HSTS at
  // `max-age=31536000; includeSubDomains` WITH NO `preload` — the contract refuses preload
  // because submission is close to irreversible and the apex domain is unregistered —
  // `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`.
  //
  // AND `frame-ancestors` HAD TO MOVE WITH IT, WHICH IS WHY THERE ARE NOW TWO OVERRIDES
  // (F-280). helmet's default CSP carries `frame-ancestors 'self'`
  // (`helmet/index.cjs:19`, `getDefaultDirectives`), and a CSP `frame-ancestors` OVERRIDES
  // `X-Frame-Options` in every browser that implements CSP — so the one option deliberately
  // overridden above was the one the client discarded, and the contract's `DENY` was
  // satisfied on the wire and defeated in the browser. `useDefaults: true` is helmet's own
  // default and is written out anyway, because this call now names two policies and a reader
  // has to see that the other ten directives are left as helmet ships them.
  //
  // The redirect path's two documented exceptions (`Referrer-Policy: unsafe-url` on the 302,
  // a tighter CSP on the branded 404) belong to `redirect-resolution.md`, and the TASK that
  // builds that route sets them per-response over these defaults. THAT CSP MUST CARRY ITS OWN
  // `frame-ancestors 'none'`: the directive does not fall back to `default-src`, so a
  // per-response CSP that replaces this one drops the protection this line adds.
  app.use(
    helmet({
      frameguard: { action: 'deny' },
      contentSecurityPolicy: { useDefaults: true, directives: { 'frame-ancestors': ["'none'"] } },
    }),
  );

  // ADR-0006: every controller answers under /api. GET /health stays at the
  // root so the platform health check never depends on the API surface.
  app.setGlobalPrefix('api', {
    exclude: [{ path: 'health', method: RequestMethod.GET }],
  });

  await app.listen(resolvePort(process.env.PORT));
}

bootstrap().catch(async (error: unknown) => {
  // A failed start is otherwise a bare unhandled rejection with no context. It now goes
  // through the same pino logger as every request line, which is what
  // `logging-and-headers.md` means by "nothing may opt out": before this it carried no
  // `level`, no `service`, no `env`, no timestamp and no redaction.
  //
  // `includeMessage: true`, and it is the exception rather than the rule. Nothing has
  // served a request at this point, so no message on this path can carry request-derived
  // data — and the message IS the diagnosis here, since every throwable that reaches this
  // line is one of our own boot refusals: "GIT_COMMIT_SHA must be the full 40-character
  // …", "DATABASE_URL connects as 'postgres', which is exempt from row-level security".
  // Withholding it would turn a self-explaining refusal into a puzzle. The full policy,
  // and what it costs, is in `observability/logger.ts`.
  //
  // The frames come back on this line, which F-064 had removed. They are safe because
  // `errorLogFields` strips the `name: message` header out of them; F-064's objection was
  // that a stack is the one field path-based redaction cannot reach, and the header line
  // was the only part of a stack that carries anything worth reaching.
  //
  // `boot_precondition` is present only when a precondition refused, and names which one
  // (F-245). "database_reachable" means the check could not be answered and the operator
  // waits; "runtime_role_cannot_bypass_rls" means it was answered unsafely and the DSN has
  // to change. Nothing else on this line separates them.
  logger.error(
    {
      ...(error instanceof BootPreconditionError
        ? { boot_precondition: error.precondition }
        : {}),
      ...errorLogFields(error, { includeMessage: true }),
    },
    'the API failed to start',
  );

  // Release the container's handles before exiting. A close that itself fails
  // must not become a second unhandled rejection, which would strand the exit.
  await app?.close().catch(() => undefined);

  // pino's default destination is a synchronous write to fd 1, verified through a pipe on
  // pino 10.3.1 / Node 24.19, so the line above survives this call. That is why the
  // hand-rolled promise around `process.stderr.write` that used to sit here is gone rather
  // than ported: it existed to defeat exactly this drop, and pino already does.
  process.exit(1);
});
