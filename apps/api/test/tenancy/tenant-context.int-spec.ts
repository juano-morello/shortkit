/**
 * STORY-003 — AC-8, AC-9, AC-10, AC-11.
 *
 * Integration only, by ADR-0001 and test-strategy.md: row-level security cannot be
 * faked in a mock. A mocked repository proves the mock honours tenancy, not that
 * Postgres does. Every assertion here runs against a live Postgres 17, as the
 * `shortkit_app` role, which holds neither `SUPERUSER` nor `BYPASSRLS` — the
 * fixture refuses to run otherwise, because an exempt role makes all of it vacuous.
 *
 * Nothing here reaches for `tenantStorage`, the pool, or any other internal: the
 * subject is the contract in design/contracts/tenant-context.md plus the policy
 * template in design/contracts/rls-policy-template.md.
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { TenantDb } from '../../src/tenancy/tenant-context';
import { withTenantTransaction } from '../../src/tenancy/tenant-context';
import {
  appDsn,
  assertAppRoleCannotBypassRls,
  createRlsFixture,
  dropRlsFixture,
  migrationDsn,
  RLS_FIXTURE_TABLE,
  TENANT_A,
  TENANT_A_LABEL,
  TENANT_B,
  TENANT_B_LABEL,
} from '../support/rls-fixture';
import { querySql } from '../support/psql';

interface FixtureRow extends Record<string, unknown> {
  tenant_id: string;
  label: string;
}

/** Postgres `insufficient_privilege`, raised when a row fails a policy's WITH CHECK. */
const RLS_VIOLATION = '42501';

const FORGED_ROW_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const ROLLED_BACK_ROW_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

const table = sql.identifier(RLS_FIXTURE_TABLE);

/**
 * Deliberately unfiltered. The isolation under test is the database's, so a
 * `where tenant_id = ...` here would assert the query rather than the policy.
 */
async function visibleRows(db: TenantDb): Promise<FixtureRow[]> {
  const result = await db.execute<FixtureRow>(
    sql`select tenant_id, label from ${table} order by label`,
  );

  return result.rows;
}

async function rejectionOf(work: Promise<unknown>): Promise<{ code?: string; message: string }> {
  try {
    await work;
  } catch (error) {
    const failure = error as { code?: string; message?: string };
    return { code: failure.code, message: failure.message ?? String(error) };
  }

  throw new Error('expected the call to reject, but it resolved');
}

describe('tenant-scoped persistence', () => {
  beforeAll(() => {
    assertAppRoleCannotBypassRls();
  });

  beforeEach(() => {
    createRlsFixture();
  });

  afterAll(() => {
    dropRlsFixture();
  });

  it("AC-8: a read inside tenant A's transaction returns A's row and not B's", async () => {
    const rows = await withTenantTransaction(TENANT_A, (db) => visibleRows(db));

    expect(rows).toEqual([{ tenant_id: TENANT_A, label: TENANT_A_LABEL }]);
  });

  it("AC-9: an insert carrying tenant B's tenant_id is refused inside tenant A's transaction", async () => {
    const failure = await rejectionOf(
      withTenantTransaction(TENANT_A, async (db) => {
        await db.execute(
          sql`insert into ${table} (id, tenant_id, label)
              values (${FORGED_ROW_ID}::uuid, ${TENANT_B}::uuid, ${'planted-by-tenant-a'})`,
        );
      }),
    );

    expect(failure.code).toBe(RLS_VIOLATION);

    const rowsOfB = await withTenantTransaction(TENANT_B, (db) => visibleRows(db));
    expect(rowsOfB).toEqual([{ tenant_id: TENANT_B, label: TENANT_B_LABEL }]);
  });

  it("AC-9: an update of tenant B's row affects zero rows inside tenant A's transaction", async () => {
    const affected = await withTenantTransaction(TENANT_A, async (db) => {
      const result = await db.execute(
        sql`update ${table} set label = ${'taken-over-by-tenant-a'} where tenant_id = ${TENANT_B}::uuid`,
      );

      return result.rowCount as number;
    });

    expect(affected).toBe(0);

    const rowsOfB = await withTenantTransaction(TENANT_B, (db) => visibleRows(db));
    expect(rowsOfB).toEqual([{ tenant_id: TENANT_B, label: TENANT_B_LABEL }]);
  });

  it('AC-10: a read issued outside any tenant-context transaction returns zero rows', () => {
    // The table is seeded, so zero rows below is the policy denying, not an empty
    // table. Read through the owner with a context set, since FORCE ROW LEVEL
    // SECURITY subjects the owner to the policy too.
    const seeded = querySql<{ label: string }>(
      migrationDsn(),
      `select label from ${RLS_FIXTURE_TABLE}`,
      { tenantId: TENANT_A },
    );
    expect(seeded).toEqual([{ label: TENANT_A_LABEL }]);

    const withoutContext = querySql<FixtureRow>(
      appDsn(),
      `select tenant_id, label from ${RLS_FIXTURE_TABLE}`,
    );

    expect(withoutContext).toEqual([]);
  });

  it('AC-11: a throw inside the wrapped function rolls the transaction back', async () => {
    const boom = new Error('deliberate failure inside the tenant transaction');

    const failure = await rejectionOf(
      withTenantTransaction(TENANT_A, async (db) => {
        await db.execute(
          sql`insert into ${table} (id, tenant_id, label)
              values (${ROLLED_BACK_ROW_ID}::uuid, ${TENANT_A}::uuid, ${'written-then-rolled-back'})`,
        );

        throw boom;
      }),
    );
    expect(failure.message).toBe(boom.message);

    const rowsOfA = await withTenantTransaction(TENANT_A, (db) => visibleRows(db));
    expect(rowsOfA).toEqual([{ tenant_id: TENANT_A, label: TENANT_A_LABEL }]);
  });

  it('AC-11: tenant context does not leak to the next transaction after a throw', async () => {
    const boom = new Error('deliberate failure inside the tenant transaction');

    await rejectionOf(
      withTenantTransaction(TENANT_A, async () => {
        throw boom;
      }),
    );

    // Sequential use returns the same pooled connection, so this is the read that
    // catches a session-level `SET`, or an AsyncLocalStorage store left un-exited
    // by the failed transaction.
    const rowsOfB = await withTenantTransaction(TENANT_B, (db) => visibleRows(db));

    expect(rowsOfB).toEqual([{ tenant_id: TENANT_B, label: TENANT_B_LABEL }]);
  });
});
