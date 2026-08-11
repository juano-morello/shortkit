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
  createOwnerTheftCanary,
  createUnqualifiedWriteCanary,
  DIRECTION_CANARY_TABLE,
  GRANT_GAP_CANARY_TABLE,
  HALF_SEEDED_CANARY_TABLE,
  MASKED_REFUSAL_CANARY_TABLE,
  OWNER_THEFT_CANARY_TABLE,
  UNQUALIFIED_WRITE_CANARY_TABLE,
} from './controls';
import { createLeakCanary, LEAK_CANARY_TABLE } from './leak-canary';

/**
 * The seven statement shapes every tenant-scoped table is attacked with. They are the
 * rows of isolation-coverage.md's "Attempt semantics" table, made concrete:
 *
 *   findAll          unfiltered read           -> must return none of the target's rows
 *   findOwnedBy      read filtered to target   -> must return zero rows
 *   updateOwnedBy    write over target's rows  -> rejected, or zero rows affected
 *   deleteOwnedBy    write over target's rows  -> rejected, or zero rows affected
 *   insertOwnedBy    write planting a new row  -> rejected, or zero rows affected
 *   updateAll        write with NO WHERE       -> at most the actor's own rows affected
 *   deleteAll        write with NO WHERE       -> at most the actor's own rows affected
 *
 * `findAll` is deliberately unfiltered: a `where owner = actor` here would assert the
 * WHERE clause rather than the policy, which is the mistake `tenant-context.int-spec.ts`
 * calls out in its own `visibleRows` helper.
 *
 * ---------------------------------------------------------------------------
 * WHY THE LAST TWO EXIST, AND WHY THE FIRST FIVE CANNOT REPLACE THEM (F-302, r2)
 * ---------------------------------------------------------------------------
 *
 * `updateOwnedBy` and `deleteOwnedBy` name the owning tenant in a WHERE clause, and a
 * WHERE clause REFERENCES A COLUMN, so PostgreSQL applies the SELECT policies to the
 * statement — the rule `test/support/rls-fixture.ts:175-188` measured and wrote down for
 * the eraser. A correctly scoped SELECT policy therefore hides a completely wide-open
 * UPDATE or DELETE policy from both of them: the statement can see no row of the
 * target's to modify and reports zero rows affected, which the harness scored as a pass.
 *
 * `UPDATE <t> SET <col> = <constant>` references no existing column, so no SELECT policy
 * is consulted and the UPDATE policy's USING clause is all that stands in the way.
 * Measured on the migrated `tenants` table with `tenants_self_update` altered to
 * `USING (true) WITH CHECK (true)`, in one ordinary tenant-A transaction:
 *
 *   UPDATE tenants SET name = 'x' WHERE id = <B>   -> UPDATE 0   (SELECT policy applied)
 *   UPDATE tenants SET name = 'x'                  -> UPDATE 2   (both tenants' rows)
 *
 * The auditor measured the same asymmetry for DELETE. These two statements are the
 * ordinary shape of an admin action, a bulk operation, a migration helper, or an ORM
 * call with a forgotten `where` — GC-5 says no query path may bypass tenant scoping, and
 * this was a whole class of path the harness could not see.
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
 *
 * 4. EVERY METHOD DECLARES `qualification`, AND AT LEAST ONE WRITE IS `'unqualified'`.
 *    A registration whose writes all name the owning tenant in a WHERE clause is blind
 *    to a wide-open UPDATE or DELETE policy, because PostgreSQL routes such a write
 *    through the SELECT policy and it reports zero rows (F-302). `tableAccess()` below
 *    supplies both shapes; a hand-written registration owes them itself.
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
  /**
   * F-330. Set when `UPDATE <t> SET <ownerColumn> = <actor>` is not a statement this
   * table can express at all. The string is the reason, it is required to remove the
   * shape, and it is carried into `report.json` via the registration's `declinedShapes`
   * — a shape that vanishes silently is the failure mode three rounds of audit have
   * found here.
   */
  readonly declineReparentAllBecause?: string;
}

