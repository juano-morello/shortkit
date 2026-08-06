---
id: TASK-005
story: STORY-003
epic: EPIC-001
title: Database connection, migrations, and the tenant-context transaction helper
status: tests-red
owner_slot: sdlc-implementer-backend
depends_on: [TASK-001]
paths: ["apps/api/src/db/**", "apps/api/drizzle/**", "apps/api/drizzle.config.ts", "apps/api/scripts/**", "apps/api/src/db/schema/tenants.ts", "docker-compose.test.yml", "apps/api/vitest.integration.config.ts", "apps/api/src/tenancy/tenant-context.ts", "apps/api/package.json", "pnpm-lock.yaml", "docs/architecture/rls.md", "docs/architecture/migrations.md"]
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

**Amended 2026-08-05 (F-117 and F-122, ruled by Juano).** Three deliverables that
ADRs assigned to this TASK were unreachable from its paths. All three now land here
and `paths:` has been widened accordingly.

1. **`apps/api/drizzle.config.ts`** — ratified. The file already exists and is
   committed; `drizzle-kit migrate` has no CLI flag for the connection URL, so
   `db:migrate` does not run without it. No TASK card named it. This records reality
   rather than assigning new work.
2. **`docs/architecture/rls.md` and `docs/architecture/migrations.md`** — assigned
   here. ADR-0003 and ADR-0004 name both as this TASK's in their follow-ups. Note
   that **GC-13 does not cover them** — GC-13 is `docs.required: [README]` with
   TASK-001 as sole producer. Their real obligation is STORY-003's Definition of Done
   line, "Docs updated (README / API / ADR consequences)". They land now, while the
   mechanisms are fresh, because two procedure caveats the audit panel surfaced have
   no other home: drizzle's migrator decides what to apply by comparing **timestamps,
   not hashes**, so appending policies to an already-applied migration is a silent
   no-op; and the integration fixture drops and recreates `tenants`, so running the
   suite removes the migrated table and its policies, and re-running `db:migrate`
   will not restore them — `docker compose down -v` is the reset.
3. **`pnpm db:check-policies`** — assigned here in its **minimum viable form**, which
   needs no `tenantScopedTables()` and is therefore not blocked on TASK-053. Assert
   from `pg_class` that every table in schema `public` has both `relrowsecurity` and
   `relforcerowsecurity` true, with an explicit exception list. It lands before the
   second tenant-scoped table rather than after: grants to `shortkit_app` are
   automatic via `ALTER DEFAULT PRIVILEGES` while RLS is opt-in per table via two
   hand-appended lines drizzle-kit does not generate, so TASK-023 adding `links` and
   forgetting `ENABLE` or `FORCE` would ship a silently unprotected table with every
   gate green. Wiring the check into the CI integration job stays TASK-002's; the
   script and its `package.json` entry are this TASK's.

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

## ⚠ drizzle-kit added 2026-08-05 (F-080, found by sdlc-architect)

**`apps/api/package.json` must gain `drizzle-kit` 0.31.10 as well as `pg` and `@types/pg`.**
Do not add `pg` and stop. ADR-0004 gives you a `db:generate` script, and VERIFIED today
`drizzle-kit` is unresolvable and appears in no manifest in the repo — so that script has no
binary behind it and the migration half of this TASK cannot run at all.

`drizzle-kit` is a devDependency; `pg` is a runtime dependency. Both are pinned exactly, no
caret and no tilde, per ADR-0018. F-069 is the record of what an unreviewed pin looks like:
say in your report why you chose each version.

## ⚠ pnpm-lock.yaml added 2026-08-05 (F-085, ruled by Juano)

**The lockfile moves with the manifest.** Juano's F-075 ruling — the consuming TASK owns its
own workspace manifest — reads as covering `pnpm-lock.yaml` too, and this TASK's paths now
include it. Commit the manifest change and the regenerated lockfile **together**, in the same
commit as the code that needs them.

The pre-flight scan found that `pnpm-lock.yaml` appeared in exactly one paths list across all
58 TASKs, TASK-001's, and TASK-001 is done — so nobody owned it. That is not cosmetic here.
Every CI job installs with `--frozen-lockfile` (TASK-002), so a `package.json` gaining `pg`,
`@types/pg` and `drizzle-kit` without its regenerated lockfile fails install for every TASK
after this one, not just this one.

Regenerate it by running the install, never by hand-editing. If a later wave puts two manifest
holders in one wave, that wave needs worktree isolation and the lockfile is resolved by
re-running the install on the merged manifests — never by merging lockfile hunks.
