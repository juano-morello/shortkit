/**
 * Contract: design/contracts/isolation-coverage.md
 * ADR: adr-0020-isolation-suite-enumeration.md, adr-0003, adr-0019
 * Produced by: TASK-006 (harness), TASK-056 (discovery, assertions, report)
 *
 * SC-1 lives here. Coverage is enforced by ENUMERATION, not by a hand-maintained list.
 */

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

export type SurfaceId = `route:${HttpMethod} ${string}` | `repo:${string}.${string}`;

export interface DiscoveredSurface {
  readonly id: SurfaceId;
  readonly kind: 'route' | 'repository-method';
  readonly authenticated: boolean;
  /** Present iff !authenticated. @Public() requires a non-empty justification. */
  readonly publicJustification?: string;
  /** Present iff the route carries @NoTenantTransaction(). One route in launch-core. */
  readonly noTenantTransactionJustification?: string;
  /**
   * True when a @Public() route reaches a tenant-scoped table through a
   * capability-token entry point (ADR-0021). A @Public() route that touches one WITHOUT
   * this fails the suite: it would need an escape, and there are exactly two.
   */
  readonly usesCapabilityToken?: boolean;
}

/** Boots the production AppModule and walks controllers via DiscoveryService + MetadataScanner. */
export function discoverRoutes(): Promise<DiscoveredSurface[]> {
  throw new Error('not implemented');
}

/** Providers carrying @TenantScopedRepository(), methods via MetadataScanner. */
export function discoverRepositoryMethods(): Promise<DiscoveredSurface[]> {
  throw new Error('not implemented');
}

/**
 * Backstop for a forgotten decorator: any provider whose class name matches
 * /Repository$|Repo$/ must carry @TenantScopedRepository(). Returns the offenders.
 */
export function undecoratedRepositoryClasses(): Promise<string[]> {
  throw new Error('not implemented');
}

/** Every table from tenantScopedTables() must be reachable through a registered repository. */
export function tablesWithoutRepository(): Promise<string[]> {
  throw new Error('not implemented');
}

/**
 * ============================================================================
 * EXACTLY TWO. A third fails the length assertion in the suite.
 * Raising this number requires a written justification (ADR-0020).
 * ============================================================================
 */
export const ISOLATION_EXCLUSIONS = [
  {
    id: 'repo:RedirectReadRepository.resolveByHostAndSlug' as SurfaceId,
    justification:
      'Redirect resolution runs before a tenant is known; the visitor is anonymous and the only inputs are a hostname and a slug. Narrowed by ADR-0003 to FOR SELECT policies on domains and links only, inside a READ ONLY transaction, in one file.',
  },
  {
    id: 'repo:PrivilegedTenantEraser.erase' as SurfaceId,
    justification:
      'Amendment A-2: GDPR deletion is deliberately outside the tenant-facing interface. Narrowed by ADR-0003 to a FOR DELETE policy scoped to a single tenant id. Reachable only from POST /api/gdpr/delete under tenant owner plus confirmation (AC-106).',
  },
] as const;

/**
 * ASSERTION 1 of 2. Each Postgres context flag must appear in exactly one non-test
 * source file. A fourth escape, or a second file setting an existing one, fails here.
 */
export const CONTEXT_FLAG_OWNERS: ReadonlyArray<{ flag: string; file: string }> = [
  { flag: 'app.tenant_id', file: 'apps/api/src/tenancy/tenant-context.ts' },
  { flag: 'app.redirect_context', file: 'apps/api/src/redirect/db/redirect-read.ts' },
  { flag: 'app.privileged_erase', file: 'apps/api/src/gdpr/privileged-eraser.ts' },
];

/**
 * ============================================================================
 * ASSERTION 2 of 2. pg_policies shape check. Added 2026-08-04.
 * ============================================================================
 *
 * Grep catches an escape that SETS A NEW CONTEXT FLAG. It does not catch a cascade, and
 * it does not catch a permissive policy added to an existing table.
 *
 * F-005 was exactly that: `tenants` carried a FOR ALL policy whose DELETE let any
 * authenticated handler cascade-destroy the tenant's click stream and audit log while
 * setting no flag and greping clean.
 *
 * Every policy on every tenant-scoped table must match an approved shape in
 * rls-policy-template.md BY NAME AND BY qual TEXT. Three checks, all must hold:
 *   1. every policy present matches an approved shape
 *   2. every tenant-scoped table HAS the shapes it is required to have
 *      (a table missing <t>_privileged_erase silently survives erasure)
 *   3. relrowsecurity AND relforcerowsecurity are true on every tenant-scoped table
 *      (without FORCE the owner bypasses every policy and the suite is theatre)
 */
export interface PolicyShape {
  readonly namePattern: RegExp;
  readonly command: 'ALL' | 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE';
  /** Normalised. CAPTURED FROM A LIVE DATABASE, never hand-written: PostgreSQL
   *  reformats policy expressions and a hand-written string will not match. */
  readonly qual: string | null;
  readonly withCheck: string | null;
  readonly tables: 'all-tenant-scoped' | readonly string[];
  readonly required: boolean;
}

export function assertOnlyApprovedPolicies(): Promise<void> {
  throw new Error('not implemented');
}

export interface TenantFixture {
  readonly id: string;
  readonly ownerUserId: string;
  readonly token: string;
  readonly workspaceId: string;
  readonly linkId: string;
  readonly domainId: string;
}

export interface TenantFixtures {
  readonly tenantA: TenantFixture;
  readonly tenantB: TenantFixture;
}

export function createTenantFixtures(): Promise<TenantFixtures> {
  throw new Error('not implemented');
}

/**
 * route:       request as A's user against B's resource id
 *              -> 403 or 404, and no id or tenant_id of B's anywhere in the body (AC-94)
 * repo method: call inside A's transaction with B's arguments
 *              -> zero rows, or a throw (AC-94)
 * writes:      rejected or zero rows affected, no tenant_id altered (AC-95)
 *
 * A surface whose arguments cannot be inferred registers a fixture builder.
 * ABSENCE OF ONE FAILS AS UNCOVERED. It is never skipped.
 */
export function assertNoCrossTenantAccess(
  _surface: DiscoveredSurface,
  _fixtures: TenantFixtures,
): Promise<void> {
  throw new Error('not implemented');
}

export interface IsolationReport {
  runAt: string;
  discovered: DiscoveredSurface[];
  covered: SurfaceId[];
  /** Asserted with toEqual([]) so the failure NAMES each one (AC-96). */
  uncovered: SurfaceId[];
  excluded: ReadonlyArray<{ id: SurfaceId; justification: string }>;
  publicRoutes: ReadonlyArray<{ id: SurfaceId; justification: string }>;
  verdict: 'pass' | 'fail';
}

/** Written to apps/api/test/isolation/report.json and uploaded as a CI artifact. */
export function isolationReport(): IsolationReport {
  throw new Error('not implemented');
}

/** AC-95. Runs once after the suite, against a snapshot taken before it. */
export function assertNoTenantIdAltered(): Promise<void> {
  throw new Error('not implemented');
}