/**
 * F-330. `tenants` is the cascade root: its owner column IS its primary key, so
 * `UPDATE tenants SET id = <actor>` with no WHERE sets every visible row's id to the
 * same value and collides on the primary key — a 23505 raised by the index BEFORE any
 * policy is consulted, which is indistinguishable from the 42501 a policy owes us. It is
 * also not a statement any real code path issues: re-parenting a tenant to itself is not
 * an operation. Recorded rather than silently skipped, and printed into the artifact.
 */
export const TENANTS_DECLINES_REPARENT =
  'tenants is the cascade root and its owner column `id` is its primary key. An ' +
  'unqualified `UPDATE tenants SET id = <actor>` sets every row the USING clause admits ' +
  'to one value and is refused by the primary key index with 23505 before any policy is ' +
  'evaluated, so it could never distinguish a correct policy from a wide-open one. ' +
  'CONSEQUENCE, STATED: on the migrated production table the F-302/F-330 mechanism rests ' +
  'on `updateAll` alone per direction — `deleteAll` there is inert for the reason F-329 ' +
  'records, and this shape is inapplicable.';

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

  const shapes: TenantScopedMethod[] = [
    {
      name: 'findAll',
      kind: 'read',
      reaches: 'existing-row',
      qualification: 'unqualified',
      attempt: (actor) => reads(sql`select ${projection} from ${table} order by id`)(actor),
    },
    {
      name: 'findOwnedBy',
      kind: 'read',
      reaches: 'existing-row',
      qualification: 'owner-qualified',
      attempt: (actor, target) =>
        reads(sql`select ${projection} from ${table} where ${owner} = ${target.id}::uuid`)(actor),
    },
    {
      name: 'updateOwnedBy',
      kind: 'write',
      reaches: 'existing-row',
      qualification: 'owner-qualified',
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
      qualification: 'owner-qualified',
      attempt: (actor, target) =>
        writes(sql`delete from ${table} where ${owner} = ${target.id}::uuid`)(actor),
    },
    {
      name: 'insertOwnedBy',
      kind: 'write',
      reaches: 'new-row',
      qualification: 'owner-qualified',
      attempt: (actor, target) => writes(spec.plantedRow(spec.plantedOwnerId(target)))(actor),
    },
    /**
     * F-302. NO WHERE CLAUSE, AND NO REFERENCE TO AN EXISTING COLUMN.
     *
     * `set <col> = <constant>` is what keeps the SELECT policies out of it: a SET
     * expression reading a column would pull them back in and this attempt would become
     * `updateOwnedBy` with extra steps. The label is distinct from
     * `overwritten-by-another-tenant` on purpose — `isolation_masked_refusal_canary`
     * carries a CHECK constraint rejecting that one, and a control that refuses this
     * statement with 23514 would hide the very leak it exists to expose.
     *
     * `reaches: 'existing-row'`: with nothing of the target's there, an unqualified
     * write has nothing to leak and its row count proves nothing (F-295).
     */
    {
      name: 'updateAll',
      kind: 'write',
      reaches: 'existing-row',
      qualification: 'unqualified',
      attempt: (actor) =>
        writes(
          sql`update ${table}
                 set ${sql.identifier(spec.mutableColumn)} = ${'overwritten-by-an-unqualified-write'}`,
        )(actor),
    },
    /** F-302. `DELETE FROM <t>` — the auditor's measurement: DELETE 0 qualified, DELETE 2 not. */
    {
      name: 'deleteAll',
      kind: 'write',
      reaches: 'existing-row',
      qualification: 'unqualified',
      attempt: (actor) => writes(sql`delete from ${table}`)(actor),
    },
    /**
     * =========================================================================
     * F-330. THE ONLY SHAPE THAT WRITES THE OWNER COLUMN, AND IT IS THE THEFT.
     * =========================================================================
     *
     * `UPDATE <t> SET <ownerColumn> = <actor>`, unqualified. It exists because F-302's
     * fix closed the half of the defect that permits OVERWRITING and left the half that
     * permits TAKING — and the second is worse.
     *
     * Widen a policy's USING and leave its WITH CHECK correct — one token away from what
     * `tenantScopedPolicies()` emits — and every other shape in this battery reports a
     * pass. Measured on a probe carrying exactly that policy:
     *
     *   findAll / findOwnedBy        -> correct rows            -> pass
     *   updateOwnedBy / deleteOwnedBy-> 0 rows (SELECT policy)  -> pass
     *   insertOwnedBy                -> 42501 RLS refusal       -> pass
     *   updateAll   (F-302's)        -> 42501, WITH CHECK held  -> pass
     *   deleteAll   (F-302's)        -> DELETE 1 == own rows    -> pass
     *   UPDATE probe SET tenant_id = <A>            -> UPDATE 2, AND B'S ROW IS NOW A'S
     *
     * That last statement is this method. The WITH CHECK is satisfied precisely BECAUSE
     * the resulting row belongs to the actor, which is why it slips past the clause that
     * refuses every other write — and why the count rule and the digest, which never see
     * a statement that is never issued, both stayed silent.
     *
     * It is judged by the two mechanisms that already exist and needs no third: the
     * count rule sees `UPDATE 2` against one visible own row, and `foreignRowLines()`
     * sees the target's row LEAVE the foreign set, which names the victim.
     *
     * Ordinary code paths that issue it: a re-parent, a move-between-workspaces, an
     * upsert, an ORM `save()` on a hydrated entity whose owner field was rebound.
     */
    {
      name: 'reparentAll',
      kind: 'write',
      reaches: 'existing-row',
      qualification: 'unqualified',
      attempt: (actor) =>
        writes(sql`update ${table} set ${owner} = ${actor.id}::uuid`)(actor),
    },
  ];

  // F-330. The declined shape is REMOVED HERE AND NOWHERE ELSE, and only against a
  // stated reason — which the registration also carries into `report.json`. A shape that
  // can be dropped without a reason is a shape that gets dropped.
  return shapes.filter(
    (shape) =>
      !(shape.name === 'reparentAll' && spec.declineReparentAllBecause !== undefined),
  );
}

