---
id: ADR-0004
slug: foundation
title: One schema file per table, glob-driven migration generation, and migrations rebased rather than merged
status: accepted
supersedes: null
date: 2026-08-04
---

## Context

Wave 4 runs TASK-016 and TASK-023 at the same time, both writing
`apps/api/src/db/schema/**` and `apps/api/drizzle/**`. Wave 7 does the same with
TASK-038 and TASK-045. The plan flags that migrations must be rebased, not
auto-merged, and leaves the layout that makes that survivable to Design.

Drizzle Kit writes migrations as numbered SQL files plus `drizzle/meta/_journal.json`
and a snapshot per migration. Two branches generating concurrently both produce
`0004_*.sql` and both append an entry to `_journal.json`. Git will happily
three-way-merge the JSON into a file whose entries reference snapshots that were
computed against different parent states. The result applies cleanly in development,
where the tables already exist, and fails on a fresh database. That failure surfaces
in CI's integration job or, worse, on deploy.

TASK-053 needs to enumerate every table carrying `tenant_id` at runtime, so the
schema has to be reachable as a single importable object.

## Decision

**One file per table, named after the table.**
`apps/api/src/db/schema/tenants.ts`, `workspaces.ts`, `tenant_memberships.ts`,
`memberships.ts`, `invitations.ts`, `domains.ts`, `links.ts`, `click_events.ts`,
`audit_entries.ts`, `auth.ts`. A file declares its table, its RLS policy statements
and its relations. Two TASKs in a wave touch different files.

**A barrel that only re-exports.** `apps/api/src/db/schema/index.ts` contains nothing
but `export * from './<file>';` lines in alphabetical order. Application code and
`tenantScopedTables()` import the barrel. A wave conflict there is two adjacent
inserted lines.

**Drizzle Kit reads a glob, not the barrel.**

```ts
// apps/api/drizzle.config.ts
export default { schema: './src/db/schema/*.ts', out: './drizzle', dialect: 'postgresql' };
```

A TASK that adds a table and forgets the barrel still gets a correct migration, and
`tenantScopedTables()`'s cross-check against `information_schema` (ADR-0019) catches
the missing export.

**Git refuses to merge migration metadata.** `.gitattributes` at the repo root:

```
apps/api/drizzle/meta/** -merge
apps/api/drizzle/*.sql   -merge
```

Unsetting `merge` makes Git treat the path as binary: it leaves a conflict rather
than producing a plausible-looking wrong file.

**Migration conflicts are resolved by regeneration, never by editing.** The written
procedure, which belongs in `docs/architecture/migrations.md`:

1. `git checkout --theirs` the merged schema TypeScript. Resolve those normally.
2. `git rm` every migration SQL file and snapshot introduced by the branch being
   rebased, and take `_journal.json` wholesale from the target branch.
3. `pnpm --filter @shortkit/api db:generate`. Drizzle Kit diffs the merged schema
   against the target branch's last snapshot and emits one new migration.
4. `pnpm test:integration` against a dropped and recreated database. A migration set
   that only works on an existing database fails here.

**RLS lives in migrations, not in a manual runbook.** Drizzle Kit does not generate
policy DDL for these tables. Each schema file exports a `policies` SQL string built
from the ADR-0003 template, and the TASK that adds the table appends it to the
generated migration by hand in the same commit. `pnpm db:check-policies` asserts
that every table in `tenantScopedTables()` has all four statements present in
`pg_policies` after migration, and CI's integration job runs it.

**Migrations run at deploy, before the new machine takes traffic.** `pnpm --filter
@shortkit/api db:migrate` runs as `shortkit_migrator`. It is not run from application
boot, so N machines starting concurrently cannot race.

**Corrected 2026-08-10 (F-142). This decision said a Fly release command runs it. There
is none, and there deliberately never will be.** `fly.toml:20-61` records the settlement
of F-119: a `release_command` executes inside the deployed image, whose runtime stage
installs production dependencies only, so it has no `drizzle-kit` binary; promoting
`drizzle-kit` to a dependency was rejected because it puts GHSA-67mh-4wv8-2f99 into the
production graph and falsifies the acceptance in `docs/security/known-advisories.md`.
`infra/deploy.sh` runs the migration from the working copy, as `shortkit_migrator`,
before it calls `fly deploy`.

