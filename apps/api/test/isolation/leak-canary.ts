/**
 * THE NEGATIVE CONTROL. A table shaped exactly like a tenant-scoped one, with the
 * row-level security DELIBERATELY LEFT OFF.
 *
 * Produced by: TASK-006. Used by `cross-tenant-isolation.int-spec.ts` and nowhere else.
 *
 * WHY IT EXISTS. AC-12 is satisfied by the harness enumerating and reporting correctly,
 * and it was ruled on 2026-08-06 that no test-of-the-harness would be written, because
 * a test asserting that a test helper works is hollow. That ruling left one thing
 * unproven and said so: nothing mechanically demonstrated that the harness would DETECT
 * a leak rather than report `pass` on a run where it was looking in the wrong place.
 *
 * This table closes that without asserting anything about the harness's internals. It
 * is a real table in a real database that really does leak: any tenant can read, edit,
 * delete and plant rows belonging to any other. The suite runs the SAME harness over
 * it (same registry, same attempt semantics, same judge), and requires all five
 * methods to come back `fail`. The break that test catches is a harness that has
 * stopped detecting anything, and the assertion is about Postgres's answer, not about
 * the harness's shape.
 *
 * THE DEFECT IT IMPERSONATES IS THE REAL ONE. `scripts/check-policies.mts` opens with
 * it: a TASK that adds a table, appends its CREATE POLICY block and forgets ENABLE or
 * FORCE ships a table every authenticated tenant can read and write, with every gate
 * green. This table is that TASK's output. It carries the `tenant_id` column and the
 * foreign key and it carries no `ALTER TABLE ... ENABLE ROW LEVEL SECURITY`.
 *
 * ⚠ IT MUST NOT SURVIVE THE SUITE. An unprotected table sitting in schema `public` is
 * exactly what `db:check-policies` exists to fail on. `dropLeakCanary()` runs in the
 * suite's `afterAll`, and CI runs `db:check-policies` BEFORE the integration suite
 * (ci.yml, "ORDER IS LOAD-BEARING"), so the two never meet. If they ever do, the
 * failure names `isolation_leak_canary`, which is a name that explains itself.
 */
import { TENANT_ID_COLUMN_SQL } from '../../src/db/rls';
import { execSql, querySql } from '../support/psql';
import {
  appRoleName,
  migrationDsn,
  TENANT_A,
  TENANT_B,
} from '../support/rls-fixture';

export const LEAK_CANARY_TABLE = 'isolation_leak_canary';

export const LEAK_CANARY_A_ROW_ID = '0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a';
export const LEAK_CANARY_B_ROW_ID = '0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b';

/**
 * Same DDL a tenant-scoped table gets, from the same production constant, and then
 * NOT `tenantScopedPolicies()`. That omission is the whole artifact. It is spelled out
 * rather than achieved by deleting a line, so nobody repairs it by re-adding one.
 */
export function createLeakCanary(): void {
  execSql(
    migrationDsn(),
    `DROP TABLE IF EXISTS ${LEAK_CANARY_TABLE};

     CREATE TABLE ${LEAK_CANARY_TABLE} (
       id    uuid PRIMARY KEY,
       ${TENANT_ID_COLUMN_SQL},
       label text NOT NULL
     );

     GRANT SELECT, INSERT, UPDATE, DELETE ON ${LEAK_CANARY_TABLE} TO :"app_role";

     INSERT INTO ${LEAK_CANARY_TABLE} (id, tenant_id, label) VALUES
       ('${LEAK_CANARY_A_ROW_ID}', '${TENANT_A}', 'canary-row-owned-by-tenant-a'),
       ('${LEAK_CANARY_B_ROW_ID}', '${TENANT_B}', 'canary-row-owned-by-tenant-b');`,
    { variables: { app_role: appRoleName() } },
  );
}

export function dropLeakCanary(): void {
  execSql(migrationDsn(), `DROP TABLE IF EXISTS ${LEAK_CANARY_TABLE};`);
}

interface TableProtection extends Record<string, unknown> {
  row_security: boolean;
  force_row_security: boolean;
  policies: number;
}

/**
 * The premise of the negative control, read from the catalog. Asserted before the
 * control is used: if someone "fixed" this table by protecting it, the control would
 * report `pass` on every method and the suite's expectation of failure would go red
 * with no explanation of why.
 */
export function leakCanaryProtection(): TableProtection {
  const [state] = querySql<TableProtection>(
    migrationDsn(),
    `SELECT c.relrowsecurity      AS row_security,
            c.relforcerowsecurity AS force_row_security,
            (SELECT count(*)::int
               FROM pg_policies p
              WHERE p.schemaname = 'public' AND p.tablename = '${LEAK_CANARY_TABLE}') AS policies
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = '${LEAK_CANARY_TABLE}'`,
  );

  if (state === undefined) {
    throw new Error(`${LEAK_CANARY_TABLE} does not exist; call createLeakCanary() first.`);
  }

  return state;
}
