/**
 * Contract: design/contracts/isolation-coverage.md — this file is that contract's
 *           NORMATIVE FORM. Read the two together; the clause each export answers is
 *           named in its own comment.
 * ADR: adr-0020-isolation-suite-enumeration.md, adr-0003, adr-0019
 * Produced by: TASK-006 (the harness below) — TASK-056 fills in route discovery, the
 *              four grep clauses, the pg_policies shape assertion and the Form A/B/C
 *              scan, all fenced off at the bottom of this file.
 * AC-12.
 *
 * SC-1 lives here. Coverage is enforced by ENUMERATION, not by a hand-maintained list.
 *
 * ===========================================================================
 * WHAT THIS HARNESS COVERS TODAY, AND WHAT A PASSING RUN THEREFORE PROVES
 * ===========================================================================
 *
 * TWO TABLES. `tenants` and `rls_fixture_rows`. That is every table this repository
 * has: `apps/api/drizzle/0000_*.sql` creates `tenants` and nothing else, and
 * `rls_fixture_rows` is the template-shaped table `test/support/rls-fixture.ts` builds
 * from the production policy builder. `workspaces`, `links`, `domains`, `click_events`,
 * `tenant_memberships` and the rest do not exist yet.
 *
 * NO ROUTES AND NO REPOSITORIES. There is no `AppModule` route carrying tenant data and
 * no class carrying `@TenantScopedRepository()` — the decorator itself still throws
 * `not implemented` in `src/tenancy/tenant-context.ts` (TASK-011). So the three
 * discovery mechanisms in isolation-coverage.md's "Discovery" section discover nothing
 * today, and they are TASK-056's to build. What this file delivers is the layer beneath
 * them: the registry they will register into, the attempt semantics they will drive,
 * and the report they will fill.
 *
 * SO A GREEN RUN OF `cross-tenant-isolation.int-spec.ts` SAYS EXACTLY THIS: for the two
 * tables that exist, a tenant transaction belonging to A cannot read, update, delete or
 * plant a row belonging to B, through any of the five statement shapes below, and no
 * such attempt moved a row from one tenant to another. IT DOES NOT SAY that the system
 * has no cross-tenant surface — most of the system is not written. Ruled 2026-08-06:
 * AC-12 is met against a partial table set, deliberately, and the boundary is stated
 * rather than implied.
 *
 * HOW IT GROWS. A later schema TASK adds one `registerTenantScopedSurfaces()` call in
 * `registrations.ts` naming its table, its owner column and its repository's methods.
 * Nothing in this file changes. That is the mechanism isolation-coverage.md means when
 * it says every TASK adding a repository is a consumer of this contract.
 *
 * ===========================================================================
 * AND WHAT PROVES THE HARNESS WOULD NOTICE
 * ===========================================================================
 *
 * Nothing here is asserted against a mock, and no test in this suite asserts that a
 * test helper works. Every attempt runs real SQL through `withTenantTransaction`
 * against a live Postgres as `shortkit_app`, a role holding neither SUPERUSER nor
 * BYPASSRLS. The thing that would make an attempt pass wrongly is the database
 * answering wrongly.
 *
 * The remaining risk — that the harness reports `pass` because it is looking in the
 * wrong place — is closed by a NEGATIVE CONTROL rather than by prose: `leak-canary.ts`
 * builds a table shaped exactly like a tenant-scoped one and deliberately omits
 * `ENABLE ROW LEVEL SECURITY`, which is the exact defect `scripts/check-policies.mts`
 * exists to catch. The suite runs this same harness over it and requires EVERY one of
 * the five attempts to report `fail`. A harness that could not see a leak would report
 * that table clean, and the suite goes red.
 */
import { writeFileSync } from 'node:fs';

import { sql } from 'drizzle-orm';

import { withTenantTransaction } from '../../src/tenancy/tenant-context';
import {
  createRlsFixture,
  TENANT_A,
  TENANT_A_NAME,
  TENANT_B,
  TENANT_B_NAME,
} from '../support/rls-fixture';

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

/** isolation-coverage.md, "Surface identity". */
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
   * capability-token entry point (ADR-0021). TASK-056 populates this; no route exists
   * to carry it yet.
   */
  readonly usesCapabilityToken?: boolean;
}

