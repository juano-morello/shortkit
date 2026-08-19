/**
 * Contract: docs/contracts/isolation-coverage.md — this file is that contract's
 *           NORMATIVE FORM. Read the two together; the clause each export answers is
 *           named in its own comment.
 * ADR: adr-0020-isolation-suite-enumeration.md, adr-0003, adr-0019
 * Produced by: TASK-006 (the harness below) — TASK-056 fills in route discovery, the
 *              four grep clauses, the pg_policies shape assertion and the Form A/B/C
 *              scan, all fenced off at the bottom of this file.
 * AC-12.
 *
 * SC-1 lives here.
 *
 * ===========================================================================
 * HOW COVERAGE IS BOUNDED, STATED FIRST BECAUSE IT DECIDES WHAT THE REST MEANS
 * ===========================================================================
 *
 * IN THIS WAVE, THE SET OF SUBJECTS IS THE REGISTRY. `discoveredSurfaces()` maps over
 * `registrations.ts`, so `uncovered` is structurally `[]` and cannot fail on its own —
 * an earlier version of this header claimed enumeration where there was a list, and r1
 * measured the consequence: a tenant-scoped table nobody registered leaked every row to
 * every tenant with both gates green and its name in no artifact.
 *
 * WHAT KEEPS THE LIST HONEST IS A SECOND, INDEPENDENT ENUMERATION (F-296, F-303).
 * `tenantScopedTableDrift()` asks the DATABASE which relations carry a tenant boundary
 * and requires that set to equal the registry's. A table in one and not the other fails
 * the run and names it, in both directions. That is ADR-0019's cross-check, SQL half,
 * pulled forward: it needs no `tenantScopedTables()` artifact, and TASK-053 and TASK-056
 * are both deferred.
 *
 * IT ASKS FIVE INDEPENDENT QUESTIONS, NOT ONE, AND THE FIRST VERSION ASKED ONLY ONE.
 * r1 matched on the literal column name `tenant_id` — the assumption ADR-0019 itself
 * files under "accepted cost" — and r2 measured what that misses: a table whose owner
 * column is called `owning_tenant`, force-RLS'd with a `USING (true)` policy, leaking
 * every row to every tenant, invisible to the drift check, named in no artifact, and
 * called protected by `db:check-policies`. r3 measured that arms 3 and 4 are properties
 * of a table being PROTECTED, so the UNPROTECTED shape of the same table was still
 * invisible — caught then only by `db:check-policies`, which is a different gate, which
 * is not what "second, independent enumeration" means. Arm 5 is a foreign key to
 * `tenants(id)` and depends on neither protection nor a column name. The five arms, and
 * the shape that still escapes all of them, are at `tenantScopedTableDrift()` below.
 * Module-graph discovery of routes and repositories remains TASK-056's, and nothing here
 * pretends otherwise.
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
 * NO DISCOVERY. Routes carrying tenant data and one class carrying
 * `@TenantScopedRepository()` exist since identity-membership (the four `/api/workspaces`
 * routes and `WorkspaceRepository`; the decorator became real in TASK-006), but the three
 * discovery mechanisms in isolation-coverage.md's "Discovery" section still discover
 * nothing — they throw, and they are TASK-056's to build. Every surface attacked today
 * was registered by hand. What this file delivers is the layer beneath discovery: the
 * registry it will register into, the attempt semantics it will drive, and the report it
 * will fill.
 *
 * SO A GREEN RUN OF `cross-tenant-isolation.int-spec.ts` SAYS EXACTLY THIS: for the two
 * tables that exist, a tenant transaction belonging to A cannot read, update, delete or
 * plant a row belonging to B, OR TAKE OWNERSHIP OF ONE, through any of the EIGHT
 * statement shapes below — five that name the owning tenant in a WHERE clause and THREE
 * THAT NAME NOTHING AT ALL — and no such attempt moved, removed or overwrote a row
 * belonging to another tenant.
 *
 * THE LAST THREE ARE THE BLOCKERS OF TWO CONSECUTIVE ROUNDS, AND THEY ARE NOT A DETAIL.
 *
 * `updateAll` and `deleteAll` are r2's (F-302). Every write the harness attempted until
 * then was qualified by the owner column, so PostgreSQL routed it through the SELECT
 * policy — the rule `test/support/rls-fixture.ts:175-188` already had measured and
 * written down — and reported zero rows however wide open the UPDATE or DELETE policy
 * was. Measured on the migrated production table: `tenants_self_update` altered to
 * `USING (true) WITH CHECK (true)`, then `UPDATE tenants SET name = 'x'` with no WHERE,
 * in an ordinary tenant-A transaction, reported UPDATE 2 and destroyed tenant B's row —
 * while this suite reported 15 passed, exit 0, and `db:check-policies` OK.
 *
 * `reparentAll` is r3's (F-330), and it is the worse half. Tighten that WITH CHECK back
 * to the predicate the production builder actually emits — leaving only the USING
 * widened — and the statement above is REFUSED with 42501, which the harness scored as a
 * denial. Measured: every attempt green, `verdict: pass`, over a policy admitting every
 * row of every tenant. A refusal proves the WITH CHECK held and says NOTHING about the
 * USING clause, and no shape in this harness had ever written the owner column — which
 * is the statement that defect permits. `UPDATE <t> SET tenant_id = <actor>` reports
 * UPDATE 2 and leaves tenant B's row belonging to tenant A. Theft rather than vandalism,
 * and every mechanism r2 added was blind to it.
 *
 * AND NO TABLE IS EXCUSED FROM ANY OF THE EIGHT (F-342, r4). r3 let a registration
 * decline a shape by name, with a published reason, and `tenants` was the first and only
 * use: its owner column is its primary key, so `UPDATE tenants SET id = <actor>` was said
 * to be "refused by the primary key index with 23505 before any policy is evaluated, so
 * it could never distinguish a correct policy from a wide-open one". MEASURED on the
 * migrated table, as `shortkit_app` in an ordinary tenant-A transaction on 2026-08-11:
 *
 *   tenants_self_update USING (id = ctx)  [the migration's] -> UPDATE 1, NO ERROR
 *   tenants_self_update USING (true), WITH CHECK correct    -> ERROR 23505 tenants_pkey
 *   tenants_self_update USING (true) WITH CHECK (true)      -> ERROR 23505 tenants_pkey
 *
 * The ordering is the other way round: the USING clause is applied during the scan, so
 * under the correct policy the statement reaches only the actor's own row, the assignment
 * is an IDENTITY UPDATE, and the key is never contended. The shape separated the cases
 * cleanly on the one migrated production table this repository has, and the artifact SC-1
 * points at published the false reason as a fact. Both the decline and the mechanism
 * behind it are gone.
 *
 * IT DOES NOT SAY that the system
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
 * its attempts to report `fail`. A harness that could not see a leak would report that
 * table clean, and the suite goes red.
 *
 * There are NINE such controls now, one per way an audit measured this harness reporting
 * `pass` over a database that was not isolated, plus four probes for tables nobody
 * registered. They are in `controls.ts` and `leak-canary.ts`, each named for the finding
 * it answers, and every one of them is real DDL against the real database rather than a
 * mutation someone ran once.
 *
 * AND SINCE r4 THERE IS ONE POSITIVE CONTROL AMONG THEM (F-344).
 * `isolation_guarded_check_canary` is correctly isolated and carries a WITH CHECK
 * stricter than its USING, which is what an ordinary business predicate produces — and
 * r3's `unverified` rule fired on it, leaving the run permanently red over a table with
 * nothing wrong with it. A check that goes red on correct code is the check that gets
 * deleted rather than fixed, so the shape a correct table CANNOT be reported as is now
 * measured on every run alongside the shapes a leaking table must be.
 */
import { writeFileSync } from 'node:fs';

import { sql } from 'drizzle-orm';

