import { Module } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';

import { AuthModule } from './auth/auth.module';
import { ApiExceptionFilter } from './common/errors/exception-filter';
import { RateLimitModule } from './common/rate-limit/rate-limit.module';
import { HealthModule } from './health/health.module';
import { RequestLogInterceptor } from './observability/request-log.interceptor';
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
 *
 * `APP_INTERCEPTOR` → `RequestLogInterceptor` (TASK-016) IS REGISTERED BEFORE
 * `TenantTransactionInterceptor`, AND THE ORDER IS A RULING, NOT AN ACCIDENT. Nest runs global
 * interceptors in registration order and the first registered wraps the rest, so the request
 * log line is the OUTERMOST layer: its `duration_ms` covers the tenant transaction and the
 * handler, and it runs for a `@NoTenantTransaction()` route the other interceptor skips. It
 * reads `tenant_id` from the `RequestContext` the guard wrote, which is there whatever the
 * order (guards run before every interceptor), and it exempts nothing: a `@Public()` route
 * gets its line too, without a `tenant_id`.
 *
 * `APP_GUARD` → `RateLimitGuard` IS BOUND IN `RateLimitModule` (TASK-1b-07, F-018), AND THAT
 * MODULE IS IMPORTED AFTER `AuthModule` ON PURPOSE. Nest applies `APP_GUARD` providers in
 * module scan order — this import list's order — and runs global guards in that order, so
 * `AuthGuard` runs first and `RateLimitGuard` second, which is what `rate-limit.md` fixes
 * ("after `AuthGuard`, before `TenantTransactionInterceptor`"; the second half is Nest's
 * lifecycle, every guard before any interceptor). Today the guard's real branch is the
 * `@Public()` per-IP bucket, for which `AuthGuard` returns at once and the order is
 * immaterial; the order is pinned (`app.module.spec.ts`) for the tenant-keyed write branch
 * TASK-051 fills, which reads the `RequestContext` `AuthGuard` writes. `GET /health` is
 * `@Public()` and outside the `/api` prefix, and the guard leaves it alone by that path.
 */
@Module({
  // `RateLimitModule` after `AuthModule` — see the docblock; swapping them changes the guard order.
  imports: [AuthModule, HealthModule, WorkspacesModule, RateLimitModule],
  providers: [
    { provide: APP_FILTER, useClass: ApiExceptionFilter },
    // Outermost first — see the docblock. Swapping these two lines changes what
    // `duration_ms` measures and is a change to `logging-and-headers.md`'s "Required fields".
    { provide: APP_INTERCEPTOR, useClass: RequestLogInterceptor },
    { provide: APP_INTERCEPTOR, useClass: TenantTransactionInterceptor },
  ],
})
export class AppModule {}
