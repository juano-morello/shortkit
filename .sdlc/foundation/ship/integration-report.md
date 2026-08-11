# Integration report: foundation

Ship step 2. Full-system verification of all ten TASKs together, not per-TASK re-runs.

The previous occupant of this path was the 2026-08-06 wave-1 intermediate integration
report. It was not overwritten. It now lives at
`.sdlc/foundation/ship/integration-report-wave-1.md`, unmodified.

| | |
|---|---|
| Verified at | 2026-08-11, 19:31 to 19:47 local (UTC-3) |
| Branch | `main` |
| HEAD when the run started | `e40bbd9` |
| HEAD when the run ended | `6a90d35` |
| Last commit touching non-`.sdlc` source | `6916a24`, 2026-08-11 19:09 |
| Verifier | `sdlc-integrator` |
| Verdict | **changes-requested** |

## What tree this measured, exactly

HEAD moved three times during the run. Every one of those commits touched only `.sdlc/`:
`e40bbd9`, `fe05ed5`, `6a90d35` are all `docs(sdlc)` or `docs(design)`. The last commit to
change any file under `apps/`, `packages/`, `scripts/`, `docs/`, the Dockerfiles or either
compose file is `6916a24` at 19:09, twenty-two minutes before the first command below ran.
So every number here was measured against one source tree, and `git diff --name-only
fe05ed5..HEAD` confirms it: three `.sdlc` paths and nothing else.

**After the last measurement, the tree went dirty and this report does not cover it.**
`git status --porcelain` at 19:47 reads:

```
 M README.md
 M package.json
```

Those are an implementer's in-flight fixes for F-388 (README, open blocker) and F-390
(wiring `check-compose-stack.sh` into `package.json` as `test:compose`). Nothing in this
report was run against them. The report's evidence stops at the committed tree.

## What ran

| # | Check | Command | Result | Evidence |
|---|---|---|---|---|
| 1 | Unit suite | `pnpm test` | **PASS** | 18 files, 189 tests, 189 passed, 0 failed, 1.28s |
| 2 | Integration suite | `DATABASE_URL=... DATABASE_MIGRATION_URL=... pnpm test:integration` | **PASS** | 3 files, 62 tests, 62 passed, 0 failed, 200.92s |
| 3 | Typecheck | `pnpm typecheck` | **PASS** | exit 0; root, `packages/contracts`, `apps/api`, `apps/web` all clean |
| 4 | Lint | `pnpm lint` | **PASS** | exit 0, no output |
| 5 | Build | `pnpm build` | **PASS** | exit 0; `apps/api` tsup `dist/main.js` 585.99 KB, `apps/web` next build 3 static routes |
| 6 | RLS gate | `pnpm --filter @shortkit/api db:check-policies` | **PASS** | exit 0, `ok tenants`, 1 table protected, 5 exemptions unevaluated (tables absent) |
| 7 | RLS gate in documented order | same, on a freshly migrated clean database | **PASS** | exit 0, same output; see "Migrations" |
| 8 | AC-115 compose stack | `./scripts/check-compose-stack.sh` | **PASS** | exit 0, **all 15 clauses PASS** |
| 9 | Migrations forward, clean DB | `db:migrate` against an empty database | **PASS** | 1 migration file, applied, `tenants` owned by `shortkit_migrator`, `rowsecurity=t`, 4 policies |
| 10 | Migration rollback | none exists | **FINDING** | see INT-001 |
| 11 | Startup / smoke | `GIT_COMMIT_SHA=$(git rev-parse HEAD) docker compose up -d --build --wait` | **PASS** | exit 0; api, web, postgres all healthy |
| 12 | `GET /health` on the composed API | `curl http://127.0.0.1:3001/health` | **PASS** | `HTTP=200`, body `{"status":"ok","commit":"fe05ed5f821164386eb7df1f562e9cd5e90087ba"}` |
| 13 | Two-stack coexistence (F-356) | dev stack up while the test stack runs | **PASS** | test container id and `RestartCount` unchanged; see below |
| 14 | Wrong-identity migration fails closed | migrate as the bootstrap superuser, then `up` | **PASS** | seed exits 1 on `permission denied for table tenants`; api never leaves `Created` |
| 15 | Contract drift, contracts to consumers | `node .github/scripts/assert-contract-drift.mjs` | **PASS** | exit 0, 2 mutations, each breaks exactly the consuming workspace |
| 16 | Inlined-secret guard (AC-113) | `BFF_PROXY_SECRET=<probe> pnpm --filter @shortkit/web assert:no-secrets` | **PASS** | exit 0, 54 files checked across `.next/static` (9) and `.next/server/app` (45) |
| 17 | Production dependency audit | `pnpm audit --prod --no-optional --audit-level moderate` | **PASS** | exit 0, `No known vulnerabilities found` |
| 18 | GC-8, unresolvable request is not 5xx | curl probes on the composed artifacts | **PASS** | see below |
| 19 | GC-4, no AI attribution | `git log --all` scan | **PASS** | 0 hits for `Co-Authored-By: Claude`, `Generated with Claude`, or the robot emoji, across all history |
| 20 | Coverage gate | `testing.coverage_gate` | **UNSET** | see "Coverage" |
| 21 | Backward compatibility | judged | **NOT APPLICABLE** | see "Backward compatibility" |

