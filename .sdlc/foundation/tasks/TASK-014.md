---
id: TASK-014
story: STORY-006
epic: EPIC-002
title: Workspace endpoints and contracts
status: deferred
owner_slot: sdlc-implementer-backend
depends_on: [TASK-013, TASK-011, TASK-007]
paths: ["apps/api/src/workspaces/**", "packages/contracts/src/workspaces/**", "apps/api/src/app.module.ts"]
contracts: [design/contracts/auth-tokens.md, design/contracts/error-envelope.md, design/contracts/workspace-authorization.md]
test_files: []
acceptance: [AC-23, AC-24, AC-25]
rework_count: 0
---

## Intent

Workspace CRUD, tenant-scoped.

## Approach

Cross-tenant access returns **404, not 403** (AC-24 — existence is not disclosed); list responses are tenant-filtered **by RLS, not by an application-level `where` clause**.

## Out of scope for this TASK

Member management (TASK-018), branding (TASK-045), UI.

## Interfaces

**Consumes**

`workspaceRepository`, `workspaces` (TASK-013); `AuthGuard`, `RequestContext` (TASK-011); `ErrorEnvelope`, `Paginated<T>` (TASK-007).

**Produces**

`POST/GET/PATCH/DELETE /workspaces` and `/workspaces/:id`; `workspaceContract` — `{ id, name, createdAt }`; `createWorkspaceContract`.
