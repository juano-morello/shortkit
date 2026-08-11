/**
 * SIX MORE NEGATIVE CONTROLS, one per way an audit measured this harness reporting
 * `pass` over a database that was not isolated.
 *
 * Produced by: TASK-006 rework r2 (F-293, F-294, F-295, F-296) and r2 round 2
 * (F-302, F-303). Used by `cross-tenant-isolation.int-spec.ts` and nowhere else.
 *
 * `leak-canary.ts` already carries the first control — a table with no row-level
 * security at all, which every attempt must report as failing. It catches one shape: a
 * TOTAL, SYMMETRIC leak on a table someone remembered to register. The audit measured
 * four shapes it does not catch, and each of the tables below is one of them, built as
 * real DDL against the real database rather than as a mutation someone ran once:
 *
 *   isolation_direction_canary        a carve-out that lets ONE tenant plant rows owned
 *                                     by another. Invisible to a census, invisible to
 *                                     every attempt that only ever acts as tenant A.
 *                                     F-293's blind spot, in its sharpest form.
 *
 *   isolation_baseline_leak_canary    a read carve-out for one tenant. The leak is
 *                                     present BEFORE any attempt runs, so a
 *                                     before/after comparison of the ownership census
 *                                     cannot see it. F-293's second half.
 *
 *   isolation_grant_gap_canary        correct policies, and the runtime role never
 *                                     received INSERT/UPDATE/DELETE. Every write raises
 *                                     42501 — the same SQLSTATE a policy refusal raises
 *                                     — so a harness that scores any throw as a pass
 *                                     reports three write surfaces it never tested.
 *                                     F-294.
 *
 *   isolation_masked_refusal_canary   a wide-open policy, plus an unrelated CHECK
 *                                     constraint that the planted row happens to
 *                                     violate. The write is refused with 23514 while
 *                                     the policy admits everything. F-294, measured
 *                                     form.
 *
 *   isolation_half_seeded_canary      correct policies, and only tenant A was ever
 *                                     seeded. Four of the five statement shapes return
 *                                     zero rows because there is nothing there, not
 *                                     because a policy denied them. F-295.
 *
 *   isolation_unqualified_write_canary
 *                                     a correctly scoped SELECT policy hiding a
 *                                     COMPLETELY WIDE-OPEN UPDATE and DELETE policy.
 *                                     Every owner-qualified attempt is routed through
 *                                     the SELECT policy by PostgreSQL and reports zero
 *                                     rows, so the table reads as isolated from all five
 *                                     of the shapes the harness had before r2's second
 *                                     round. Only a write with NO WHERE CLAUSE sees it.
 *                                     F-302's blocker, in its sharpest form.
 *
 * ⚠ NONE OF THEM MAY SURVIVE THE SUITE, for the reason `leak-canary.ts` states: an
 * unprotected — or deliberately mis-protected — table in schema `public` is what
 * `db:check-policies` exists to fail on. `dropControlTables()` runs in the suite's
 * `afterAll`, and CI runs `db:check-policies` before the integration suite.
 *
 * ⚠ THE FLAG LITERAL IS DELIBERATE. These files write `app.tenant_id` into policy SQL.
 * isolation-coverage.md's scan set is `apps/api/src/**` and excludes `apps/api/test/**`
 * by name, precisely because the integration harness has to speak the same SQL the
 * policies do.
 */
import { TENANT_ID_COLUMN_SQL, tenantScopedPolicies } from '../../src/db/rls';
import { execSql } from '../support/psql';
import { appRoleName, migrationDsn, TENANT_A, TENANT_B } from '../support/rls-fixture';

export const DIRECTION_CANARY_TABLE = 'isolation_direction_canary';
export const BASELINE_LEAK_CANARY_TABLE = 'isolation_baseline_leak_canary';
export const GRANT_GAP_CANARY_TABLE = 'isolation_grant_gap_canary';
export const MASKED_REFUSAL_CANARY_TABLE = 'isolation_masked_refusal_canary';
export const HALF_SEEDED_CANARY_TABLE = 'isolation_half_seeded_canary';
export const UNQUALIFIED_WRITE_CANARY_TABLE = 'isolation_unqualified_write_canary';
export const OWNER_THEFT_CANARY_TABLE = 'isolation_owner_theft_canary';

