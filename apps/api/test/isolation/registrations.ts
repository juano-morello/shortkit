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
      attempt: (actor) => reads(sql`select ${projection} from ${table} order by id`)(actor),
    },
    {
      name: 'findOwnedBy',
      kind: 'read',
      attempt: (actor, target) =>
        reads(sql`select ${projection} from ${table} where ${owner} = ${target.id}::uuid`)(actor),
    },
    {
      name: 'updateOwnedBy',
      kind: 'write',
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
      attempt: (actor, target) =>
        writes(sql`delete from ${table} where ${owner} = ${target.id}::uuid`)(actor),
    },
    {
      name: 'insertOwnedBy',
      kind: 'write',
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
