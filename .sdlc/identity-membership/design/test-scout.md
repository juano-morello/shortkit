# Test scout — identity-membership, waves 0-1 (TASK-001, TASK-002, TASK-018)

## Relevant files

`apps/api/vitest.config.ts:10` — unit tier, `include: ['src/**/*.spec.ts']`. Confirmed.
`apps/api/vitest.integration.config.ts:17,51` — integration tier, `include: ['**/*.int-spec.ts']` (glob `INTEGRATION_SPEC`), relative to `apps/api/`, so it also matches `test/**`.
`apps/api/vitest.integration.config.ts:27-45` — `assertEveryIntegrationSpecRuns()`, a module-scope self-check that throws (failing the whole command) if any file matches `/\.int[-.]spec\.ts$/` but not `/\.int-spec\.ts$/` — catches `foo.int.spec.ts` and similar near-misses.
`apps/api/vitest.integration.config.ts:70` — `fileParallelism: false`, with the F-134 rationale (shared DB, shared `rls_fixture_rows` table dropped/recreated per test).
`packages/contracts/vitest.config.ts:7` — unit tier, `include: ['src/**/*.spec.ts']`.
`apps/web/vitest.config.ts:10` — `include: ['app/**/*.spec.{ts,tsx}', 'src/**/*.spec.{ts,tsx}']`.
`vitest.config.ts:13` (root) — `projects: ['apps/api', 'apps/web', 'packages/contracts']`; root `pnpm test` = `vitest run` fans out to these three, none of which include integration.
`.sdlc/config.yaml:83-98` — `testing.unit: pnpm test`, `testing.integration: pnpm test:integration`, `coverage_gate: null` (deliberate, not an oversight).
`apps/api/test/support/rls-fixture.ts` — two-tenant RLS fixture, table `rls_fixture_rows`.
`apps/api/test/support/auth-fixture.ts` — `authServerEnv()`, Better Auth column-discovery helpers, request helpers.
`apps/api/test/support/api-server.ts` — spawns the built API (`dist/main.js`) as a child process; documents the `beforeAll`-kick/`beforeEach`-await pattern to avoid boot failures reading as "skipped" instead of "failed".
`apps/api/test/support/psql.ts` — `execSql`/`querySql`, process-spawn (or `docker run`) wrapper around `psql`.
`apps/api/test/isolation/coverage.ts` — the isolation harness's types, registry, drift check, report machinery. 1700+ lines.
`apps/api/test/isolation/coverage.ts:614-629` — `registerTenantScopedSurfaces()`.
`apps/api/test/isolation/coverage.ts:749-801` — `tenantScopedTableDrift()`, the registry-vs-database cross-check (five arms, F-303/F-333).
`apps/api/test/isolation/coverage.ts:1718-1722` — `CONTEXT_FLAG_OWNERS`, currently three rows, no importer anywhere in the repo (confirmed by repo-wide grep).
`apps/api/test/isolation/registrations.ts:591-592` — the two existing `registerTenantScopedSurfaces()` calls at module scope (`tenantsAccess`, `rlsFixtureRowsAccess`).
`apps/api/test/isolation/controls.ts:130` — `TENANT_ID = current_setting('app.tenant_id', true)::uuid`, the hand-written predicate used by every canary policy in this file. **No `nullif` wrapper** — this is the "old form" TASK-002 says needs reconciling with ADR-0049's production template.
`apps/api/test/isolation/cross-tenant-isolation.int-spec.ts:546-575` — the two `F-296` tests that assert `tenantScopedTableDrift()` and `judged().registryDrift` both equal `{ inDatabaseNotRegistered: [], registeredNotInDatabase: [] }`; a table registered without a matching DB row (or vice versa) fails these, not a thrown exception.
`apps/api/src/db/rls.ts:57-80` — `tenantScopedPolicies()`; lines 70-71 and 74-76 are the three raw (un-wrapped) `current_setting('app.tenant_id'/'app.privileged_erase', true)` predicates TASK-002 wraps in `nullif(...)`.
`apps/api/src/db/rls.ts:89-100` — `redirectReadPolicy()`, the fourth predicate; not shipped in any migration yet.
`apps/api/scripts/check-policies.mts` — current form: RLS-enabled/forced check + `EXEMPT` map (5 entries) cross-checked against `pg_attribute`. No `pg_policies` counting and no `has_table_privilege`/`has_any_column_privilege` yet — TASK-002 adds both.
`apps/api/src/observability/framework-400-request-body.spec.ts:12` — confirmed precedent: a `src/**/*.spec.ts` file importing from `../../test/support/response-object-probe.controller`.
`apps/api/src/observability/logging-opt-out.spec.ts:1,17-38` — an existing "scan the source tree" control, but built on the **TypeScript compiler's own parser**, not a grep, and its own docstring (lines 30-38) explicitly warns against grepping source text and cites `writing-good-tests.md`.
`apps/api/src/observability/logger-lint-rule.spec.ts:154-176` — `it('AC-116 (F-278): ...')` naming convention: AC id plus a finding id in parens.
`apps/api/test/tenancy/tenant-context.int-spec.ts:2,168-266` — file-header `STORY-003 — AC-8, AC-9, AC-10, AC-11.`; per-test `it('AC-9: ...')`.
`apps/api/src/common/errors/exception-filter.spec.ts:323-401` — repeated `it('AC-13: ...')` naming.
`.github/scripts/provision-test-database.sql:33-34,57,66` — `CREATE ROLE shortkit_migrator/shortkit_app ... NOBYPASSRLS;` and the two guards TASK-018 must widen (`rolname IN (...)` at :57, `<> 2` cardinality at :66).
`docker-compose.yml:320-321` and `docker-compose.test.yml:122-123` — the two inline `CREATE ROLE` blocks TASK-018 also edits (confirmed, matches the card).
`packages/contracts/src/roles.ts:90,118-125,150-156` — `asTenantRole`/`tenantRoleRank` currently throw `not implemented`; the brand-refusal rule TASK-001 must respect for `tenantMembershipContract`.

