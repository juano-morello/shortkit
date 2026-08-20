---
id: ADR-0020
slug: foundation
title: Discover routes and repository methods through NestJS DiscoveryService, with a naming-convention backstop
status: accepted
supersedes: null
date: 2026-08-04
---

> **Amended 2026-08-11 (F-327). Two sentences in the Decision stated a rule that three audit
> rounds on TASK-006 disproved by measurement, and a third described an artifact shape and a
> CI upload that do not exist.** The decisions this ADR makes did not change: discovery
> through `DiscoveryService` with a naming-convention backstop, coverage by set difference,
> exclusions as count-asserted data, and a second completeness assertion over `pg_policies`
> all stand. What changed is that this ADR was **also** restating the attempt semantics, and
> those semantics moved underneath it while the restatement did not.
>
> **The corrections point at `docs/contracts/isolation-coverage.md` rather than repeating
> it.** Two copies of a rule are two things that can drift, which is exactly the failure
> being corrected here: the contract carried the disproved rule in three places and this ADR
> in two, so one fix had to be applied five times and was applied twice. The attempt
> semantics live in the contract now, in one place, and this ADR names the decision and stops
> there.
>
> See "Attempts are generated" and "AC-95's write check" in the Decision below, and the
> module-graph bullet under Consequences.

## Context

AC-93 requires the isolation suite to enumerate every exported repository method and
every registered authenticated route, and to fail if any is not covered by a
cross-tenant attempt. AC-96 requires a new authenticated route added without a case to
fail the suite and be named in the failure. TASK-056 rules out a hand-maintained list.

SC-1 is the initiative's headline claim, and this mechanism is what makes it a claim
that keeps being true rather than one that was true on the day it was written.

The suite must also record exactly two exclusions: the redirect module's
non-tenant-scoped read (TASK-029) and `privilegedTenantEraser` (TASK-054). A third
must fail.

## Decision

**Routes: `DiscoveryService` plus `MetadataScanner`, against the real application
module.** The suite boots the production `AppModule` in a testing context and walks
every controller, reading `PATH_METADATA` and `METHOD_METADATA` from each handler and
the controller's own path, plus the global prefix from ADR-0006. That produces the
live route table, not a copy of it.

A route is **authenticated** unless its handler or controller carries `@Public()`. The
`@Public()` set is reported separately with a justification string, so the redirect
routes and `POST /invitations/:token/accept` appear as deliberate rather than as gaps.

**Repositories: a decorator, backstopped by a naming-convention check.**
`@TenantScopedRepository()` marks a provider; `DiscoveryService` finds them and
`MetadataScanner.getAllMethodNames(prototype)` enumerates their public methods. A new
method on an existing repository is discovered with no edit.

A forgotten decorator on a whole new class is the hole, and this closes it:

```ts
// fails and names the class
const undecorated = providers
  .filter((p) => /Repository$/.test(p.name) || /Repo$/.test(p.name))
  .filter((p) => !Reflect.getMetadata(TENANT_SCOPED_REPOSITORY, p.metatype));
expect(undecorated).toEqual([]);
```

**Amended 2026-08-18.** The key TASK-006 shipped is `TENANT_SCOPED_REPOSITORY_METADATA`,
suffixed like the two route keys, in `apps/api/src/tenancy/tenant-context.ts`. The snippet
above stays as written on 2026-08-04.

A second check asserts every table from `tenantScopedTables()` (ADR-0019) is reachable
through at least one registered repository, so a table with no repository is a failure
too. Three independent mechanisms, and defeating all three requires deliberately naming
a class something other than `*Repository`, skipping the decorator, and not touching
any tenant-scoped table.

**Coverage is asserted by set difference, not by counting.**

```ts
type SurfaceId = `route:${string}` | `repo:${string}.${string}`;
const uncovered = discovered.filter((s) => !attempted.has(s) && !EXCLUSIONS.has(s));
expect(uncovered).toEqual([]);   // names every uncovered surface
```

`toEqual([])` on an array of ids is what makes AC-96's "names the uncovered route"
literal. A count comparison would say "expected 41, got 40".

**A second completeness assertion over `pg_policies`.** Added 2026-08-04. Grep catches an
escape that sets a new context flag. It does not catch a cascade, and it does not catch a
permissive policy added to an existing table, which is how F-005 survived the first
round. The suite asserts that every policy on every tenant-scoped table matches an
approved shape from `rls-policy-template.md` by name and by `qual` text, that every
required shape is present, and that `FORCE ROW LEVEL SECURITY` is on. The coverage table
in `isolation-coverage.md` lists which mechanism catches which arrival path.

