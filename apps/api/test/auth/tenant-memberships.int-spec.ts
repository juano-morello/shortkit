/**
 * STORY-001: AC-2, AC-4. TASK-002.
 *
 * Contract: `docs/contracts/tenant-membership-lookup.md` ("The table", "The policies",
 * "Isolation controls this owes"). ADR-0015, ADR-0045, ADR-0049.
 *
 * ============================================================================
 * ALL FOUR LOOKUP ASSERTIONS RUN ON A WARM CONNECTION. THAT IS THE POINT (F-004).
 * ============================================================================
 *
 * The two controls this contract originally specified named no connection state, and both
 * are true on a cold backend, so both would have passed over F-003, the raise that only
 * appears once a backend has committed one transaction-local `set_config`. `rls-fixture.ts`
 * seeds through the migrator DSN and leaves the application pool cold, so cold is the state
 * a test falls into by accident.
 *
 * `POOL_MAX` is 10. Sequential use returns the same pooled connection (the property
 * `tenant-context.int-spec.ts:275` already rests on) so the warm mint below runs one
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
  assertLookupAdmitsOnly,
  countMembershipsWithNoLookupFlag,
  readMembershipsUnderLookupFlag,
  warmMembershipLookupFlags,
} from '../support/membership-lookup-probe';
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

/**
 * ============================================================================
 * F-133. THE SECOND MEMBERSHIP ROW, AND IT IS THE WHOLE OF CONTROL 2's SECOND CONJUNCT.
 * ============================================================================
 *
 * This user holds a membership IN TENANT B, and the row exists so that control 2 has a
 * row to exclude. Until 2026-08-14 the fixture seeded exactly one membership, so
 * "returns that user AND NO OTHER TENANT" had no other tenant's row in the table:
 * `USING (true)` on `tenant_memberships_membership_lookup` satisfied it, and so did the
 * sharper shape below. MEASURED on the migrated production table with the lookup policy
 * replaced by
 *
 *   USING (nullif(current_setting('app.membership_lookup_user', true), '') IS NOT NULL)
 *
 * (every membership row of every tenant, to anyone who sets the flag) this whole file
 * reported 6 passed, exit 0.
 *
 * ⚠ IT IS A DIFFERENT USER, NOT A SECOND ROW FOR THE SAME ONE. `UNIQUE (user_id)` is what
 * AC-2 is about and it permits exactly this: one row per user, any number of tenants.
 */
const USER_IN_ANOTHER_TENANT = 'tenantBUserId0001';

const MEMBERSHIP_ID = '44444444-4444-4444-8444-444444444444';
const MEMBERSHIP_ID_IN_ANOTHER_TENANT = '66666666-6666-4666-8666-666666666666';

const SEEDED_USER_IDS = [
  USER_WITH_A_MEMBERSHIP,
  USER_WITH_NO_MEMBERSHIP,
  USER_IN_ANOTHER_TENANT,
];

let migrator: pg.Client;
let runtime: pg.Client;

async function seedUsersAndTheirMemberships(): Promise<void> {
  await migrator.query(`DELETE FROM "user" WHERE id = ANY($1::text[])`, [SEEDED_USER_IDS]);

  for (const id of SEEDED_USER_IDS) {
    await migrator.query(
      `INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
       VALUES ($1, $2, $3, false, now(), now())`,
      [id, 'An Operator', `${id}@example.com`],
    );
  }

  // `tenant_memberships` is tenant-scoped and FORCE ROW LEVEL SECURITY applies to the
  // owning role too, so each insert runs inside the context its own WITH CHECK admits,
  // which is one context per tenant, and the reason these are two transactions.
  for (const [id, tenantId, userId] of [
    [MEMBERSHIP_ID, TENANT_A, USER_WITH_A_MEMBERSHIP],
    [MEMBERSHIP_ID_IN_ANOTHER_TENANT, TENANT_B, USER_IN_ANOTHER_TENANT],
  ]) {
    await migrator.query('BEGIN');
    await migrator.query('SELECT set_config($1, $2, true)', ['app.tenant_id', tenantId]);
    await migrator.query(
      `INSERT INTO tenant_memberships (id, tenant_id, user_id, role)
       VALUES ($1, $2, $3, 'owner')`,
      [id, tenantId, userId],
    );
    await migrator.query('COMMIT');
  }
}

