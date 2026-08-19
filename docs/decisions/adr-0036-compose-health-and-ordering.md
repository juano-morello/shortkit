---
id: ADR-0036
slug: foundation
title: Every service probes what it actually promises, the Postgres probe connects over the compose network so that it authenticates, and the API's start period is coupled to its boot budget
status: accepted
supersedes: null
date: 2026-08-11
---

## Context

`docker-compose.test.yml` carries a health check comment written from measurement, and it is
the most reusable thing in the repository about compose. `pg_isready` marks the container
healthy during the Postgres entrypoint's temporary socket-only server, so `up -d --wait`
returns and the next command gets `ECONNREFUSED` or `role shortkit_app does not exist`. The
probe that works runs a statement as `shortkit_app`, over TCP, against the real database.
Those three properties are load-bearing and `pg_isready` has none of them: its `-U` and
`-d` only affect what the server logs, and with no `-h` it uses the unix socket.

**A fourth property was claimed and does not exist. Corrected 2026-08-11 (F-357).** The test
file's comment and the first version of this ADR both said the probe *authenticates*. It does
not, because of where it connects. Measured by reading `pg_hba.conf` out of a running
`postgres:17-alpine` container:

```
local   all  all                trust
host    all  all  127.0.0.1/32  trust           <- initdb's default
host    all  all  ::1/128       trust
host    all  all  all           scram-sha-256   <- appended by the entrypoint
```

The first matching line wins, and the loopback trust lines come first. A probe that connects
to `127.0.0.1` from inside the container is therefore trusted and `PGPASSWORD` is never read.
Measured both directions against that container: a wrong password over `127.0.0.1` is
**accepted**; the same wrong password over the container's own bridge address gets
`FATAL: password authentication failed for user "shortkit_app"`.

Everything else in the stack connects to `postgres:5432` over the compose network, which
matches the `scram-sha-256` line. So the probe was testing the one path no other client uses,
and the one path where the credential does not matter.

The same question has a different answer for each of the other services, and getting it
wrong the same way is easy. `GET /health` is served by `apps/api/src/health/health.controller.ts`
and touches no database. So a green `/health` says the process is up. It says nothing about
whether the API can serve a request that reads a table. `fly.toml` and
`docs/architecture/migrations.md` both record that gap, and on the redirect path it is GC-8.

`main.ts` spends up to `DATABASE_REACHABLE_BUDGET_MS`, 20 seconds, retrying an unreachable
database before it refuses to boot. Its own docblock says the number is coupled to
`fly.toml`'s 30-second `grace_period` and that raising one means raising the other.
ADR-0030 deletes `fly.toml`, so that coupling needs a new home or it is lost.

## Alternatives considered

**`pg_isready` for Postgres.** Pros: it is the documented probe, it is one word, and every
tutorial uses it. Cons: measured false-positive during initdb, which is precisely the window
this stack runs its role script in. Why it lost: `docker-compose.test.yml` already ruled on
this from measurement and nothing about a persistent volume changes it. The first `up` is
the run where it matters and the first `up` is the run where it fails.

**`depends_on` ordering with no health checks at all.** Pros: simplest; compose starts things
in order. Cons: plain `depends_on` waits for the container to start, not for the service to
work, so `migrate` would connect to a Postgres that is still running initdb. Why it lost: it
is the failure the health check exists to prevent, with the check removed.

**A TCP port probe for the API, such as `nc -z 127.0.0.1 3001`.** Pros: no HTTP client
needed in the image. Cons: a listening socket is a weaker claim than a 200, and `netcat` is
not in `node:24-alpine`. Why it lost: the image already has a better HTTP client than
anything we would install.

**`wget -q -O- http://127.0.0.1:3001/health` for the API.** Pros: busybox provides it in the
alpine base, so it needs nothing installed. Cons: it asserts the request did not fail; it
does not assert the status code without extra flags and it does not read the body. Why it
lost: it is close, and the node one-liner asserts what AC-115 actually says.

**Asserting the `commit` field's shape in the API probe as well as `status`.** Pros: catches
a mis-built image at probe time. Cons: the Dockerfile guard and the boot check already
refuse that image at two earlier layers, and under ADR-0037 the compose default is a
sentinel that would pass the regex anyway. Why it lost: it duplicates two existing guards
and would still not distinguish the case it exists for.