**Both requirements this decision actually makes survive the change of mechanism.**
Migrations still do not run from application boot, so concurrent machines cannot race;
and a failed migration still blocks the deploy, because `set -e` in `infra/deploy.sh`
stops the script before `fly deploy` is reached. What the mechanism no longer gives is
failing closed when someone bypasses the script — see the accepted costs below and the
three costs enumerated at `fly.toml:20-61`, which are normative for the deploy path.

### Pinned versions. Recorded 2026-08-05 (F-069)

This ADR named neither package. TASK-001's implementer picked `drizzle-orm` 0.45.2 while
transcribing a manifest, which left the data-access library for the whole initiative
chosen with no design input. The pin is right, and here is the check that says so.

```
drizzle-orm  0.45.2   dependency of apps/api
drizzle-kit  0.31.10  devDependency of apps/api
```

Both are the newest published stable release: I read `latest` from the npm registry on
2026-08-05 and got 0.45.2 and 0.31.10. Exact versions, no range, per ADR-0018.

**The 1.0.0 line is not adopted.** Both packages publish a long `1.0.0-beta.*` and
`1.0.0-rc.*` series alongside the stable tags, and `rc.4` is the furthest along. The
0.4x/0.31 pair is what the four things this ADR depends on were designed against:
`dialect: 'postgresql'` in `drizzle.config.ts`, a `schema` glob rather than a file, the
`_journal.json` plus per-migration snapshot format the rebase procedure deletes and
regenerates, and `drizzle-orm/node-postgres` as the driver ADR-0002 assumes. A 1.0
release changes the migration metadata format, and finding that out during a wave-4
rebase costs more than any 1.0 feature is worth here. Revisit after launch-core ships,
in its own ADR, with the migration set regenerated from scratch against an empty
database.

**`drizzle-kit` is not installed today.** `apps/api/package.json` carries `drizzle-orm`
and no `drizzle-kit`, so `db:generate`, `db:migrate` and the rebase procedure above have
no binary behind them. TASK-005 needs it added, which runs into the same unowned
manifest as F-075 (`pg`) and F-071 (`zod`). The version is settled here; who writes the
line into the manifest is not, and F-075 is escalated.

`drizzle-kit`'s major and minor track `drizzle-orm`'s snapshot format rather than its
own semver, so the two move together. Upgrade both in one commit, regenerate the
migration set against an empty database, and run the integration job before merging.

### Rollback: revert the commit, migrate forward. Recorded 2026-08-11 (F-392)

This ADR never used the word rollback, and neither did `docs/architecture/migrations.md`.
Ship step 4 asks for a feature flag, a revert, or a migration-down, and the initiative had
none of the three written anywhere. An absence a reader infers from a missing CLI
subcommand is not a posture. Here is the posture.

**There are no down migrations, and none will be written for this initiative.** Rolling
back a schema change means two things and nothing else: revert the commit that introduced
the schema file and its migration, then write a **new** forward migration that moves the
database from where it is to where the reverted code expects it. Migration numbers only go
up. `__drizzle_migrations` only grows.

Removing the migration file from git is not part of the procedure and does not help. The
migrator compares the most recent `created_at` in `__drizzle_migrations` against the
journal and never compares hashes, so deleting or editing a file that has already been
applied changes nothing on any database that applied it. `docs/architecture/migrations.md`,
"The migrator compares timestamps, not contents", has the failure mode in full.

**Why there is no mechanism, factually.** Checked 2026-08-11 against the installed
`drizzle-kit` 0.31.10, not against the documentation:

- The CLI dispatches nine commands: `generate`, `migrate`, `push`, `pull`, `check`, `up`,
  `drop`, `export`, `studio`. There is no `down`, and no flag on `migrate` that reverses.
