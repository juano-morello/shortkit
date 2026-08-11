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
 * or plant a row belonging to the other, through any of SEVEN statement shapes, IN
 * EITHER DIRECTION; that two of those seven carry NO WHERE CLAUSE, so a wide-open UPDATE
 * or DELETE policy cannot hide behind a correctly scoped SELECT policy (F-302); each
 * acting tenant demonstrably could see its own row while being refused the other's;
 * every refusal the run scored as a pass was a row-level security refusal and says so in
 * `report.json`; and the set of tables carrying a tenant boundary in the database — by
 * four independent properties, none of which assumes the owner column is called
 * `tenant_id` (F-303) — is exactly the set the registry knows about. Every one of those
 * is a real statement against a live Postgres, issued through `withTenantTransaction` as
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
 * answered — including the seven negative controls, which are real tables carrying real
 * defects that really do leak, not assertions about the harness's shape.
 *
 * ONE TEST BELOW IS THE EXCEPTION AND IT SAYS SO: the F-304 test asserts what is in
 * `report.json` on disk part-way through a run. That is not a helper's shape, it is the
 * artifact SC-1 points at and F-297 is about to upload, and the measured defect was that
 * the file kept the PREVIOUS run's verdict when a run died.
 *
 * ---------------------------------------------------------------------------
 * THE SEVEN CONTROLS, AND THE FINDING EACH ONE ANSWERS
 * ---------------------------------------------------------------------------
 *
 * Two audit rounds measured this suite reporting `pass` over a database that was not
 * isolated, six ways. Each way is now a table the suite builds, attacks and requires a
 * non-`pass` answer for, so the measurement runs on every CI run instead of once:
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
 *
 * ...plus two probes for tables nobody registered, `wave3_workspaces_probe` (F-296) and
 * `wave3_audit_events_probe` (F-303), which the drift check has to name.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenantTransaction } from '../../src/tenancy/tenant-context';

