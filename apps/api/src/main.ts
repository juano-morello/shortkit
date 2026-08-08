import 'reflect-metadata';

import { RequestMethod } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module';
import { assertRuntimeRoleCannotBypassRls } from './db/rls';
import { readBuildCommitSha } from './health/build-commit';
import { errorLogFields, logger } from './observability/logger';

const DEFAULT_PORT = 3001;
const MIN_PORT = 1;
const MAX_PORT = 65535;

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
 */
async function assertBootPreconditions(): Promise<void> {
  readBuildCommitSha();

  await assertRuntimeRoleCannotBypassRls();
}

async function bootstrap(): Promise<void> {
  await assertBootPreconditions();

  app = await NestFactory.create(AppModule);

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
  logger.error(errorLogFields(error, { includeMessage: true }), 'the API failed to start');

  // Release the container's handles before exiting. A close that itself fails
  // must not become a second unhandled rejection, which would strand the exit.
  await app?.close().catch(() => undefined);

  // pino's default destination is a synchronous write to fd 1, verified through a pipe on
  // pino 10.3.1 / Node 24.19, so the line above survives this call. That is why the
  // hand-rolled promise around `process.stderr.write` that used to sit here is gone rather
  // than ported: it existed to defeat exactly this drop, and pino already does.
  process.exit(1);
});
