# `foundation`: a multi-tenant substrate with isolation enforced by Postgres

**Corrected 2026-08-12.** This file opened by stating there was no pull request. There is
one, and this is its body. The sequence is worth recording because it is the same defect
this initiative spent a week filing against other documents: a direct push to `main` was
rejected by branch protection requiring the `gate` check, and the orchestrator had earlier
priced the branch alternative as "rewrites published history" — which was false.
`origin/main` is 248 commits behind and a strict ancestor of this branch, so pushing a ref
moves no sha and rewrites nothing. The expensive option did not exist; the cheap one did,
and it is the one `phases/ship.md` and GC-10 both wanted.

| | |
|---|---|
| Initiative | `foundation` (re-scoped from `launch-core` on 2026-08-09) |
| Branch | `feat/foundation` into `main` |
| Base | `cee06e4`, a strict ancestor — no history rewritten |
| Deploy target | none, by decision (ADR-0030) |
| First CI run | **this PR.** `quality`, `integration` and `compose` have never executed on a runner |

| | |
|---|---|
| Initiative | `foundation` (re-scoped from `launch-core` on 2026-08-09) |
| Range | `be8f9e2` (2026-08-03) to `4a5ab8a` (2026-08-11) |
| Commits | 257 |
| Deploy target | none, by decision (ADR-0030) |

## What

A multi-tenant substrate with tenant isolation enforced by Postgres, a shared contracts
package both deployables read, structured logging that cannot leak a field by accident, a
local Docker Compose stack that comes up with one command, and a three-job CI gate.

Concretely: one migrated table (`tenants`), one route (`GET /health`), one static page, and
the machinery around them. Ten TASKs across four STORIEs.

## Why

`refinement.md`'s problem statement asks for a repository that proves tenant isolation
instead of asserting it. Isolation is the claim an agency buys, and a demo that asserts it
in a README is worth nothing to the person evaluating whether the author can be trusted with
their clients' data.

The initiative delivers the mechanism for that claim and does not deliver the claim itself.
`sdlc-product-auditor` ruled SC-1 **not yet measurable** rather than met or partly met, and
the reason is exact: SC-1 quantifies over "every repository method and every authenticated
endpoint", and there are zero of each. Five of the twenty live acceptance criteria answer to
a success criterion. The other fifteen answer to EPIC-001's outcome sentence, "a deployable,
CI-gated monorepo whose data layer cannot be read across tenants." That sentence is the
instrument for this initiative. An SC scoreboard is the wrong one.

The re-scope is the other half of the why. `launch-core` had grown to 6 EPICs and 58 TASKs
with nothing shipped, at a 9:1 artifact-to-code ratio. On 2026-08-09 it became EPIC-001
alone, and the other five EPICs became five named entries in `.sdlc/roadmap.md` with no ids,
no acceptance criteria and no design. Each becomes its own initiative when the one before it
ships.

## Scope

**EPIC-001**, Foundation and tenancy substrate.

| STORY | Title | TASKs | ACs |
|---|---|---|---|
| STORY-001 | Monorepo scaffold and quality gates | TASK-001 | AC-1, AC-2, AC-3, AC-4, AC-107 |
| STORY-002 | Deployable skeleton with CI | TASK-002, TASK-003, TASK-004, TASK-059, TASK-060 | AC-5, AC-6, AC-7, AC-113, AC-114, AC-115, AC-116 |
| STORY-003 | Tenant-scoped persistence with row-level security | TASK-005, TASK-006 | AC-8, AC-9, AC-10, AC-11, AC-12 |
| STORY-004 | Shared contracts and a uniform error surface | TASK-007, TASK-008 | AC-13, AC-14, AC-15 |

Ten TASKs, all `status: done`. TASK-059 and TASK-060 were minted on 2026-08-11 under
Amendments A-8 and A-9: A-8 narrowed AC-6 after ADR-0030 deleted the Fly artifacts and
minted AC-115 for the compose stack, A-9 minted AC-116 for the logging opt-out class after
F-278 established that the three Nest `Logger` sites were a class rather than one line.

