/**
 * STORY-003 — AC-12. The cross-tenant isolation harness, run over everything registered
 * with it.
 *
 * Produced by: TASK-006, by sdlc-test-architect rather than an implementer (ruled
 * 2026-08-06 on F-222, following F-077 and F-100: test files are the test architect's
 * regardless of which card names them).
 *
 * ---------------------------------------------------------------------------
 * WHAT A GREEN RUN OF THIS FILE DOES AND DOES NOT SAY
 * ---------------------------------------------------------------------------
 *
 * IT SAYS: for the two tables that exist today — `tenants` and `rls_fixture_rows` — a
 * tenant transaction belonging to either tenant cannot read, filter for, update, delete
 * or plant a row belonging to the other, or TAKE OWNERSHIP OF ONE, through any of EIGHT
 * statement shapes ON EITHER TABLE — no table is excused from one since r4 withdrew the
 * decline (F-342) — IN EITHER DIRECTION; that three of those eight carry NO WHERE CLAUSE,
 * so a wide-open UPDATE or DELETE policy cannot hide behind a correctly scoped SELECT
 * policy (F-302), and that one of the three ASSIGNS THE OWNER COLUMN, so a widened USING
 * cannot hide behind a correct WITH CHECK either (F-330); each acting tenant demonstrably
 * could see its own row while being refused the other's; every refusal the run scored as
 * a pass was a row-level security refusal ON AN OWNER-QUALIFIED WRITE and says so in
 * `report.json`; and the set of tables carrying a tenant boundary in the database — by
 * five independent properties, none of which assumes the owner column is called
 * `tenant_id` and one of which does not assume the table is protected at all (F-303,
 * F-333) — is exactly the set the registry knows about. Every one of those is a real
 * statement against a live Postgres, issued through `withTenantTransaction` as
 * `shortkit_app`, a role holding neither SUPERUSER nor BYPASSRLS.
 *
 * IT DOES NOT SAY the system has no uncovered cross-tenant surface. Most of the system
 * is unwritten: there is no authenticated route, no repository class, and no
 * `workspaces`, `links`, `domains`, `tenant_memberships` or `click_events` table. Route
 * and repository discovery — isolation-coverage.md's route and decorator enumeration,
 * the four grep clauses and the `pg_policies` shape assertion — are TASK-056's. AC-12 is
 * met against a partial table set, deliberately and by ruling, and the boundary is
 * printed into `report.json` on every run so the artifact SC-1 points at carries it too.
 *
 * ---------------------------------------------------------------------------
 * NO TEST HERE ASSERTS THAT A TEST HELPER WORKS
 * ---------------------------------------------------------------------------
 *
 * Declined 2026-08-06: a test asserting that a test helper works is the shape this
 * initiative has twice called hollow. Every assertion below is about what Postgres
 * answered — including the eleven controls, which are real tables carrying real
 * defects that really do leak — bar one, which is correct and must stay green, not assertions about the harness's shape.
 *
 * FOUR TESTS BELOW ARE THE EXCEPTION AND THEY SAY SO. The F-304 and F-331 tests assert
 * what is in `report.json` on disk part-way through a run: that is not a helper's shape,
 * it is the artifact SC-1 points at and F-297 is about to upload, and the measured
 * defects were that the file kept the PREVIOUS run's verdict when a run died (F-304) and
 * then published THIS run's `pass` before the tests that could disprove it had run
 * (F-331). The two F-343 tests assert the mechanism that computes what that artifact
 * says, for the same reason — one against a hand-built task tree and one against the tree
 * the runner actually built for this file.
 *
 * ---------------------------------------------------------------------------
 * THE ELEVEN CONTROLS, AND THE FINDING EACH ONE ANSWERS
 * ---------------------------------------------------------------------------
 *
 * Five audit rounds measured this suite reporting `pass` over a database that was not
 * isolated, nine ways — and once, reporting a red run over a database that was fine.
 * Each way is now a table the suite builds, attacks and requires a specific answer for,
 * so the measurement runs on every CI run instead of once:
 *
 *   isolation_leak_canary             no row-level security at all      (the r1 control)
 *   isolation_direction_canary        leaks only to one tenant, on INSERT only   (F-293)
 *   isolation_baseline_leak_canary    leaks on read, already at baseline         (F-293)
 *   isolation_grant_gap_canary        42501 from a missing grant, not a policy   (F-294)
 *   isolation_masked_refusal_canary   wide-open policy, 23514 masking it         (F-294)
 *   isolation_half_seeded_canary      correct policies, target owns no row       (F-295)
 *   isolation_unqualified_write_canary
 *                                     wide-open UPDATE and DELETE behind a correct
 *                                     SELECT policy — invisible to every write that
 *                                     names the owner in a WHERE clause      (F-302)
 *   isolation_owner_theft_canary      the same USING widened, WITH CHECK LEFT CORRECT —
 *                                     so the unqualified write is REFUSED and the
 *                                     refusal looked like a denial, while a statement
 *                                     assigning the owner column takes the row  (F-330)
 *   isolation_pk_owner_canary         the same defect on a table whose owner column IS
 *                                     its primary key — `tenants`'s shape, which r3
 *                                     declined the owner-column write on. It is refused
 *                                     there with 23505 and scored `unverified`, which is
 *                                     a red run naming the surface                (F-342)
 *   isolation_guarded_check_canary    CORRECTLY ISOLATED, and its WITH CHECK carries one
 *                                     ordinary business predicate beyond tenancy. The
 *                                     only control here that must come back entirely
 *                                     GREEN: r3's rule left the run permanently red on
 *                                     it, and a check that fires on correct code is the
 *                                     check that gets deleted                     (F-344)
 *   isolation_guarded_leak_canary     THAT TABLE'S TWIN, WITH THE USING WIDENED. F-344's
 *                                     escape from the refusal took a free `SQL` fragment,
 *                                     and one column reference in it — `version =
 *                                     version + 1`, the optimistic-lock idiom — routes
 *                                     both unqualified writes back through the SELECT
 *                                     policy and hides the leak entirely. Measured: this
 *                                     table reported `pass` on all sixteen attempts. The
 *                                     field is now `{ column, value }[]` and the value is
 *                                     bound, so the mistake is unexpressible; two tests
 *                                     run it, the second with the value an author would
 *                                     use to try to spell a column anyway       (F-352)
 *
 * ...plus four probes for tables nobody registered: `wave3_workspaces_probe` (F-296) and
 * `wave3_audit_events_probe_{norls,noforce,forced}` (F-303, F-333), which the drift check
 * has to name whether or not they are protected.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenantTransaction } from '../../src/tenancy/tenant-context';

import {
  beginIsolationReport,
  createTenantFixtures,
  finishIsolationReport,
  formatIsolationReport,
  ISOLATION_EXCLUSIONS,
  registeredSubjects,
  runCrossTenantAttempts,
  tenantOwnershipCensus,
  tenantScopedTableDrift,
  writeIsolationReport,
  assertNoTenantIdAltered,
} from './coverage';
import type {
  AttemptOutcome,
  IsolationReport,
  SuiteOutcome,
  TenantFixtures,
} from './coverage';
import {
  createUnregisteredOwnerColumnProbe,
  createUnregisteredTableProbe,
  dropControlTables,
  dropUnregisteredOwnerColumnProbes,
  dropUnregisteredTableProbe,
  ownerColumnProbeTable,
  OWNER_COLUMN_PROBE_PROTECTIONS,
  UNREGISTERED_TABLE_PROBE,
} from './controls';
import { createLeakCanary, dropLeakCanary, leakCanaryProtection } from './leak-canary';
import {
  assertDeclaredQualification,
  baselineLeakCanaryAccess,
  directionCanaryAccess,
  EXPECTED_SURFACE_IDS,
  grantGapCanaryAccess,
  guardedCheckCanaryAccess,
  guardedLeakBoundValueCanaryAccess,
  guardedLeakCanaryAccess,
  halfSeededCanaryAccess,
  leakCanaryAccess,
  maskedRefusalCanaryAccess,
  ownerTheftCanaryAccess,
  pkOwnerCanaryAccess,
  qualificationOfStatement,
  unqualifiedWriteCanaryAccess,
} from './registrations';
import { querySql } from '../support/psql';
import {
  assertAppRoleCannotBypassRls,
  dropRlsFixture,
  migrationDsn,
  RLS_FIXTURE_TABLE,
  TENANT_A_ROW_ID,
  TENANT_B_ROW_ID,
} from '../support/rls-fixture';

const REPORT_PATH = fileURLToPath(new URL('report.json', import.meta.url));

/**
 * F-343. Hand-written, for the reason `EXPECTED_SURFACE_IDS` is hand-written: it is the
 * number of tests `suiteOutcomeOf()` must observe for the conjunction it publishes to be
 * a statement about this whole file. A test that stops being counted — because it was
 * nested and the mechanism stopped recursing — and a test added without this number
 * moving both have to arrive as a visible diff. It reaches `report.json` as
 * `observedTests`, so a reader of the artifact can check it too.
 */