### Where the Postgres probe connects (added 2026-08-11, F-357)

**Keep `-h 127.0.0.1` and delete the word "authenticates" from the comment.** Pros: no change
to a probe string that is already written and already escaped; no dependency on name
resolution; the three properties that do hold are still worth more than `pg_isready`. Cons:
the probe never reads `PGPASSWORD`, so `$$SHORTKIT_APP_PASSWORD` in it is decorative and an
escaping mistake there is undetectable by any outcome. `postgres` healthy would carry no
claim about the credential every other service in the stack has to present. Why it lost: it
leaves a load-bearing-looking string that nothing reads, which is the shape that produced
this finding.

**`POSTGRES_INITDB_ARGS: --auth-host=scram-sha-256`, so loopback authenticates too.** Pros:
fixes the server rather than the probe, so any future in-container client on loopback also
authenticates, and the probe string stays exactly as written. Cons: it buys no security,
because `local all all trust` already gives anything with a shell in that container a
passwordless superuser session over the unix socket. It is an initdb-time setting, so it is a
silent no-op against an existing `pgdata` volume, which adds a fourth entry to ADR-0032's
list of edits that appear to do nothing. And the failure mode is the wrong direction: if the
entrypoint does not honour the argument the way this ADR assumes, the probe keeps passing
under trust and nobody finds out. Why it lost: an unverified mechanism whose failure is
silent green is exactly what F-357 is.

**`-h "$$(hostname -i)"`.** Pros: reaches the container's own bridge address, which is what
was measured, and does not name the service. Cons: it puts a `$` back into
`healthcheck.test`, the precise site of F-316, and `hostname -i` prints space-separated
addresses when the container joins more than one network, which hands `psql` a host string
that is not a host. Why it lost: `-h postgres` reaches the same address with no new escaping
and no arity assumption. Kept as the named fallback below.

## Decision

**Postgres: the test stack's probe, carried forward with its reasoning, adapted to this
database, and pointed at the compose network so that it authenticates.** `PGPASSWORD`
through the environment rather than a password embedded in a DSN, because an overridden
password with a `@` or `/` in it breaks a URL and does not break an environment variable.

```yaml
healthcheck:
  test:
    - 'CMD-SHELL'
    - 'PGPASSWORD="$$SHORTKIT_APP_PASSWORD" psql -h postgres -p 5432 -U shortkit_app -d shortkit -tAc "select 1" >/dev/null'
  interval: 1s
  timeout: 3s
  retries: 30
  start_period: 10s
```

**`-h postgres`, not `-h 127.0.0.1`. Changed 2026-08-11 (F-357).** The service resolves
through the compose network's DNS to the container's own bridge address, which matches
`host all all all scram-sha-256` rather than initdb's loopback trust line. Four properties
then hold instead of three: the role exists, the database exists, the real server is
accepting TCP, and **the password `shortkit_app` presents is the password the role has**.
That fourth one is the reason `postgres` healthy is worth anything to `migrate`, `seed` and
`api`: the probe now travels the same code path, over the same address family, with the same
credential shape as every other client in the stack. The comment in `docker-compose.yml`
restates all of it, at the same length as the test file's, because the next person to
"simplify" this will reach for `pg_isready` or for loopback.

**Verify the resolution once and record it.** That a compose service resolves its own name
from inside its own container is Docker's documented behaviour and it was **not measured**
here: design started no containers. If it is wrong, the failure is loud and immediate. The
container never goes healthy and the health log says `could not translate host name
"postgres" to address`. The fallback is `-h "$$(hostname -i)"`, with the `$$` and the
multi-network caveat above. The implementer states in the TASK report which form is in the
file and what the first `up` printed.

**No `2>&1`. Changed 2026-08-11 (F-357).** stdout goes to `/dev/null` and stderr does not.
Docker keeps the last five probe outputs in `.State.Health.Log`, so
`docker inspect --format '{{json .State.Health}}' <container>` shows psql's own error text,
which for the failure this probe now catches is `FATAL: password authentication failed for
user "shortkit_app"`. That single line is the diagnosis F-315 costs an afternoon without.
psql never echoes `PGPASSWORD`, and `docker inspect` already prints that variable from the
container's environment (ADR-0031), so this discloses nothing new. The cost is a noisier
health log during `start_period`, where every entry reads `Connection refused` while initdb
runs.

