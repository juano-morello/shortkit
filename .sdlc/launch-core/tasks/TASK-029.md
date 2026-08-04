---
id: TASK-029
story: STORY-011
epic: EPIC-003
title: Isolated redirect module resolving from Postgres
status: todo
owner_slot: sdlc-implementer-backend
depends_on: [TASK-023]
paths: ["apps/api/src/redirect/**", "apps/api/src/app.module.ts"]
contracts: []
test_files: []
acceptance: [AC-48, AC-50, AC-55]
rework_count: 0
---

## Intent

The hot path, built first without a cache so correctness is established before speed.

## Approach

**GC-7/GC-8** — this module lives in the one backend deployable, is `@Public()`, and **must not import the link-management, auth, workspace, or member modules** (AC-55 tests this); resolution is by `(hostname, slug)`.

**The one deliberate GC-5 exception.** Resolution happens before a tenant is known, because the visitor is anonymous. This non-tenant-scoped read must be documented here and covered by TASK-056's enumeration as an **explicit, justified exclusion** rather than an accidental hole. A security auditor should challenge it specifically: if the justification does not hold, SC-1's claim is narrower than stated.

**GC-8** — no unresolvable request returns 5xx.

## Out of scope for this TASK

Caching (TASK-030), invalidation (TASK-031), degradation (TASK-032), click events (TASK-034), per-workspace branding (TASK-046), custom hostname routing (TASK-043).

## Interfaces

**Consumes**

`links`, `domains`, `db` (TASK-023); `isLinkActive` when TASK-027 lands.

**Produces**

`GET /:slug` on any bound host → 302 or branded 404; `resolveLink(hostname, slug)` → link or null; `renderNotFound(context)` — the default branded 404 renderer that TASK-046 extends; a documented statement that the redirect module reads outside tenant context and why.
