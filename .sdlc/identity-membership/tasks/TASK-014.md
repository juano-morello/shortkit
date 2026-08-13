---
id: TASK-014
story: STORY-005
epic: EPIC-001
title: Two-tenant authenticated attempt mechanism for the isolation harness
status: todo
owner_slot: sdlc-implementer-backend
depends_on: [TASK-012]
paths: ["apps/api/test/isolation/http-attempts.ts", "apps/api/test/isolation/coverage.ts"]
contracts: [design/contracts/isolation-coverage.md, design/contracts/auth-tokens.md]
test_files: ["apps/api/test/isolation/cross-tenant-isolation.int-spec.ts (isolation tier — this TASK adds the mechanism the spec calls; TASK-015 adds the per-endpoint controls)"]
acceptance: [AC-29]
rework_count: 0
---

## Intent

Give the isolation harness a way to attack an **endpoint** rather than a table: two real
tenants, each with a real session, each attempting the other's rows over HTTP.

## Approach

Every attempt the harness runs today is SQL through `withTenantTransaction` against a live
Postgres as `shortkit_app`. SC-4 asks for something the harness has never done: an attempt
issued as an **authenticated request** by a second tenant's operator, signed in concurrently.
This TASK builds that mechanism; TASK-015 registers the controls that use it.

**The shape follows the existing one exactly.** A registered subject names its table, its
owner column, its `reset`, and a list of methods each carrying a **required, undefaulted**
`qualification` and an `attempt`. An HTTP attempt is another `CrossTenantAttempt`
implementation: it takes the two tenant fixtures and a direction, issues a request as one
tenant against a row belonging to the other, and returns a `CrossTenantAttemptResult` the
existing scoring reads. Nothing about the report, the directions or the verdict vocabulary
changes.

**Both directions, always.** `ATTEMPT_DIRECTIONS` is `['A->B', 'B->A']` and every method is
attempted in both, reported as distinct outcomes under the same surface id. A leak is not
symmetric in general: `USING (true)` is, and an `OR` arm naming one tenant is not (F-293).

**A refusal is not automatically a pass, and this is where the harness has been wrong three
times.** The recorded history is worth repeating because an HTTP attempt makes it easier to
repeat, not harder:

- round 1 — attempts ran in one direction only, any throw scored as a pass, and there was no
  positive control;
- round 2 — an owner-qualified write is routed through the SELECT policy by PostgreSQL and
  reports zero rows however wide open the UPDATE policy is;
- round 3 — a 42501 refusal on an unqualified write scored as a pass, which proves the
  `WITH CHECK` held and **not** that the `USING` did.

Over HTTP the same class arrives as a **404 or a 403 scored as a pass**. A 404 from an
endpoint proves the row was invisible to the policy **or** that the id was wrong **or** that
the route was misspelled, and only the first is isolation. An attempt whose refusal cannot
distinguish those must be scored `unverified` and go red, not `pass`. **An absence of
evidence recorded as a fact is the shape this file keeps having to un-learn** (F-296, F-342),
and there is deliberately no mechanism for declining a shape.

**A count is not a verdict either.** The harness's census and `assertNoTenantIdAltered`
exist because a write that moves a row to a tenant the fixture never seeds is detected by the
count rule while the digest cannot **name** the recipient (F-341 item 3). An HTTP attempt
that mutates has to be checked against the database, not against the response body.

**Two concurrent sessions, minted through the real surface.** Each tenant fixture gets a real
user, a real membership and a real token from the shipped auth surface — not a hand-forged
JWT — because a forged token would prove the policy and skip the guard, and SC-4 is about
what a **signed-in operator** can reach. `apps/api/test/support/auth-fixture.ts` already
ships `signUp`, `signIn`, `mintToken`, `jwtClaims`, `authRequest`, `POLICY_COMPLIANT_PASSWORD`
and `clearAuthTables`, and it sends an `Origin` header because `better-auth@1.6.26` answers a
state-changing auth request without one with `403 MISSING_OR_NULL_ORIGIN`.

**`apps/api/test/support/**` is `sdlc-test-architect`'s under routing rule 0 and is not in
this TASK's `paths`.** It is consumed, not edited. If the fixture needs a change, that is a
finding routed to its owner rather than an edit made here.