/**
 * F-296's probe. A tenant-scoped table that NOBODY REGISTERS — the wave-3 table the
 * security auditor added by hand and watched both gates stay green over. It is
 * deliberately NOT named in `SUITE_OWNED_CONTROL_TABLES`, because being caught is the
 * whole point of it.
 */
export const UNREGISTERED_TABLE_PROBE = 'wave3_workspaces_probe';

/**
 * F-303's probe, and since r3 the stem of three of them. The same omission as
 * `UNREGISTERED_TABLE_PROBE` — nobody called `registerTenantScopedSurfaces()` — on a
 * table whose owner column is NOT called `tenant_id`. The drift check enumerated on that
 * literal name, so this table was invisible to the one mechanism F-296 added to close
 * exactly this class.
 *
 * The auditor's measured shape, reproduced here on 2026-08-11 before the F-303 fix:
 * `audit_events(owning_tenant)` with ENABLE + FORCE and `USING (true)` returns
 * `bob@tenant-b.example` inside tenant A's transaction, while the suite is 15 passed,
 * `registryDrift` is empty in both directions and `db:check-policies` calls it
 * protected. Named for a table a later wave plausibly adds, and deliberately NOT in
 * `SUITE_OWNED_CONTROL_TABLES`.
 */
export const UNREGISTERED_OWNER_COLUMN_PROBE = 'wave3_audit_events_probe';

const CONTROL_A_ROW_ID = 'c0a0c0a0-c0a0-4c0a-8c0a-c0a0c0a0c0a0';
const CONTROL_B_ROW_ID = 'c0b0c0b0-c0b0-4c0b-8c0b-c0b0c0b0c0b0';

export const CONTROL_A_LABEL = 'control-row-owned-by-tenant-a';
export const CONTROL_B_LABEL = 'control-row-owned-by-tenant-b';

const TENANT_ID = `current_setting('app.tenant_id', true)::uuid`;

/** The same shape every tenant-scoped table has, from the same production constant. */
function createTable(table: string, extra = ''): string {
  return `DROP TABLE IF EXISTS ${table};

     CREATE TABLE ${table} (
       id    uuid PRIMARY KEY,
       ${TENANT_ID_COLUMN_SQL},
       label text NOT NULL${extra}
     );`;
}

function seedBothTenants(table: string): string {
  return `INSERT INTO ${table} (id, tenant_id, label) VALUES
       ('${CONTROL_A_ROW_ID}', '${TENANT_A}', '${CONTROL_A_LABEL}'),
       ('${CONTROL_B_ROW_ID}', '${TENANT_B}', '${CONTROL_B_LABEL}');`;
}

function grantAll(table: string): string {
  return `GRANT SELECT, INSERT, UPDATE, DELETE ON ${table} TO :"app_role";`;
}

function run(script: string): void {
  execSql(migrationDsn(), script, { variables: { app_role: appRoleName() } });
}

/**
 * THE DEFECT: `_insert` carries an `OR` arm naming one tenant. Reads, updates and
 * deletes are scoped correctly for everybody, so an ownership census taken as either
 * tenant is clean and every attempt made AS TENANT A is refused exactly as it should be.
 * Tenant B may plant a row owned by anyone.
 *
 * This is the ordinary defect the audit named: an "internal tenant" carve-out, a support
 * path, a predicate compared against a hard-coded id. It is reachable only by acting as
 * the tenant the carve-out names.
 */
