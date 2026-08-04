---
id: TASK-005
story: STORY-003
epic: EPIC-001
title: Database connection, migrations, and the tenant-context transaction helper
status: todo
owner_slot: sdlc-implementer-backend
depends_on: [TASK-001]
paths: ["apps/api/src/db/**", "apps/api/drizzle/**", "apps/api/src/db/schema/tenants.ts"]
contracts: [design/contracts/rls-policy-template.md, design/contracts/tenant-context.md]
test_files: []
acceptance: [AC-8, AC-9, AC-10, AC-11]
rework_count: 0
---

## Intent

Establish the one way tenant-scoped data is reached, so nothing later can bypass it.

## Approach

**GC-5** — every tenant-scoped query runs inside a transaction that has issued `SET LOCAL app.tenant_id`; Drizzle is the data-access layer; RLS is enabled on the tenants table and the pattern is reusable by later schema TASKs; **the database role used by the API must not hold `BYPASSRLS`**; context must not leak across pooled connections.

## Out of scope for this TASK

Any domain table other than `tenants`, auth, seeding, the isolation suite itself (TASK-006).

## Interfaces

**Consumes**

`apps/api` workspace (TASK-001).

**Produces**

`withTenantTransaction(tenantId, fn)` — runs `fn` inside a transaction with `app.tenant_id` set and rolls back on throw; `db` — the Drizzle client; the migration runner command; `tenants` table with columns `id`, `name`, `created_at`; a documented RLS policy template that every later tenant-scoped table applies.
