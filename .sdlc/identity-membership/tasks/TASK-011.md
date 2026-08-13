---
id: TASK-011
story: STORY-004
epic: EPIC-001
title: The workspaces table, its policies, its registration and WorkspaceRepository
status: todo
owner_slot: sdlc-implementer-backend
depends_on: [TASK-002, TASK-006]
paths: ["apps/api/src/db/schema/workspaces.ts", "apps/api/src/db/schema/index.ts", "apps/api/drizzle/**", "apps/api/src/workspaces/workspace.repository.ts", "apps/api/test/isolation/registrations.ts"]
contracts: [design/contracts/rls-policy-template.md, design/contracts/isolation-coverage.md, design/contracts/workspaces.md]
test_files: ["apps/api/src/workspaces/workspace.repository.spec.ts (unit)", "apps/api/test/workspaces/workspace-repository.int-spec.ts (integration)", "apps/api/test/isolation/cross-tenant-isolation.int-spec.ts (isolation, registration only — the assertions there are TASK-015's)"]
acceptance: [AC-25, AC-26]
rework_count: 0
---

## Intent

Add the second real tenant-scoped table this repository has ever had, with every statement
the template produces, and the repository that reads it inside tenant context.

## Approach

**Three obligations, one commit.** `workspaces` is a tenant-scoped table, so this TASK
delivers all three of these together or the build fails:

1. the `tenant_id` column declared through `TENANT_ID_COLUMN_SQL`
   (`apps/api/src/db/rls.ts:103-104` — `tenant_id uuid NOT NULL REFERENCES tenants(id) ON
   DELETE CASCADE`),
2. the output of `tenantScopedPolicies('workspaces')` (`rls.ts:57-80`) **hand-appended** to
   the migration drizzle-kit generates, because Drizzle Kit generates no policy DDL
   (`rls.ts:6-8`),
3. a `registerTenantScopedSurfaces()` call in `apps/api/test/isolation/registrations.ts`.

`pnpm db:check-policies` fails on a missing (2) by comparing against `pg_policies`; the
isolation harness's registry-versus-database cross-check fails the run on a missing (3).
**A follow-up TASK for any of the three is a plan defect, not a sequencing choice.** F-239
is the reason they are not separable in time: `ALTER DEFAULT PRIVILEGES` grants
`shortkit_app` full DML on every table the migrator creates, so the table is writable by the
runtime role from the moment it exists and before any policy covers it.

`tenantScopedPolicies` produces four DDL statements plus the `tenant_id` index: enable RLS,
force RLS, one `FOR ALL` policy with **matching** `USING` and `WITH CHECK` on
`tenant_id = current_setting('app.tenant_id', true)::uuid`, and a privileged-erase
`FOR DELETE` policy. `workspaces` is a template-shaped table and takes the template unchanged
— it is **not** a cascade root and must not copy `tenants`' bespoke four-policy set.

**Columns.** `id uuid`, `tenant_id` per (1), `name text NOT NULL`, `created_at timestamptz
NOT NULL DEFAULT now()`, and whatever column carries the archived state. **Design fixes the
archive representation** — nullable timestamp, boolean, or status enum — and it is listed for
the architect. AC-23 is written against the observable and holds under any of them.

Whether `id` is application-supplied like `tenants.id` or database-generated is also
Design's. `tenants` carries an application-supplied id for a specific reason — signup mints
it and opens the tenant transaction under it before inserting, so the row it writes is the
one `tenants_self_insert` admits (ADR-0021) — and that reason **does not apply** to a
workspace created inside an already-open tenant transaction.

The barrel `apps/api/src/db/schema/index.ts` gains `export * from './workspaces';`,
alphabetically. Drizzle Kit reads a glob over the directory and does not import the barrel,
so a missing line still produces a correct migration and is caught only by ADR-0019's
cross-check against `information_schema`.

**Migration ordering.** This is migration `0002`. It depends on TASK-002's `0001` because two
TASKs generating migrations concurrently collide on drizzle's `_journal.json`, and because
`workspaces.tenant_id` references `tenants(id)`, which `0000` already created.

