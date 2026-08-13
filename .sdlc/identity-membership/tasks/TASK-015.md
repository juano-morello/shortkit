---
id: TASK-015
story: STORY-005
epic: EPIC-001
title: One negative control per shipped endpoint, and the report's coverage boundary
status: todo
owner_slot: sdlc-implementer-backend
depends_on: [TASK-011, TASK-014]
paths: ["apps/api/test/isolation/registrations.ts", "apps/api/test/isolation/controls.ts", "apps/api/test/isolation/cross-tenant-isolation.int-spec.ts", "apps/api/test/isolation/coverage.ts"]
contracts: [design/contracts/isolation-coverage.md]
test_files: ["apps/api/test/isolation/cross-tenant-isolation.int-spec.ts (isolation tier)"]
acceptance: [AC-30, AC-31, AC-32]
rework_count: 0
---

## Intent

Register every shipped authenticated endpoint as an attacked surface, prove the harness would
notice if one leaked, and state in the report exactly what this run covered.

## Approach

**Register the endpoints.** Every authenticated route this initiative ships gets a
registration using TASK-014's `endpointAccess`, attempted in both directions. That is the
SC-4 clause "one negative control per endpoint, **in the isolation harness rather than in a
controller test**" — a controller test proves the controller does what its author expected,
and this proves the database refuses what the controller was never asked about.

**Prove the harness would notice.** Nine controls already ship, each named for a way an audit
measured this harness reporting `pass` over a database that was not isolated, plus four
probes for unregistered tables and — since r4 — **one positive control**: a correctly
isolated table carrying a `WITH CHECK` stricter than its `USING`, which is what an ordinary
business predicate produces and which r3's `unverified` rule wrongly turned red. A check that
goes red on correct code is the check that gets deleted rather than fixed, so the shape a
correct table **cannot** be reported as is measured on every run alongside the shapes a
leaking table must be.

This TASK adds the endpoint-level equivalent (AC-31): a control table shaped exactly like
`workspaces` but with `ENABLE ROW LEVEL SECURITY` omitted — the exact defect
`scripts/check-policies.mts` exists to catch — reached through a control endpoint, with
**every** attempt over it required to report `fail`. A harness that could not see a leak
would report that endpoint clean.

**Controls are never registered.** `leakCanaryAccess` and the six r2 controls are exported as
values the suite passes to `runCrossTenantAttempts()` directly, and the registry has **no
notion of a subject allowed to leak**. That is structural, not conventional: there is no field
a future TASK can set to mark a real table as expected-to-leak and have the suite wave it
through. The endpoint control follows the same rule.

**`tenant_memberships` is registered by TASK-002 and asserted here** (AC-32). Its attempts run
in both directions and every one must report `pass`. Its owner column is `tenant_id`; it is a
template-shaped table, not a cascade root like `tenants`.

**The coverage boundary is reproduced verbatim into `report.json` so the artifact SC-1 points
at is not read as stronger than it is.** `COVERAGE_BOUNDARY` today says the run covers two
tables, `tenants` and `rls_fixture_rows`, that no routes and no repositories are enumerated
because none exist, and that route and repository discovery is TASK-056's. **Every one of
those clauses is now partly false and the string must be rewritten** — the run covers four
tables and a registered set of endpoints, repositories exist, and discovery is still
unimplemented. The honest form says which endpoints were attacked, that the set was
**registered by hand rather than discovered**, and that a route nobody registered is a route
nobody attacked.

**What this run still does not prove**, and the boundary string should say so:

- five statement shapes F-341 names are not built — `INSERT ... ON CONFLICT DO UPDATE`,
  `MERGE`, eviction (`UPDATE <t> SET <owner> = <a tenant the fixture never seeds>`),
  cascade and trigger effects on a sibling table, and `SELECT ... FOR UPDATE`;
- coverage is bounded by the shapes someone thought of, which is Juano's 2026-08-11 ruling,
  and this initiative adds a whole new attempt category to that bound;
