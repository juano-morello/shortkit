---
id: ADR-0032
slug: foundation
title: Postgres data lives in a named volume, and `down -v` is the only reset
status: accepted
supersedes: null
date: 2026-08-11
---

## Context

`docker-compose.test.yml` mounts tmpfs at `/var/lib/postgresql/data` on purpose: the
integration suite drops and recreates its fixture per test and nothing is worth keeping
between runs. TASK-059's Definition of Done requires the opposite. Data must survive
`docker compose restart`, and a stack that seeds and then forgets does not satisfy AC-115.

Three facts shape the answer. The Postgres entrypoint runs `/docker-entrypoint-initdb.d`
only when the data directory is empty, so role provisioning is a first-`up` event and not a
per-`up` event. `docs/architecture/migrations.md` records that the drizzle migrator compares
the most recent `created_at` in `__drizzle_migrations` and never compares hashes, so editing
an already-applied migration does nothing and reports success. And the compose volume
outlives the git branch, so a checkout with divergent migrations meets a database that
matches neither.

## Alternatives considered

**tmpfs, as the test stack uses.** Pros: `down` leaves no disk behind; no stale state ever;
a reset costs nothing. Cons: `docker compose restart` loses the seed, which the DoD forbids
outright, and a developer who stops the stack overnight comes back to an empty database and
a migration run on every start. Why it lost: the DoD names it.

**A host bind mount, such as `./.data/postgres`.** Pros: the data is visible in the
worktree; a developer can back it up or inspect it with host tools; deleting it needs no
Docker command. Cons: the Postgres container runs as uid 999 and writes a directory the
host user cannot read or delete without `sudo`, which is a support burden on exactly the
"machine with only Docker" AC-115 describes. It needs a `.gitignore` entry, and a missed
one commits a database into a public repository. On macOS and Windows the bind mount is
slow enough to be noticeable. Why it lost: it puts a root-owned directory in the worktree
of a public repository to buy inspectability that `docker compose exec` already provides.

**A named volume.** Pros: Docker owns the permissions, nothing lands in the worktree,
`down -v` is one documented command, and the volume is namespaced by compose project so two
clones do not collide. Cons: it is invisible until you run `docker volume ls`, and a
developer who does not know `down -v` will debug a stale database for an afternoon. Why it
won: the failure it allows is documented and recoverable; the failures the others allow are
a DoD violation and a permissions trap.

## Decision

**One named volume, `pgdata`, mounted at `/var/lib/postgresql/data` on the `postgres`
service.** Compose namespaces it as `<project>_pgdata`. Nothing else in the stack is
stateful: the API and web containers hold no data, and the one-shot migrate and seed
services write only to the database.

**The project name is the directory basename, and two clones collide.** Corrected
2026-08-11 (F-318). Compose derives the default project name from the basename of the
project directory, not from its path, and `git clone` names the directory after the
repository. Verified by execution: `docker compose config` in a directory named `shortkit`
emits `name: shortkit` whatever its parent path is. So `~/work/shortkit` and
`~/scratch/shortkit` share one `shortkit_pgdata`, and the second clone gets the first's
schema, `__drizzle_migrations` rows, roles and passwords.

Two of this ADR's own mechanisms then compound it. The init script does not re-run, because
the data directory is not empty, so a branch that changed the roles SQL silently has no
effect. And `db:migrate` compares the most recent `created_at` rather than hashes, so a
divergent migration reports success having executed nothing. The stack comes up green over a
database that matches neither working copy. If the two clones set different
`SHORTKIT_APP_PASSWORD` values, the second one's DSN does not match the roles in the volume
and the failure is an authentication dead end with no obvious cause.

**`COMPOSE_PROJECT_NAME` is how a developer separates them**, and the README says so beside
the reset ladder. `docker-compose.yml` does **not** set `name:`: pinning it would make the
collision unconditional rather than merely likely, and it would take the override away.

**The reset ladder, and each rung means exactly one thing.**