/**
 * isolation-coverage.md declares six fields — `id`, `ownerUserId`, `token`,
 * `workspaceId`, `linkId`, `domainId`. Five of them name rows in tables no migration
 * creates yet: `user` and `tenant_memberships` (TASK-013), `workspaces` (TASK-018),
 * `links` and `domains` (TASK-024, TASK-028).
 *
 * RULED 2026-08-06: do not block on them and do not invent them. The two fields below
 * are the ones a fixture can honestly hold today, and the wave that adds each table
 * adds its field here in the same commit that registers the table. This divergence from
 * the contract is deliberate and recorded, not an oversight — see TASK-006's report.
 */
export interface TenantFixture {
  readonly id: string;
  readonly name: string;
}

export interface TenantFixtures {
  readonly tenantA: TenantFixture;
  readonly tenantB: TenantFixture;
}

/**
 * What an attempt hands back for judging. A read reports `rows`; a write reports
 * `rowsAffected`. An attempt that the database refused simply THROWS — the runner
 * catches it, and a refusal is a pass (isolation-coverage.md, "Attempt semantics":
 * "zero rows returned, or a throw").
 */
export interface CrossTenantAttemptResult {
  readonly rows?: ReadonlyArray<Record<string, unknown>>;
  readonly rowsAffected?: number;
}

/**
 * Runs one method inside `actor`'s tenant transaction, with `target`'s arguments. It is
 * a real call against a real database; it does not judge anything.
 */
export type CrossTenantAttempt = (
  actor: TenantFixture,
  target: TenantFixture,
) => Promise<CrossTenantAttemptResult>;

export interface TenantScopedMethod {
  /** The method name as it appears in the surface id: `repo:<subject>.<name>`. */
  readonly name: string;
  /** AC-94 covers the reads, AC-95 the writes. Reported, so the split is legible. */
  readonly kind: 'read' | 'write';
  readonly attempt: CrossTenantAttempt;
}

/**
 * One tenant-scoped subject: a repository, or — until repositories exist — the table
 * access object that stands in for one. The later schema TASK that lands
 * `LinkRepository` registers it here and its methods are enumerated the same way.
 */
export interface TenantScopedSurfaceRegistration {
  /** Class name of the subject, and the middle of every id it contributes. */
  readonly subject: string;
  readonly table: string;
  /**
   * The column carrying the owning tenant. `tenant_id` on every table built from
   * `tenantScopedPolicies()`; `id` on `tenants`, which is the cascade root and carries
   * no `tenant_id` of its own.
   */
  readonly ownerColumn: string;
  /**
   * Puts the fixture back the way it was. Called BEFORE every attempt, so an attempt
   * that wrongly succeeded cannot make the next one's result meaningless.
   */
  readonly reset: () => void | Promise<void>;
  readonly methods: readonly TenantScopedMethod[];
}

export interface AttemptOutcome {
  readonly id: SurfaceId;
  readonly subject: string;
  readonly method: string;
  readonly table: string;
  readonly kind: 'read' | 'write';
  /** AC-12: pass/fail PER METHOD. */
  readonly outcome: 'pass' | 'fail';
  /** One entry per way this attempt crossed the boundary. Empty on a pass. */
  readonly leaks: readonly string[];
  /** How the database refused it, when it did. A refusal is a pass. */
  readonly refusedWith?: string;
}

export interface IsolationReport {
  runAt: string;
  discovered: DiscoveredSurface[];
  covered: SurfaceId[];
  /** Asserted with toEqual([]) so the failure NAMES each one (AC-96). */
  uncovered: SurfaceId[];
  /**
   * ADDITIVE, and not in isolation-coverage.md's declared `IsolationReport`. AC-12
   * requires the harness to report "pass/fail per method"; the contract's shape carries
   * only `covered`, `uncovered` and a whole-run `verdict`, none of which distinguishes
   * a method that was attempted and passed from one that was attempted and leaked.
   * Recorded as a contract gap in TASK-006's report rather than silently absorbed.
   */
  attempts: AttemptOutcome[];
  /** The subset of `covered` whose outcome was `fail`. Named, for AC-96's reason. */
  failed: SurfaceId[];
  excluded: ReadonlyArray<{ id: SurfaceId; justification: string }>;
  publicRoutes: ReadonlyArray<{ id: SurfaceId; justification: string }>;
  noTenantTransactionRoutes: ReadonlyArray<{ id: SurfaceId; justification: string }>;
  /** Covered by named integration tests rather than by enumeration. */
  unenumerable: ReadonlyArray<{ id: string; reason: string; coveredBy: string }>;
  /** Stated in the artifact itself, so a reader of report.json sees the boundary. */
  coverageBoundary: string;
  verdict: 'pass' | 'fail';
}

