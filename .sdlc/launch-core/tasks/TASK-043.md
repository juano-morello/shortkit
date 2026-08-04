---
id: TASK-043
story: STORY-015
epic: EPIC-004
title: Custom hostname routing into the redirect module
status: todo
owner_slot: sdlc-implementer-backend
depends_on: [TASK-042, TASK-029, TASK-003]
paths: ["infra/**", "fly.toml", "apps/api/src/redirect/**"]
contracts: []
test_files: []
acceptance: [AC-71, AC-73]
rework_count: 0
---

## Intent

Make an active custom hostname actually serve redirects over HTTPS.

## Approach

**GC-7** — no new deployable; **GC-1** — hostname routing must not add measurable latency to the cache-hit path, and **TASK-036's baseline must be re-checked if it does**; the test in AC-71 is an **external** HTTPS request, not an in-process one; a deleted domain stops serving (AC-73).

## Out of scope for this TASK

Multi-region routing (out of the initiative), per-workspace branding on the 404 (TASK-046), UI.

## Interfaces

**Consumes**

Active-domain transition and `certificateStatus` (TASK-042); `resolveLink`, redirect module (TASK-029); Fly deployment config (TASK-003).

**Produces**

Custom hostnames resolving to `GET /:slug`; the documented end-to-end provisioning flow.

## ⚠ BLOCKED on dispatch

Requires a **registered apex domain**. AC-71 is an external HTTPS request to a hostname Juano must own.