### 1. Unit suite

```
Test Files  18 passed (18)
     Tests  189 passed (189)
```

The pino error envelopes printed to stderr during `exception-filter.spec.ts` are the specs
asserting on their own log output, not failures.

### 2. Integration suite

```
Test Files  3 passed (3)
     Tests  62 passed (62)
  Duration  200.92s
```

`test/isolation/cross-tenant-isolation.int-spec.ts` (29), `test/tenancy/tenant-context.int-spec.ts`
(25), `test/security/security-headers.int-spec.ts` (8). Run against the standing test stack,
Compose project `shortkit`, port 55433.

**The isolation suite's own coverage boundary still applies and this run does not widen it.**
It passes over two tables, `tenants` and `rls_fixture_rows`, which is every table this
repository has, and enumerates ten repository-method surfaces with no routes and no
repositories, because none exist. Green here does not mean the system has no uncovered
cross-tenant surface. The suite prints that on every run and it is restated here rather
than dropped.

### 8. AC-115, fifteen clauses

`./scripts/check-compose-stack.sh` exited **0**. Exit 2 would have meant nothing was
measured; it did not occur.

```
AC-115.0 PASS  a compose file exists at the repository root and Compose can parse it
AC-115.1 PASS  the stack comes up from a clean state with one command
AC-115.2 PASS  Postgres reaches a healthy state
AC-115.3 PASS  the API reaches a healthy state
AC-115.4 PASS  the web app reaches a healthy state
GUARD-1  PASS  shortkit_app authenticates over TCP with the fixture password
GUARD-2  PASS  shortkit_app is refused over TCP with a wrong password
AC-115.5 PASS  the migrations have been applied: table public.tenants exists in database shortkit
AC-115.6 PASS  1 migration(s) recorded applied for 1 migration file(s)
AC-115.7 PASS  the demo tenant 00000000-0000-4000-8000-000000000001 is present and readable by shortkit_app
AC-115.8 PASS  GET /health returned 200
AC-115.9 PASS  the response body has status "ok"
DOD-1    PASS  a second `up` against the existing volume returned 0
DOD-2    PASS  tenants held 1 row(s) before and after the second up
DOD-3    PASS  tenants still holds 1 row(s) after 'docker compose restart'

AC-115: GREEN. Every clause passed.
```

The script's own teardown ran `docker compose down -v --rmi local --remove-orphans` against
project `shortkit-dev`. The standing test stack came through it untouched, which is check 13.

### 9. Migrations forward on a clean database

The standing test container had to survive, so this was not run by recreating it. A scratch
database was created inside the live container with the same ownership and default-privilege
setup the init script gives `shortkit_test`:

