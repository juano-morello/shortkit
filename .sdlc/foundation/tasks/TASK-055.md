---
id: TASK-055
story: STORY-019
epic: EPIC-005
title: Web export and delete-account settings
status: deferred
owner_slot: sdlc-implementer-frontend
depends_on: [TASK-015, TASK-054]
paths: ["apps/web/app/(app)/settings/account/**"]
contracts: [design/contracts/tenant-scoped-tables.md, design/contracts/web-api-client.md]
test_files: []
acceptance: [AC-88, AC-92]
rework_count: 0
---

## Intent

Put export and deletion where an operator can find them without support.

## Approach

Deletion requires **explicit typed confirmation** and states plainly that it is irreversible and cascades to all workspaces, links and domains; the export download is initiated and its readiness surfaced; copy is human-facing prose (GC-12).

## Out of scope for this TASK

Deletion scheduling or a grace period, partial export selection.

## Interfaces

**Consumes**

Settings shell and navigation registry (TASK-047, TASK-015); `exportContract` and the delete endpoint (TASK-053, TASK-054).

**Produces**

Route `/settings/account`.
