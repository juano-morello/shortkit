---
id: TASK-006
story: STORY-002
epic: EPIC-001
title: Tenant transaction interceptor and the three tenancy decorators
status: todo
owner_slot: sdlc-implementer-backend
depends_on: [TASK-005]
paths: ["apps/api/src/tenancy/tenant-transaction.interceptor.ts", "apps/api/src/tenancy/tenant-context.ts", "apps/api/src/app.module.ts"]
contracts: [design/contracts/tenant-context.md, design/contracts/isolation-coverage.md]
test_files: ["apps/api/src/tenancy/tenant-transaction.interceptor.spec.ts (unit)", "apps/api/src/decorator-metadata.spec.ts (unit, existing file — extended)", "apps/api/test/tenancy/request-tenant-binding.int-spec.ts (integration)"]
acceptance: [AC-14, AC-15]
rework_count: 0
---

## Intent

Make an authenticated request run inside its caller's tenant transaction, and turn the three
decorators that currently throw `not implemented` into real metadata.

## Approach

`apps/api/src/tenancy/tenant-context.ts` ships three decorators whose bodies are
`throw new Error('not implemented')` (`tenant-context.ts:358-394`) and whose metadata
symbols already exist. This TASK implements all three in that one file, because they are
three declarations in one module and no other TASK in this initiative writes it.

- **`Public(justification: string)`** — the justification is **required** and is printed by
  the coverage report. Exempts a route from `AuthGuard` and from the interceptor. A
  `@Public()` route that touches a tenant-scoped table must reach it through a
  capability-token entry point (ADR-0021), which does not exist in this initiative — so no
  route shipped here carries `@Public()`, and AC-15 is measured against a test-only route.
- **`NoTenantTransaction(justification: string)`** — keeps `AuthGuard`, skips only the
  interceptor. **No route shipped in this initiative uses it.** Its one intended user is
  `POST /api/gdpr/delete`, which is roadmap item 4. Implemented here because it lives in
  this file and a half-implemented module is worse than a complete one; the rules its
  docblock states (a `@NoTenantTransaction` route may not carry a role decorator; the guard
  fails closed on a missing context) are carried forward verbatim and not relaxed.
- **`TenantScopedRepository()`** — marks a provider for repository enumeration (ADR-0020).
  `WorkspaceRepository` (TASK-011) carries it. The **enumeration itself is out of scope**:
  `discoverRepositoryMethods()` in `apps/api/test/isolation/coverage.ts` throws
  `TASK-056 owns repository discovery` and stays that way in this initiative.

**The interceptor.** It runs **after** authentication and **before** the handler, which is
ADR-0002's requirement and the reason ADR-0013 rejected the community package that would
have registered a competing global guard. It reads the `RequestContext` the guard populated,
opens `withTenantTransaction(context.tenantId, ...)` around the handler, and lets the
existing semantics stand: commit on resolve, roll back and rethrow on throw.

Nesting is already handled by the helper and must not be re-implemented: a nested call with
the **same** `tenantId` reuses the outer transaction with no savepoint, and a nested call
with a **different** `tenantId` throws `TenantContextMismatchError`. A repository method
that opens its own `withTenantTransaction` under the interceptor therefore joins rather than
nests, which is the property that lets TASK-011's repository be written without knowing
whether an interceptor is above it.

**Third-party network I/O goes in `options.afterCommit`, never inside the transaction body**
(ADR-0002). Nothing in this initiative dispatches mail, but the rule is stated here because
this interceptor is the seam every later handler inherits.

`app.module.ts` gains the interceptor as an `APP_INTERCEPTOR` provider and the guard
(TASK-005) as an `APP_GUARD` provider, alongside the existing `APP_FILTER`. Registering them
in the module rather than in `main.ts` is the pattern the file's own docblock states: the
filter is there "so it is in place for every app built from this module, the test harness
included".

**`@Public()` on a globally registered guard is what makes `GET /health` keep working.**
`main.ts` excludes `GET /health` from the `/api` prefix but not from a global guard. Verify
the health route still answers 200 with no `Authorization` header — `apps/api/src/health/health.spec.ts`
already asserts that route's behaviour and it must stay green.

## Out of scope for this TASK

`AuthGuard` itself (TASK-005). Repository and route discovery in the isolation harness
(TASK-056, deferred; not in this initiative). `WorkspaceGuard`, `RequireTenantRole`,
`RequireWorkspaceRole` (item 1b). Any endpoint. Any change to `withTenantTransaction`'s own
body — its timeouts, its `set_config` calls and its nesting rules are shipped and correct.

## Interfaces

**Consumes**

From TASK-005:
- `AuthGuard implements CanActivate`
- `REQUEST_CONTEXT_KEY` — the request property carrying the populated `RequestContext`

From `apps/api/src/tenancy/tenant-context.ts` (shipped, same file this TASK edits):
- `withTenantTransaction<T>(tenantId: string, fn: (db: TenantDb) => Promise<T>, options?: { afterCommit?: () => Promise<void> }): Promise<T>` — at `tenant-context.ts:164-269`
- `tenantDb(): TenantDb`, `currentTenantId(): string` — throw `TenantContextMissingError` outside an active context
- `assertUuid(value: string): string`
- `PUBLIC_ROUTE_METADATA`, `NO_TENANT_TRANSACTION_METADATA` — symbols, already exported
- `interface RequestContext`
- `TenantContextMismatchError`, `TenantContextMissingError`, `InvalidTenantIdError`

**Produces**

- `apps/api/src/tenancy/tenant-context.ts`:
  - `Public(justification: string): MethodDecorator & ClassDecorator` — sets `PUBLIC_ROUTE_METADATA` to the justification string; **no longer throws**
  - `NoTenantTransaction(justification: string): MethodDecorator & ClassDecorator` — sets `NO_TENANT_TRANSACTION_METADATA`; **no longer throws**
  - `TenantScopedRepository(): ClassDecorator` — sets the ADR-0020 marker; **no longer throws**
  - `TENANT_SCOPED_REPOSITORY_METADATA: symbol` — the marker `TenantScopedRepository()` writes
- `apps/api/src/tenancy/tenant-transaction.interceptor.ts` exporting
  `TenantTransactionInterceptor implements NestInterceptor` — opens `withTenantTransaction` on `RequestContext.tenantId`; skips when the handler carries `NO_TENANT_TRANSACTION_METADATA` or `PUBLIC_ROUTE_METADATA`
- `apps/api/src/app.module.ts` — `APP_GUARD` bound to `AuthGuard` and `APP_INTERCEPTOR` bound to `TenantTransactionInterceptor`, in that order relative to each other
