---
id: TASK-011
story: STORY-005
epic: EPIC-002
title: Auth guard and per-request tenant context binding
status: deferred
owner_slot: sdlc-implementer-backend
depends_on: [TASK-009, TASK-005]
paths: ["apps/api/src/common/guards/**", "apps/api/src/tenancy/**", "apps/api/src/app.module.ts"]
contracts: [design/contracts/auth-tokens.md, design/contracts/error-envelope.md, design/contracts/tenant-context.md]
test_files: []
acceptance: [AC-17]
rework_count: 0
---

## Intent

Connect an authenticated request to a tenant transaction, so GC-5 is enforced by the framework rather than by discipline.

## Approach

**GC-5** — an authenticated request's handler runs inside `withTenantTransaction` bound to the caller's tenant; unverified accounts get 403 `email_not_verified` on authenticated endpoints; unauthenticated requests get 401; **the redirect module must remain outside this guard** because it is unauthenticated.

## Out of scope for this TASK

Workspace-level authorization (TASK-017), rate limiting (TASK-051), role checks.

## Interfaces

**Consumes**

JWT issuance and `AuthUser` (TASK-009); `withTenantTransaction` (TASK-005); `ErrorCode` (TASK-007).

**Produces**

`AuthGuard` — rejects 401 unauthenticated, 403 `email_not_verified` unverified; `RequestContext` — `{ userId, tenantId }` available to every authenticated handler; `@Public()` marker exempting a route from the guard.

## ⚠ F-138 must be closed before this TASK is dispatched (routed 2026-08-05)

`design/contracts/tenant-context.md` invariant 5 promises that nesting `withTenantTransaction`
with the same `tenantId` reuses the outer transaction, **with no exception stated**. The
shipped code (`tenant-context.ts:179-181`, TASK-005 fix round 1) throws
`TenantContextMissingError` when the outer context has already settled. You consume that
contract, so as written it would send you into a fire-and-forget follow-up inside `fn` that
calls `withTenantTransaction`, expects reuse, and gets an unexplained runtime throw — the
behaviour is written down only in `docs/architecture/rls.md`, which is not normative and which
your card does not point at.

Routed to `sdlc-architect` under routing rule 0. **Do not dispatch this TASK until the
contract states the settled-context invariant**: a context is invalidated when its transaction
settles, and `tenantDb`, `currentTenantId` and a nested `withTenantTransaction` all throw
rather than reuse a released handle.
