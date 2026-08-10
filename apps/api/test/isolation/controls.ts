/**
 * FIVE MORE NEGATIVE CONTROLS, one per way the r1 audit measured this harness reporting
 * `pass` over a database that was not isolated.
 *
 * Produced by: TASK-006 rework r2 (F-293, F-294, F-295, F-296). Used by
 * `cross-tenant-isolation.int-spec.ts` and nowhere else.
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

/**
 * F-296's probe. A tenant-scoped table that NOBODY REGISTERS — the wave-3 table the
 * security auditor added by hand and watched both gates stay green over. It is
 * deliberately NOT named in `SUITE_OWNED_CONTROL_TABLES`, because being caught is the
 * whole point of it.
 */
export const UNREGISTERED_TABLE_PROBE = 'wave3_workspaces_probe';

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
      UNREGISTERED_TABLE_PROBE,
    ]
      .map((table) => `DROP TABLE IF EXISTS ${table};`)
      .join('\n'),
  );
}
