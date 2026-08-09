---
id: ADR-0019
slug: foundation
title: Enumerate tenant-scoped tables from the Drizzle schema, cross-checked against information_schema
status: accepted
supersedes: null
date: 2026-08-04
---

## Context

AC-88 requires the GDPR export to contain records from every category a tenant owns.
AC-90 requires a referential check over every table containing a `tenant_id` to return
zero rows after deletion. TASK-053 says the export enumerates tables rather than listing
them by hand, so a table added later without coverage fails the test.

The failure this prevents is specific. Someone in a later initiative adds
`link_tags(tenant_id, ...)`, ships it, and it silently escapes both export and
erasure. The export is a compliance gap and the erasure is a legal one, and neither
produces an error. A hand-maintained array would look exactly the same on the day it
became wrong.

`tenantScopedTables()` is consumed by TASK-053, TASK-054 and TASK-056, so it is a
contract before it is an implementation.

## Decision

**Primary source: the Drizzle schema, at runtime.**

```ts
import * as schema from '../db/schema';

export function tenantScopedTables(): TenantScopedTable[] {
  return Object.values(schema)
    .filter((v): v is PgTable => is(v, PgTable))
    .filter((t) => 'tenant_id' in getTableColumns(t))
    .map((t) => ({ name: getTableName(t), table: t }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
```

Adding a table with a `tenant_id` column and exporting it from the barrel adds it to
export, to erasure and to the isolation suite with no other edit.

**Cross-check: the database, in a test.** The barrel is a file someone can forget.
A migration adding a table by raw SQL bypasses the schema entirely. So a test in the
integration suite asserts set equality:

```sql
SELECT table_name FROM information_schema.columns
WHERE table_schema = 'public' AND column_name = 'tenant_id';
```

against `tenantScopedTables().map(t => t.name)`. A mismatch fails and names the
offending table in both directions. Two independent enumerations that must agree is
what makes this stronger than either one.

**A short, justified exclusion list.** `TENANT_SCOPED_TABLE_EXCLUSIONS` in the same
file, currently `['tenants']`, because `tenants` carries `id` rather than `tenant_id`
and is handled explicitly as the cascade root. Every entry carries a comment naming
why. The cross-check subtracts it from both sides, so an unjustified addition is a
diff a reviewer sees.

**Auth tables are outside this enumeration by design.** `user`, `session`, `account`
and `verification` carry no `tenant_id` (ADR-0003, ADR-0015), so they do not appear
here. `authOwnedUserTables()` is a separate, deliberately named export that TASK-054
uses, and TASK-053 exports member identity through `tenant_memberships` joined to
`user`. Keeping them separate is what keeps `tenantScopedTables()` meaning exactly
one thing.

**Erasure uses the cascade, and verifies with the enumeration.** Revised 2026-08-04
(F-002). The original sequence ran in one transaction setting only
`app.privileged_erase`, so its opening `SELECT` of `tenant_memberships` was denied by
`tenant_isolation` (which tests the unset `app.tenant_id`) and not admitted by the erase
policy (which is `FOR DELETE`). The user id list came back empty, no account was
deleted, `DELETE FROM tenants` was denied for the same reason, and the residue check
asserted zero over an empty set and passed. A completed GDPR erasure deleted nothing and
reported success. Three transactions now, and the census is an input rather than
something the eraser collects for itself.

1. **Census**, ordinary tenant context: member user ids and a row count per table.
   Assert `userIds.length >= 1` and `rowCounts['tenant_memberships'] >= 1` before
   anything is deleted. The owner issuing the request is a member of their own tenant,
   so an empty census means RLS denied the read.
2. **Erase**, under `set_config('app.privileged_erase', ...)`:
   `DELETE FROM tenants WHERE id = $1` asserting rowCount 1, then
   `DELETE FROM "user" WHERE id = ANY($2)` asserting rowCount equals the census.
   `tenants_privileged_erase` is the only `DELETE` policy on `tenants` (ADR-0003), so
   this is the only statement anywhere that can remove that row. Every `tenant_id`
   foreign key declares `ON DELETE CASCADE`, and PostgreSQL runs referential actions
   with row security bypassed, so the cascade reaches rows the erase policy alone would
   not.
