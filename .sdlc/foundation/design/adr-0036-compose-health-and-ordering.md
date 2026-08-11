---
id: ADR-0036
slug: foundation
title: Every service probes what it actually promises, and the API's start period is coupled to its boot budget
status: accepted
supersedes: null
date: 2026-08-11
---

## Context

`docker-compose.test.yml` carries a health check comment written from measurement, and it is
the most reusable thing in the repository about compose. `pg_isready` marks the container
healthy during the Postgres entrypoint's temporary socket-only server, so `up -d --wait`
returns and the next command gets `ECONNREFUSED` or `role shortkit_app does not exist`. The
probe that works authenticates as `shortkit_app`, over TCP on `127.0.0.1`, against the real
database. All three halves are load-bearing and `pg_isready` has none of them: its `-U` and
`-d` only affect what the server logs, and with no `-h` it uses the unix socket.

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

## Decision

**Postgres: the test stack's probe, carried forward with its reasoning and adapted to this
database.** `PGPASSWORD` through the environment rather than a password embedded in a DSN,
because an overridden password with a `@` or `/` in it breaks a URL and does not break an
environment variable.

```yaml
healthcheck:
  test:
    - 'CMD-SHELL'
    - 'PGPASSWORD="$$SHORTKIT_APP_PASSWORD" psql -h 127.0.0.1 -p 5432 -U shortkit_app -d shortkit -tAc "select 1" >/dev/null 2>&1'
  interval: 1s
  timeout: 3s
  retries: 30
  start_period: 10s
```

The three load-bearing halves are unchanged: it authenticates as `shortkit_app`, it goes
over TCP to `127.0.0.1`, and it names the real database. It is false until the roles exist,
the database exists, and the real server is accepting TCP connections. The comment in
`docker-compose.yml` restates why, at the same length as the test file's, because the next
person to "simplify" this will reach for `pg_isready`.

**`$$SHORTKIT_APP_PASSWORD`, with two dollars.** Corrected 2026-08-11 (F-316). Compose
interpolates `healthcheck.test` the same way it interpolates `configs.*.content`, so a
single `$` is substituted from the **host** environment at parse time, where the variable is
unset by design: ADR-0031 gives it a value in the **container** environment. Verified by
execution with `docker compose config`, the probe renders as `PGPASSWORD=""` and
`shortkit_app`'s password is `app`, so under `postgres:17-alpine`'s default
`scram-sha-256` it fails on every attempt. With `interval: 1s`, `retries: 30`,
`start_period: 10s` the container is unhealthy after roughly 40 seconds and never recovers,
`migrate` never starts because it waits on `service_healthy`, and `docker compose up -d
--wait` exits non-zero with `dependency failed to start: container ... is unhealthy`. AC-115
red on its own command, on a clean machine, every time. This is independent of the roles
script: even with the script correct, the probe alone holds the whole stack down.

**The reason this is in the ADR rather than left to the implementer is the repair it
invites.** A developer facing "postgres is never healthy" has three cheap fixes in front of
them and two are the ones this cluster exists to prevent: put the literal password in the
probe, which is the test file's shape and the F-131 hazard ADR-0031 avoids; replace the
probe with `pg_isready`, which is the measured false positive this section exists to
prevent; or set `POSTGRES_HOST_AUTH_METHOD=trust`, which makes a Postgres on
`127.0.0.1:55432` accept any password for `shortkit_migrator`. The third is the one that
makes the probe pass fastest and it is the only one that is a security defect.

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
