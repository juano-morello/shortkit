---
id: TASK-028
story: STORY-010
epic: EPIC-003
title: Web expiry and schedule controls
status: deferred
owner_slot: sdlc-implementer-frontend
depends_on: [TASK-026, TASK-027]
paths: ["apps/web/src/components/links/**", "apps/web/app/(app)/links/**"]
contracts: [design/contracts/web-api-client.md]
test_files: []
acceptance: [AC-44, AC-45, AC-47]
rework_count: 0
---

## Intent

Let the operator set and see a link's validity window.

## Approach

The list distinguishes active, scheduled, and expired links visibly; timestamps are shown in the operator's local timezone **with the timezone stated**.

## Out of scope for this TASK

Bulk scheduling, expiry notifications.

## Interfaces

**Consumes**

`<LinkForm />`, `/links` routes (TASK-026); `linkContract` with `expiresAt`/`activatesAt` (TASK-027).

**Produces**

Schedule fields on `<LinkForm />`; `<LinkStatusBadge />` reused by TASK-041's domain view.
