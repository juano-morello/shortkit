/**
 * STORY-001 — AC-2, AC-4. TASK-002.
 *
 * Contract: `design/contracts/tenant-membership-lookup.md` ("The table", "The policies",
 * "Isolation controls this owes"). ADR-0015, ADR-0045, ADR-0049.
 *
 * ============================================================================
 * ALL FOUR LOOKUP ASSERTIONS RUN ON A WARM CONNECTION. THAT IS THE POINT (F-004).
 * ============================================================================
 *
 * The two controls this contract originally specified named no connection state, and both
 * are true on a cold backend — so both would have passed over F-003, the raise that only
 * appears once a backend has committed one transaction-local `set_config`. `rls-fixture.ts`
 * seeds through the migrator DSN and leaves the application pool cold, so cold is the state
 * a test falls into by accident.
 *
 * `POOL_MAX` is 10. Sequential use returns the same pooled connection — the property
 * `tenant-context.int-spec.ts:275` already rests on — so the warm mint below runs one
 * `withTenantTransaction` and then the lookup, with nothing concurrent between them.
 *
 * A REFUSAL IS NOT A PASS. Row-level security denies a read by returning zero rows and
 * never by raising (isolation-coverage.md, corrected statement 2), so a `22P02` in any of
 * these is F-003 rather than a denial, and a test that throws proves nothing.
 */
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { closeDatabase } from '../../src/db/client';
import { withTenantTransaction } from '../../src/tenancy/tenant-context';
import { NoTenantMembershipError, tenantIdForUser } from '../../src/auth/tenant-id-for-user';
import {
  TENANT_A,
  TENANT_B,
  appDsn,
  assertAppRoleCannotBypassRls,
  createRlsFixture,
  dropRlsFixture,
  migrationDsn,
} from '../support/rls-fixture';

/** Better Auth generates its own ids and they are not uuids (auth-schema.md). */
const USER_WITH_A_MEMBERSHIP = 'nZ8kQpR2xLmT4vB6';
const USER_WITH_NO_MEMBERSHIP = 'orphanUserId0001';

const MEMBERSHIP_ID = '44444444-4444-4444-8444-444444444444';

let migrator: pg.Client;
let runtime: pg.Client;

async function seedUsersAndOneMembership(): Promise<void> {
  await migrator.query(`DELETE FROM "user" WHERE id = ANY($1::text[])`, [
    [USER_WITH_A_MEMBERSHIP, USER_WITH_NO_MEMBERSHIP],
  ]);

  for (const id of [USER_WITH_A_MEMBERSHIP, USER_WITH_NO_MEMBERSHIP]) {
    await migrator.query(
      `INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
       VALUES ($1, $2, $3, false, now(), now())`,
      [id, 'An Operator', `${id}@example.com`],
    );
  }

  // `tenant_memberships` is tenant-scoped and FORCE ROW LEVEL SECURITY applies to the
  // owning role too, so the insert runs inside the context its own WITH CHECK admits.
  await migrator.query('BEGIN');
  await migrator.query('SELECT set_config($1, $2, true)', ['app.tenant_id', TENANT_A]);
  await migrator.query(
    `INSERT INTO tenant_memberships (id, tenant_id, user_id, role)
     VALUES ($1, $2, $3, 'owner')`,
    [MEMBERSHIP_ID, TENANT_A, USER_WITH_A_MEMBERSHIP],
  );
  await migrator.query('COMMIT');
}

/**
 * Leaves every declared flag at its reset value, `''`, on this connection — the state
 * `pg.Pool` hands to the next checkout and the one ADR-0049 exists for.
 */
async function warm(client: pg.Client): Promise<void> {
  await client.query('BEGIN');

  for (const [flag, value] of [
    ['app.tenant_id', TENANT_A],
    ['app.membership_lookup_user', USER_WITH_A_MEMBERSHIP],
  ]) {
    await client.query('SELECT set_config($1, $2, true)', [flag, value]);
  }

  await client.query('COMMIT');
}

async function countMembershipsFor(userId: string, tenantId: string): Promise<number> {
  await migrator.query('BEGIN');
  await migrator.query('SELECT set_config($1, $2, true)', ['app.tenant_id', tenantId]);

  const result = await migrator.query<{ held: string }>(
    'SELECT count(*)::int AS held FROM tenant_memberships WHERE user_id = $1',
    [userId],
  );

  await migrator.query('COMMIT');

  return Number(result.rows[0]?.held ?? -1);
}