const TESTS_IN_THIS_FILE = 29;

/**
 * ===========================================================================
 * F-332. AT MODULE SCOPE, AND THAT IS THE WHOLE POINT OF WHERE IT IS.
 * ===========================================================================
 *
 * This ran inside `beforeAll` until r3. vitest does not run `beforeAll` when every test
 * in the file is filtered out, so a run that selected nothing left the PREVIOUS run's
 * `pass` on disk with no marker at all — measured:
 *
 *   npx vitest run ... -t 'a name that matches no test'
 *   -> Test Files 1 skipped (1), Tests 18 skipped (18), EXIT=0, 489ms
 *   -> report.json unchanged: verdict=pass, runAt=<the previous run's>
 *
 * Exit 0 and a green artifact, over a run that asserted nothing. Module scope executes at
 * COLLECTION, which happens for a filtered run, so the stale pass is replaced by
 * `incomplete` before any test is selected or skipped.
 *
 * `readFileSync` immediately after is the capture the F-304 and F-331 tests assert on:
 * what was on disk while this run was in flight.
 */
beginIsolationReport(REPORT_PATH);

const reportOnDiskWhileTheRunWasInFlight = readFileSync(REPORT_PATH, 'utf8');

/**
 * F-331. What the runner observed of THIS FILE's tests, read in `afterAll` — which vitest
 * runs after every test in the file, and also runs when `beforeAll` threw (measured: the
 * tasks then read `skip`).
 *
 * Anything that is not "every test passed" is not a pass. A `skip` is `incomplete` rather
 * than `fail` because a filtered or aborted run has not disproved anything; a `fail` is a
 * `fail`.
 */
interface RunnerTask {
  readonly type?: string;
  readonly tasks?: RunnerTask[];
  readonly result?: { state?: string };
}

/**
 * ===========================================================================
 * F-343. EVERY TEST UNDER `suite`, AT ANY DEPTH — AND THE DEPTH IS THE FINDING.
 * ===========================================================================
 *
 * @vitest/runner@3.2.7 declares `type Task = Test | Suite | File`, and a nested
 * `describe` arrives as a task of type `"suite"` carrying its own `tasks`. This filtered
 * ONE level, so the moment the control tests were grouped — which is the ordinary way
 * this file grows, and which they now are — every failure inside the group became
 * invisible to the conjunction and `finishIsolationReport()` published `verdict: 'pass'`
 * over a red file. F-331 restored by an ordinary edit, inside the mechanism built to
 * prevent it.
 *
 * The `states.length === 0` guard did not help: it fires only when EVERY test is nested.
 * Nothing pinned the number of tasks the function observed, so the shrink was silent —
 * which is the same accounting failure F-296 and F-342 are. The count now reaches
 * `report.json` as `observedTests`, and the F-343 tests below pin it against the real
 * tree.
 */
function testStatesOf(suite: unknown): (string | undefined)[] {
  const tasks = (suite as RunnerTask).tasks ?? [];

  return tasks.flatMap((task) =>
    task.type === 'suite' ? testStatesOf(task) : task.type === 'test' ? [task.result?.state] : [],
  );
}

function suiteOutcomeOf(suite: unknown): SuiteOutcome {
  const states = testStatesOf(suite);

  if (states.length === 0) {
    return 'incomplete';
  }

  if (states.includes('fail')) {
    return 'fail';
  }

  return states.every((state) => state === 'pass') ? 'pass' : 'incomplete';
}

interface TableProtection extends Record<string, unknown> {
  row_security: boolean;
  force_row_security: boolean;
  policies: number;
}

function protectionOf(table: string): TableProtection | undefined {
  return querySql<TableProtection>(
    migrationDsn(),
    `SELECT c.relrowsecurity      AS row_security,
            c.relforcerowsecurity AS force_row_security,
            (SELECT count(*)::int
               FROM pg_policies p
              WHERE p.schemaname = 'public' AND p.tablename = '${table}') AS policies
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = '${table}'`,
  )[0];
}

/** `${id}: ${why}` per failing method, so a red run names the surface (AC-96's reason). */
function leakedSurfaces(report: IsolationReport): string[] {
  return report.attempts
    .filter((outcome) => outcome.outcome === 'fail')
    .map((outcome) => `${outcome.direction ?? '?'} ${outcome.id}: ${outcome.leaks.join(' | ')}`);
}

/** `A->B updateOwnedBy` — the shape every control's expectation is written in. */
function labelled(outcomes: readonly AttemptOutcome[]): string[] {
  return outcomes.map((outcome) => `${outcome.direction ?? '?'} ${outcome.method}`).sort();
}

function withOutcome(
  report: IsolationReport,
  outcome: AttemptOutcome['outcome'],
): AttemptOutcome[] {
  return report.attempts.filter((attempt) => attempt.outcome === outcome);
}