- `ISOLATION_EXCLUSIONS` still carries two entries for surfaces that do not exist —
  `RedirectReadRepository.resolveByHostAndSlug` and `PrivilegedTenantEraser.erase`. **The
  length of that list is the control**: a third entry has to arrive as a visible one-line
  diff. Do not add to it, and do not remove from it.

**Do not add a `declinedShapes` mechanism.** r3 added one with three independent guard rails
and its first and only use was wrong: `tenants` declined the owner-column write on a premise
that measurement contradicted, which removed one of the table's two live unqualified write
attempts while the published artifact carried the false reason as a fact. A table that cannot
express a shape as written **changes the statement**; a table that genuinely cannot answer
goes `unverified` and red.

## Out of scope for this TASK

The HTTP attempt mechanism itself (TASK-014). The `tenant_memberships` and `workspaces`
registrations, which land in the same commits as their tables (TASK-002, TASK-011) — this
TASK asserts them and does not create them. Any `apps/api/src` file. Route and repository
discovery (TASK-056, deferred). Generative mutation of the policy set (roadmap item 4).
Building any of F-341's five shapes.

## Interfaces

**Consumes**

From TASK-014:
- `endpointAccess(spec): TenantScopedSurfaceRegistration`
- `interface EndpointAttemptSpec { method: HttpMethod; route: string; qualification: 'owner-qualified' | 'unqualified'; ... }`
- `signedInTenants(): Promise<{ a: SignedInTenant; b: SignedInTenant }>`
- `interface SignedInTenant { tenantId: string; userId: string; email: string; bearerToken: string; cookie: string }`

From TASK-011: the `WorkspaceRepository` registration and the `workspaces` table.
From TASK-002: the `TenantMembershipsTableAccess` registration and the `tenant_memberships` table.
From TASK-012: the four authenticated workspace routes and their exact paths.

From `apps/api/test/isolation/` (shipped):
- `registerTenantScopedSurfaces(...)`, `registeredSubjects(): TenantScopedSurfaceRegistration[]`
- `tableAccess({...})`, `controlAccess(subject, table, reset, ...)`
- `leakCanaryAccess`, `directionCanaryAccess`, `baselineLeakCanaryAccess`,
  `grantGapCanaryAccess`, `maskedRefusalCanaryAccess`, `halfSeededCanaryAccess`,
  `unqualifiedWriteCanaryAccess`, `ownerTheftCanaryAccess`, `pkOwnerCanaryAccess`,
  `guardedCheckCanaryAccess` (the positive control), `guardedLeakCanaryAccess`,
  `guardedLeakBoundValueCanaryAccess`
- `EXPECTED_SURFACE_IDS`, `COVERAGE_BOUNDARY`, `SUITE_OWNED_CONTROL_TABLES`,
  `ISOLATION_EXCLUSIONS`, `UNENUMERABLE_SURFACES`
- `tenantScopedTableDrift(...)`, `assertNoTenantIdAltered()`, `runCrossTenantAttempts(...)`,
  `finishIsolationReport(...)`, `formatIsolationReport(report)`

**Produces**

- `apps/api/test/isolation/registrations.ts` — one `endpointAccess` registration per
  authenticated route this initiative ships, each method carrying an explicit
  `qualification`; `EXPECTED_SURFACE_IDS` extended with every new surface id
- `apps/api/test/isolation/controls.ts` — the endpoint-level negative control: a table shaped
  like `workspaces` with `ENABLE ROW LEVEL SECURITY` omitted, reached through a control
  endpoint, exported as a value and **not** registered
- `apps/api/test/isolation/cross-tenant-isolation.int-spec.ts` — assertions that every
  registered endpoint attempt reports `pass` in both directions, that every control attempt
  reports `fail`, and that `tenant_memberships` and `workspaces` are registered subjects
- `apps/api/test/isolation/coverage.ts` — `COVERAGE_BOUNDARY` rewritten to state the tables
  and endpoints this run covered, that the endpoint set was registered by hand rather than
  discovered, and the five F-341 shapes it does not attempt
