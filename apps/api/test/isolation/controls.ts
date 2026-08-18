/**
 * NINE MORE CONTROLS. Eight are NEGATIVE — one per way an audit measured this harness
 * reporting `pass` over a database that was not isolated — and the ninth,
 * `isolation_guarded_check_canary`, is POSITIVE: a correctly isolated table the harness
 * measurably reported red (F-344).
 *
 * Produced by: TASK-006 rework r2 (F-293, F-294, F-295, F-296), r2 round 2 (F-302,
 * F-303), r3 (F-330, F-333) and r4 (F-342, F-344). Used by
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
 *   isolation_owner_theft_canary      the same USING widened and the WITH CHECK LEFT
 *                                     CORRECT, so the unqualified write is REFUSED and
 *                                     the refusal read as a denial, while a statement
 *                                     assigning the owner column takes the row. F-330's
 *                                     blocker.
 *
 *   isolation_pk_owner_canary         that defect on a table whose owner column IS its
 *                                     primary key — `tenants`'s shape, and the shape r3
 *                                     declined the owner-column write on. F-342.
 *
 *   isolation_guarded_check_canary    THE ONE THAT IS NOT A LEAK. Correctly isolated,
 *                                     with a WITH CHECK stricter than its USING, which
 *                                     the r3 rule reported red — permanently, with no
 *                                     escape. F-344.
 *
 * ⚠ ONE OF THEM IS A POSITIVE CONTROL AND ITS EXPECTED ANSWER IS `pass`. Every other
 * table here must come back non-`pass` on the attempts the finding names;
 * `isolation_guarded_check_canary` must come back entirely green, because the failure it
 * exists for is the harness calling a correct database broken.
 *
 * ⚠ NONE OF THEM MAY SURVIVE THE SUITE, for the reason `leak-canary.ts` states: an
 * unprotected — or deliberately mis-protected — table in schema `public` is what
 * `db:check-policies` exists to fail on. `dropControlTables()` runs in the suite's
 * `afterAll`, and CI runs `db:check-policies` before the integration suite.
 *
 * ⚠ THE FLAG LITERAL IS DELIBERATE WHEREVER IT APPEARS. These files write `app.tenant_id`
 * into policy SQL. isolation-coverage.md's scan set is `apps/api/src/**` and excludes
 * `apps/api/test/**` by name, precisely because the integration harness has to speak the
 * same SQL the policies do. Since 2026-08-14 the tenant-id predicate is READ OUT OF
 * `tenantScopedPolicies()` rather than written here (F-009), so the literal reaches these
 * canaries from `src/db/rls.ts` — which is the one file the scan set permits to hold it.
 */