```
CREATE DATABASE shortkit_fwdcheck OWNER shortkit_migrator;
GRANT USAGE ON SCHEMA public TO shortkit_app;
ALTER DEFAULT PRIVILEGES FOR ROLE shortkit_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO shortkit_app;
ALTER DEFAULT PRIVILEGES FOR ROLE shortkit_migrator IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO shortkit_app;
```

`db:migrate` against it: `migrations applied successfully`, exit 0. Then `db:check-policies`
in the order `docs/architecture/migrations.md` says to run it, after migrate and before the
suite, exit 0. Catalog state read back as `shortkit_migrator`:

```
 Schema |  Name   | Type  |       Owner
 public | tenants | table | shortkit_migrator

 tablename |        policyname        |  cmd
 tenants   | tenants_privileged_erase | DELETE
 tenants   | tenants_self_insert      | INSERT
 tenants   | tenants_self_select      | SELECT
 tenants   | tenants_self_update      | UPDATE

 tablename | rowsecurity
 tenants   | t
```

`shortkit_fwdcheck` was dropped afterwards. AC-115.5 and AC-115.6 covered the same ground
independently, through `docker compose up` against an empty named volume.

The check on line 6 of this table was run after the integration suite, which
`migrations.md` warns leaves the database holding a fixture-built `tenants`. It passed, and
the clean-database run on line 7 is the one that carries the claim.

### 10. Rollback

**No down-migration mechanism exists in this repository. Stated explicitly because silence
here would be the wrong answer.**

- `apps/api/drizzle/` holds one file, `0000_odd_betty_ross.sql`, forward DDL only. It
  contains no down section and no `DROP`.
- `drizzle-kit`'s command list is `generate, migrate, introspect, push, studio, up, check,
  drop, export`. `drop` removes a migration file from the journal folder. It does not touch
  a database. There is no `down`.
- `docs/architecture/migrations.md` does not use the words rollback, down migration,
  revert or reversible anywhere. Neither does ADR-0004.
- The only documented way back to a previous schema state is destructive:
  `docker compose down -v` then `up`, or `docker compose -f docker-compose.test.yml down -v`
  then `up -d --wait` then `db:migrate`. Both discard all data.

ADR-0004 does not explicitly accept irreversibility. It accepts an adjacent cost, a
half-applied non-transactional migration, and says nothing about reversing a fully applied
one. Filed as INT-001 below. It is mitigated rather than resolved by ADR-0030: there is no
deploy target and no production database, so today the only thing a rollback would recover
is a developer's local volume.

### 11 and 12. Startup and smoke

Built and brought up with real provenance:

```
GIT_COMMIT_SHA="fe05ed5f821164386eb7df1f562e9cd5e90087ba" docker compose up -d --build --wait
```

exit 0. Container states and published ports:

```
shortkit-dev-api-1       api        Up (healthy)   127.0.0.1:3001->3001/tcp
shortkit-dev-postgres-1  postgres   Up (healthy)   127.0.0.1:55432->5432/tcp
shortkit-dev-web-1       web        Up (healthy)   127.0.0.1:3000->3000/tcp
```

`GET http://127.0.0.1:3001/health` returned `HTTP=200`,
`application/json; charset=utf-8`, body:

```json
{"status":"ok","commit":"fe05ed5f821164386eb7df1f562e9cd5e90087ba"}
```

That is the ADR-0027 and ADR-0037 seam holding across TASK-003 and TASK-059: the sha the
build was given is the sha `/health` reports, and it is not the forty-zero sentinel.
`GET http://127.0.0.1:3000/` returned `HTTP=200`.

`assertBootPreconditions()` had a reachable Postgres carrying NOBYPASSRLS roles throughout,
so F-116 had nothing to refuse and the api container went healthy. No boot failure occurred.

