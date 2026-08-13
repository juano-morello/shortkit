---
id: TASK-002
story: STORY-001
epic: EPIC-001
title: Better Auth tables, tenant_memberships with its unique constraint, and tenantIdForUser
status: todo
owner_slot: sdlc-implementer-backend
depends_on: []
paths: ["apps/api/src/db/schema/auth.ts", "apps/api/src/db/schema/tenant-memberships.ts", "apps/api/src/db/schema/index.ts", "apps/api/src/db/schema/auth.spec.ts", "apps/api/drizzle/**", "apps/api/src/auth/tenant-id-for-user.ts", "apps/api/src/auth/membership-lookup.ts", "apps/api/src/db/rls.ts", "apps/api/src/db/client.ts", "apps/api/scripts/check-policies.mts", "apps/api/test/isolation/registrations.ts", "apps/api/test/isolation/coverage.ts", "apps/api/test/isolation/cross-tenant-isolation.int-spec.ts", "apps/api/test/isolation/controls.ts", "docs/architecture/rls.md"]
# paths WIDENED 2026-08-13 by Juano at the Design wave-1 gate, F-002. Six files its own design
# requires and its original declaration did not reach. THE WAVE TABLE IS UNCHANGED: TASK-001 is
# packages/contracts/** only, so wave 1 stays parallel-safe, and every other claimant of these
# files (003 w2, 005 w4, 014 w8, 015 w9) is strictly later. A declaration gap, not an ordering one.
# WIDENED A SECOND TIME 2026-08-13, F-010, after design round 1 moved the fix into the shared
# RLS template, which has more consumers than the new policy did. controls.ts and
# docs/architecture/rls.md are live sites of the old predicate. Neither is claimed by another
# TASK. WITHOUT controls.ts, F-009 IS UNFIXABLE AND THE HARNESS GOES ON PROVING ISOLATION
# AGAINST THE PREDICATE ADR-0049 REPLACED - green, because the old form isolates correctly on a
# cold connection, which is the only state the fixture creates.
contracts: [design/contracts/rls-policy-template.md, design/contracts/isolation-coverage.md, design/contracts/tenant-context.md]
test_files: ["apps/api/src/auth/tenant-id-for-user.spec.ts (unit)", "apps/api/test/auth/tenant-memberships.int-spec.ts (integration)", "apps/api/test/isolation/cross-tenant-isolation.int-spec.ts (isolation, registration only — the assertions there are TASK-015's)"]
acceptance: [AC-2, AC-4]
rework_count: 0
---

## Intent

Put Better Auth's own tables and the `tenant_memberships` table into the one migration
system, with the unique constraint that makes one-tenant-per-user structural and the single
lookup that turns a user id into a `tid` claim.

## Approach

**One migration, three obligations, one commit.** `tenant_memberships` is a tenant-scoped
table, so it owes all three of these in the same commit or the build fails:

1. its `tenant_id` column declared through `TENANT_ID_COLUMN_SQL`
   (`apps/api/src/db/rls.ts:103-104` — `tenant_id uuid NOT NULL REFERENCES tenants(id) ON
   DELETE CASCADE`),
2. the output of `tenantScopedPolicies('tenant_memberships')` (`apps/api/src/db/rls.ts:57-80`)
   hand-appended to the migration drizzle-kit generates, because **Drizzle Kit generates no
   policy DDL** (`rls.ts:6-8`),
3. a `registerTenantScopedSurfaces()` call in `apps/api/test/isolation/registrations.ts`
   naming the table, its owner column and its access methods.

`pnpm db:check-policies` fails on a missing (2); the isolation harness's registry-versus-
database cross-check fails the run on a missing (3). **Splitting any of the three into a
follow-up is a defect, not a sequencing choice.** F-239 is the reason the split is unsafe in
time as well as in review: `ALTER DEFAULT PRIVILEGES` grants `shortkit_app` full DML on
every table the migrator creates, so a new table is writable by the runtime role before any
policy exists for it.

**Better Auth's tables carry no `tenant_id` and no row-level security.** ADR-0013 fixes
that, ADR-0003 explains why it is not a GC-5 exception, and
`apps/api/scripts/check-policies.mts` already names `user`, `session`, `account`,
`verification` **and `jwks`** — **FIVE entries, not four**. Corrected 2026-08-13 at the Design
wave-1 gate; `jwks` was added by F-232 on 2026-08-07, so the `jwt` plugin's table is already
listed. **Add no entry to that list.** Per ADR-0044 you add only the `EXEMPT.size !== 5`
length control. The script's own docblock still says "None of the four exist yet" and is
stale in the same way — that correction is yours, filed as F-001.

`apps/api/src/db/schema/auth.ts` is Better Auth's schema for the pinned `1.6.26` with the
`jwt` and `bearer` plugins enabled, checked in and owned from then on by drizzle-kit
(ADR-0013). ADR-0013 says it is generated once with the Better Auth CLI. **Do not guess the
column naming.** `apps/api/test/support/auth-fixture.ts:19-27` records that nothing in
`design/**` or `tasks/**` fixes whether the generated column is `emailVerified` or
`email_verified`, and the fixture discovers column names from `pg_attribute` for exactly
that reason. Whatever this file declares is what that fixture will find.

