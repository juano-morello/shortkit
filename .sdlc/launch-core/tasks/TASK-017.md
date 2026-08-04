---
id: TASK-017
story: STORY-007
epic: EPIC-002
title: Workspace authorization guard
status: todo
owner_slot: sdlc-implementer-backend
depends_on: [TASK-016, TASK-011]
paths: ["apps/api/src/common/authorization/**"]
contracts: []
test_files: []
acceptance: [AC-27, AC-28, AC-104, AC-105]
rework_count: 0
---

## Intent

One enforcement point for "may this user act on this workspace, in this way".

## Approach

Absence of membership yields **404, not 403** (AC-27); insufficient role yields **403** with a stable `code` (AC-28); the guard is declarative so later endpoint TASKs annotate rather than reimplement.

`viewer` is denied every write and permitted every read the workspace grants — **enforced once here** so TASK-025, TASK-040, TASK-045 and TASK-049 inherit it without change. Tenant `admin` is denied the owner-only surfaces (export, deletion) per AC-105.

## Out of scope for this TASK

Role management endpoints (TASK-018), rate limiting (TASK-051), UI. Granting `viewer` to anyone outside test fixtures.

## Interfaces

**Consumes**

`memberships`, `membershipRepository`, `WorkspaceRole`, `roleRank` (TASK-016); `AuthGuard`, `RequestContext` (TASK-011); `ErrorCode` (TASK-007).

**Produces**

`@RequireWorkspaceRole(role)` and `@RequireTenantRole(role)` decorators; `WorkspaceGuard` — 404 on non-membership, 403 on insufficient role; `RequestContext` extended with `workspaceId`, `workspaceRole`, and `tenantRole`.