Security headers on the composed API response, read live rather than from the spec:
`Content-Security-Policy`, `Cross-Origin-Opener-Policy: same-origin`,
`Cross-Origin-Resource-Policy: same-origin`, `Referrer-Policy: no-referrer`,
`Strict-Transport-Security: max-age=31536000; includeSubDomains`,
`X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `X-XSS-Protection: 0`.

The stack was torn down with `docker compose down -v` afterwards.

### 13. The two stacks genuinely coexist (F-356)

The test container's identity was recorded before any compose work and re-read three times:
after the AC-115 script (which runs `down -v --rmi local --remove-orphans`), after the dev
stack came up alongside it, and after the final teardown.

```
Id=729b1105e4d7aad7c6bf0c7fa5c74c8fcfa91855da230efef013d68bedd48f13
RestartCount=0
StartedAt=2026-08-11T19:37:26  (unchanged across all four reads)
Health=healthy
```

With both stacks up at once:

```
NAME           STATUS         CONFIG FILES
shortkit       running(1)     docker-compose.test.yml
shortkit-dev   running(3)     docker-compose.yml
```

Ports 55433 and 55432 bound simultaneously. A query issued as `shortkit_app` against
`shortkit_test` returned `test-stack-alive` after the dev stack was up, and again after it
was torn down with `down -v`. The test container was neither recreated nor removed at any
point. F-356's property holds.

The mechanism is `name: shortkit-dev` at `docker-compose.yml:74`, and
`check-compose-stack.sh` additionally refuses to take over a project holding containers
from a foreign compose file rather than trusting the port separation.

### 14. Wrong-identity migration fails before the API starts

The claim under test is `docs/architecture/migrations.md`: the seed connects as
`shortkit_app` on purpose, so a stack migrated as any other identity fails there rather
than inside whatever feature first reads the table. Tested both entry points.

**Entry point A, the documented one.** Clean volume, `up` with the migrate service's
`DATABASE_MIGRATION_URL` overridden to the bootstrap superuser through an override file
outside the repository. Result:

```
service "seed" didn't complete successfully: exit 1
error: permission denied for table tenants
  severity: 'ERROR',  routine: 'aclcheck_error'

api    Created          <- never started
seed   Exited (1)
migrate Exited (0)
```

Exactly as documented, down to the error string. The API never started.

**Entry point B, a wrongly migrated database re-entered by a correct `up`.** Also fails
closed, one service earlier and with a different error:

```
service "migrate" didn't complete successfully: exit 1
ERROR: permission denied for schema drizzle

 tableowner | tablename
 postgres   | __drizzle_migrations
 postgres   | tenants
```

`api` stayed in `Created`. The guarantee holds in both directions. The doc describes only
entry point A; that is a documentation gap, not a defect, and it is filed as INT-003.

### 18. GC-8, no unresolvable request returns 5xx

Probed live against both composed deployables:

| Target | Path | Result |
|---|---|---|
| api | `/health` | `200` `{"status":"ok",...}` |
| api | `/api/nope` | `404` `{"code":"not_found","message":"The requested resource was not found."}` |
| api | `/nope` | `404` same envelope |
| api | `/api/bff/x` | `404` same envelope |
| web | `/` | `200` |
| web | `/nope` | `404` |
| web | `/api/bff/anything` | `404` |

No 5xx on any unresolvable path. The branded visitor 404 GC-8 names belongs to the redirect
path, which is deferred to the roadmap and has no code here; what is measurable today is
the error envelope, and it holds.

## What was skipped, and why

| Check | Why |
|---|---|
| End-to-end suite | **None exists.** No `playwright`, `@playwright/test` or `cypress` in the root manifest, in either app's manifest, in `packages/contracts` or in `pnpm-workspace.yaml`. There is no e2e layer to run, so this is absence rather than omission. |
| Coverage measurement | **No coverage tooling is installed and `testing.coverage_gate` is `null` in `.sdlc/config.yaml`.** Reporting the line rather than dropping it: the gate is unset, no threshold was ever chosen, and no coverage number appears anywhere in this report because none was produced. |
| `pnpm test:compose` under that name | The script was wired into `package.json` after the last measurement, as part of the in-flight F-390 fix. `./scripts/check-compose-stack.sh` was run directly and is the same code path. The new alias itself is unverified. |
| GC-1 (p99 at 500 RPS) and GC-2 (5-second destination propagation) | No implementing code in this initiative. Both constrain the redirect and cache paths, which left with EPIC-002 and later. Nothing to measure. |
| AC-7, the live Vercel deploy | TASK-004's acceptance, met on 2026-08-06 by a curl at 200 `text/html`. Outside this dispatch and not re-measured. |
| Fresh audit of the 88 open minors and nits | Not this step's job. They carry to the Ship triage as recorded. |
| CI executed on GitHub | The CI job steps were run locally, one by one, as the table above shows. The workflow itself was not triggered on a runner. |

## What only shows up in combination

Everything below passed its own TASK. These are the seams.

### The web deployable can reach nothing (already disclosed, confirmed live)

TASK-008 built `apps/web/src/lib/api/client.ts`. Every browser-side call it makes targets
the same-origin BFF proxy at `BFF_PATH_PREFIX = '/api/bff'`, and the client asserts that
prefix on every URL before it fetches. **That route does not exist.** `apps/web/app/api`
is not a directory; the whole of `apps/web/app` is `page.tsx` and `not-found.tsx`.

Measured: `GET http://127.0.0.1:3000/api/bff/anything` on the composed web container
returns `404`.