**Unbuilt as of 2026-08-11 (F-122, F-333, F-327), and worth knowing which half runs.**
`assertOnlyApprovedPolicies()` throws `not implemented`; it needs `tenantScopedTables()`,
which is ADR-0019's and TASK-053's. What runs today is `pnpm db:check-policies`, which
asserts `relrowsecurity` and `relforcerowsecurity` against an exception list and does **not**
match policies against approved shapes. It is also carrying part of the load of TASK-006's
registry drift check, so the two are a composite gate rather than two independent ones,
stated in `isolation-coverage.md` so that whoever replaces either half knows.

**Exclusions are data with justifications, and the count is asserted.**

```ts
export const ISOLATION_EXCLUSIONS = [
  { id: 'repo:RedirectReadRepository.resolveByHostAndSlug',
    justification: 'Redirect resolution runs before a tenant is known; the visitor is anonymous. Narrowed by ADR-0003 to a FOR SELECT policy on domains and links inside a READ ONLY transaction.' },
  { id: 'repo:PrivilegedTenantEraser.erase',
    justification: 'Amendment A-2: GDPR deletion is deliberately outside the tenant-facing interface. Narrowed by ADR-0003 to a FOR DELETE policy scoped to one tenant id.' },
] as const;

expect(ISOLATION_EXCLUSIONS).toHaveLength(2);
```

A third exclusion fails on the length assertion. Raising the number is a one-line diff
that a reviewer sees and that this ADR says must carry a written justification.

**Attempts are generated, not written per surface.** `assertNoCrossTenantAccess`
(TASK-006) takes a surface descriptor and runs the attempt. Routes get a request as
tenant A's user against tenant B's resource id, asserting 403 or 404 and never a body
carrying B's data. ~~Repository methods get a call inside tenant A's transaction with B's
arguments, asserting zero rows.~~ A surface whose arguments the generator cannot infer
registers a fixture builder; the absence of one fails as uncovered rather than being
skipped.

**Amended 2026-08-11 (F-302, F-330, F-327).** "Asserting zero rows" is the pre-F-302 rule
and it is satisfied by a policy that admits every row of every tenant: PostgreSQL routes any
UPDATE or DELETE that references a column through the SELECT policy, so a write qualified by
the owner column reports zero rows however wide open the write policy is. Measured on the
migrated `tenants` table, and a suite reporting 15 passed with exit 0 over a table one
tenant could destroy. The rule now depends on whether the statement names the owning tenant
in a `WHERE` clause, a refusal proves only what the `WITH CHECK` clause decides, and a read
that raised proves nothing at all. **The normative statement is
`docs/contracts/isolation-coverage.md`, "Attempt semantics", and it is not restated here.**
The decision this ADR is making (that attempts are generated from a descriptor rather than
hand-written per surface) is unchanged.

~~**AC-95's write check runs once after the suite.** A single query asserts no row's
`tenant_id` changed against a snapshot taken before the run.~~

**Amended 2026-08-11 (F-302, F-328, F-327).** That was the only ownership check the harness
had and it is now neither the only one nor the strongest: ownership is compared either side
of **every individual attempt**, which names the method that moved a row, and the post-run
check is the weaker form kept for TASK-056, weaker still because an unqualified write that
affected rows triggers a fixture reset immediately after the attempt. Where that weakening
is bounded, and the one place it is not, is in `isolation-coverage.md`, "AC-95's post-run
check".

**The report is machine-readable.** `apps/api/test/isolation/report.json`~~, uploaded as
a CI artifact~~: discovered surfaces, covered, excluded with justifications, public
routes with justifications, and the run's verdict. This is the artifact SC-1 points at.

**Amended 2026-08-11 (F-297, F-331, F-327).** Two corrections. **No upload step exists**
(the path is gitignored and `ci.yml` has none), so the artifact lives only in the workspace of
whichever job ran the suite; building it is F-297's, and it must fail the job when the
artifact's `runAt` predates the job. And the five fields listed above are a strict subset of
what is written: the shape, the three values `verdict` now takes, and the write discipline
that stops a red run publishing a green artifact are declared in `isolation-coverage.md`,
"Report".

## Alternatives considered

