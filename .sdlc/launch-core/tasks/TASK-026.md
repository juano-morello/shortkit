---
id: TASK-026
story: STORY-009
epic: EPIC-003
title: Web link list, create, and edit
status: todo
owner_slot: sdlc-implementer-frontend
depends_on: [TASK-015, TASK-025]
paths: ["apps/web/app/(app)/links/**", "apps/web/src/components/links/**"]
contracts: [design/contracts/slug.md, design/contracts/web-api-client.md]
test_files: []
acceptance: [AC-37, AC-38, AC-40, AC-42, AC-43]
rework_count: 0
---

## Intent

The operator's primary daily screen.

## Approach

The `slug_taken` 409 is surfaced **against the slug field**, not as a generic banner; the full short URL (host + slug) is displayed and copyable; deletion is confirmed.

## Out of scope for this TASK

Expiry controls (TASK-028), domain selection beyond what exists (custom domains arrive in TASK-041), audit history panel (TASK-050).

## Interfaces

**Consumes**

Authenticated layout, `useCurrentWorkspace`, navigation registry (TASK-015); `linkContract`, `createLinkContract`, `updateLinkContract` (TASK-025); `<ErrorMessage />` (TASK-008).

**Produces**

Routes `/links`, `/links/new`, `/links/[id]`; `<LinkForm />` extended by TASK-028; `<LinkDetail />` extended by TASK-050.