**Deferred, not cancelled.** TASK-009 through TASK-058 left the initiative in the re-scope
and keep their ids, because those ids appear in commit subjects. Sixteen findings are owned
by deferred TASKs and stay in `findings.yaml`, parked.

## Design decisions

Forty-two ADRs. Twenty-nine govern code in this release.

| ADR | Decision |
|---|---|
| ADR-0001 | Vitest across all three workspaces, integration tests on a separate command |
| ADR-0002 | Bind tenant context with AsyncLocalStorage, an interceptor, and an accessor that throws |
| ADR-0003 | Two database roles, forced RLS, and exactly two named context escapes |
| ADR-0004 | One schema file per table, glob-driven migration generation, migrations rebased rather than merged |
| ADR-0005 | The web app imports the zod contracts directly; no generated client |
| ADR-0006 | One deployable serving three URL surfaces, split by an `/api` prefix |
| ADR-0019 | Enumerate tenant-scoped tables from the Drizzle schema, cross-checked against `information_schema` |
| ADR-0020 | Discover routes and repository methods through NestJS `DiscoveryService`, with a naming-convention backstop |
| ADR-0022 | Redaction by allowlist, CORS off, helmet on |
| ADR-0023 | Role types are nominally branded, so no bare literal is assignable to either |
| ADR-0024 | A domain error carries its own `ErrorCode`, and everything else is a 500 |
| ADR-0025 | The contracts package recognises and flattens its own `ZodError`s |
| ADR-0026 | The exception filter emits only text and shapes it chose itself |
| ADR-0027 | The deployed commit SHA reaches `/health` as a build argument, and its absence refuses the deploy |
| ADR-0028 | A log field reaches the line only if it is named |
| ADR-0029 | A credential is never constructible into an error string |
| ADR-0030 | No deploy target is chosen for the API, and the repository stops implying one |
| ADR-0031 | The compose stack transcribes the roles contract rather than sharing SQL with the test stack; its credentials are fixtures bound to loopback |
| ADR-0032 | Postgres data lives in a named volume, the stack takes its own compose project name, and `down -v` is the only reset |
| ADR-0033 | Migrations and seed run as two one-shot compose services from a non-deployable image stage, each as its own role |
| ADR-0034 | The seed is a list of idempotent per-table units that reports what it does not cover |
| ADR-0035 | The web app gets its own multi-stage image, depends on nothing, and cannot reach the API from the browser |
| ADR-0036 | Every service probes what it promises; the Postgres probe connects over the compose network so that it authenticates; the API's start period is coupled to its boot budget |
| ADR-0037 | The compose build defaults `GIT_COMMIT_SHA` to the git null SHA, which narrows ADR-0027 for images that cannot reach traffic |
| ADR-0038 | Anything that is not GET or HEAD is a mutating method |
| ADR-0039 | Design stubs die at the design gate |
| ADR-0040 | The trusted client address is a declared property of the deployment, and it may be absent |
| ADR-0041 | "Or any other logger" is gated at the dependency list, and the import site fences the packages we have |
| ADR-0042 | The API source tree means `apps/api/src`; the `no-console` rule follows the source tree and the logger rule follows the package |

Thirteen more were written here and govern deferred increments: ADR-0007 (short-code
generation), ADR-0008 (redirect cache shape), ADR-0009 (expiry eviction), ADR-0010 (click
event write path), ADR-0011 (branding port), ADR-0012 (Redis client and rate-limit
degradation), ADR-0013 (Better Auth in NestJS), ADR-0014 (web session handling), ADR-0015
(user-tenant cardinality), ADR-0016 (domain provisioning), ADR-0017 (email provider),
ADR-0018 (CI performance gate), ADR-0021 (tenant-routing capability tokens).

## Testing

Measured on 2026-08-11 by `sdlc-integrator` against the committed tree. Source, infra and
docs were last touched at `6916a24`; the checks marked re-run were repeated at `4a5ab8a`
after the two Ship blockers closed.