## How this area works

Three commands, three configs, no shared `include`:

- `pnpm test` (root) → `vitest.config.ts` fans out to the three workspace projects, each of which only collects `src/**/*.spec.ts` (api, contracts) or `app|src/**/*.spec.{ts,tsx}` (web). No Postgres, no Docker — this is what keeps `pnpm test` green from a clean clone.
- `pnpm test:integration` (root) → `pnpm --filter @shortkit/api test:integration` → `vitest run --config vitest.integration.config.ts` inside `apps/api`, collecting `**/*.int-spec.ts` anywhere under `apps/api` (so both `test/**` and, in principle, `src/**` if someone named a file that way — nothing in the repo does). This tier runs `fileParallelism: false` and needs `DATABASE_URL` + `DATABASE_MIGRATION_URL` against a migrated database (`docker-compose.test.yml` up, `db:migrate` run).
- The **isolation suite** is not a fourth tier — it is `apps/api/test/isolation/cross-tenant-isolation.int-spec.ts`, one `*.int-spec.ts` file collected by the same integration run. It reads a module-level `registry` (`coverage.ts:605`) populated by `registerTenantScopedSurfaces()` calls that run at **import time** from `registrations.ts` (lines 591-592 today). Coverage is judged by comparing every discovered/attempted surface against `registeredSubjects()`, and separately cross-checked against the live database schema via `tenantScopedTableDrift()` (five independent arms over `pg_class`/`pg_attribute`/`pg_policies`/`pg_constraint`, at `coverage.ts:749-801`). Both checks are ordinary `expect(...).toEqual(...)` assertions inside the `.int-spec.ts` file (`cross-tenant-isolation.int-spec.ts:546-575`), not a separate throw — a missing/extra registration fails those two `it()`s, not the whole run.

A file named like an integration spec but missing the exact `*.int-spec.ts` suffix does not silently vanish: `assertEveryIntegrationSpecRuns()` (`vitest.integration.config.ts:27-45`) walks the workspace at config-eval time and throws before any test runs, listing the mismatched file names. A file under `src/**` named `*.spec.ts` collects in the unit tier regardless of directory (e.g. the precedent at `framework-400-request-body.spec.ts`); a file under `test/**` named `*.spec.ts` (not `*.int-spec.ts`) collects in **neither** tier and passes by never running — this is exactly the trap TASK-002's card calls out for `context-flag-owners.spec.ts` and is why that file must live under `src/**`.

`CONTEXT_FLAG_OWNERS` (`coverage.ts:1718-1722`) is exported but has zero importers anywhere in the repository today (confirmed by grep) — TASK-002's new `context-flag-owners.spec.ts` will be its first consumer.

## Conventions to follow

