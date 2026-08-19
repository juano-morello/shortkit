import 'reflect-metadata';

import { RequestMethod } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { toNodeHandler } from 'better-auth/node';
import express from 'express';
import helmet from 'helmet';

import { AppModule } from './app.module';
import { authBodyCap } from './auth/auth-body-cap';
import { authRateLimit } from './auth/auth-rate-limit';
import { bindEmailRateLimitPort } from './auth/email-rate-limit-hook';
import {
  AuthBindingError,
  assertAuthRoleSeparation,
  assertBetterAuthSecretConfigured,
  assertBetterAuthUrlConfigured,
  assertBffProxySecretConfigured,
  assertTrustedClientIpHeaderConfigured,
  assertWebAppOriginsConfigured,
} from './auth/boot-assertions';
import { AUTH_RATE_LIMIT_PORT } from './auth/ports/auth-rate-limit.port';
import type { AuthRateLimitPort } from './auth/ports/auth-rate-limit.port';
import { RedisBindingError, assertRedisConfigured } from './cache/redis-client';
import { assertRuntimeRoleCannotBypassRls } from './db/rls';
import { readBuildCommitSha } from './health/build-commit';
import { MailBindingError, assertMailTransportConfigured } from './mail/mail-transport';
import { errorLogFields, logger } from './observability/logger';
import { REDIRECT_ROUTE_PREFIX_EXCLUSION } from './redirect/redirect.module';

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

/**
 * The same arrangement for `assertAuthRoleSeparation()` (ADR-0050, TASK-004): every verdict
 * it reaches on its own opens with this literal — "DATABASE_AUTH_URL connects as '…'",
 * "DATABASE_AUTH_URL connects to a database where … do not exist" — and anything else came
 * from the driver and is retried. Checked not to collide with the one above in either
 * direction: `'DATABASE_AUTH_URL connects as x'.startsWith('DATABASE_URL connect')` is
 * `false`, and no `DATABASE_URL` verdict starts with `DATABASE_AUTH_URL`.
 *
 * Duplicated rather than shared with `RLS_VERDICT_PREFIX` on purpose (F-030): that function
 * stays parameterless and `DATABASE_URL`-only, and generalising its wording to cover a second
 * DSN would break the match in the expensive direction.
 */
const AUTH_VERDICT_PREFIX = 'DATABASE_AUTH_URL connect';

/**
 * The size cap on the Better Auth mount (ADR-0013). 32 KiB, and it is the ONLY body bound on
 * `/api/auth/*`: `express.json({ limit })` below runs after the mount and never sees these
 * requests, and `better-call` bounds nothing when handed no `Content-Length`.
 */
const AUTH_BODY_MAX_BYTES = 32 * 1024;

/** The Nest routes' body limit, `logging-and-headers.md`'s "none larger than 100 KiB". */
const NEST_BODY_LIMIT = '100kb';

