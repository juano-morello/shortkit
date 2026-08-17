---
id: ADR-0032
slug: foundation
title: Postgres data lives in a named volume, the stack takes its own compose project name, and `down -v` is the only reset
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

### For the compose project name (added 2026-08-11, F-356)

The problem these answer is stated in the Decision below: `docker-compose.yml` and
`docker-compose.test.yml` sit in one directory, so they take one default project name, and
they both declare a service called `postgres`. Ports do not separate compose stacks.

**Pin `name:` on `docker-compose.yml`.** Pros: the new stack gets its own project, its own
containers, its own network and its own volume, so `up`, `down -v` and `--remove-orphans` at
the repository root cannot reach the integration suite's container in either direction. It
touches only a file that does not exist yet, so a `done` TASK's file stays untouched and no
existing volume needs migrating. `scripts/check-compose-stack.sh` reads the project name from
`docker compose config` and needs no edit; its refusal guard simply stops firing, which is
the correct outcome rather than a suppressed one. Cons: two clones now collide
unconditionally on the pinned name instead of only when their directory basenames match
(F-318). Why it won: the collision it worsens is between a developer's own two copies and
produces a stale database; the collision it removes deletes a running test database from
under a suite.

**Set `COMPOSE_PROJECT_NAME` in `docker-compose.test.yml`'s documented workflow.** Pros: no
change to either compose file's behaviour; the dev stack keeps the plain `shortkit` name.
Cons: it is a convention, not a mechanism. It protects the developer who remembers it on
every one of the four commands in that file's header and nobody else, it does not protect
CI or a script, and the failure when it is forgotten is the destructive one. It also puts
the burden on the file that already works. Why it lost: a documented habit is not a boundary,
and this boundary destroys data when it is crossed.

