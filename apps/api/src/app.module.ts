import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';

import { ApiExceptionFilter } from './common/errors/exception-filter';

/**
 * Composition root. Feature modules register here, each added by its own TASK.
 *
 * The redirect module stays isolated from links, workspaces and tenancy: it is
 * imported here and imports nothing from them.
 *
 * The exception filter is registered here rather than in main.ts so it is in place for
 * every app built from this module, the test harness included (TASK-007, ADR-0024).
 */
@Module({
  imports: [],
  providers: [{ provide: APP_FILTER, useClass: ApiExceptionFilter }],
})
export class AppModule {}
