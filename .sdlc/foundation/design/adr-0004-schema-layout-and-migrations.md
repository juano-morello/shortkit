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

**Migrations run at deploy, before the new machine takes traffic.** The Fly release
command runs `pnpm --filter @shortkit/api db:migrate` as `shortkit_migrator`. It is
not run from application boot, so N machines starting concurrently cannot race.

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
- Running migrations from the Fly release command means a failed migration blocks the
  deploy, which is correct, and also means a bad migration can leave the release
  half-applied if it is not written to be transactional.

### Follow-ups this creates

- TASK-001 writes `.gitattributes` with the two `-merge` entries.
- TASK-005 writes `drizzle.config.ts`, the barrel, `db:generate`, `db:migrate`,
  `db:check-policies`, and `docs/architecture/migrations.md`. It also needs
  `drizzle-kit` 0.31.10 in `apps/api`'s devDependencies, which nothing has added yet.
- TASK-003 adds the release command to `fly.toml`.
- Waves 4 and 7: the second TASK to merge rebases. The orchestrator picks which one
  before dispatching, so neither implementer decides mid-merge.
