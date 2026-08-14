/**
 * STORY-001 — TASK-002. ADR-0049's behavioural control.
 *
 * Contract: `design/contracts/rls-policy-template.md`, `design/contracts/tenant-context.md`.
 * ADR: adr-0049-context-flags-are-never-cast-directly.md, adr-0050.
 *
 * ============================================================================
 * THE STATE UNDER TEST IS THE CONNECTION'S, NOT THE SCHEMA'S.
 * ============================================================================
 *
 * A transaction-local `set_config` creates a session-level placeholder whose RESET VALUE IS
 * THE EMPTY STRING, not NULL, and `pg.Pool` returns the backend to the pool with no reset
 * query. From the first committed tenant transaction onward, every later checkout of that
 * physical connection reads `current_setting('app.tenant_id', true)` as `''` rather than
 * NULL — so `''::uuid` is evaluated and raises `22P02 invalid input syntax for type uuid:
 * ""`. That is the state the application actually runs in, and AC-10's plain out-of-context
 * read fails in it while passing on a cold backend, which is the only state the fixture
 * creates by default (F-003, F-004, F-005).
 *
 * `nullif(<flag>, '')` collapses unset and reset to NULL alike. This control is what cannot
 * be evaded by rendering: `check-policies.mts`'s counting control reads the catalogue and
 * cannot see a flag reached through a view, a function wrapper or a stable helper.
 *
 * ============================================================================
 * THE TABLE SET IS COMPUTED, AND IT IS NOT ALL OF SCHEMA `public`.
 * ============================================================================
 *
 * After migration `0001` the five Better Auth tables answer `permission denied for table
 * <t>` (`42501`) to `shortkit_app` (ADR-0050), so a control written over the whole schema
 * asserts the opposite of the property on the day the role split lands. The set is every
 * ordinary or partitioned table this role can read, by the table-level privilege call
 * OR'd with the column-level one — `has_table_privilege` alone does not see a column-level
 * grant (measured, F-031/F-042), and a column-granted table dropping out of the set would
 * take the sixth-auth-table property with it: a table nobody revoked stays in the set,
 * carries no policy, returns rows to this SELECT, and the control fires.
 *
 * `has_any_column_privilege` accepts only the three column-grantable privileges and raises
 * `unrecognized privilege type: "DELETE"`. Do not widen the `'SELECT'` argument.
 *
 * A `pg.Client` rather than `test/support/psql.ts`: every `psql` call there is a process
 * spawn, so each statement lands on a NEW backend and the warm state cannot be built. One
 * client is one session for the whole file.
 */
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  TENANT_A,
  appDsn,
  assertAppRoleCannotBypassRls,
  createRlsFixture,
  dropRlsFixture,
  migrationDsn,
} from '../support/rls-fixture';
import { querySql } from '../support/psql';

/**
 * Every flag ADR-0049 declares, set transaction-locally and committed, which is what leaves
 * each placeholder at `''`. Test files are outside isolation-coverage.md's scan set by its
 * own exclusion table — the harness sets flags by design.
 */
const DECLARED_FLAGS: readonly [string, string][] = [
  ['app.tenant_id', TENANT_A],
  ['app.privileged_erase', TENANT_A],
  ['app.redirect_context', 'on'],
  ['app.membership_lookup_user', 'some-user-id'],
];

const READABLE_TABLES = `
  SELECT c.relname AS table_name
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND c.relkind IN ('r', 'p')
     AND (has_table_privilege(current_user, c.oid, 'SELECT')
          OR has_any_column_privilege(current_user, c.oid, 'SELECT'))
   ORDER BY c.relname`;

let connection: pg.Client;

/** What the no-context read answered: a row count, or the SQLSTATE it raised. */
type Outcome = { table: string; rows: number } | { table: string; raised: string };

async function readableTables(): Promise<string[]> {
  const result = await connection.query<{ table_name: string }>(READABLE_TABLES);

  return result.rows.map((row) => row.table_name);
}

async function warmTheBackend(): Promise<void> {
  await connection.query('BEGIN');

  for (const [flag, value] of DECLARED_FLAGS) {
    await connection.query('SELECT set_config($1, $2, true)', [flag, value]);
  }

  await connection.query('COMMIT');
}

async function countWithNoContext(table: string): Promise<Outcome> {
  try {
    const result = await connection.query<{ visible: string }>(
      `SELECT count(*)::int AS visible FROM "${table}"`,
    );

    return { table, rows: Number(result.rows[0]?.visible ?? -1) };
  } catch (error) {
    // A refusal is NOT a pass. Row-level security denies a read by returning zero rows and
    // never by raising (isolation-coverage.md, corrected statement 2), so a SQLSTATE here
    // is the defect rather than the denial.
    return { table, raised: (error as { code?: string }).code ?? String(error) };
  }
}

describe('a warm connection with no tenant context', () => {
  beforeAll(async () => {
    assertAppRoleCannotBypassRls();

    connection = new pg.Client({ connectionString: appDsn() });
    await connection.connect();
  });

  beforeEach(() => {
    // Seeds tenants A and B and two rows in the fixture table through the PRODUCTION
    // policies, so "zero rows" below means the policy hid rows that exist rather than that
    // the database is empty.
    createRlsFixture();
  });

  afterAll(async () => {
    dropRlsFixture();
    await connection.end();
  });

  it('the premise: the computed set is not empty and the rows it should hide exist', async () => {
    const tables = await readableTables();
    // IN TENANT A'S CONTEXT, and that is not incidental: `tenants` and the fixture table
    // both carry FORCE ROW LEVEL SECURITY, so the migrator sees zero rows out of context
    // too. Counting without a flag would report an empty database and fail this premise
    // against a correctly seeded one.
    const [seeded] = querySql<{ tenants: number; fixture_rows: number }>(
      migrationDsn(),
      `SELECT (SELECT count(*)::int FROM tenants) AS tenants,
              (SELECT count(*)::int FROM rls_fixture_rows) AS fixture_rows`,
      { tenantId: TENANT_A },
    );

    // Both halves are the premise, not the subject. An empty set, or a set of empty tables,
    // satisfies the control below while reading nothing.
    expect({
      tables: tables.length > 0,
      seededTenants: (seeded?.tenants ?? 0) > 0,
      seededRows: (seeded?.fixture_rows ?? 0) > 0,
    }).toEqual({ tables: true, seededTenants: true, seededRows: true });
  });

  it('ADR-0049: it returns zero rows from every table this role can read, and raises on none', async () => {
    const tables = await readableTables();

    await warmTheBackend();

    const outcomes: Outcome[] = [];

    for (const table of tables) {
      outcomes.push(await countWithNoContext(table));
    }

    // Hand-derived: the property is the same for every table in the set, so the expectation
    // is the set with `rows: 0` against each name. A table that raised carries `raised`
    // instead and the diff names it and its SQLSTATE.
    expect(outcomes).toEqual(tables.map((table) => ({ table, rows: 0 })));
  });

  it('ADR-0049: the same read on a cold backend already returns zero rows, so the state is what differs', async () => {
    // The control for the control. Cold is the state the fixture creates by accident and
    // the state the pre-ADR-0049 template passes in, so a run where BOTH fail is a broken
    // fixture rather than the defect this file exists for.
    const cold = new pg.Client({ connectionString: appDsn() });
    await cold.connect();

    try {
      const result = await cold.query<{ visible: string }>(
        'SELECT count(*)::int AS visible FROM rls_fixture_rows',
      );

      expect(Number(result.rows[0]?.visible)).toBe(0);
    } finally {
      await cold.end();
    }
  });
});
