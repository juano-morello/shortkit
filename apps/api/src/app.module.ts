import { Module } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';

import { AuthModule } from './auth/auth.module';
import { AuthorizationModule } from './common/authorization/authorization.module';
import { WorkspaceAuthorizationInterceptor } from './common/authorization/workspace-authorization.interceptor';
import { ApiExceptionFilter } from './common/errors/exception-filter';
import { RateLimitModule } from './common/rate-limit/rate-limit.module';
import { HealthModule } from './health/health.module';
import { InvitationsModule } from './invitations/invitations.module';
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
 *
 * `APP_INTERCEPTOR` → `WorkspaceAuthorizationInterceptor` (TASK-1b-05, D-05) IS REGISTERED
 * THIRD, AFTER `TenantTransactionInterceptor`, AND THAT ORDER IS THE SAME KIND OF RULING.
 * `workspace-authorization.md` names the enforcement point `WorkspaceGuard` and requires that
 * its membership lookup run INSIDE the tenant transaction, under RLS, failing closed with
 * `TenantContextMissingError` when there is none. Nest runs every guard before any
 * interceptor, so no `CanActivate` can satisfy that; an interceptor registered after the
 * tenant one can, because the tenant interceptor calls `next.handle()` inside
 * `withTenantTransaction` and this one's `intercept()` runs from that call, under the ambient
 * store. So the chain is RequestLog → TenantTransaction → WorkspaceAuthorization: the log line
 * still measures everything, the transaction still wraps the check and the handler, and the
 * check reads `memberships` / `tenant_memberships` through `tenantDb()` — no transaction, no
 * row, a 500, never a pass. Registered before the tenant interceptor it would run OUTSIDE the
 * transaction and every decorated route would 500. `AuthorizationModule` is imported so the
 * interceptor's two repositories resolve in this context; the property is on the interceptor
 * itself, and `app.module.spec.ts` asserts the resolved order.
 */
@Module({
  // `RateLimitModule` after `AuthModule` — see the docblock; swapping them changes the guard order.
  imports: [AuthModule, HealthModule, WorkspacesModule, InvitationsModule, RateLimitModule, AuthorizationModule],
  providers: [
    { provide: APP_FILTER, useClass: ApiExceptionFilter },
    // Outermost first — see the docblock. Swapping these two lines changes what
    // `duration_ms` measures and is a change to `logging-and-headers.md`'s "Required fields".
    { provide: APP_INTERCEPTOR, useClass: RequestLogInterceptor },
    { provide: APP_INTERCEPTOR, useClass: TenantTransactionInterceptor },
    // Third, inside the transaction the second opens — see the docblock. Moving this line
    // above the tenant interceptor puts the membership lookup outside any transaction.
    { provide: APP_INTERCEPTOR, useClass: WorkspaceAuthorizationInterceptor },
  ],
})
export class AppModule {}
