/**
 * THE TOKEN-MINT ESCAPE'S READ, AS ONE MECHANISM: used by the control that asserts the
 * real policy and by the negative control that proves the assertion discriminates.
 *
 * Contract: `docs/contracts/tenant-membership-lookup.md` ("Isolation controls this
 * owes", controls 2 and 3). ADR-0045, ADR-0049.
 *
 * ⚠ WHY THIS IS SHARED CODE AND NOT TWO COPIES (F-133). Control 2 in
 * `test/auth/tenant-memberships.int-spec.ts` is the only assertion in the system that
 * reads a tenant-scoped table with NO tenant context, and until this file existed nothing
 * proved it could fail: the isolation harness never sets `app.membership_lookup_user`
 * (`test/isolation/registrations.ts`, the `tenant_memberships` registration), and
 * `db:check-policies` counts `nullif` wrappers and cannot see WHICH COLUMN a predicate
 * compares against. MEASURED on 2026-08-14, on the migrated production table, with
 * `tenant_memberships_membership_lookup` replaced by
 *
 *   USING (nullif(current_setting('app.membership_lookup_user', true), '') IS NOT NULL)
 *
 * (a policy that hands every membership row of every tenant to anyone who sets the flag)
 * `test/auth/tenant-memberships.int-spec.ts` reported **6 passed, exit 0**.
 *
 * So the read and the expectation both live here, and
 * `cross-tenant-isolation.int-spec.ts`'s F-133 control runs THESE FUNCTIONS over canary
 * tables carrying that exact defect. A copy in each suite would prove that Postgres
 * behaves as Postgres does; one mechanism run over both a correct policy and a widened
 * one proves the control the product relies on can go red.
 *
 * `apps/api/test/support/**` is in no TASK's paths and belongs to sdlc-test-architect
 * under routing rule 0 (F-077, F-100), which is why this file is here rather than beside
 * either suite.
 */
import type pg from 'pg';
import { expect } from 'vitest';

/** The two columns every control here projects: who the row belongs to, and to which tenant. */
export interface MembershipLookupRow {
  readonly user_id: string;
  readonly tenant_id: string;
}

export interface LookupProbe {
  /** `tenant_memberships`, or one of the F-133 canaries shaped like it. */
  readonly table: string;
  readonly userId: string;
}

/**
 * The table name is substituted into SQL rather than bound (no parameter can carry an
 * identifier) so it is checked against the same shape `src/db/rls.ts` accepts. Every
 * caller passes a literal from this repository, so this only ever fires on a typo.
 */
const SAFE_TABLE_NAME = /^[a-z_][a-z0-9_]*$/;

function assertTableName(table: string): string {
  if (!SAFE_TABLE_NAME.test(table)) {
    throw new Error(`Not a usable table name for a membership lookup probe: ${JSON.stringify(table)}`);
  }

  return table;
}

/**
 * Leaves every declared flag at its reset value, `''`, on this connection: the state
 * `pg.Pool` hands to the next checkout and the one ADR-0049 exists for (F-003, F-004).
 *
 * Both controls below run on a connection warmed this way and that is the point: the two
 * controls the contract originally specified named no connection state, and both are true
 * on a COLD backend, so both would have passed over F-003. `rls-fixture.ts` seeds through
 * the migrator DSN and leaves the application pool cold, so cold is the state a test falls
 * into by accident.
 */
export async function warmMembershipLookupFlags(
  client: pg.Client,
  context: { readonly tenantId: string; readonly userId: string },
): Promise<void> {
  await client.query('BEGIN');

  for (const [flag, value] of [
    ['app.tenant_id', context.tenantId],
    ['app.membership_lookup_user', context.userId],
  ]) {
    await client.query('SELECT set_config($1, $2, true)', [flag, value]);
  }

  await client.query('COMMIT');
}

/**
 * Control 2's statement: with `app.membership_lookup_user` set and NO tenant context, read
 * the whole table.
 *
 * `ORDER BY user_id` so that a read admitting more than one row has a stable shape to
 * assert against; the ordering is not part of what the policy decides.
 *
 * The `finally` issues `COMMIT`, which PostgreSQL turns into a rollback if the SELECT
 * aborted the transaction, so a raise (a `22P02` here is F-003 and not a denial) reaches
 * the caller as its own error instead of as a `25P02` on the next statement.
 */
export async function readMembershipsUnderLookupFlag(
  client: pg.Client,
  probe: LookupProbe,
): Promise<MembershipLookupRow[]> {
  const table = assertTableName(probe.table);

  await client.query('BEGIN');

  try {
    await client.query('SELECT set_config($1, $2, true)', [
      'app.membership_lookup_user',
      probe.userId,
    ]);

    const result = await client.query<MembershipLookupRow>(
      `SELECT user_id, tenant_id FROM ${table} ORDER BY user_id`,
    );

    return result.rows;
  } finally {
    await client.query('COMMIT');
  }
}

/**
 * Control 3's statement: the same read with NO flag set at all. Row-level security denies
 * a read by returning zero rows and never by raising (isolation-coverage.md, corrected
 * statement 2), so a raise is reported rather than thrown: `{ raised }` is a defect and
 * `{ rows: 0 }` is the denial.
 */
export async function countMembershipsWithNoLookupFlag(
  client: pg.Client,
  table: string,
): Promise<{ rows: number } | { raised: string }> {
  const relation = assertTableName(table);

  return client
    .query<{ visible: number }>(`SELECT count(*)::int AS visible FROM ${relation}`)
    .then(
      (result) => ({ rows: Number(result.rows[0]?.visible) }),
      (error: unknown) => ({ raised: (error as { code?: string }).code ?? String(error) }),
    );
}

/**
 * THE EXPECTATION CONTROL 2 IS, and the reason it is a function: the F-133 control in
 * `test/isolation/cross-tenant-isolation.int-spec.ts` calls it over a canary carrying a
 * widened lookup policy and asserts THIS THROWS, and over a canary carrying the production
 * predicate and asserts it does not. An expectation that cannot be shown to fail is not a
 * control.
 *
 * Both conjuncts of the contract's control 2 ("returns exactly A's row AND NOT tenant
 * B's") are one `toEqual` over the whole result set, so a policy admitting an extra row
 * fails it. Which is only true of a table that HOLDS an extra row: the fixture seeding one
 * membership was the other half of F-133.
 */
export function assertLookupAdmitsOnly(
  rows: readonly MembershipLookupRow[],
  expected: MembershipLookupRow,
): void {
  expect(rows).toEqual([expected]);
}