3. **Verify**, ordinary tenant context: `assertNoTenantResidue(census)` iterates
   `tenantScopedTables()` and `authOwnedUserTables()` and asserts zero everywhere.

**"Zero rows before, zero rows after" can no longer pass**, because steps 1 and 2 assert
non-zero first. If the cascade misses a table under `FORCE ROW LEVEL SECURITY`, step 3
fails and names it, and the fallback is an explicit per-table `DELETE` in reverse
dependency order driven by the same enumeration.

**Export iterates the same list, in tenant context.** `POST /gdpr/export` runs inside
`withTenantTransaction`, so RLS does the filtering and AC-89's "zero records belonging
to tenant B" is a property of the database rather than of a `where` clause. Output is a
zip of one NDJSON file per table plus a `manifest.json` naming the tables, the row
counts, and the schema version.

## Alternatives considered

| Option | Pros | Cons | Why not |
|---|---|---|---|
| A hand-maintained `const TENANT_TABLES = [...]` | Explicit; readable; no reflection | TASK-053 forbids it, and correctly: a table added later is absent from the list and nothing fails. The failure is silent and the consequence is legal | Explicitly ruled out by the TASK, and it is the exact defect this exists to prevent |
| Query `information_schema` at runtime as the only source | Always matches the live database; no barrel to forget | The export needs Drizzle table objects to build typed queries, not just names. It also means the export's shape depends on the database it happens to be connected to | Right source for verification, wrong source for construction. Kept as the cross-check |
| A `@TenantScoped()` decorator on each schema module | Explicit intent per table | A decorator someone forgets is a hand-maintained list with more syntax. The `tenant_id` column is the ground truth already | Adds ceremony without adding a guarantee |
| Enumerate repositories instead of tables | Matches how the application reads data | A table with no repository still holds a tenant's rows and still has to be erased. Repository coverage is a different property, handled by ADR-0020 | Solves a different problem |

## Consequences

### Positive

- Adding a tenant-scoped table wires it into export, erasure and the isolation suite by
  adding a column and a barrel line.
- A table added by raw SQL, or added to the schema but missing from the barrel, fails a
  test that names it. Both directions of drift are caught.
- Erasure is one `DELETE` whose completeness is asserted rather than assumed, and the
  ADR-0003 policy means even the eraser cannot cross tenants.
- An erasure that deletes nothing fails loudly instead of reporting success. The census
  assertions catch a policy denial before the destructive statement runs.
- Export isolation is enforced by RLS, so AC-89 asserts an outcome rather than an
  intention.

### Negative / accepted cost

- The enumeration depends on the column being named exactly `tenant_id`. A table using
  `owner_tenant_id` is invisible to both the schema filter and the SQL cross-check, and
  nothing notices. The naming convention is now load-bearing and only a code review
  enforces it.
- Erasure relies on `ON DELETE CASCADE` reaching every table. A schema TASK that
  declares `tenant_id` without the foreign key produces orphans, caught only by AC-90's
  residue check in wave 11.
- The cross-check runs only in the integration suite, so a developer adding a table and
  running `pnpm test` sees nothing.
- Erasure is three transactions instead of one, so it is no longer atomic. A crash
  between phase 2 and phase 3 leaves the data gone and unverified, and a crash inside
  phase 2 after the `tenants` delete commits leaves orphaned `user` rows. Phase 3 is the
  detection, and re-running the route is the repair.
- `authOwnedUserTables()` is a second, separately maintained list covering the auth
  tables, and it is genuinely hand-maintained. Better Auth adding a table in an upgrade
  would escape erasure. A test asserting the set against Better Auth's generated schema
  file is the mitigation, and it is weaker than the `tenant_id` check.
- The export loads each table fully into an NDJSON stream inside one transaction. A
  large tenant holds a connection for the duration.

### Follow-ups this creates

- TASK-053 owns `tenantScopedTables()`, the exclusion list, the cross-check test, and
  the export.
- TASK-054 owns `privilegedTenantEraser`, `authOwnedUserTables()`,
  `assertNoTenantResidue`, and the cascade fallback if the residue check ever fails.
- Every schema TASK declares `tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE`.
- Contract: `design/contracts/tenant-scoped-tables.md`.