| Check | Result |
|---|---|
| `pnpm test` | 18 files, **189/189** passed. Re-run at `4a5ab8a`: 189/189 |
| `pnpm test:integration` | 3 files, **62/62** passed, 200.92s, against a real Postgres |
| `pnpm typecheck` | exit 0, all four projects. Re-run at `4a5ab8a`: exit 0 |
| `pnpm lint` | exit 0. Re-run at `4a5ab8a`: exit 0 |
| `pnpm build` | exit 0, `apps/api` `dist/main.js` 585.99 KB, `apps/web` 3 static routes. Re-run at `4a5ab8a`: exit 0 |
| `pnpm --filter @shortkit/api db:check-policies` | exit 0, on a freshly migrated clean database and in the documented order |
| `./scripts/check-compose-stack.sh` | exit 0, **fifteen of fifteen clauses PASS**. Re-run at `4a5ab8a`: exit 0 |
| `node .github/scripts/assert-contract-drift.mjs` | exit 0, two mutations, each breaks exactly the consuming workspace |
| `pnpm --filter @shortkit/web assert:no-secrets` | exit 0 over 54 files, with `BFF_PROXY_SECRET` set |
| `pnpm audit --prod --no-optional --audit-level moderate` | exit 0, `No known vulnerabilities found` |
| Startup smoke | `docker compose up -d --build --wait` exit 0; `GET /health` returned `200` and `{"status":"ok","commit":"fe05ed5f821164386eb7df1f562e9cd5e90087ba"}` |

**Coverage is unmeasured.** `testing.coverage_gate` is `null` in `.sdlc/config.yaml`, no
coverage tooling is installed, and no threshold was ever chosen. No coverage number appears
in this release note because none was produced.

### Deliberately not automated

- **The isolation suite's boundary.** It covers two tables, `tenants` and a fixture table it
  builds from the production policy builder, and no routes and no repositories, because
  none exist. A green run proves the mechanism. It does not prove the system has no
  uncovered cross-tenant surface. The suite prints this on every run and writes it into
  `report.json`.
- **AC-7, the Vercel page.** Verified by curl on 2026-08-06 at 200 `text/html`. No automated
  check watches it.
- **GC-1 and GC-2**, the p99 latency ceiling and the five-second destination propagation.
  Both constrain the redirect and cache paths, which are on the roadmap. There is no code to
  measure.
- **No end-to-end layer exists.** No Playwright and no Cypress in any manifest. The absence
  is a scope decision, not a gap in this run.

### Cross-TASK checks, which is what per-TASK green does not cover

Two compose stacks coexist without destroying each other. The integration suite's container
was watched across an AC-115 run that executes
`docker compose down -v --rmi local --remove-orphans` on the neighbouring project, and
across the dev stack coming up beside it. Container id and `RestartCount=0` unchanged
throughout. Project names separate the stacks; ports do not.

Migrating as the wrong identity fails before the API starts, in both directions.
Migrate as the bootstrap superuser and the seed exits 1 on
`permission denied for table tenants`. Re-enter an already wrongly-migrated database with a
correct `up` and the migrate service exits 1 on `permission denied for schema drizzle`. In
both cases the `api` container never leaves `Created`.

## Migrations

One migration, `apps/api/drizzle/0000_odd_betty_ross.sql`. It creates `tenants` and applies
the four-statement RLS policy block.

**Forward, verified on a clean database.** `db:migrate` against an empty database exits 0,
and the catalog reads back `tenants` owned by `shortkit_migrator` with `rowsecurity = t` and
four policies (`tenants_self_select`, `tenants_self_insert`, `tenants_self_update`,
`tenants_privileged_erase`). `db:check-policies` then exits 0 in the order
`docs/architecture/migrations.md` specifies, after migrate and before the suite. AC-115.5
and AC-115.6 cover the same ground independently through `docker compose up` against an
empty volume.