import {
  beginIsolationReport,
  createTenantFixtures,
  formatIsolationReport,
  ISOLATION_EXCLUSIONS,
  registeredSubjects,
  runCrossTenantAttempts,
  tenantOwnershipCensus,
  tenantScopedTableDrift,
  writeIsolationReport,
  assertNoTenantIdAltered,
} from './coverage';
import type { AttemptOutcome, IsolationReport, TenantFixtures } from './coverage';
import {
  createUnregisteredOwnerColumnProbe,
  createUnregisteredTableProbe,
  dropControlTables,
  dropUnregisteredOwnerColumnProbe,
  dropUnregisteredTableProbe,
  UNREGISTERED_OWNER_COLUMN_PROBE,
  UNREGISTERED_TABLE_PROBE,
} from './controls';
import { createLeakCanary, dropLeakCanary, leakCanaryProtection } from './leak-canary';
import {
  baselineLeakCanaryAccess,
  directionCanaryAccess,
  EXPECTED_SURFACE_IDS,
  grantGapCanaryAccess,
  halfSeededCanaryAccess,
  leakCanaryAccess,
  maskedRefusalCanaryAccess,
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
  let report: IsolationReport;
  /** F-304. What was on disk between the run starting and the run finishing. */
  let reportOnDiskWhileTheRunWasInFlight: string;

  beforeAll(async () => {
    // F-304. FIRST, BEFORE ANYTHING THAT CAN THROW. Everything below this line can:
    // `assertAppRoleCannotBypassRls()` throws on a bypassing role and
    // `createTenantFixtures()` throws on a leak that is already present, which is the
    // single most alarming failure this harness has. Until r2's second round the
    // artifact was written once, at the end, so each of those left the PREVIOUS run's
    // `"verdict": "pass"` on disk for CI to publish as evidence.
    beginIsolationReport(REPORT_PATH);
    reportOnDiskWhileTheRunWasInFlight = readFileSync(REPORT_PATH, 'utf8');

    // Without this every assertion below passes vacuously: a role exempt from row-level
    // security makes a correct implementation and a missing one look identical.
    assertAppRoleCannotBypassRls();

    fixtures = await createTenantFixtures();
    report = await runCrossTenantAttempts(registeredSubjects(), fixtures);

    writeIsolationReport(report, REPORT_PATH);
    // AC-12's "its output enumerates which methods were exercised", in the run log.
    console.log(formatIsolationReport(report));
  }, 300_000);

  afterAll(() => {
    dropLeakCanary();
    dropControlTables();
    dropRlsFixture();
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

    expect(leakedSurfaces(report)).toEqual([]);
    expect(withOutcome(report, 'unverified')).toEqual([]);
    expect(report.verdict).toBe('pass');
  });

  it('AC-12: the report enumerates every method it exercised, and reports pass or fail for each', () => {
    // Hand-written in registrations.ts and compared here, so a battery that quietly
    // loses a statement shape — or a registration that stops registering — fails with
    // the missing id named, rather than reporting a smaller clean run.
    expect([...report.covered].sort()).toEqual([...EXPECTED_SURFACE_IDS]);

    expect(report.attempts.map((outcome) => outcome.outcome)).toEqual(
      report.attempts.map(() => 'pass'),
    );

    // Fourteen surfaces, each attempted in both directions (F-293). Reads and writes
    // are both exercised: AC-94 covers the reads and AC-95 the writes, and a battery
    // that had lost all of one kind would still satisfy the count above.
    expect(report.attempts).toHaveLength(28);
    expect(report.attempts.filter((outcome) => outcome.kind === 'read')).toHaveLength(8);
    expect(report.attempts.filter((outcome) => outcome.kind === 'write')).toHaveLength(20);

    // F-302. Four of those twenty writes carry NO WHERE CLAUSE — `updateAll` and
    // `deleteAll` per table, per direction. Hand-derived, because a battery that
    // silently lost them is a battery that cannot see a wide-open UPDATE policy, and
    // the counts above would not move if `updateAll` were quietly replaced by a second
    // owner-qualified statement.
    expect(
      labelled(
        report.attempts.filter(
          (outcome) => outcome.kind === 'write' && outcome.qualification === 'unqualified',
        ),
      ),
    ).toEqual([
      'A->B deleteAll',
      'A->B deleteAll',
      'A->B updateAll',
      'A->B updateAll',
      'B->A deleteAll',
      'B->A deleteAll',
      'B->A updateAll',
      'B->A updateAll',
    ]);
  });

  it('F-293: every registered surface is attempted in both directions, not only as tenant A', () => {
    // The blocker r1 found: `attempt()` had one call site and it read
    // `method.attempt(fixtures.tenantA, fixtures.tenantB)`, so the actor was always A
    // and a policy that leaks only to B was never attempted. Both lists are the same
    // ten ids, which is what "both directions" means.
    const forward = report.attempts.filter((outcome) => outcome.direction === 'A->B');
    const reverse = report.attempts.filter((outcome) => outcome.direction === 'B->A');

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
    const refused = report.attempts.filter((outcome) => outcome.refusedWith !== undefined);

    expect(labelled(refused)).toEqual([
      'A->B insertOwnedBy',
      'A->B insertOwnedBy',
      'B->A insertOwnedBy',
      'B->A insertOwnedBy',
    ]);

    for (const outcome of refused) {
      expect(outcome.refusalKind).toBe('row-level-security');
      expect(outcome.refusedWith).toMatch(/violates row-level security policy/);
    }
  });

  it('F-296: the registry and the database agree on which tables carry a tenant boundary', () => {
    // ADR-0019's cross-check, SQL half. `discoveredSurfaces()` maps over the registry,
    // so `uncovered` is structurally `[]` and a table nobody registers is invisible to
    // the suite rather than reported by it. This is the assertion that is not.
    expect(tenantScopedTableDrift()).toEqual({
      inDatabaseNotRegistered: [],
      registeredNotInDatabase: [],
    });
    expect(report.registryDrift).toEqual({
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
    expect(control.attempts).toHaveLength(14);
    expect(control.verdict).toBe('fail');

    // ...and each one says WHOSE row leaked, which is what makes a real red run
    // actionable rather than a bare `false !== true`.
    const forward = control.attempts.filter((outcome) => outcome.direction === 'A->B');
    const reverse = control.attempts.filter((outcome) => outcome.direction === 'B->A');

    expect(forward).toHaveLength(7);
    expect(reverse).toHaveLength(7);

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
    expect(control.attempts).toHaveLength(14);

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
    expect(control.attempts).toHaveLength(14);

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
      'A->B updateAll',
      'A->B updateOwnedBy',
      'B->A deleteAll',
      'B->A deleteOwnedBy',
      'B->A insertOwnedBy',
      'B->A updateAll',
      'B->A updateOwnedBy',
    ]);
    expect(control.attempts).toHaveLength(14);

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
    expect(control.attempts).toHaveLength(14);

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
      'A->B updateAll',
      'B->A deleteAll',
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
    expect(control.attempts).toHaveLength(14);

    const unverified = control.attempts.filter((outcome) => outcome.outcome === 'unverified');

    expect(unverified).toHaveLength(13);
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
      'A->B updateAll',
      'B->A deleteAll',
      'B->A updateAll',
    ]);
    expect(control.attempts).toHaveLength(14);
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

  it('F-303: a tenant-scoped table whose owner column is not called tenant_id is named, rather than silently uncovered', async () => {
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
    createUnregisteredOwnerColumnProbe();

    try {
      expect(tenantScopedTableDrift()).toEqual({
        inDatabaseNotRegistered: [UNREGISTERED_OWNER_COLUMN_PROBE],
        registeredNotInDatabase: [],
      });

      // ...and it really does leak, so the drift check is the only thing between this
      // table and a green run. Read through the production path as `shortkit_app`, in
      // tenant A's transaction: a correct policy answers zero rows here.
      const seenByTenantA = await withTenantTransaction(
        fixtures.tenantA.id,
        async (db): Promise<{ owning_tenant: string }[]> => {
          const result = await db.execute<{ owning_tenant: string }>(
            sql`select owning_tenant from ${sql.identifier(UNREGISTERED_OWNER_COLUMN_PROBE)}`,
          );

          return [...result.rows];
        },
      );

      expect(seenByTenantA.map((row) => row.owning_tenant)).toEqual([fixtures.tenantB.id]);
    } finally {
      dropUnregisteredOwnerColumnProbe();
    }
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
    // The break this catches: `beginIsolationReport()` removed from `beforeAll`, or
    // moved below anything that can throw. Both put a stale `pass` back on disk.
    const inFlight = JSON.parse(reportOnDiskWhileTheRunWasInFlight) as IsolationReport;

    expect(inFlight.verdict).toBe('incomplete');
    expect(inFlight.incompleteBecause).toContain('NOTHING HERE IS EVIDENCE OF ISOLATION');
    expect(inFlight.attempts).toEqual([]);

    // ...and the completed run overwrote it, which is the other half: an artifact
    // permanently stuck at `incomplete` would satisfy the assertion above and tell CI
    // nothing.
    //
    // Deliberately NOT asserted as `pass` here. Whether this run passed is what the
    // AC-12 test above decides; coupling that verdict into this one would make the
    // F-304 assertion fail on every genuine leak, which is precisely when a reader most
    // needs to know the artifact is this run's and not the last one's.
    const finished = JSON.parse(readFileSync(REPORT_PATH, 'utf8')) as IsolationReport;

    expect(finished.verdict).not.toBe('incomplete');
    expect(finished.incompleteBecause).toBeUndefined();
    expect(finished.attempts).toHaveLength(28);
    expect(finished.runAt).not.toBe(inFlight.runAt);
  });

  it('AC-12: no row changed tenant across the run (AC-95)', async () => {
    // isolation-coverage.md's declared post-run check, against the census taken when
    // the fixtures were built. A cross-tenant UPDATE that had been allowed through, or
    // a DELETE that reached another tenant's row, shows up here even if the statement
    // that did it reported nothing.
    await expect(assertNoTenantIdAltered()).resolves.toBeUndefined();
  }, 180_000);

  it('AC-12: exactly two isolation exclusions are declared', () => {
    // isolation-coverage.md, "Exclusions: exactly two", and invariant 5. Neither surface
    // exists yet; the LENGTH is the control, so that a third exclusion has to arrive as
    // a one-line diff a reviewer sees, with the written justification ADR-0020 requires.
    expect(ISOLATION_EXCLUSIONS).toHaveLength(2);
    expect(ISOLATION_EXCLUSIONS.map((exclusion) => exclusion.id)).toEqual([
      'repo:RedirectReadRepository.resolveByHostAndSlug',
      'repo:PrivilegedTenantEraser.erase',
    ]);
  });
});
