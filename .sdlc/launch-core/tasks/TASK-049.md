---
id: TASK-049
story: STORY-017
epic: EPIC-005
title: Audit query endpoint
status: todo
owner_slot: sdlc-implementer-backend
depends_on: [TASK-048, TASK-017]
paths: ["apps/api/src/audit/**", "packages/contracts/src/audit/**", "apps/api/src/app.module.ts"]
contracts: [design/contracts/error-envelope.md, design/contracts/tenant-context.md, design/contracts/workspace-authorization.md]
test_files: []
acceptance: [AC-79, AC-80, AC-81]
rework_count: 0
---

## Intent

Expose a link's change history to the people entitled to see it.

## Approach

Cross-tenant access returns **404** and cross-tenant entries never appear in a list (AC-81); results are paginated using the shared `Paginated<T>`.

## Out of scope for this TASK

UI (TASK-050), audit export (TASK-053 covers it as part of GDPR export).

## Interfaces

**Consumes**

`auditReader` (TASK-048); `@RequireWorkspaceRole`, `WorkspaceGuard` (TASK-017); `Paginated<T>` (TASK-007).

**Produces**

`GET /links/:id/audit`; `auditEntryContract` — `{ id, actorId, actorEmail, action, previousValue, newValue, occurredAt }`.