**`$$SHORTKIT_APP_PASSWORD`, with two dollars.** Corrected 2026-08-11 (F-316). Compose
interpolates `healthcheck.test` the same way it interpolates `configs.*.content`, so a
single `$` is substituted from the **host** environment at parse time, where the variable is
unset by design: ADR-0031 gives it a value in the **container** environment. Verified by
execution with `docker compose config`, the probe then renders as `PGPASSWORD=""`.

### What the F-315 and F-316 defects actually do, measured

**This is the single normative account of that failure mode.** ADR-0031 and TASK-059's card
point here rather than restating it, because the version they used to carry was wrong in the
same way in all three places (F-357). Measured by TASK-059's red step against real
containers, not derived.

| Defect | Under the old loopback probe | Under the probe above |
|---|---|---|
| Roles script unescaped (F-315): both roles get a NULL password | probe passes under `trust`, `postgres` reports **healthy**, `up -d --wait` returns **0** on a Postgres-only stack. In the full stack the first red is `migrate`, connecting over the network, with `FATAL: password authentication failed for user "shortkit_migrator"` against a database whose roles visibly exist | probe fails on every attempt, `postgres` unhealthy at roughly 40 seconds, `migrate` never starts, `up -d --wait` exits non-zero with `dependency failed to start: container ... is unhealthy`, and the health log names the role |
| Probe unescaped (F-316), roles script correct | `PGPASSWORD=""` is never read, so the probe **passes**. The stack comes up entirely green with a probe that checks nothing, and nothing ever detects the mistake | probe fails on every attempt, same loud outcome as above |

Two things follow, and the second is why this section exists.

1. The earlier claim that the probe "alone holds the whole stack down, independent of the
   roles script" was **backwards**. Alone, it held nothing down and reported green.
2. Both defects are still deterministic first-`up` failures with the probe above, so the
   `$$` rule's importance is unchanged. What changed is that the rule is now
   **self-enforcing**: a single `$` in the probe makes the container unhealthy on the first
   `up`, instead of producing a green stack with a decorative password.

3. Detection no longer rests on the probe alone. `scripts/check-compose-stack.sh` reads
   Compose's parse-time warnings and names any variable that was substituted with the empty
   string, before it starts anything, and its GUARD-1 authenticates as `shortkit_app` over a
   non-loopback address from the host. Either one catches both defects independently of the
   probe.

The escape and its evidence are ADR-0031's; this ADR states only what the failure looks like.

**The reason this is in the ADR rather than left to the implementer is the repair it
invites.** A developer facing "postgres is never healthy" has three cheap fixes in front of
them and two are the ones this cluster exists to prevent: put the literal password in the
probe, which is the test file's shape and the F-131 hazard ADR-0031 avoids; replace the
probe with `pg_isready`, which is the measured false positive this section exists to
prevent; or set `POSTGRES_HOST_AUTH_METHOD=trust`, which makes a Postgres on
`127.0.0.1:55432` accept any password for `shortkit_migrator`. The third is the one that
makes the probe pass fastest and it is the only one that is a security defect. It is also the
only one of the three that `scripts/check-compose-stack.sh` catches: GUARD-2 presents a wrong
password over a non-loopback address and fails if the server accepts it.

**The `node -e` probes below need no escaping and must not be given any.** They contain no
`$`. Their YAML single-quoted scalar yields `node -e "fetch('...')..."`, and inside the
shell's double quotes the single quotes, braces, `=>`, `;` and `>` are all literal. Adding
`$$` where there is no `$` would be cargo cult.

**`migrate` and `seed`: no health check.** They are one-shot services and their promise is
an exit code. `condition: service_completed_successfully` on the dependent service is the
whole mechanism.

**API: an HTTP probe that asserts the status code and the body, using the runtime already in
the image.**