type BootPrecondition =
  | 'database_reachable'
  | 'runtime_role_cannot_bypass_rls'
  | 'auth_role_separation';

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
 * is cheapest to find out. Every member refuses by throwing, which lands in `bootstrap`'s
 * `catch` below and exits non-zero — a Fly machine that exits non-zero fails the deploy
 * and the previous version keeps serving.
 *
 * ORDER, and why (recorded because F-116 asked for it):
 *
 *  1. `readBuildCommitSha()` — ADR-0027. A string comparison against a regex, no I/O, no
 *     allocation, no network. A mis-built image therefore fails before the process opens a
 *     database connection. ADR-0027 fixes this pair's order explicitly; the rest of the
 *     sequence was left open.
 *  2. The three auth bindings — ADR-0051, ADR-0058, ADR-0059. Three `process.env` reads
 *     and three string comparisons, so they belong in the same class as the SHA check and
 *     sit before the database one: a misconfigured secret refuses in two milliseconds
 *     rather than after a twenty-second database budget on a machine where the database is
 *     also down. Without `BETTER_AUTH_SECRET` better-auth signs every JWT with a constant
 *     published on npm (F-020); without `BETTER_AUTH_URL` the issuer and the session
 *     cookie's `Secure` flag are taken from the caller's `Host` header and from `NODE_ENV`.
 *
 *     ============================================================================
 *     WAVE 3 MUST REACH `auth.config.ts` THROUGH A DYNAMIC IMPORT INSIDE `bootstrap()`.
 *     ============================================================================
 *
 *     CORRECTED 2026-08-16 (F-206's sibling, F-210), because the claim that stood here was
 *     measured false. It said the accessors and these assertions produce an identical log
 *     line either way, which is ADR-0058's and `auth-config-surface.md:68-72`'s reasoning
 *     for one shared `AuthBindingError`. They do not. A STATIC import of `auth.config.ts`
 *     at this file's module scope runs `betterAuth({ secret: betterAuthSecret(), … })`
 *     during module evaluation, which is BEFORE `bootstrap()` is ever called and therefore
 *     outside `bootstrap().catch` — measured with wave 3's shape and an empty secret: a raw
 *     uncaught stack on stderr, no pino line, no `boot_precondition`, no `service`, no
 *     `env`, and the refusal crossing the process boundary through Node's uncaught handler
 *     rather than through the one censoring mechanism ADR-0028 requires. It still fails
 *     closed; what is lost is the labelled line, on the preconditions whose whole
 *     justification is telling an operator WHICH binding refused.
 *
 *     So TASK-004 mounts through `const { auth } = await import('./auth/auth.config')`
 *     inside `bootstrap()`, after `assertBootPreconditions()` has run — which is what
 *     `bootstrap()` below does. Then these three assertions fire first and the accessors
 *     never get the chance to throw uncaught, the shared error class keeps the meaning
 *     ADR-0058 gives it, and the one-way import rule (`boot-assertions.ts` never imports
 *     `auth.config.ts`) is untouched. With a static import they are not redundant — they
 *     are dead, and the labelled refusal goes with them.
 *
 *  2b. The two trust-boundary assertions — ADR-0040, F-380, F-385 (TASK-004, wave 3). Two
 *     more `process.env` reads, so they sit with the bindings and ahead of anything that
 *     opens a connection. Called UNCONDITIONALLY; each keys on its own declared variable
 *     (`CLIENT_TRUST_BOUNDARY`, `BFF_TRUST_BOUNDARY`) inside, and NEITHER READS `NODE_ENV`
 *     — `Dockerfile:83` sets that to `production` in the image `docker compose` runs, and
 *     a gate on it refuses to boot `api` on a laptop. Unset and `direct` assert nothing, so
 *     the compose stack, which declares neither, boots.
 *
 *  2c. The mail transport — ADR-0017, F-386 (TASK-1b-02, item 1b). One more `process.env`
 *     read in the same class, and the same rule with absence INVERTED: validity of
 *     `MAIL_TRANSPORT` is asserted unconditionally, `resend` requires `RESEND_API_KEY` and
 *     `MAIL_FROM`, and unset selects `NoopMailSender` rather than asserting nothing — the
 *     permissive branch here spends money and reaches a stranger's inbox, so absence has to
 *     land on the sender that can do neither. Its refusal is `MailBindingError`, mapped in
 *     the catch below like `AuthBindingError`; when it resolves `none` it writes ONE warn
 *     line carrying `boot_precondition: 'mail_transport'`, which is the only local evidence
 *     a deployment that forgot the variable ever gets. NEVER READS `NODE_ENV`, for the
 *     reason 2b gives.
 *
 *  2d. The redirect cache — ADR-0012, D-2-09 (TASK-2-03, item 2). Two more `process.env`
 *     reads and a `new URL()`, so it sits in the class above and ahead of anything that
 *     opens a connection, and it follows 2c's inverted-absence shape exactly: the VALIDITY
 *     of `REDIS_URL` is asserted unconditionally, `REDIS_KEY_NAMESPACE` is REQUIRED only
 *     when a URL is declared (`redirect-cache.md` — a defaulted namespace shares a key space
 *     with whatever else points at that instance, which is a staging host record served to
 *     production visitors), and UNSET binds `UnavailableRedirectCache` with ONE warn line
 *     carrying `boot_precondition: 'redirect_cache'`. Absence is not a refusal here because
 *     ADR-0012's whole posture is that the redirect serves without Redis: refusing to boot
 *     on a missing cache would convert a degraded path into an outage. Its refusal is
 *     `RedisBindingError`, mapped in the catch below. NEVER READS `NODE_ENV`.
 *
 *     REACHABILITY IS DELIBERATELY NOT A PRECONDITION. The client is built inside the module
 *     graph and connects there; an unreachable instance degrades every read to
 *     `'unavailable'`, which the redirect answers from Postgres (AC-2-29). Nothing here
 *     waits for it, and no boot budget is spent on it.
 *
 *  3. `assertRuntimeRoleCannotBypassRls()` — F-116, ADR-0003. One transaction against
 *     `pg_roles` and `pg_class`. TASK-005 built it and disclosed that nothing called it,
 *     so until now a `DATABASE_URL` pointing at a superuser or any `BYPASSRLS` role
 *     started the API normally and every tenant-scoped query silently returned every
 *     tenant's rows — the one condition GC-5 exists to make impossible. The integration
 *     suite cannot catch it: `rls-fixture.ts` checks the role's attributes before the
 *     tests run, so it proves the POLICIES work while nothing proved the deployed PROCESS
 *     refused the wrong role.
 *
 *  4. `assertAuthRoleSeparation()` — ADR-0050, F-030, F-031 (TASK-004, wave 3). One
 *     catalogue query per direction: as `shortkit_auth` on `DATABASE_AUTH_URL`, that the
 *     role reaches no tenant-scoped table and is `NOBYPASSRLS`, not superuser and owns
 *     nothing; as the application role on `DATABASE_URL`, that it holds NO privilege — the
 *     whole set, not `SELECT` — on any of Better Auth's five tables. It is the first
 *     precondition that needs a second connection before the process serves, and its
 *     reachability half is retried on the same budget and by the same loop as the RLS
 *     check, for the same reason: a cold wake is not a wrong grant.
 *
 * All of them run before `NestFactory.create`. A container that has resolved its providers
 * holds handles, and there is nothing any check needs from the module graph.
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
 *  - The refusals are distinguishable by machine, not only by prose: the line carries
 *    `boot_precondition: "database_reachable"`, `"runtime_role_cannot_bypass_rls"` or, since
 *    wave 3, `"auth_role_separation"`.
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

  assertBetterAuthSecretConfigured(process.env);
  assertBetterAuthUrlConfigured(process.env);
  assertWebAppOriginsConfigured(process.env);

  assertTrustedClientIpHeaderConfigured(process.env);
  assertBffProxySecretConfigured(process.env);

  assertMailTransportConfigured(process.env);

  assertRedisConfigured(process.env);

  // ONE DEADLINE FOR BOTH DATABASE CHECKS. `DATABASE_REACHABLE_BUDGET_MS` is sized as the
  // whole boot's reachability allowance (see its declaration), so the second check inherits
  // whatever the first left rather than opening a budget of its own — otherwise two cold
  // wakes could take the boot to twice the number that constant was calibrated against.
  const deadline = Date.now() + DATABASE_REACHABLE_BUDGET_MS;

  await answeredOrRetried(deadline, {
    precondition: 'runtime_role_cannot_bypass_rls',
    verdictPrefix: RLS_VERDICT_PREFIX,
    unknown: 'whether the runtime role can bypass row-level security',
    check: assertRuntimeRoleCannotBypassRls,
  });

  await answeredOrRetried(deadline, {
    precondition: 'auth_role_separation',
    verdictPrefix: AUTH_VERDICT_PREFIX,
    unknown: 'whether the auth role and the application role are separated',
    check: assertAuthRoleSeparation,
  });
}