This is disclosed rather than hidden. `client.ts:577-581` says the proxy is
`app/api/bff/[...path]/route.ts`, that its owning work left with EPIC-002, and that no
card's `paths` cover `apps/web/app/api/bff/**`. `docker-compose.yml` repeats it: two green
containers are not evidence of a working frontend-to-backend path. Both of GC-7's
deployables boot and serve, and nothing connects them. Correct for a foundation, and it
means the compose stack's green is not a system-works signal. Filed as INT-002 so it is
routed rather than assumed known.

### AC-115's check is wired into nothing (confirms F-390, independently)

`grep -rn "check-compose-stack" .github/ package.json apps/` returned nothing at the
committed tree. AC-115 replaced AC-6's deploy clause and is the only evidence the substrate
runs as a system; a change to the Dockerfile, either compose file, the roles SQL, migrate
or seed breaks it with no gate firing. An implementer is fixing this now, in the dirty
`package.json` this report does not cover. Adding a script alias is not the same as adding
a CI job, and F-390's `required_change` asks for CI or a named manual cadence.

### The inlined-secret guard refuses to run without a value, and that is correct

`pnpm --filter @shortkit/web assert:no-secrets` with no `BFF_PROXY_SECRET` in the
environment exits 1 with:

```
FAIL: BFF_PROXY_SECRET is not set. This check searches the built output for this
variable's value; without a real value there is nothing to search for, and the check
would pass without having checked anything.
```

Not a defect. It is the fail-closed behaviour `ci.yml:119-130` is built around. Re-run with
a probe value it exits 0 over 54 files. Recorded because a reader running the CI steps by
hand will hit this and it looks like a break.

It also prints a live caveat worth carrying: no compiled read of
`NEXT_PUBLIC_API_BASE_URL` exists anywhere under `.next`, so the positive control is
inactive and this run does not prove build and check environments agree.

### Seams that held

- **`packages/contracts` to both consumers.** `assert-contract-drift.mjs` mutated
  `ERROR_CODES` and `FORM_ERROR_KEY` and each mutation broke the typecheck of exactly the
  workspace that consumes it, `apps/web` and `apps/api` respectively. ADR-0005's
  no-generated-client arrangement works in both directions.
- **TASK-060's lint rule across all three workspaces.** `pnpm lint` exits 0 at the root,
  and `logger-lint-rule.spec.ts` runs eslint in-process to prove the rule actually fails on
  a Nest `Logger` import. Rule and codebase agree.
- **TASK-003's `/health` and TASK-059's build provenance.** The composed API reported the
  sha the build was handed, not the sentinel.
- **TASK-007's error envelope through the composed artifact.** The `not_found` envelope
  came back from a real container, not from a Nest testing module.
- **Migration, seed and RLS as one chain.** `postgres -> migrate -> seed -> api` ordering
  held, the seed was idempotent across a second `up` (DOD-2), and the data survived
  `restart` (DOD-3).

## Backward compatibility

**Does not apply, and here is the reasoning rather than the assertion.**

