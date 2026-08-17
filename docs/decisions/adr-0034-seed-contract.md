---
id: ADR-0034
slug: foundation
title: The seed is a list of idempotent per-table units that reports what it does not cover
status: accepted
supersedes: null
date: 2026-08-11
---

## Context

The production schema is one table. `apps/api/drizzle/0000_odd_betty_ross.sql` creates
`tenants` and nothing else. `rls_fixture_rows` is built at runtime by
`apps/api/test/support/rls-fixture.ts` and is not in any migration. Links, users, auth and
workspaces left with EPIC-002 through EPIC-006 in the 2026-08-09 re-scope.

So the honest seed inserts one demo tenant. The hazard is not that it covers little. It is
that a file called `seed.mts` reads as "the demo data" whatever it contains, and the next
person to add a table has no reason to think the seed needs anything. That is the same
defect class TASK-006 met and answered: a harness that reported PASS over two tables, fixed
by making the boundary a printed output rather than a comment. `apps/api/test/isolation/coverage.ts`
is the worked example, and the part of it that carries the weight is
`tenantScopedTableDrift()`, which asks the database what exists rather than trusting a list.

Two constraints bind the implementation. `tenants` carries `FORCE ROW LEVEL SECURITY` and
`tenants_self_insert` admits only a row whose `id` equals `current_setting('app.tenant_id')`,
so no role in the stack can insert a tenant without setting the flag first. And F-213
established that `information_schema` is privilege-filtered by the SQL standard, so a census
run as `shortkit_app` over `information_schema.tables` reports "nothing is there" when it
means "I cannot see it".

## Alternatives considered

**A one-off script that inserts one tenant.** Pros: five lines; nothing to maintain. Cons:
the next table's rows have nowhere obvious to go, so they get appended ad hoc, and the file
becomes a pile. Nothing states the boundary, so a reader assumes the seed is the demo
dataset. Why it lost: it is the artifact whose failure mode this ADR exists to prevent.

**A SQL file applied by the migrator alongside the migrations.** Pros: no TypeScript, no
`pg` dependency, runs in the same step. Cons: it cannot express idempotency across schema
changes without hand-written guards, it cannot report coverage, and it would run as
`shortkit_migrator`, which removes the grant check ADR-0033 depends on. Why it lost: it
gives up both of the two things this seed is for.

**A seed that truncates and reinserts, so it is idempotent by rebuilding.** Pros: the
simplest possible idempotency; the database always matches the file exactly. Cons: it
destroys anything a developer created, on every `up`, with no warning, in a stack whose
whole point is that data survives a restart (ADR-0032). Why it lost: it makes persistence
useless.

**A coverage report that fails the seed when a table is uncovered.** Pros: impossible to
ignore; the next table cannot land without a seed unit. Cons: a TASK adding a table would
break `docker compose up` for everyone until it wrote seed rows, including for work that
has nothing to do with that table, and the cheapest green fix is an empty unit that covers
nothing while reporting coverage. Why it lost: it converts a warning into an incentive to
fake the thing being warned about.

**A coverage report computed from a hardcoded list of known tables.** Pros: no query. Cons:
the list is exactly what goes stale, and a table nobody added to the list reports as fully
covered. Why it lost: this is what `coverage.ts` calls out by name and answers with a second
independent enumeration.

## Decision

**`apps/api/scripts/seed.mts`, run by `node` with no build step, importing `pg` directly,
in the manner of `apps/api/scripts/check-policies.mts`.** Node strips the types, so nothing
in the file may use syntax that needs emit: no enums, no namespaces, no decorators, no
parameter properties.

### Normative shape

```ts
import type pg from 'pg';

/** The one tenant everything else in this repository's seed data hangs from. */
export const DEMO_TENANT_ID = '00000000-0000-4000-8000-000000000001';
export const DEMO_TENANT_NAME = 'Demo Agency';

export interface SeedUnit {
  /** The table this unit writes. Must exist in schema `public` after migrations. */
  readonly table: string;
  /** One line: why these rows exist. Printed by the coverage report. */
  readonly purpose: string;
  /**
   * Idempotent insert. Runs inside a transaction that has already issued
   * `set_config('app.tenant_id', DEMO_TENANT_ID, true)`, as `shortkit_app`.
   * Returns the number of rows it actually inserted, which is 0 on a re-run.
   */
  run(client: pg.PoolClient): Promise<number>;
}

/** Every unit, in dependency order. A TASK adding a table appends exactly one entry. */
export const SEED_UNITS: readonly SeedUnit[] = [/* tenants */];
```

