# Migrations

Drizzle Kit generates the SQL; the generated file is checked in and applied forward.
Source: ADR-0004. This document is the procedure.

## Layout

| Path | What it is |
| --- | --- |
| `apps/api/src/db/schema/<table>.ts` | one file per table, exported from `schema/index.ts` |
| `apps/api/drizzle/NNNN_*.sql` | the generated migrations, applied in order |
| `apps/api/drizzle/meta/` | `_journal.json` and one snapshot per migration, both generated |
| `apps/api/drizzle.config.ts` | tells Drizzle Kit where the schema is, where migrations go, and which DSN to connect as |

`drizzle.config.ts` globs `./src/db/schema/*.ts` rather than reading the barrel, so a
table whose `export *` line was forgotten still gets a correct migration.

## Commands

All three run from the repository root. **They do not take the same connection**, and the
column below is which variable each one reads.

| Command | Reads | What it does |
| --- | --- | --- |
| `pnpm --filter @shortkit/api db:generate` | nothing | diffs the schema against the last snapshot and writes one new migration. It never connects, and `drizzle.config.ts` falls back to an empty DSN so generation works offline |
| `pnpm --filter @shortkit/api db:migrate` | `DATABASE_MIGRATION_URL` | applies every migration the database has not seen |
| `pnpm --filter @shortkit/api db:check-policies` | `DATABASE_URL` | asserts row-level security is on for every table in `public` |

`db:migrate` takes the migrator DSN because the migrator role owns the tables and
`shortkit_app` can run no DDL.

**`db:check-policies` takes `DATABASE_URL`, and that is not an oversight.** It inspects
the catalog as `shortkit_app` — the role whose access the policies exist to constrain —
so the check runs over the same connection the API uses rather than over the owner's
(`apps/api/scripts/check-policies.mts` records the decision). Export only
`DATABASE_MIGRATION_URL` and it exits 1 naming what is missing. Point `DATABASE_URL` at
the migrator DSN and it runs as the owner instead, which is not what it was written to
assert.

For local work, `DATABASE_URL` and `DATABASE_MIGRATION_URL` point at the container in
`docker-compose.test.yml`; the header of that file has the two exports.

## Policies are appended by hand

Drizzle Kit does not generate policy DDL. After `db:generate`, append the output of
`tenantScopedPolicies('<t>')` (`apps/api/src/db/rls.ts` builds it — see `rls.md`) to
the generated `.sql`, in the same commit as the schema file. A table
shipped without it is readable and writable by every tenant, and nothing else in the
build will tell you: the grants come from `ALTER DEFAULT PRIVILEGES` and already exist,
so the feature's own queries work and its tests pass.

`db:check-policies` is what catches it. Run it after `db:migrate`, locally and in CI.

In CI it runs after `db:migrate` and **before** the integration suite, for the reason in
"Running the integration suite wipes the migrated tables" below: afterwards, schema
`public` holds the fixture's unprotected `tenants` or no tables at all, and the check
would be reading a database the migrations no longer describe.

## The migrator compares timestamps, not contents

This one costs people an afternoon.

`__drizzle_migrations` stores each applied migration's hash and its `created_at`, taken
from the journal. On every run the migrator reads the **most recent** `created_at` and
applies only the migrations whose timestamp is greater. The stored hash is never
compared to anything.

So **editing a migration that has already been applied does nothing.** Not on your
machine, not on any other. Append the policy block to an applied migration and
`db:migrate` reports success, having executed no statement — the table stays
unprotected, and the migration file in git says otherwise.

Two consequences:

- A change to an applied migration needs a **new** migration. That is true of policy
  DDL, of a column type, of anything.
- If you are still iterating locally and want the old file to be the one that runs, drop
  the database and re-apply from scratch: `docker compose -f docker-compose.test.yml
  down -v`, then `up -d --wait`, then `db:migrate`.

## Running the integration suite wipes the migrated tables

`apps/api/test/support/rls-fixture.ts` drops and recreates `tenants` and its own fixture
table before every test, so after `pnpm test:integration` the database holds a `tenants`
built by the fixture rather than by the migration — without the four policies the
migration applies to it — or, after the last teardown, no `tenants` at all.

Re-running `db:migrate` does **not** repair this. The migration is already recorded in
`__drizzle_migrations`, and by the rule above the migrator skips it.

The reset is `docker compose -f docker-compose.test.yml down -v`, then `up -d --wait`,
then `db:migrate`. The container stores its data in tmpfs, so `down -v` costs a few
seconds and nothing else.

This only bites when you are looking at the database by hand after a test run. The suite
itself does not care: it builds what it needs in `beforeEach`.

## Rebasing a branch that added a migration

When two branches each add a table, the second to merge regenerates. Do not hand-merge
`_journal.json` or a snapshot — `.gitattributes` marks both `-merge` so git raises a
conflict instead of producing a plausible wrong file.

1. Take the merged schema TypeScript (`git checkout --theirs`) and resolve those files
   normally.
2. `git rm` every migration `.sql` and snapshot your branch introduced, and take
   `_journal.json` wholesale from the target branch.
3. `pnpm --filter @shortkit/api db:generate`. Drizzle Kit diffs the merged schema against
   the target branch's last snapshot and emits one new migration.
4. Re-append the policy DDL to the new file. Regeneration does not carry it over.
5. Drop and recreate the database, `db:migrate`, then `pnpm test:integration`. A
   migration set that only applies to a database that already has the old one fails
   here, which is the point of doing it against an empty database.

The regenerated migration has a different filename and hash from the one you tested on
your branch. Anyone who applied the old one locally has to drop and recreate too.

## At deploy

The Fly release command runs `pnpm --filter @shortkit/api db:migrate` as
`shortkit_migrator`, before the new machine takes traffic. Migrations do not run from
application boot, so machines starting together cannot race. A failed migration blocks
the deploy.

Write migrations to be transactional where you can. A release that fails halfway through
a non-transactional migration leaves the database in a state no file describes.
