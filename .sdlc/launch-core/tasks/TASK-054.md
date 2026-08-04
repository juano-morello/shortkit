---
id: TASK-054
story: STORY-019
epic: EPIC-005
title: Account deletion with verified cascade
status: todo
owner_slot: sdlc-implementer-backend
depends_on: [TASK-053]
paths: ["apps/api/src/gdpr/**", "apps/api/src/db/schema/**", "apps/api/drizzle/**"]
contracts: []
test_files: []
acceptance: [AC-90, AC-91, AC-92, AC-106]
rework_count: 0
---

## Intent

Erase a tenant completely, and prove there is nothing left.

## Approach

AC-90's referential check iterates `tenantScopedTables()` so **a table added later cannot silently survive deletion**; deletion requires the documented confirmation step (AC-92); **GC-8** — links of a deleted tenant return the branded 404, never a 5xx (AC-91).

**Amendment A-2 governs this TASK.** Deletion runs through a **named, separately-testable privileged eraser** that lives outside the tenant-facing repositories and is reachable only from `POST /gdpr/delete` under tenant `owner` plus the documented confirmation. It hard-deletes `click_events` and `audit_entries` along with every other `tenant_id`-bearing table. The eraser is documented as an **explicit exclusion in TASK-056's enumeration** so a security auditor finds it deliberately rather than discovering it.

## Out of scope for this TASK

Soft delete, retention windows, per-workspace deletion, UI.

**Using the privileged eraser for anything other than whole-tenant deletion** — no partial, per-workspace, or per-link erasure.

## Interfaces

**Consumes**

`tenantScopedTables()` (TASK-053); `withTenantTransaction` (TASK-005); `renderNotFound` (TASK-029).

**Produces**

`POST /gdpr/delete` requiring explicit confirmation; `privilegedTenantEraser.erase(tenantId)` — **the single non-tenant-facing mutation surface on `click_events` and `audit_entries`**; `assertNoTenantResidue(tenantId)` — the referential check AC-90 asserts, reused by TASK-056.
