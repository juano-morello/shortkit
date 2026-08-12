---
id: ADR-0031
slug: foundation
title: The compose stack transcribes the roles contract rather than sharing SQL with the test stack, and its credentials are fixtures bound to loopback
status: accepted
supersedes: null
date: 2026-08-11
---

## Context

`docker-compose.test.yml` inlines the role provisioning SQL as a compose `config` and is
the repository's only worked example of it. It carries its own banner:
`TEST-ONLY. DO NOT ADAPT THIS FILE INTO A PRODUCTION DATABASE (F-131)`, followed by an
explicit list of what is reusable and what is not. The reusable half is
`rls-policy-template.md`'s "Roles" section applied. The non-reusable half is literal
passwords, no TLS, tmpfs, and the fact that `ALTER DEFAULT PRIVILEGES` is scoped to the
identity `shortkit_migrator`.

The new stack needs the same two roles with three differences: a different database name
(`shortkit`, not `shortkit_test`), passwords that come from the environment rather than
from a literal, and a data directory that survives a restart.

Two facts decide this. First, `rls-policy-template.md` is already the normative source for
both files, and it writes the passwords as psql variables: `PASSWORD :'migrator_password'`.
`docker-compose.test.yml` says in its own comment that it departs from the contract "but
for the literal passwords, which psql cannot take as `:'variables'` here", because the
Postgres entrypoint runs a `.sql` file in `/docker-entrypoint-initdb.d` through `psql -f`
with no `-v` flags. Second, `docker-compose.test.yml` belongs to TASK-005, which is `done`.

## Alternatives considered

**Extract the roles SQL to one file both compose stacks mount.** For example
`infra/postgres/roles.sql`, parameterised, with each stack passing its own database name
and passwords. Pros: one text to change when the contract changes; drift between the two
becomes impossible by construction. Cons: it couples a `done` TASK's file to a new one, so
every future change to the local stack's provisioning edits a file the integration suite
depends on, and a mistake there turns the whole suite red for reasons that have nothing to
do with the suite. It also needs a parameterisation mechanism anyway, since the database
names differ. And `infra/` is deleted by ADR-0030, so the shared file needs a new home
whose only occupant is this. Why it lost: the coupling runs the wrong way. A test-only file
and a local-only file have different constraints, and the thing that should be shared is
the contract, not the transcription.

**Copy `docker-compose.test.yml`'s config block and change the literals.** Pros: fastest;
the block is known to work. Cons: it copies the `.sql`-in-initdb.d shape, which is the
shape that forced the departure from the contract in the first place, so the new file
inherits a workaround it does not need. Interpolating a password into
`CREATE ROLE ... PASSWORD '${VAR}'` has no escaping, so an override containing a quote
produces a syntax error at best and a different role at worst. Why it lost: it copies the
one part of the test file the contract already says is a compromise.

**Transcribe the contract into a shell init script that passes the passwords as psql
variables.** Pros: the SQL in the new file is the contract verbatim, `:'app_password'`
included; psql does the quoting, so an arbitrary password is safe; the two compose files
stay independent. Cons: an extra layer, a shell script inside a YAML string, and a second
transcription of the same SQL that can drift from the first. Why it won: the drift it
allows is caught by execution, and the escaping problem it removes is not caught by
anything.

## Decision

**Two transcriptions of one contract, not one shared file.** `docker-compose.test.yml` and
`docker-compose.yml` each hold their own copy of `rls-policy-template.md`'s "Roles"
section. Neither is derived from the other. `rls-policy-template.md` is the single
normative source and its "Consumed by" line names both.

**The new stack's copy is the contract verbatim, including the psql variables**, delivered
as a shell init script rather than a `.sql` file so that `psql -v` is available:

