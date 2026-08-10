/**
 * WHAT THE ISOLATION SUITE COVERS. Produced by: TASK-006.
 *
 * Every tenant-scoped subject in the system registers here, and the registry is the
 * enumeration — no hand-maintained list of assertions, no `it()` per table.
 *
 * ⚠ THIS FILE IS THE ONE A LATER SCHEMA TASK EDITS. Adding `links` means one
 * `registerTenantScopedSurfaces()` call naming the table, its owner column and the
 * repository methods to attempt. Nothing in `coverage.ts` changes, and the new table's
 * five attempts appear in `report.json` on the next run.
 *
 * ---------------------------------------------------------------------------
 * WHY THE SUBJECTS BELOW ARE ACCESS OBJECTS AND NOT REPOSITORIES
 * ---------------------------------------------------------------------------
 *
 * `repo:TenantsTableAccess.findAll` names a class that exists, in this file, with that
 * method on it. There is no `TenantRepository` to name instead: no repository class
 * exists anywhere in `apps/api/src` yet, and `@TenantScopedRepository()` still throws
 * `not implemented` (TASK-011). Naming one would put a surface id in `report.json` that
 * points at nothing, and `ISOLATION_EXCLUSIONS` is keyed on exactly these strings.
 *
 * The access objects are thin on purpose. Each method issues ONE statement through
 * `withTenantTransaction` — the same production path a repository will use, against the
 * same policies — so what an attempt exercises is Postgres's row-level security, not
 * this file. When `LinkRepository` arrives it registers its own methods and the harness
 * does not notice the difference.
 */
import { sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';

import { withTenantTransaction } from '../../src/tenancy/tenant-context';
import {
  createRlsFixture,
  RLS_FIXTURE_TABLE,
  TENANT_C_NEVER_SEEDED,
} from '../support/rls-fixture';

import type {
  CrossTenantAttemptResult,
  TenantFixture,
  TenantScopedMethod,
  TenantScopedSurfaceRegistration,
} from './coverage';
import { registerTenantScopedSurfaces } from './coverage';
import {
  BASELINE_LEAK_CANARY_TABLE,
  createBaselineLeakCanary,
  createDirectionCanary,
  createGrantGapCanary,
  createHalfSeededCanary,
  createMaskedRefusalCanary,
  DIRECTION_CANARY_TABLE,
  GRANT_GAP_CANARY_TABLE,
  HALF_SEEDED_CANARY_TABLE,
  MASKED_REFUSAL_CANARY_TABLE,
} from './controls';
import { createLeakCanary, LEAK_CANARY_TABLE } from './leak-canary';

/**
 * The five statement shapes every tenant-scoped table is attacked with. They are the
 * rows of isolation-coverage.md's "Attempt semantics" table, made concrete:
 *
 *   findAll          unfiltered read           -> must return none of the target's rows
 *   findOwnedBy      read filtered to target   -> must return zero rows
 *   updateOwnedBy    write over target's rows  -> rejected, or zero rows affected
 *   deleteOwnedBy    write over target's rows  -> rejected, or zero rows affected
 *   insertOwnedBy    write planting a new row  -> rejected, or zero rows affected
 *
 * `findAll` is deliberately unfiltered: a `where owner = actor` here would assert the
 * WHERE clause rather than the policy, which is the mistake `tenant-context.int-spec.ts`
 * calls out in its own `visibleRows` helper.
 *
 * ---------------------------------------------------------------------------
 * WHAT A REGISTRATION OWES THE HARNESS SINCE r2 — READ THIS BEFORE ADDING ONE
 * ---------------------------------------------------------------------------
 *
 * 1. `reset()` MUST SEED A ROW FOR BOTH TENANTS. Four of the five shapes above return
 *    zero rows when the target owns none, whatever the policy says, and the harness now
 *    refuses to score them: the surface comes back `unverified` and the run fails
 *    (F-295). A registration that seeds only one tenant used to report four green
 *    surfaces over a table that could have had no row-level security at all.
 *
 * 2. EVERY METHOD DECLARES `reaches`. `'existing-row'` for a statement that must find
 *    something already there, `'new-row'` for one that plants it. It is what tells the
 *    harness which attempts need the target to own a row.
 *
 * 3. EVERY METHOD IS ATTEMPTED IN BOTH DIRECTIONS. `attempt(actor, target)` is called
 *    once as (A, B) and once as (B, A), so a statement built for one hard-coded tenant
 *    is a defect the harness will report rather than one it will hide (F-293). Use the
 *    `actor` and `target` arguments; do not close over `TENANT_A`.
 */
interface TableAccessSpec {
  readonly table: string;
  readonly ownerColumn: string;
  /** Columns to project on a read. MUST include the owner column, or the harness refuses to judge. */
  readonly projection: string[];
  /** A non-owner column the update attempt tries to overwrite. */
  readonly mutableColumn: string;
  /**
   * The owner id the insert attempt writes, and the row it writes. For a `tenant_id`
   * table this is the target tenant itself. For `tenants`, whose row identity IS its
   * owner, the target's row already exists and an insert carrying its id would fail on
   * the primary key BEFORE any policy was evaluated — a 23505 that reads exactly like
   * the 42501 the policy owes us. So it plants a tenant that has never been seeded.
   */
  readonly plantedOwnerId: (target: TenantFixture) => string;
  readonly plantedRow: (ownerId: string) => SQL;
}

function reads(statement: SQL) {
  return async (actor: TenantFixture): Promise<CrossTenantAttemptResult> =>
    withTenantTransaction(actor.id, async (db) => ({
      rows: (await db.execute<Record<string, unknown>>(statement)).rows,
    }));
}

function writes(statement: SQL) {
  return async (actor: TenantFixture): Promise<CrossTenantAttemptResult> =>
    withTenantTransaction(actor.id, async (db) => ({
      rowsAffected: (await db.execute(statement)).rowCount ?? 0,
    }));
}

function tableAccess(spec: TableAccessSpec): TenantScopedMethod[] {
  const table = sql.identifier(spec.table);
  const owner = sql.identifier(spec.ownerColumn);
  const projection = sql.join(
    spec.projection.map((column) => sql.identifier(column)),
    sql`, `,
  );

  return [
    {
      name: 'findAll',
      kind: 'read',
      reaches: 'existing-row',
      attempt: (actor) => reads(sql`select ${projection} from ${table} order by id`)(actor),
    },
    {
      name: 'findOwnedBy',
      kind: 'read',
      reaches: 'existing-row',
      attempt: (actor, target) =>
        reads(sql`select ${projection} from ${table} where ${owner} = ${target.id}::uuid`)(actor),
    },
    {
      name: 'updateOwnedBy',
      kind: 'write',
      reaches: 'existing-row',
      attempt: (actor, target) =>
        writes(
          sql`update ${table}
                 set ${sql.identifier(spec.mutableColumn)} = ${'overwritten-by-another-tenant'}
               where ${owner} = ${target.id}::uuid`,
        )(actor),
    },
    {
      name: 'deleteOwnedBy',
      kind: 'write',
      reaches: 'existing-row',
      attempt: (actor, target) =>
        writes(sql`delete from ${table} where ${owner} = ${target.id}::uuid`)(actor),
    },
    {
      name: 'insertOwnedBy',
      kind: 'write',
      reaches: 'new-row',
      attempt: (actor, target) => writes(spec.plantedRow(spec.plantedOwnerId(target)))(actor),
    },
  ];
}

const PLANTED_FIXTURE_ROW_ID = 'f1f1f1f1-f1f1-4f1f-8f1f-f1f1f1f1f1f1';

/**
 * The cascade root. `id` is its own owner column, and its four policies are the bespoke
 * set `apps/api/drizzle/0000_*.sql` hand-appends — not `tenantScopedPolicies()`. It has
 * no ordinary DELETE policy at all (F-005), which is what `deleteOwnedBy` exercises.
 */
const tenantsAccess: TenantScopedSurfaceRegistration = {
  subject: 'TenantsTableAccess',
  table: 'tenants',
  ownerColumn: 'id',
  reset: createRlsFixture,
  methods: tableAccess({
    table: 'tenants',
    ownerColumn: 'id',
    projection: ['id', 'name'],
    mutableColumn: 'name',
    plantedOwnerId: () => TENANT_C_NEVER_SEEDED,
    plantedRow: (ownerId) =>
      sql`insert into ${sql.identifier('tenants')} (id, name)
          values (${ownerId}::uuid, ${'planted-by-another-tenant'})`,
  }),
};

/**
 * The template-shaped table. Its policies come from `tenantScopedPolicies()` in
 * `src/db/rls.ts`, so an attempt here exercises the production builder every later
 * schema TASK will apply.
 */
const rlsFixtureRowsAccess: TenantScopedSurfaceRegistration = {
  subject: 'RlsFixtureRowsTableAccess',
  table: RLS_FIXTURE_TABLE,
  ownerColumn: 'tenant_id',
  reset: createRlsFixture,
  methods: tableAccess({
    table: RLS_FIXTURE_TABLE,
    ownerColumn: 'tenant_id',
    projection: ['id', 'tenant_id', 'label'],
    mutableColumn: 'label',
    plantedOwnerId: (target) => target.id,
    plantedRow: (ownerId) =>
      sql`insert into ${sql.identifier(RLS_FIXTURE_TABLE)} (id, tenant_id, label)
          values (${PLANTED_FIXTURE_ROW_ID}::uuid, ${ownerId}::uuid, ${'planted-by-another-tenant'})`,
  }),
};

registerTenantScopedSurfaces(tenantsAccess);
registerTenantScopedSurfaces(rlsFixtureRowsAccess);

const PLANTED_CANARY_ROW_ID = 'f2f2f2f2-f2f2-4f2f-8f2f-f2f2f2f2f2f2';

/**
 * NOT REGISTERED, and that is structural rather than a convention: it is exported as a
 * value the suite passes to `runCrossTenantAttempts()` directly, and the registry has
 * no notion of a subject that is allowed to leak. So there is no field a future TASK
 * can set to mark a REAL table as expected-to-leak and have the suite wave it through.
 */
export const leakCanaryAccess: TenantScopedSurfaceRegistration = {
  subject: 'LeakCanaryTableAccess',
  table: LEAK_CANARY_TABLE,
  ownerColumn: 'tenant_id',
  reset: () => {
    // `tenants` is re-seeded first: erasing the fixture tenants cascades through the
    // canary's foreign key, so the canary has to be rebuilt after, not before.
    createRlsFixture();
    createLeakCanary();
  },
  methods: tableAccess({
    table: LEAK_CANARY_TABLE,
    ownerColumn: 'tenant_id',
    projection: ['id', 'tenant_id', 'label'],
    mutableColumn: 'label',
    plantedOwnerId: (target) => target.id,
    plantedRow: (ownerId) =>
      sql`insert into ${sql.identifier(LEAK_CANARY_TABLE)} (id, tenant_id, label)
          values (${PLANTED_CANARY_ROW_ID}::uuid, ${ownerId}::uuid, ${'planted-by-another-tenant'})`,
  }),
};

const PLANTED_CONTROL_ROW_ID = 'f3f3f3f3-f3f3-4f3f-8f3f-f3f3f3f3f3f3';

/**
 * The five r2 controls (`controls.ts`), each a real table shaped like a tenant-scoped
 * one and each defective in a way the r1 audit measured this harness reporting as clean.
 * NOT REGISTERED, for the reason `leakCanaryAccess` states above: the suite passes them
 * to `runCrossTenantAttempts()` by hand, and the registry has no notion of a subject
 * allowed to leak.
 *
 * Their `reset()` rebuilds only the control table. It does NOT rebuild the tenant
 * fixture: nothing a control attempt does touches `tenants`, and re-seeding it would
 * cascade the control's own rows away and cost three process spawns per attempt.
 */
function controlAccess(
  subject: string,
  table: string,
  reset: () => void,
): TenantScopedSurfaceRegistration {
  return {
    subject,
    table,
    ownerColumn: 'tenant_id',
    reset,
    methods: tableAccess({
      table,
      ownerColumn: 'tenant_id',
      projection: ['id', 'tenant_id', 'label'],
      mutableColumn: 'label',
      plantedOwnerId: (target) => target.id,
      plantedRow: (ownerId) =>
        sql`insert into ${sql.identifier(table)} (id, tenant_id, label)
            values (${PLANTED_CONTROL_ROW_ID}::uuid, ${ownerId}::uuid, ${'planted-by-another-tenant'})`,
    }),
  };
}

/** F-293: leaks only to one tenant, and only on INSERT. */
export const directionCanaryAccess = controlAccess(
  'DirectionCanaryTableAccess',
  DIRECTION_CANARY_TABLE,
  createDirectionCanary,
);

/** F-293: leaks on read to one tenant, and the leak is already there at baseline. */
export const baselineLeakCanaryAccess = controlAccess(
  'BaselineLeakCanaryTableAccess',
  BASELINE_LEAK_CANARY_TABLE,
  createBaselineLeakCanary,
);

/** F-294: every write refused with 42501, by a missing grant rather than by a policy. */
export const grantGapCanaryAccess = controlAccess(
  'GrantGapCanaryTableAccess',
  GRANT_GAP_CANARY_TABLE,
  createGrantGapCanary,
);

/** F-294: a wide-open policy, with two of the writes masked as 23514 refusals. */
export const maskedRefusalCanaryAccess = controlAccess(
  'MaskedRefusalCanaryTableAccess',
  MASKED_REFUSAL_CANARY_TABLE,
  createMaskedRefusalCanary,
);

/** F-295: correct policies, and only one of the two tenants was ever seeded. */
export const halfSeededCanaryAccess = controlAccess(
  'HalfSeededCanaryTableAccess',
  HALF_SEEDED_CANARY_TABLE,
  createHalfSeededCanary,
);

/** Every surface id this wave covers, hand-written so a battery quietly losing a method fails. */
export const EXPECTED_SURFACE_IDS = [
  'repo:RlsFixtureRowsTableAccess.deleteOwnedBy',
  'repo:RlsFixtureRowsTableAccess.findAll',
  'repo:RlsFixtureRowsTableAccess.findOwnedBy',
  'repo:RlsFixtureRowsTableAccess.insertOwnedBy',
  'repo:RlsFixtureRowsTableAccess.updateOwnedBy',
  'repo:TenantsTableAccess.deleteOwnedBy',
  'repo:TenantsTableAccess.findAll',
  'repo:TenantsTableAccess.findOwnedBy',
  'repo:TenantsTableAccess.insertOwnedBy',
  'repo:TenantsTableAccess.updateOwnedBy',
] as const;