import { withTenantTransaction } from '../../src/tenancy/tenant-context';
import { querySql } from '../support/psql';
import {
  createRlsFixture,
  migrationDsn,
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
  /**
   * Whether the statement reaches a row that must already exist, or writes a new one.
   * F-295: a statement that reaches an existing row proves nothing unless the target
   * actually owns one, so the runner refuses to score it until it has read that row
   * through the target's own tenant transaction.
   */
  readonly reaches?: 'existing-row' | 'new-row';
  /**
   * ============================================================================
   * F-302. WHETHER THE STATEMENT NAMES THE OWNING TENANT IN A WHERE CLAUSE.
   * ============================================================================
   *
   * REQUIRED, and deliberately not defaulted. Every write the harness attempted until
   * r2 was `owner-qualified`, and that single fact was the blocker: PostgreSQL applies
   * the SELECT policies to any UPDATE or DELETE that REFERENCES A COLUMN, which
   * `test/support/rls-fixture.ts:175-188` already had measured and written down. So a
   * `WHERE tenant_id = <target>` is routed through the SELECT policy and reports zero
   * rows however wide open the UPDATE or DELETE policy is. Measured on the migrated
   * production table: with `tenants_self_update` altered to `USING (true) WITH CHECK
   * (true)`, `UPDATE tenants SET name = 'x' WHERE id = <B>` from tenant A's transaction
   * reports UPDATE 0, and `UPDATE tenants SET name = 'x'` with no WHERE at all reports
   * UPDATE 2 and destroys tenant B's row.
   *
   * The two values are judged differently and that is the point:
   *
   *   'owner-qualified'  every row the statement can touch belongs to the TARGET, so
   *                      ANY row affected is a leak (the rule since r1).
   *
   *   'unqualified'      no WHERE at all, so the rows the ACTOR owns are legitimately
   *                      affected. The leak is a row count in excess of what the actor
   *                      can see of its own — `UPDATE 2` from a single-tenant context —
   *                      and it is visible in the command tag before any census runs.
   *
   * A defaulted field is how this blind spot comes back: a later TASK registering a
   * repository method would inherit whichever value was convenient. Making it required
   * means the decision has to be written down per statement.
   */
  readonly qualification: 'owner-qualified' | 'unqualified';
  /**
   * TASK-014. Present iff this method is an HTTP attempt, in which case it is
   * `route:${method} ${pattern}` and overrides `surfaceIdOf(subject, name)` — so an
   * endpoint attempt names the ROUTE in the report rather than a repository method. A
   * table or repository method leaves it undefined and keeps the `repo:` id.
   */
  readonly surfaceId?: SurfaceId;
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
  /*
   * ==========================================================================
   * F-342. THERE IS NO WAY TO DECLINE A STATEMENT SHAPE, AND THAT IS DELIBERATE.
   * ==========================================================================
   *
   * r3 added one: `declinedShapes`, a reason string carried into `report.json`, guarded
   * by three independent edits so a decline could not arrive as a silent diff. The guard
   * rails were right and the first — and only — use was not. `tenants` declined the
   * owner-column write on the premise that `UPDATE tenants SET id = <actor>` "is refused
   * by the primary key index with 23505 before any policy is evaluated". Measured on the
   * migrated table on 2026-08-11: under the migration's own policies it reports UPDATE 1
   * and NO ERROR, because the USING clause admits only the actor's own row and the
   * assignment is an identity update; the 23505 appears only once the USING is widened.
   * The shape separated a correct policy from a wide-open one, in both directions, and
   * the decline removed one of the table's two live unqualified write attempts — while
   * the artifact SC-1 points at published the false reason as a fact.
   *
   * An absence of evidence recorded as a fact is F-296's shape and it is what this file
   * keeps repeating, so the mechanism is gone rather than corrected. A table that cannot
   * express a shape as written changes the STATEMENT — see `unqualifiedWritesAlsoSet` in
   * registrations.ts, which is how F-344's stricter-WITH-CHECK table stays green — and a
   * table that genuinely cannot answer goes `unverified` and red, which is a measurement
   * rather than a declaration.
   */
}

export type AttemptDirection = 'A->B' | 'B->A';

/**
 * F-293. Every method is attempted in both, and both are reported as distinct outcomes
 * under the same surface id. A leak is not symmetric in general: `USING (true)` is, and
 * an `OR` arm naming one tenant is not.
 */
export const ATTEMPT_DIRECTIONS: readonly AttemptDirection[] = ['A->B', 'B->A'];

export interface AttemptOutcome {
  readonly id: SurfaceId;
  readonly subject: string;
  readonly method: string;
  readonly table: string;
  readonly kind: 'read' | 'write';
  /** F-293: which tenant acted, and which it acted against. */
  readonly direction?: AttemptDirection;
  readonly actor?: string;
  readonly target?: string;
  /** AC-12: pass/fail PER METHOD. `unverified` is a run failure, like `uncovered`. */
  readonly outcome: 'pass' | 'fail' | 'unverified';
  /** One entry per way this attempt crossed the boundary. Empty on a pass. */
  readonly leaks: readonly string[];
  /** F-295: "denied" and "found nothing" are different answers. */
  readonly rowsSeen?: number;
  readonly rowsAffected?: number;
  /** F-302: whether the statement carried a WHERE naming the owning tenant. */
  readonly qualification?: 'owner-qualified' | 'unqualified';
  /** Rows the actor could see that it owns, read through its own transaction. */
  readonly actorOwnRowsVisible?: number;
  /** Rows the target could see that it owns. Zero makes a reaching attempt vacuous. */
  readonly targetOwnRowsVisible?: number;
  /** How the database refused it, when it did. SQLSTATE AND MESSAGE (F-294). */
  readonly refusedWith?: string;
  /** F-294: only a refusal the harness recognises as row-level security is a pass. */
  readonly refusalKind?: 'row-level-security' | 'unrecognised';
  /** Why the attempt proved nothing. Present iff outcome is `unverified`. */
  readonly unverifiedBecause?: string;
}

/**
 * ============================================================================
 * F-304. `incomplete` IS A THIRD VERDICT, AND IT DIVERGES FROM THE CONTRACT.
 * ============================================================================
 *
 * isolation-coverage.md's declared `IsolationReport` carries `verdict: 'pass' | 'fail'`.
 * Recorded here as a deliberate divergence rather than silently absorbed, in the same
 * shape as the additive `attempts` field below.
 *
 * WHY THE CONTRACT'S TWO VALUES ARE NOT ENOUGH. `report.json` was written ONCE, after
 * the attempts, so a run that died earlier left the PREVIOUS run's `"verdict": "pass"`
 * on disk. Measured on 2026-08-11: with `tenants_self_select` altered to `USING (true)`,
 * the fixture threw in `beforeAll` — the F-293 absolute census assertion doing exactly
 * its job — vitest exited 1 with all 15 tests skipped, and `report.json` still read
 * `verdict=pass runAt=<the previous run's timestamp>`. The most alarming failure this
 * harness has is now precisely the one that strands a stale pass.
 *
 * `incomplete` is written BEFORE anything that can throw and overwritten at the end, so
 * the artifact is either this run's answer or an explicit statement that this run did
 * not finish. It is never the last run's answer.
 *
 * SEQUENCING, NAMED BY THE AUDITOR: this lands BEFORE F-297's CI upload. Upload the
 * artifact first and CI starts publishing a stale pass as evidence.
 *
 * ============================================================================
 * F-331. AND THE OTHER HALF: THE WINDOW *AFTER* THE WRITE WAS OPEN TOO.
 * ============================================================================
 *
 * F-304 closed "a stale pass from a previous run". It left "a confident pass from THIS
 * run that this run then disproved". `writeIsolationReport()` was the last statement in
 * `beforeAll`, and ELEVEN OF THE EIGHTEEN TESTS RUN AFTER IT — the protection-count
 * assertions, all seven control runs, both drift probes, the refusal roster, and
 * `assertNoTenantIdAltered()`. None of them could reach the artifact.
 *
 * MEASURED, in the same run that reproduced F-330: `Tests 1 failed | 17 passed (18)`,
 * EXIT=1, and `report.json` read `verdict=pass attempts=28 failed=[]` FOR THAT RUN. The
 * suite is strictly stronger than its own report, because `verdict` was computed from
 * the attempt judgements alone. The most alarming case is `assertNoTenantIdAltered()`
 * failing — a row changed tenant across the run — which is BY CONSTRUCTION something no
 * attempt judged.
 *
 * So the artifact is now written TWICE AND ONLY TWICE, and neither write can produce a
 * `pass` that the suite goes on to contradict:
 *
 *   1. at module scope, before anything            -> verdict `incomplete`, no attempts
 *   2. at the end of `beforeAll`, after the run    -> verdict STILL `incomplete`, and
 *                                                     the attempts, so a process killed
 *                                                     mid-suite strands the data without
 *                                                     stranding a verdict
 *   3. in `afterAll`, which vitest runs after every test in the file and ALSO runs when
 *      `beforeAll` threw (measured)                -> the final verdict, which is the
 *                                                     CONJUNCTION of the attempt
 *                                                     judgement and what the runner
 *                                                     observed of this file's tests
 *
 * THE BOUND, STATED RATHER THAN OVERCLAIMED. `verdict: 'pass'` on disk implies every
 * attempt passed AND every test in THIS FILE passed. It cannot imply the process exited
 * 0: a failure in another spec file exits the process non-zero and is invisible from
 * here. `suiteOutcome` carries the half this file can observe, so an uploader that wants
 * the stronger property keys on the job's exit code as well.
 */
export type IsolationVerdict = 'pass' | 'fail' | 'incomplete';