`tenant_memberships` follows ADR-0015 exactly: `id uuid PRIMARY KEY DEFAULT
gen_random_uuid()`, `tenant_id` per (1) above, `user_id text NOT NULL REFERENCES "user"(id)
ON DELETE CASCADE`, `role tenant_role NOT NULL`, `created_at timestamptz NOT NULL DEFAULT
now()`, and `CONSTRAINT tenant_memberships_user_unique UNIQUE (user_id)`. **`user_id` is
`text`** — Better Auth's shape, not this repository's uuid convention — and it is the only
non-uuid foreign key in the schema. `tenant_role` is a Postgres enum carrying exactly
`owner`, `admin`, `member`, per ADR-0015 amendment A-8.

The barrel at `apps/api/src/db/schema/index.ts` gains `export * from './auth';` and
`export * from './tenant-memberships';`, alphabetically. Drizzle Kit reads a glob over the
directory and does not import the barrel, so a forgotten line still produces a correct
migration and is caught only by ADR-0019's cross-check — add both lines.

`tenantIdForUser(userId)` is the single-row lookup on the unique index that ADR-0013's
`definePayload` calls at mint time and ADR-0015 requires to **throw** when no membership row
exists. It runs at token-mint time, when no tenant context is open and no `tid` is known —
that is the chicken-and-egg ADR-0013 names, and it is why this function exists at all. How
it reaches the database without an ambient tenant context, given that
`apps/api/src/db/client.ts:11-23` exports only `databaseTransaction` against an enumerated
caller list, is a **Design decision** and is listed for the architect. Whatever Design rules,
the caller list in `client.ts` is normative and this TASK does not widen it unilaterally.

Migration ordering: this is migration `0001`. TASK-011 adds `workspaces` as a later
migration. Two TASKs generating migrations concurrently would collide on drizzle's
`_journal.json`, which is why TASK-011 depends on this one.

## Out of scope for this TASK

The Better Auth instance and its plugin configuration (TASK-003) — this TASK writes no
`auth.config.ts`. The `workspaces` table (TASK-011). The `memberships` workspace-level table
(item 1b, not built). Any endpoint, any guard, any web code. Endpoint-level isolation
controls (TASK-014, TASK-015) — this TASK's registry entry covers the **table**, and the
assertions in `cross-tenant-isolation.int-spec.ts` are not edited here.

## Interfaces

**Consumes**

From `apps/api/src/db/rls.ts` (shipped):
- `TENANT_ID_COLUMN_SQL: string` — `'tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE'`
- `tenantScopedPolicies(table: string): PolicySet` — four DDL statements plus the `tenant_id` index; table name validated by `assertTableName` against `^[a-z_][a-z0-9_]*$`
- `assertRuntimeRoleCannotBypassRls(): Promise<void>`

From `apps/api/src/db/schema/tenants.ts` (shipped):
- `tenants` — `id uuid PRIMARY KEY` (application-supplied), `name text NOT NULL`, `createdAt timestamptz NOT NULL DEFAULT now()`

From `apps/api/test/isolation/coverage.ts` (shipped):
- `registerTenantScopedSurfaces(registration: TenantScopedSurfaceRegistration): void` — exported at `coverage.ts:614`, called at `registrations.ts:591`
- `interface TenantScopedSurfaceRegistration { subject: string; table: string; ownerColumn: string; reset: () => void | Promise<void>; methods: readonly TenantScopedMethod[] }`
- `interface TenantScopedMethod { ...; qualification: 'owner-qualified' | 'unqualified'; attempt: CrossTenantAttempt }` — `qualification` is **required**, deliberately undefaulted (F-342)
- `tableAccess({ table, ownerColumn, projection, mutableColumn, plantedOwnerId, plantedRow })` from `registrations.ts` — the generic table-attempt builder both existing subjects use

From `packages/contracts/src/roles.ts` (shipped): `TENANT_ROLES`, `TENANT_ROLE`.

**Produces**

- `apps/api/src/db/schema/auth.ts` — Better Auth 1.6.26's tables for the `jwt` and `bearer`
  plugins: `user`, `session`, `account`, `verification` and the plugin's key table. No
  `tenant_id`, no RLS.
- `apps/api/src/db/schema/tenant-memberships.ts` — `export const tenantMemberships` with
  columns `id`, `tenantId`, `userId`, `role`, `createdAt`, and the Postgres enum
  `tenant_role` carrying `owner | admin | member`.
- `apps/api/drizzle/0001_*.sql` — creates every table above, plus the hand-appended
  `tenantScopedPolicies('tenant_memberships')` statement set.
- `apps/api/src/auth/tenant-id-for-user.ts` exporting:
  - `tenantIdForUser(userId: string): Promise<string>` — resolves to the tenant id on that
    user's single `tenant_memberships` row, lower-cased uuid; **throws
    `NoTenantMembershipError` when no row exists.** Never returns `null` and never returns
    an empty string.
  - `class NoTenantMembershipError extends Error` — `name` is `'NoTenantMembershipError'`;
    carries the user id it was asked about and no email address.
- `apps/api/test/isolation/registrations.ts` — one added
  `registerTenantScopedSurfaces()` call for subject `TenantMembershipsTableAccess`, table
  `tenant_memberships`, owner column `tenant_id`.
- `apps/api/src/db/schema/index.ts` — two added `export *` lines.
