# Contract: isolation surface discovery and the coverage report

- **Boundary:** the SC-1 suite's discovery mechanism, and the report it produces.
- **Normative form:** `apps/api/test/isolation/coverage.ts` (stub: `design/stubs/apps/api/test/isolation/coverage.ts`).
- **Produced by:** TASK-006 (harness), TASK-056 (discovery, assertions, report).
- **Consumed by:** every TASK adding a repository or an authenticated route.
- **ADRs:** ADR-0020, ADR-0003, ADR-0019.

## Surface identity

```ts
export type SurfaceId =
  | `route:${'GET'|'POST'|'PATCH'|'PUT'|'DELETE'} ${string}`   // 'route:GET /api/links/:id'
  | `repo:${string}.${string}`;                                 // 'repo:LinkRepository.findById'

export interface DiscoveredSurface {
  readonly id: SurfaceId;
  readonly kind: 'route' | 'repository-method';
  readonly authenticated: boolean;
  readonly publicJustification?: string;   // present iff !authenticated
}
```

## Discovery

Three independent mechanisms. Defeating coverage requires defeating all three.

**1. Routes, via `DiscoveryService` + `MetadataScanner`.** The suite boots the
production `AppModule` in a testing context and walks every controller, reading
`PATH_METADATA` and `METHOD_METADATA` per handler plus the controller path and the
global prefix (ADR-0006). A route is authenticated unless its handler or controller
carries `@Public(justification)`. Public routes are reported with their justification,
not silently skipped.

**2. Repositories, via `@TenantScopedRepository()` + `DiscoveryService`.** Public
methods are enumerated with `MetadataScanner.getAllMethodNames(prototype)`. A new
method on an existing repository is discovered with no edit.

**3. The backstop for a forgotten decorator.**

```ts
// fails and names the class
const undecorated = providers
  .filter((p) => /Repository$|Repo$/.test(p.name))
  .filter((p) => !Reflect.getMetadata(TENANT_SCOPED_REPOSITORY, p.metatype));
expect(undecorated).toEqual([]);
```

plus: every table from `tenantScopedTables()` must be reachable through at least one
registered repository, so a table with no repository fails too.

## Coverage assertion

```ts
const uncovered = discovered
  .filter((s) => s.authenticated)
  .map((s) => s.id)
  .filter((id) => !attempted.has(id) && !excludedIds.has(id));

expect(uncovered).toEqual([]);   // names every uncovered surface (AC-96)
```

`toEqual([])` on an array of ids, not a count comparison. AC-96 requires the failure to
**name** the uncovered route.

## Exclusions: exactly two

```ts
export const ISOLATION_EXCLUSIONS = [
  {
    id: 'repo:RedirectReadRepository.resolveByHostAndSlug',
    justification:
      'Redirect resolution runs before a tenant is known; the visitor is anonymous and the only inputs are a hostname and a slug. Narrowed by ADR-0003 to FOR SELECT policies on domains and links only, inside a READ ONLY transaction, in one file.',
  },
  {
    id: 'repo:PrivilegedTenantEraser.erase',
    justification:
      'Amendment A-2: GDPR deletion is deliberately outside the tenant-facing interface. Narrowed by ADR-0003 to a FOR DELETE policy scoped to a single tenant id. Reachable only from POST /api/gdpr/delete under tenant owner plus confirmation (AC-106).',
  },
] as const;

expect(ISOLATION_EXCLUSIONS).toHaveLength(2);
```

A third exclusion fails the length assertion. Raising the number is a one-line diff a
reviewer sees, and ADR-0020 requires a written justification with it.

## Two completeness assertions, not one

### 1. The grep assertion

Each Postgres context flag must appear in exactly one non-test source file:

| String | Permitted file |
|---|---|
| `app.tenant_id` | `apps/api/src/tenancy/tenant-context.ts` |
| `app.redirect_context` | `apps/api/src/redirect/db/redirect-read.ts` |
| `app.privileged_erase` | `apps/api/src/gdpr/privileged-eraser.ts` |

A fourth escape, or a second file setting an existing one, fails here.

### 2. The `pg_policies` shape assertion

Added 2026-08-04. Grep catches an escape that **sets a new context flag**. It does not
catch a cascade, and it does not catch a permissive policy added to an existing table.
F-005 was exactly that: `tenants` carried a `FOR ALL` policy whose `DELETE` let any
authenticated handler cascade-destroy the tenant's click stream and audit log while
setting no flag and greping clean.