export function createDirectionCanary(): void {
  run(
    `${createTable(DIRECTION_CANARY_TABLE)}

     ${grantAll(DIRECTION_CANARY_TABLE)}

     ${seedBothTenants(DIRECTION_CANARY_TABLE)}

     ALTER TABLE ${DIRECTION_CANARY_TABLE} ENABLE ROW LEVEL SECURITY;
     ALTER TABLE ${DIRECTION_CANARY_TABLE} FORCE  ROW LEVEL SECURITY;

     CREATE POLICY ${DIRECTION_CANARY_TABLE}_select ON ${DIRECTION_CANARY_TABLE}
       FOR SELECT USING (tenant_id = ${TENANT_ID});
     CREATE POLICY ${DIRECTION_CANARY_TABLE}_update ON ${DIRECTION_CANARY_TABLE}
       FOR UPDATE USING (tenant_id = ${TENANT_ID}) WITH CHECK (tenant_id = ${TENANT_ID});
     CREATE POLICY ${DIRECTION_CANARY_TABLE}_delete ON ${DIRECTION_CANARY_TABLE}
       FOR DELETE USING (tenant_id = ${TENANT_ID});
     CREATE POLICY ${DIRECTION_CANARY_TABLE}_insert ON ${DIRECTION_CANARY_TABLE}
       FOR INSERT WITH CHECK (tenant_id = ${TENANT_ID}
                              OR ${TENANT_ID} = '${TENANT_B}'::uuid);`,
  );
}

/**
 * THE DEFECT: the SELECT policy carries the same `OR` arm, so tenant B reads every
 * tenant's rows. The leak exists the moment the table is seeded — before any attempt
 * runs — which is why a census compared only before-versus-after an attempt reports it
 * as unchanged and therefore clean.
 */
export function createBaselineLeakCanary(): void {
  run(
    `${createTable(BASELINE_LEAK_CANARY_TABLE)}

     ${grantAll(BASELINE_LEAK_CANARY_TABLE)}

     ${seedBothTenants(BASELINE_LEAK_CANARY_TABLE)}

     ALTER TABLE ${BASELINE_LEAK_CANARY_TABLE} ENABLE ROW LEVEL SECURITY;
     ALTER TABLE ${BASELINE_LEAK_CANARY_TABLE} FORCE  ROW LEVEL SECURITY;

     CREATE POLICY ${BASELINE_LEAK_CANARY_TABLE}_select ON ${BASELINE_LEAK_CANARY_TABLE}
       FOR SELECT USING (tenant_id = ${TENANT_ID}
                         OR ${TENANT_ID} = '${TENANT_B}'::uuid);
     CREATE POLICY ${BASELINE_LEAK_CANARY_TABLE}_update ON ${BASELINE_LEAK_CANARY_TABLE}
       FOR UPDATE USING (tenant_id = ${TENANT_ID}) WITH CHECK (tenant_id = ${TENANT_ID});
     CREATE POLICY ${BASELINE_LEAK_CANARY_TABLE}_delete ON ${BASELINE_LEAK_CANARY_TABLE}
       FOR DELETE USING (tenant_id = ${TENANT_ID});
     CREATE POLICY ${BASELINE_LEAK_CANARY_TABLE}_insert ON ${BASELINE_LEAK_CANARY_TABLE}
       FOR INSERT WITH CHECK (tenant_id = ${TENANT_ID});`,
  );
}

/**
 * THE DEFECT IS NOT IN THE POLICIES — they are the production ones, applied by the
 * production builder. The runtime role holds SELECT and nothing else, which is what an
 * `ALTER DEFAULT PRIVILEGES` that never reached a table, or an explicit REVOKE, leaves
 * behind. Every write raises 42501 `permission denied for table ...`: the SAME SQLSTATE
 * a `WITH CHECK` refusal raises, and the reason a harness needs the message and not only
 * the code.
 *
 * Reads are granted deliberately. Without them the ownership census itself would raise
 * and the run would die before any attempt was judged, which tests nothing.
 */
