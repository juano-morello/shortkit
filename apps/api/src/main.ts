import 'reflect-metadata';

import { RequestMethod } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module';
import { errorResponse } from './common/errors/error-envelope';

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

async function bootstrap(): Promise<void> {
  app = await NestFactory.create(AppModule);

  // ADR-0006: every controller answers under /api. GET /health stays at the
  // root so the platform health check never depends on the API surface.
  app.setGlobalPrefix('api', {
    exclude: [{ path: 'health', method: RequestMethod.GET }],
  });

  await app.listen(resolvePort(process.env.PORT));
}

bootstrap().catch(async (error: unknown) => {
  // A failed start is otherwise a bare unhandled rejection with no context. It
  // logs in the shared envelope shape so a startup failure searches the same way
  // as a request failure. TASK-003 swaps this for the pino logger.
  //
  // The stack is deliberately not logged: ADR-0022 redacts by path at the
  // logger, and no path reaches into a stack, so it would be the one field on
  // the boot line outside the redaction pipeline. Name and message are the
  // summary; the stack returns when TASK-003 lands an error serialiser.
  const { body } = errorResponse('internal_error', 'the API failed to start');
  const line = JSON.stringify({
    ...body,
    cause: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
  });

  // stderr is asynchronous when it is a pipe — which is what a container gets —
  // and `process.exit` drops pending writes, so the exit waits for the flush.
  await new Promise<void>((resolve) => {
    process.stderr.write(`${line}\n`, () => {
      resolve();
    });
  });

  // Release the container's handles before exiting. A close that itself fails
  // must not become a second unhandled rejection, which would strand the exit.
  await app?.close().catch(() => undefined);

  process.exit(1);
});