describe('tenant_memberships', () => {
  beforeAll(async () => {
    assertAppRoleCannotBypassRls();

    migrator = new pg.Client({ connectionString: migrationDsn() });
    runtime = new pg.Client({ connectionString: appDsn() });

    await migrator.connect();
    await runtime.connect();
  });

  beforeEach(async () => {
    createRlsFixture();
    await seedUsersAndOneMembership();
  });

  afterAll(async () => {
    dropRlsFixture();
    await migrator.end();
    await runtime.end();
    await closeDatabase();
  });

  it('AC-2: a second membership for the same user is refused by tenant_memberships_user_unique', async () => {
    await migrator.query('BEGIN');
    await migrator.query('SELECT set_config($1, $2, true)', ['app.tenant_id', TENANT_B]);

    let refusal: { code?: string; constraint?: string } = {};

    try {
      // Under tenant B — "inserted under any tenant". `UNIQUE (user_id)` carries no tenant
      // column, which is what makes one-tenant-per-user structural rather than a rule the
      // signup path is trusted to follow (ADR-0015).
      await migrator.query(
        `INSERT INTO tenant_memberships (id, tenant_id, user_id, role)
         VALUES ('55555555-5555-4555-8555-555555555555', $1, $2, 'member')`,
        [TENANT_B, USER_WITH_A_MEMBERSHIP],
      );
    } catch (error) {
      refusal = error as { code?: string; constraint?: string };
    }

    await migrator.query('ROLLBACK');

    expect({ code: refusal.code, constraint: refusal.constraint }).toEqual({
      code: '23505',
      constraint: 'tenant_memberships_user_unique',
    });
  });

  it('AC-2: the table still holds exactly one row for that user, under its own tenant and no other', async () => {
    expect({
      underTenantA: await countMembershipsFor(USER_WITH_A_MEMBERSHIP, TENANT_A),
      underTenantB: await countMembershipsFor(USER_WITH_A_MEMBERSHIP, TENANT_B),
    }).toEqual({ underTenantA: 1, underTenantB: 0 });
  });

  it("AC-4: tenantIdForUser resolves to that user's tenant id on a warm pooled connection", async () => {
    // One committed tenant transaction on the application pool, which is what leaves
    // `app.tenant_id` at `''` for the lookup that follows. This is the assertion that
    // fails without ADR-0049's `nullif`.
    await withTenantTransaction(TENANT_A, async (db) => {
      await db.execute(sql`select 1 as warmed`);
    });

    expect(await tenantIdForUser(USER_WITH_A_MEMBERSHIP)).toBe(TENANT_A);
  });

  it('AC-4: a user with no membership row is rejected with NoTenantMembershipError, never a null or empty tid', async () => {
    await withTenantTransaction(TENANT_A, async (db) => {
      await db.execute(sql`select 1 as warmed`);
    });

    const outcome = await tenantIdForUser(USER_WITH_NO_MEMBERSHIP).then(
      (resolved) => ({ resolved }),
      (error: unknown) => ({
        rejectedWith: error instanceof NoTenantMembershipError ? error.name : String(error),
        userId: (error as NoTenantMembershipError).userId,
      }),
    );

    // A resolved `null` or `''` would read as `{ resolved: null }` here. Token minting must
    // FAIL: an orphaned `user` row — the accepted residue of a non-atomic signup (GC-E) —
    // never receives a JWT, and `AuthGuard`'s claim-shape check is only the backstop.
    expect(outcome).toEqual({
      rejectedWith: 'NoTenantMembershipError',
      userId: USER_WITH_NO_MEMBERSHIP,
    });
  });

  it('tenant-membership-lookup.md control 2: with the lookup flag set, a warm read returns that user and no other tenant', async () => {
    await warm(runtime);
    await runtime.query('BEGIN');
    await runtime.query('SELECT set_config($1, $2, true)', [
      'app.membership_lookup_user',
      USER_WITH_A_MEMBERSHIP,
    ]);

    const result = await runtime.query<{ user_id: string; tenant_id: string }>(
      'SELECT user_id, tenant_id FROM tenant_memberships',
    );

    await runtime.query('COMMIT');

    expect(result.rows).toEqual([
      { user_id: USER_WITH_A_MEMBERSHIP, tenant_id: TENANT_A },
    ]);
  });

  it('tenant-membership-lookup.md control 3: with no flag set, a warm read returns zero rows rather than raising', async () => {
    await warm(runtime);

    const outcome = await runtime
      .query<{ visible: string }>('SELECT count(*)::int AS visible FROM tenant_memberships')
      .then(
        (result) => ({ rows: Number(result.rows[0]?.visible) }),
        (error: unknown) => ({ raised: (error as { code?: string }).code ?? String(error) }),
      );

    expect(outcome).toEqual({ rows: 0 });
  });
});
