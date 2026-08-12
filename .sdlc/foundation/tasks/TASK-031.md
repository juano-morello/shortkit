---
id: TASK-031
story: STORY-011
epic: EPIC-003
title: Cache invalidation on link writes (SC-3)
status: deferred
owner_slot: sdlc-implementer-backend
depends_on: [TASK-030, TASK-025]
paths: ["apps/api/src/links/**", "apps/api/src/cache/**"]
contracts: [design/contracts/link-mutation-events.md, design/contracts/redirect-cache.md]
test_files: []
acceptance: [AC-51, AC-46]
rework_count: 0
---

## Intent

Make edits visible within 5 seconds without relying on TTL expiry.

## Approach

**GC-2** — the test must still pass with the TTL configured to one hour; invalidation is driven by the `onLinkMutated` hook so the link handlers are not modified; invalidation must cover destination change, slug change, deletion, **and expiry change**; if invalidation fails, the failure is logged and must not silently leave a stale entry beyond the 5-second budget.

## Out of scope for this TASK

Degradation (TASK-032), the expiry-eviction strategy itself (TASK-027 owns Design's answer).

## Interfaces

**Consumes**

`onLinkMutated` (TASK-025); `redirectCache`, `redisClient` (TASK-030).

**Produces**

Invalidation subscriber on `onLinkMutated`; the documented worst-case propagation delay, which must be `< 5s`.