```yaml
healthcheck:
  test:
    - 'CMD-SHELL'
    - 'node -e "fetch(''http://127.0.0.1:3001/health'').then(async r => { if (r.status !== 200) process.exit(1); const b = await r.json(); if (b.status !== ''ok'') process.exit(1); }).catch(() => process.exit(1))"'
  interval: 5s
  timeout: 3s
  retries: 12
  start_period: 30s
```

`node -e` needs nothing installed. Node 24 has global `fetch`. The probe asserts exactly what
AC-115 asserts: 200, and `status` equal to `"ok"`.

**`start_period: 30s`, and the number is coupled to `main.ts`, not chosen.** Boot retries an
unreachable database for `DATABASE_REACHABLE_BUDGET_MS`, 20 seconds, before refusing. A start
period at or below that would start counting failures while the process is riding out exactly
the wake the retry exists to survive. This is `fly.toml`'s 30-second `grace_period` moving
into the file that replaces it. **Raising one means raising the other**, and the comment in
`docker-compose.yml` says so beside the value, because `main.ts`'s docblock currently points
at `fly.toml` and will point here.

**What the API's health check does and does not mean, stated in the compose file.** A green
`api` means the process bound its port and `/health` answered. `/health` touches no database.
What carries the database claim is not the probe but the boot sequence: `main.ts` refuses to
serve unless it reached the database and established that the runtime role cannot bypass RLS.
So `api` healthy means "at boot, Postgres was reachable and `shortkit_app` was
`NOBYPASSRLS`". It does not mean the database is reachable now.

**Web: an HTTP probe of the root page, the same shape, status only.**

```yaml
healthcheck:
  test:
    - 'CMD-SHELL'
    - 'node -e "fetch(''http://127.0.0.1:3000/'').then(r => process.exit(r.status === 200 ? 0 : 1)).catch(() => process.exit(1))"'
  interval: 5s
  timeout: 3s
  retries: 12
  start_period: 10s
```

`/` is what AC-115 measures for the web app and there is no body contract to assert.

**Startup ordering.**

```
postgres  healthcheck above
migrate   depends_on: postgres  condition: service_healthy
seed      depends_on: migrate   condition: service_completed_successfully
api       depends_on: seed      condition: service_completed_successfully
web       no depends_on (ADR-0035)
```

**Restart policy.** `postgres`, `api` and `web` take `restart: unless-stopped`. `migrate` and
`seed` take `restart: "no"`. The reasoning is `fly.toml`'s F-245 reasoning carried forward:
`main.ts` refuses to boot when it cannot establish that the runtime role is subject to RLS,
and a database that is slow to come back leaves the API exited. Something has to bring it
back or the stack is down until a human notices.

**Verification commands, for the README and for the auditor.** `docker compose up` is AC-115's
literal command and runs in the foreground. `docker compose up -d --wait` is what returns only
when every service is healthy or has completed successfully, and it is what a check should
use. Both belong in the README. `--wait` is the reason the Postgres probe has to be true
rather than merely green.

**`docker compose restart` restarts the exited one-shots too, and it does not honour
`depends_on` conditions.** So the DoD's top rung prints two failing services: `migrate` and
`seed` are restarted alongside the rest, they connect to a Postgres that is not yet accepting
connections, and they exit non-zero under `restart: "no"`. The data survives, which is what
the DoD asks. The README says this in the same place it names the command, because a
developer who sees two red services after `restart` will read it as a broken stack and reach
for `down -v`, which destroys the data the rung exists to demonstrate.

## Consequences

### Positive

- The measured `pg_isready` failure cannot recur in this stack, and the reason travels with
  the probe rather than living only in a file this one does not read.
- **`postgres` healthy now carries a credential claim.** `shortkit_app` authenticated over
  the compose network, which is the same path and the same authentication method `seed` and
  `api` use. The dependent services no longer start behind a green light that was earned
  under `trust`.
- **A missing `$` in the probe is now self-detecting.** It was previously invisible in every
  outcome, which is why F-316's remedy needed this change rather than only a documentation
  fix.
- **A failing probe explains itself.** Keeping stderr puts Postgres's own `FATAL` line in
  `docker inspect`'s health log, which is where a developer looks after `up --wait` reports
  a container unhealthy.
- Every probe asserts the thing its AC asserts. The API's checks a 200 and `status: "ok"`;
  the web's checks a 200 on the page AC-115 names.