Public contracts changed in this initiative: `packages/contracts` gained the error shapes
(TASK-007), and `apps/web`'s api client gained its surface (TASK-008). Neither has a
released consumer.

- `packages/contracts` is `"private": true`, version `0.0.0`, and is consumed only through
  `workspace:*` by `@shortkit/api` and `@shortkit/web` inside this repository. It is not
  published to any registry.
- Both apps are `"private": true` at `0.0.0`.
- ADR-0030 records that there is no deploy target. Nothing from this repository is running
  anywhere that an old client could be pointed at, with the single exception of TASK-004's
  Vercel page, which serves static HTML and calls no API.
- No git tag exists that marks a released version.

There is no old client and no coordinated deploy to sequence. The first initiative that
ships a consumer inherits this question.

## Global Constraints, checked

| GC | Verdict | Evidence |
|---|---|---|
| GC-3, infra under $25/month | Not measurable here | No deploy target exists (ADR-0030). Nothing is provisioned and nothing is billed. |
| GC-4, no AI attribution | **PASS** | `git log --all` scan for `Co-Authored-By: Claude`, `Generated with Claude` and the robot emoji: **0 hits** across all history. |
| GC-5, RLS transaction rule | **PASS** | 25 tenant-context integration tests and 29 isolation tests, plus `db:check-policies` on a clean migration. Bounded by the isolation suite's stated coverage boundary. |
| GC-7, one backend and one frontend deployable | **PASS** | `docker compose ps` shows `api` and `web` and no third service. `migrate` and `seed` are one-shots that exit. |
| GC-8, no 5xx to a visitor | **PASS** | Seven live probes above, all 200 or 404. |
| GC-9, pino, no PII in log bodies | **PASS** by suite | 54 logger and allowlist tests in the unit suite, including the field allowlist and the contract-drift specs. Not independently re-derived here. |
| GC-13, README stays current | **FAIL** | F-388, open blocker, filed by `sdlc-product-auditor` in Ship step 1. Inherited, not found here. A fix is in flight in the dirty tree. |
| GC-14, one focused sitting | Out of scope for integration | |

## Findings

Three new. Ids are `INT-nnn` to avoid colliding with `findings.yaml`, which another agent
is writing concurrently; whoever routes these should renumber into the F-series.

```yaml
- id: INT-001
  phase: ship
  task: null
  source: sdlc-integrator
  round: 1
  severity: major
  kind: design
  file: .sdlc/foundation/design/adr-0004-schema-layout-and-migrations.md
  line: 1
  summary: >-
    NO DOWN-MIGRATION MECHANISM EXISTS, AND NO ADR ACCEPTS ITS ABSENCE. drizzle-kit has no
    `down` command; its `drop` removes a file from the journal folder and never touches a
    database. The one migration file is forward DDL only. Neither ADR-0004 nor
    docs/architecture/migrations.md uses the words rollback, down migration, revert or
    reversible anywhere.
  failure_scenario: >-
    The only documented way back from an applied migration is `docker compose down -v`,
    which destroys the data. That is fine today because ADR-0030 means there is no
    production database to protect. It stops being fine on the first day one exists, and
    the decision to live without a rollback path will not have been made by anyone - it
    will have been inherited from a tool default that no ADR ever examined.
  required_change: >-
    Either ADR-0004 gains an explicit clause accepting forward-only migrations and naming
    what replaces rollback, or a down-migration convention is chosen before a deploy target
    is. This is a decision to record, not code to write today.
  owner_slot: sdlc-architect
  status: open

- id: INT-002
  phase: ship
  task: null
  source: sdlc-integrator
  round: 1
  severity: minor
  kind: behavior
  file: apps/web/src/lib/api/client.ts
  line: 246
  summary: >-
    THE TWO DEPLOYABLES BOOT GREEN AND NOTHING CONNECTS THEM. Every browser-side call
    apiClient() makes targets BFF_PATH_PREFIX = '/api/bff', asserted on every URL before
    the fetch. apps/web/app/api does not exist; apps/web/app is page.tsx and not-found.tsx.
    Measured live on the composed stack - GET http://127.0.0.1:3000/api/bff/anything
    returns 404.
  failure_scenario: >-
    A green `docker compose up` reads as "the system works" and it does not mean that. It
    means both halves boot. Filed as minor rather than major BECAUSE IT IS ALREADY
    DISCLOSED IN THREE PLACES - client.ts:577-581, docker-compose.yml's web service
    comment, and TASK-008's ledger note - and no screen calls the client today. It is filed
    at all so the gap is routed rather than remembered.
  required_change: >-
    No code. The roadmap entry that lands apps/web/app/api/bff/[...path]/route.ts names
    this integration as its acceptance, so the first initiative to wire the two deployables
    proves the path end to end rather than assuming it.
  owner_slot: sdlc-implementer-backend
  status: open

- id: INT-003
  phase: ship
  task: null
  source: sdlc-integrator
  round: 1
  severity: nit
  kind: docs
  file: docs/architecture/migrations.md
  line: 1
  summary: >-
    The wrong-identity guarantee is documented for one entry point of two. The doc says a
    stack migrated as any other identity fails at the seed with `permission denied for
    table tenants`. Measured true. But a database already migrated by the wrong identity,
    re-entered by a correct `up`, fails one service EARLIER, at `migrate`, with
    `permission denied for schema drizzle`.
  failure_scenario: >-
    Someone debugging a migrate-service failure searches the doc for the error they have,
    finds the seed's error instead, and concludes the two are unrelated. The guarantee
    itself holds in both cases: api never leaves `Created`.
  required_change: >-
    One sentence in the same section naming the second entry point and its error string.
  owner_slot: sdlc-implementer-backend
  status: open
```