**`WorkspaceRepository` carries `@TenantScopedRepository()`** (TASK-006) and every method
runs inside tenant context. It reads the ambient handle through `tenantDb()` rather than
taking a client argument, and `tenantDb()` throws `TenantContextMissingError` outside an
active transaction — which is what makes an accidental unscoped read a crash rather than a
leak. It never imports `databaseTransaction` from `apps/api/src/db/client.ts`: that export
has an enumerated caller list at `client.ts:11-23` and a repository is not on it.

**Every statement this repository issues must be owner-qualified even though the policy
already scopes it.** The isolation harness's round-2 finding is exactly this: an
owner-qualified write is routed through the SELECT policy by PostgreSQL and reports zero
rows however wide open the UPDATE policy is — so a repository that relies on the policy alone
produces statements whose refusal proves less than it appears to. The registry's
`qualification` field is required and undefaulted (F-342) for the same reason.

## Out of scope for this TASK

The workspace endpoints and their contracts (TASK-012). Any web code. The endpoint-level
isolation controls (TASK-014, TASK-015) — this TASK's registry entry covers the **table**,
and the assertions in `cross-tenant-isolation.int-spec.ts` are not edited here. The
`memberships` workspace-level table and `WorkspaceRole` enforcement (item 1b, not built).
Branding fields on a workspace (roadmap item 3).

## Interfaces

**Consumes**

From `apps/api/src/db/rls.ts` (shipped):
- `TENANT_ID_COLUMN_SQL: string`
- `tenantScopedPolicies(table: string): PolicySet` — table name validated by `assertTableName` against `^[a-z_][a-z0-9_]*$`

From `apps/api/src/tenancy/tenant-context.ts` (shipped) and TASK-006:
- `tenantDb(): TenantDb` — throws `TenantContextMissingError` outside an active context
- `currentTenantId(): string`
- `TenantScopedRepository(): ClassDecorator` — implemented by TASK-006; **throws `not implemented` before it lands**
- `TENANT_SCOPED_REPOSITORY_METADATA: symbol` (TASK-006)

From TASK-002: migration `0001` and the schema barrel's current contents.

From `apps/api/test/isolation/coverage.ts` (shipped):
- `registerTenantScopedSurfaces(registration: TenantScopedSurfaceRegistration): void`
- `interface TenantScopedSurfaceRegistration { subject: string; table: string; ownerColumn: string; reset: () => void | Promise<void>; methods: readonly TenantScopedMethod[] }`
- `interface TenantScopedMethod { qualification: 'owner-qualified' | 'unqualified'; attempt: CrossTenantAttempt; ... }`
- `tableAccess({ table, ownerColumn, projection, mutableColumn, plantedOwnerId, plantedRow })` from `registrations.ts`

**Produces**

- `apps/api/src/db/schema/workspaces.ts` — `export const workspaces`, template-shaped,
  carrying `tenant_id`
- `apps/api/drizzle/0002_*.sql` — creates `workspaces` with the hand-appended
  `tenantScopedPolicies('workspaces')` statement set
- `apps/api/src/db/schema/index.ts` — one added `export *` line
- `apps/api/src/workspaces/workspace.repository.ts` exporting
  `WorkspaceRepository`, decorated `@TenantScopedRepository()`, with:
  - `create(input: { name: string }): Promise<Workspace>`
  - `list(options: { includeArchived: boolean }): Promise<Workspace[]>`
  - `rename(id: string, name: string): Promise<Workspace>`
  - `archive(id: string): Promise<Workspace>`
  - `findById(id: string): Promise<Workspace | null>`

  Every method reads `tenantDb()` and issues owner-qualified statements. `Workspace` is the
  row shape TASK-012's contract mirrors.
- `apps/api/test/isolation/registrations.ts` — one added
  `registerTenantScopedSurfaces()` call for subject `WorkspaceRepository`, table
  `workspaces`, owner column `tenant_id`, with one `TenantScopedMethod` per repository
  method above and each method's `qualification` stated explicitly