const PLANTED_FIXTURE_ROW_ID = 'f1f1f1f1-f1f1-4f1f-8f1f-f1f1f1f1f1f1';

/**
 * The cascade root. `id` is its own owner column, and its four policies are the bespoke
 * set `apps/api/drizzle/0000_*.sql` hand-appends — not `tenantScopedPolicies()`.
 *
 * ---------------------------------------------------------------------------
 * WHAT `tenants`'s GREEN ATTEMPTS ACTUALLY PROVE (F-329, F-334) — READ THIS BEFORE
 * QUOTING A COUNT OF THEM
 * ---------------------------------------------------------------------------
 *
 * `tenants` has NO ORDINARY DELETE POLICY AT ALL (F-005). An earlier version of this
 * comment said that "is what `deleteOwnedBy` exercises", which reads as coverage; it is
 * the opposite. BOTH delete attempts on this table rest on that absence:
 *
 *   deleteOwnedBy  `DELETE FROM tenants WHERE id = <target>`  -> 0, whatever else is true
 *   deleteAll      `DELETE FROM tenants`                      -> 0, whatever else is true
 *
 * Four green attempts (two shapes x two directions) that prove a policy is ABSENT rather
 * than that a policy is CORRECT. They start meaning something the day a DELETE policy
 * lands here, and not before.
 *
 * And the eight owner-qualified write attempts across both registered tables prove the
 * SELECT policy rather than the write policy — that is F-302's finding restated as an
 * accounting fact, not a separate defect.
 *
 * SO, ON THE MIGRATED PRODUCTION TABLE: `updateAll` is the ONLY live unqualified write
 * attempt per direction. `deleteAll` is inert for the reason above and `reparentAll` is
 * inapplicable for the reason `TENANTS_DECLINES_REPARENT` gives. One attempt per
 * direction is what stands between this table and F-302's class of defect, and that
 * number belongs at the gate rather than in a footnote.
 */