**Ordering with deploy: none applies.** There is no deploy target. The one place migrations
run outside a developer's shell is `docker compose up`, where a one-shot `migrate` service
runs as `shortkit_migrator` between a healthy Postgres and the seed. Migrations never run
from application boot, so concurrent processes cannot race, and they never run from
`/docker-entrypoint-initdb.d`, which would leave every table owned by the bootstrap
superuser with `shortkit_app` granted nothing.

**One trap worth knowing.** The migrator compares timestamps, not contents. Editing a
migration that has already been applied does nothing and reports success. A change to an
applied migration needs a new migration.

## Rollback plan

**Revert the commit and migrate forward. There are no down-migrations.** Juano ruled this on
2026-08-11 under F-392, and ADR-0004 and `docs/architecture/migrations.md` carry it.

The posture holds on two conditions: the schema stays additive-only, and no production
database exists. It gets revisited when either stops being true. Do not read it as a claim
that rollback is unnecessary in general.

What that means in practice, per surface:

- **Schema.** `drizzle-kit` has no `down` command. Its `drop` removes a file from the journal
  folder and never touches a database. Going back means reverting the code and writing a new
  forward migration that undoes the change.
- **Local data.** `docker compose down -v` destroys the volume and starts clean. `down`
  without `-v` keeps the data. There is no weaker reset.
- **Application code.** `git revert`. No feature flag exists and nothing is behind one.
- **Deploy.** Nothing to roll back. No deploy target exists (ADR-0030), and the only running
  artifact anywhere is the static Vercel page from TASK-004, which serves HTML and calls no
  API.

## Risk

| Risk | How it shows up | Standing |
|---|---|---|
| **The isolation claim is read wider than it was measured.** The suite covers two tables and no request path. | Someone quotes "isolation is tested" for a surface that was never attempted. A cross-tenant leak ships in the first initiative that adds a repository. | Mitigated, not closed. The suite prints its boundary on every run, writes it into `report.json`, and the README now closes its isolation bullet with the same sentence. Roadmap item 4 owns widening it. |
| **A new table ships with no policies.** Grants come from `ALTER DEFAULT PRIVILEGES` and already exist, so the feature's own queries work and its tests pass. | Every tenant can read the table. Nothing in the build says so except the gate. | `db:check-policies` runs in CI's `integration` job, and the isolation suite's drift check names a tenant-scoped table nobody registered. Both have to be removed for this to land silently. |
| **Forward-only migrations meet a destructive change.** | A migration drops or rewrites a column, and the only way back is `down -v`, which destroys data. | Accepted while the schema is additive-only and no production database exists (F-392). The condition is written into ADR-0004 so the next person hits the ruling rather than the tool default. |
| **`NODE_ENV`-gated behaviour under compose.** `Dockerfile:83` sets `NODE_ENV=production`, so anything keyed on it behaves as production in a local stack. Two boot assertions were repaired to gate on a declared property instead (F-380, F-385). | F-386 is the open one: `mail-sender.md` binds the live Resend sender under the same condition. It does not refuse to boot. It waits, and sends real email to a real address the first time anyone invites someone from a laptop. | Not reachable today. Mail is unwritten and the provider work is deferred. F-386 is open and unruled, carried on the roadmap to whichever increment writes mail. |
| **Two green containers read as a working system.** | An evaluator runs `docker compose up`, sees three healthy services, and assumes the frontend talks to the backend. It does not: the BFF proxy route does not exist and answers 404. | Disclosed in three places (the web client, the compose file's web service, the README) and filed as INT-002 so the first initiative to wire the two deployables proves the path rather than assuming it. |
| **The compose check only just became a gate.** It was measured once, by hand, before `4a5ab8a`. | A change to the Dockerfile, either compose file, the roles SQL, migrate or seed breaks it and the next person to find out is the next person to clone. | Closed. `compose` is now a job in CI's `needs: [quality, integration, compose]`, plus `pnpm test:compose`. The first CI run is the one that proves the job works on a runner; nobody has watched it go green there yet. |

## Author

Juano is the sole author of record.
