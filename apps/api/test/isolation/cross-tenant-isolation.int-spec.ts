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
 * or plant a row belonging to the other, through any of five statement shapes, IN EITHER
 * DIRECTION; each acting tenant demonstrably could see its own row while being refused
 * the other's; every refusal the run scored as a pass was a row-level security refusal
 * and says so in `report.json`; and the set of tables carrying a tenant boundary in the
 * database is exactly the set the registry knows about. Every one of those is a real
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
 * answered — including the six negative controls, which are real tables carrying real
 * defects that really do leak, not assertions about the harness's shape.
 *
 * ---------------------------------------------------------------------------
 * THE SIX CONTROLS, AND THE FINDING EACH ONE ANSWERS (r2)
 * ---------------------------------------------------------------------------
 *
 * The r1 audit measured this suite reporting `pass` over a database that was not
 * isolated, four ways. Each way is now a table the suite builds, attacks and requires a
 * non-`pass` answer for, so the measurement runs on every CI run instead of once:
 *
 *   isolation_leak_canary             no row-level security at all      (the r1 control)
 *   isolation_direction_canary        leaks only to one tenant, on INSERT only   (F-293)
 *   isolation_baseline_leak_canary    leaks on read, already at baseline         (F-293)
 *   isolation_grant_gap_canary        42501 from a missing grant, not a policy   (F-294)
 *   isolation_masked_refusal_canary   wide-open policy, 23514 masking it         (F-294)
 *   isolation_half_seeded_canary      correct policies, target owns no row       (F-295)
 */
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
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
  createUnregisteredTableProbe,
  dropControlTables,
  dropUnregisteredTableProbe,
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

  beforeAll(async () => {
    // Without this every assertion below passes vacuously: a role exempt from row-level
    // security makes a correct implementation and a missing one look identical.
    assertAppRoleCannotBypassRls();

    fixtures = await createTenantFixtures();
    report = await runCrossTenantAttempts(registeredSubjects(), fixtures);

    writeIsolationReport(report, REPORT_PATH);
    // AC-12's "its output enumerates which methods were exercised", in the run log.
    console.log(formatIsolationReport(report));
  }, 180_000);

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

    // Ten surfaces, each attempted in both directions (F-293). Reads and writes are
    // both exercised: AC-94 covers the reads and AC-95 the writes, and a battery that
    // had lost all of one kind would still satisfy the count above.
    expect(report.attempts).toHaveLength(20);
    expect(report.attempts.filter((outcome) => outcome.kind === 'read')).toHaveLength(8);
    expect(report.attempts.filter((outcome) => outcome.kind === 'write')).toHaveLength(12);
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

    // Every one of the ten, not merely the verdict, and `fail` rather than "not a
    // pass": a harness that had stopped detecting anything on reads would still fail
    // the run on a write, and an attempt reported `unverified` here would mean the
    // control had stopped being a leak.
    expect(control.attempts.filter((outcome) => outcome.outcome !== 'fail')).toEqual([]);
    expect(control.attempts).toHaveLength(10);
    expect(control.verdict).toBe('fail');

    // ...and each one says WHOSE row leaked, which is what makes a real red run
    // actionable rather than a bare `false !== true`.
    const forward = control.attempts.filter((outcome) => outcome.direction === 'A->B');
    const reverse = control.attempts.filter((outcome) => outcome.direction === 'B->A');

    expect(forward).toHaveLength(5);
    expect(reverse).toHaveLength(5);

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
    expect(control.attempts).toHaveLength(10);

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
    expect(control.attempts).toHaveLength(10);

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
      'A->B deleteOwnedBy',
      'A->B insertOwnedBy',
      'A->B updateOwnedBy',
      'B->A deleteOwnedBy',
      'B->A insertOwnedBy',
      'B->A updateOwnedBy',
    ]);
    expect(control.attempts).toHaveLength(10);

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
    expect(control.attempts).toHaveLength(10);

    for (const outcome of masked) {
      expect(outcome.refusalKind).toBe('unrecognised');
      expect(outcome.refusedWith).toContain('23514');
    }

    // The reads are scoped correctly and the update and delete reach nothing they can
    // see, so those eight are real passes — which is what makes the two above a
    // statement about the refusal rather than about the table.
    expect(control.attempts.filter((outcome) => outcome.outcome === 'pass')).toHaveLength(8);
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
    expect(control.attempts).toHaveLength(10);

    const unverified = control.attempts.filter((outcome) => outcome.outcome === 'unverified');

    expect(unverified).toHaveLength(9);
    expect(unverified.filter((outcome) => outcome.unverifiedBecause === undefined)).toEqual([]);

    // The row counts that make "denied" and "found nothing" different answers, in the
    // artifact rather than only in a judgement.
    expect(
      control.attempts.filter((outcome) => outcome.kind === 'read' && outcome.rowsSeen === undefined),
    ).toEqual([]);

    expect(control.verdict).toBe('fail');
  }, 180_000);

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
