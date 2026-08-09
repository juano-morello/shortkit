---
id: TASK-051
story: STORY-018
epic: EPIC-005
title: Per-tenant rate limiting on API writes
status: deferred
owner_slot: sdlc-implementer-backend
depends_on: [TASK-030, TASK-011, TASK-007]
paths: ["apps/api/src/common/rate-limit/**", "apps/api/src/app.module.ts"]
contracts: [design/contracts/auth-tokens.md, design/contracts/error-envelope.md, design/contracts/rate-limit.md, design/contracts/redirect-cache.md, design/contracts/tenant-context.md]
test_files: []
acceptance: [AC-83, AC-84, AC-85, AC-86]
rework_count: 0
---

## Intent

Bound one tenant's write volume so it cannot affect another's.

## Approach

**The limiter key is the tenant, never a global bucket, for authenticated traffic** (AC-84); **explicitly not applied to the redirect path** (AC-86); returns 429 with `Retry-After` and a stable `code`; **reuses `redisClient` from TASK-030** rather than opening a second connection (GC-3).

**Amended 2026-08-04 (finding F-026, ruled by Juano).** This Approach originally
read "applies to write endpoints only". That is no longer true and building to it
would silently reopen F-018.

`RateLimitGuard` covers **every route under `/api`**, not only writes:

- **Authenticated routes** — keyed by tenant, as AC-84 requires. Unchanged.
- **`@Public()` routes — keyed by client IP, on all methods including `GET`.**
  `GET /api/invitations/:token` opens a Postgres transaction exactly as the
  accept route does, on the pooled connection set the redirect hot path shares.
  An IP key is not a global bucket and does not weaken AC-84, whose claim is
  about authenticated tenant writes; a public route has no tenant to key on.
  The check runs **before the capability token is parsed**, so a malformed-token
  flood costs one `INCR` and no transaction.

**Behaviour when Redis is unavailable is an open Design decision.** SC-7 covers the redirect path only, not this limiter. Design must choose fail-open or fail-closed; either is testable.

## Out of scope for this TASK

Per-user or per-endpoint limits, UI handling (TASK-052), quota billing.

## Interfaces

**Consumes**

`redisClient` (TASK-030); `RequestContext`, `AuthGuard` (TASK-011); `ErrorCode` (TASK-007).

**Produces**

`RateLimitGuard` applied to write routes; error code `rate_limited`; `Retry-After` header on 429; the documented limit and window.