| Option | Pros | Cons | Why not |
|---|---|---|---|
| Read Express's `_router.stack` for routes | Directly reflects what the server will serve, including anything mounted outside Nest | A private Express internal that changed shape between Express 4 and 5, which NestJS 11 just moved to. It also loses the `@Public()` metadata the suite needs to classify routes | Fragile against exactly the upgrade the project already made |
| Generate an OpenAPI document and enumerate its paths | A stable, inspectable artifact; tooling exists | ADR-0005 chose not to produce one, and `@nestjs/swagger` decorators would become mandatory on every endpoint purely to feed this test. Repository methods are not covered at all | Adds an artifact and a decoration burden for half the coverage |
| A file-system convention: every `*.repository.ts` is scanned by AST | No decorators; catches classes never registered in DI | An AST walk is a second, weaker model of the application that drifts from what DI actually instantiates, and it cannot tell a tenant-scoped repository from a non-tenant one | More machinery, less fidelity |
| Enforce coverage with a lint rule requiring a matching test per method | Fails at lint time, faster feedback | A lint rule proves a test file exists, not that a cross-tenant attempt ran or that it returned zero rows | Proves the wrong thing |
| Mutation testing: flip an RLS policy off and require the suite to fail | Proves the suite has teeth, not just coverage | Valuable, and a much larger piece of work than TASK-056 scopes | Worth doing later; not this initiative |

## Consequences

### Positive

- Adding a route or a repository method fails the suite by default, and the failure
  message names it. That is AC-96 literally.
- The suite reads the real module graph, so it cannot drift from what the server
  serves. **Not yet true, as of 2026-08-11 (F-327).** It is a property of TASK-056's
  harness, and TASK-056 has not run: no route carries tenant data, no class carries
  `@TenantScopedRepository()`, and the decorator throws `not implemented` (TASK-011). What
  stands in for it in wave 2, and why it is a substitute rather than the thing, is in
  `isolation-coverage.md`, "The registry, and what bounds the covered set before TASK-056
  exists". **Amended 2026-08-18.** The decorator shipped in TASK-006 with the required
  justification on `@Public()` and `@NoTenantTransaction()`; `WorkspaceRepository` carries
  `@TenantScopedRepository()`. Nothing reads the marker yet, so the sentence stays not yet
  true.
- Three independent discovery mechanisms mean a single omission is caught by at least
  one. **Two of the three are unbuilt** (same amendment). The one that runs is a database
  cross-check the ADR did not anticipate, and it is independent of the registry rather than
  of the module graph.
- The two exclusions are visible, justified, narrowed by database policy, and
  count-asserted, so an auditor finds them deliberately.

### Negative / accepted cost

- The naming-convention backstop is a string match on class names. A repository named
  `LinkStore` escapes it, and only the table-reachability check would notice, and only
  if it touches a tenant-scoped table.
- The suite boots the whole application, so it is slow and it fails for reasons that
  have nothing to do with isolation, such as a missing environment variable. Failures
  will sometimes be noise and people learn to reread them rather than trust them.
- Generated attempts test the shape of isolation, not the semantics of each endpoint. A
  route returning 404 for the wrong reason passes.
- Argument inference will not work for every route, so some surfaces need fixture
  builders. Writing one is exactly the moment someone is tempted to add an exclusion
  instead, and only the length assertion stands in the way.
- `DiscoveryService` and `MetadataScanner` are stable but internal-flavoured NestJS
  APIs. A major upgrade can change them and the suite breaks in a way that looks like a
  security failure.
- The `pg_policies` assertion compares normalised `qual` text, so its expected values
  have to be generated against a live database and committed. A PostgreSQL upgrade that
  changes normalisation fails the test with a diff that looks alarming and means
  nothing, and regenerating is the fix, which trains people to regenerate rather than to
  read.

### Follow-ups this creates

- TASK-006 builds `createTenantFixtures`, `assertNoCrossTenantAccess` and
  `isolationReport` against the surface-descriptor shape in the contract.
- TASK-011 makes `@Public()` carry a required justification string. **Amended 2026-08-18:**
  TASK-006 did, for `@Public()` and `@NoTenantTransaction()` both, at decoration time.
- Every repository-producing TASK applies `@TenantScopedRepository()`.
- TASK-056 owns discovery, the three checks, the exclusion list, the AC-95 snapshot
  check, and `report.json`. **Revised 2026-08-11 (F-327):** TASK-006 shipped `report.json`,
  the exclusion list, the AC-95 snapshot check and the attempt semantics three waves early,
  because the harness needed them to judge anything at all. What is left for TASK-056 is
  discovery, the four grep clauses, the `pg_policies` shape assertion and the Form A/B/C
  scan. The split as it stands is in `isolation-coverage.md`, "What this contract claims that
  is not yet true".
- **This ADR states each rule once and points at the contract for the mechanism.** Added
  2026-08-11 (F-327). The reason is the finding itself: the disproved write rule existed in
  five places across two documents, one fix reached two of them, and the gap survived an
  audit round. A future change to the attempt semantics amends the contract, and this ADR
  only if the *decision* changed.
- Mutation testing of the RLS policies belongs to a later initiative.
- Contract: `docs/contracts/isolation-coverage.md`.
