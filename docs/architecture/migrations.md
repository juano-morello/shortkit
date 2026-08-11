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

There are two local databases and they are different databases. For work against the
integration suite's container, `DATABASE_URL` and `DATABASE_MIGRATION_URL` point at
`docker-compose.test.yml` on port 55433; the header of that file has the two exports. The
development stack (`docker-compose.yml`, port 55432, database `shortkit`) applies its own
migrations as part of `docker compose up` and needs neither export.

`db:seed` reads `DATABASE_URL` and **refuses any database that is not named `shortkit`**,
which is what keeps the demo tenant out of `shortkit_test` when it is run from a shell
that exported the suite's DSN.

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
  the database and re-apply from scratch. Which command depends on which database:
  - integration suite: `docker compose -f docker-compose.test.yml down -v`, then
    `up -d --wait`, then `db:migrate`;
  - development stack: `docker compose down -v`, then `docker compose up`. The `migrate`
    service re-applies everything against the empty volume. `down -v` and nothing weaker:
    the volume is what holds the already-applied state, and it survives
    `docker compose down` (ADR-0032).

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

## In the local stack

**There is no deploy, and there is no deploy target** (ADR-0030). `fly.toml` and
`infra/deploy.sh` are deleted; nothing in this repository ships the API anywhere. The one
place migrations run outside a developer's shell is `docker compose up`.

`docker-compose.yml` runs them as a **one-shot `migrate` service** built from the
`migrator` stage of the root `Dockerfile` (ADR-0033). The chain is:

```
postgres  healthy
  -> migrate  drizzle-kit migrate, as DATABASE_MIGRATION_URL (shortkit_migrator)
    -> seed   node apps/api/scripts/seed.mts, as DATABASE_URL (shortkit_app)
      -> api
```

Three things about that are decisions rather than convenience:

1. **A separate image stage, because the API image cannot migrate.** The runtime stage
   installs production dependencies only, and `drizzle-kit` is a devDependency. The
   `migrator` stage is `FROM build`, so it has it, and it is marked NOT DEPLOYABLE in the
   `Dockerfile` for the same reason: it carries the esbuild advisory that
   `docs/security/known-advisories.md` accepts on the grounds that no copy of
   `drizzle-kit` is deployed.
2. **Never in `/docker-entrypoint-initdb.d`.** Postgres runs those files as the bootstrap
   superuser, so every table would be owned by `postgres`,
   `ALTER DEFAULT PRIVILEGES FOR ROLE shortkit_migrator` would apply to none of them, and
   `shortkit_app` would get nothing. It also runs once and never again, and
   `__drizzle_migrations` would not know the migration had been applied.
3. **The seed runs as `shortkit_app`, and that is the grant check.** Migrating as any
   identity other than `shortkit_migrator` produces tables the runtime role cannot touch.
   That fails closed, but on its own it fails at runtime, inside whatever feature first
   reads the table. The seed's insert turns it into `permission denied for table tenants`
   during `docker compose up`, before the API starts, with the failing service named.

`db:check-policies` is **not** in that chain. CI's integration job runs it, and AC-115
does not ask for it. If it is ever added it belongs as a third one-shot service between
`seed` and `api`, reading `DATABASE_URL`, for the reason above about running it as the
runtime role.

## What constrains any deploy target that is chosen later

Six constraints are platform-independent and survive the deletion of the Fly artifacts.
They are recorded once, in ADR-0030's "What survives the deletion", rather than restated
here: migrations cannot run inside the production image, they do not run from application
boot, a failed migration must block the deploy, the image must build before any DDL is
applied, `GET /health` touches no database and cannot gate a deploy on its own, and boot
spends up to 20 seconds reaching the database before it refuses.

Whoever chooses a platform reads that list first. This document is the local procedure.

Write migrations to be transactional where you can. A run that fails halfway through a
non-transactional migration leaves the database in a state no file describes, and
`docker compose down -v` is then the only repair.
