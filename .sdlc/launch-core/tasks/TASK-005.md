---
id: TASK-005
story: STORY-003
epic: EPIC-001
title: Database connection, migrations, and the tenant-context transaction helper
status: tests-red
owner_slot: sdlc-implementer-backend
depends_on: [TASK-001]
paths: ["apps/api/src/db/**", "apps/api/drizzle/**", "apps/api/src/db/schema/tenants.ts", "docker-compose.test.yml", "apps/api/vitest.integration.config.ts", "apps/api/src/tenancy/tenant-context.ts", "apps/api/package.json"]
contracts: [design/contracts/rls-policy-template.md, design/contracts/tenant-context.md]
test_files: ["apps/api/test/tenancy/tenant-context.int-spec.ts"]
acceptance: [AC-8, AC-9, AC-10, AC-11]
rework_count: 0
---

## Intent

Establish the one way tenant-scoped data is reached, so nothing later can bypass it.

## Approach

**GC-5** — every tenant-scoped query runs inside a transaction that has issued `SET LOCAL app.tenant_id`; Drizzle is the data-access layer; RLS is enabled on the tenants table and the pattern is reusable by later schema TASKs; **the database role used by the API must not hold `BYPASSRLS`**; context must not leak across pooled connections.

## Out of scope for this TASK

Any domain table other than `tenants`, auth, seeding, the isolation suite itself (TASK-006).

**Amended 2026-08-04 (F-038, ruled by Juano).** This TASK now also produces
`docker-compose.test.yml`, which stands up the `postgres:17-alpine` that
`pnpm test:integration` connects to locally. ADR-0001 requires the file and no TASK
produced it: TASK-001 excludes "Database" by name, and this TASK's paths did not reach
it. It lands here because the migration runner and the non-`BYPASSRLS` role are both
already this TASK's, and neither is verifiable without a database to apply them to.
The CI-side equivalent is a `services:` container and belongs to TASK-002 (F-039), not
here.

## Interfaces

**Consumes**

`apps/api` workspace (TASK-001).

**Produces**

`withTenantTransaction(tenantId, fn)` — runs `fn` inside a transaction with `app.tenant_id` set and rolls back on throw; `db` — the Drizzle client; the migration runner command; `tenants` table with columns `id`, `name`, `created_at`; a documented RLS policy template that every later tenant-scoped table applies.

## ⚠ Obligation added 2026-08-04 (F-064, ruled by Juano)

**Remove `passWithNoTests: true` from `apps/api/vitest.integration.config.ts`.** TASK-001
set it so `pnpm test:integration` would not fail an empty repo, and named you and TASK-056
as the suppliers of real suites. It must not survive past the first real `.int-spec.ts`.
While it stands, an integration run that matches nothing is indistinguishable from one that
passed. You produce `docker-compose.test.yml` and the migration runner, so you are the
first TASK that can write an integration test at all.

## ⚠ Paths widened 2026-08-05 (F-074, F-075, F-076 — ruled by Juano)

Three files were added to `paths`, each because this TASK was already obliged to write it.

- **`apps/api/src/tenancy/tenant-context.ts`** (F-074). `withTenantTransaction` lives here,
  not under `apps/api/src/db/**`, and all four of this TASK's ACs assert its behaviour.
  The stub's own header already splits the file — *"Produced by: TASK-005
  (withTenantTransaction, tenantDb), TASK-011 (interceptor, RequestContext)"* — so only the
  paths list disagreed. **Juano ruled the narrow file glob, not `apps/api/src/tenancy/**`.**
  TASK-011 keeps the directory for the interceptor and `RequestContext`. You write this one
  file and nothing else under `tenancy/`. Two TASKs holding one file is the same shape as
  TASK-009 and TASK-058 on `auth.config.ts`, sequenced by TASK-011's `depends_on`.

- **`apps/api/package.json`** (F-075). `pg` and `@types/pg` are unresolvable from `apps/api`
  today — verified `MODULE_NOT_FOUND` — though ADR-0002 names `pg` as the driver and
  `drizzle-orm/node-postgres` requires it. Juano ruled that **the consuming TASK owns its own
  workspace manifest**, so the dependency lands in the same commit as the code that needs it.
  ADR-0018 makes exact pinning the stance: no caret, no tilde. F-069 is what an unreviewed
  pin looks like — say in your report why you chose the version you chose.

- **`apps/api/vitest.integration.config.ts`** (F-076). See the F-064 obligation block above;
  the paths list simply never picked up the file that ruling named.

**Ownership note.** If a wave-1 sibling also gains `apps/api/package.json`, this wave stops
being parallel-safe on that one file and needs worktree isolation. Check the wave table before
dispatch rather than assuming.