/**
 * ============================================================================
 * EXACTLY TWO. A third fails the length assertion in the suite.
 * Raising this number requires a written justification (ADR-0020).
 * ============================================================================
 *
 * Neither surface exists yet — `RedirectReadRepository` is TASK-029's and
 * `PrivilegedTenantEraser` is TASK-054's. The list is carried now because the LENGTH is
 * the control: a third entry has to arrive as a visible one-line diff, and it cannot do
 * that against a list that does not exist.
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
 * isolation-coverage.md, "What enumeration cannot reach" (F-021). `DiscoveryService`
 * walks the Nest module graph and Better Auth is mounted on the raw Express instance
 * ahead of Nest (ADR-0013), so nothing under `/api/auth/*` is enumerable.
 *
 * These are declarations of where the boundary of enumeration lies. The tests named in
 * `coveredBy` belong to TASK-013 and TASK-054 and DO NOT EXIST YET; the report carries
 * the entries so a reader sees the gap, and TASK-056 is what turns `coveredBy` into an
 * assertion that the file is there and runs.
 */
export const UNENUMERABLE_SURFACES = [
  {
    id: 'hook:onUserCreated',
    reason: 'Better Auth handler is mounted outside the Nest module graph (ADR-0013).',
    coveredBy: 'apps/api/test/auth/signup-invited.int-spec.ts',
  },
  {
    id: 'handler:POST /api/gdpr/delete authorization',
    reason: '@NoTenantTransaction moves the owner check into the handler (F-020).',
    coveredBy: 'apps/api/test/gdpr/delete-authorization.int-spec.ts',
  },
] as const;

/** Reproduced verbatim into `report.json`, so the artifact SC-1 points at is not read as stronger than it is. */
export const COVERAGE_BOUNDARY =
  'TASK-006, wave 2. Covers the two tables that exist: `tenants` (migrated, four ' +
  'bespoke policies) and `rls_fixture_rows` (built from tenantScopedPolicies()). ' +
  'No routes and no repositories are enumerated, because none exist — route and ' +
  'repository discovery is TASK-056. A pass here means cross-tenant reads and writes ' +
  'against those two tables were refused or returned nothing; it does not mean the ' +
  'system has no uncovered cross-tenant surface.';

/* ========================================================================== *
 * The registry. This is the enumeration mechanism.
 * ========================================================================== */

const registry = new Map<string, TenantScopedSurfaceRegistration>();

/**
 * Adds a subject and every method it offers to the enumeration. Called at import time
 * from `registrations.ts`; a later schema TASK adds one call and nothing else.
 *
 * Registering the same subject twice throws rather than overwriting: two registrations
 * disagreeing about a table's owner column would silently disable half the attempts.
 */
export function registerTenantScopedSurfaces(
  registration: TenantScopedSurfaceRegistration,
): void {
  if (registry.has(registration.subject)) {
    throw new Error(`${registration.subject} is already registered with the isolation suite.`);
  }

  if (registration.methods.length === 0) {
    throw new Error(
      `${registration.subject} registered no methods. A subject with nothing to attempt ` +
        'is indistinguishable from a subject nobody remembered to cover.',
    );
  }

  registry.set(registration.subject, registration);
}

export function registeredSubjects(): TenantScopedSurfaceRegistration[] {
  return [...registry.values()];
}

export function surfaceIdOf(subject: string, method: string): SurfaceId {
  return `repo:${subject}.${method}`;
}

/** Every surface the registry knows about, in the shape the contract's report declares. */
export function discoveredSurfaces(
  registrations: readonly TenantScopedSurfaceRegistration[] = registeredSubjects(),
): DiscoveredSurface[] {
  return registrations.flatMap((registration) =>
    registration.methods.map(
      (method): DiscoveredSurface => ({
        id: surfaceIdOf(registration.subject, method.name),
        kind: 'repository-method',
        // Every method here runs inside a tenant transaction, which is what
        // `authenticated` means for a repository surface.
        authenticated: true,
      }),
    ),
  );
}

/* ========================================================================== *
 * Fixtures.
 * ========================================================================== */

/** The census taken when the fixtures were built, for `assertNoTenantIdAltered()`. */
let ownershipBaseline: string[] | null = null;

/**
 * Two tenants, each owning one row in every registered table. Rebuilds the fixture from
 * scratch, so a run never inherits another test's rows.
 */