import {
  Body,
  Controller,
  Get,
  Module,
  NotFoundException,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { sql } from 'drizzle-orm';

import { TENANT_ID_COLUMN_SQL, membershipLookupPolicy, tenantScopedPolicies } from '../../src/db/rls';
import { currentTenantId, tenantDb } from '../../src/tenancy/tenant-context';
import { execSql } from '../support/psql';
import { mintToken } from '../support/auth-fixture';
import { appRoleName, migrationDsn, TENANT_A, TENANT_B } from '../support/rls-fixture';

import type { AttemptGroup } from './coverage';
import { endpointAccess } from './http-attempts';
import type { EndpointAttemptSpec, SignedInTenants } from './http-attempts';

export const DIRECTION_CANARY_TABLE = 'isolation_direction_canary';
export const BASELINE_LEAK_CANARY_TABLE = 'isolation_baseline_leak_canary';
export const GRANT_GAP_CANARY_TABLE = 'isolation_grant_gap_canary';
export const MASKED_REFUSAL_CANARY_TABLE = 'isolation_masked_refusal_canary';
export const HALF_SEEDED_CANARY_TABLE = 'isolation_half_seeded_canary';
export const UNQUALIFIED_WRITE_CANARY_TABLE = 'isolation_unqualified_write_canary';
export const OWNER_THEFT_CANARY_TABLE = 'isolation_owner_theft_canary';
export const PK_OWNER_CANARY_TABLE = 'isolation_pk_owner_canary';
export const GUARDED_CHECK_CANARY_TABLE = 'isolation_guarded_check_canary';
export const GUARDED_LEAK_CANARY_TABLE = 'isolation_guarded_leak_canary';

/**
 * F-133. THREE TABLES SHAPED LIKE `tenant_memberships`, DIFFERING ONLY IN THEIR LOOKUP
 * POLICY. `createMembershipLookupCanaries()` below says what each one is for.
 */
export const MEMBERSHIP_LOOKUP_CANARY_TABLE = 'isolation_membership_lookup_canary';
export const MEMBERSHIP_LOOKUP_WIDE_OPEN_CANARY_TABLE =
  'isolation_membership_lookup_wide_open_canary';
export const MEMBERSHIP_LOOKUP_FLAG_GATED_CANARY_TABLE =
  'isolation_membership_lookup_flag_gated_canary';

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

/**
 * ===========================================================================
 * READ OUT OF `tenantScopedPolicies()`. IT IS NOT A COPY, AND UNTIL 2026-08-14 IT WAS
 * ONE — UNDER A COMMENT SAYING IT WAS NOT (F-009).
 * ===========================================================================
 *
 * This constant used to be hand-written as `current_setting('app.tenant_id', true)::uuid`
 * with the docblock below it already claiming it came "from the same production
 * constant". It did not. ADR-0049 then changed the production predicate to wrap every
 * flag reference in `nullif(<flag>, '')`, and a hand-written copy DOES NOT MOVE WITH IT:
 * every canary in this file would have gone on testing the shape the product no longer
 * has, AND GONE GREEN, because the old predicate isolates correctly on a cold connection
 * and cold is the only state the fixture creates. The harness built to catch exactly that
 * class was carrying an instance of it.
 *
 * So it is extracted rather than transcribed. The regex is anchored on the rendering
 * `tenantScopedPolicies()` actually emits, and a rendering it cannot read throws AT
 * IMPORT — which is the point: a change to the production predicate must either flow
 * through here or stop the suite, and it may not quietly do neither.
 */
const ISOLATION_USING = /^\s*USING\s+\(tenant_id = (.+)\)$/m;

function productionTenantIdPredicate(): string {
  const isolation = tenantScopedPolicies('probe').statements.find((statement) =>
    statement.includes('probe_tenant_isolation'),
  );
  const matched = isolation === undefined ? null : ISOLATION_USING.exec(isolation);

  if (matched === null) {
    throw new Error(
      "could not read the tenant-id predicate out of tenantScopedPolicies()'s isolation " +
        `policy: ${isolation ?? 'no <t>_tenant_isolation statement was emitted at all'}. ` +
        'Every canary table in this file builds its policies from that expression, so ' +
        'a shape this cannot parse would silently leave them testing a predicate the ' +
        'product no longer uses (F-009). Update the regex above with the new rendering.',
    );
  }

  return matched[1];
}

const TENANT_ID = productionTenantIdPredicate();

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
 * =========================================================================
 * F-342. THE OWNER COLUMN IS THE PRIMARY KEY — `tenants`'s SHAPE, AS A CONTROL.
 * =========================================================================
 *
 * r3 declined the owner-column write on `tenants` on the premise that
 * `UPDATE tenants SET id = <actor>` "is refused by the primary key index with 23505
 * BEFORE ANY POLICY IS EVALUATED, so it could never distinguish a correct policy from a
 * wide-open one". Both halves are false, and the measurement is what settles it. On the
 * migrated production table, as `shortkit_app` inside an ordinary tenant-A transaction
 * (2026-08-11, this machine):
 *
 *   tenants_self_update USING (id = ctx)  [THE MIGRATION'S]  -> UPDATE 1, NO ERROR
 *   tenants_self_update USING (true), WITH CHECK correct     -> ERROR 23505 tenants_pkey
 *   tenants_self_update USING (true) WITH CHECK (true)       -> ERROR 23505 tenants_pkey
 *
 * The POLICY IS EVALUATED FIRST and is exactly what prevents the collision: the USING
 * clause admits only the actor's own row, so the assignment is an IDENTITY UPDATE and the
 * index is never contended. Widen the USING and the statement sweeps both rows onto one
 * id, and only then does the index refuse it. So the shape distinguishes the two cases
 * cleanly, in both directions — which is why the decline was withdrawn and `tenants`
 * carries `reparentAll` like every other table.
 *
 * THIS TABLE IS THE FAILING HALF OF THAT MEASUREMENT, AS PERMANENT DDL. `id` is both the
 * primary key and the owner column, the UPDATE policy's USING is widened and its WITH
 * CHECK left correct — `isolation_owner_theft_canary`'s defect on `tenants`'s shape. The
 * passing half runs on every CI run too: it is `tenants` itself, in the main battery.
 *
 * WHAT IT SCORES, AND THE HONEST NARROWNESS OF IT. `reparentAll` here is refused with
 * 23505, which `classifyRefusal()` scores `unrecognised` — so the attempt is UNVERIFIED
 * and names the surface, rather than FAIL naming a victim. That is a red run and a named
 * surface, which is strictly more than the decline gave this shape, and it is less than
 * `reparentAll` gives a table whose owner column is not its primary key.
 *
 * NO FOREIGN KEY TO `tenants`, deliberately: `insertOwnedBy` plants a tenant id that is
 * never seeded, and a foreign key would refuse it with 23503 before the policy could,
 * which is the very confusion this control exists to disprove.
 */
export function createPkOwnerCanary(): void {
  run(
    `DROP TABLE IF EXISTS ${PK_OWNER_CANARY_TABLE};

     CREATE TABLE ${PK_OWNER_CANARY_TABLE} (
       id    uuid PRIMARY KEY,
       label text NOT NULL
     );

     ${grantAll(PK_OWNER_CANARY_TABLE)}

     INSERT INTO ${PK_OWNER_CANARY_TABLE} (id, label) VALUES
       ('${TENANT_A}', '${CONTROL_A_LABEL}'),
       ('${TENANT_B}', '${CONTROL_B_LABEL}');

     ALTER TABLE ${PK_OWNER_CANARY_TABLE} ENABLE ROW LEVEL SECURITY;
     ALTER TABLE ${PK_OWNER_CANARY_TABLE} FORCE  ROW LEVEL SECURITY;

     CREATE POLICY ${PK_OWNER_CANARY_TABLE}_select ON ${PK_OWNER_CANARY_TABLE}
       FOR SELECT USING (id = ${TENANT_ID});
     CREATE POLICY ${PK_OWNER_CANARY_TABLE}_insert ON ${PK_OWNER_CANARY_TABLE}
       FOR INSERT WITH CHECK (id = ${TENANT_ID});
     CREATE POLICY ${PK_OWNER_CANARY_TABLE}_delete ON ${PK_OWNER_CANARY_TABLE}
       FOR DELETE USING (id = ${TENANT_ID});
     -- THE DEFECT, on the cascade root's shape: USING widened, WITH CHECK left correct.
     CREATE POLICY ${PK_OWNER_CANARY_TABLE}_update ON ${PK_OWNER_CANARY_TABLE}
       FOR UPDATE USING (true) WITH CHECK (id = ${TENANT_ID});`,
  );
}

/**
 * =========================================================================
 * F-344. THE POSITIVE CONTROL: A WITH CHECK STRICTER THAN ITS USING, AND NOTHING WRONG.
 * =========================================================================
 *
 * NOT A LEAK. This table is CORRECTLY ISOLATED — one `FOR ALL` policy whose USING is the
 * production predicate — and it carries one ordinary business predicate beyond tenancy in
 * its WITH CHECK. Soft-delete guards, immutability-on-archive and plan-limit checks all
 * produce exactly this shape, and both seeded rows are `status = 'locked'` so the clause
 * bites on the ACTOR'S OWN ROW in both directions.
 *
 * WHY IT IS HERE. r3's rule — an unqualified write refused by row-level security is
 * `unverified` rather than `pass` (F-330) — fires on this table, measured: tenant A sees
 * exactly its own row, and `update <t> set label = '...'` is refused with
 * `new row violates row-level security policy` because the resulting row is still locked.
 * The run went permanently red on a table with nothing wrong with it, and the message's
 * own suggested remedy — re-issue as `reparentAll` — was refused identically, because
 * setting `tenant_id` leaves `status` untouched. A check that goes red on correct code is
 * the check that gets deleted rather than fixed.
 *
 * THE ESCAPE IS THE STATEMENT, NOT A DECLARATION (F-342's lesson). The registration says
 * which columns the WITH CHECK requires and the unqualified writes assign them too, so the
 * statement is ADMITTED and judged on its row count — which is the judgement that sees a
 * wide-open USING. Nothing about `refusalProvesDenial` is softened: a refusal on an
 * unqualified write is still never a pass. What changed is that a correct table can now
 * produce a statement that is not refused.
 *
 * SO A GREEN RUN OVER THIS TABLE MEANS: all sixteen attempts passed, and the two
 * unqualified updates were ADMITTED and reported exactly one row each — the actor's own.
 * Deleting `unqualifiedWritesAlsoSet` from its registration turns those four attempts
 * `unverified` and the suite red, which is the mutation this control exists to fail on.
 */
export function createGuardedCheckCanary(): void {
  run(
    `${createTable(GUARDED_CHECK_CANARY_TABLE, `,
       status text NOT NULL DEFAULT 'active'`)}

     ${grantAll(GUARDED_CHECK_CANARY_TABLE)}

     -- BOTH rows locked: the WITH CHECK must bite on the acting tenant's OWN row, in
     -- both directions, or the control is only about the other tenant's rows.
     INSERT INTO ${GUARDED_CHECK_CANARY_TABLE} (id, tenant_id, label, status) VALUES
       ('${CONTROL_A_ROW_ID}', '${TENANT_A}', '${CONTROL_A_LABEL}', 'locked'),
       ('${CONTROL_B_ROW_ID}', '${TENANT_B}', '${CONTROL_B_LABEL}', 'locked');

     ALTER TABLE ${GUARDED_CHECK_CANARY_TABLE} ENABLE ROW LEVEL SECURITY;
     ALTER TABLE ${GUARDED_CHECK_CANARY_TABLE} FORCE  ROW LEVEL SECURITY;

     -- CORRECT ISOLATION, plus one ordinary business predicate. The USING clause is
     -- exactly what tenantScopedPolicies() emits.
     CREATE POLICY ${GUARDED_CHECK_CANARY_TABLE}_tenant_isolation ON ${GUARDED_CHECK_CANARY_TABLE}
       FOR ALL USING (tenant_id = ${TENANT_ID})
               WITH CHECK (tenant_id = ${TENANT_ID} AND status <> 'locked');`,
  );
}

/**
 * =========================================================================
 * F-352. THE GUARDED TABLE THAT REALLY IS LEAKING — `isolation_guarded_check_canary`'s
 * TWIN, WITH THE USING CLAUSE WIDENED.
 * =========================================================================
 *
 * F-344 gave a registration a way to satisfy a WITH CHECK stricter than its USING, so a
 * correctly isolated table could produce an unqualified write that is ADMITTED rather
 * than refused. The escape was a free `SQL` fragment, and the field's own comment claimed
 * it "cannot hide a leak: the statement still carries no WHERE clause, so it still sweeps
 * every row the USING clause admits". THAT CLAIM IS FALSE. The WHERE clause is not what
 * keeps the SELECT policies out of an UPDATE — A COLUMN REFERENCE ANYWHERE IN THE
 * STATEMENT PULLS THEM BACK IN, which is the rule `test/support/rls-fixture.ts:175-188`
 * measured and F-302's whole finding rests on. A SET expression is part of the statement.
 *
 * THIS TABLE IS WHERE THAT COSTS SOMETHING. Its SELECT, INSERT and DELETE policies are
 * correct; its UPDATE policy's USING is wide open and its WITH CHECK asks for an
 * optimistic lock rather than for tenancy — `lock_token <> ''` — with both rows seeded
 * unlocked. Measured, as `shortkit_app` in an ordinary tenant-A transaction, 2026-08-11:
 *
 *   set label = <const>                              -> 42501, new row violates RLS
 *   set label = <const>, lock_token = lock_token||'x'-> UPDATE 1   <- SILENT. NO LEAK SEEN
 *   set label = <const>, lock_token = 'held'         -> UPDATE 2   <- THE LEAK
 *   set label = <const>, lock_token = 'lock_token'   -> UPDATE 2   <- still the leak
 *   set tenant_id = <A>                              -> 42501, new row violates RLS
 *   set tenant_id = <A>,  lock_token = lock_token||'x'-> UPDATE 1  <- SILENT
 *   set tenant_id = <A>,  lock_token = 'held'        -> UPDATE 2   <- THE LEAK
 *
 * Row 1 is why the registration MUST name the column: without it both unqualified writes
 * are refused and score `unverified`. Row 2 is F-352: `lock_token = lock_token || 'x'` is
 * the ordinary optimistic-lock idiom, it satisfies the check, and it disarms BOTH
 * unqualified writes at once — the run goes green over a table whose UPDATE policy admits
 * every row of every tenant. Row 3 is the same statement with the value BOUND instead of
 * derived, and it is the one the harness can now express.
 *
 * The fourth row is the falsification attempt kept as a control: `'lock_token'` is the
 * closest a caller can get to a column reference under `{ column, value }`, and it is a
 * parameter — `"lock_token" = $2` — so the leak is still reported. If the builder ever
 * inlines the value instead of binding it, that row becomes UPDATE 1 and the adversarial
 * control goes red.
 *
 * The WITH CHECK deliberately says NOTHING about tenancy. With `tenant_id = ctx` in it
 * this would be `isolation_owner_theft_canary` and the writes would be refused on the
 * first foreign row; the point here is a check that is satisfied while the USING leaks.
 */
export function createGuardedLeakCanary(): void {
  run(
    `${createTable(GUARDED_LEAK_CANARY_TABLE, `,
       lock_token text NOT NULL DEFAULT ''`)}

     ${grantAll(GUARDED_LEAK_CANARY_TABLE)}

     -- BOTH rows unlocked, so the WITH CHECK bites on the acting tenant's OWN row in
     -- both directions and the registration cannot avoid naming the column.
     ${seedBothTenants(GUARDED_LEAK_CANARY_TABLE)}

     ALTER TABLE ${GUARDED_LEAK_CANARY_TABLE} ENABLE ROW LEVEL SECURITY;
     ALTER TABLE ${GUARDED_LEAK_CANARY_TABLE} FORCE  ROW LEVEL SECURITY;

     CREATE POLICY ${GUARDED_LEAK_CANARY_TABLE}_select ON ${GUARDED_LEAK_CANARY_TABLE}
       FOR SELECT USING (tenant_id = ${TENANT_ID});
     CREATE POLICY ${GUARDED_LEAK_CANARY_TABLE}_insert ON ${GUARDED_LEAK_CANARY_TABLE}
       FOR INSERT WITH CHECK (tenant_id = ${TENANT_ID});
     CREATE POLICY ${GUARDED_LEAK_CANARY_TABLE}_delete ON ${GUARDED_LEAK_CANARY_TABLE}
       FOR DELETE USING (tenant_id = ${TENANT_ID});
     -- THE DEFECT: USING wide open, and a WITH CHECK that guards the lock rather than
     -- the tenant — so it is satisfiable by any tenant, on any row.
     CREATE POLICY ${GUARDED_LEAK_CANARY_TABLE}_update ON ${GUARDED_LEAK_CANARY_TABLE}
       FOR UPDATE USING (true) WITH CHECK (lock_token <> '');`,
  );
}

/**
 * =========================================================================
 * F-133. THE TOKEN-MINT ESCAPE'S POLICY, IN THREE SHAPES — AND THE ONLY CONTROL IN THIS
 * FILE FOR A POLICY THE CROSS-TENANT BATTERY CANNOT REACH AT ALL.
 * =========================================================================
 *
 * `tenant_memberships_membership_lookup` (ADR-0045) is the one policy in the system that
 * reads a tenant-scoped table with NO tenant context. Every attempt in this harness runs
 * through `withTenantTransaction`, which sets `app.tenant_id` and never
 * `app.membership_lookup_user`, so the battery cannot see that policy widen — and
 * `db:check-policies` counts `nullif` wrappers and cannot see WHICH COLUMN a predicate
 * compares against, as its own docblock says. The only control over it is control 2 in
 * `test/auth/tenant-memberships.int-spec.ts`, and until 2026-08-14 that control ran
 * against a fixture holding ONE membership row, so "returns that user AND NOT TENANT B's"
 * had no other tenant's row to exclude.
 *
 * MEASURED that day, on the migrated production table, with the lookup policy replaced by
 *
 *   USING (nullif(current_setting('app.membership_lookup_user', true), '') IS NOT NULL)
 *
 * — every membership row of every tenant, to anybody who sets the flag — that whole file
 * reported **6 passed, exit 0**. `USING (true)` was caught, by the no-flag control and by
 * the AC-2 counts; the flag-gated shape above was caught by nothing at all.
 *
 * THE THREE TABLES. Identical but for the lookup policy, each seeded with one membership
 * row for tenant A and one for tenant B:
 *
 *   isolation_membership_lookup_canary             the production predicate, READ OUT OF
 *                                                  `membershipLookupPolicy()`. The control
 *                                                  must come back GREEN over this one.
 *   isolation_membership_lookup_wide_open_canary   `USING (true)`.
 *   isolation_membership_lookup_flag_gated_canary  gated on the flag and blind to
 *                                                  `user_id` — the shape nothing saw.
 *
 * The two widened predicates are HAND-WRITTEN, because a defect must not track the
 * production builder; the correct one is EXTRACTED, for the reason `TENANT_ID` above is,
 * so a change to the shipped predicate flows through here or stops the suite. A stale flag
 * name in the hand-written pair is loud rather than silent: the flag-gated table would
 * then admit nothing and the control's expected two rows would fail.
 *
 * GRANT SELECT AND NOTHING ELSE, because the escape is `FOR SELECT` and stays `FOR SELECT`
 * (ADR-0045, invariant 2). Rows are seeded BEFORE the policies are applied, so the seed
 * never depends on the clause under test — `rls-fixture.ts`'s rule 2.
 */
const LOOKUP_USING = /^\s*USING \((.+)\);$/m;

function productionMembershipLookupPredicate(): string {
  const [statement] = membershipLookupPolicy().statements;
  const matched = statement === undefined ? null : LOOKUP_USING.exec(statement);

  if (matched === null) {
    throw new Error(
      'could not read the lookup predicate out of membershipLookupPolicy(): ' +
        `${statement ?? 'it emitted no statement at all'}. The F-133 control builds its ` +
        'correct twin from that expression, so a shape this cannot parse would leave the ' +
        'control asserting over a predicate the product no longer uses. Update the regex.',
    );
  }

  return matched[1];
}

/** Better Auth generates its own ids and they are not uuids (auth-schema.md). */
export const MEMBERSHIP_LOOKUP_CANARY_USER_A = 'lookupCanaryUserA';
export const MEMBERSHIP_LOOKUP_CANARY_USER_B = 'lookupCanaryUserB';

function membershipLookupCanary(table: string, lookupUsing: string): string {
  return `DROP TABLE IF EXISTS ${table};

     CREATE TABLE ${table} (
       id      uuid PRIMARY KEY,
       ${TENANT_ID_COLUMN_SQL},
       user_id text NOT NULL,
       CONSTRAINT ${table}_user_unique UNIQUE (user_id)
     );

     GRANT SELECT ON ${table} TO :"app_role";

     INSERT INTO ${table} (id, tenant_id, user_id) VALUES
       ('${CONTROL_A_ROW_ID}', '${TENANT_A}', '${MEMBERSHIP_LOOKUP_CANARY_USER_A}'),
       ('${CONTROL_B_ROW_ID}', '${TENANT_B}', '${MEMBERSHIP_LOOKUP_CANARY_USER_B}');

     ${tenantScopedPolicies(table).statements.join('\n     ')}

     CREATE POLICY ${table}_membership_lookup ON ${table}
       FOR SELECT USING (${lookupUsing});`;
}

export function createMembershipLookupCanaries(): void {
  run(
    [
      membershipLookupCanary(
        MEMBERSHIP_LOOKUP_CANARY_TABLE,
        productionMembershipLookupPredicate(),
      ),
      membershipLookupCanary(MEMBERSHIP_LOOKUP_WIDE_OPEN_CANARY_TABLE, 'true'),
      membershipLookupCanary(
        MEMBERSHIP_LOOKUP_FLAG_GATED_CANARY_TABLE,
        "nullif(current_setting('app.membership_lookup_user', true), '') IS NOT NULL",
      ),
    ].join('\n\n     '),
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

/**
 * =========================================================================
 * AC-31. THE ENDPOINT-LEVEL NEGATIVE CONTROL (TASK-015).
 * =========================================================================
 *
 * The table controls above each prove the harness would catch a leaking TABLE. This proves
 * it would catch a leaking AUTHENTICATED ENDPOINT — the exact defect
 * `scripts/check-policies.mts` exists to catch, reached over HTTP: a table shaped like
 * `workspaces` with `ENABLE ROW LEVEL SECURITY` OMITTED, read and written through a control
 * endpoint that trusts row-level security to scope it and issues no `tenant_id` predicate of
 * its own. Every attempt over it must report `fail`; a harness that could not see an endpoint
 * leak would report that endpoint clean.
 *
 * IT IS REACHED THROUGH THE REAL GUARD AND INTERCEPTOR. The control controller below runs
 * inside an in-process Nest app the spec builds from `AppModule` plus `EndpointControlModule`
 * (the shape `test/auth/auth-guard.int-spec.ts` uses), pointed at the child's JWKS. So the
 * request passes the real `AuthGuard`, opens the real tenant transaction, and reads the
 * control table through `tenantDb()` — everything a shipped route does except the missing
 * row-level security.
 *
 * NOT REGISTERED. Like every control, `endpointControlGroup()` is a value the spec passes to
 * `runCrossTenantAttempts()`/`runAttemptGroups()` directly, never `registerTenantScopedSurfaces()`:
 * the registry has no notion of a subject allowed to leak (F-346), and the endpoint control
 * follows the same rule.
 *
 * WHY THE CREATE ATTACK LOOKS DIFFERENT. A create that writes under the caller's own tenant
 * cannot cross a boundary whatever the policies, so a missing-RLS defect could never make it
 * leak — the SHIPPED `POST /api/workspaces` is exactly that, and its endpoint attempt passes.
 * The control's create is therefore the analogue of `insertOwnedBy`: it PLANTS a row under a
 * tenant named in the body, which the isolation policy's `WITH CHECK` would refuse and which,
 * with row-level security omitted, succeeds. That is the create defect the harness must catch.
 */
export const ENDPOINT_CONTROL_CANARY_TABLE = 'isolation_endpoint_control_canary';

const ENDPOINT_CONTROL_ROW_A = 'ec010101-ec01-4ec0-8ec0-ec01ec01ec01';
const ENDPOINT_CONTROL_ROW_B = 'ec020202-ec02-4ec0-8ec0-ec02ec02ec02';
const ENDPOINT_CONTROL_NAME = 'endpoint-control-seeded-row';

/** The control table: workspaces-shaped, and DELIBERATELY without ENABLE ROW LEVEL SECURITY. */
export function createEndpointControlCanary(): void {
  run(
    `DROP TABLE IF EXISTS ${ENDPOINT_CONTROL_CANARY_TABLE};

     CREATE TABLE ${ENDPOINT_CONTROL_CANARY_TABLE} (
       id          uuid PRIMARY KEY,
       ${TENANT_ID_COLUMN_SQL},
       name        text NOT NULL,
       archived_at timestamptz
     );

     ${grantAll(ENDPOINT_CONTROL_CANARY_TABLE)}`,
    // NO ALTER TABLE ... ENABLE ROW LEVEL SECURITY. That omission is the whole artifact,
    // spelled by absence rather than by deleting a line, so nobody repairs it by adding one.
  );
}

/** Seeds one control row per signed-in tenant. No RLS, so a plain insert as the migrator serves. */
export function resetEndpointControlCanary(runtime: SignedInTenants): void {
  execSql(
    migrationDsn(),
    `DELETE FROM ${ENDPOINT_CONTROL_CANARY_TABLE};
     INSERT INTO ${ENDPOINT_CONTROL_CANARY_TABLE} (id, tenant_id, name) VALUES
       (:'row_a'::uuid, :'ta'::uuid, :'name'),
       (:'row_b'::uuid, :'tb'::uuid, :'name');`,
    {
      variables: {
        row_a: ENDPOINT_CONTROL_ROW_A,
        row_b: ENDPOINT_CONTROL_ROW_B,
        ta: runtime.a.tenantId,
        tb: runtime.b.tenantId,
        name: ENDPOINT_CONTROL_NAME,
      },
    },
  );
}

const CONTROL_TABLE = sql.identifier(ENDPOINT_CONTROL_CANARY_TABLE);

/**
 * The control route surface. It reads and writes the control table through `tenantDb()` and
 * TRUSTS row-level security to scope it — it issues no `tenant_id` predicate of its own, the
 * shape a route takes when its author assumes the table is protected. With RLS omitted, every
 * one of these crosses the boundary.
 */
@Controller('control')
export class EndpointControlController {
  @Get()
  async list(): Promise<{ items: Record<string, unknown>[] }> {
    const { rows } = await tenantDb().execute<Record<string, unknown>>(
      sql`select id, tenant_id, name from ${CONTROL_TABLE} order by id`,
    );

    return { items: [...rows] };
  }

  @Post()
  async create(
    @Body() body: { name?: string; tenantId?: string },
  ): Promise<Record<string, unknown>> {
    // The `insertOwnedBy` analogue: the caller may name the owning tenant, which the WITH
    // CHECK would refuse and which, with RLS omitted, plants a foreign-owned row.
    const owner = body.tenantId ?? currentTenantId();
    const { rows } = await tenantDb().execute<Record<string, unknown>>(
      sql`insert into ${CONTROL_TABLE} (id, tenant_id, name)
          values (gen_random_uuid(), ${owner}::uuid, ${body.name ?? 'planted'})
          returning id, tenant_id, name`,
    );

    return rows[0];
  }

  @Patch(':id')
  async rename(
    @Param('id') id: string,
    @Body() body: { name?: string },
  ): Promise<Record<string, unknown>> {
    const { rows } = await tenantDb().execute<Record<string, unknown>>(
      sql`update ${CONTROL_TABLE} set name = ${body.name ?? 'renamed'}
           where id = ${id}::uuid returning id, tenant_id, name`,
    );

    if (rows.length === 0) {
      throw new NotFoundException();
    }

    return rows[0];
  }

  @Post(':id/archive')
  async archive(@Param('id') id: string): Promise<Record<string, unknown>> {
    const { rows } = await tenantDb().execute<Record<string, unknown>>(
      sql`update ${CONTROL_TABLE} set archived_at = now()
           where id = ${id}::uuid returning id, tenant_id, name`,
    );

    if (rows.length === 0) {
      throw new NotFoundException();
    }

    return rows[0];
  }
}

@Module({ controllers: [EndpointControlController] })
export class EndpointControlModule {}

/** The four control-endpoint attempts, mirroring the workspace routes shape for shape. */
const ENDPOINT_CONTROL_ROUTES: readonly EndpointAttemptSpec[] = [
  {
    name: 'create',
    method: 'POST',
    route: '/control',
    httpKind: 'write',
    reaches: 'new-row',
    qualification: 'owner-qualified',
    buildRequest: (_actor, target) => ({
      path: '/control',
      body: { name: 'planted-by-another-tenant', tenantId: target.id },
    }),
    expectedRefusal: { kind: 'created-under-actor' },
  },
  {
    name: 'list',
    method: 'GET',
    route: '/control',
    httpKind: 'read',
    reaches: 'existing-row',
    qualification: 'owner-qualified',
    buildRequest: () => ({ path: '/control' }),
    expectedRefusal: { kind: 'absent-from-list' },
  },
  {
    name: 'rename',
    method: 'PATCH',
    route: '/control/:id',
    httpKind: 'write',
    reaches: 'existing-row',
    qualification: 'owner-qualified',
    buildRequest: (_actor, target, ctx) => ({
      path: `/control/${ctx.seededRowId(target.id)}`,
      body: { name: 'renamed-by-another-tenant' },
    }),
    expectedRefusal: { kind: 'status', status: 404 },
  },
  {
    name: 'archive',
    method: 'POST',
    route: '/control/:id/archive',
    httpKind: 'write',
    reaches: 'existing-row',
    qualification: 'owner-qualified',
    buildRequest: (_actor, target, ctx) => ({
      path: `/control/${ctx.seededRowId(target.id)}/archive`,
    }),
    expectedRefusal: { kind: 'status', status: 404 },
  },
];

/**
 * The endpoint control as an attempt group: the in-process control app is `baseUrl`, tokens
 * are minted fresh from the child (`runtime.server`) so they cannot expire, and the fixtures
 * are the two signed-in tenants. Every attempt must report `fail`.
 */
export function endpointControlGroup(runtime: SignedInTenants, baseUrl: string): AttemptGroup {
  const tokenFor = async (tenantId: string): Promise<string> => {
    const tenant = tenantId === runtime.a.tenantId ? runtime.a : runtime.b;
    const minted = await mintTokenFromChild(runtime, tenant.cookie);

    return minted;
  };

  const seededRowId = (tenantId: string): string =>
    tenantId === runtime.a.tenantId ? ENDPOINT_CONTROL_ROW_A : ENDPOINT_CONTROL_ROW_B;

  const registration = endpointAccess({
    subject: 'EndpointControl',
    table: ENDPOINT_CONTROL_CANARY_TABLE,
    ownerColumn: 'tenant_id',
    reset: () => resetEndpointControlCanary(runtime),
    baseUrl,
    tokenFor,
    seededRowId,
    endpoints: ENDPOINT_CONTROL_ROUTES,
  });

  return {
    registrations: [registration],
    fixtures: {
      tenantA: { id: runtime.a.tenantId, name: 'signed-in-tenant-a' },
      tenantB: { id: runtime.b.tenantId, name: 'signed-in-tenant-b' },
    },
  };
}

async function mintTokenFromChild(runtime: SignedInTenants, cookie: string): Promise<string> {
  const minted = await mintToken(runtime.server, cookie);
  const token = (minted.body as { token?: unknown }).token;

  if (minted.status !== 200 || typeof token !== 'string') {
    throw new Error(`control-endpoint token mint answered ${String(minted.status)}: ${minted.raw}`);
  }

  return token;
}

export function dropEndpointControlCanary(): void {
  execSql(migrationDsn(), `DROP TABLE IF EXISTS ${ENDPOINT_CONTROL_CANARY_TABLE};`);
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
      PK_OWNER_CANARY_TABLE,
      GUARDED_CHECK_CANARY_TABLE,
      GUARDED_LEAK_CANARY_TABLE,
      MEMBERSHIP_LOOKUP_CANARY_TABLE,
      MEMBERSHIP_LOOKUP_WIDE_OPEN_CANARY_TABLE,
      MEMBERSHIP_LOOKUP_FLAG_GATED_CANARY_TABLE,
      ENDPOINT_CONTROL_CANARY_TABLE,
      UNREGISTERED_TABLE_PROBE,
      ...OWNER_COLUMN_PROBE_PROTECTIONS.map(ownerColumnProbeTable),
    ]
      .map((table) => `DROP TABLE IF EXISTS ${table};`)
      .join('\n'),
  );
}
