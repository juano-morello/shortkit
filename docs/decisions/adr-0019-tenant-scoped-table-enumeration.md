---
id: ADR-0019
slug: foundation
title: Enumerate tenant-scoped tables from the Drizzle schema, cross-checked against information_schema
status: accepted
supersedes: null
date: 2026-08-04
---

> **Amended 2026-08-11 (F-303, F-333, F-327). The decision stands; two statements around it
> moved.** The SQL half of the cross-check shipped three waves early, inside TASK-006's
> isolation harness, and it shipped **wider than this ADR specified** — five independent
> properties rather than the single `tenant_id` column below, because this ADR's own accepted
> cost was measured coming true. As a result one sentence in "Negative / accepted cost" is now
> false as written, and the residual that replaces it belongs here rather than only in a test
> file. `ON DELETE CASCADE` also acquired a second consumer and is now load-bearing for two
> mechanisms rather than one. `tenantScopedTables()` itself, the exclusion list and the
> erasure sequence are unchanged and remain TASK-053's and TASK-054's. Details in
> `docs/contracts/isolation-coverage.md`, "The registry, and what bounds the covered set
> before TASK-056 exists".
>
> **Extended 2026-08-11, second pass (F-350).** The half-repair above is asymmetric and the
> first version of this amendment did not say so plainly enough: **the SQL half sees a table
> that departs from the naming convention and the schema half does not, and it is the schema
> half that export and erasure iterate.** A new cost bullet states which consumer depends on
> which enumeration, why that is F-002's shape arriving through a compliance door, why it is
> unreachable today, and what TASK-053 must do about it.

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

**Amended 2026-08-11 (F-303, F-333, F-327). The SQL half shipped early and wider than this.**
TASK-006 needed the cross-check before `tenantScopedTables()` existed, so it compares the
database against the isolation registry instead, and **the query above was not enough**. A
table whose owner column is called `owning_tenant`, force-RLS'd with a `USING (true)` policy,
leaked every row to every tenant while being invisible to this predicate and reported
protected by `db:check-policies` — measured. The shipped form asks **five** independent
questions: the table is `tenants`; it carries a column named `tenant_id`; row-level security
is enabled **and** forced; a policy reads `app.tenant_id`; or **it declares a foreign key to
`tenants(id)`**. The last is the only one that depends on neither protection nor a name, and
it is why the FK requirement below is now load-bearing twice over.

**The independence claim needs one qualification, and it is the point of F-333.** For an
*unprotected* table whose owner column is not `tenant_id`, the thing that caught it before
arm 5 was `db:check-policies`, which is a different gate run by a different step. Two
enumerations that must agree is stronger than one only while both actually see the table;
where one does not, the pair is a composite gate and not a redundant one. TASK-053's
`tenantScopedTables()` inherits this: **it is the schema half of a cross-check whose SQL half
now asks five questions, and matching only `tenant_id` on the schema side reintroduces the
gap on that side.**

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
  `owner_tenant_id` is invisible to both the schema filter and the SQL cross-check, ~~and
  nothing notices~~. The naming convention is now load-bearing and only a code review
  enforces it.

  **Amended 2026-08-11 (F-303, F-333, F-327). "Nothing notices" was measured coming true,
  and then half-repaired.** The measurement: `audit_events(owning_tenant)` returned another
  tenant's rows to the acting tenant while the isolation suite reported 15 passed,
  `registryDrift` was empty in both directions, and `db:check-policies` called the table
  protected. What notices now is the **SQL half**, through the four arms that do not read the
  column name; the **schema half** — `tenantScopedTables()`, still filtering on `'tenant_id'
  in getTableColumns(t)` — is unchanged and still does not notice, which is why a table
  missing from it also escapes export and erasure however loudly the isolation suite
  complains.

  **The residual, stated here rather than only in the harness.** A table escapes all five
  arms if it is not `tenants`, spells its owner column something other than `tenant_id`,
  declares no foreign key to `tenants`, carries no policy reading `app.tenant_id`, and is not
  force-RLS'd. That is three simultaneous departures from the convention this ADR sets, and
  nothing anywhere names such a table. **A boundary stated as a residual is what stops the
  next reader treating the enumeration as complete** — this ADR's original bullet said the
  convention was load-bearing, and the residual is exactly how much of the load it still
  carries. It is repeated here deliberately, because a reader of this ADR is deciding whether
  the convention matters; **if the arms change, `isolation-coverage.md` is the copy that
  moves first and this bullet follows it.**