- `drop` is not an undo. Its implementation (`src/cli/commands/drop.ts`, bundled into
  `bin.cjs`) reads `apps/api/drizzle/meta/_journal.json`, prompts for an entry, `rmSync`s
  the matching `NNNN_*.sql` and `meta/NNNN_snapshot.json`, and rewrites the journal. It
  opens no connection and issues no SQL. Run it against a database that already applied the
  migration and you get a table that still exists, a row still in `__drizzle_migrations`,
  and no file on disk describing either. That is worse than doing nothing.

Generating a reverse migration from the snapshots is possible in principle, since Drizzle
keeps one snapshot per migration and diffs in either direction, but nothing in `drizzle-kit`
exposes it and this initiative is not building it.

**Two conditions make forward-only valid. Both must hold, not either.**

1. **The schema is additive-only.** Verified at `4a5ab8a` rather than assumed. The migration
   set is one file, `apps/api/drizzle/0000_odd_betty_ross.sql`, and `_journal.json` has one
   entry at `idx: 0`. Every statement in it creates something that did not exist: `CREATE
   TABLE "tenants"`, `ALTER TABLE "tenants" ENABLE ROW LEVEL SECURITY`, the matching `FORCE`,
   and the four `CREATE POLICY` statements from ADR-0003's cascade-root template. No `DROP`,
   no `ALTER COLUMN`, no `RENAME`, no `TRUNCATE`, no `UPDATE` or `DELETE` against rows. (A
   grep for those keywords hits only the `FOR UPDATE` and `FOR DELETE` clauses inside the
   policy definitions and one comment.) Reverting the commit and rebuilding from empty
   destroys nothing that predates the commit, because nothing predates it.
2. **No production database exists.** ADR-0030 is explicit that the repository does not
   promise "an uptime story, a rollback story, or a production database". The only two
   databases are the development stack's volume (port 55432) and the integration suite's
   tmpfs container (port 55433), and `docker compose down -v` resets either one in seconds.
   Every row in both is either seeded by `apps/api/scripts/seed.mts` or built by a test
   fixture, so no rollback has to preserve anything.

**What ends this posture.** Either one alone, not both together:

- **A destructive migration.** `DROP TABLE` or `DROP COLUMN`, an `ALTER COLUMN` that narrows
  a type, a `RENAME`, or DML that rewrites existing rows. Forward-only recovery needs the
  data the migration destroyed, and there is no copy of it. The commit that introduces the
  first destructive migration must carry its own reversal plan, and it needs its own ADR
  superseding this section before it merges. An expand-migrate-contract sequence keeps the
  posture intact as long as the contract step is a separate, later commit.
- **A deploy target holding data nobody can regenerate.** The moment a database exists whose
  contents `db:seed` cannot rebuild, `docker compose down -v` stops being the reset and the
  window between a bad migration applying and the fix migration shipping becomes a window
  with real rows in a bad state. Whoever picks the platform (the open question ADR-0030 left)
  owns replacing this section, alongside the six constraints in ADR-0030's "What survives
  the deletion".

**Rejected: writing a down-migration mechanism now.** Hand-authored `NNNN_down.sql` files
plus a runner that walks `__drizzle_migrations` backwards is maybe 150 lines and a fair
amount of care around transactions and the journal. It loses on two counts. It would ship
untested, because the only database it could be exercised against is one that `down -v`
already resets, so the tests would prove the runner runs and nothing about whether it
recovers anything. And the sole migration it could reverse today is a single `CREATE TABLE`.
Build it when the first destructive migration needs it, against a database where being
wrong costs something.

## Alternatives considered

| Option | Pros | Cons | Why not |
|---|---|---|---|
| One `schema.ts` for all tables | No barrel, one import, everything visible at once | Every schema TASK in every wave edits the same file. Waves 4 and 7 become guaranteed conflicts in the middle of table definitions rather than at file boundaries | Turns a merge of two disjoint additions into a merge of one file's interior |
| Grouped by bounded context (`tenancy.ts`, `links.ts`, `domains.ts`) | Fewer files; related tables read together | TASK-016 and TASK-023 would still collide on `tenancy.ts` in wave 4; the grouping does not line up with the TASK boundaries the plan actually created | Does not solve the problem it exists to solve |
| Serialise the schema TASKs into their own waves | No concurrent migration generation at all | Adds two waves to a 13-wave plan and idles the second owner slot; the plan explicitly chose worktree isolation over splitting | The plan already priced this; the layout is the cheaper fix |
| Hand-written SQL migrations, no Drizzle Kit generation | Full control; RLS and tables in one authored file; no snapshots to conflict | Loses drift detection between the TypeScript schema and the database, which is the thing that keeps `tenantScopedTables()` honest | The generator's snapshot is what makes ADR-0019's cross-check meaningful |