Every policy on every tenant-scoped table must match one of the approved shapes in
`rls-policy-template.md` **by name and by `qual` text**. Anything else fails and names
the policy and the table.

```ts
export interface PolicyShape {
  readonly namePattern: RegExp;   // e.g. /^(.+)_tenant_isolation$/
  readonly command: 'ALL' | 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE';
  readonly qual: string | null;   // normalised, captured from a live database
  readonly withCheck: string | null;
  readonly tables: 'all-tenant-scoped' | readonly string[];
}

export declare function assertOnlyApprovedPolicies(): Promise<void>;
```

The check runs three ways, and all three must hold:

1. Every policy present matches an approved shape.
2. Every tenant-scoped table has the shapes it is **required** to have, so a table
   missing `<t>_privileged_erase` fails rather than silently surviving erasure.
3. `relrowsecurity` and `relforcerowsecurity` are both true on every tenant-scoped
   table. Without `FORCE`, the owner bypasses every policy and the whole suite is
   theatre.

**Expected `qual` strings are captured from a live database after migration**, not
written by hand: PostgreSQL normalises and reformats policy expressions, so a
hand-written string will not match.

`pnpm db:check-policies` is the same assertion, runnable outside the suite, and CI's
`integration` job runs it.

### What the two assertions together do and do not cover

| Way a third escape could arrive | Caught by |
|---|---|
| a new context flag set in application code | grep |
| an existing flag set in a second file | grep |
| a new permissive policy on an existing table | `pg_policies` shape |
| a widened `FOR` clause on an approved policy | `pg_policies` shape |
| a tenant-scoped table with RLS not forced | `pg_policies` shape |
| a table with a `tenant_id` column and no policies at all | `pg_policies` shape, via `tenantScopedTables()` |
| a `BYPASSRLS` or superuser runtime role | boot-time assertion (`rls-policy-template.md`) |
| a cascade from a table whose `DELETE` is ungated | **indirectly**: the shape assertion proves `tenants` has no ordinary `DELETE` policy, which is what makes the cascade reachable only from the eraser |

## Attempt semantics

```ts
export interface TenantFixtures {
  readonly tenantA: { id: string; ownerUserId: string; token: string; workspaceId: string; linkId: string; domainId: string };
  readonly tenantB: { /* same shape */ };
}
export declare function createTenantFixtures(): Promise<TenantFixtures>;
export declare function assertNoCrossTenantAccess(surface: DiscoveredSurface, f: TenantFixtures): Promise<void>;
export declare function isolationReport(): IsolationReport;
```

| Kind | Attempt | Assertion |
|---|---|---|
| route | request as A's user against B's resource id | status is 403 or 404, and the body contains no id or `tenant_id` belonging to B (AC-94) |
| repository method | call inside A's transaction with B's arguments | zero rows returned, or a throw (AC-94) |
| write of either kind | as above | rejected or zero rows affected (AC-95) |

A surface whose arguments cannot be inferred registers a fixture builder. **Absence of
one fails as uncovered**; it is never skipped.

**AC-95's post-run check** runs once: a single query asserts no row's `tenant_id`
differs from a snapshot taken before the run.

## Enforcing "exactly one of Form A, B or C"

`workspace-authorization.md` invariant 8 says every authenticated route is authorised by
exactly one form. Form A is a decorator and `DiscoveryService` sees it. **Forms B and C
are method calls**, so they need a source-level check.

```ts
export type AuthorizationForm = 'A-decorator' | 'B-in-handler' | 'C-in-transaction' | 'unverified';
export declare function authorizationFormOf(surface: DiscoveredSurface): AuthorizationForm;
```

The scan resolves each authenticated route's handler and looks for a call to
`authorizer.assert`, `authorizer.assertTenant`, or `assertNotLastOwner`. It follows **one
level of delegation**: a handler whose body is a single call into a service method also
has that method's body scanned.

**A route the scan cannot resolve is reported as `unverified`, not as passing.**
`unverified` is a suite failure with the route named, exactly like `uncovered`. That is
what stops the check degrading into a rubber stamp when a handler delegates two levels
deep: the fix is to move the call up or to add the route to the scan's resolution hints,
both of which are visible in a diff.

Known limit, stated: the scan proves an authorization call exists on the path, not that
its arguments are right. A handler calling `assert(someOtherWorkspaceId, ...)` passes.
Form B's correctness still rests on the cross-tenant attempts above, which is why both
mechanisms exist.

## What enumeration cannot reach

