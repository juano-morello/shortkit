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
 * tenant transaction belonging to A cannot read, filter for, update, delete or plant a
 * row belonging to B, through any of five statement shapes; and no attempt moved a row
 * between tenants. Every one of those is a real statement against a live Postgres,
 * issued through `withTenantTransaction` as `shortkit_app`, a role holding neither
 * SUPERUSER nor BYPASSRLS.
 *
 * IT DOES NOT SAY the system has no uncovered cross-tenant surface. Most of the system
 * is unwritten: there is no authenticated route, no repository class, and no
 * `workspaces`, `links`, `domains`, `tenant_memberships` or `click_events` table. Route
 * and repository discovery — isolation-coverage.md's three enumeration mechanisms, the
 * four grep clauses and the `pg_policies` shape assertion — are TASK-056's. AC-12 is
 * met against a partial table set, deliberately and by ruling, and the boundary is
 * printed into `report.json` on every run so the artifact SC-1 points at carries it too.
 *
 * ---------------------------------------------------------------------------
 * NO TEST HERE ASSERTS THAT A TEST HELPER WORKS
 * ---------------------------------------------------------------------------
 *
 * Declined 2026-08-06: a test asserting that a test helper works is the shape this
 * initiative has twice called hollow. Every assertion below is about what Postgres
 * answered — including the negative control, which is a real unprotected table that
 * really does leak, not an assertion about the harness's shape.
 */
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createTenantFixtures,
  formatIsolationReport,
  ISOLATION_EXCLUSIONS,
  registeredSubjects,
  runCrossTenantAttempts,
  writeIsolationReport,
  assertNoTenantIdAltered,
} from './coverage';
import type { IsolationReport, TenantFixtures } from './coverage';
import { createLeakCanary, dropLeakCanary, leakCanaryProtection } from './leak-canary';
import { EXPECTED_SURFACE_IDS, leakCanaryAccess } from './registrations';
import { querySql } from '../support/psql';
import {
  assertAppRoleCannotBypassRls,
  dropRlsFixture,
  migrationDsn,
  RLS_FIXTURE_TABLE,
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
    .map((outcome) => `${outcome.id}: ${outcome.leaks.join(' | ')}`);
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
    expect(report.verdict).toBe('pass');
  });

  it('AC-12: the report enumerates every method it exercised, and reports pass or fail for each', () => {
    // Hand-written in registrations.ts and compared here, so a battery that quietly
    // loses a statement shape — or a registration that stops registering — fails with
    // the missing id named, rather than reporting a smaller clean run.
    expect([...report.covered].sort()).toEqual([...EXPECTED_SURFACE_IDS]);

    expect(report.attempts.map((outcome) => outcome.outcome)).toEqual(
      EXPECTED_SURFACE_IDS.map(() => 'pass'),
    );

    // Reads and writes are both exercised: AC-94 covers the reads and AC-95 the writes,
    // and a battery that had lost all of one kind would still satisfy the count above.
    expect(report.attempts.filter((outcome) => outcome.kind === 'read')).toHaveLength(4);
    expect(report.attempts.filter((outcome) => outcome.kind === 'write')).toHaveLength(6);
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

    // Every one of the five, not merely the verdict: a harness that had stopped
    // detecting anything on reads would still fail the run on a write, and the point of
    // this control is that each statement shape is independently live.
    expect(control.attempts.filter((outcome) => outcome.outcome === 'pass')).toEqual([]);
    expect(control.attempts).toHaveLength(5);
    expect(control.verdict).toBe('fail');

    // ...and each one says WHAT leaked, which is what makes a real red run actionable
    // rather than a bare `false !== true`.
    for (const outcome of control.attempts) {
      expect(outcome.leaks.join(' ')).toContain(fixtures.tenantB.id);
    }
  }, 180_000);

  it('AC-12: no row changed tenant across the run (AC-95)', async () => {
    // isolation-coverage.md's declared post-run check, against the census taken when
    // the fixtures were built. A cross-tenant UPDATE that had been allowed through, or
    // a DELETE that reached another tenant's row, shows up here even if the statement
    // that did it reported nothing.
    await expect(assertNoTenantIdAltered()).resolves.toBeUndefined();
  });

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