/** The warm state every control below runs on, from the probe both suites share (F-133). */
async function warm(client: pg.Client): Promise<void> {
  await warmMembershipLookupFlags(client, {
    tenantId: TENANT_A,
    userId: USER_WITH_A_MEMBERSHIP,
  });
}

/**
 * Attempts a second membership row for `USER_WITH_A_MEMBERSHIP` inside `tenantId`'s
 * context. Returns the driver's error fields, empty when the insert was admitted, which
 * is itself a failure of AC-2 and shows up as `{ code: undefined }` against `23505`.
 *
 * ⚠ IT ENDS IN `COMMIT`, AND `ROLLBACK` WOULD MAKE AC-2's SECOND CONJUNCT VACUOUS (F-134).
 * "The table still holds exactly one row for that user" is a statement about the table
 * AFTER the attempt, and a rolled-back attempt leaves one row whatever the database did:
 * measured: with `tenant_memberships_user_unique` DROPPED, the insert was admitted and the
 * counts under a `ROLLBACK` still read 1 and 0. Committing lets the attempt leave behind
 * exactly what it earned: on a correct database the statement was refused, the transaction
 * is already aborted and PostgreSQL turns this `COMMIT` into a rollback; on a database
 * that admitted it, the row persists and the count assertion fires. `beforeEach` rebuilds
 * the fixture either way.
 */