interface RetriedPrecondition {
  /** What the log line names when the check ANSWERS unsafely. */
  readonly precondition: BootPrecondition;
  /** The literal every verdict the check reaches on its own opens with. */
  readonly verdictPrefix: string;
  /** What stays unknown when the budget is spent, for the `database_reachable` message. */
  readonly unknown: string;
  readonly check: () => Promise<void>;
}

/**
 * The two database preconditions, with the reachability half retried. See the block above
 * for why the two halves are separated and why the budget ends in a refusal.
 *
 * ONE LOOP FOR BOTH (ADR-0050), AND ONE DEADLINE. The caller computes `deadline` once from
 * `DATABASE_REACHABLE_BUDGET_MS`, so the two checks together spend at most that budget: a
 * cold wake met by the first leaves the second whatever remains, and a boot that exhausts it
 * refuses at the same wall-clock number whichever DSN was the slow one. The prefixes are what
 * tell an answer from a failure to answer, and each check brings its own; the loop does not
 * know which DSN it is waiting on beyond that.
 */
async function answeredOrRetried(deadline: number, target: RetriedPrecondition): Promise<void> {
  let wait = DATABASE_RETRY_MIN_MS;
  let attempts = 0;

  for (;;) {
    attempts += 1;

    try {
      await target.check();
      return;
    } catch (error: unknown) {
      if (error instanceof Error && error.message.startsWith(target.verdictPrefix)) {
        // The check answered, and the answer is unsafe. Its own message is the diagnosis
        // and is kept verbatim; the original is on `cause`.
        throw new BootPreconditionError(target.precondition, error.message, { cause: error });
      }

      if (Date.now() + wait >= deadline) {
        throw new BootPreconditionError(
          'database_reachable',
          `the database could not be reached in ${String(attempts)} attempt(s) before the ` +
            `${String(DATABASE_REACHABLE_BUDGET_MS)}ms boot budget ran out, so ${target.unknown} is unknown ` +
            `and the process will not serve. Last failure: ${describeCause(error)}`,
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

  // ============================================================================
  // `bodyParser: false` IS A GLOBAL SETTING MADE FOR ONE ROUTE (ADR-0013).
  // ============================================================================
  //
  // Better Auth reads the raw request stream, so nothing may parse a body before its mount
  // below. Nest's own parsers are therefore off for the whole app, and `express.json` /
  // `express.urlencoded` are registered by hand AFTER the mount. ANY MIDDLEWARE ADDED
  // BETWEEN `NestFactory.create` AND THOSE TWO `app.use` CALLS RECEIVES AN UNPARSED BODY,
  // AND THE SYMPTOM IS `req.body === undefined` RATHER THAN AN ERROR. helmet below is fine —
  // it reads no body. Anything else goes after the parsers.
  app = await NestFactory.create(AppModule, { bodyParser: false });

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

  // ============================================================================
  // THE AUTH MOUNT (ADR-0013). ONE REGISTRATION, AND THE ORDERING IS THE WHOLE TRICK.
  // ============================================================================
  //
  // On the raw Express instance, OUTSIDE the Nest module graph and AHEAD of every body
  // parser: no Nest guard, interceptor or filter applies to it, `RateLimitGuard` cannot see
  // it, and `express.json`'s limit does not reach it. The two middlewares in front of the
  // handler are the price of that and are what keep the pre-auth credential surface bounded
  // (F-004): `authBodyCap` refuses or cuts an oversized body WITHOUT parsing or consuming the
  // stream, and `authRateLimit` charges an IP-keyed bucket from HEADERS ONLY, through
  // `AUTH_RATE_LIMIT_PORT` (F-024) and never a store client, with the principal from
  // `resolveRateLimitPrincipal` (F-031) — and where that is `null`, which is every
  // environment that exists today (ADR-0040), the bucket does not run.
  //
  // helmet is registered above, so it covers this mount: its docblock's "anything mounted
  // outside the Nest module graph" was written for exactly this line.
  //
  // `auth.config.ts` IS REACHED HERE, DYNAMICALLY, AND NOWHERE EARLIER (F-210). It evaluates
  // `betterAuth({ secret: betterAuthSecret(), … })` at module scope, so a static import at
  // the top of this file would run the accessors during module evaluation — before
  // `bootstrap()`, outside `bootstrap().catch`, and the refusal would be a raw stack on
  // stderr with no `boot_precondition`. Awaited after `assertBootPreconditions()`, the three
  // bindings have already answered and the accessors cannot throw. This is the one file that
  // may import it (`better-auth-database-callers.spec.ts` scan 5), because the composed
  // instance is a second handle on the auth role.
  //
  // NestJS 11 ships Express 5, whose wildcard syntax is `{*splat}`, not `*`.
  const { auth } = await import('./auth/auth.config');
  const authRateLimitPort = app.get<AuthRateLimitPort>(AUTH_RATE_LIMIT_PORT);
  // The email-keyed sign-in bucket runs INSIDE Better Auth (`hooks.before`, F-019) and can
  // inject nothing, so it is handed the SAME port instance the Express middleware charges —
  // one limiter, one map (TASK-1b-09, D-15). Bound before the mount so no request can reach
  // the hook unbound; unbound it would degrade open with a warn line rather than 5xx.
  bindEmailRateLimitPort(authRateLimitPort);
  const server: express.Express = app.getHttpAdapter().getInstance();

  server.all(
    '/api/auth/{*splat}',
    authBodyCap({ maxBytes: AUTH_BODY_MAX_BYTES }),
    authRateLimit(authRateLimitPort),
    toNodeHandler(auth),
  );

  // The parsers Nest would have registered, at the limit `rate-limit.md` invariant 8 fixes
  // for Nest handlers. After the mount, so they never touch an auth request's stream.
  app.use(express.json({ limit: NEST_BODY_LIMIT }));
  app.use(express.urlencoded({ extended: true, limit: NEST_BODY_LIMIT }));

  // ADR-0006: every controller answers under /api. GET /health stays at the
  // root so the platform health check never depends on the API surface.
  //
  // AND SINCE TASK-2-06, SO DOES THE REDIRECT'S `GET /:slug`. The visitor surface is a
  // public URL a person pastes into a browser, so it cannot carry an `/api` segment
  // (ADR-0006, D-2-13). The exclusion is IMPORTED rather than written out: its path is not
  // the obvious `':slug'` but an escaped literal, because Nest matches an exclusion against
  // every route's DECLARED path and the unescaped parameter pattern matches every
  // one-segment GET route in the application, `GET /api/links` included.
  // `redirect/redirect.module.ts` records the measurement; `app.module.spec.ts` pins both
  // directions of it.
  app.setGlobalPrefix('api', {
    exclude: [{ path: 'health', method: RequestMethod.GET }, REDIRECT_ROUTE_PREFIX_EXCLUSION],
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
  // (F-245). "database_reachable" means a check could not be answered and the operator
  // waits; "runtime_role_cannot_bypass_rls" and "auth_role_separation" mean it was answered
  // unsafely and a DSN or a grant has to change. Nothing else on this line separates them.
  //
  // `AuthBindingError.binding` is the third source of that field and carries the same
  // words the assertions above use (ADR-0058) — the three bindings, and since wave 3 the
  // two trust boundaries. It is mapped here rather than only in the assertions so that the
  // accessors inside `auth.config.ts` — which raise the same class — reach the same
  // labelled line.
  //
  // `MailBindingError.binding` is the fourth, always `'mail_transport'` (item 1b, F-386).
  // It is a class of its own rather than a `BootPreconditionError` because that class is
  // module-private here and this file boots on import, so `mail/mail-transport.ts` cannot
  // reach it; the field VALUE is the one `mail-sender.md` fixes and the one the tests read.
  //
  // `RedisBindingError.binding` is the fifth, always `'redirect_cache'` (item 2, TASK-2-03,
  // D-2-09), and it is a class of its own for the same reason `MailBindingError` is: this
  // file boots on import, so `cache/redis-client.ts` cannot reach the module-private class
  // above. It fires only on a DECLARED binding that is malformed or incomplete; an absent
  // `REDIS_URL` writes a warn line and boots.
  //
  // THAT ONLY HOLDS WHILE `auth.config.ts` IS REACHED FROM INSIDE `bootstrap()` (F-210).
  // A static import at this file's module scope evaluates it before `bootstrap()` runs, so
  // the throw never reaches this handler at all: measured, a raw uncaught stack on stderr
  // with none of the fields below. The precondition block above carries the whole finding;
  // `bootstrap()` awaits the import after `assertBootPreconditions()` for that reason.
  logger.error(
    {
      ...(error instanceof BootPreconditionError
        ? { boot_precondition: error.precondition }
        : {}),
      ...(error instanceof AuthBindingError ? { boot_precondition: error.binding } : {}),
      ...(error instanceof MailBindingError ? { boot_precondition: error.binding } : {}),
      ...(error instanceof RedisBindingError ? { boot_precondition: error.binding } : {}),
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