```yaml
configs:
  shortkit_roles_sh:
    content: |
      #!/bin/sh
      set -eu
      psql -v ON_ERROR_STOP=1 --username "$$POSTGRES_USER" --dbname postgres \
        -v migrator_password="$$SHORTKIT_MIGRATOR_PASSWORD" \
        -v app_password="$$SHORTKIT_APP_PASSWORD" <<'SQL'
      -- NOBYPASSRLS on BOTH roles. It is the default, and it is written out because a
      -- role that can bypass RLS makes every isolation claim in this system a tautology:
      -- the API's boot check would refuse, the integration suite's assertions would pass
      -- over a role exempt from every policy, and nothing else looks.
      CREATE ROLE shortkit_migrator LOGIN PASSWORD :'migrator_password' NOBYPASSRLS;
      CREATE ROLE shortkit_app      LOGIN PASSWORD :'app_password'      NOBYPASSRLS;

      CREATE DATABASE shortkit OWNER shortkit_migrator;

      \connect shortkit

      GRANT USAGE ON SCHEMA public TO shortkit_app;
      ALTER DEFAULT PRIVILEGES FOR ROLE shortkit_migrator IN SCHEMA public
        GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO shortkit_app;
      ALTER DEFAULT PRIVILEGES FOR ROLE shortkit_migrator IN SCHEMA public
        GRANT USAGE, SELECT ON SEQUENCES TO shortkit_app;
      SQL
```

Mounted at `/docker-entrypoint-initdb.d/10-roles.sh`, **with `mode: 0555` on the service's
`configs` entry**, and the claim attached to that is narrower than it first appears.

Compose gives a config `0444` by default. The Postgres entrypoint branches on the executable
bit for `*.sh`, confirmed verbatim against `docker-library/postgres` `17/alpine3.23`: it runs
an executable file as a child process and **sources** a non-executable one into its own
shell, logging which it did. Sourcing leaves this script's `set -eu` set in the entrypoint's
shell for the rest of initialisation, and `-u` then turns any later dereference of an unset
variable into a fatal error in a file nobody here controls. The maintainers know the shape:
line 3 of that entrypoint carries their own
`# TODO swap to -Eeuo pipefail above (after handling all potentially-unset variables)`.

**The hazard is latent, not present.** Everything the entrypoint executes after
`docker_process_init_files` was traced and none of it dereferences an unset variable, so
sourcing works today. `mode: 0555` asks for the cleaner of two working paths rather than
avoiding a live failure.

**The mode takes effect. Measured 2026-08-11 (TASK-059 red step).** Docker's reference says
`mode` is ignored for bind-mounted config content, which is how Compose delivers a
`content:` config, and that reservation is what kept this on the unverified list. It does not
apply here. A `content:` config mounted at `/docker-entrypoint-initdb.d/10-roles.sh` with
`mode: 0555` lands as `-r-xr-xr-x` and the entrypoint logs
`running /docker-entrypoint-initdb.d/10-roles.sh`, not `sourcing`. So the script executes as
a child process, its `set -eu` does not leak into the entrypoint's shell, and the latent
hazard above does not arise. Docker 29.7.2, Compose v5.4.0, `postgres:17-alpine`.

Five more details are load-bearing:

- **Every `$` the container's shell must see is written `$$`.** See the section below. This
  is invisible in the rendered YAML and there is no worked example of it in the repository.
- `<<'SQL'` is quoted, so the shell performs no expansion. psql substitutes
  `:'app_password'` and quotes it correctly whatever it contains. That is what makes the
  contract's own form usable and it is the whole reason for the shell layer. It only
  protects anything once the `$$` escaping is in place, because Compose runs first.
- `POSTGRES_DB: postgres`, so the entrypoint does not create `shortkit` itself. The
  `CREATE DATABASE ... OWNER shortkit_migrator` above is what makes the migrator the owner,
  which is what makes it own schema `public` through `pg_database_owner` and run DDL with
  no further grant (ADR-0003).
- `ON_ERROR_STOP=1`. Without it psql reports success after a failed statement and the
  container comes up with half the roles. It does not fire on a NOTICE, which is the door
  the interpolation defect below came through.
- `NOBYPASSRLS` on both roles, **with the comment**. It is the Postgres default, so it
  reads as redundant to anyone who does not know what it is doing, and the reader most
  likely to delete it is the one who cannot see why it is there. `docker-compose.test.yml`
  carries the same sentence for the same reason. The property is caught at runtime by
  `assertRuntimeRoleCannotBypassRls()`; the reason is caught by nothing.