export function createGrantGapCanary(): void {
  run(
    `${createTable(GRANT_GAP_CANARY_TABLE)}

     -- The REVOKE is what builds the defect, and it has to be explicit: the compose
     -- file's ALTER DEFAULT PRIVILEGES FOR ROLE shortkit_migrator grants all four
     -- privileges on every table the migrator creates, so a table can only lose them
     -- deliberately. In production the same state arrives when the migration runs under
     -- another identity and the default privileges never apply at all.
     GRANT SELECT ON ${GRANT_GAP_CANARY_TABLE} TO :"app_role";
     REVOKE INSERT, UPDATE, DELETE ON ${GRANT_GAP_CANARY_TABLE} FROM :"app_role";

     ${seedBothTenants(GRANT_GAP_CANARY_TABLE)}

     ${tenantScopedPolicies(GRANT_GAP_CANARY_TABLE).statements.join('\n     ')}`,
  );
}

/**
 * THE DEFECT: the write policies admit everything, so any tenant may plant a row owned
 * by any other. The CHECK constraint is UNRELATED to tenancy — the sort of thing an
 * ordinary schema TASK adds — and it happens to reject the exact label the insert
 * attempt writes. So the one statement that can reach the widened policy is refused,
 * with 23514, while the policy stays wide open.
 *
 * This is the security auditor's measured sequence, made permanent: widening
 * `tenants_self_insert` to `WITH CHECK (true)` turned the suite red, and adding
 * `CHECK (name <> 'planted-by-another-tenant')` turned it GREEN AGAIN at
 * `refused: error [23514]`.
 *
 * The SELECT policy is left correct on purpose, exactly as it was in that measurement.
 * A read carve-out would make the table leak outright, every attempt would fail on the
 * census, and the control would no longer be about the refusal at all.
 */
export function createMaskedRefusalCanary(): void {
  run(
    `${createTable(
      MASKED_REFUSAL_CANARY_TABLE,
      `,
       CONSTRAINT ${MASKED_REFUSAL_CANARY_TABLE}_label_check
         CHECK (label NOT IN ('planted-by-another-tenant', 'overwritten-by-another-tenant'))`,
    )}

     ${grantAll(MASKED_REFUSAL_CANARY_TABLE)}

     ${seedBothTenants(MASKED_REFUSAL_CANARY_TABLE)}

     ALTER TABLE ${MASKED_REFUSAL_CANARY_TABLE} ENABLE ROW LEVEL SECURITY;
     ALTER TABLE ${MASKED_REFUSAL_CANARY_TABLE} FORCE  ROW LEVEL SECURITY;

     CREATE POLICY ${MASKED_REFUSAL_CANARY_TABLE}_select ON ${MASKED_REFUSAL_CANARY_TABLE}
       FOR SELECT USING (tenant_id = ${TENANT_ID});
     CREATE POLICY ${MASKED_REFUSAL_CANARY_TABLE}_update ON ${MASKED_REFUSAL_CANARY_TABLE}
       FOR UPDATE USING (true) WITH CHECK (true);
     CREATE POLICY ${MASKED_REFUSAL_CANARY_TABLE}_delete ON ${MASKED_REFUSAL_CANARY_TABLE}
       FOR DELETE USING (true);
     CREATE POLICY ${MASKED_REFUSAL_CANARY_TABLE}_insert ON ${MASKED_REFUSAL_CANARY_TABLE}
       FOR INSERT WITH CHECK (true);`,
  );
}

/**
 * THE DEFECT IS IN THE FIXTURE, NOT THE DATABASE: the policies are the production ones
 * and they work. Only tenant A was seeded. Every statement that reaches an EXISTING row
 * therefore returns nothing whatever the policy says, and a harness that reads zero rows
 * as proof of denial reports four green surfaces over a premise it never established.
 *
 * The same table, read the other way round, is the actor-side half: acting as tenant B
 * there is no row of B's own to see, so nothing the database answers is evidence that
 * the tenant context reached it at all.
 */
