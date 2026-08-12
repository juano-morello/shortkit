---
id: TASK-029
story: STORY-011
epic: EPIC-003
title: Isolated redirect module resolving from Postgres
status: deferred
owner_slot: sdlc-implementer-backend
depends_on: [TASK-023]
paths: ["apps/api/src/redirect/**", "apps/api/src/app.module.ts"]
contracts: [design/contracts/branding.md, design/contracts/redirect-resolution.md]
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

## ⚠ Two deferred TASK-005 findings routed here 2026-08-05

**F-143 — `app.redirect_context` is a PERMISSIVE policy, and Postgres ORs permissive
policies.** A transaction with `app.redirect_context` set therefore sees **every tenant's
rows regardless of `app.tenant_id`**. That is the documented GC-5 exclusion and it is
correct, but it means the flag *is* the whole boundary: **never set it in a transaction that
also does tenant work.** `sdlc-security-auditor` carried this forward across two rounds rather
than filing it, and filed it here only because `docs/architecture/rls.md:128` now lists the
flag without describing the one property that makes it dangerous.

**F-152 — the acquisition timeout gives you nothing to branch on, and GC-8 is yours.** Pool
exhaustion or a cold-start timeout rejects with a plain `Error` carrying **no SQLSTATE**, so
`postgresErrorCode` answers `undefined`. GC-8 says no unresolvable request returns 5xx to a
visitor — it returns the branded 404. A handler branching on SQLSTATE cannot classify this
failure, so the default arm is a 500 unless you map it explicitly. The redirect path shares
the same pool as everything else. TASK-007's exception filter is already `done`, so the
mapping has to happen here or at Ship.