## Consequences

### Positive

- Two TASKs in the same wave adding two tables touch two files plus two lines of a
  barrel.
- Regeneration, rather than hand-editing, guarantees the merged migration matches the
  merged schema. The failure mode of a hand-merged journal cannot occur.
- The `-merge` attribute turns a silent bad merge into a conflict a human must read.

### Negative / accepted cost

- Rebasing throws away a migration that was already written and tested on its branch,
  and the regenerated one has a different filename and hash. Anyone who applied the
  old migration to a local database has to drop and recreate it.
- RLS policy DDL is appended by hand to a generated file. A TASK that forgets it
  produces a table with no policies, and `pnpm db:check-policies` catches that only
  in the integration job, not at generation time.
- Ten schema files for ten tables makes browsing the data model slower than one file
  would. `docs/architecture/data-model.md` has to carry the overview instead.
- Running migrations at deploy means a failed migration blocks the deploy, which is
  correct, and also means a bad migration can leave the release half-applied if it is
  not written to be transactional. **The half-applied cost is unchanged by F-142's
  correction; only the attribution was wrong.** The blocking is `set -e` in
  `infra/deploy.sh`, not a Fly release command.
- **A cost the release-command mechanism would not have had (F-119, F-142).** The
  migration runs from a working copy, so the `shortkit_migrator` DSN lives in a
  developer's shell rather than in Fly secrets, and a deploy that bypasses
  `infra/deploy.sh` applies no DDL at all and fails open. Both are stated in full at
  `fly.toml:20-61`, which is normative for them; this ADR names them so a reader of the
  decision above does not have to find out from the deploy script.
- **No migration can be undone in place (F-392).** Recovery from a bad migration takes a
  revert, a new migration, a review and a deploy, not one command. Between the bad
  migration applying and the fix landing, the database sits in the bad state. That is
  affordable only because both databases are disposable and neither holds data anyone
  needs, which is condition 2 above and is a circumstance rather than a property of the
  design. The cost scales with the first real dataset.
- **The two conditions are unenforced.** Nothing in CI fails a pull request that adds
  `DROP COLUMN` to a migration, and `db:check-policies` does not look at it. A destructive
  migration merges as easily as an additive one, and the only thing standing between it
  and the schema is a reviewer who has read this section.

### Follow-ups this creates

- TASK-001 writes `.gitattributes` with the two `-merge` entries.
- TASK-005 writes `drizzle.config.ts`, the barrel, `db:generate`, `db:migrate`,
  `db:check-policies`, and `docs/architecture/migrations.md`. It also needs
  `drizzle-kit` 0.31.10 in `apps/api`'s devDependencies, which nothing has added yet.
- ~~TASK-003 adds the release command to `fly.toml`.~~ **Discharged differently and
  closed 2026-08-10 (F-142).** TASK-003 deliberately added no `release_command`, and
  `fly.toml:20` says so in those words. It wrote `infra/deploy.sh` instead, which runs
  the migration before `fly deploy`. Nothing is outstanding here.
- Waves 4 and 7: the second TASK to merge rebases. The orchestrator picks which one
  before dispatching, so neither implementer decides mid-merge.
- **F-392.** `docs/architecture/migrations.md` gains a short "There is no down migration"
  section that states the operator action and points here. The posture, the two conditions
  and what ends them live in this ADR only, so there is one copy to keep true.
- **F-392, deferred and owned by whoever triggers it.** The first destructive migration,
  or the first deploy target with data that `db:seed` cannot rebuild, supersedes the
  rollback section above. Neither is scheduled. A reviewer who sees `DROP`, `RENAME` or a
  narrowing `ALTER COLUMN` in a generated migration should stop and ask for the ADR.
