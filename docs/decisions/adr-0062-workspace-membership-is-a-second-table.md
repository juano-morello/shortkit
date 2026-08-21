---
id: ADR-0062
slug: invitations
title: Workspace membership is a second table under the unchanged template, and its foreign key to workspaces is composite
status: accepted
supersedes: null
amends: null
depends_on: ADR-0003, ADR-0015, ADR-0019, ADR-0021, ADR-0049
date: 2026-08-18
---

## Context

`docs/roadmap.md` split identity into 1a and 1b and wrote down the cost of the split before
anyone paid it: "1b adds a boundary to a `workspaces` table and policy set that never had
one, which is F-236's class at one remove. Design owes an ADR clause naming what 1b adds and
why the existing policies survive it." This is that clause.

What 1a shipped (TASK-011, ADR-0003, `apps/api/drizzle/0002_*.sql`): `workspaces` with the
template column `tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE`, and the
output of `tenantScopedPolicies('workspaces')` hand-appended: `FORCE ROW LEVEL SECURITY`,
`workspaces_tenant_isolation` (`FOR ALL`, matching `USING`/`WITH CHECK` on the `nullif`'d
`app.tenant_id`), `workspaces_privileged_erase` (`FOR DELETE` on `app.privileged_erase`), and
the `tenant_id` index. Every tenant member sees every workspace of the tenant; the only
boundary is the tenant.

What 1b needs: a person sees exactly the workspaces they were invited to, at exactly the
roles named (SC-7). ADR-0015 already decided where that lives: `tenant_memberships` holds
the `TenantRole`, one row per user ever; `memberships` holds the `WorkspaceRole`, one row per
user per workspace, and its alternatives table rejects one table with a nullable
`workspace_id`. So the question this ADR answers is not *whether* there is a second table but
what the second table does to the first: does `workspaces` gain a column, a policy, or a
different predicate, and if not, what makes "the caller holds a membership" a property the
database can refuse rather than one an application check asserts.

F-236's shape, for the reader who has not met it: a migration that reads and writes zero rows
under `FORCE ROW LEVEL SECURITY` and reports success, because the migrator is `NOBYPASSRLS`
and no context flag is set. Any 1b step that "adjusts" existing `workspaces` rows or derives
new rows from them inside a migration is that shape.

## Decision

### `workspaces` gains no column, no policy and no changed predicate

The 1b boundary is expressed entirely by a second table. `workspaces_tenant_isolation` and
`workspaces_privileged_erase` are the two policies `workspaces` has after 1b, with the quals
migration `0002` gave them; `workspace-repository.int-spec.ts` still holds `0002` to the
builder's output verbatim, and `db:check-policies` still counts two. Nothing in 1b writes
`ALTER POLICY`, `ALTER TABLE workspaces ADD COLUMN`, or a new `CREATE POLICY ... ON
workspaces`.

Why the policies survive: they were never asked to say *who in the tenant* may see a
workspace, only *which tenant* owns it, and that question has the same answer after 1b. The
narrower question is answered one table over. A per-user predicate on `workspaces` would need
a flag carrying the caller's user id: a fifth context flag, a fourth exclusion, a policy the
approved set does not list, and a `SELECT` on `workspaces` that depends on the request's
identity in a way `withTenantTransaction`'s contract does not express, for a property that a
join expresses already. ADR-0003's template stays the whole of what a tenant-scoped table
owes.

### Membership is `memberships`, under the unchanged template

```sql
CREATE TABLE memberships (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,   -- TENANT_ID_COLUMN_SQL
  workspace_id uuid NOT NULL,
  user_id      text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  role         workspace_role NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, user_id),
  FOREIGN KEY (workspace_id, tenant_id) REFERENCES workspaces (id, tenant_id) ON DELETE CASCADE
);
-- + tenantScopedPolicies('memberships'), verbatim, hand-appended (GC-A, F-239)
```

`invitations` and `invitation_workspaces` land in the same migration (`0003`), each with its
own `tenant_id`, its own `tenantScopedPolicies()` block and its own registration: three
tables, three obligations each, one commit. None of the three is a cascade root and none gets
a bespoke policy: the one `@Public()` route that reads `invitations` does so **inside**
`withTenantTransaction(<the token's tenant prefix>)` under the ordinary isolation policy, which
is ADR-0021's third sanctioned pattern and "not a GC-5 escape". `ISOLATION_EXCLUSIONS` stays at
three; `db:check-policies` counts fifteen policy sets over eleven tables.