- **The two enumerations have different coverage, and the consumers that matter most depend
  on the weaker one.** Added 2026-08-11 (F-350). Stated as its own cost because the previous
  bullet's repair is asymmetric and reads as though the gap were closed.

  | Enumeration | Sees a table whose owner column is not `tenant_id` | Consumers |
  |---|---|---|
  | the SQL half — five arms, `tenantScopedTableDrift()` | **yes**, through arms 3, 4 and 5 | the isolation suite (SC-1) |
  | the schema half — `tenantScopedTables()`, this ADR's `Decision` | **no.** One property: `'tenant_id' in getTableColumns(t)` | **the GDPR export (AC-88), erasure and its residue check (AC-90)**, and TASK-056's table-reachability check |

  So a table added with `owning_tenant`, or with the column named right but missing from the
  barrel, is **named loudly by the isolation suite and silently skipped by erasure**. The
  export omits a category the tenant owns, and `assertNoTenantResidue()` iterates a list the
  table is not on and reports zero. That is F-002's shape — a completed erasure that deleted
  less than it claimed and reported success — arriving through a different door, and the door
  it arrives through is a compliance one.

  **Not reachable today**, which is why this is recorded rather than escalated: all three
  consumers are deferred (TASK-053, TASK-054, TASK-056), and `public` holds one table.

  **The decision, so TASK-053 does not inherit it as an open question.** TASK-053 must close
  the gap on the schema side, and the cheaper of the two ways is the second:

  1. widen `tenantScopedTables()` to a name-independent derivation — the Drizzle table object
     exposes its foreign keys, so "declares a foreign key to `tenants(id)`" is expressible
     there and is the same property as SQL arm 5; or
  2. **keep the one-property filter and make the existing cross-check fail on the
     difference** — assert `tenantScopedTables()` against the five-arm SQL half rather than
     against the single-column query in the `Decision` above. The SQL half already exists and
     is already tested, so this is a test change rather than a schema-reflection change, and
     it fails closed with the table named.

  Either way the acceptance test is the same: **a table with an `owning_tenant` column and a
  foreign key to `tenants` must appear in whatever list erasure iterates**, or fail the build
  naming itself.

- **`ON DELETE CASCADE` on the tenant foreign key now has two consumers, not one.** Added
  2026-08-11 (F-333, F-327). It was required for erasure; it is also the fifth drift arm, the
  only enumeration property independent of both protection and column naming. A schema TASK
  that declares `tenant_id` without the foreign key therefore produces orphans **and** a
  table the drift check cannot see unless another arm happens to catch it. The bullet below
  about orphans understated the cost.
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
  the export. **Read before starting (added 2026-08-11, F-327):** the SQL half of the
  cross-check already exists, in `apps/api/test/isolation/coverage.ts` as
  `tenantScopedTableDrift()`, in a five-arm form this ADR did not specify. TASK-053 either
  consumes it or supersedes it deliberately; writing the one-property query above a second
  time reintroduces the gap F-303 measured.
- **The `tenant_id`-only filter in `tenantScopedTables()` is the weaker half of the pair, and
  closing that is TASK-053's, with the two options and the acceptance test written out under
  "Negative / accepted cost" (F-350).** It is a compliance gap rather than a tidiness one:
  erasure and export iterate the weaker half.
- TASK-054 owns `privilegedTenantEraser`, `authOwnedUserTables()`,
  `assertNoTenantResidue`, and the cascade fallback if the residue check ever fails.
- Every schema TASK declares `tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE`.
- Contract: `docs/contracts/tenant-scoped-tables.md`.