- `up -d --wait` returning is a real signal, so the DoD's clean-state demonstration is a
  script rather than a sequence of sleeps.
- The 20-second boot budget's coupling survives the deletion of `fly.toml` instead of
  becoming an orphaned comment.
- No probe needs anything installed in either image.

### The cost accepted

- **A green `api` does not mean the API can reach the database.** It means it could at boot.
  `/health` touching no database is a deliberate decision from ADR-0006 and this ADR does not
  reopen it; it names the gap so nobody reads the green as more than it is.
- **`restart: unless-stopped` turns a genuine misconfiguration into a restart loop.** An API
  pointed at a `BYPASSRLS` role refuses on every attempt and the log fills with the same
  refusal. The first refusal is the diagnostic one; the last is identical and arrives after
  hundreds of lines.
- **The Postgres probe runs `psql` every second for up to 40 seconds.** Each is a connection
  and an authentication against a database that is starting. It is cheap and it is not free,
  and it will appear in the Postgres log as a run of connection attempts on the first `up`.
  Each one is now a full SCRAM handshake and a DNS lookup rather than a trusted connection,
  which is still cheap and is measurably more work than before.
- **The probe now depends on the compose network's name resolution and on the service being
  called `postgres`.** Renaming the service breaks the probe, and the break is loud: the
  container never goes healthy and the health log says the host name could not be
  translated. This coupling did not exist with `127.0.0.1` and it is the price of the
  credential claim.
- **That resolution is stated from Docker's documentation and was not measured here.** It
  sits on TASK-059's verify-on-first-`up` list with a named fallback. It is the one mechanism
  claim in this revision that is not backed by execution, and it is stated that way on
  purpose: F-357 exists because a mechanism claim was repeated in three documents without
  anyone re-measuring it.
- **The probe covers `shortkit_app` and not `shortkit_migrator`.** A password wrong for the
  migrator alone still surfaces at `migrate` rather than at the health check. One role is a
  sufficient canary for the defect class this exists to catch, because F-315 breaks both
  roles at once, and a two-role probe doubles the connection cost every second for a case
  nothing has produced.
- **The test stack keeps the loopback probe and keeps the hole.** `docker-compose.test.yml`
  belongs to TASK-005, which is `done`, so F-357 corrected its comment and not its
  behaviour. The hole is inert there: that file creates its roles with literal passwords in
  the same file the DSNs are documented in, with no interpolation anywhere, so there is no
  mechanism to make the passwords disagree. The two files now differ on a probe that was
  supposed to be the shared worked example.
- **The `node -e` probes are one-line JavaScript inside YAML inside a shell string**, with
  two levels of quoting. They are not linted and a quoting mistake produces a permanently
  unhealthy service with no message. The implementer must run them once by hand.
- **`start_period: 30s` means a genuinely broken API takes 30 seconds to be reported.** That
  is the price of not killing a healthy one that is waiting on a cold database.
- **Nothing checks the seed's coverage warning.** `seed` exits 0 whether or not tables are
  uncovered (ADR-0034), so `up --wait` returns green over a partially seeded database by
  design.

### Follow-ups this creates

- `apps/api/src/main.ts`'s `DATABASE_REACHABLE_BUDGET_MS` docblock and the
  `bootstrap().catch` comment both name `fly.toml`. They point at `docker-compose.yml` and
  this ADR now. Outside TASK-059's paths, so it needs routing.
- README gains the two commands and the reset ladder (ADR-0032).
- **`docker-compose.test.yml`'s probe comment was corrected in place (F-357) and its probe
  was not.** Whoever next owns that file decides whether the integration suite's Postgres
  should authenticate its own health probe. The change is `-h postgres` there too, and it is
  a behaviour change to a `done` TASK's file, so it needs an owner rather than a drive-by.
- **`scripts/check-compose-stack.sh` asserts nothing about where the probe connects**, by its
  own deliberate stance of measuring behaviour rather than file text. GUARD-1 and GUARD-2
  measure the server's authentication from the host, which is a different claim. A clause
  that reads `docker compose config` for a loopback host in the Postgres probe would close
  it and would break that stance; routed to the check's owner as a judgement call, not as a
  defect.
