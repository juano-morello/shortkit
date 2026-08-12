---
id: TASK-022
story: STORY-008
epic: EPIC-002
title: Web invite dialog and accept-invitation flow
status: deferred
owner_slot: sdlc-implementer-frontend
depends_on: [TASK-019, TASK-021]
paths: ["apps/web/app/(app)/members/invite/**", "apps/web/app/(auth)/invite/**"]
contracts: [design/contracts/web-api-client.md]
test_files: []
acceptance: [AC-32, AC-33, AC-34, AC-35, AC-36]
rework_count: 0
---

## Intent

Invite a teammate to chosen workspaces, and let them accept.

## Approach

The accept screen is reachable unauthenticated and leads into account creation; **expired, revoked, and already-accepted each render distinct explanatory copy** (GC-12).

## Out of scope for this TASK

Member role editing (TASK-019).

## Interfaces

**Consumes**

`<MembersTable />` (TASK-019); `invitationContract` and its error codes (TASK-021); `/signup` route (TASK-012).

**Produces**

Route `/members/invite`; route `/invite/[token]`.