The whole growth story is that one array. A TASK that adds a table appends one entry and
changes nothing else, the way a schema TASK appends one
`registerTenantScopedSurfaces()` call in `registrations.ts`.

### What a seed is allowed to be in this repository

Five rules, all normative.

1. **Idempotent by construction, not by checking first.** Every row has a fixed primary key
   declared as a constant in the file and every insert ends `ON CONFLICT (<pk>) DO NOTHING`.
   Not `DO UPDATE`: that clobbers a value a developer changed by hand, which is the same
   destruction `TRUNCATE` performs, arriving one row at a time. A unit returns the row count
   the statement actually inserted, so a re-run reports 0 rather than claiming work.
2. **It may run against a non-empty database, and it runs on every `up`.** There is no
   "already seeded" marker. A marker would be state about state, and the database is
   already the state. Running always is what makes rule 1 load-bearing rather than
   decorative.
3. **It never deletes and never updates.** No `TRUNCATE`, no `DELETE`, no `ON CONFLICT DO
   UPDATE`, no `ALTER`. The reset is `docker compose down -v` (ADR-0032) and it is the only
   one.
4. **Every unit performs a real write on its first run.** A unit that no-ops is not
   coverage, and it silently removes the grant check ADR-0033 depends on.
5. **All units run inside one transaction, opened as `shortkit_app`, that has set
   `app.tenant_id` to `DEMO_TENANT_ID` before any unit runs.** The flag is set once, in the
   harness, so a later unit inserting into a tenant-scoped table gets a policy-correct
   insert without doing anything. The statement is
   `select set_config('app.tenant_id', $1, true)` with the name as an inline literal and
   the value bound, per `tenant-context.md`. One transaction, so a failing unit leaves the
   database exactly as it found it.
6. **The seed names its own connection, and refuses one it does not recognise.** Added
   2026-08-11 (F-322). Before any unit runs it reads `select current_user, current_database()`
   and prints both. It exits non-zero, before writing anything, if `current_user` is not
   `shortkit_app` or `current_database()` is not `shortkit`.

   Two separate reasons, and both are failures the seed would otherwise pass through
   silently.

   **The role check is what makes the grant check real.** ADR-0033 makes this file the thing
   that turns a migration run as the wrong identity into a startup failure, and it is only
   that because it connects as `shortkit_app`. Nothing in the running system asserted that it
   did. `DATABASE_URL` is assembled by interpolation in the compose file, so
   `shortkit_app` to `shortkit_migrator` is a one-token edit: the migrator owns the tables
   and holds every privilege, and `FORCE ROW LEVEL SECURITY` keeps the RLS half passing too,
   so both of the seed's silent jobs would keep reporting success while checking nothing. A
   seed that cannot name its own role is not performing the check it is credited with.

   **The database check is what `infra/deploy.sh`'s loopback refusal used to be, and it is
   deliberately not a loopback refusal.** `db:seed` exists so the seed runs outside compose,
   and it writes. `docker-compose.test.yml`'s header documents a workflow whose literal first
   step is
   `export DATABASE_URL='postgres://shortkit_app:app@127.0.0.1:55433/shortkit_test'`. From
   that shell, `pnpm db:seed` writes the demo tenant into the integration suite's database.

   A host-based refusal would be wrong in both directions here. It would **permit** the
   dangerous case, because the test database is on `127.0.0.1` and so is the compose one when
   reached from the host. And it would **reject** the legitimate case, because the seed's
   primary invocation is inside the `seed` container, where the database host is the compose
   service name `postgres` rather than any loopback address. The database **name**
   distinguishes the two exactly, and it distinguishes them from wherever the script runs.

   **The residual, stated rather than left implicit.** Neither discriminator separates this
   stack from a future production database, which would plausibly also be named `shortkit`
   and reached as `shortkit_app`. Rule 6 keeps the seed out of `shortkit_test`; it would not
   keep it out of production. Nothing needs to today, because ADR-0030 records that there is
   no production database. Whoever provisions one, alongside F-116, decides what guard
   replaces this and it will have to key on something other than a name.

   `check-policies.mts` is the cited precedent and needs no such guard because it only reads.
   ADR-0030 has just deleted the repository's only example of a script declining a DSN, so
   this is where that discipline continues.

### The coverage boundary is printed, and it is computed from the database