| Command | What survives | When to use it |
|---|---|---|
| `docker compose restart` | everything: roles, schema, seeded and developer-created rows | restart a process |
| `docker compose stop` / `start` | the same | free the ports for a while |
| `docker compose down` | the volume, so all data | free the containers |
| `docker compose down -v` | nothing. The next `up` runs initdb, the roles script, migrations and the seed from scratch | any change to role provisioning, an edited migration, a branch switch across migrations, or a database in a state nothing describes |

**`down -v` is the documented reset and the README says so in those words.** It is not a
last resort. It is the normal response to three specific situations, and each is named
beside the command:

1. **A change to the roles SQL.** `/docker-entrypoint-initdb.d` runs once against an empty
   data directory. Editing the script and running `up` again changes nothing, the stack
   keeps working with the old roles, and there is no error anywhere. This is the failure
   mode most likely to cost an hour.
2. **An edited migration that was already applied.** The migrator compares timestamps, not
   contents. `db:migrate` reports success having executed no statement, and the table stays
   as it was while the file in git says otherwise. `docs/architecture/migrations.md` already
   documents this against the test container; it applies here identically.
3. **A branch switch across a migration.** The volume does not switch with the branch.

**`docker compose down -v` destroys developer data with no confirmation.** The README says
that in the same sentence as the command. The stack is a development stack and its data is
one demo tenant plus whatever a developer typed, so the cost of losing it is bounded and
stated rather than guarded.

## Consequences

### Positive

- `docker compose restart` keeps the seed, which is the DoD requirement, and keeps whatever
  a developer created, which is what makes the stack usable for more than one sitting.
- Nothing writes to the worktree, so no `.gitignore` entry stands between a developer and a
  committed database.
- The reset is one command with no arguments to get wrong.

### The cost accepted

- **Stale state is now possible, and it is silent in the one case that matters most.** A
  roles change that never applied leaves a stack that works, which means the developer has
  no signal at all until something depends on the new grant. This is the price of
  persistence and there is no version of persistence without it.
- **The volume outlives everything a developer can see.** `docker compose down` looks like a
  full teardown and is not. `git clean -xdf` does not touch it. `docker volume ls` is the
  only place it appears.
- **Disk grows and nothing reclaims it.** A developer who works on several branches
  accumulates one volume per project **name**, which is one per distinct directory basename
  rather than one per clone.
- **Two clones with the same directory name share one database**, per the correction above.
  A developer who clones a second copy specifically to avoid disturbing the first gets the
  opposite of what they intended, and the symptom is a green stack rather than an error.

### What the volume holds, stated now while the answer is boring

This decision converts the database from tmpfs to durable storage, so it is worth recording
what durable means here before the tables that make it matter arrive.

Today the volume holds one synthetic demo tenant, whatever a developer typed, and
PostgreSQL's own `pg_authid` verifiers for three fixture roles. Nothing personal, nothing
regulated, nothing worth an attacker's time.

The storage itself is unencrypted developer storage that survives `docker compose down`,
`git clean -xdf`, a branch switch and possibly the boundary between two clones. Its only
retention mechanism is a command a developer has to know to run. The repository designs a
GDPR erasure path for production data (`privilegedTenantEraser`, ADR-0019, AC-90) and this
volume has no counterpart to it, correctly, because there is nothing here to erase.

**The first table carrying personal data is what makes that paragraph need rewriting.**
`click_events` carries `ip_hash` under GC-9; `user`, `session`, `account` and `verification`
carry emails and session material. Whoever lands the first of them decides whether a
development stack may hold it, and the answer might still be yes. It should be an answer
rather than an omission.
- **The persistent database diverges from the test database's behaviour.** The integration
  suite's container is tmpfs and fresh every run; this one is not. A bug that only appears
  against a database with history will not show up in the suite.

### Follow-ups this creates

- README documents the reset ladder above, including the three situations that require
  `down -v`, that `down -v` destroys developer data with no confirmation, that
  `COMPOSE_PROJECT_NAME` is how two clones are separated, and one sentence on what the
  volume holds and how long.
- `docs/architecture/migrations.md`'s existing "drop and recreate" instructions currently
  name `docker-compose.test.yml`. TASK-059 adds the local stack's equivalent beside them
  rather than replacing them; the two databases are different and both instructions are
  correct for their own file.