export async function createTenantFixtures(): Promise<TenantFixtures> {
  createRlsFixture();

  const fixtures: TenantFixtures = {
    tenantA: { id: TENANT_A, name: TENANT_A_NAME },
    tenantB: { id: TENANT_B, name: TENANT_B_NAME },
  };

  ownershipBaseline = await tenantOwnershipCensus(registeredSubjects(), fixtures);

  return fixtures;
}

/**
 * Who owns what, read through the policies themselves: one tenant transaction per
 * tenant per table, each returning the row ids that tenant can see. A row that moved
 * from B to A appears in A's half and disappears from B's; a row that was deleted
 * disappears from both.
 *
 * Deliberately NOT read as the migrator with RLS off. The census is what the tenants
 * can see, and the transaction it runs in is the same production path the attempts use.
 */
export async function tenantOwnershipCensus(
  registrations: readonly TenantScopedSurfaceRegistration[],
  fixtures: TenantFixtures,
): Promise<string[]> {
  const census: string[] = [];

  for (const registration of registrations) {
    for (const tenant of [fixtures.tenantA, fixtures.tenantB]) {
      const rows = await withTenantTransaction(tenant.id, async (db) => {
        const result = await db.execute<Record<string, unknown>>(
          sql`select id, ${sql.identifier(registration.ownerColumn)} as owner
                from ${sql.identifier(registration.table)}
               order by id`,
        );

        return result.rows;
      });

      for (const row of rows) {
        census.push(
          `${registration.table} seen-by=${tenant.id} id=${String(row.id)} owner=${String(row.owner)}`,
        );
      }
    }
  }

  return census.sort();
}

/**
 * AC-95's post-run check, in isolation-coverage.md's own words: "a single query asserts
 * no row's tenant_id differs from a snapshot taken before the run". The snapshot is the
 * one `createTenantFixtures()` took.
 *
 * The runner below ALSO compares the census either side of every individual attempt,
 * which is strictly stronger — it names the method that moved a row instead of only
 * reporting that one did — so this is the contract's declared form kept available for
 * TASK-056, not the only place ownership is checked.
 */
export async function assertNoTenantIdAltered(): Promise<void> {
  if (ownershipBaseline === null) {
    throw new Error('assertNoTenantIdAltered() ran before createTenantFixtures().');
  }

  const now = await tenantOwnershipCensus(registeredSubjects(), {
    tenantA: { id: TENANT_A, name: TENANT_A_NAME },
    tenantB: { id: TENANT_B, name: TENANT_B_NAME },
  });

  if (now.join('\n') !== ownershipBaseline.join('\n')) {
    throw new Error(
      'tenant ownership changed across the run.\n' +
        `before:\n  ${ownershipBaseline.join('\n  ')}\nafter:\n  ${now.join('\n  ')}`,
    );
  }
}

/* ========================================================================== *
 * Attempt semantics. isolation-coverage.md, "Attempt semantics".
 * ========================================================================== */

function judge(
  registration: TenantScopedSurfaceRegistration,
  actor: TenantFixture,
  target: TenantFixture,
  result: CrossTenantAttemptResult,
): string[] {
  const leaks: string[] = [];

  for (const row of result.rows ?? []) {
    if (!(registration.ownerColumn in row)) {
      // Not a leak — a broken attempt. An attempt whose projection omits the owner
      // column cannot be judged, and silently passing it is how a harness stops
      // detecting anything.
      throw new Error(
        `an attempt on ${registration.subject} returned a row without its owner column ` +
          `"${registration.ownerColumn}": ${JSON.stringify(row)}. Every read attempt must ` +
          'project the owner column, or the harness has nothing to compare.',
      );
    }

    const owner = String(row[registration.ownerColumn]);

    if (owner.toLowerCase() !== actor.id.toLowerCase()) {
      leaks.push(
        `returned a row owned by ${owner}, not by the acting tenant ${actor.id}: ` +
          JSON.stringify(row),
      );
    }
  }

  const affected = result.rowsAffected ?? 0;

  if (affected > 0) {
    leaks.push(
      `affected ${String(affected)} row(s) while acting as ${actor.id} against ` +
        `${target.id}; a cross-tenant write must be rejected or affect zero rows (AC-95)`,
    );
  }

  return leaks;
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { code?: string }).code;

    return code === undefined ? `${error.name}: ${error.message}` : `${error.name} [${code}]`;
  }

  return String(error);
}

/**
 * Runs one method and judges it. Never throws for a leak — it RECORDS one, so a run
 * reports every method rather than stopping at the first (AC-12, AC-96).
 */
