---
id: TASK-020
story: STORY-008
epic: EPIC-002
title: Invitation schema and token lifecycle
status: deferred
owner_slot: sdlc-implementer-backend
depends_on: [TASK-016]
paths: ["apps/api/src/db/schema/**", "apps/api/drizzle/**", "apps/api/src/invitations/tokens/**"]
contracts: [design/contracts/rls-policy-template.md, design/contracts/tenant-context.md]
test_files: []
acceptance: [AC-34, AC-35, AC-36]
rework_count: 0
---

## Intent

Model a pending invitation and the states a token can be in.

## Approach

**GC-5** — RLS applied; an invitation names an explicit set of workspaces and a role per workspace; tokens are single-use, expiring, and revocable; **a consumed, expired, and revoked token each produce a distinct state** so AC-34/35/36 are separately distinguishable.

## Out of scope for this TASK

Endpoints and email sending (TASK-021), UI.

## Interfaces

**Consumes**

`memberships`, roles (TASK-016); RLS template (TASK-013).

**Produces**

`invitations` and `invitation_workspaces` tables, RLS enabled; `InvitationState` = `pending | accepted | expired | revoked`; `invitationRepository` with `create`, `findByToken`, `markAccepted`, `revoke`.