describe('cross-tenant isolation over every registered tenant-scoped surface', () => {
  let fixtures: TenantFixtures;
  let report: IsolationReport | null = null;

  /**
   * The run's judged report. `report` is nullable so that `afterAll` can tell a run that
   * never produced one from a run that did (F-331); a test reaching for it when
   * `beforeAll` threw gets a clear sentence rather than a TypeError.
   */
  function judged(): IsolationReport {
    if (report === null) {
      throw new Error(
        'the isolation run produced no report — beforeAll threw before judging any ' +
          'attempt. The failure above is the one to read.',
      );
    }

    return report;
  }

  beforeAll(async () => {
    // The `incomplete` marker is already on disk — it is written at module scope, above,
    // for the reason F-332 gives. Everything in this hook can throw:
    // `assertAppRoleCannotBypassRls()` throws on a bypassing role and
    // `createTenantFixtures()` throws on a leak that is already present, which is the
    // single most alarming failure this harness has.

    // Without this every assertion below passes vacuously: a role exempt from row-level
    // security makes a correct implementation and a missing one look identical.
    assertAppRoleCannotBypassRls();

    fixtures = await createTenantFixtures();
    report = await runCrossTenantAttempts(registeredSubjects(), fixtures);

    // F-331. This writes the ATTEMPTS and deliberately leaves `verdict: incomplete`.
    // Eleven of this file's tests run after this line, including
    // `assertNoTenantIdAltered()`, and any of them can disprove an attempt battery that
    // judged itself clean. The verdict is published in `afterAll` and nowhere else.
    writeIsolationReport(report, REPORT_PATH);
    // AC-12's "its output enumerates which methods were exercised", in the run log.
    console.log(formatIsolationReport(report));
  }, 300_000);

  afterAll((suite) => {
    try {
      dropLeakCanary();
      dropControlTables();
      dropRlsFixture();
    } finally {
      // F-331. THE ONLY WRITE THAT CAN PUBLISH `pass`, and it happens after every test in
      // this file has a result. `report` is null when `beforeAll` threw — vitest runs
      // this hook anyway (measured) — and the `incomplete` marker then stands.
      //
      // F-343. The COUNT goes with the outcome, so the artifact says how many tests the
      // conjunction was computed over instead of leaving a reader to assume it was all
      // of them.
      finishIsolationReport(
        REPORT_PATH,
        report,
        suiteOutcomeOf(suite),
        testStatesOf(suite).length,
      );
    }
  });

  it('AC-12: no registered method lets one tenant reach another tenant\'s rows', () => {
    // The premise, stated first and read from the catalog: both tables really are
    // protected, so a clean run below is the policies denying rather than an
    // unprotected table nobody looked at. Counts are hand-derived — four bespoke
    // policies on `tenants` from drizzle/0000_*.sql, two from tenantScopedPolicies().
    expect(protectionOf('tenants')).toEqual({
      row_security: true,
      force_row_security: true,
      policies: 4,
    });
    expect(protectionOf(RLS_FIXTURE_TABLE)).toEqual({
      row_security: true,
      force_row_security: true,
      policies: 2,
    });

    expect(leakedSurfaces(judged())).toEqual([]);
    expect(withOutcome(judged(), 'unverified')).toEqual([]);
    expect(judged().verdict).toBe('pass');
  });

  it('AC-12: the report enumerates every method it exercised, and reports pass or fail for each', () => {
    // Hand-written in registrations.ts and compared here, so a battery that quietly
    // loses a statement shape — or a registration that stops registering — fails with
    // the missing id named, rather than reporting a smaller clean run.
    expect([...judged().covered].sort()).toEqual([...EXPECTED_SURFACE_IDS]);

    expect(judged().attempts.map((outcome) => outcome.outcome)).toEqual(
      judged().attempts.map(() => 'pass'),
    );

    // SIXTEEN surfaces, each attempted in both directions (F-293) — the same eight shapes
    // on both tables, since r4 withdrew the one decline (F-342). Reads and writes are both
    // exercised: AC-94 covers the reads and AC-95 the writes, and a battery that had lost
    // all of one kind would still satisfy the count above.
    expect(judged().attempts).toHaveLength(32);
    expect(judged().attempts.filter((outcome) => outcome.kind === 'read')).toHaveLength(8);
    expect(judged().attempts.filter((outcome) => outcome.kind === 'write')).toHaveLength(24);

    // F-302, F-330, F-342. Twelve of those twenty-four writes carry NO WHERE CLAUSE.
    // Hand-derived, because a battery that silently lost them is a battery that cannot
    // see a wide-open UPDATE policy, and the counts above would not move if `updateAll`
    // were quietly replaced by a second owner-qualified statement.
    expect(
      labelled(
        judged().attempts.filter(
          (outcome) => outcome.kind === 'write' && outcome.qualification === 'unqualified',
        ),
      ),
    ).toEqual([
      'A->B deleteAll',
      'A->B deleteAll',
      'A->B reparentAll',
      'A->B reparentAll',
      'A->B updateAll',
      'A->B updateAll',
      'B->A deleteAll',
      'B->A deleteAll',
      'B->A reparentAll',
      'B->A reparentAll',
      'B->A updateAll',
      'B->A updateAll',
    ]);
  });

  it('F-342: the owner-column write is attempted on tenants too, and reports only the acting tenant\'s own row', () => {
    // THE WITHDRAWN DECLINE. r3 removed this shape from `tenants` and published the
    // reason into `report.json`: that `UPDATE tenants SET id = <actor>` "is refused by
    // the primary key index with 23505 before any policy is evaluated, so it could never
    // distinguish a correct policy from a wide-open one". Measured on this machine on
    // 2026-08-11 against the migrated table, as `shortkit_app` inside an ordinary
    // tenant-A transaction:
    //
    //   tenants_self_update USING (id = ctx)  [the migration's] -> UPDATE 1, NO ERROR
    //   tenants_self_update USING (true), WITH CHECK correct    -> ERROR 23505
    //   tenants_self_update USING (true) WITH CHECK (true)      -> ERROR 23505
    //
    // The ordering is the other way round: PostgreSQL applies the USING clause during the
    // scan, so under the correct policy the statement reaches ONLY the actor's own row,
    // the assignment is an IDENTITY UPDATE, and the primary key is never contended. The
    // index refuses it only once a widened USING has swept both rows onto one id.
    //
    // This test is the PASSING half of that measurement, running on the one migrated
    // production table this repository has. The failing half is the F-342 control over
    // `isolation_pk_owner_canary`. The break this catches: the shape declined again, on
    // this table or on any other.
    const reparent = judged().attempts.filter(
      (outcome) => outcome.id === 'repo:TenantsTableAccess.reparentAll',
    );

    expect(labelled(reparent)).toEqual(['A->B reparentAll', 'B->A reparentAll']);

    for (const outcome of reparent) {
      expect(outcome.outcome).toBe('pass');
      expect(outcome.refusedWith).toBeUndefined();
      // One row — the actor's own, reassigned to itself. `affected > actorOwnRowsVisible`
      // is the rule that would fire, and under a widened USING it is 2 against 1.
      expect(outcome.rowsAffected).toBe(1);
      expect(outcome.actorOwnRowsVisible).toBe(1);
    }
  });

  it('F-293: every registered surface is attempted in both directions, not only as tenant A', () => {
    // The blocker r1 found: `attempt()` had one call site and it read
    // `method.attempt(fixtures.tenantA, fixtures.tenantB)`, so the actor was always A
    // and a policy that leaks only to B was never attempted. Both lists are the same
    // ten ids, which is what "both directions" means.
    const forward = judged().attempts.filter((outcome) => outcome.direction === 'A->B');
    const reverse = judged().attempts.filter((outcome) => outcome.direction === 'B->A');

    expect(forward.map((outcome) => outcome.id).sort()).toEqual([...EXPECTED_SURFACE_IDS]);
    expect(reverse.map((outcome) => outcome.id).sort()).toEqual([...EXPECTED_SURFACE_IDS]);

    // ...and the actor really was the other tenant, not the same one twice.
    expect([...new Set(forward.map((outcome) => outcome.actor))]).toEqual([fixtures.tenantA.id]);
    expect([...new Set(reverse.map((outcome) => outcome.actor))]).toEqual([fixtures.tenantB.id]);
  });

  it('F-295: each tenant sees exactly its own row in every registered table before anything is attempted', async () => {
    // The positive control. Four lines, hand-derived from the fixture: two tables, two
    // tenants, one row each, and each tenant seeing only its own. If `app.tenant_id`
    // were never set, set under a mistyped name, or set to a value no row matches, this
    // is empty and every cross-tenant attempt in the file would be passing on nothing.
    const { id: a } = fixtures.tenantA;
    const { id: b } = fixtures.tenantB;

    expect(await tenantOwnershipCensus(registeredSubjects(), fixtures)).toEqual([
      `${RLS_FIXTURE_TABLE} seen-by=${a} id=${TENANT_A_ROW_ID} owner=${a}`,
      `${RLS_FIXTURE_TABLE} seen-by=${b} id=${TENANT_B_ROW_ID} owner=${b}`,
      `tenants seen-by=${a} id=${a} owner=${a}`,
      `tenants seen-by=${b} id=${b} owner=${b}`,
    ]);
  });

  it('F-294: every refusal this run scored as a pass was a row-level security refusal, and says so', () => {
    // r1 measured that `describeError()` dropped the message whenever a SQLSTATE was
    // present, so an RLS refusal and a missing table grant both rendered as the
    // identical string `error [42501]` — the string report.json carried for two
    // attempts. A refusal that cannot be told apart from a permission error is not
    // evidence of anything.
    const refused = judged().attempts.filter((outcome) => outcome.refusedWith !== undefined);

    // ---------------------------------------------------------------------------
    // THE INVARIANT FIRST, THEN THE ROSTER. Both are here on purpose (F-330).
    // ---------------------------------------------------------------------------
    //
    // The roster below is a literal enumeration, and the re-audit caught it doing
    // something it was never designed for: under `tenants_self_update USING (true)` it
    // was THE ONLY THING that turned the run red, because `updateAll` joined the list.
    // Not one attempt had been judged a leak. An accidental tripwire whose message —
    // `expected [...(5)] to deeply equal [...(3)]` — named no boundary crossing at all,
    // and which any future registration with a refused write would be extended past.
    //
    // So the invariant is asserted first and derived from the outcomes, not listed: a
    // refusal may only be scored a pass on an OWNER-QUALIFIED write. On an unqualified
    // one it proves the WITH CHECK clause held and says nothing about the USING clause,
    // which is the half that decides which existing rows the statement could reach.
    for (const outcome of judged().attempts.filter(
      (o) => o.outcome === 'pass' && o.refusedWith !== undefined,
    )) {
      expect(outcome.qualification).toBe('owner-qualified');
      expect(outcome.refusalKind).toBe('row-level-security');
      expect(outcome.refusedWith).toMatch(/violates row-level security policy/);
    }

    // AND THE ROSTER, KEPT DELIBERATELY AS A TRIPWIRE. It is a hand-written list of every
    // attempt this run expects the database to refuse at all, and its value is that a
    // statement shape which starts being refused — for any reason, in any direction —
    // cannot slip in unnoticed. Extending it is the correct response to adding a
    // registration; extending it WITHOUT understanding why the new entry is refused is
    // the mistake, and the invariant above is what catches that.
    expect(labelled(refused)).toEqual([
      'A->B insertOwnedBy',
      'A->B insertOwnedBy',
      'B->A insertOwnedBy',
      'B->A insertOwnedBy',
    ]);
  });

  it('F-296: the registry and the database agree on which tables carry a tenant boundary', () => {
    // ADR-0019's cross-check, SQL half. `discoveredSurfaces()` maps over the registry,
    // so `uncovered` is structurally `[]` and a table nobody registers is invisible to
    // the suite rather than reported by it. This is the assertion that is not.
    expect(tenantScopedTableDrift()).toEqual({
      inDatabaseNotRegistered: [],
      registeredNotInDatabase: [],
    });
    expect(judged().registryDrift).toEqual({
      inDatabaseNotRegistered: [],
      registeredNotInDatabase: [],
    });
  });

  it('F-296: a tenant-scoped table nobody registered is named, rather than silently uncovered', () => {
    // The security auditor's measurement, made permanent: a wave-3 table with tenant_id,
    // ENABLE, FORCE and a policy — correct in every way `db:check-policies` can see —
    // that no `registerTenantScopedSurfaces()` call names. Before this, both gates
    // stayed green and the table appeared nowhere in report.json.
    createUnregisteredTableProbe();

    try {
      expect(tenantScopedTableDrift()).toEqual({
        inDatabaseNotRegistered: [UNREGISTERED_TABLE_PROBE],
        registeredNotInDatabase: [],
      });
    } finally {
      dropUnregisteredTableProbe();
    }
  });

  /**
   * ===========================================================================
   * F-343. THESE ARE NESTED ON PURPOSE, AND THE NESTING IS LOAD-BEARING.
   * ===========================================================================
   *
   * `suiteOutcomeOf()` reads `suite.tasks` in `afterAll` and is what stops a red run from
   * publishing a green artifact (F-331). Until r4 it filtered ONE level for
   * `task.type === 'test'`, and @vitest/runner delivers a nested `describe` as a task of
   * type `"suite"` — so grouping these controls, which is the ordinary way this file
   * grows, would have hidden every failure inside the group from the conjunction and
   * published `verdict: pass` over a red file. Measured, and the mechanism now recurses.
   *
   * The group is kept rather than reverted BECAUSE it is the condition: with the controls
   * nested, the real task tree exercises the recursion on every run, and the F-343 tests
   * below pin both the total the mechanism observes and the fact that some of it is
   * nested. Flattening this describe fails them.
   */
  describe('the negative controls — one per database an audit measured this harness calling clean', () => {
    it('AC-12: every method on a deliberately unprotected table is reported as failing', async () => {
      createLeakCanary();

      // The premise of the control, from the catalog: this table carries a tenant_id
      // column, a foreign key to tenants, and NO row-level security whatsoever. That is
      // the defect scripts/check-policies.mts exists to catch — a table whose CREATE
      // POLICY block was written and whose ENABLE ROW LEVEL SECURITY was forgotten.
      expect(leakCanaryProtection()).toEqual({
        row_security: false,
        force_row_security: false,
        policies: 0,
      });

      const control = await runCrossTenantAttempts([leakCanaryAccess], fixtures);

      // Every one of the fourteen, not merely the verdict, and `fail` rather than "not a
      // pass": a harness that had stopped detecting anything on reads would still fail
      // the run on a write, and an attempt reported `unverified` here would mean the
      // control had stopped being a leak.
      expect(control.attempts.filter((outcome) => outcome.outcome !== 'fail')).toEqual([]);
      expect(control.attempts).toHaveLength(16);
      expect(control.verdict).toBe('fail');

      // ...and each one says WHOSE row leaked, which is what makes a real red run
      // actionable rather than a bare `false !== true`.
      const forward = control.attempts.filter((outcome) => outcome.direction === 'A->B');
      const reverse = control.attempts.filter((outcome) => outcome.direction === 'B->A');

      expect(forward).toHaveLength(8);
      expect(reverse).toHaveLength(8);

      for (const outcome of forward) {
        expect(outcome.leaks.join(' ')).toContain(fixtures.tenantB.id);
      }

      for (const outcome of reverse) {
        expect(outcome.leaks.join(' ')).toContain(fixtures.tenantA.id);
      }
    }, 180_000);

    it('F-293: a policy that leaks to one tenant only, on one statement only, is reported as failing', async () => {
      // THE BLOCKER'S SHAPE. `isolation_direction_canary` scopes reads, updates and
      // deletes correctly for everybody; its INSERT policy carries an `OR` arm naming
      // tenant B. So an ownership census is clean, every attempt made AS TENANT A is
      // refused exactly as it should be, and tenant B may plant a row owned by tenant A.
      //
      // Nothing but acting as B can see it: this is the one leak shape a census cannot
      // catch, because no SELECT anywhere returns a foreign row.
      const control = await runCrossTenantAttempts([directionCanaryAccess], fixtures);

      expect(labelled(control.attempts.filter((outcome) => outcome.outcome !== 'pass'))).toEqual([
        'B->A insertOwnedBy',
      ]);
      expect(control.attempts).toHaveLength(16);

      const [leaked] = control.attempts.filter((outcome) => outcome.outcome === 'fail');

      expect(leaked?.leaks.join(' ')).toContain(fixtures.tenantA.id);
      expect(control.verdict).toBe('fail');
    }, 180_000);

    it('F-293: a read leak that is already present at baseline is reported as failing', async () => {
      // `isolation_baseline_leak_canary` lets tenant B read every tenant's rows. The leak
      // exists the moment the table is seeded, so comparing the ownership census before
      // an attempt against the census after it — which is all the census was ever used
      // for — reports it as unchanged, and therefore clean.
      //
      // The evidence was already being computed: `tenantOwnershipCensus()` reads as BOTH
      // tenants and builds the line that proves it. What was missing was the absolute
      // assertion over that line: seen-by must equal owner.
      const control = await runCrossTenantAttempts([baselineLeakCanaryAccess], fixtures);

      expect(control.attempts.filter((outcome) => outcome.outcome === 'pass')).toEqual([]);
      expect(control.attempts).toHaveLength(16);

      // Every attempt on the table carries the census evidence, naming the tenant that
      // could see a row it does not own.
      for (const outcome of control.attempts) {
        expect(outcome.leaks.join(' ')).toContain(fixtures.tenantB.id);
      }

      expect(control.verdict).toBe('fail');
    }, 180_000);

    it('F-294: a 42501 raised by a missing grant is not evidence that a policy refused', async () => {
      // `isolation_grant_gap_canary` carries the production policies and the runtime role
      // holds SELECT and nothing else — an ALTER DEFAULT PRIVILEGES that never reached
      // the table, or an explicit REVOKE. Its three write shapes raise
      // `42501 permission denied for table ...`, the same SQLSTATE a WITH CHECK refusal
      // raises. Scoring any throw as a pass reports three write surfaces per direction
      // that tested nothing at all.
      const control = await runCrossTenantAttempts([grantGapCanaryAccess], fixtures);

      expect(labelled(control.attempts.filter((outcome) => outcome.outcome === 'unverified'))).toEqual([
        'A->B deleteAll',
        'A->B deleteOwnedBy',
        'A->B insertOwnedBy',
        'A->B reparentAll',
        'A->B updateAll',
        'A->B updateOwnedBy',
        'B->A deleteAll',
        'B->A deleteOwnedBy',
        'B->A insertOwnedBy',
        'B->A reparentAll',
        'B->A updateAll',
        'B->A updateOwnedBy',
      ]);
      expect(control.attempts).toHaveLength(16);

      // The reads are granted and the policies are the production ones, so those four
      // are real passes — which is what makes the six above a statement about the
      // refusal and not about the table.
      expect(labelled(control.attempts.filter((outcome) => outcome.outcome === 'pass'))).toEqual([
        'A->B findAll',
        'A->B findOwnedBy',
        'B->A findAll',
        'B->A findOwnedBy',
      ]);

      for (const outcome of control.attempts.filter((o) => o.outcome === 'unverified')) {
        expect(outcome.refusalKind).toBe('unrecognised');
        expect(outcome.refusedWith).toContain('42501');
        expect(outcome.refusedWith).toContain('permission denied');
      }

      expect(control.verdict).toBe('fail');
    }, 180_000);

    it('F-294: a wide-open policy masked by an unrelated CHECK constraint is not reported as a pass', async () => {
      // The security auditor's measured sequence, made permanent. Widening
      // `tenants_self_insert` to `WITH CHECK (true)` turned the suite red; adding
      // `CHECK (name <> 'planted-by-another-tenant')` turned it green again at
      // `refused: error [23514]` WHILE THE POLICY STAYED WIDE OPEN.
      // `isolation_masked_refusal_canary` is that database: any tenant may plant a row
      // owned by any other, and the only statement that can demonstrate it is refused by
      // a constraint that has nothing to do with tenancy.
      const control = await runCrossTenantAttempts([maskedRefusalCanaryAccess], fixtures);

      const masked = control.attempts.filter((outcome) => outcome.outcome === 'unverified');

      expect(labelled(masked)).toEqual(['A->B insertOwnedBy', 'B->A insertOwnedBy']);
      expect(control.attempts).toHaveLength(16);

      for (const outcome of masked) {
        expect(outcome.refusalKind).toBe('unrecognised');
        expect(outcome.refusedWith).toContain('23514');
      }

      // ---------------------------------------------------------------------------
      // F-302. WHAT THIS ASSERTION USED TO SAY, AND WHY THAT WAS WORSE THAN SILENCE.
      // ---------------------------------------------------------------------------
      //
      // It read `expect(...outcome === 'pass').toHaveLength(8)`, over a canary that
      // carries `FOR UPDATE USING (true) WITH CHECK (true)` and `FOR DELETE USING (true)`,
      // with a comment explaining that the update and delete "reach nothing they can see"
      // and are therefore "real passes". Both halves were true and the conclusion was
      // wrong: they reach nothing they can see BECAUSE PostgreSQL applies the SELECT
      // policies to a write that references a column, and this table's SELECT policy is
      // the only correct thing about its write path. Eight green attempts over two
      // policies that admit every row of every tenant, asserted to be fine — which reads
      // as coverage, and is harder to find than a missing test.
      //
      // What it says now: the four attempts that name nothing FAIL, and each names the
      // tenant whose rows a statement with no WHERE clause reached.
      expect(labelled(control.attempts.filter((outcome) => outcome.outcome === 'fail'))).toEqual([
        'A->B deleteAll',
        'A->B reparentAll',
        'A->B updateAll',
        'B->A deleteAll',
        'B->A reparentAll',
        'B->A updateAll',
      ]);

      for (const outcome of control.attempts.filter((o) => o.outcome === 'fail')) {
        expect(outcome.leaks.join(' ')).toContain(outcome.target ?? '');
      }

      // The reads and the owner-qualified writes remain real passes — which is what makes
      // the four above a statement about the unqualified shape and not about the table
      // being broken in some way any attempt would have caught.
      expect(labelled(control.attempts.filter((outcome) => outcome.outcome === 'pass'))).toEqual([
        'A->B deleteOwnedBy',
        'A->B findAll',
        'A->B findOwnedBy',
        'A->B updateOwnedBy',
        'B->A deleteOwnedBy',
        'B->A findAll',
        'B->A findOwnedBy',
        'B->A updateOwnedBy',
      ]);
      expect(control.verdict).toBe('fail');
    }, 180_000);

    it('F-295: an attempt against a tenant that owns no row proves nothing and is not a pass', async () => {
      // `isolation_half_seeded_canary` carries the production policies and only tenant A
      // was ever seeded — the one-line omission in a future `registerTenantScopedSurfaces()`
      // call that no other test would cover. Four of the five statement shapes return zero
      // rows because there is nothing there, whatever the policy says; read the other way
      // round, the ACTOR owns no row, so nothing the database answers is evidence that the
      // tenant context reached the table at all.
      //
      // The insert acting as A is the one real pass: it plants a NEW row, so it needs no
      // pre-existing row of the target's, and the WITH CHECK really does refuse it.
      const control = await runCrossTenantAttempts([halfSeededCanaryAccess], fixtures);

      expect(labelled(control.attempts.filter((outcome) => outcome.outcome === 'pass'))).toEqual([
        'A->B insertOwnedBy',
      ]);
      expect(control.attempts).toHaveLength(16);

      const unverified = control.attempts.filter((outcome) => outcome.outcome === 'unverified');

      expect(unverified).toHaveLength(15);
      expect(unverified.filter((outcome) => outcome.unverifiedBecause === undefined)).toEqual([]);

      // The row counts that make "denied" and "found nothing" different answers, in the
      // artifact rather than only in a judgement.
      expect(
        control.attempts.filter((outcome) => outcome.kind === 'read' && outcome.rowsSeen === undefined),
      ).toEqual([]);

      expect(control.verdict).toBe('fail');
    }, 180_000);

    it('F-302: a wide-open UPDATE and DELETE policy behind a correct SELECT policy is reported as failing', async () => {
      // THE r2 BLOCKER, MADE PERMANENT. The auditor's mutation was one statement against
      // the migrated production table — `ALTER POLICY tenants_self_update ON tenants USING
      // (true) WITH CHECK (true)` — and under it, in an ordinary tenant-A transaction as
      // `shortkit_app`, `UPDATE tenants SET name = 'pwned-by-tenant-A'` reported UPDATE 2
      // and BOTH tenants' rows read `pwned-by-tenant-A` afterwards. Reproduced end to end
      // on 2026-08-11; tenant B's data destroyed by tenant A. Under that database this
      // suite reported `isolation coverage - PASS`, 15 passed, exit 0, and
      // `db:check-policies` OK.
      //
      // `isolation_unqualified_write_canary` is that database as DDL, so the measurement
      // runs on every CI run rather than once. Its SELECT and INSERT policies are correct
      // and its UPDATE and DELETE policies admit every row of every tenant.
      const control = await runCrossTenantAttempts([unqualifiedWriteCanaryAccess], fixtures);

      // Ten of the fourteen pass, and that is the finding rather than an aside: every
      // statement shape the harness had before this round is routed through the SELECT
      // policy by PostgreSQL and answers zero rows, so the table reads as isolated. The
      // ownership census is clean for the same reason.
      expect(labelled(control.attempts.filter((outcome) => outcome.outcome === 'fail'))).toEqual([
        'A->B deleteAll',
        'A->B reparentAll',
        'A->B updateAll',
        'B->A deleteAll',
        'B->A reparentAll',
        'B->A updateAll',
      ]);
      expect(control.attempts).toHaveLength(16);
      expect(control.attempts.filter((outcome) => outcome.outcome === 'unverified')).toEqual([]);

      // Each failure names what leaked and to whom: the row count the statement itself
      // reported against the number of its own rows the acting tenant was shown to see,
      // and the tenant that owns the rows it should not have touched.
      for (const outcome of control.attempts.filter((o) => o.outcome === 'fail')) {
        expect(outcome.leaks.join(' ')).toContain(outcome.target ?? '');
        expect(outcome.leaks.join(' ')).toContain('2 row(s) affected');
        expect(outcome.leaks.join(' ')).toContain('only 1 row(s) of its own');
      }

      expect(control.verdict).toBe('fail');
    }, 180_000);

    it('F-303/F-333: a tenant-scoped table whose owner column is not called tenant_id is named whether or not it is protected', async () => {
      // `tenantScopedTableDrift()` enumerated on the LITERAL column name `tenant_id`, so
      // the one mechanism F-296 added to catch an unregistered table could not see a table
      // that spells its owner column any other way — which ADR-0019 records as an accepted
      // cost of the naming convention, and which the registry's own `ownerColumn` field
      // has always contradicted.
      //
      // Measured on 2026-08-11 before the fix: this exact table, with ENABLE, FORCE and
      // `USING (true)`, returned tenant B's `actor_email` inside tenant A's transaction
      // while the suite was 15 passed, `registryDrift` was empty in both directions and
      // `db:check-policies` reported "OK: 2 table(s) in schema public, all protected".
      // F-333. ALL THREE STATES OF PROTECTION, because r3 measured that arms 3 and 4 are
      // properties of a table being PROTECTED and the UNPROTECTED shape is the worst one.
      // Before arm 5 (a foreign key to `tenants`), only the third of these was named; the
      // other two were caught solely by `db:check-policies`, which is a different gate, so
      // this check was neither second nor independent for them.
      for (const protection of OWNER_COLUMN_PROBE_PROTECTIONS) {
        createUnregisteredOwnerColumnProbe(protection);
      }

      try {
        expect(tenantScopedTableDrift()).toEqual({
          inDatabaseNotRegistered: [...OWNER_COLUMN_PROBE_PROTECTIONS]
            .map(ownerColumnProbeTable)
            .sort(),
          registeredNotInDatabase: [],
        });

        // ...and every one of them really does leak, so the drift check is the only thing
        // between these tables and a green run: nothing attempts anything against a table
        // nobody registered. Read through the production path as `shortkit_app` inside
        // tenant A's transaction — a correct policy answers zero rows here.
        for (const protection of OWNER_COLUMN_PROBE_PROTECTIONS) {
          const table = ownerColumnProbeTable(protection);
          const seenByTenantA = await withTenantTransaction(
            fixtures.tenantA.id,
            async (db): Promise<{ owning_tenant: string }[]> => {
              const result = await db.execute<{ owning_tenant: string }>(
                sql`select owning_tenant from ${sql.identifier(table)}`,
              );

              return [...result.rows];
            },
          );

          expect({ table, owners: seenByTenantA.map((row) => row.owning_tenant) }).toEqual({
            table,
            owners: [fixtures.tenantB.id],
          });
        }
      } finally {
        dropUnregisteredOwnerColumnProbes();
      }
    }, 180_000);

    it('F-330: a widened USING with a correct WITH CHECK is reported as failing, and its refusal is not a pass', async () => {
      // THE SIBLING OF F-302, AND THE WORSE HALF. `isolation_owner_theft_canary` is
      // `isolation_unqualified_write_canary` with three characters changed: the UPDATE
      // policy's WITH CHECK is tightened back to what `tenantScopedPolicies()` actually
      // emits, leaving only the USING widened. One token from the production builder.
      //
      // MEASURED BEFORE THIS ROUND, on the migrated production table:
      //   ALTER POLICY tenants_self_update ON tenants USING (true);   -- WITH CHECK correct
      //   -> pass A->B updateAll (affected 0) — refused: error [42501]
      //   -> pass B->A updateAll (affected 0) — refused: error [42501]
      //   -> report.json: verdict=pass, failed=[], unverified=[], 28 attempts
      // Every attempt green over a policy admitting every row of every tenant. The count
      // rule never fired because no row count was ever reported, and the digest never
      // fired because nothing the harness issued changed anything.
      const control = await runCrossTenantAttempts([ownerTheftCanaryAccess], fixtures);

      // MECHANISM 1. The refusal proves the WITH CHECK held and says nothing about the
      // USING clause — which is the half deciding which existing rows the statement could
      // reach. `unverified`, not `pass`.
      const refusedUnqualified = control.attempts.filter(
        (outcome) => outcome.outcome === 'unverified',
      );

      expect(labelled(refusedUnqualified)).toEqual(['A->B updateAll', 'B->A updateAll']);

      for (const outcome of refusedUnqualified) {
        expect(outcome.refusalKind).toBe('row-level-security');
        expect(outcome.unverifiedBecause).toContain('proves the WITH CHECK clause held');
      }

      // MECHANISM 2. The statement that assigns the owner column. The WITH CHECK admits it
      // precisely BECAUSE the resulting row belongs to the actor, which is what lets it
      // through the clause that refuses every other write — and it is theft rather than
      // vandalism: the target's row is not damaged, it changes hands.
      expect(labelled(control.attempts.filter((outcome) => outcome.outcome === 'fail'))).toEqual([
        'A->B reparentAll',
        'B->A reparentAll',
      ]);

      for (const outcome of control.attempts.filter((o) => o.outcome === 'fail')) {
        expect(outcome.leaks.join(' ')).toContain(outcome.target ?? '');
        expect(outcome.leaks.join(' ')).toContain('2 row(s) affected');
      }

      // Twelve of the sixteen still pass, and that is the finding rather than an aside:
      // every other shape in the battery reads this table as isolated.
      expect(control.attempts).toHaveLength(16);
      expect(control.attempts.filter((outcome) => outcome.outcome === 'pass')).toHaveLength(12);

      // F-346. The verdict must be `fail` BECAUSE OF THE ATTEMPTS, and until r4 it was
      // not: `isolation_owner_theft_canary` was missing from SUITE_OWNED_CONTROL_TABLES,
      // so every control run that built it also reported it as registry drift — and
      // `attemptVerdict` is `fail` whenever drift is non-empty, whatever the attempts
      // said. Measured on 2026-08-11: `inDatabaseNotRegistered:
      // ["isolation_owner_theft_canary"]`. The assertion below is what makes
      // `control.verdict` a statement about this table's policies again.
      expect(control.registryDrift).toEqual({
        inDatabaseNotRegistered: [],
        registeredNotInDatabase: [],
      });
      expect(control.verdict).toBe('fail');
    }, 180_000);

    it('F-342: on a table whose owner column is its primary key, the owner-column write still separates a widened USING from a correct one', async () => {
      // THE DECLINE THIS REPLACES, AND WHY IT WAS WITHDRAWN. r3 removed `reparentAll`
      // from `tenants` on the premise that `UPDATE tenants SET id = <actor>` "is refused
      // by the primary key index with 23505 BEFORE ANY POLICY IS EVALUATED, so it could
      // never distinguish a correct policy from a wide-open one", and published that
      // sentence into `report.json`. Measured on the migrated production table on
      // 2026-08-11, as `shortkit_app` in an ordinary tenant-A transaction:
      //
      //   USING (id = ctx)  [the migration's]  -> UPDATE 1, NO ERROR   (identity update)
      //   USING (true), WITH CHECK correct     -> ERROR 23505 tenants_pkey
      //   USING (true) WITH CHECK (true)       -> ERROR 23505 tenants_pkey
      //
      // The policy is evaluated FIRST and is exactly what prevents the collision. So the
      // shape separates the cases cleanly, and the passing half of that measurement runs
      // on every CI run as `tenants` itself — see the F-342 test over the main battery.
      // THIS is the failing half, as permanent DDL rather than as a claim in a report.
      const control = await runCrossTenantAttempts([pkOwnerCanaryAccess], fixtures);

      expect(labelled(control.attempts.filter((outcome) => outcome.outcome === 'unverified'))).toEqual([
        'A->B reparentAll',
        'A->B updateAll',
        'B->A reparentAll',
        'B->A updateAll',
      ]);

      // ...and the owner-column write is refused BY THE INDEX, which the harness cannot
      // attribute to a policy — so it lands as `unverified` naming the surface rather
      // than as a `fail` naming a victim. Stated here because that is the honest, and
      // narrower, reason the shape is worth running on this table shape.
      for (const outcome of control.attempts.filter((o) => o.method === 'reparentAll')) {
        expect(outcome.refusalKind).toBe('unrecognised');
        expect(outcome.refusedWith).toContain('23505');
      }

      // The unqualified overwrite is refused by the WITH CHECK instead, which is F-330's
      // rule doing its job on this table shape as well.
      for (const outcome of control.attempts.filter((o) => o.method === 'updateAll')) {
        expect(outcome.refusalKind).toBe('row-level-security');
      }

      expect(control.attempts).toHaveLength(16);
      expect(control.attempts.filter((outcome) => outcome.outcome === 'pass')).toHaveLength(12);
      expect(control.registryDrift).toEqual({
        inDatabaseNotRegistered: [],
        registeredNotInDatabase: [],
      });
      expect(control.verdict).toBe('fail');
    }, 180_000);

    it('F-344: a correctly isolated table whose WITH CHECK is stricter than its USING is reported clean', async () => {
      // THE ONLY CONTROL IN THIS FILE THAT MUST COME BACK ENTIRELY GREEN, and it is a
      // control for exactly that reason: r3's rule — an unqualified write refused by
      // row-level security is `unverified` rather than `pass` (F-330) — fired on a table
      // with nothing wrong with it, and left the run permanently red with no escape.
      //
      // MEASURED, on `isolation_guarded_check_canary`: one `FOR ALL` policy whose USING
      // is the production predicate and whose WITH CHECK carries one ordinary business
      // guard, `status <> 'locked'`, with both seeded rows locked. Tenant A sees exactly
      // its own row — correct isolation — and yet `update <t> set label = '...'` is
      // refused with `new row violates row-level security policy`, scores `unverified`,
      // and fails the run. `reparentAll` was refused identically, so the remedy the
      // message itself offered did not work either. A check that goes red on correct code
      // is the check that gets deleted rather than fixed.
      //
      // The rule is unchanged. What changed is that the registration can name the columns
      // the WITH CHECK requires, so the unqualified writes are ADMITTED and judged on
      // their row count — the judgement that sees a wide-open USING. The break this test
      // catches: `unqualifiedWritesAlsoSet` dropped from the registration, or from the
      // two statements that carry it.
      const control = await runCrossTenantAttempts([guardedCheckCanaryAccess], fixtures);

      expect(labelled(control.attempts.filter((outcome) => outcome.outcome !== 'pass'))).toEqual([]);
      expect(control.attempts).toHaveLength(16);

      // ...and they were ADMITTED rather than merely not-refused: each unqualified write
      // reported exactly the one row the acting tenant owns. A refused statement reports
      // no row count at all, which is how this differs from every other control here.
      const unqualifiedWrites = control.attempts.filter(
        (outcome) => outcome.kind === 'write' && outcome.qualification === 'unqualified',
      );

      expect(labelled(unqualifiedWrites)).toEqual([
        'A->B deleteAll',
        'A->B reparentAll',
        'A->B updateAll',
        'B->A deleteAll',
        'B->A reparentAll',
        'B->A updateAll',
      ]);

      // ⚠ `rowsAffected: 1` IS ALSO WHAT A DISARMED STATEMENT REPORTS, AND THAT IS WHY
      // THE ASSERTION SURVIVED r5 UNCHANGED RATHER THAN BEING WEAKENED (F-352). Under
      // r4's free-`SQL` field, `status = status` referenced a column, PostgreSQL applied
      // the SELECT policy, and both unqualified writes reported exactly 1 — the same
      // number a correctly scoped USING clause produces here. The count alone could not
      // tell the two apart.
      //
      // What makes 1 mean something is that the disarmed statement is no longer
      // EXPRESSIBLE: `unqualifiedWritesAlsoSet` is `{ column, value }[]` and the value is
      // bound as `$N`, so `updateAll` on this table can only be
      // `set "label" = $1, "status" = $2` and its row count is the USING clause's answer.
      // `isolation_guarded_leak_canary` is the other half of the pair, one test below:
      // the SAME registration mechanism over a wide-open USING, reporting 2 and failing.
      // Together they say the count discriminates; either alone does not.
      for (const outcome of unqualifiedWrites) {
        expect(outcome.rowsAffected).toBe(1);
        expect(outcome.actorOwnRowsVisible).toBe(1);
        expect(outcome.refusedWith).toBeUndefined();
      }

      expect(control.registryDrift).toEqual({
        inDatabaseNotRegistered: [],
        registeredNotInDatabase: [],
      });
      expect(control.verdict).toBe('pass');
    }, 180_000);

    it('F-352: a stricter WITH CHECK over a wide-open USING is reported as failing, not satisfied into silence', async () => {
      // F-344's escape was a free `SQL` fragment, and the field claimed it "cannot hide a
      // leak: the statement still carries no WHERE clause, so it still sweeps every row
      // the USING clause admits". THE WHERE CLAUSE IS NOT WHAT KEEPS THE SELECT POLICIES
      // OUT — a column reference anywhere in the statement pulls them back in, and a SET
      // expression is part of the statement. Measured on this table, tenant A,
      // 2026-08-11:
      //
      //   set label = <const>                                -> 42501, refused
      //   set label = <const>, lock_token = lock_token||'x'   -> UPDATE 1  SILENT
      //   set label = <const>, lock_token = 'held'            -> UPDATE 2  THE LEAK
      //   set tenant_id = <A>, lock_token = lock_token||'x'   -> UPDATE 1  SILENT
      //   set tenant_id = <A>, lock_token = 'held'            -> UPDATE 2  THE LEAK
      //
      // `lock_token = lock_token || 'x'` is the ordinary optimistic-lock idiom and it
      // disarms BOTH unqualified writes at once. This table's UPDATE policy admits every
      // row of every tenant, and under that registration the whole control came back
      // `pass`. The break this test catches: the assignment's value derived from a column
      // rather than bound — which since r5 is unexpressible, and this is the measurement
      // that says so rather than the type.
      const control = await runCrossTenantAttempts([guardedLeakCanaryAccess], fixtures);

      // The three owner-qualified writes are routed through the correct SELECT policy and
      // report zero rows, exactly as on `isolation_unqualified_write_canary`; only the
      // two statements that reference no existing column can see this policy at all.
      expect(labelled(control.attempts.filter((outcome) => outcome.outcome === 'fail'))).toEqual([
        'A->B reparentAll',
        'A->B updateAll',
        'B->A reparentAll',
        'B->A updateAll',
      ]);
      expect(control.attempts).toHaveLength(16);

      // ...and nothing came back `unverified`: the two unqualified writes were ADMITTED
      // by the WITH CHECK rather than refused by it, which is the whole point of naming
      // the column. A refusal here would prove the check held and nothing about the USING.
      expect(labelled(control.attempts.filter((outcome) => outcome.outcome === 'unverified'))).toEqual(
        [],
      );

      // Each failure names the victim and the arithmetic: two rows swept by a statement
      // issued by a tenant that was shown exactly one row of its own.
      for (const outcome of control.attempts.filter((o) => o.outcome === 'fail')) {
        expect(outcome.rowsAffected).toBe(2);
        expect(outcome.leaks.join(' ')).toContain(outcome.target ?? '');
        expect(outcome.leaks.join(' ')).toContain('2 row(s) affected');
        expect(outcome.leaks.join(' ')).toContain('only 1 row(s) of its own');
      }

      expect(control.registryDrift).toEqual({
        inDatabaseNotRegistered: [],
        registeredNotInDatabase: [],
      });
      expect(control.verdict).toBe('fail');
    }, 180_000);

    it('F-352: the closest thing to a column reference the shape admits is a bound value, and the leak is still reported', async () => {
      // THE FALSIFICATION ATTEMPT ON r5's OWN GUARANTEE, KEPT AS A CONTROL. The guarantee
      // is "no value this field admits can reference a column", and the way to break it
      // without changing the type is for the BUILDER to stop binding — `sql.raw`, a
      // template concatenation, a helper that "supports expressions". Under that mutation
      // the value below stops being the string `'lock_token'` and becomes the column
      // `lock_token`, both unqualified writes drop to the actor's own row, and this
      // table's wide-open USING becomes invisible again.
      //
      // Same table, same defect, same mechanism as the test above; only the value differs.
      // Measured, tenant A, 2026-08-11: `set label = <const>, lock_token = 'lock_token'`
      // reports UPDATE 2, because `"lock_token" = $2` is a parameter and not a reference.
      const control = await runCrossTenantAttempts([guardedLeakBoundValueCanaryAccess], fixtures);

      expect(labelled(control.attempts.filter((outcome) => outcome.outcome === 'fail'))).toEqual([
        'A->B reparentAll',
        'A->B updateAll',
        'B->A reparentAll',
        'B->A updateAll',
      ]);

      for (const outcome of control.attempts.filter((o) => o.outcome === 'fail')) {
        expect(outcome.rowsAffected).toBe(2);
        expect(outcome.leaks.join(' ')).toContain('2 row(s) affected');
      }

      expect(control.verdict).toBe('fail');
    }, 180_000);
  });

  it('F-331: report.json carries no verdict while the tests that could disprove it are still running', async () => {
    // MEASURED, in the same run that reproduced F-330: `Tests 1 failed | 17 passed (18)`,
    // EXIT=1, and `report.json` read `verdict=pass attempts=28 failed=[]` FOR THAT RUN —
    // not a stale one. `writeIsolationReport()` was the last statement in `beforeAll`,
    // and eleven of this file's tests run after it, including `assertNoTenantIdAltered()`
    // — whose failure is BY CONSTRUCTION something no attempt judged.
    //
    // So while this test is executing, the artifact must carry the attempts and NO
    // verdict. The break this catches: the final write moved back into `beforeAll`.
    const inFlight = JSON.parse(readFileSync(REPORT_PATH, 'utf8')) as IsolationReport;

    expect(inFlight.verdict).toBe('incomplete');
    expect(inFlight.suiteOutcome).toBe('incomplete');

    // ...and it is not an empty marker: the attempts are this run's and were judged, so a
    // process killed here strands the evidence without stranding a verdict.
    expect(inFlight.attempts).toHaveLength(32);
    expect(inFlight.attemptVerdict).toBe('pass');
    expect(inFlight.incompleteBecause).toContain('had not finished');

    // The conjunction is only computed in `afterAll`, so no assertion in this file can
    // observe the final write. What CAN be asserted here is that the attempt judgement
    // alone is not enough to publish a pass — `assertNoTenantIdAltered()` runs after this
    // test and is exactly the check that would contradict it.
    await expect(assertNoTenantIdAltered()).resolves.toBeUndefined();
  }, 180_000);

  it('F-304: report.json says `incomplete` from the moment a run starts, so a run that dies leaves no stale pass', () => {
    // MEASURED, on 2026-08-11. `report.json` was written once, after the attempts. With
    // `tenants_self_select` altered to `USING (true)`, `createTenantFixtures()` threw in
    // `beforeAll` — the F-293 absolute census assertion doing exactly its job — vitest
    // exited 1 with all 15 tests skipped, and the artifact on disk still read
    // `verdict=pass` carrying the PREVIOUS run's `runAt`. The most alarming failure this
    // harness has was precisely the one that stranded a green artifact, and F-297 is
    // about to start uploading that artifact from CI.
    //
    // The break this catches: `beginIsolationReport()` removed from module scope, or
    // moved back below anything that can throw. Both put a stale `pass` back on disk.
    const marker = JSON.parse(reportOnDiskWhileTheRunWasInFlight) as IsolationReport;

    expect(marker.verdict).toBe('incomplete');
    expect(marker.incompleteBecause).toContain('NOTHING HERE IS EVIDENCE OF ISOLATION');
    expect(marker.attempts).toEqual([]);
    expect(marker.failed).toEqual([]);

    // ...and the run moved past it, which is the other half: an artifact permanently
    // stuck at the empty marker would satisfy every assertion above and tell CI nothing.
    // The file now on disk is THIS run's attempts, written after they were judged.
    //
    // The final verdict is deliberately NOT read here. It is published in `afterAll`,
    // after this test has finished, for the reason F-331 gives — and no assertion inside
    // a suite can observe its own suite's last write. That step is measured externally
    // and recorded in the round's report.
    const afterTheAttempts = JSON.parse(readFileSync(REPORT_PATH, 'utf8')) as IsolationReport;

    expect(afterTheAttempts.attempts).toHaveLength(32);
    expect(afterTheAttempts.runAt).not.toBe(marker.runAt);
  });

  it('F-343: a failing test inside a nested describe is observed, so a red file cannot publish a green verdict', () => {
    // VERIFIED AGAINST @vitest/runner@3.2.7's OWN SHAPE, and then against the real tree
    // in the test below. `Task = Test | Suite | File`, `Suite` carries `tasks: Task[]`,
    // and a nested `describe` therefore arrives as `type: "suite"`. The r3 mechanism did
    // `tasks.filter((task) => task.type === 'test')` over ONE level, so the group of
    // control tests above — grouped in this round, which is the ordinary way this file
    // grows — would have been filtered out entirely, the remaining top-level states would
    // all have read `pass`, and `finishIsolationReport()` would have published
    // `verdict: 'pass'` while vitest exited 1. F-331 restored by an ordinary edit.
    //
    // The tree below is hand-built to that documented shape, with the failure buried two
    // levels down. The break this catches: the recursion removed.
    const oneFailureTwoLevelsDown = {
      type: 'suite',
      tasks: [
        { type: 'test', result: { state: 'pass' } },
        {
          type: 'suite',
          tasks: [
            { type: 'test', result: { state: 'pass' } },
            {
              type: 'suite',
              tasks: [{ type: 'test', result: { state: 'fail' } }],
            },
          ],
        },
      ],
    };

    expect(suiteOutcomeOf(oneFailureTwoLevelsDown)).toBe('fail');

    // ...and every one of the three is counted, in tree order, which is the half that
    // makes the shrink loud rather than silent: a mechanism that sees fewer tests than
    // the file has cannot be told from one that sees them all pass.
    expect(testStatesOf(oneFailureTwoLevelsDown)).toEqual(['pass', 'pass', 'fail']);
  });

  it('F-343: every test in this file is observed by the mechanism that publishes the verdict', (context) => {
    // THE SYNTHETIC TREE ABOVE PROVES THE FUNCTION; THIS PROVES IT AGAINST THE RUNNER.
    // `context.task.file` is the File task vitest built for this file, fully collected,
    // so the count is over the same tree `afterAll` will read. TESTS_IN_THIS_FILE is
    // hand-written for the reason EXPECTED_SURFACE_IDS is: a test that stops being
    // counted, or one added without the count moving, has to arrive as a visible diff.
    const file = (context as unknown as { task: { file: unknown } }).task.file;

    expect(testStatesOf(file)).toHaveLength(TESTS_IN_THIS_FILE);

    // ...and the file really is nested, computed here WITHOUT the mechanism under test,
    // so the recursion above is exercised by the real runner on every CI run rather than
    // only by the fixture. Flattening the control group makes these equal and fails here.
    const topLevelOnly = ((file as { tasks?: { type?: string }[] }).tasks ?? [])
      .flatMap((task) => (task.type === 'suite' ? ((task as { tasks?: { type?: string }[] }).tasks ?? []) : [task]))
      .filter((task) => task.type === 'test').length;

    expect(topLevelOnly).toBeLessThan(TESTS_IN_THIS_FILE);
  });

  it('F-345: a statement\'s qualification is derived from the SQL it issues, not taken on trust', () => {
    // `qualification` selects the count rule (`affected > 0` versus `affected >
    // actorOwnRowsVisible`), the F-330 refusal rule (`pass` versus `unverified`) and the
    // post-attempt `reset()` — three judgements — and it was a string literal sitting
    // beside the SQL it claimed to describe, with nothing but review between them.
    //
    // The expectations are hand-derived from the statements beside them. The break this
    // catches: the derivation reading the wrong half of the rule.
    expect(qualificationOfStatement(sql`update ${sql.identifier('t')} set ${sql.identifier('label')} = ${'x'}`)).toBe(
      'unqualified',
    );
    expect(
      qualificationOfStatement(
        sql`update ${sql.identifier('t')} set ${sql.identifier('label')} = ${'x'} where ${sql.identifier('tenant_id')} = ${TENANT_A_ROW_ID}::uuid`,
      ),
    ).toBe('owner-qualified');
    expect(qualificationOfStatement(sql`delete from ${sql.identifier('t')}`)).toBe('unqualified');
    expect(qualificationOfStatement(sql`select id from ${sql.identifier('t')} order by id`)).toBe(
      'unqualified',
    );

    // An INSERT names the rows it may touch in the row it supplies, and an INSERT policy
    // has NO USING clause at all — only a WITH CHECK — so a refusal is complete evidence
    // for that statement, which is what `owner-qualified` means to the runner.
    expect(
      qualificationOfStatement(sql`insert into ${sql.identifier('t')} (id, label) values (${TENANT_A_ROW_ID}::uuid, ${'x'})`),
    ).toBe('owner-qualified');
  });

  it('F-345: a shape that labels an unqualified statement owner-qualified is refused rather than registered', () => {
    // THE BLIND SPOT THIS CLOSES, NAMED: a registration labelling an unqualified write
    // `owner-qualified` restores F-330's defect for that surface — its row-level-security
    // refusal scores `pass` again — and nothing but review stood between the label and
    // the SQL. The check runs at registration time, which is import time, so a
    // disagreement cannot reach a run at all.
    expect(() =>
      assertDeclaredQualification(
        'updateAll',
        'owner-qualified',
        sql`update ${sql.identifier('t')} set ${sql.identifier('label')} = ${'x'}`,
      ),
    ).toThrow(/updateAll/);

    // ...and the agreeing case is not refused, so the check is about the disagreement
    // rather than about the shape's name.
    expect(() =>
      assertDeclaredQualification(
        'updateAll',
        'unqualified',
        sql`update ${sql.identifier('t')} set ${sql.identifier('label')} = ${'x'}`,
      ),
    ).not.toThrow();
  });

  it('AC-12: no row changed tenant across the run (AC-95)', async () => {
    // isolation-coverage.md's declared post-run check, against the census taken when
    // the fixtures were built. A cross-tenant UPDATE that had been allowed through, or
    // a DELETE that reached another tenant's row, shows up here even if the statement
    // that did it reported nothing.
    await expect(assertNoTenantIdAltered()).resolves.toBeUndefined();
  }, 180_000);

  it('AC-12: exactly three isolation exclusions are declared', () => {
    // isolation-coverage.md's `ISOLATION_EXCLUSIONS` section and invariant 5, plus
    // ADR-0045's "The exclusion". Cited by content rather than by heading: that section
    // is still headed "exactly two" and is site 6 on TASK-002's card, so a citation by
    // title goes stale the moment TASK-002 lands.
    //
    // The LENGTH is the control, so that a fourth exclusion has to arrive as a one-line
    // diff a reviewer sees, with the written justification ADR-0020 requires. The first
    // two surfaces do not exist yet (TASK-029, TASK-054). The third is `withMembershipLookup`,
    // the token-mint escape: it and this assertion land in TASK-002's commit together,
    // because an escape in wave 1 with its entry in wave 9 is eight waves of a green
    // suite over an unlisted escape. Red until then, deliberately.
    expect(ISOLATION_EXCLUSIONS).toHaveLength(3);
    expect(ISOLATION_EXCLUSIONS.map((exclusion) => exclusion.id)).toEqual([
      'repo:RedirectReadRepository.resolveByHostAndSlug',
      'repo:PrivilegedTenantEraser.erase',
      'repo:TenantMembershipLookup.tenantIdForUser',
    ]);
  });
});