**Route and repository auto-discovery stays unimplemented.** `discoverRoutes()`,
`discoverRepositoryMethods()`, `undecoratedRepositoryClasses()` and
`tablesWithoutRepository()` in `coverage.ts` all throw `TASK-056 owns ...` and keep throwing.
This initiative registers its endpoints explicitly. SC-1's build-fails clause is about
**tables** and its mechanism already ships.

`UNENUMERABLE_SURFACES` already records `hook:onUserCreated` as unreachable by enumeration,
because the Better Auth handler is mounted outside the Nest module graph (ADR-0013), with
`coveredBy` pointing at a test file that does not exist. This initiative ships the signup
hook, so that entry's `coveredBy` should name a test that now exists — pointing it at
TASK-003's integration test is in scope here.

## Out of scope for this TASK

The per-endpoint control registrations and the mis-policied control tables (TASK-015). Any
`apps/api/src` file. Any table registration — `tenant_memberships` is TASK-002's and
`workspaces` is TASK-011's, each in the same commit as its table. Route discovery,
repository discovery and the forgotten-decorator backstop (TASK-056, deferred). Generative
mutation of the policy set (roadmap item 4). The five unbuilt statement shapes F-341 names.

## Interfaces

**Consumes**

From `apps/api/test/isolation/coverage.ts` (shipped, same file this TASK edits):
- `type SurfaceId = ` route:${HttpMethod} ${string}` | `repo:${string}.${string}` `
- `type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'`
- `type CrossTenantAttempt`, `interface CrossTenantAttemptResult`, `interface AttemptOutcome`
- `interface TenantFixture`, `interface TenantFixtures`, `createTenantFixtures(): Promise<TenantFixtures>`
- `ATTEMPT_DIRECTIONS: readonly AttemptDirection[]` — `['A->B', 'B->A']`
- `runCrossTenantAttempts(...)`, `assertNoCrossTenantAccess(...)`, `tenantOwnershipCensus(...)`, `assertNoTenantIdAltered(): Promise<void>`
- `surfaceIdOf(subject: string, method: string): SurfaceId`
- `beginIsolationReport(path: string, because?: string)`, `finishIsolationReport(...)`, `isolationReport()`, `writeIsolationReport(report, path)`, `formatIsolationReport(report)`
- `ISOLATION_EXCLUSIONS`, `UNENUMERABLE_SURFACES`, `COVERAGE_BOUNDARY`, `SUITE_OWNED_CONTROL_TABLES`

From `apps/api/test/support/auth-fixture.ts` (**test-architect's; consumed, never edited**):
- `signUp(...)`, `signIn(...)`, `signOut(server, cookie)`, `getSession(server, cookie)`, `mintToken(server, cookie)`
- `authRequest(...)`, `jwtClaims(token: string): Record<string, unknown>`
- `POLICY_COMPLIANT_PASSWORD`, `TOO_SHORT_PASSWORD`, `SIGNUP_NAME`, `authServerEnv(baseUrl: string)`
- `clearAuthTables()`, `sessionsFor(email)`, `accountsFor(email)`, `countSessions()`

From `apps/api/test/support/api-server.ts` and `rls-fixture.ts` (**test-architect's**):
`ApiServer`, `createRlsFixture`, `TENANT_A`, `TENANT_B`, `migrationDsn`.

From TASK-012 (over HTTP): the four authenticated workspace routes.

**Produces**

- `apps/api/test/isolation/http-attempts.ts` exporting:
  - `endpointAccess(spec: { subject: string; table: string; ownerColumn: string; reset: () => void | Promise<void>; endpoints: readonly EndpointAttemptSpec[] }): TenantScopedSurfaceRegistration` — the HTTP analogue of `tableAccess`
  - `interface EndpointAttemptSpec { method: HttpMethod; route: string; qualification: 'owner-qualified' | 'unqualified'; buildRequest(...): ...; expectedRefusal: ... }`
  - `signedInTenants(): Promise<{ a: SignedInTenant; b: SignedInTenant }>` — two real users, two real memberships, two real tokens, minted through the shipped auth surface
  - `interface SignedInTenant { tenantId: string; userId: string; email: string; bearerToken: string; cookie: string }`
- `apps/api/test/isolation/coverage.ts` — the HTTP attempt category accepted by the existing
  scoring and report; `UNENUMERABLE_SURFACES`' `hook:onUserCreated` entry repointed at a test
  that exists