/** F-331. What the test runner observed of this file's own tests. */
export type SuiteOutcome = 'pass' | 'fail' | 'incomplete';

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
  /**
   * F-294, F-295. Surfaces that were attempted and proved nothing: the database refused
   * for a reason that was not a policy, or the premise the attempt needed did not hold.
   * A run with any of these is `fail`, for the same reason `uncovered` is.
   */
  unverified?: SurfaceId[];
  /**
   * F-296. Tables carrying a tenant boundary that the registry does not know about, and
   * registered tables the database does not have. Both directions fail the run.
   */
  registryDrift?: RegistryDatabaseDrift;
  excluded: ReadonlyArray<{ id: SurfaceId; justification: string }>;
  publicRoutes: ReadonlyArray<{ id: SurfaceId; justification: string }>;
  noTenantTransactionRoutes: ReadonlyArray<{ id: SurfaceId; justification: string }>;
  /** Covered by named integration tests rather than by enumeration. */
  unenumerable: ReadonlyArray<{ id: string; reason: string; coveredBy: string }>;
  /**
   * F-343. How many of this file's tests the runner had reported a result for when the
   * verdict was computed. `suiteOutcome` is a conjunction over exactly this many tests,
   * and until r4 nothing pinned the number: the mechanism filtered one level of tasks, so
   * a test nested in a `describe` was silently uncounted and a red file could publish a
   * green verdict. A reader of the artifact can now check the count.
   */
  observedTests?: number;
  /** Stated in the artifact itself, so a reader of report.json sees the boundary. */
  coverageBoundary: string;
  /**
   * F-331. THE JUDGEMENT OVER THE ATTEMPTS ALONE — what `verdict` used to mean, and
   * what the control runs in the suite assert against. Kept as its own field so that
   * `verdict` can be the stronger, conjoined answer without losing this one.
   */
  attemptVerdict?: 'pass' | 'fail';
  /**
   * F-331. What the runner observed of this file's tests. `incomplete` until `afterAll`
   * has run, which is also what a killed process leaves behind.
   */
  suiteOutcome?: SuiteOutcome;
  /**
   * F-331. In `report.json` this is the CONJUNCTION of `attemptVerdict` and
   * `suiteOutcome`: `pass` only when both are. On the in-memory report that
   * `runCrossTenantAttempts()` returns it is the attempt judgement alone, because that
   * is the question a control run is asking.
   */
  verdict: IsolationVerdict;
  /** F-304. Present iff the verdict is `incomplete`: what the artifact is not saying. */
  incompleteBecause?: string;
}

/**
 * ============================================================================
 * EXACTLY THREE. A fourth fails the length assertion in the suite.
 * Raising this number requires a written justification (ADR-0020).
 * ============================================================================
 *
 * Raised from two to three on 2026-08-14 by ADR-0045, which is that justification. The
 * third entry is the token-mint membership lookup: `tid` must be in every token, it comes
 * from a tenant-scoped table, and at mint time no tenant is known — so neither
 * `withTenantTransaction` nor a plain `databaseTransaction` can produce it.
 *
 * Two of the three surfaces do not exist yet — `RedirectReadRepository` is TASK-029's and
 * `PrivilegedTenantEraser` is TASK-054's. `TenantMembershipLookup` DOES exist, from this
 * wave, at `apps/api/src/auth/tenant-id-for-user.ts`. The list is carried whether or not
 * a surface is built, because the LENGTH is the control: a new entry has to arrive as a
 * visible one-line diff, and it cannot do that against a list that does not exist.
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
  {
    id: 'repo:TenantMembershipLookup.tenantIdForUser' as SurfaceId,
    justification:
      'Token minting runs before a tenant is known: the claim this reads produces is what a tenant context is later opened from. Narrowed by ADR-0045 to a FOR SELECT policy admitting one user_id, inside a READ ONLY transaction, in one file. Reachable only from definePayload.',
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
    // TASK-014: repointed at the signup hook's integration test, which ships this
    // initiative and exists. The uninvited branch — signup creates a tenant that is the
    // generated uuid and one membership in it — is what `signup-creates-tenant.int-spec.ts`
    // asserts, and it is the one anonymous path that writes `tenant_memberships`.
    coveredBy: 'apps/api/test/auth/signup-creates-tenant.int-spec.ts',
  },
  {
    id: 'handler:POST /api/gdpr/delete authorization',
    reason: '@NoTenantTransaction moves the owner check into the handler (F-020).',
    coveredBy: 'apps/api/test/gdpr/delete-authorization.int-spec.ts',
  },
] as const;

/** Reproduced verbatim into `report.json`, so the artifact SC-1 points at is not read as stronger than it is. */
export const COVERAGE_BOUNDARY =
  'TASK-015, wave 9. This run covers FOUR TABLES and FOUR AUTHENTICATED ENDPOINTS, in ' +
  'TWO ATTEMPT CATEGORIES. ' +
  'THE FOUR TABLES, attacked as SQL through withTenantTransaction as shortkit_app: ' +
  '`tenants` (the migrated cascade root, four bespoke policies), `rls_fixture_rows` (a ' +
  'FIXTURE TABLE this suite creates and drops per run, built from the production ' +
  'tenantScopedPolicies()), `tenant_memberships` (migrated, TASK-002 — carrying the ' +
  'token-mint FOR SELECT escape as a third policy), and `workspaces` (migrated, TASK-011 ' +
  '— attacked both as a table and through the five methods of WorkspaceRepository). Each ' +
  'is hit with EIGHT statement shapes in BOTH directions; three of the eight carry NO ' +
  'WHERE CLAUSE (F-302) and one of those assigns the owner column (F-330). ' +
  'THE FOUR ENDPOINTS, attacked as authenticated HTTP requests by a second signed-in ' +
  'operator against the composition root (TASK-014, SC-4): `POST /api/workspaces`, ' +
  '`GET /api/workspaces`, `PATCH /api/workspaces/:id` and `POST /api/workspaces/:id/archive`. ' +
  'Two real users, two real memberships and two real tokens are minted through the shipped ' +
  'auth surface — not forged — and each route is attempted in both directions. A 404 or ' +
  '403 counts as a pass ONLY when the OWNER of the addressed row succeeds (2xx) at the ' +
  'same request in the same run: otherwise the id or the route is wrong, the refusal ' +
  'proves nothing, and the attempt is `unverified` and red. A mutating attempt is verified ' +
  'against the DATABASE, never the response body. ' +
  'THE SET WAS REGISTERED BY HAND, NOT DISCOVERED. There is no route or repository ' +
  'enumeration in this wave: the table subjects are the registry in registrations.ts and ' +
  'the endpoint subjects are a hand-written list of EndpointAttemptSpecs. A ROUTE NOBODY ' +
  'REGISTERED IS A ROUTE NOBODY ATTACKED — module-graph route discovery, the ' +
  '@TenantScopedRepository decorator enumeration, the four grep clauses and the ' +
  'pg_policies shape assertion are all TASK-056\'s and unbuilt. What keeps the TABLE ' +
  'registry honest is the database cross-check: a relation in schema public must be ' +
  'registered if ANY of FIVE independent properties holds — it is `tenants`; it carries a ' +
  'column named tenant_id; row-level security is enabled AND forced on it; one of its ' +
  'policies reads app.tenant_id; or it declares a FOREIGN KEY to tenants(id) — and a ' +
  'difference in either direction fails the run and names the table (ADR-0019, SQL half). ' +
  'That cross-check does NOT reach routes: a controller nobody registered is invisible to ' +
  'it, which is the endpoint half of the same "registered by hand" bound. ' +
  'WHAT A PASS MEANS: every registered method and endpoint was attempted in both ' +
  'directions, each acting tenant was shown to own a row first, every refusal scored as a ' +
  'pass was a recognised refusal (a row-level security SQLSTATE for a table attempt, an ' +
  'owner-verified 404/403 for an endpoint attempt), and no tenant could see or change a ' +
  'row it does not own before or after any attempt. An attempt that proved nothing is ' +
  '`unverified` and fails the run. ' +
  'WHAT THIS RUN STILL DOES NOT PROVE. Coverage is bounded by the shapes someone thought ' +
  'of — Juano\'s 2026-08-11 ruling — and this initiative adds a whole new attempt ' +
  'category (HTTP) to that same bound rather than escaping it. FIVE STATEMENT SHAPES ' +
  'F-341 NAMES ARE NOT BUILT: INSERT ... ON CONFLICT DO UPDATE (the save()/upsert() idiom, ' +
  'reaching the UPDATE policy\'s USING on conflict); MERGE (each WHEN branch a different ' +
  'policy); eviction, UPDATE <t> SET <owner> = <a tenant the fixture never seeds> (the ' +
  'count rule detects it but the digest cannot name the recipient); cascade and trigger ' +
  'effects on a SIBLING table (bounded today only because tenants has no ordinary DELETE ' +
  'policy); and SELECT ... FOR UPDATE / FOR SHARE (a locking read applies the UPDATE ' +
  'policy\'s USING, an existence side channel). ISOLATION_EXCLUSIONS carries the surfaces ' +
  'deliberately outside the tenant-facing interface — redirect resolution, GDPR erasure, ' +
  'and the token-mint membership lookup — each narrowed by database policy and justified ' +
  'in-file; the LENGTH of that list is the control, so a new exclusion arrives as a ' +
  'one-line diff a reviewer sees. And most of the system is simply unwritten: there are ' +
  'no `links`, `domains` or `click_events` tables and no other authenticated routes.';

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