The seed asks Postgres what tables exist and subtracts the ones it covers. The query is
`check-policies.mts`'s `TABLES` query, for the reason recorded there against F-213:
`pg_class` is not privilege-filtered and `information_schema` is, and this connection is
`shortkit_app` deliberately.

```sql
select c.relname as table_name
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public'
   and c.relkind in ('r', 'p')
 order by c.relname
```

Drizzle's bookkeeping table lives in schema `drizzle`, not `public`, so it does not appear.
If that ever changes it gets an explicit exclusion with the reason beside it.

Every run prints, to stdout, in this order and with these literal tokens:

```
seed: connected as shortkit_app to shortkit
seed: covered 1 of 1 tables in schema public
seed:   tenants  1 row inserted  the tenant every later unit hangs its rows from
seed: NOT SEEDED (0): none
seed: this seed covers the tables listed above and nothing else. It is not a demo dataset.
```

The first line is rule 6's, and it comes first because it is the precondition for the rest
meaning anything: a coverage report from the wrong role over the wrong database is worse
than no report. `NOT SEEDED` is the load-bearing literal. When the set is non-empty the line names every
table and the count, and the exit code stays 0. A warning, not a failure, for the reason in
the rejected alternative: failing would make the cheapest repair an empty unit.

The file's header states the same boundary in prose, in the manner of `coverage.ts`: today
this seed covers one table because the schema has one table, a passing `docker compose up`
therefore proves that one demo tenant exists and that `shortkit_app` can write it, and it
proves nothing about any table this repository does not yet have.

### The demo tenant

`00000000-0000-4000-8000-000000000001`. Version nibble 4 and variant nibble 8, so it passes
any uuid validation the code applies, and it is obviously synthetic to a human reading a
row. Frozen: changing it after anyone has a volume means two demo tenants, and the seed
cannot delete the first one.

## Consequences

### Positive

- `docker compose up` twice in a row succeeds, inserts nothing the second time, and says so
  with a count rather than with silence.
- The next table's absence from the seed is visible on the first `up` after it lands, to
  whoever runs it, not just to whoever wrote it.
- The coverage claim cannot go stale, because it is a diff against the live catalogue rather
  than a list in a file.
- Adding a table's seed rows is one array entry. Nothing about the harness changes.
- A developer's hand-edited demo data survives every `up`.

### The cost accepted

- **`NOT SEEDED` is a warning and a warning can be ignored.** `docker compose up` prints a
  lot of lines and this one competes with all of them. The alternative was worse, and this
  is the residual.
- **The seed is doing two jobs: inserting data and checking grants.** Rule 6 makes the
  second job visible in the seed's own output and refuses the refactor that would remove it,
  which is the repair for what this bullet used to say. What is left is that the two jobs are
  still in one file with one name, so a reader who wants "just some demo data" is holding a
  guard as well.
- **Rule 6 hardcodes two identifiers.** `shortkit_app` and `shortkit` are literals in the
  seed, so a stack that legitimately renames either has to edit the script, and the error it
  gets first is a refusal rather than an explanation. That is the correct direction for a
  guard and it is still friction.
- **`ON CONFLICT DO NOTHING` hides a schema change.** If a later migration adds a `NOT NULL`
  column to `tenants` with no default, the seed's insert would fail on a fresh database and
  succeed silently on an existing one, so the two developers see different results from the
  same command.
- **The demo tenant id is frozen forever.** It is in volumes on developer machines and the
  seed has no delete path, so a change means two tenants and a manual cleanup.
- **A second `set_config('app.tenant_id', ...)` call site now exists in the repository**,
  outside ADR-0003 clause A1's scan set. ADR-0033 records why it is admissible. The cost is
  that "one file sets this flag" is now true of the scan set rather than of the repository,
  and a reader has to know which.
- **One transaction for all units means a large seed is one long transaction.** With one
  unit that is free. With twenty it holds a connection and `idle_in_transaction_session_timeout`
  does not apply here because this is not `withTenantTransaction`. Splitting per unit is the
  repair when it matters, and it costs the all-or-nothing property.

### Follow-ups this creates

- TASK-059 writes `apps/api/scripts/seed.mts` and adds a `db:seed` script to
  `apps/api/package.json` so it is runnable outside compose.
- No contract file is written. `SEED_UNITS` has exactly one consumer today, TASK-059, and
  every TASK that would have been the second left with EPIC-002 through EPIC-006. The first
  TASK that adds a table to the schema is what turns this section into
  `docs/contracts/seed-units.md`, and the shape above is what it will hold.