**Rename the dev stack's Postgres service, `postgres` to `db`, and share the project.**
Pros: cheaper than a project rename in one respect, since the two stacks would no longer
contend for the same service key, and Compose does not remove containers for services absent
from the file unless it is told to. Cons: each stack's containers become **orphans** of the
other's project, and Compose's response to an orphan is to print, on every single `up`, that
you can run the command with `--remove-orphans` to clean it up. The mitigation is a message
that recommends the destructive command. `scripts/check-compose-stack.sh` already passes
`--remove-orphans` on its pre-`up` teardown, so the check written for AC-115 would delete the
integration suite's container the first time it ran without its refusal guard. It also
diverges the two stacks' service names for no reason a reader can see, costs `docker compose
exec db psql` against `docker compose exec postgres psql` in the test stack, and forces edits
to AC-115.2 in the check and to the service ADR-0033 and ADR-0036 name. Why it lost: it
leaves a live destructive path behind a warning that points at it.

**Document "stop one stack before starting the other".** Pros: free. Cons: it is the same
convention argument as above with no mechanism at all, and it makes the two stacks
mutually exclusive, so an integration run cannot happen while the dev stack is up. Why it
lost: it costs more in daily use than the pinned name and protects less.

## Decision

**One named volume, `pgdata`, mounted at `/var/lib/postgresql/data` on the `postgres`
service.** Compose namespaces it as `<project>_pgdata`. Nothing else in the stack is
stateful: the API and web containers hold no data, and the one-shot migrate and seed
services write only to the database.

**`docker-compose.yml` sets `name: shortkit-dev`.** Ruled 2026-08-11 (F-356). This reverses
the previous instruction not to set `name:`, and the reversal is explained below rather than
left as a diff.

The default project name is the directory basename, and `docker-compose.test.yml` is in that
same directory. Measured on the running integration container: project `shortkit`, service
`postgres`, config file `docker-compose.test.yml`. The new stack would take the same project
name and ADR-0033 gives it a service called `postgres` too. Compose identifies a container by
project plus service, and ports are not part of that identity, so `docker compose up` at the
repository root would **recreate the integration suite's container** and
`docker compose down -v`, which is this ADR's documented reset, would **delete it**. TASK-059's
red step measured the collision and refuses with exit 2 rather than clobbering.

With `name: shortkit-dev` the two stacks share nothing. Verified by execution on Docker
29.7.2 / Compose v5.4.0:

| | test stack | dev stack |
|---|---|---|
| project | `shortkit` | `shortkit-dev` |
| container | `shortkit-postgres-1` | `shortkit-dev-postgres-1` |
| network | `shortkit_default` | `shortkit-dev_default` |
| volume | none, tmpfs | `shortkit-dev_pgdata` |

Neither stack's containers are even orphans of the other's project, so Compose prints no
orphan warning and never suggests `--remove-orphans`, and both stacks can run at once, which
is what a developer running the integration suite against a working dev stack actually does.

**`COMPOSE_PROJECT_NAME` still overrides `name:`, and the earlier claim that pinning would
"take the override away" was wrong.** Measured, same versions. Compose's precedence, highest
first, is the `-p` flag, then `COMPOSE_PROJECT_NAME`, then the file's top-level `name:`, then
the directory basename. With `name: shortkit-dev` in the file, `COMPOSE_PROJECT_NAME=teamx
docker compose config` reports project `teamx` and volume `teamx_pgdata`. So the two-clone
escape hatch survives pinning intact.

**What pinning does cost is real and is F-318's other half.** Two clones now share
`shortkit-dev_pgdata` whatever their directories are called, where before, a clone into a
differently named directory got its own volume by accident. A developer who separates copies
by renaming the directory loses that and has to set `COMPOSE_PROJECT_NAME` instead.

**The two clones still collide, and the rest of this section is unchanged.** Corrected
2026-08-11 (F-318). Compose derives the default project name from the basename of the
project directory, not from its path, and `git clone` names the directory after the
repository. Verified by execution: `docker compose config` in a directory named `shortkit`
emits `name: shortkit` whatever its parent path is. So without an override `~/work/shortkit`
and `~/scratch/shortkit` share one volume, and the second clone gets the first's
schema, `__drizzle_migrations` rows, roles and passwords.

Two of this ADR's own mechanisms then compound it. The init script does not re-run, because
the data directory is not empty, so a branch that changed the roles SQL silently has no
effect. And `db:migrate` compares the most recent `created_at` rather than hashes, so a
divergent migration reports success having executed nothing. The stack comes up green over a
database that matches neither working copy. If the two clones set different
`SHORTKIT_APP_PASSWORD` values, the second one's DSN does not match the roles in the volume
and the failure is an authentication dead end with no obvious cause.

**`COMPOSE_PROJECT_NAME` is how a developer separates them**, and the README says so beside
the reset ladder, with the precedence order, because a reader who sees `name: shortkit-dev`
in the file will otherwise assume it is fixed.

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
- The reset is one command with no arguments to get wrong, and after F-356 it can no longer
  reach the integration suite's container. `docker compose down -v` at the repository root
  is destructive to exactly one stack, which is the one the developer is looking at.
- **Both stacks run at the same time.** The dev stack on 55432 and the integration suite on
  55433 are independent projects, so `pnpm test:integration` does not require stopping the
  thing being developed.
- The AC-115 check runs while the integration suite is up. Its refusal guard stays in place
  for the case that still collides, a clone into a directory literally named `shortkit-dev`.

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
- **Two clones share one database whatever their directories are called**, which is stronger
  than the basename collision the correction above describes and is the price of pinning
  `name:` (F-356). A developer who clones a second copy specifically to avoid disturbing the
  first gets the opposite of what they intended, and the symptom is a green stack rather
  than an error. `COMPOSE_PROJECT_NAME` is the fix and it still works.
- **The project name no longer matches the repository name**, so `docker compose ls`,
  `docker ps` and every volume and network name carry `shortkit-dev` while the test stack
  carries the plain `shortkit`. The unadorned name belongs to the stack a developer touches
  less often, which reads backwards. Correcting it means putting `name: shortkit-test` in a
  `done` TASK's file, and this ADR does not take that.
- **A directory named `shortkit-dev` reintroduces the collision**, because the test stack's
  name is still the basename. It is a narrow case and it is the one the check's refusal
  guard still exists for.

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
  `COMPOSE_PROJECT_NAME` is how two clones are separated **and that it overrides the pinned
  `name:`**, and one sentence on what the volume holds and how long. It also says the two
  stacks are separate projects and may both run, and names the volume `shortkit-dev_pgdata`
  so `docker volume ls` output is recognisable.
- **`docker-compose.test.yml` could take `name: shortkit-test` and let the dev stack drop
  back to the basename.** That is a behaviour change to TASK-005's file and needs its owner.
  The trigger is anyone opening that file for another reason; nothing forces it, because
  `name: shortkit-dev` already separates the two.
- `scripts/check-compose-stack.sh`'s refusal message explains the collision as "they share a
  project name because Compose derives it from the directory basename", which stops being
  the reason it can fire once the dev file pins `name:`. The guard is still correct; only its
  explanation narrows. Routed to the check's owner, cosmetic.
- `docs/architecture/migrations.md`'s existing "drop and recreate" instructions currently
  name `docker-compose.test.yml`. TASK-059 adds the local stack's equivalent beside them
  rather than replacing them; the two databases are different and both instructions are
  correct for their own file.