const tenantsAccess: TenantScopedSurfaceRegistration = {
  subject: 'TenantsTableAccess',
  table: 'tenants',
  ownerColumn: 'id',
  reset: createRlsFixture,
  declinedShapes: [{ shape: 'reparentAll', because: TENANTS_DECLINES_REPARENT }],
  methods: tableAccess({
    table: 'tenants',
    ownerColumn: 'id',
    projection: ['id', 'name'],
    mutableColumn: 'name',
    plantedOwnerId: () => TENANT_C_NEVER_SEEDED,
    plantedRow: (ownerId) =>
      sql`insert into ${sql.identifier('tenants')} (id, name)
          values (${ownerId}::uuid, ${'planted-by-another-tenant'})`,
    declineReparentAllBecause: TENANTS_DECLINES_REPARENT,
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
 * The six r2 controls (`controls.ts`), each a real table shaped like a tenant-scoped
 * one and each defective in a way an audit measured this harness reporting as clean.
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

/**
 * F-302. A wide-open UPDATE and a wide-open DELETE policy, and NOTHING ELSE WRONG. The
 * SELECT policy is correctly scoped, which is the whole artifact: with it in place, an
 * ownership census is clean, every owner-qualified attempt is routed through it and
 * reports zero rows, and the table reads as isolated from all five of the shapes the
 * harness had before r2.
 *
 * This is the auditor's `ALTER POLICY tenants_self_update ON tenants USING (true) WITH
 * CHECK (true)` made permanent as DDL, so the measurement runs on every CI run rather
 * than once. Under that mutation, on the migrated production table, `UPDATE tenants SET
 * name = 'pwned-by-tenant-A'` in an ordinary tenant-A transaction reported UPDATE 2 and
 * both rows read `pwned-by-tenant-A` afterwards, while this suite reported 15 passed and
 * exit 0.
 *
 * The insert policy is left correct on purpose. A wide-open WITH CHECK would fail
 * `insertOwnedBy` as well, and the control would stop being a statement about the
 * unqualified shape specifically.
 */
export const unqualifiedWriteCanaryAccess = controlAccess(
  'UnqualifiedWriteCanaryTableAccess',
  UNQUALIFIED_WRITE_CANARY_TABLE,
  createUnqualifiedWriteCanary,
);

/**
 * F-330. THE SIBLING OF THE ABOVE, AND THE ONE THE r2 FIX LEFT OPEN. Its UPDATE policy
 * carries `USING (true)` with the WITH CHECK left exactly as `tenantScopedPolicies()`
 * writes it, so the refusal-scored-as-a-pass and the owner-column write are both live on
 * it. Three characters of DDL separate it from `unqualifiedWriteCanaryAccess`, and that
 * is the distance between vandalism and theft.
 */
export const ownerTheftCanaryAccess = controlAccess(
  'OwnerTheftCanaryTableAccess',
  OWNER_THEFT_CANARY_TABLE,
  createOwnerTheftCanary,
);

/** Every surface id this wave covers, hand-written so a battery quietly losing a method fails. */
export const EXPECTED_SURFACE_IDS = [
  'repo:RlsFixtureRowsTableAccess.deleteAll',
  'repo:RlsFixtureRowsTableAccess.deleteOwnedBy',
  'repo:RlsFixtureRowsTableAccess.findAll',
  'repo:RlsFixtureRowsTableAccess.findOwnedBy',
  'repo:RlsFixtureRowsTableAccess.insertOwnedBy',
  'repo:RlsFixtureRowsTableAccess.reparentAll',
  'repo:RlsFixtureRowsTableAccess.updateAll',
  'repo:RlsFixtureRowsTableAccess.updateOwnedBy',
  'repo:TenantsTableAccess.deleteAll',
  'repo:TenantsTableAccess.deleteOwnedBy',
  'repo:TenantsTableAccess.findAll',
  'repo:TenantsTableAccess.findOwnedBy',
  'repo:TenantsTableAccess.insertOwnedBy',
  'repo:TenantsTableAccess.updateAll',
  'repo:TenantsTableAccess.updateOwnedBy',
] as const;
