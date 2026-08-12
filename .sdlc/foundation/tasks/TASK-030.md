---
id: TASK-030
story: STORY-011
epic: EPIC-003
title: Redis read-through cache on the redirect path
status: deferred
owner_slot: sdlc-implementer-backend
depends_on: [TASK-029]
paths: ["apps/api/src/redirect/**", "apps/api/src/cache/**", "apps/api/src/app.module.ts"]
contracts: [design/contracts/redirect-cache.md, design/contracts/redirect-resolution.md]
test_files: []
acceptance: [AC-49]
rework_count: 0
---

## Intent

Make the hot path hot.

## Approach

**GC-1** — this is the path SC-2's ceiling applies to, so it **must not perform a Postgres query on a hit** (AC-49, verified by an observable counter or log assertion — that observability hook is part of this TASK, not an afterthought); **GC-3** — Upstash pay-as-you-go; the cache key is derived from `(hostname, slug)` consistent with GC-6.

## Out of scope for this TASK

Invalidation on write (TASK-031), degradation on Redis loss (TASK-032), rate-limiting use of Redis (TASK-051 reuses the client produced here).

## Interfaces

**Consumes**

`resolveLink`, redirect module (TASK-029).

**Produces**

`redisClient` — the shared Redis connection, reused by TASK-051; `redirectCache.get/set/del(hostname, slug)`; `dbQueryCounter` — the observable used by AC-49 and by TASK-032's tests.