export function createHalfSeededCanary(): void {
  run(
    `${createTable(HALF_SEEDED_CANARY_TABLE)}

     ${grantAll(HALF_SEEDED_CANARY_TABLE)}

     INSERT INTO ${HALF_SEEDED_CANARY_TABLE} (id, tenant_id, label) VALUES
       ('${CONTROL_A_ROW_ID}', '${TENANT_A}', '${CONTROL_A_LABEL}');

     ${tenantScopedPolicies(HALF_SEEDED_CANARY_TABLE).statements.join('\n     ')}`,
  );
}

/**
 * F-302. THE DEFECT: `_update` and `_delete` admit everything, and the SELECT policy is
 * CORRECT. That combination is what made this class invisible. PostgreSQL applies the
 * SELECT policies to any UPDATE or DELETE that references a column, so:
 *
 *   update ... where tenant_id = <target>  -> the SELECT policy hides the target's row
 *                                             -> UPDATE 0 -> scored as a pass
 *   delete ... where tenant_id = <target>  -> same -> DELETE 0 -> scored as a pass
 *   update ... set label = <constant>      -> no column referenced, no SELECT policy
 *                                             -> UPDATE 2 -> THE LEAK
 *   delete from ...                        -> same -> DELETE 2 -> THE LEAK
 *
 * The ownership census is clean too, because nothing this table admits on a SELECT
 * crosses a boundary. So before r2's second round, every mechanism this harness had
 * reported it isolated.
 *
 * The INSERT policy is left correct on purpose, exactly as the SELECT one is: widening
 * it would fail `insertOwnedBy` as well and the control would stop being a statement
 * about the unqualified shape.
 */
export function createUnqualifiedWriteCanary(): void {
  run(
    `${createTable(UNQUALIFIED_WRITE_CANARY_TABLE)}

     ${grantAll(UNQUALIFIED_WRITE_CANARY_TABLE)}

     ${seedBothTenants(UNQUALIFIED_WRITE_CANARY_TABLE)}

     ALTER TABLE ${UNQUALIFIED_WRITE_CANARY_TABLE} ENABLE ROW LEVEL SECURITY;
     ALTER TABLE ${UNQUALIFIED_WRITE_CANARY_TABLE} FORCE  ROW LEVEL SECURITY;

     CREATE POLICY ${UNQUALIFIED_WRITE_CANARY_TABLE}_select ON ${UNQUALIFIED_WRITE_CANARY_TABLE}
       FOR SELECT USING (tenant_id = ${TENANT_ID});
     CREATE POLICY ${UNQUALIFIED_WRITE_CANARY_TABLE}_insert ON ${UNQUALIFIED_WRITE_CANARY_TABLE}
       FOR INSERT WITH CHECK (tenant_id = ${TENANT_ID});
     CREATE POLICY ${UNQUALIFIED_WRITE_CANARY_TABLE}_update ON ${UNQUALIFIED_WRITE_CANARY_TABLE}
       FOR UPDATE USING (true) WITH CHECK (true);
     CREATE POLICY ${UNQUALIFIED_WRITE_CANARY_TABLE}_delete ON ${UNQUALIFIED_WRITE_CANARY_TABLE}
       FOR DELETE USING (true);`,
  );
}

/**
 * F-330. THE SIBLING OF THE ABOVE, AND THE WORSE HALF. The UPDATE policy's USING is
 * widened and its WITH CHECK IS LEFT EXACTLY AS `tenantScopedPolicies()` WRITES IT — one
 * token of difference from the production builder, and the difference between the two
 * canaries is three characters.
 *
 * WHY IT NEEDS ITS OWN TABLE. `isolation_unqualified_write_canary` widens both halves,
 * so `updateAll` sails through the WITH CHECK, reports `UPDATE 2`, and the count rule
 * catches it. Tighten the WITH CHECK back and that same statement is REFUSED with 42501
 * on the first foreign row it reaches — which the harness scored as a pass until r3,
 * because a refusal looked like a denial. Measured on the migrated `tenants` table:
 * every attempt green, `verdict: pass`, over a policy admitting every row of every
 * tenant.
 *
 * WHAT IT PERMITS, WHICH IS THEFT RATHER THAN VANDALISM. The WITH CHECK is satisfied by
 * any row that ends up belonging to the actor, so `UPDATE <t> SET tenant_id = <actor>`
 * takes every row the widened USING admits. Measured on a probe carrying this exact
 * policy: `UPDATE 2`, and `row-owned-by-tenant-b` afterwards read `tenant_id = <A>`.
 *
 * Expected outcomes over the eight shapes, and the middle one is the point:
 *   findAll, findOwnedBy, updateOwnedBy, deleteOwnedBy, insertOwnedBy, deleteAll -> pass
 *   updateAll    -> UNVERIFIED (refused by the WITH CHECK, proves the wrong half)
 *   reparentAll  -> FAIL, naming the tenant whose row moved
 */
