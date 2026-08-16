import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';

import { AuthModule } from './auth/auth.module';
import { ApiExceptionFilter } from './common/errors/exception-filter';
import { HealthModule } from './health/health.module';

/**
 * Composition root. Feature modules register here, each added by its own TASK.
 *
 * The redirect module stays isolated from links, workspaces and tenancy: it is
 * imported here and imports nothing from them.
 *
 * The exception filter is registered here rather than in main.ts so it is in place for
 * every app built from this module, the test harness included (TASK-007, ADR-0024).
 *
 * HealthModule is registered here rather than in main.ts because AC-6's assertions run
 * against an application built from this module (TASK-003, F-217). Its route resolves at
 * the root: main.ts excludes `GET /health` from the `/api` global prefix (ADR-0006).
 *
 * AuthModule carries no route. Better Auth's handler is mounted on Express in main.ts,
 * outside this graph, because it needs the raw body (ADR-0013); the module exists for
 * TASK-005's `AuthGuard` and its providers.
 */
@Module({
  imports: [AuthModule, HealthModule],
  providers: [{ provide: APP_FILTER, useClass: ApiExceptionFilter }],
})
export class AppModule {}