/**
 * ============================================================================
 * F-296. THE REGISTRY IS CROSS-CHECKED AGAINST THE DATABASE.
 * ============================================================================
 */

export interface RegistryDatabaseDrift {
  /** Tenant-scoped in the database, registered nowhere. The suite is blind to these. */
  readonly inDatabaseNotRegistered: string[];
  /** Registered here, absent from the database or no longer tenant-scoped. */
  readonly registeredNotInDatabase: string[];
}

/**
 * The suite's own tables, which are built and dropped by a run and are therefore not
 * part of the schema the registry describes. A CLOSED LIST, for the same reason
 * `ISOLATION_EXCLUSIONS` is one: naming a real table here is the way to hide it from
 * SC-1, and it has to be a one-line diff a reviewer sees. `rls_fixture_rows` is NOT
 * here — it is registered, and it is attempted.
 */
export const SUITE_OWNED_CONTROL_TABLES: readonly string[] = [
  'isolation_leak_canary',
  'isolation_direction_canary',
  'isolation_baseline_leak_canary',
  'isolation_grant_gap_canary',
  'isolation_masked_refusal_canary',
  'isolation_half_seeded_canary',
  'isolation_unqualified_write_canary',
  // F-346, found in r4. `isolation_owner_theft_canary` shipped in r3 and was never added
  // here, so every control run that had built it also reported it as registry drift —
  // and `attemptVerdict` is `fail` whenever drift is non-empty, whatever the attempts
  // said. The F-330 control's `expect(control.verdict).toBe('fail')` was therefore
  // satisfied by the omission rather than by the policies, measured:
  // `inDatabaseNotRegistered: ["isolation_owner_theft_canary"]`. A control table missing
  // from this list turns every later control's verdict assertion into a tripwire for the
  // list itself, which is the same class as the F-294 refusal roster firing for the wrong
  // reason. The F-344 control — the one that must come back `pass` — is what now fails
  // when this list is incomplete.
  'isolation_owner_theft_canary',
  'isolation_pk_owner_canary',
  'isolation_guarded_check_canary',
  // F-352. Its leaky twin: the same stricter WITH CHECK, over a wide-open USING.
  'isolation_guarded_leak_canary',
  // F-133. The token-mint escape's policy in three shapes — the production predicate and
  // two widenings of it. They carry `tenant_id` and a foreign key to `tenants`, so the
  // drift check names them like any other tenant-scoped table, and the F-346 rule applies:
  // a control table missing from this list turns every later control's verdict assertion
  // into a tripwire for the list rather than for the policies.
  'isolation_membership_lookup_canary',
  'isolation_membership_lookup_wide_open_canary',
  'isolation_membership_lookup_flag_gated_canary',
  // TASK-015. The endpoint-level negative control (AC-31): a workspaces-shaped table with
  // ENABLE ROW LEVEL SECURITY omitted, reached through an in-test control endpoint. Built
  // and dropped inside its own test, so the main run never sees it — but the control run's
  // own drift check would, and the F-346 rule requires its `fail` to be the attempts' answer
  // and not a drift tripwire, so it is exempted here like every other control table.
  'isolation_endpoint_control_canary',
];

/**
 * ADR-0019's cross-check, SQL half, pulled forward: enumerate the tables that carry a
 * tenant boundary FROM THE DATABASE and compare with the registry. TASK-053's
 * `tenantScopedTables()` is the schema half and is deferred; this half needs no artifact
 * that does not exist.
 *
 * ============================================================================
 * F-303. FOUR PROPERTIES, NOT ONE, AND NONE OF THEM ASSUMES A COLUMN NAME.
 * ============================================================================
 *
 * r1 added this check on the literal column name `tenant_id`, which is the same
 * assumption ADR-0019 itself records under "Negative / accepted cost": *"the enumeration
 * depends on the column being named exactly `tenant_id`. A table using `owner_tenant_id`
 * is invisible to both the schema filter and the SQL cross-check, and nothing notices."*
 * The auditor measured the consequence against this harness: `audit_events(owning_tenant)`
 * with ENABLE + FORCE and a `USING (true)` policy leaks `bob@tenant-b.example` to tenant
 * A — reproduced here on 2026-08-11 — while the suite is 15 passed, `registryDrift` is
 * empty in both directions, `db:check-policies` reports "OK: 2 table(s) ... all protected"
 * and the table is named in no artifact.
 *
 * The registry already carries an `ownerColumn` per table, so the harness has always
 * known the column can vary. The drift query was the one place that assumed it could not.
 * The four arms below are independent, and defeating the check means defeating all four:
 *
 *   1. `tenants`, the cascade root — tenant-scoped and carrying no tenant column at all,
 *      named exactly as ADR-0019's exclusion list names it.
 *   2. a column literally named `tenant_id`. KEPT, because it is the only arm that sees
 *      a table with NO row-level security whatsoever — the `isolation_leak_canary`
 *      shape, and the one `scripts/check-policies.mts` exists for.
 *   3. row-level security ENABLED AND FORCED. Column-name agnostic, and the arm that
 *      catches the measured `audit_events(owning_tenant)` case.
 *   4. a policy whose predicate reads `app.tenant_id`, whatever it compares it against.
 *      Catches a table protected by a tenant policy that arm 3 would miss because FORCE
 *      was forgotten — which is a leak in its own right and one this arm names.
 *
 * ARM 5, ADDED FOR F-333, IS THE ONE THAT DOES NOT DEPEND ON PROTECTION OR ON A NAME.
 * Arms 3 and 4 are properties of a table being PROTECTED, so the re-audit measured what
 * they cannot see: three probes, each with owner column `owning_tenant` and each leaking
 * `bob@tenant-b.example` to tenant A —
 *
 *   wave3_audit_norls    no RLS at all                    -> arms 1-4: NOT NAMED
 *   wave3_audit_noforce  ENABLE, no FORCE, USING (true)   -> arms 1-4: NOT NAMED
 *   wave3_audit_forced   ENABLE + FORCE, USING (true)     -> arms 1-4: named, by arm 3
 *
 * The unprotected shape is the WORST one, and it was invisible to every arm except the
 * literal column name F-303 was filed against. `db:check-policies` did catch the other
 * two and `ci.yml` runs it first, so the composite gate held — but that made this check
 * neither second nor independent for that shape, which is what its own header claimed.
 *
 * 5. a FOREIGN KEY to `tenants(id)`. That is the property every tenant-scoped table in
 *    this schema actually has: `TENANT_ID_COLUMN_SQL` in `src/db/rls.ts` declares
 *    `REFERENCES tenants(id) ON DELETE CASCADE`, ADR-0019 requires it of every schema
 *    TASK, and AC-90's residue check depends on it. It holds whatever the column is
 *    called and whether or not anyone remembered to protect the table.
 *
 * WHAT STILL ESCAPES ALL FIVE, STATED SO THE CLAIM IS NOT READ AS STRONGER THAN IT IS:
 * a table that is not `tenants`, spells its owner column something other than
 * `tenant_id`, declares NO foreign key to `tenants`, carries no policy reading
 * `app.tenant_id`, and is not force-RLS'd. That table violates ADR-0019's stated
 * convention in three independent ways at once, and nothing here would name it.
 *
 * ACCEPTED COST, STATED. Arms 3 and 4 are properties of protection rather than of
 * tenancy, so a table force-RLS'd for some other reason — a future audit log locked to
 * one role, say — would be reported as drift, and so would a table with a foreign key to
 * `tenants` that carries no tenant's data. That fails CLOSED: the run goes red and names
 * the table, and the remedy is a registration or a justified entry in a closed list,
 * both of which are one-line diffs a reviewer sees. The alternative failed OPEN, and
 * this file has now measured that twice.
 */