- Test names carry the AC id, sometimes plus a finding id: `it('AC-13: answers a rejected request with ...')` (`exception-filter.spec.ts:323`), `it('AC-116 (F-278): lint fails on the Nest Logger import at ...')` (`logger-lint-rule.spec.ts:154`), `it("AC-8: a read inside tenant A's transaction returns A's row and not B's", ...)` (`tenant-context.int-spec.ts:168`). File headers restate the covered ACs and the STORY: `tenant-context.int-spec.ts:2` — `STORY-003 — AC-8, AC-9, AC-10, AC-11.`
- Isolation-harness tests reference the finding id alone when the test is a control rather than an AC assertion: `it('F-296: the registry and the database agree ...')` (`cross-tenant-isolation.int-spec.ts:546`).
- `test/support/**` and `test/isolation/**` (existing files) carry an explicit ownership banner: "⚠ THIS FILE IS sdlc-test-architect'S ... appears in no TASK's paths and belongs to it under routing rule 0" (`rls-fixture.ts:20-22`, `auth-fixture.ts:5-7`, `api-server.ts:5-7`). TASK-018 is the one card in this scope whose `paths` explicitly *does* include two of these support files (`rls-fixture.ts`, `auth-fixture.ts`) — a documented, deliberate exception, not a violation of the banner.
- Scanning the source tree for a structural property is done via the TypeScript compiler API (`logging-opt-out.spec.ts:34`), not text grep, per that file's own citation of `writing-good-tests.md` ("the answer here is not to assert on the text but to derive a structural property of the module graph"). ADR-0045's control (TASK-002's `context-flag-owners.spec.ts`) is specified as a **grep** over `set_config(` first arguments — see Gotchas.
- Every environment variable an integration fixture needs is declared and documented at the point that needs it, with a remedy message in the thrown error (`rls-fixture.ts:106-118`, `auth-fixture.ts:101-113`) — not silently defaulted.
- Catalogue reads use `pg_attribute`/`pg_class`/`pg_policies`/`pg_constraint`, never `information_schema`, because `information_schema` is privilege-filtered and a role with no grant on a table sees zero rows, which reads identically to "column absent" (F-213, documented at `check-policies.mts:104-123`, `auth-fixture.ts:27-30`). Any new catalogue-reading control (the two TASK-002 adds) should follow this.
- `Map`, not object literal, for any exemption/allow-list keyed by identifier strings, per F-146 at `check-policies.mts:39-43` (prototype pollution via `constructor`/`toString`/etc.).

## Existing tests

Framework: Vitest 3 everywhere (ADR-0001). Unit specs use `unplugin-swc` (api) for decorator metadata; contracts and web use their own transforms.

- Unit: `packages/contracts/src/roles.spec.ts` does not yet exist (TASK-001 creates it, per `test_files`); pattern to follow is `apps/api/src/**/*.spec.ts` co-located with source.
- Integration: `apps/api/test/tenancy/tenant-context.int-spec.ts` (existing, not edited by any of these three TASKs) is the reference implementation for `startApiServer`'s `beforeAll`-kick/`beforeEach`-await pattern (documented at `api-server.ts:60-83`) and for AC-id-per-`it()` naming.
- Isolation: `apps/api/test/isolation/cross-tenant-isolation.int-spec.ts` (72KB) is the one file; `registrations.ts`, `coverage.ts`, `controls.ts` supply fixtures/predicates/registry it consumes. `leak-canary.ts` and `report.json` (a generated artifact, not source) also live in `test/isolation/`.
- Fixture helpers are function-based, not class/factory-based: `createRlsFixture()`/`dropRlsFixture()` (`rls-fixture.ts:339,370`), `clearAuthTables()` (`auth-fixture.ts:357`) — called explicitly from `beforeEach`/`afterEach` in consuming specs, not auto-wired.
- Integration tests get their DB via two roles: `DATABASE_URL` (`shortkit_app`, the runtime/RLS-subject role) and `DATABASE_MIGRATION_URL` (`shortkit_migrator`, owns the schema, runs DDL/seed/erase). `appDsn()`/`migrationDsn()` at `rls-fixture.ts:121-128` are the single read point for both; `auth-fixture.ts:101-113` reads `DATABASE_URL` independently for the spawned API child's env.
- `authServerEnv(baseUrl)` (`auth-fixture.ts:79-93`) **today** returns `NODE_ENV`, `DATABASE_URL`, `GIT_COMMIT_SHA`, `BETTER_AUTH_URL`, `BETTER_AUTH_SECRET` (a 55-character fixture string, well above the >32-char floor ADR-0051 states), and `BFF_PROXY_SECRET`. It does **not** currently return `DATABASE_AUTH_URL` — confirmed absent — matching TASK-018's stated addition.

## Prior art

- Catalogue-assertion control: `apps/api/scripts/check-policies.mts` is the direct ancestor of TASK-002's two new `check-policies.mts` assertions (pg_policies counting, grant-matrix). It is a plain Node script (`.mts`, type-stripped, no decorators/enums/namespaces allowed) run by `pnpm db:check-policies`, not a vitest spec, and CI's `integration` job runs it.
- `src/**` spec importing `test/**`: `apps/api/src/observability/framework-400-request-body.spec.ts:12` — `import { RESPONSE_OBJECT_ONLY_MARKER } from '../../test/support/response-object-probe.controller';`. Confirmed real and exactly the shape `context-flag-owners.spec.ts` would need to reach `test/isolation/coverage`.
- Source-tree scanning for a security/logging property: `logging-opt-out.spec.ts` — AST-based (TypeScript compiler API), enumerates `apps/api/src/**/*.ts` excluding `*.spec.ts`, with one named exemption and an explicit self-test that the derivation can distinguish a violating module from a clean one (`beforeAll` controls). No existing test in this repo does a literal text grep over `apps/api/src` — this is a genuine gap, not something I am inferring a pattern for.
- Role/grant provisioning: `.github/scripts/provision-test-database.sql` and the two inline Compose blocks are the three existing sites TASK-018 extends; all three currently express the *same two-role* model in slightly different SQL dialects (`:` bind variables in Compose, literal passwords in the CI script).

## Gotchas

- **Tension, not contradiction, worth flagging to the architect**: TASK-002 specifies `context-flag-owners.spec.ts` as a **grep** over `set_config(` first arguments in `apps/api/src`. The one existing precedent for scanning source in this repo (`logging-opt-out.spec.ts`) explicitly avoided grepping text in favor of AST parsing, citing `writing-good-tests.md`'s warning against exactly that pattern. TASK-002's card is explicit about the grep approach and gives a reason (matching `set_config(` calls, not full syntactic analysis), so this may be a deliberate, narrower case — but it is the one place in this codebase where the new test departs from established practice, and it's worth the test architect naming that departure rather than silently reproducing it.
- `fileParallelism: false` (`vitest.integration.config.ts:70`) means every `.int-spec.ts` file runs sequentially, sharing one database and one `rls_fixture_rows` table that is dropped/recreated per test. A new integration file (TASK-002's `tenant-memberships.int-spec.ts`, `warm-connection-no-context.int-spec.ts`) adds wall-clock serially, not in parallel with existing ones.
- `registerTenantScopedSurfaces()` runs at **module import time**, not inside a test hook, and throws on a duplicate `subject` name (`coverage.ts:614-619`). Two TASKs both trying to register the same table/subject would fail at collection, not at assertion.
- `startApiServer` must be kicked in `beforeAll` and *awaited again* in `beforeEach` (not solely awaited in `beforeAll`) or a boot failure reports as "skipped" rather than "failed" under this pinned Vitest — documented at length in `api-server.ts:48-83`, with `credential-auth.int-spec.ts` as the reference.
- Better Auth column names (`emailVerified` vs `email_verified`) are discovered from `pg_attribute` at runtime (`auth-fixture.ts:217-237`), not hard-coded — a test that spells a column name would break silently once `auth.ts`'s schema is generated by TASK-002.
- The `tenants` table's DELETE path requires **both** `app.privileged_erase` and `app.tenant_id` set — setting only the first returns `DELETE 0` with no error, because any column reference (including in a `WHERE`) pulls the `FOR SELECT` policies back in (`rls-fixture.ts:174-195`, measured, not reasoned). Any new fixture/control touching `tenants` should know this.
- `EXPECTED_SURFACE_IDS`, `SUITE_OWNED_CONTROL_TABLES` (`coverage.ts:655-678`) and similar closed lists inside the isolation harness must be updated in the same commit as anything that adds a canary table or registered surface — an omission here has previously produced a false-positive `fail` verdict (F-346, documented in the surrounding comment) rather than a false pass, but it is still a silent trap for anyone adding a new control table without reading the harness closely.
- `CONTEXT_FLAG_OWNERS` is a documented **subset** check, not equality (per TASK-002's card, F-039) — it already carries two rows (`redirect-read.ts`, `privileged-eraser.ts`) for files that do not exist yet, deferred to later TASKs. An equality assertion here would be red on arrival.

## What I could not determine

- Whether `apps/api/src/db/context-flag-owners.spec.ts` or `apps/api/test/tenancy/warm-connection-no-context.int-spec.ts` exist yet — neither does (both are TASK-002 deliverables per its `test_files`), confirmed by directory listing; not a gap, just noting I checked rather than assumed.
- The exact grant-matrix SQL TASK-002 will add to `check-policies.mts` — I read only the current (pre-TASK-002) file; the new assertions are specified in the TASK card's prose, not yet in code, so I cannot cite line numbers for code that does not exist.
- Whether CI's `integration` job (`.github/workflows/ci.yml`) already runs `db:check-policies` after the wave-0/1 changes land — I did not read `ci.yml` in this pass; TASK-018's own card asserts the ordering is load-bearing but I have not independently confirmed the current job steps.
- I did not read ADR-0044, ADR-0049, ADR-0050 or ADR-0051 in full — my citations of "nullif wrapper", "role split", "three-role model" are drawn from the TASK cards' own quotations of them, not from reading the ADR files directly. The test architect should read those ADRs directly for the design rationale; this report only grounds where the *tests* currently stand.