export function createOwnerTheftCanary(): void {
  run(
    `${createTable(OWNER_THEFT_CANARY_TABLE)}

     ${grantAll(OWNER_THEFT_CANARY_TABLE)}

     ${seedBothTenants(OWNER_THEFT_CANARY_TABLE)}

     ALTER TABLE ${OWNER_THEFT_CANARY_TABLE} ENABLE ROW LEVEL SECURITY;
     ALTER TABLE ${OWNER_THEFT_CANARY_TABLE} FORCE  ROW LEVEL SECURITY;

     CREATE POLICY ${OWNER_THEFT_CANARY_TABLE}_select ON ${OWNER_THEFT_CANARY_TABLE}
       FOR SELECT USING (tenant_id = ${TENANT_ID});
     CREATE POLICY ${OWNER_THEFT_CANARY_TABLE}_insert ON ${OWNER_THEFT_CANARY_TABLE}
       FOR INSERT WITH CHECK (tenant_id = ${TENANT_ID});
     CREATE POLICY ${OWNER_THEFT_CANARY_TABLE}_delete ON ${OWNER_THEFT_CANARY_TABLE}
       FOR DELETE USING (tenant_id = ${TENANT_ID});
     -- THE DEFECT, AND IT IS ONE TOKEN: USING widened, WITH CHECK left correct.
     CREATE POLICY ${OWNER_THEFT_CANARY_TABLE}_update ON ${OWNER_THEFT_CANARY_TABLE}
       FOR UPDATE USING (true) WITH CHECK (tenant_id = ${TENANT_ID});`,
  );
}

/**
 * F-296. A tenant-scoped table added by a later wave whose author forgot the one
 * `registerTenantScopedSurfaces()` call. It is correct in every way `db:check-policies`
 * can see — `tenant_id`, ENABLE, FORCE, a policy — and the isolation suite must still
 * fail, because nothing ever attempts anything against it.
 */
export function createUnregisteredTableProbe(): void {
  run(
    `${createTable(UNREGISTERED_TABLE_PROBE)}

     ${grantAll(UNREGISTERED_TABLE_PROBE)}

     ${tenantScopedPolicies(UNREGISTERED_TABLE_PROBE).statements.join('\n     ')}`,
  );
}

export function dropUnregisteredTableProbe(): void {
  execSql(migrationDsn(), `DROP TABLE IF EXISTS ${UNREGISTERED_TABLE_PROBE};`);
}

