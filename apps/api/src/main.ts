import 'reflect-metadata';

import { RequestMethod } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module';
import { errorResponse } from './common/error-envelope';

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

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);

  // ADR-0006: every controller answers under /api. GET /health stays at the
  // root so the platform health check never depends on the API surface.
  app.setGlobalPrefix('api', {
    exclude: [{ path: 'health', method: RequestMethod.GET }],
  });

  await app.listen(resolvePort(process.env.PORT));
}

bootstrap().catch((error: unknown) => {
  // A failed start is otherwise a bare unhandled rejection with no context. It
  // logs in the shared envelope shape so a startup failure searches the same way
  // as a request failure. TASK-003 swaps console for the pino logger.
  const { body } = errorResponse('internal_error', 'the API failed to start');

  console.error(
    JSON.stringify({
      ...body,
      cause: error instanceof Error ? error.stack : String(error),
    }),
  );
  process.exitCode = 1;
});
