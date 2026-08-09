---
id: TASK-032
story: STORY-011
epic: EPIC-003
title: Redirect degradation when Redis is unavailable (SC-7)
status: deferred
owner_slot: sdlc-implementer-backend
depends_on: [TASK-030]
paths: ["apps/api/src/redirect/**", "apps/api/src/cache/**"]
contracts: [design/contracts/redirect-cache.md, design/contracts/redirect-resolution.md]
test_files: []
acceptance: [AC-52, AC-53, AC-54]
rework_count: 0
---

## Intent

Keep the visitor's experience correct when the cache is gone.

## Approach

**GC-8** — no 5xx reaches a visitor; the cache call is **bounded** so a hung Redis cannot hang the request; recovery is automatic without a restart (AC-54); **Postgres-loss degraded mode is explicitly out of the initiative** (`refinement.md`, "Not planned at all") — do not build it. Building the Redis-unavailability simulation is part of this TASK.

## Out of scope for this TASK

Postgres-loss handling, multi-region failover, rate-limiter behaviour under Redis loss (an open Design decision belonging to TASK-051).

## Interfaces

**Consumes**

`redirectCache`, `redisClient`, `dbQueryCounter` (TASK-030); `resolveLink`, `renderNotFound` (TASK-029).

**Produces**

Bounded, fail-open cache access; `simulateRedisUnavailable()` test utility reused by TASK-036's baseline notes.
