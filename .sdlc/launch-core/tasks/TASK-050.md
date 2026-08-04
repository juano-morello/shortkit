---
id: TASK-050
story: STORY-017
epic: EPIC-005
title: Web link history panel
status: todo
owner_slot: sdlc-implementer-frontend
depends_on: [TASK-026, TASK-049]
paths: ["apps/web/src/components/links/**", "apps/web/app/(app)/links/**"]
contracts: [design/contracts/web-api-client.md]
test_files: []
acceptance: [AC-79, AC-80]
rework_count: 0
---

## Intent

Show who changed a link and when, where the operator already is.

## Approach

History appears on the existing link detail view rather than a separate route; destination changes show old and new side by side.

## Out of scope for this TASK

Reverting a change, exporting history.

## Interfaces

**Consumes**

`<LinkDetail />` (TASK-026); `auditEntryContract` (TASK-049).

**Produces**

`<LinkHistory />` mounted in `<LinkDetail />`.