async function attemptDuplicateMembership(
  tenantId: string,
  rowId: string,
): Promise<{ code?: string; constraint?: string }> {
  await migrator.query('BEGIN');
  await migrator.query('SELECT set_config($1, $2, true)', ['app.tenant_id', tenantId]);

  let refusal: { code?: string; constraint?: string } = {};

  try {
    await migrator.query(
      `INSERT INTO tenant_memberships (id, tenant_id, user_id, role)
       VALUES ($1, $2, $3, 'member')`,
      [rowId, tenantId, USER_WITH_A_MEMBERSHIP],
    );
  } catch (error) {
    refusal = error as { code?: string; constraint?: string };
  }

  await migrator.query('COMMIT');

  return refusal;
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
    await seedUsersAndTheirMemberships();
  });

  afterAll(async () => {
    dropRlsFixture();
    await migrator.end();
    await runtime.end();
    await closeDatabase();
  });

  it('AC-2: a second membership for that user under ANOTHER tenant is refused, and the table still holds exactly one row for them', async () => {
    // ⚠ ONE TEST, TWO CONJUNCTS, AND THAT IS F-134. AC-2 is one sentence ("Postgres
    // rejects the statement ... AND the table still holds exactly one row for that user"),
    // and it was discharged by two independent `it`s with a `beforeEach` re-seed between
    // them, so the count never observed the post-rejection table and passed identically
    // with the refusal test deleted. The count below runs in the same test, after the
    // attempt has been committed for whatever it earned; see `attemptDuplicateMembership`.
    //
    // Under tenant B: "inserted under any tenant". `UNIQUE (user_id)` carries no tenant
    // column, which is what makes one-tenant-per-user structural rather than a rule the
    // signup path is trusted to follow (ADR-0015).
    const refusal = await attemptDuplicateMembership(
      TENANT_B,
      '55555555-5555-4555-8555-555555555555',
    );

    expect({
      code: refusal.code,
      constraint: refusal.constraint,
      underTenantA: await countMembershipsFor(USER_WITH_A_MEMBERSHIP, TENANT_A),
      underTenantB: await countMembershipsFor(USER_WITH_A_MEMBERSHIP, TENANT_B),
    }).toEqual({
      code: '23505',
      constraint: 'tenant_memberships_user_unique',
      underTenantA: 1,
      underTenantB: 0,
    });
  });

  it('AC-2: a second membership for that user under ITS OWN tenant is refused by the same constraint, and the table still holds exactly one row for them', async () => {
    // F-134. THE SHAPE A BUGGY SIGNUP RETRY PRODUCES, and it was attempted nowhere: the
    // same user, the same tenant, a second row. AC-2 says "under any tenant" and the
    // cross-tenant case above is the only one that had a test.
    //
    // It is also the case where nothing but the constraint can be doing the refusing: the
    // insert runs inside tenant A's context, so the isolation policy's WITH CHECK admits
    // the row and a 23505 cannot be a row-level-security refusal wearing another number.
    const refusal = await attemptDuplicateMembership(
      TENANT_A,
      '77777777-7777-4777-8777-777777777777',
    );

    expect({
      code: refusal.code,
      constraint: refusal.constraint,
      underTenantA: await countMembershipsFor(USER_WITH_A_MEMBERSHIP, TENANT_A),
      underTenantB: await countMembershipsFor(USER_WITH_A_MEMBERSHIP, TENANT_B),
    }).toEqual({
      code: '23505',
      constraint: 'tenant_memberships_user_unique',
      underTenantA: 1,
      underTenantB: 0,
    });
  });

  it('the fixture seeds exactly one membership for that user, under its own tenant and no other', async () => {
    // THE PREMISE THE TWO TESTS ABOVE REST ON, and deliberately no longer carrying an
    // "AC-2:" prefix (F-134, and the hazard F-132 names): it observes the seeded table and
    // not a rejected insert, so a Ship-phase reader counting AC evidence by test title
    // does not count it twice. If this is red, "still holds exactly one row" above is a
    // statement about a fixture that was already wrong.
    expect({
      underTenantA: await countMembershipsFor(USER_WITH_A_MEMBERSHIP, TENANT_A),
      underTenantB: await countMembershipsFor(USER_WITH_A_MEMBERSHIP, TENANT_B),
      otherTenantsUserUnderTenantB: await countMembershipsFor(
        USER_IN_ANOTHER_TENANT,
        TENANT_B,
      ),
    }).toEqual({ underTenantA: 1, underTenantB: 0, otherTenantsUserUnderTenantB: 1 });
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
    // FAIL: an orphaned `user` row (the accepted residue of a non-atomic signup (GC-E))
    // never receives a JWT, and `AuthGuard`'s claim-shape check is only the backstop.
    expect(outcome).toEqual({
      rejectedWith: 'NoTenantMembershipError',
      userId: USER_WITH_NO_MEMBERSHIP,
    });
  });

  it('tenant-membership-lookup.md control 2: with the lookup flag set, a warm read returns that user and no other tenant', async () => {
    // ⚠ THE TABLE NOW HOLDS TWO MEMBERSHIP ROWS AND THAT IS WHAT MAKES THE SECOND CONJUNCT
    // A STATEMENT (F-133). `USER_IN_ANOTHER_TENANT` holds a row in tenant B, so "and not
    // tenant B's" has a row to exclude; with the single-membership fixture this assertion
    // was satisfied by `USING (true)`.
    //
    // The read and the expectation both come from `membership-lookup-probe.ts`, and the
    // F-133 control in `test/isolation/cross-tenant-isolation.int-spec.ts` runs THOSE SAME
    // FUNCTIONS over canary tables carrying a widened lookup policy, where the expectation
    // below is required to throw. That is what makes this a control rather than a claim.
    await warm(runtime);

    const admitted = await readMembershipsUnderLookupFlag(runtime, {
      table: 'tenant_memberships',
      userId: USER_WITH_A_MEMBERSHIP,
    });

    assertLookupAdmitsOnly(admitted, {
      user_id: USER_WITH_A_MEMBERSHIP,
      tenant_id: TENANT_A,
    });
  });

  it('tenant-membership-lookup.md control 3: with no flag set, a warm read returns zero rows rather than raising', async () => {
    // TWO rows in the table now, so a policy that admits without reading the flag reports 2
    // here rather than 1. What this control still cannot see is a policy that IS gated on
    // the flag and does not compare it to `user_id` (with no flag set it correctly admits
    // nothing), which is control 2's job and the division of labour the F-133 control
    // measures on both shapes.
    await warm(runtime);

    expect(await countMembershipsWithNoLookupFlag(runtime, 'tenant_memberships')).toEqual({
      rows: 0,
    });
  });
});
