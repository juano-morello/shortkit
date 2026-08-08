import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';

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
 */
@Module({
  imports: [HealthModule],
  providers: [{ provide: APP_FILTER, useClass: ApiExceptionFilter }],
})
export class AppModule {}
