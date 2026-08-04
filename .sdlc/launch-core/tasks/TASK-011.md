---
id: TASK-011
story: STORY-005
epic: EPIC-002
title: Auth guard and per-request tenant context binding
status: todo
owner_slot: sdlc-implementer-backend
depends_on: [TASK-009, TASK-005]
paths: ["apps/api/src/common/guards/**", "apps/api/src/tenancy/**", "apps/api/src/app.module.ts"]
contracts: []
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