export function tenantScopedTableDrift(
  registrations: readonly TenantScopedSurfaceRegistration[] = registeredSubjects(),
): RegistryDatabaseDrift {
  // `relkind` 'r' is an ordinary table and 'p' a partitioned one, matching
  // scripts/check-policies.mts. `pg_attribute` rather than `information_schema.columns`
  // for the reason that script records at F-213.
  const tables = querySql<{ table_name: string }>(
    migrationDsn(),
    `select c.relname as table_name
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
        and c.relkind in ('r', 'p')
        and (
             -- 1. the cascade root
             c.relname = 'tenants'
             -- 2. the conventional owner column
             or exists (select 1
                          from pg_attribute a
                         where a.attrelid = c.oid
                           and a.attname = 'tenant_id'
                           and a.attnum > 0
                           and not a.attisdropped)
             -- 3. F-303: protected, whatever its owner column is called
             or (c.relrowsecurity and c.relforcerowsecurity)
             -- 4. F-303: a policy that reads the tenant context flag
             or exists (select 1
                          from pg_policies p
                         where p.schemaname = 'public'
                           and p.tablename = c.relname
                           and (coalesce(p.qual, '') like '%app.tenant_id%'
                                or coalesce(p.with_check, '') like '%app.tenant_id%'))
             -- 5. F-333: a foreign key to tenants(id). Independent of protection AND of
             --    the column's name — the only arm that sees an UNPROTECTED table whose
             --    owner column is not called tenant_id, which is the worst shape.
             or exists (select 1
                          from pg_constraint fk
                         where fk.conrelid = c.oid
                           and fk.contype = 'f'
                           and fk.confrelid = 'public.tenants'::regclass)
            )`,
  ).map((row) => row.table_name);

  const inDatabase = new Set(
    tables.filter((table) => !SUITE_OWNED_CONTROL_TABLES.includes(table)),
  );
  const registered = new Set(registrations.map((registration) => registration.table));

  return {
    inDatabaseNotRegistered: [...inDatabase].filter((table) => !registered.has(table)).sort(),
    registeredNotInDatabase: [...registered].filter((table) => !inDatabase.has(table)).sort(),
  };
}

export function surfaceIdOf(subject: string, method: string): SurfaceId {
  return `repo:${subject}.${method}`;
}

/**
 * The id a method contributes to the report: its own `route:` id when it is an HTTP
 * attempt (TASK-014), the `repo:` id built from the subject and the method name otherwise.
 */
function methodSurfaceId(
  registration: TenantScopedSurfaceRegistration,
  method: TenantScopedMethod,
): SurfaceId {
  return method.surfaceId ?? surfaceIdOf(registration.subject, method.name);
}

