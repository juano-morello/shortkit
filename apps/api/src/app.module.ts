import { Module } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';

import { AuthModule } from './auth/auth.module';
import { ApiExceptionFilter } from './common/errors/exception-filter';
import { HealthModule } from './health/health.module';
import { TenantTransactionInterceptor } from './tenancy/tenant-transaction.interceptor';
import { WorkspacesModule } from './workspaces/workspaces.module';

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
 *
 * THE TWO GLOBAL ENHANCERS THAT MAKE A ROUTE TENANT-SCOPED BY DEFAULT, AND WHERE EACH LIVES.
 * `APP_GUARD` → `AuthGuard` is bound in `AuthModule` (TASK-005), beside the two collaborators
 * it injects; it is not repeated here, because two `APP_GUARD` bindings of the same class
 * would run the guard twice. `APP_INTERCEPTOR` → `TenantTransactionInterceptor` is bound HERE
 * (TASK-006), for the reason the filter is: it has to be in place for every app built from
 * this module, the test harness included. Nest runs every guard before any interceptor, so
 * the interceptor always sees the `RequestContext` the guard wrote — ADR-0002's ordering —
 * and a route that carries `@Public()` is exempt from both while `@NoTenantTransaction()`
 * exempts it from the interceptor alone. `GET /health` is `@Public('platform probe')`.
 */
@Module({
  imports: [AuthModule, HealthModule, WorkspacesModule],
  providers: [
    { provide: APP_FILTER, useClass: ApiExceptionFilter },
    { provide: APP_INTERCEPTOR, useClass: TenantTransactionInterceptor },
  ],
})
export class AppModule {}