async function attempt(
  registration: TenantScopedSurfaceRegistration,
  method: TenantScopedMethod,
  fixtures: TenantFixtures,
): Promise<AttemptOutcome> {
  const id = surfaceIdOf(registration.subject, method.name);
  const common = {
    id,
    subject: registration.subject,
    method: method.name,
    table: registration.table,
    kind: method.kind,
  } as const;

  await registration.reset();

  const before = await tenantOwnershipCensus([registration], fixtures);

  let result: CrossTenantAttemptResult;

  try {
    result = await method.attempt(fixtures.tenantA, fixtures.tenantB);
  } catch (error) {
    // isolation-coverage.md: "zero rows returned, or a throw". The database refusing
    // the statement is the outcome the policy exists to produce.
    return { ...common, outcome: 'pass', leaks: [], refusedWith: describeError(error) };
  }

  const leaks = judge(registration, fixtures.tenantA, fixtures.tenantB, result);
  const after = await tenantOwnershipCensus([registration], fixtures);

  if (after.join('\n') !== before.join('\n')) {
    leaks.push(
      'tenant ownership changed while this method ran (AC-95).\n' +
        `      before: ${before.join(' | ')}\n      after:  ${after.join(' | ')}`,
    );
  }

  return { ...common, outcome: leaks.length === 0 ? 'pass' : 'fail', leaks };
}

/**
 * isolation-coverage.md's declared entry point: assert one surface, throwing on a leak.
 *
 * A surface with no registered attempt FAILS AS UNCOVERED and is never skipped — the
 * contract's "Attempt semantics" says so in as many words, and a skip is how a surface
 * with awkward arguments quietly leaves the suite.
 */
export async function assertNoCrossTenantAccess(
  surface: DiscoveredSurface,
  fixtures: TenantFixtures,
): Promise<void> {
  const found = registeredSubjects()
    .flatMap((registration) =>
      registration.methods.map((method) => ({ registration, method })),
    )
    .find(({ registration, method }) => surfaceIdOf(registration.subject, method.name) === surface.id);

  if (found === undefined) {
    throw new Error(
      `${surface.id} has no registered cross-tenant attempt, so it is UNCOVERED. ` +
        'Register one in apps/api/test/isolation/registrations.ts. A surface whose ' +
        'arguments cannot be inferred registers a fixture builder; it is never skipped.',
    );
  }

  const outcome = await attempt(found.registration, found.method, fixtures);

  if (outcome.outcome === 'fail') {
    throw new Error(`${surface.id} crossed the tenant boundary:\n  - ${outcome.leaks.join('\n  - ')}`);
  }
}

let lastReport: IsolationReport | null = null;

/**
 * Runs every registered method and returns the report. Judges; does not assert. The
 * suite is what turns a `fail` verdict into a red test, which is what lets the negative
 * control assert a `fail` without the run dying first.
 */
export async function runCrossTenantAttempts(
  registrations: readonly TenantScopedSurfaceRegistration[],
  fixtures: TenantFixtures,
): Promise<IsolationReport> {
  const discovered = discoveredSurfaces(registrations);
  const attempts: AttemptOutcome[] = [];

  for (const registration of registrations) {
    for (const method of registration.methods) {
      attempts.push(await attempt(registration, method, fixtures));
    }
  }

  const covered = attempts.map((outcome) => outcome.id);
  const uncovered = discovered
    .filter((surface) => surface.authenticated)
    .map((surface) => surface.id)
    .filter(
      (id) =>
        !covered.includes(id) &&
        !ISOLATION_EXCLUSIONS.some((exclusion) => exclusion.id === id),
    );
  const failed = attempts.filter((o) => o.outcome === 'fail').map((o) => o.id);

  const report: IsolationReport = {
    runAt: new Date().toISOString(),
    discovered,
    covered,
    uncovered,
    attempts,
    failed,
    excluded: ISOLATION_EXCLUSIONS.map((exclusion) => ({ ...exclusion })),
    // TASK-056 fills both from the module graph. No route exists to enumerate.
    publicRoutes: [],
    noTenantTransactionRoutes: [],
    unenumerable: UNENUMERABLE_SURFACES.map((surface) => ({ ...surface })),
    coverageBoundary: COVERAGE_BOUNDARY,
    verdict: failed.length === 0 && uncovered.length === 0 ? 'pass' : 'fail',
  };

  lastReport = report;

  return report;
}

/** isolation-coverage.md, "Report": the last run's report. */
export function isolationReport(): IsolationReport {
  if (lastReport === null) {
    throw new Error('isolationReport() ran before runCrossTenantAttempts().');
  }

  return lastReport;
}

