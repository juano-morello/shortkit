---
id: TASK-046
story: STORY-016
epic: EPIC-004
title: Branded 404 and fallback URL on the redirect path
status: deferred
owner_slot: sdlc-implementer-backend
depends_on: [TASK-029, TASK-045]
paths: ["apps/api/src/redirect/**"]
contracts: [design/contracts/branding.md, design/contracts/redirect-cache.md, design/contracts/redirect-resolution.md]
test_files: []
acceptance: [AC-75, AC-76, AC-77]
rework_count: 0
---

## Intent

An unknown link on a client's domain looks like the client's, not like Shortkit's.

## Approach

**GC-8** — status stays 404 when rendering the branded page, and 302 when a fallback URL is configured; **GC-1** — the 404 path must not require a Postgres query on every miss in a way that lets a scan of unknown slugs degrade the hot path; absent branding falls back to the default page (AC-77).

**AC-55 still holds** — this must not introduce an import of the workspace module into the redirect module, so branding reaches the redirect path through a **narrow read interface**.

## Out of scope for this TASK

Branding settings UI (TASK-047), custom 404 templates per link.

## Interfaces

**Consumes**

`renderNotFound`, redirect module (TASK-029); `brandingRepository.getForDomain` (TASK-045); `redirectCache` (TASK-030) if branding is cached.

**Produces**

Branded 404 rendering keyed by resolved domain; fallback-URL 302 behaviour.
