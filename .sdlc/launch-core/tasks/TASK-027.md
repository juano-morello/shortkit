---
id: TASK-027
story: STORY-010
epic: EPIC-003
title: Expiry and scheduled activation
status: todo
owner_slot: sdlc-implementer-backend
depends_on: [TASK-025]
paths: ["apps/api/src/links/**", "apps/api/src/db/schema/**", "apps/api/drizzle/**", "packages/contracts/src/links/**"]
contracts: []
test_files: []
acceptance: [AC-44, AC-45, AC-46, AC-47]
rework_count: 0
---

## Intent

Give links a validity window and a single shared rule for evaluating it.

## Approach

**One `isLinkActive(link, now)` rule used by both the API and the redirect path** so they cannot diverge; absence of both timestamps means active (AC-47).

**How an expired link leaves the cache is an open Design question** (bound TTL by time-to-expiry, or sweep on read). Implement whichever Design chose, and satisfy AC-46 **with the TTL set to one hour**.

## Out of scope for this TASK

UI (TASK-028), any background scheduler beyond what the chosen approach requires, notifying anyone that a link expired.

## Interfaces

**Consumes**

`links`, `linkRepository` (TASK-023); link endpoints and `onLinkMutated` (TASK-025); the cache invalidation hook (TASK-031) if Design's answer needs it.

**Produces**

`links.expires_at` and `links.activates_at` columns; `isLinkActive(link, now)` → boolean; `linkContract` extended with `expiresAt` and `activatesAt`.