/** Every surface the registry knows about, in the shape the contract's report declares. */
export function discoveredSurfaces(
  registrations: readonly TenantScopedSurfaceRegistration[] = registeredSubjects(),
): DiscoveredSurface[] {
  return registrations.flatMap((registration) =>
    registration.methods.map((method): DiscoveredSurface => {
      const id = methodSurfaceId(registration, method);

      return {
        id,
        // A `route:` id is an HTTP endpoint attempt (TASK-014); everything else runs
        // inside a tenant transaction as a repository-shaped surface.
        kind: id.startsWith('route:') ? 'route' : 'repository-method',
        // Every method here is behind the guard or the tenant transaction, which is what
        // `authenticated` means for these surfaces.
        authenticated: true,
      };
    }),
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

  const baseline = await censusRows(registeredSubjects(), fixtures);

  // F-295. An empty census is the state in which every attempt in the run passes
  // vacuously: no row is returned because no row exists, or because the tenant context
  // never reached the database. Neither is isolation.
  if (baseline.length === 0) {
    throw new Error(
      'the ownership census is empty before any attempt has run. Either no subject is ' +
        'registered, or neither tenant can see a row it owns — in which case every ' +
        'cross-tenant attempt below would return zero rows whatever the policies say.',
    );
  }

  // F-293. The ABSOLUTE assertion, not the differential one: a leak that is already
  // present when the fixture is built is identical before and after every attempt.
  const leaks = censusLeaks(baseline);

  if (leaks.length > 0) {
    throw new Error(`the fixture leaks before any attempt has run:\n  - ${leaks.join('\n  - ')}`);
  }

  ownershipBaseline = baseline.map(censusLine).sort();

  return fixtures;
}

interface CensusRow {
  readonly table: string;
  readonly seenBy: string;
  readonly id: string;
  readonly owner: string;
  /**
   * F-302. `md5(<row>::text)` over the WHOLE row, computed by the database. An overwrite
   * PRESERVES OWNERSHIP — `UPDATE tenants SET name = 'pwned-by-tenant-A'` leaves every
   * `id` and every owner exactly where they were — so a census of ids and owners is
   * identical before and after a tenant has destroyed another tenant's data. The digest
   * is what makes that visible, and it needs no per-registration configuration: it
   * covers every column the table has, including columns a later TASK adds.
   */
  readonly digest: string;
}

/** Ownership only. `assertNoTenantIdAltered()` is defined over exactly this (AC-95). */
function censusLine(row: CensusRow): string {
  return `${row.table} seen-by=${row.seenBy} id=${row.id} owner=${row.owner}`;
}

/** Ownership AND content. What the per-attempt comparison is defined over (F-302). */
function censusContentLine(row: CensusRow): string {
  return `${censusLine(row)} digest=${row.digest}`;
}

/**
 * F-302. The census lines for rows the ACTOR DOES NOT OWN, which is the set an attempt
 * may not change by any amount.
 *
 * The actor's own rows are excluded DELIBERATELY, and this is the clause that lets an
 * unqualified write be attempted at all: `DELETE FROM rls_fixture_rows` issued in tenant
 * A's transaction is SUPPOSED to remove A's own row, and comparing all rows either side
 * of it would report correct behaviour as a leak. Nothing is lost by the exclusion — a
 * row that moved from the actor to anyone else APPEARS in this set afterwards, and a row
 * that moved the other way DISAPPEARS from it, so both directions of a re-parenting are
 * still caught.
 */
function foreignRowLines(rows: readonly CensusRow[], actor: TenantFixture): string[] {
  return rows
    .filter((row) => !sameTenant(row.owner, actor.id))
    .map(censusContentLine)
    .sort();
}

function sameTenant(one: string, other: string): boolean {
  return one.toLowerCase() === other.toLowerCase();
}

/**
 * F-293. Every census line where the tenant that could SEE a row is not the tenant that
 * OWNS it. The harness computed these lines from the first day and compared them only
 * before-versus-after an attempt, which is blind to a leak that is already there — and
 * blind to a leak visible only to the tenant that never acted.
 */
function censusLeaks(rows: readonly CensusRow[]): string[] {
  return rows
    .filter((row) => !sameTenant(row.seenBy, row.owner))
    .map(
      (row) =>
        `tenant ${row.seenBy} could see a row it does not own before this attempt ran: ` +
        `${censusLine(row)}`,
    );
}

async function censusRows(
  registrations: readonly TenantScopedSurfaceRegistration[],
  fixtures: TenantFixtures,
): Promise<CensusRow[]> {
  const census: CensusRow[] = [];

  for (const registration of registrations) {
    for (const tenant of [fixtures.tenantA, fixtures.tenantB]) {
      const rows = await withTenantTransaction(tenant.id, async (db) => {
        const result = await db.execute<Record<string, unknown>>(
          sql`select r.id                              as id,
                     r.${sql.identifier(registration.ownerColumn)} as owner,
                     md5(r::text)                      as digest
                from ${sql.identifier(registration.table)} as r
               order by r.id`,
        );

        return result.rows;
      });

      for (const row of rows) {
        census.push({
          table: registration.table,
          seenBy: tenant.id,
          id: String(row.id),
          owner: String(row.owner),
          digest: String(row.digest),
        });
      }
    }
  }

  return census;
}

/**
 * Who owns what, read through the policies themselves: one tenant transaction per
 * tenant per table, each returning the row ids that tenant can see. A row that moved
 * from B to A appears in A's half and disappears from B's; a row that was deleted
 * disappears from both.
 *
 * Deliberately NOT read as the migrator with RLS off. The census is what the tenants
 * can see, and the transaction it runs in is the same production path the attempts use.
 *
 * TWO THINGS ARE ASSERTED OVER IT, AND THE SECOND WAS MISSING UNTIL r2 (F-293). The
 * differential one — this census before an attempt against the same census after it —
 * catches a row that MOVED. The absolute one, `censusLeaks()`, catches a row that was
 * already visible to a tenant that does not own it: seen-by must equal owner on every
 * line. A leak present at baseline is identical before and after every attempt, so the
 * differential comparison can never see it, and it is the shape a directional policy
 * defect produces.
 */
export async function tenantOwnershipCensus(
  registrations: readonly TenantScopedSurfaceRegistration[],
  fixtures: TenantFixtures,
): Promise<string[]> {
  return (await censusRows(registrations, fixtures)).map(censusLine).sort();
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
  method: TenantScopedMethod,
  actor: TenantFixture,
  target: TenantFixture,
  result: CrossTenantAttemptResult,
  actorOwnRowsVisible: number,
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

  if (method.kind !== 'write') {
    return leaks;
  }

  if (method.qualification === 'owner-qualified') {
    // Every row this statement can reach belongs to the target, so any row at all is
    // the leak. The rule since r1, unchanged.
    if (affected > 0) {
      leaks.push(
        `affected ${String(affected)} row(s) while acting as ${actor.id} against ` +
          `${target.id}; a cross-tenant write must be rejected or affect zero rows (AC-95)`,
      );
    }

    return leaks;
  }

  // F-302. THE COMMAND TAG IS THE EVIDENCE, AND IT ARRIVES BEFORE ANY CENSUS RUNS.
  //
  // An unqualified statement is entitled to every row the ACTOR owns and to nothing
  // else, so the number the database reports is comparable against a number the harness
  // established through the actor's own transaction moments earlier. `UPDATE 2` from a
  // single-tenant context that can see one row of its own is the leak, stated in the
  // one place a wide-open UPDATE or DELETE policy cannot hide it: the SELECT policy
  // never gets consulted, because there is no column reference for it to filter.
  if (affected > actorOwnRowsVisible) {
    leaks.push(
      `an UNQUALIFIED ${method.kind} (${method.name}, no WHERE clause) reported ` +
        `${String(affected)} row(s) affected while the acting tenant ${actor.id} can see ` +
        `only ${String(actorOwnRowsVisible)} row(s) of its own in ${registration.table}. ` +
        `At least ${String(affected - actorOwnRowsVisible)} row(s) belonging to another ` +
        `tenant were written — ${target.id} is the only other tenant seeded in this ` +
        'fixture. PostgreSQL routes an owner-qualified write through the SELECT policy ' +
        'and this statement past it, so this count is the only thing that sees a ' +
        'wide-open UPDATE or DELETE policy (F-302, AC-95).',
    );
  }

  return leaks;
}

/**
 * F-294. THE MESSAGE SURVIVES, AND THE CODE ALONE IS NOT ENOUGH.
 *
 * The previous form returned `${name} [${code}]` and DROPPED the message whenever a
 * SQLSTATE was present. Both auditors measured the consequence independently: an RLS
 * `WITH CHECK` violation and `permission denied for table ...` are both 42501, so both
 * rendered as the identical string `error [42501]` — which is what `report.json` carried
 * for two of the ten attempts. A refusal that cannot be told apart from a missing grant
 * is not evidence that a policy refused anything.
 *
 * So the classification needs the message as well as the code, and it is deliberately
 * narrow: PostgreSQL raises `new row violates row-level security policy` for a WITH
 * CHECK denial and nothing else does. Anything the harness does not recognise is
 * `unrecognised`, which makes the attempt `unverified` rather than a pass.
 */
const ROW_LEVEL_SECURITY_REFUSAL = /violates row-level security policy/i;

interface Refusal {
  readonly description: string;
  readonly kind: 'row-level-security' | 'unrecognised';
}

function classifyRefusal(error: unknown): Refusal {
  if (!(error instanceof Error)) {
    return { description: String(error), kind: 'unrecognised' };
  }

  const code = (error as { code?: string }).code;
  const description = `${error.name}${code === undefined ? '' : ` [${code}]`}: ${error.message}`;

  return {
    description,
    kind:
      code === '42501' && ROW_LEVEL_SECURITY_REFUSAL.test(error.message)
        ? 'row-level-security'
        : 'unrecognised',
  };
}

/**
 * F-295. THE PREMISE AN ATTEMPT NEEDS BEFORE ITS ANSWER MEANS ANYTHING.
 *
 * Most of the statement shapes return zero rows when the target owns no row,
 * whatever the policy says, and every one of them returns zero rows if the tenant
 * context never reached the database. Both are indistinguishable from a denial unless
 * the harness establishes, through the tenants' own transactions, that there was
 * something to deny and someone to deny it to.
 *
 * Read through the census that is already taken before every attempt, so this costs no
 * extra round trip.
 */
function premiseFailure(
  registration: TenantScopedSurfaceRegistration,
  method: TenantScopedMethod,
  actor: TenantFixture,
  target: TenantFixture,
  actorOwnRowsVisible: number,
  targetOwnRowsVisible: number,
): string | undefined {
  if (actorOwnRowsVisible === 0) {
    return (
      `the acting tenant ${actor.id} could see no row of its own in ${registration.table}, ` +
      'so this attempt proves nothing: a statement that returns zero rows or is refused ' +
      'looks the same whether the policy denied it or the tenant context never reached ' +
      'the database (F-295). Seed a row for both tenants in this table.'
    );
  }

  if (method.reaches !== 'new-row' && targetOwnRowsVisible === 0) {
    return (
      `the target tenant ${target.id} owns no row in ${registration.table}, so a ` +
      'statement reaching an existing row returns nothing whether or not any policy ' +
      'exists (F-295). "Denied" and "found nothing" are not the same answer.'
    );
  }

  return undefined;
}

/**
 * Runs one method in one direction and judges it. Never throws for a leak — it RECORDS
 * one, so a run reports every method rather than stopping at the first (AC-12, AC-96).
 *
 * THREE OUTCOMES, NOT TWO. `unverified` is what an attempt gets when it neither leaked
 * nor proved anything: the database refused it for a reason that was not a policy, or
 * the premise above did not hold. It fails the run and names the surface, in the same
 * shape as `uncovered` — the alternative is what r1 measured, a green report over
 * surfaces that were never tested.
 */
async function attempt(
  registration: TenantScopedSurfaceRegistration,
  method: TenantScopedMethod,
  fixtures: TenantFixtures,
  direction: AttemptDirection,
): Promise<AttemptOutcome> {
  const [actor, target] =
    direction === 'A->B'
      ? [fixtures.tenantA, fixtures.tenantB]
      : [fixtures.tenantB, fixtures.tenantA];

  await registration.reset();

  const beforeRows = await censusRows([registration], fixtures);
  const before = foreignRowLines(beforeRows, actor);

  const actorOwnRowsVisible = beforeRows.filter(
    (row) => sameTenant(row.seenBy, actor.id) && sameTenant(row.owner, actor.id),
  ).length;
  const targetOwnRowsVisible = beforeRows.filter(
    (row) => sameTenant(row.seenBy, target.id) && sameTenant(row.owner, target.id),
  ).length;

  const common = {
    id: methodSurfaceId(registration, method),
    subject: registration.subject,
    method: method.name,
    table: registration.table,
    kind: method.kind,
    direction,
    actor: actor.id,
    target: target.id,
    qualification: method.qualification,
    actorOwnRowsVisible,
    targetOwnRowsVisible,
  } as const;

  // F-293. The absolute census assertion, applied per attempt so a red run names the
  // surface and the table rather than only the run.
  const leaks = censusLeaks(beforeRows);
  const unverifiedBecause = premiseFailure(
    registration,
    method,
    actor,
    target,
    actorOwnRowsVisible,
    targetOwnRowsVisible,
  );

  let result: CrossTenantAttemptResult;

  try {
    result = await method.attempt(actor, target);
  } catch (error) {
    const refusal = classifyRefusal(error);
    // ========================================================================
    // WHAT A REFUSAL IS EVIDENCE OF, AND F-330: IT DEPENDS ON THE STATEMENT.
    // ========================================================================
    //
    // RLS NEVER REFUSES A SELECT — it returns zero rows. A read that threw did not run,
    // so whatever it proves, it is not that a policy denied it (F-294).
    //
    // AND A REFUSAL PROVES THE WITH CHECK HELD, NOT THAT THE USING DID. Those are
    // different halves of a policy and they answer different questions: USING decides
    // WHICH EXISTING ROWS the statement may reach, WITH CHECK decides WHAT THE RESULTING
    // ROW MAY LOOK LIKE. For an owner-qualified write the distinction does not matter —
    // the statement names the target, so a refusal on any ground means the target's row
    // was not written. For an UNQUALIFIED write it is the whole question: the statement
    // sweeps every row the USING clause admits, and a WITH CHECK refusal on the FIRST
    // foreign row it reaches is exactly what a wide-open USING with a correct WITH CHECK
    // produces.
    //
    // MEASURED, on the migrated production table. `ALTER POLICY tenants_self_update ON
    // tenants USING (true)` — WITH CHECK left exactly as the migration wrote it — and:
    //
    //   pass  A->B  updateAll  (write on tenants, affected 0)
    //         — refused: error [42501]: new row violates row-level security policy
    //   pass  B->A  updateAll  — the same
    //   report.json: verdict=pass, failed=[], unverified=[], 28 attempts
    //
    // Every attempt green over a table whose UPDATE policy admits every row of every
    // tenant. The count rule (F-302) never fires because no row count is ever reported,
    // and the digest never fires because nothing the harness issued changed anything.
    // So an unqualified write that was refused is `unverified`: it proved something, and
    // the something is not the property this suite exists to assert.
    const refusalProvesDenial =
      method.kind === 'write' &&
      refusal.kind === 'row-level-security' &&
      method.qualification === 'owner-qualified';
    const because = refusalProvesDenial
      ? unverifiedBecause
      : method.kind === 'write' &&
          refusal.kind === 'row-level-security' &&
          method.qualification === 'unqualified'
        ? `this UNQUALIFIED write was refused by row-level security: ${refusal.description}. ` +
          'That proves the WITH CHECK clause held. It proves NOTHING about the USING ' +
          'clause, which is the half that decides which existing rows the statement ' +
          'could reach — and an unqualified statement reaches every row USING admits. A ' +
          'wide-open USING with a correct WITH CHECK produces exactly this refusal, and ' +
          'it was measured producing it on the migrated `tenants` table while every ' +
          'attempt in the run scored a pass (F-330). ' +
          'IF THIS TABLE IS CORRECTLY ISOLATED, THE REMEDY IS THE STATEMENT AND NOT THIS ' +
          'RULE (F-344): a WITH CHECK stricter than its USING — a soft-delete guard, an ' +
          'immutability-on-archive predicate, a plan limit — refuses this write on the ' +
          'ACTOR\'S OWN ROW, and `reparentAll` is refused by it identically, so re-issuing ' +
          'as that shape does not help. Give the registration `unqualifiedWritesAlsoSet` ' +
          'naming the columns the check requires; the statement still carries no WHERE ' +
          'clause, so it still reaches every row the USING clause admits and is still ' +
          'judged on its row count. What is NOT available is declaring the table fine: ' +
          'this refusal is evidence about the WITH CHECK and there is no evidence here ' +
          'about the USING.'
        : `the database refused this attempt for a reason the harness cannot attribute to a ` +
          `policy: ${refusal.description}. ` +
          (method.kind === 'read'
            ? 'Row-level security refuses a read by returning zero rows, never by raising, ' +
              'so a read that threw never ran (F-294).'
            : 'Only a row-level security refusal is evidence that a policy denied the write ' +
              '(F-294).');

    if (leaks.length > 0) {
      return {
        ...common,
        outcome: 'fail',
        leaks,
        refusedWith: refusal.description,
        refusalKind: refusal.kind,
      };
    }

    return {
      ...common,
      outcome: because === undefined ? 'pass' : 'unverified',
      leaks,
      refusedWith: refusal.description,
      refusalKind: refusal.kind,
      ...(because === undefined ? {} : { unverifiedBecause: because }),
    };
  }

  leaks.push(...judge(registration, method, actor, target, result, actorOwnRowsVisible));

  const after = foreignRowLines(await censusRows([registration], fixtures), actor);

  if (after.join('\n') !== before.join('\n')) {
    leaks.push(
      `a row belonging to a tenant other than the acting tenant ${actor.id} changed ` +
        'while this method ran: it moved, it was removed, or its contents were ' +
        'overwritten (AC-95, F-302). Each line names the tenant that owns the row.\n' +
        `      before: ${before.join(' | ')}\n      after:  ${after.join(' | ')}`,
    );
  }

  // F-302. An unqualified write that reached the actor's own rows is CORRECT behaviour
  // and it leaves the fixture edited, so the fixture is put back before the run moves
  // on. `reset()` already runs before every attempt, so this only matters for the last
  // attempt of a run — but that is exactly the state `assertNoTenantIdAltered()` and the
  // F-295 positive control read afterwards, and a `DELETE FROM rls_fixture_rows` issued
  // as tenant B legitimately removes B's own row.
  //
  // It costs nothing: a cross-tenant write this restores has ALREADY been judged above,
  // recorded in `leaks`, and reported as a `fail` naming the surface. The post-run check
  // is the contract's weaker form, and the comment on it says so.
  if (method.qualification === 'unqualified' && (result.rowsAffected ?? 0) > 0) {
    await registration.reset();
  }

  const counted = {
    ...common,
    ...(result.rows === undefined ? {} : { rowsSeen: result.rows.length }),
    ...(result.rowsAffected === undefined ? {} : { rowsAffected: result.rowsAffected }),
  };

  if (leaks.length > 0) {
    return { ...counted, outcome: 'fail', leaks };
  }

  return unverifiedBecause === undefined
    ? { ...counted, outcome: 'pass', leaks }
    : { ...counted, outcome: 'unverified', leaks, unverifiedBecause };
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
    .find(({ registration, method }) => methodSurfaceId(registration, method) === surface.id);

  if (found === undefined) {
    throw new Error(
      `${surface.id} has no registered cross-tenant attempt, so it is UNCOVERED. ` +
        'Register one in apps/api/test/isolation/registrations.ts. A surface whose ' +
        'arguments cannot be inferred registers a fixture builder; it is never skipped.',
    );
  }

  for (const direction of ATTEMPT_DIRECTIONS) {
    const outcome = await attempt(found.registration, found.method, fixtures, direction);

    if (outcome.outcome === 'fail') {
      throw new Error(
        `${surface.id} crossed the tenant boundary (${direction}):\n  - ${outcome.leaks.join('\n  - ')}`,
      );
    }

    if (outcome.outcome === 'unverified') {
      throw new Error(
        `${surface.id} (${direction}) proved nothing: ${outcome.unverifiedBecause ?? ''}`,
      );
    }
  }
}

let lastReport: IsolationReport | null = null;

/**
 * TASK-014. One battery of registrations against one pair of tenant fixtures. The table
 * subjects run against the seeded `tenants`/`tenant_memberships`/`workspaces` fixtures;
 * the HTTP endpoint subjects run against the two SIGNED-IN operators, whose tenant ids and
 * tokens are different — so a run can carry both, each group with the fixtures its attempts
 * were built for, and the report combines them.
 */
export interface AttemptGroup {
  readonly registrations: readonly TenantScopedSurfaceRegistration[];
  readonly fixtures: TenantFixtures;
}

/**
 * Runs every registered method and returns the report. Judges; does not assert. The
 * suite is what turns a `fail` verdict into a red test, which is what lets the negative
 * control assert a `fail` without the run dying first.
 */
export async function runCrossTenantAttempts(
  registrations: readonly TenantScopedSurfaceRegistration[],
  fixtures: TenantFixtures,
): Promise<IsolationReport> {
  return runAttemptGroups([{ registrations, fixtures }]);
}

/**
 * TASK-014. Runs several batteries in one report, each against its own fixtures. The
 * SQL table battery and the HTTP endpoint battery act as different pairs of tenants, so
 * they arrive as two groups; the report's `covered`, `failed`, `unverified` and verdict
 * are computed over every attempt in every group together, exactly as a single group was.
 */
export async function runAttemptGroups(
  groups: readonly AttemptGroup[],
): Promise<IsolationReport> {
  const allRegistrations = groups.flatMap((group) => group.registrations);
  const discovered = discoveredSurfaces(allRegistrations);
  const attempts: AttemptOutcome[] = [];

  for (const group of groups) {
    for (const registration of group.registrations) {
      for (const method of registration.methods) {
        // F-293. BOTH DIRECTIONS. One call site attempting `(tenantA, tenantB)` was the
        // blocker r1 found: the actor was always A, so a policy leaking only to B — an
        // "internal tenant" carve-out, a support read, a predicate compared against a
        // hard-coded id — was never attempted at all.
        for (const direction of ATTEMPT_DIRECTIONS) {
          attempts.push(await attempt(registration, method, group.fixtures, direction));
        }
      }
    }
  }

  // One surface id per surface, however many directions it was attempted in.
  const covered = [...new Set(attempts.map((outcome) => outcome.id))];
  const uncovered = discovered
    .filter((surface) => surface.authenticated)
    .map((surface) => surface.id)
    .filter(
      (id) =>
        !covered.includes(id) &&
        !ISOLATION_EXCLUSIONS.some((exclusion) => exclusion.id === id),
    );
  const failed = [
    ...new Set(attempts.filter((o) => o.outcome === 'fail').map((o) => o.id)),
  ];
  const unverified = [
    ...new Set(attempts.filter((o) => o.outcome === 'unverified').map((o) => o.id)),
  ];
  // F-296. Read against the registry, not against `registrations`: drift is a property
  // of what the suite knows about versus what the database holds, and a control run
  // over one canary must not report the whole registry as missing.
  const registryDrift = tenantScopedTableDrift();
  const attemptVerdict =
    failed.length === 0 &&
    unverified.length === 0 &&
    uncovered.length === 0 &&
    registryDrift.inDatabaseNotRegistered.length === 0 &&
    registryDrift.registeredNotInDatabase.length === 0
      ? 'pass'
      : 'fail';

  const report: IsolationReport = {
    runAt: new Date().toISOString(),
    discovered,
    covered,
    uncovered,
    attempts,
    failed,
    unverified,
    registryDrift,
    excluded: ISOLATION_EXCLUSIONS.map((exclusion) => ({ ...exclusion })),
    // TASK-056 fills both from the module graph. No route exists to enumerate.
    publicRoutes: [],
    noTenantTransactionRoutes: [],
    unenumerable: UNENUMERABLE_SURFACES.map((surface) => ({ ...surface })),
    coverageBoundary: COVERAGE_BOUNDARY,
    attemptVerdict,
    // F-331. The attempt judgement alone on the in-memory report — which is the question
    // a control run asks. `finishIsolationReport()` is what conjoins it with what the
    // runner observed before anything reaches disk.
    verdict: attemptVerdict,
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

/**
 * `apps/api/test/isolation/report.json` — the artifact SC-1 points at.
 *
 * F-331. WRITE 2 OF 3, AND IT DELIBERATELY DOES NOT PUBLISH A VERDICT. The attempts are
 * this run's and worth stranding on disk if the process dies mid-suite; the verdict is
 * not, because eleven of this file's tests have yet to run and any of them can disprove
 * it. `finishIsolationReport()` is the only function that ever writes `pass`.
 */
export function writeIsolationReport(report: IsolationReport, path: string): void {
  const inFlight: IsolationReport = {
    ...report,
    verdict: 'incomplete',
    suiteOutcome: 'incomplete',
    incompleteBecause:
      'The attempts below are THIS run\'s and were judged: see `attemptVerdict`. The ' +
      'run itself had not finished when this was written — the control runs, the drift ' +
      'probes, the protection-count assertions and assertNoTenantIdAltered() all run ' +
      'after it, and any of them can disprove an attemptVerdict of `pass`. If you are ' +
      'reading this, the suite did not reach its afterAll: treat `attemptVerdict` as ' +
      'evidence and `verdict` as unanswered (F-331).',
  };

  writeFileSync(path, `${JSON.stringify(inFlight, null, 2)}\n`, 'utf8');
}

/**
 * F-331. WRITE 3 OF 3, FROM `afterAll`, AND THE ONLY ONE THAT CAN SAY `pass`.
 *
 * `suiteOutcome` is what the runner observed of this file's own tests, so the verdict on
 * disk is the conjunction: an attempt battery that passed AND a suite that did not
 * contradict it. A red run can no longer leave a green artifact.
 *
 * `report` is null when `beforeAll` threw — vitest still runs `afterAll` in that case
 * (measured), and there is no report to publish, so the `incomplete` marker stands.
 */
export function finishIsolationReport(
  path: string,
  report: IsolationReport | null,
  suiteOutcome: SuiteOutcome,
  /** F-343. How many tests the conjunction was computed over. Recorded, not trusted. */
  observedTests: number,
): void {
  if (report === null) {
    beginIsolationReport(path, 'the run threw before it judged any attempt.');

    return;
  }

  // Anything that is not an explicit `pass` is a `fail` for the attempt half: there is no
  // third answer once the attempts have been judged, and defaulting the other way is how
  // a report with a missing field would publish a pass.
  const attemptVerdict: 'pass' | 'fail' =
    report.attemptVerdict ?? (report.verdict === 'pass' ? 'pass' : 'fail');
  const verdict: IsolationVerdict =
    suiteOutcome === 'incomplete'
      ? 'incomplete'
      : attemptVerdict === 'pass' && suiteOutcome === 'pass'
        ? 'pass'
        : 'fail';

  const finished: IsolationReport = {
    ...report,
    attemptVerdict,
    suiteOutcome,
    observedTests,
    verdict,
    ...(verdict === 'incomplete'
      ? {
          incompleteBecause:
            'The attempts were judged, but the runner did not report a result for every ' +
            'test in this file — the suite was filtered, skipped, or died (F-331).',
        }
      : { incompleteBecause: undefined }),
  };

  writeFileSync(path, `${JSON.stringify(finished, null, 2)}\n`, 'utf8');
}

/**
 * F-304. WRITE 1 OF 3. CALLED AT MODULE SCOPE, BEFORE ANYTHING THAT CAN THROW.
 *
 * Stamps the artifact `incomplete` so that a run which dies — a fixture that throws on a
 * pre-existing leak, a dropped connection, a killed process — leaves a file that says it
 * did not finish, rather than the last successful run's `"verdict": "pass"`.
 *
 * Deleting the file instead would also be unambiguous and it is what the finding offers
 * as an alternative. This is the stronger of the two: absence is indistinguishable from
 * a job that never ran the suite at all, and a `runAt` plus a reason tells whoever finds
 * the stranded artifact which run stranded it.
 *
 * F-332. IT IS CALLED AT MODULE SCOPE AND NOT FROM `beforeAll`, AND THAT IS THE FIX.
 * vitest does not run `beforeAll` when every test in the file is filtered out, so
 * `-t 'a name that matches no test'` gave 18 skipped, EXIT=0, and the PREVIOUS run's
 * `pass` still on disk with no marker at all — measured. Module scope runs at collection,
 * which happens for a filtered run.
 *
 * WHAT MODULE SCOPE STILL DOES NOT COVER, STATED: a collection error. If an import throws
 * — `registerTenantScopedSurfaces()` rejecting a duplicate subject, say — the module body
 * never executes and the stale artifact survives. Closing that needs `globalSetup` in
 * `vitest.integration.config.ts`, which is outside this TASK's `paths`. Recorded for
 * F-297: an upload step that fails when the artifact's `runAt` predates the job closes it
 * from the other side, and is the more robust place for it anyway.
 */
export function beginIsolationReport(path: string, because?: string): void {
  const marker: IsolationReport = {
    runAt: new Date().toISOString(),
    discovered: [],
    covered: [],
    uncovered: [],
    attempts: [],
    failed: [],
    unverified: [],
    excluded: ISOLATION_EXCLUSIONS.map((exclusion) => ({ ...exclusion })),
    publicRoutes: [],
    noTenantTransactionRoutes: [],
    unenumerable: UNENUMERABLE_SURFACES.map((surface) => ({ ...surface })),
    coverageBoundary: COVERAGE_BOUNDARY,
    suiteOutcome: 'incomplete',
    verdict: 'incomplete',
    incompleteBecause:
      `This run started at the runAt above and has not written its result yet. ${
        because ?? 'If you are reading this, the run did not finish: it threw before ' +
          'judging its attempts, or the process was killed.'
      } NOTHING HERE IS EVIDENCE OF ISOLATION — an empty ` +
      '`failed` list means no attempt was scored, not that no attempt leaked. This ' +
      'marker exists because the artifact previously kept the PREVIOUS run\'s ' +
      '"verdict": "pass" in exactly this situation (F-304).',
  };

  writeFileSync(path, `${JSON.stringify(marker, null, 2)}\n`, 'utf8');
}

/** AC-12's "enumerates which methods were exercised", for the run log a human reads. */
export function formatIsolationReport(report: IsolationReport): string {
  const lines = [
    `isolation coverage — ${report.verdict.toUpperCase()} — ${report.runAt}`,
    report.coverageBoundary,
    '',
    ...report.attempts.map(
      (outcome) =>
        `  ${{ pass: 'pass', fail: 'FAIL', unverified: 'UNVERIFIED' }[outcome.outcome]}  ` +
        `${outcome.direction ?? '?'}  ${outcome.id}  (${outcome.kind} on ${outcome.table}` +
        `, saw ${outcome.rowsSeen ?? 0}, affected ${outcome.rowsAffected ?? 0})` +
        (outcome.refusedWith === undefined ? '' : ` — refused: ${outcome.refusedWith}`) +
        (outcome.unverifiedBecause === undefined
          ? ''
          : `\n      ? ${outcome.unverifiedBecause}`) +
        outcome.leaks.map((leak) => `\n      ! ${leak}`).join(''),
    ),
  ];

  if (report.uncovered.length > 0) {
    lines.push('', '  UNCOVERED (AC-96):', ...report.uncovered.map((id) => `    - ${id}`));
  }

  const drift = report.registryDrift;

  if (drift !== undefined && drift.inDatabaseNotRegistered.length > 0) {
    lines.push(
      '',
      '  TENANT-SCOPED IN THE DATABASE AND REGISTERED NOWHERE (F-296):',
      ...drift.inDatabaseNotRegistered.map(
        (table) => `    - ${table} — add a registerTenantScopedSurfaces() call in registrations.ts`,
      ),
    );
  }

  if (drift !== undefined && drift.registeredNotInDatabase.length > 0) {
    lines.push(
      '',
      '  REGISTERED HERE AND NOT TENANT-SCOPED IN THE DATABASE (F-296):',
      ...drift.registeredNotInDatabase.map((table) => `    - ${table}`),
    );
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
  // The fourth flag (ADR-0045, F-047). The only row here whose file exists today, and
  // therefore the only one `context-flag-owners.spec.ts` can match against a real
  // `set_config` call — which is why that control asserts A1's SUBSET direction and not
  // its exactly-one direction until TASK-029 and TASK-054 land the other two setters.
  { flag: 'app.membership_lookup_user', file: 'apps/api/src/auth/membership-lookup.ts' },
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