### Inherited, not found here, and blocking

`F-388`, severity **blocker**, status **open**, owner `sdlc-implementer-backend`. The README
describes three subsystems in present tense that do not exist, and states the isolation
claim without the coverage boundary. GC-13 fails. Filed by `sdlc-product-auditor` in Ship
step 1. A fix is in flight in the dirty tree this report does not cover.

Also open and unrouted at ship: `F-386` (major, the third NODE_ENV trap, `ResendMailSender`
binds live under compose, fails silently rather than loudly), `F-390` (major, AC-115 wired
into nothing). Still escalated: `F-102` (TASK-040, deferred), `F-236` (TASK-054, deferred),
`F-239` (TASK-009, deferred). All three escalations belong to deferred TASKs and none of
them blocks this initiative, but ship.md rule 50 should be read against them explicitly
rather than around them.

Findings tally read from `findings.yaml` at `6a90d35`: 241 fixed, 88 open, 43 routed, 15
parked, 3 escalated, 1 routed-later.

## Machine state

Left as found. Verified after the last teardown:

```
NAME       STATUS       CONFIG FILES
shortkit   running(1)   docker-compose.test.yml

shortkit-postgres-1   Up 3 hours (healthy)   project=shortkit
Id=729b1105e4d7...  RestartCount=0  Health=healthy
select 'test-stack-alive' -> test-stack-alive
```

The `shortkit-dev` project holds no containers, no volume and no network. The scratch
database `shortkit_fwdcheck` was dropped. Nothing under `.sdlc/foundation/design/` was
written. The only files this dispatch created are in `.sdlc/foundation/ship/`.

## Verdict

**changes-requested.**

Every gate this dispatch could measure is green: 189 unit tests, 62 integration tests,
typecheck, lint, build, the RLS gate on a clean migration, all fifteen AC-115 clauses, the
smoke path, and the two-stack coexistence property. The system does work as a whole to the
extent that anything is wired together.

It is not clear to ship, for reasons that are decisions rather than breakage:

1. **F-388 is an open blocker.** GC-13 fails. A fix is in flight and unverified.
2. **INT-001, no rollback path, is undecided rather than accepted.** One line in ADR-0004
   closes it.
3. **F-390 leaves the only system-level check ungated.** A `package.json` alias is not CI.
4. Nothing in this report covers the dirty `README.md` and `package.json`. Re-run at least
   `pnpm lint`, `pnpm typecheck` and `./scripts/check-compose-stack.sh` after they commit.