- Nothing in this script grants `shortkit_app` anything on a table directly. It receives
  DML only through `ALTER DEFAULT PRIVILEGES FOR ROLE shortkit_migrator`, which is what
  makes ADR-0033's grant check meaningful.

### Compose interpolates `configs.*.content`, and every `$` must be `$$`

Corrected 2026-08-11 (F-315, F-316). This ADR previously stated that interpolation inside a
config block "is not used here, deliberately". That was wrong. Interpolation is on by
default and applies to the whole document, including `configs.*.content`, `healthcheck.test`
and `command`. Verified twice by execution, independently, with `docker compose config` on a
scratch file:

- Unescaped, on AC-115's own scenario (nothing exported, no `.env`), Compose emits
  `The "POSTGRES_USER" variable is not set. Defaulting to a blank string.` and stores
  `--username "" -v migrator_password="" -v app_password=""`. libpq treats an empty user as
  unset and connects as `postgres`, PostgreSQL answers `PASSWORD ''` with a NOTICE rather
  than an error, `ON_ERROR_STOP=1` does not fire, and the script exits 0. Both roles exist
  with a password no other part of the stack believes was set, and the only diagnostic at
  that moment is three warnings at the top of the `up` output. **What the stack does next is
  ADR-0036's to state.** This ADR used to state it too, and stated it wrongly: see that ADR's
  section "What the F-315 and F-316 defects actually do, measured", which is now the one
  normative account (corrected 2026-08-11, F-357).
- Escaped, `$$POSTGRES_USER` is not a reference at all. Compose's interpolation lexer
  consumes `$$` as an escape before it ever looks for a name.

**How the escape was established, and where the evidence stops.** Recorded because the first
version of this section carried a justification that does not hold, and an ADR with a broken
proof in it is worse than one with none: the next reader stops at the proof.

The discarded argument was that a source `$$` and a host-injected single `$` render
identically in `docker compose config`, so their internal values must be equal. That does not
follow. It assumes the printer is a function of the resolved model alone, and it does not
exclude a provenance-aware printer that passes a source `$$` through untouched and escapes
only substituted values. Those two hypotheses agree on every input a printing experiment can
construct, including `${DOLLAR}A$$B`, which renders `$$A$$B` under both. **No amount of
reading `docker compose config` output separates them.**

What does separate them is the lexer, which is observable through warning emission and
through structure rather than through the printed dollars. Measured on Docker 29.7.2,
Compose v5.4.0:

| Input | Warning | Output |
|---|---|---|
| `$$NAME`, `NAME` unset | **none** | `$$NAME` |
| `$$$NAME`, `NAME` unset | **exactly one** | `$$` |
| `x$${VAR}x`, `VAR=zzz` | none | `x$${VAR}x` — the literal `{VAR}` survives |
| `x$$${VAR}x`, `VAR=zzz` | none | `x$$zzzx` — substituted |

Row 1 is decisive against interpolation: an unset variable always warns, and there is no
warning, so no reference was ever recognised. Row 2 shows `$$` consumed in pairs, leaving one
`$NAME` that does warn. Rows 3 and 4 show the behaviour is structural rather than a count of
dollars, because the brace group either survives as text or is substituted depending on which
side of the escape it falls.

**The last step is the specification, not a measurement.** That `$$` expands to exactly one
`$` in the container is Compose's documented definition of the token, and confirming it needs
a running container. It is not verified here and it does not need to be, because its failure
is loud rather than silent: two dollars would make `/bin/sh` read `$$` as its own PID, `psql`
would be handed `--username "1234POSTGRES_USER"`, and `set -eu` on top of the Postgres
entrypoint's `set -Eeo pipefail` aborts the container on the first `up`. Nothing about that
reaches a running stack.

