---
id: TASK-018
story: STORY-007
epic: EPIC-002
title: Member management endpoints
status: deferred
owner_slot: sdlc-implementer-backend
depends_on: [TASK-017, TASK-014]
paths: ["apps/api/src/members/**", "packages/contracts/src/members/**", "apps/api/src/app.module.ts"]
contracts: [design/contracts/auth-tokens.md, design/contracts/error-envelope.md, design/contracts/workspace-authorization.md]
test_files: []
acceptance: [AC-29, AC-30, AC-31, AC-105]
rework_count: 0
---

## Intent

List members, change roles, remove members.

## Approach

The last-owner protection (AC-31) is enforced server-side **inside the same transaction as the change**; removals take effect on the next request. `GET /members` returns each member's `WorkspaceRole` per workspace including `viewer` if present; role changes accept the full workspace role set.

## Out of scope for this TASK

Invitations (TASK-021), UI (TASK-019). Exposing `viewer` in any product flow.

## Interfaces

**Consumes**

`@RequireWorkspaceRole`, `@RequireTenantRole`, `WorkspaceGuard` (TASK-017); `membershipRepository`, roles (TASK-016); `workspaceContract` (TASK-014).

**Produces**

`GET /members`, `PATCH /members/:id/role`, `DELETE /members/:id`; `memberContract` — `{ id, email, workspaces: [{ id, role }] }`; error code `last_owner_protected`.
