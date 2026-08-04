---
id: TASK-034
story: STORY-012
epic: EPIC-003
title: Non-blocking click emission from the redirect path
status: todo
owner_slot: sdlc-implementer-backend
depends_on: [TASK-029, TASK-033]
paths: ["apps/api/src/redirect/**", "apps/api/src/clicks/**"]
contracts: [design/contracts/click-events.md, design/contracts/redirect-cache.md, design/contracts/redirect-resolution.md, design/contracts/tenant-context.md]
test_files: []
acceptance: [AC-56, AC-59]
rework_count: 0
---

## Intent

Every redirect appends exactly one event without slowing the 302.

## Approach

**GC-1** — emission must not push the cache-hit path over the 25 ms ceiling, so it **must not block the response**; **GC-8/AC-59** — a write failure still returns the correct 302 and is logged; exactly one event per resolved redirect (AC-56) with no double-emission on retry.

## Out of scope for this TASK

Events for 404s, deduplication of bot traffic, any aggregation.

## Interfaces

**Consumes**

Redirect module, `resolveLink` (TASK-029); `clickEventWriter` (TASK-033).

**Produces**

Click emission on every successful redirect; the documented emission mode (in-request vs deferred) that TASK-036's baseline is measured with.
