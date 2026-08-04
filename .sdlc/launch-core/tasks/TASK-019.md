---
id: TASK-019
story: STORY-007
epic: EPIC-002
title: Web members screen
status: todo
owner_slot: sdlc-implementer-frontend
depends_on: [TASK-015, TASK-018]
paths: ["apps/web/app/(app)/members/**", "apps/web/src/components/members/**"]
contracts: [design/contracts/web-api-client.md]
test_files: []
acceptance: [AC-29, AC-30, AC-31]
rework_count: 0
---

## Intent

Show who has access to what, and let an admin change it.

## Approach

Role controls are hidden or disabled for users who lack permission, **and the server is still the enforcement point**; the last-owner rejection is shown as an explanation, not a generic failure.

## Out of scope for this TASK

The invite dialog and accept flow (TASK-022).

**`viewer` is not offered in the role picker.** If an existing membership carries `viewer`, display it read-only rather than hiding it.

## Interfaces

**Consumes**

Authenticated layout, `useCurrentWorkspace`, navigation registry (TASK-015); `memberContract` (TASK-018); `<ErrorMessage />` (TASK-008).

**Produces**

Route `/members`; `<MembersTable />` reused by the invite dialog in TASK-022.