**This is not a typo, it is the reason this ADR rejected the other option, inverted.** The
copy-the-test-file alternative lost because `PASSWORD '${VAR}'` has no escaping. Compose
interpolating the content reintroduces that one layer higher and into a worse target: the
value lands on a **shell command line**, not in SQL, in a script the Postgres entrypoint
runs as root. With `SHORTKIT_APP_PASSWORD` set to `a"$(id)"b` the stored content is
`-v app_password="a"$(id)"b"`, which is command substitution. psql's `:'var'` quoting never
gets a chance, because `/bin/sh` has already run. The rejected alternative's worst case was
a role with the wrong password; this one's is command execution in the database container.
The `$$` escaping is what puts the value back inside the heredoc's protection.

**Credentials are fixtures with overridable defaults, and the whole stack binds to
loopback.**

```yaml
environment:
  POSTGRES_PASSWORD:           ${POSTGRES_SUPERUSER_PASSWORD:-postgres}
  SHORTKIT_MIGRATOR_PASSWORD:  ${SHORTKIT_MIGRATOR_PASSWORD:-migrator}
  SHORTKIT_APP_PASSWORD:       ${SHORTKIT_APP_PASSWORD:-app}
```

Every published port binds `127.0.0.1` explicitly: `127.0.0.1:55432:5432` for Postgres,
`127.0.0.1:3001:3001` for the API, `127.0.0.1:3000:3000` for the web app. 55432 sits beside
the test stack's 55433 and is not 5432, so a Postgres already running on the developer's
machine is neither shadowed nor connected to by accident.

**A distinct port is not what keeps the two stacks apart. Corrected 2026-08-11 (F-356).** The
sentence above is true of a foreign Postgres and was false of this repository's own test
stack. Compose identifies a container by project plus service and not by port, and both files
sit in one directory and both name a service `postgres`, so distinct ports did nothing to
stop `docker compose up` at the root from recreating the integration suite's container.
`name: shortkit-dev` in `docker-compose.yml` is what separates them (ADR-0032).

**`docker-compose.yml` carries its own banner, in the same form as the test file's:**

```
LOCAL DEVELOPMENT ONLY. THIS IS NOT A PRODUCTION DATABASE, AND THERE IS NO
PRODUCTION DATABASE (ADR-0030).
```

followed by its own reusable and not-reusable lists. Not reusable, and the list is the
test file's minus tmpfs: default passwords in a committed file including the bootstrap
superuser's; no TLS, so every connection on the compose network is plaintext;
`ALTER DEFAULT PRIVILEGES` scoped to the identity `shortkit_migrator`, so anything that
migrates as another role grants `shortkit_app` nothing; and **`restart: unless-stopped` on
`postgres`** (ADR-0036), which is right for a development stack and means a database holding
the committed superuser password comes back on every Docker daemon start, including after a
reboot, until someone stops it. That setting is exactly what a reader would carry into a
production file, and the exposure window it creates there is permanent rather than "while I
am working".

**Overridden passwords must be URL-safe.** `DATABASE_URL` and `DATABASE_MIGRATION_URL` are
assembled by string interpolation in the compose file, and a DSN has no escaping mechanism
the way psql does. The `.env.example` says so at the variable.

## What keeps the duplication safe, and what would stop keeping it safe

The duplication is safe because the properties that matter are asserted by execution rather
than by reading, in three independent places:

1. `apps/api/src/db/rls.ts`'s `assertRuntimeRoleCannotBypassRls()` runs at API boot and
   refuses to serve if the connected role holds `BYPASSRLS` or is a superuser.
2. The seed connects as `shortkit_app` and writes (ADR-0033), so a broken
   `ALTER DEFAULT PRIVILEGES` fails the stack before the API starts.
3. `apps/api/test/support/rls-fixture.ts` re-checks the role attributes before every
   integration run.

It stops being safe under two conditions, and both are stated so they can be watched:

- **A change to `rls-policy-template.md`'s "Roles" section lands in only one compose file.**
  The contract's "Consumed by" line names both files, so the change is a one-line grep, but
  nothing automated enforces it.
- **Someone makes either file production-shaped.** Then both non-reusable lists apply at
  once, and neither file is a starting point. Production role provisioning is unowned and
  routed alongside F-116, and this ADR does not take it.

## Consequences

### Positive

- The new file transcribes the contract rather than the test file, so the F-131 hazard is
  not "copied carefully" but avoided: nothing in `docker-compose.yml` came from
  `docker-compose.test.yml`.