Added 2026-08-04 (F-021). `DiscoveryService` walks the Nest module graph. Better Auth is
mounted on the raw Express instance ahead of Nest (ADR-0013), so **nothing under
`/api/auth/*` appears in `discoverRoutes()`**, including `onUserCreated`, which is the
single anonymous path that writes `tenant_memberships`.

This is a real gap in SC-1's completeness claim, recorded rather than left implicit.

| Surface | Why enumeration misses it | Coverage instead |
|---|---|---|
| `onUserCreated`, invited branch | inside Better Auth's handler, outside the Nest graph | TASK-013 integration test: a token whose tenant half names another tenant creates no user and no membership there |
| `onUserCreated`, uninvited branch | same | TASK-013 integration test: the created tenant is the generated uuid and nothing else |
| in-handler authorization on `@NoTenantTransaction` routes | the check is a call, not a decorator | TASK-054 integration test: tenant `member` and `admin` both get 403 on `POST /api/gdpr/delete` (F-020) |

`isolationReport()` carries these as `unenumerable`, each with the test that covers it,
so a reader of the report sees the boundary of what the suite proves.

```ts
export const UNENUMERABLE_SURFACES = [
  { id: 'hook:onUserCreated', reason: 'Better Auth handler is mounted outside the Nest module graph (ADR-0013).', coveredBy: 'apps/api/test/auth/signup-invited.int-spec.ts' },
  { id: 'handler:POST /api/gdpr/delete authorization', reason: '@NoTenantTransaction moves the owner check into the handler (F-020).', coveredBy: 'apps/api/test/gdpr/delete-authorization.int-spec.ts' },
] as const;
```

Adding an entry here is not a substitute for an exclusion and does not change the
exclusion count: these surfaces are covered, just not by enumeration.

## Report

`apps/api/test/isolation/report.json`, uploaded as a CI artifact.

```ts
export interface IsolationReport {
  runAt: string;
  discovered: DiscoveredSurface[];
  covered: SurfaceId[];
  uncovered: SurfaceId[];
  excluded: ReadonlyArray<{ id: SurfaceId; justification: string }>;
  publicRoutes: ReadonlyArray<{ id: SurfaceId; justification: string }>;
  noTenantTransactionRoutes: ReadonlyArray<{ id: SurfaceId; justification: string }>;
  /** Covered by named integration tests rather than by enumeration. See above. */
  unenumerable: ReadonlyArray<{ id: string; reason: string; coveredBy: string }>;
  verdict: 'pass' | 'fail';
}
```

This is the artifact SC-1 points at.

## Invariants a caller may rely on

1. Adding an authenticated route or a repository method without a cross-tenant attempt
   fails the suite and names it (AC-93, AC-96).
2. Every cross-tenant read returns zero rows, 403 or 404 (AC-94).
3. Every cross-tenant write is rejected or affects zero rows, and no `tenant_id` is
   altered (AC-95).
4. The suite reads the real module graph, so it cannot drift from what the server
   serves.
5. Exactly two exclusions exist, both justified in-file and both narrowed by database
   policy.
6. **The complete set of ways data crosses a tenant boundary is the approved policy set
   in `rls-policy-template.md`**, and a test asserts that, so the claim is enforced
   rather than stated.
7. Every `@Public()` route that touches a tenant-scoped table reaches it through a
   capability-token entry point (ADR-0021), not through an escape.

## What the implementer must guarantee

- TASK-011 makes `@Public()` and `@NoTenantTransaction()` require a non-empty
  justification string. Both are enumerated and printed.
- **A `@NoTenantTransaction` route may not also carry `@RequireTenantRole` or
  `@RequireWorkspaceRole`.** The suite asserts that combination never exists (F-020):
  the guards need an ambient tenant context the route does not have, and the cheapest
  repair is to make `WorkspaceGuard` tolerate its absence, which removes the owner check
  from tenant erasure.
- **`as TenantRole` and `as WorkspaceRole` appear only inside `asTenantRole` and
  `asWorkspaceRole`.** The suite greps for a third cast site and fails on it (ADR-0023).
- Every repository-producing TASK applies `@TenantScopedRepository()`.
- The suite runs in CI's `integration` job (ADR-0001).
- A surface that is hard to fixture gets a fixture builder, not an exclusion.
- The `pg_policies` expected values are generated by a script against a freshly migrated
  database and committed. Regenerating them is a reviewed diff, which is the point.

## Versioning

`SurfaceId` strings appear in `ISOLATION_EXCLUSIONS`. Renaming a repository class or a
route path changes the id and breaks an exclusion, which fails loudly. That is
intended.