/** `apps/api/test/isolation/report.json` — the artifact SC-1 points at. */
export function writeIsolationReport(report: IsolationReport, path: string): void {
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

/** AC-12's "enumerates which methods were exercised", for the run log a human reads. */
export function formatIsolationReport(report: IsolationReport): string {
  const lines = [
    `isolation coverage — ${report.verdict.toUpperCase()} — ${report.runAt}`,
    report.coverageBoundary,
    '',
    ...report.attempts.map(
      (outcome) =>
        `  ${outcome.outcome === 'pass' ? 'pass' : 'FAIL'}  ${outcome.id}  (${outcome.kind} on ${outcome.table})` +
        (outcome.refusedWith === undefined ? '' : ` — refused: ${outcome.refusedWith}`) +
        outcome.leaks.map((leak) => `\n      ! ${leak}`).join(''),
    ),
  ];

  if (report.uncovered.length > 0) {
    lines.push('', '  UNCOVERED (AC-96):', ...report.uncovered.map((id) => `    - ${id}`));
  }

  return lines.join('\n');
}

/* ========================================================================== *
 * TASK-056's half. Declared here because isolation-coverage.md names this file
 * as the normative form for all of it; NOTHING BELOW IS TASK-006'S, and no test
 * in this wave calls any of it.
 * ========================================================================== */

/** isolation-coverage.md "Discovery" 1. Boots AppModule, walks controllers. */
export function discoverRoutes(): Promise<DiscoveredSurface[]> {
  throw new Error(
    'TASK-056 owns route discovery (isolation-coverage.md, "Discovery" 1). TASK-006 ' +
      'delivers the registry, the attempt semantics and the report only.',
  );
}

/** isolation-coverage.md "Discovery" 2. Providers carrying @TenantScopedRepository(). */
export function discoverRepositoryMethods(): Promise<DiscoveredSurface[]> {
  throw new Error(
    'TASK-056 owns repository discovery (isolation-coverage.md, "Discovery" 2). It ' +
      'also needs @TenantScopedRepository(), which still throws not-implemented in ' +
      'src/tenancy/tenant-context.ts (TASK-011).',
  );
}

/** isolation-coverage.md "Discovery" 3, the backstop for a forgotten decorator. */
export function undecoratedRepositoryClasses(): Promise<string[]> {
  throw new Error('TASK-056 owns the forgotten-decorator backstop (isolation-coverage.md, "Discovery" 3).');
}

/** Every table from tenantScopedTables() must be reachable through a registered repository. */
export function tablesWithoutRepository(): Promise<string[]> {
  throw new Error(
    'TASK-056 owns this, and it needs tenantScopedTables() (ADR-0019, TASK-053), ' +
      'which does not exist yet.',
  );
}

/** isolation-coverage.md, "ASSERTION 1 of 2": the four grep clauses A1..A4. */
export const CONTEXT_FLAG_OWNERS: ReadonlyArray<{ flag: string; file: string }> = [
  { flag: 'app.tenant_id', file: 'apps/api/src/tenancy/tenant-context.ts' },
  { flag: 'app.redirect_context', file: 'apps/api/src/redirect/db/redirect-read.ts' },
  { flag: 'app.privileged_erase', file: 'apps/api/src/gdpr/privileged-eraser.ts' },
];

export interface PolicyShape {
  readonly namePattern: RegExp;
  readonly command: 'ALL' | 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE';
  /** Normalised. CAPTURED FROM A LIVE DATABASE, never hand-written. */
  readonly qual: string | null;
  readonly withCheck: string | null;
  readonly tables: 'all-tenant-scoped' | readonly string[];
  readonly required: boolean;
}

/** isolation-coverage.md, "ASSERTION 2 of 2": the pg_policies shape check. */
export function assertOnlyApprovedPolicies(): Promise<void> {
  throw new Error(
    'TASK-056 owns the pg_policies shape assertion. `pnpm --filter @shortkit/api ' +
      'db:check-policies` is the weaker form that runs today (F-122).',
  );
}

export type AuthorizationForm = 'A-decorator' | 'B-in-handler' | 'C-in-transaction' | 'unverified';

/** isolation-coverage.md, "Enforcing exactly one of Form A, B or C". */
export function authorizationFormOf(_surface: DiscoveredSurface): AuthorizationForm {
  throw new Error(
    'TASK-056 owns the authorization-form scan (workspace-authorization.md invariant 8). ' +
      'No authenticated route exists to scan.',
  );
}