/**
 * F-303 / F-333. THE SAME FORGOTTEN REGISTRATION, ON A TABLE WHOSE OWNER COLUMN IS NOT
 * CALLED `tenant_id` — IN ALL THREE STATES OF PROTECTION.
 *
 * Everything else about each is a plausible wave-3 table: a foreign key to `tenants` with
 * the cascade every schema TASK declares, and one row owned by tenant B and none by
 * tenant A, so every row tenant A can read is one it does not own and the leak needs no
 * arithmetic to see.
 *
 * ALL THREE LEAK `bob@tenant-b.example` TO TENANT A, and r3 measured that only the third
 * was named:
 *
 *   norls    no row-level security at all       -> arms 1-4: NOT NAMED
 *   noforce  ENABLE, no FORCE, USING (true)     -> arms 1-4: NOT NAMED
 *   forced   ENABLE + FORCE, USING (true)       -> arms 1-4: named, by arm 3
 *
 * The first two were caught only by `db:check-policies`, which is a DIFFERENT GATE — so
 * the drift check was neither second nor independent for the unprotected shape, which is
 * exactly what coverage.ts's header claimed it was. Arm 5, a foreign key to `tenants(id)`,
 * is what names all three. These probes are why that arm cannot be removed without a red
 * run.
 *
 * The policy DDL is written out rather than built from `tenantScopedPolicies()`, which
 * hard-codes the column name `tenant_id` — the same assumption these probes exist to
 * break. None of them is in `SUITE_OWNED_CONTROL_TABLES`; being caught is the point.
 *
 * The address is a fixture value in a probe table that reaches a test log and never a
 * pino body (GC-9).
 */
type OwnerColumnProbeProtection = 'norls' | 'noforce' | 'forced';

const OWNER_COLUMN_PROBE_PROTECTION: Record<OwnerColumnProbeProtection, (table: string) => string> = {
  norls: () => '',
  noforce: (table) =>
    `ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;
     CREATE POLICY ${table}_tenant_isolation ON ${table} FOR ALL USING (true) WITH CHECK (true);`,
  forced: (table) =>
    `ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;
     ALTER TABLE ${table} FORCE  ROW LEVEL SECURITY;
     CREATE POLICY ${table}_tenant_isolation ON ${table} FOR ALL USING (true) WITH CHECK (true);`,
};

export function ownerColumnProbeTable(protection: OwnerColumnProbeProtection): string {
  return `${UNREGISTERED_OWNER_COLUMN_PROBE}_${protection}`;
}

/** Every shape of the F-333 probe, in the order the re-audit measured them. */
export const OWNER_COLUMN_PROBE_PROTECTIONS: readonly OwnerColumnProbeProtection[] = [
  'norls',
  'noforce',
  'forced',
];

export function createUnregisteredOwnerColumnProbe(
  protection: OwnerColumnProbeProtection,
): void {
  const table = ownerColumnProbeTable(protection);

  run(
    `DROP TABLE IF EXISTS ${table};

     CREATE TABLE ${table} (
       id            uuid PRIMARY KEY,
       owning_tenant uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
       actor_email   text NOT NULL
     );

     GRANT SELECT, INSERT, UPDATE, DELETE ON ${table} TO :"app_role";

     INSERT INTO ${table} (id, owning_tenant, actor_email) VALUES
       ('${CONTROL_B_ROW_ID}', '${TENANT_B}', 'bob@tenant-b.example');

     ${OWNER_COLUMN_PROBE_PROTECTION[protection](table)}`,
  );
}

export function dropUnregisteredOwnerColumnProbes(): void {
  execSql(
    migrationDsn(),
    OWNER_COLUMN_PROBE_PROTECTIONS.map(
      (protection) => `DROP TABLE IF EXISTS ${ownerColumnProbeTable(protection)};`,
    ).join('\n'),
  );
}

/** Every control table this file builds, dropped in the suite's `afterAll`. */
export function dropControlTables(): void {
  execSql(
    migrationDsn(),
    [
      DIRECTION_CANARY_TABLE,
      BASELINE_LEAK_CANARY_TABLE,
      GRANT_GAP_CANARY_TABLE,
      MASKED_REFUSAL_CANARY_TABLE,
      HALF_SEEDED_CANARY_TABLE,
      UNQUALIFIED_WRITE_CANARY_TABLE,
      OWNER_THEFT_CANARY_TABLE,
      UNREGISTERED_TABLE_PROBE,
      ...OWNER_COLUMN_PROBE_PROTECTIONS.map(ownerColumnProbeTable),
    ]
      .map((table) => `DROP TABLE IF EXISTS ${table};`)
      .join('\n'),
  );
}
