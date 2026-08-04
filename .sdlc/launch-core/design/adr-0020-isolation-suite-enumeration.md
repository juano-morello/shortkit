---
id: ADR-0020
slug: launch-core
title: Discover routes and repository methods through NestJS DiscoveryService, with a naming-convention backstop
status: accepted
supersedes: null
date: 2026-08-04
---

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
carrying B's data. Repository methods get a call inside tenant A's transaction with B's
arguments, asserting zero rows. A surface whose arguments the generator cannot infer
registers a fixture builder; the absence of one fails as uncovered rather than being
skipped.

**AC-95's write check runs once after the suite.** A single query asserts no row's
`tenant_id` changed against a snapshot taken before the run.

**The report is machine-readable.** `apps/api/test/isolation/report.json`, uploaded as
a CI artifact: discovered surfaces, covered, excluded with justifications, public
routes with justifications, and the run's verdict. This is the artifact SC-1 points at.

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
  serves.
- Three independent discovery mechanisms mean a single omission is caught by at least
  one.
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

### Follow-ups this creates

- TASK-006 builds `createTenantFixtures`, `assertNoCrossTenantAccess` and
  `isolationReport` against the surface-descriptor shape in the contract.
- TASK-011 makes `@Public()` carry a required justification string.
- Every repository-producing TASK applies `@TenantScopedRepository()`.
- TASK-056 owns discovery, the three checks, the exclusion list, the AC-95 snapshot
  check, and `report.json`.
- Mutation testing of the RLS policies belongs to a later initiative.
- Contract: `design/contracts/isolation-coverage.md`.