### The foreign key to `workspaces` is composite, and that is the isolation argument

**Referential checks run with row security bypassed** (rls-policy-template.md, invariant 5:
the same fact that lets `DELETE FROM tenants` cascade through tables the eraser could not
read). So a plain `workspace_id uuid REFERENCES workspaces(id)` is satisfied by *any* tenant's
workspace id: a `memberships` row carrying tenant A's `tenant_id` and tenant B's
`workspace_id` passes `memberships_tenant_isolation`'s `WITH CHECK` (its `tenant_id` is the
context's) and passes the FK (the workspace exists, and the check does not care that A cannot
see it). That row is a grant of B's workspace to a user in A, written by A. Nothing in the
policy set can refuse it, because the policy set is about `tenant_id` and the row's
`tenant_id` is correct.

`FOREIGN KEY (workspace_id, tenant_id) REFERENCES workspaces (id, tenant_id)` refuses it at
the database: the check looks for the pair (B's workspace, A's tenant) in `workspaces` and no
such pair exists. `23503`, constraint `memberships_workspace_tenant_fk`, whatever an
application check did or failed to do. `invitation_workspaces` declares the same key, for the
same reason, so an invitation in tenant A cannot name a workspace of tenant B either: the
`POST /api/invitations` handler answers 404 for a workspace the caller does not admin (D-09)
long before this is reached, and the constraint is the floor under that check.

The target of both keys is **`UNIQUE (id, tenant_id)` on `workspaces`**, added in `0003`. It is
a constraint and not a column (`id` alone is already the primary key, so the pair is
trivially unique), and it is the one thing 1b changes about `workspaces`. Drizzle Kit emits it
after the foreign keys that reference it, and PostgreSQL refuses a `FOREIGN KEY` whose
referenced columns are not yet unique, so the migration file moves the generator's statement
ahead of them by hand and says so in a comment. Measured in
`test/db/migration-0003.int-spec.ts`: as `shortkit_app` in tenant A's transaction, B's
workspace is invisible (RLS), and a membership naming it is refused `23503`
`memberships_workspace_tenant_fk` with zero rows landing in either tenant's view.

### The list route filters by membership in its own statement; RLS still bounds it by tenant

`GET /api/workspaces` (TASK-1b-06, D-10) joins `memberships` on `user_id = ctx.userId` in the
statement it issues, owner-qualified like every repository statement, and the policy on both
tables still bounds the result to `app.tenant_id`. Two mechanisms, two properties: RLS says
"only this tenant's rows", the join says "only the rows this user was granted". Neither is
asked to do the other's job. Every workspace route runs the authorizer inside the tenant
transaction (D-05), reading `memberships` under the same policy.

There is no implicit tenant-owner bypass. The `workspace-authorization.md` status table is
unconditional; every tenant-level minimum in it is `admin`/`owner`, not "sees everything".
`POST /api/workspaces` creates the workspace **and** the creator's `workspace_admin`
membership in one transaction, so the person who makes a workspace can see it.

### No backfill of `memberships` for workspaces that already exist

An `INSERT INTO memberships ... SELECT ... FROM workspaces` inside migration `0003` runs as
`shortkit_migrator`, which is `NOBYPASSRLS` under `FORCE ROW LEVEL SECURITY`, with no
`app.tenant_id` set. It reads zero rows, inserts nothing, and reports success: F-236's shape,
exactly. Doing it correctly would mean iterating tenants inside a migration under a flag the
migration sets itself, which is the string-concatenated context flag rls-policy-template.md
forbids and a precedent nobody wants.