- The contract's `:'password'` form works for the first time, so an overridden password of
  any shape is quoted correctly instead of concatenated into DDL.
- `docker-compose.test.yml` is untouched, so a `done` TASK stays done and the integration
  suite cannot be broken by work on the local stack.
- Everything binds to loopback, so a stack with the password `app` is not on the LAN.

### The cost accepted

- **Two copies of the same nine SQL statements.** A contract change has to be applied twice
  and nothing fails if it is applied once. The three runtime assertions above catch the
  cases that matter, and they do not catch a grant that is added to one file and not the
  other.
- **Default passwords ship in a committed file.** A developer who changes the port bindings
  from `127.0.0.1` to `0.0.0.0`, or who runs this on a host with a permissive firewall,
  exposes a Postgres superuser with the password `postgres`. The banner says so; nothing
  enforces it.
- **The shell layer is a shell script inside a YAML string.** It is not linted, not
  shellchecked, and a syntax error there surfaces as a Postgres container that starts and
  has no roles. The health probe in ADR-0036 is what turns that into a visible failure
  rather than a confusing one. The scope of that is narrower than it reads. A missing role is
  caught by either form of the probe, because `trust` still requires the role to exist. A
  role that exists and cannot authenticate, which is what the interpolation defect produces,
  was reported **healthy** by the loopback form this cluster specified until 2026-08-11
  (F-357).
- **The `$$` escaping is invisible in the rendered file and has no precedent to copy.**
  `docker compose config` prints `$$`, so reading the rendered output does not tell you
  whether the escaping is right; only running the container does.
  `docker-compose.test.yml`'s probe contains no `$` at all, so the repository offers no
  worked example, and the next person to add a variable to this block will write one `$`.
  The only mitigations are this section and the line on the TASK card.
- **The init script runs exactly once, on the first `up` against an empty data directory.**
  Editing the roles SQL afterwards changes nothing until `docker compose down -v`, and the
  stack keeps working with the old roles, so the edit fails silently. ADR-0032 carries this.
- **`SHORTKIT_APP_PASSWORD` appears in the Postgres container's environment**, so
  `docker inspect` and `docker compose config` print it. For a fixture that is fine. For an
  override it is a disclosure, and there is no secret mechanism in this stack. The same is
  true of `DATABASE_MIGRATION_URL` on the `migrate` service, which is the higher-privilege
  of the two: it carries the credential of the role that owns every table and can `DROP`
  any of them. Both are fixtures today and neither is protected by anything.
- **`SHORTKIT_*` survives into the running server's environment, and `POSTGRES_*` does not.**
  The entrypoint ends with `unset "${!POSTGRES_@}"`, which scrubs its own variables before
  exec'ing `postgres`. That pattern does not match `SHORTKIT_MIGRATOR_PASSWORD` or
  `SHORTKIT_APP_PASSWORD`, so both remain readable at `/proc/1/environ` for the container's
  lifetime, to anything that can exec into it. This is inherent rather than fixable here: the
  health probe runs inside that container and needs `SHORTKIT_APP_PASSWORD` on every
  interval, so the scrub the superuser password gets is not available to these two. Stated at
  this specificity because "appears in the container's environment" reads as a build-time
  fact and this is a runtime one.

### Follow-ups this creates

- `rls-policy-template.md`'s "Consumed by" line gains `docker-compose.yml` and TASK-059.
- Root `.env.example` documents `POSTGRES_SUPERUSER_PASSWORD`,
  `SHORTKIT_MIGRATOR_PASSWORD` and `SHORTKIT_APP_PASSWORD`, including the URL-safety
  requirement.
- **Corrected 2026-08-11 (F-315).** This follow-up previously read "Compose interpolation
  inside a `configs.*.content` block is not used here, deliberately". That was false and it
  was the most dangerous sentence in this ADR, because it told the implementer not to look
  for the thing that breaks the stack. Interpolation is on by default. The rule is in the
  Decision, and it is: **every `$` that the container's shell must see is written `$$`, in
  `configs.*.content`, in `healthcheck.test` and in `command` alike.**
