---
id: TASK-051
story: STORY-018
epic: EPIC-005
title: Per-tenant rate limiting on API writes
status: todo
owner_slot: sdlc-implementer-backend
depends_on: [TASK-030, TASK-011, TASK-007]
paths: ["apps/api/src/common/rate-limit/**", "apps/api/src/app.module.ts"]
contracts: []
test_files: []
acceptance: [AC-83, AC-84, AC-85, AC-86]
rework_count: 0
---

## Intent

Bound one tenant's write volume so it cannot affect another's.

## Approach

**The limiter key is the tenant, never a global bucket** (AC-84); applies to write endpoints only and **explicitly not to the redirect path** (AC-86); returns 429 with `Retry-After` and a stable `code`; **reuses `redisClient` from TASK-030** rather than opening a second connection (GC-3).

**Behaviour when Redis is unavailable is an open Design decision.** SC-7 covers the redirect path only, not this limiter. Design must choose fail-open or fail-closed; either is testable.

## Out of scope for this TASK

Per-user or per-endpoint limits, UI handling (TASK-052), quota billing.

## Interfaces

**Consumes**

`redisClient` (TASK-030); `RequestContext`, `AuthGuard` (TASK-011); `ErrorCode` (TASK-007).

**Produces**

`RateLimitGuard` applied to write routes; error code `rate_limited`; `Retry-After` header on 429; the documented limit and window.