So there is no backfill. ADR-0030 records that there is no deploy target; the only place 1a
rows can exist is a developer's compose volume, and the remedy is the reset (`docker compose
down -v`, ADR-0032). After 1b, a workspace created before it has no `memberships` row and its
owner cannot list or rename it until the volume is reset. TASK-1b-11 puts that sentence in
README.

## Alternatives considered

| Option | Pros | Cons | Why not |
|---|---|---|---|
| A per-user policy on `workspaces`: `USING (EXISTS (SELECT 1 FROM memberships m WHERE m.workspace_id = id AND m.user_id = current_setting('app.user_id')))` | The boundary lives where the rows are; a route that forgets the join is still bounded | A fifth context flag and a fourth exclusion; a policy the approved set does not list; `db:check-policies` and the drift arms would need amending; a subselect through `memberships` under RLS in every `workspaces` predicate; and it changes `0002`'s policy set, which is exactly the "known cost" the roadmap said to avoid | The join expresses the same property with no change to the template, and the boundary a route could forget is the authorizer's job (D-05), which runs on every workspace route |
| A plain `workspace_id REFERENCES workspaces(id)` and an application check | One column, the idiomatic FK | Referential checks bypass RLS, so a grant naming another tenant's workspace is a valid row; the application check is the only thing between a bug and a cross-tenant grant | The composite key makes the row unexpressible; it costs one `UNIQUE (id, tenant_id)` on `workspaces` |
| Denormalise `tenant_id` away from `memberships` and rely on the join to `workspaces` for scoping | One fewer column | A table scoped "through its parent" is a table scoped by nothing: RLS does not follow a join, ADR-0019's enumeration cannot see it, and the erasure cascade needs the column | Every tenant-scoped table carries its own `tenant_id` and its own policy set (ADR-0003, ADR-0019) |
| A backfill in `0003` giving every existing workspace's tenant owner a `workspace_admin` row | Pre-1b workspaces stay reachable | Silently inserts nothing under `FORCE` (F-236); the honest version needs per-tenant flags set inside a migration | No deploy target (ADR-0030); reset the volume (ADR-0032) |
| Membership as rows in `tenant_memberships` with a nullable `workspace_id` | One membership table | Rejected by ADR-0015 already: a nullable key that changes the row's meaning and a `role` column holding two enums | Not reopened |

## Consequences

### Positive

- `workspaces`' policy set is byte-for-byte what `0002` applied; the "known cost" is a
  constraint, and the verbatim hold on `0002` stays green.
- A membership or an invitation grant naming another tenant's workspace is a `23503` at the
  database, independent of every application check: measured, not asserted.
- Three template-shaped tables, no bespoke policy, no new flag, no new exclusion; the
  isolation harness attacks all three with the same eight shapes it attacks the others with,
  and `tenantScopedTableDrift()` names any of them that stops being registered.
- Adding a workspace-level role check is one interceptor reading one table under the policy
  the table already has.

### Negative / accepted cost

- **A tenant `owner` holds no implicit workspace access** (D-10). The person who created the
  tenant sees the workspaces they created (`POST` writes their `workspace_admin` row), and no
  other. There is no route in 1b to add a member to an existing workspace, so a tenant `admin`
  (a role nothing in 1b grants) creating a workspace would leave the `owner` without a
  membership in it and no way to repair that short of an invitation. Reachable later, recorded
  now.
- **Pre-1b workspaces in a compose volume are unreachable until the volume is reset.** No
  backfill, for the reason above; README says so (TASK-1b-11).
- **`reparentAll` on `memberships` and `invitation_workspaces` has a second floor under it.**
  Under a widened `USING`, `UPDATE <t> SET tenant_id = <actor>` would rewrite the target's row
  to a (workspace, tenant) pair `workspaces` does not hold and the composite key refuses it
  `23503`, which the harness scores `unverified` rather than `fail`: a red run naming the
  surface, narrower than a named leak (F-342's accounting). The constraint refusing the theft
  is the property this ADR exists to record; the cost is that the report says "could not
  judge" where it might have said "leaked".
- **`workspaces` carries a redundant unique index.** `(id, tenant_id)` is unique because `id`
  is; the index exists to be a foreign-key target. One index per workspace row, on a table
  that will not be large.
- **`db:check-policies` and the drift arms are unchanged and therefore do not check the
  composite key.** A later table that references `workspaces(id)` plainly is a valid schema to
  both gates. `migration-0003.int-spec.ts` asserts the two keys that exist today; a third
  table needs its own assertion. Recorded rather than fixed: a generic "no plain FK to a
  tenant-scoped parent" check is a schema-reflection rule with its own false positives, and
  two keys do not justify it yet.

### Follow-ups this creates

- TASK-1b-04 and TASK-1b-05 register `InvitationRepository` and `MembershipRepository` methods
  as `repo:` subjects beside the three table batteries (F-353 pattern), so `report.json` names
  methods that exist.
- TASK-1b-06 implements the join in the list route and the creator membership on `POST`;
  `workspaces.md` carries both.
- TASK-1b-11 writes the reset sentence into README.
- Any later table referencing `workspaces` declares the composite key and adds a row to
  `migration-000N.int-spec.ts`'s constraint assertion; the schema file's docblock says so.
