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
 * for `tenants` exists anywhere in `apps/api/src` (the one repository that does,
 * `WorkspaceRepository`, carries `@TenantScopedRepository()` — real since TASK-006 — and is
 * registered below). Naming one would put a surface id in `report.json` that
 * points at nothing, and `ISOLATION_EXCLUSIONS` is keyed on exactly these strings.
 *
 * The access objects are thin on purpose. Each method issues ONE statement through
 * `withTenantTransaction` — the same production path a repository will use, against the
 * same policies — so what an attempt exercises is Postgres's row-level security, not
 * this file. When `LinkRepository` arrives it registers its own methods and the harness
 * does not notice the difference.
 *
 * SINCE TASK-011 ONE REAL REPOSITORY IS REGISTERED BESIDE THEM. `workspaces` carries two
 * subjects on one table — the shipped F-353 pattern: `WorkspacesTableAccess` is the
 * eight-shape statement battery every table gets, and `WorkspaceRepository` names the
 * class in `src/workspaces/workspace.repository.ts` and attempts ITS FIVE METHODS, so
 * `repo:WorkspaceRepository.rename` in `report.json` points at a method that exists.
 *
 * SINCE TASK-1b-03 THREE MORE TABLES ARE REGISTERED AS BATTERIES: `memberships`,
 * `invitations` and `invitation_workspaces` (migration 0003, ADR-0062), each the eight
 * shapes — AND SINCE TASK-1b-10 TWO OF THEM CARRY THEIR REPOSITORY BESIDE THE BATTERY:
 * `InvitationRepository` (create, listForWorkspace, findById, revoke) on `invitations` and
 * `MembershipRepository` (roleFor, workspaceIdsFor, create, listForWorkspace) on
 * `memberships`, the same F-353 two-subjects-one-table pattern `workspaces` shipped.
 * `invitation_workspaces` has no repository class of its own — its rows are written and
 * read only through `InvitationRepository` and the capability-lookup functions — so it
 * stays a battery. The endpoint half gained a second group, the five invitation routes,
 * documented at `INVITATION_ENDPOINTS` below.
 */
import { sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { WORKSPACE_ROLE } from '@shortkit/contracts';

import { InvitationNotFoundError } from '../../src/invitations/errors';
import { InvitationRepository } from '../../src/invitations/invitation.repository';
import { issueCapabilityToken } from '../../src/invitations/tokens/capability-token';
import { MembershipRepository } from '../../src/memberships/membership.repository';
import { withTenantTransaction } from '../../src/tenancy/tenant-context';
import { WorkspaceNotFoundError } from '../../src/workspaces/workspace-not-found.error';
import { WorkspaceRepository } from '../../src/workspaces/workspace.repository';
import {
  createRlsFixture,
  migrationDsn,
  RLS_FIXTURE_TABLE,
  TENANT_A,
  TENANT_B,
  TENANT_C_NEVER_SEEDED,
} from '../support/rls-fixture';
import { execSql, querySql } from '../support/psql';
import { mintToken } from '../support/auth-fixture';

import type {
  AttemptGroup,
  CrossTenantAttemptResult,
  TenantFixture,
  TenantScopedMethod,
  TenantScopedSurfaceRegistration,
} from './coverage';
import { registerTenantScopedSurfaces } from './coverage';
import { endpointAccess } from './http-attempts';
import type { EndpointAttemptSpec, SignedInTenant, SignedInTenants } from './http-attempts';
import {
  BASELINE_LEAK_CANARY_TABLE,
  createBaselineLeakCanary,
  createDirectionCanary,
  createGrantGapCanary,
  createHalfSeededCanary,
  createGuardedCheckCanary,
  createMaskedRefusalCanary,
  createOwnerTheftCanary,
  createPkOwnerCanary,
  createGuardedLeakCanary,
  createUnqualifiedWriteCanary,
  DIRECTION_CANARY_TABLE,
  GRANT_GAP_CANARY_TABLE,
  GUARDED_CHECK_CANARY_TABLE,
  GUARDED_LEAK_CANARY_TABLE,
  HALF_SEEDED_CANARY_TABLE,
  MASKED_REFUSAL_CANARY_TABLE,
  OWNER_THEFT_CANARY_TABLE,
  PK_OWNER_CANARY_TABLE,
  UNQUALIFIED_WRITE_CANARY_TABLE,
} from './controls';
import { createLeakCanary, LEAK_CANARY_TABLE } from './leak-canary';

/**
 * The EIGHT statement shapes every tenant-scoped table is attacked with — every table,
 * with no exceptions since r4 withdrew the one decline (F-342). They are the rows of
 * isolation-coverage.md's "Attempt semantics" table, made concrete:
 *
 *   findAll          unfiltered read           -> must return none of the target's rows
 *   findOwnedBy      read filtered to target   -> must return zero rows
 *   updateOwnedBy    write over target's rows  -> rejected, or zero rows affected
 *   deleteOwnedBy    write over target's rows  -> rejected, or zero rows affected
 *   insertOwnedBy    write planting a new row  -> rejected, or zero rows affected
 *   updateAll        write with NO WHERE       -> at most the actor's own rows affected
 *   deleteAll        write with NO WHERE       -> at most the actor's own rows affected
 *   reparentAll      write with NO WHERE, assigning the OWNER COLUMN
 *                                              -> at most the actor's own rows affected
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
 *    supplies both shapes; a hand-written registration owes them itself. Since r4 the
 *    declaration is CHECKED AGAINST THE SQL at registration time and a disagreement
 *    throws (F-345) — the label was the one thing three rounds of judgement rested on
 *    that no mechanism verified.
 *
 * 5. NO SHAPE MAY BE DECLINED (F-342). A table whose WITH CHECK asks for more than
 *    tenancy names the columns it asks for in `unqualifiedWritesAlsoSet`, so the two
 *    unqualified updates are ADMITTED rather than refused (F-344); a table that cannot
 *    answer at all comes back `unverified` and fails the run. What is not available is
 *    declaring a shape inapplicable: r3 had that mechanism, its only use rested on a
 *    premise that measured false, and the artifact published the premise as a fact.
 */
interface TableAccessSpec {
  readonly table: string;
  readonly ownerColumn: string;
  /** Columns to project on a read. MUST include the owner column, or the harness refuses to judge. */
  readonly projection: string[];
  /** A non-owner column the update attempt tries to overwrite. */
  readonly mutableColumn: string;
  /**
   * ==========================================================================
   * WHAT THE TWO UPDATE SHAPES ASSIGN TO `mutableColumn`. Added for
   * `tenant_memberships` (tenant-membership-lookup.md, TASK-002).
   * ==========================================================================
   *
   * Absent, each shape keeps its own literal, and the two stay DIFFERENT for the reason
   * `updateAll` records below: `isolation_masked_refusal_canary` carries a CHECK
   * constraint rejecting `overwritten-by-another-tenant` specifically, and a control
   * that refused the unqualified write with 23514 would hide the leak it exists to
   * expose. Every table whose mutable column is free text leaves this unset.
   *
   * `tenant_memberships` HAS NO FREE-TEXT COLUMN. `user_id` is UNIQUE and a foreign key
   * and `role` is an enum, so a string literal assigned to either fails with a
   * constraint or enum error rather than a policy refusal — and the harness scores that
   * `unverified`, which is a red run over a table with nothing wrong with it. So the
   * registration supplies a valid `tenant_role` instead, different from the one its
   * fixture rows carry, and BOTH shapes use it: there is no CHECK constraint on this
   * table for the two literals to have to differ against.
   *
   * A value and not a fragment, for F-352's reason — everything the `sql` tag
   * interpolates that is not a fragment is bound as `$N`, so nothing spellable here can
   * reach an existing column and quietly disarm both unqualified writes.
   */
  readonly mutableValue?: string | number | boolean;
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
   * ==========================================================================
   * F-344. THE COLUMNS THIS TABLE'S `WITH CHECK` REQUIRES, ASSIGNED BY THE TWO
   * UNQUALIFIED UPDATES SO THEY ARE ADMITTED RATHER THAN REFUSED.
   * ==========================================================================
   *
   * A WITH CHECK stricter than its USING is an ordinary, CORRECT policy shape — a
   * soft-delete guard, an immutability-on-archive predicate, a plan limit. On such a
   * table `update <t> set <mutable> = <constant>` is refused by the check even though the
   * USING clause admitted only the actor's own row, and r3's rule scores that refusal
   * `unverified`: a red run, permanently, on a table with nothing wrong with it.
   * Measured on `isolation_guarded_check_canary`, and `reparentAll` — the remedy the
   * message used to offer — is refused identically.
   *
   * It is deliberately NOT applied to the owner-qualified writes: those name the target
   * in a WHERE clause, PostgreSQL routes them through the SELECT policy, and a refusal on
   * one of them is already complete evidence (F-302, F-330).
   *
   * ==========================================================================
   * F-352, r5. WHY IT IS A COLUMN AND A VALUE RATHER THAN A FRAGMENT, AND WHY THE
   * PREVIOUS VERSION OF THIS PARAGRAPH WAS FALSE.
   * ==========================================================================
   *
   * r4 took a free `SQL` fragment here and claimed it "cannot hide a leak: the statement
   * still carries no WHERE clause, so it still sweeps every row the USING clause admits".
   * THE WHERE CLAUSE IS NOT WHAT KEEPS THE SELECT POLICIES OUT. A COLUMN REFERENCE
   * ANYWHERE IN THE STATEMENT PULLS THEM BACK IN — the rule
   * `test/support/rls-fixture.ts:175-188` measured, that F-302's entire finding rests on,
   * and that `isolation-coverage.md:569` already states normatively — and a SET expression
   * is part of the statement. Measured on the F-302 canary shape, tenant A, 2026-08-11:
   *
   *   set label = <const>                     -> UPDATE 2   the leak; 2 > 1 fires
   *   set label = <const>, status = status    -> UPDATE 1   SILENT; the digest sees nothing
   *   set tenant_id = <A>                     -> UPDATE 2
   *   set tenant_id = <A>, status = status    -> UPDATE 1   SILENT
   *
   * One column reference in the fragment disarms BOTH unqualified writes at once, and
   * `version = version + 1` — an optimistic-lock guard, the idiomatic thing to write here
   * — is exactly that shape. `isolation_guarded_leak_canary` is the cost measured end to
   * end: a table whose UPDATE policy admits every row of every tenant, reported entirely
   * `pass` under such a registration.
   *
   * SO THE FIX IS THE TYPE AND NOT A CHECK. A column and a VALUE. The value is bound —
   * `sql` renders it as `$N` — so the assignment reads `"status" = $2` whatever the value
   * is, and there is no way to spell a column reference in it. This is what F-345 did for
   * the WHERE invariant: the difference is that F-345 could derive the invariant from the
   * compiled SQL and throw, and this one is enforced by the shape being unable to express
   * the mistake at all.
   *
   * `column` passes through `sql.identifier()`, which quotes it and doubles any embedded
   * quote — verified against drizzle-orm@0.45.2: `identifier('x" = version, "label')`
   * compiles to `"x"" = version, ""label"`, one identifier — so the column name cannot
   * carry an expression either.
   */
  readonly unqualifiedWritesAlsoSet?: readonly RequiredAssignment[];
}

/**
 * F-352. ONE COLUMN, AND A VALUE THAT IS A VALUE. `value` is deliberately not `SQL` and
 * not a template: everything drizzle's `sql` tag interpolates that is not a fragment
 * becomes a bound parameter, so a caller cannot reach a column from here.
 */
export interface RequiredAssignment {
  readonly column: string;
  readonly value: string | number | boolean | null;
}

/**
 * F-345. Compiled, never executed: the two fixtures below exist so that every statement a
 * shape can build has concrete arguments at REGISTRATION time, which is what lets the
 * declared `qualification` be checked against the SQL rather than trusted.
 */
const COMPILE_ONLY_ACTOR: TenantFixture = { id: TENANT_A, name: 'compiled, never executed' };
const COMPILE_ONLY_TARGET: TenantFixture = { id: TENANT_B, name: 'compiled, never executed' };

interface StatementShape {
  readonly name: string;
  readonly kind: 'read' | 'write';
  readonly reaches: 'existing-row' | 'new-row';
  readonly qualification: 'owner-qualified' | 'unqualified';
  readonly statement: (actor: TenantFixture, target: TenantFixture) => SQL;
}

/**
 * One statement shape, with its declared `qualification` CHECKED AGAINST THE SQL before
 * the method exists (F-345). The check runs here rather than in `coverage.ts` because
 * this is the layer that owns the SQL; the runner never sees a statement, only a closure.
 */
function shape(spec: StatementShape): TenantScopedMethod {
  assertDeclaredQualification(
    spec.name,
    spec.qualification,
    spec.statement(COMPILE_ONLY_ACTOR, COMPILE_ONLY_TARGET),
  );

  return {
    name: spec.name,
    kind: spec.kind,
    reaches: spec.reaches,
    qualification: spec.qualification,
    attempt: (actor, target) =>
      (spec.kind === 'read' ? reads : writes)(spec.statement(actor, target))(actor),
  };
}

/**
 * ============================================================================
 * F-345. `qualification` IS DERIVED FROM THE STATEMENT, NOT TAKEN ON TRUST.
 * ============================================================================
 *
 * The field drives three separate judgements — the count rule (`affected > 0` versus
 * `affected > actorOwnRowsVisible`), the F-330 refusal rule (`pass` versus `unverified`)
 * and the post-attempt `reset()` — and until now it was a string literal sitting next to
 * the SQL it claimed to describe, with nothing but review between the two. A registration
 * labelling an unqualified statement `owner-qualified` restores F-330's blind spot for
 * that surface: its row-level-security refusal scores a pass again.
 *
 * THE RULE, AND WHY INSERT IS NOT AN EXCEPTION MADE FOR CONVENIENCE. A statement is
 * `owner-qualified` when it names the rows it may touch: an UPDATE or DELETE does that in
 * a WHERE clause, and an INSERT does it in the row it supplies. The distinction the field
 * exists for is which half of a policy a refusal is evidence about, and an INSERT policy
 * HAS NO USING CLAUSE AT ALL — only a WITH CHECK — so a WITH CHECK refusal is complete
 * evidence for that statement, which is exactly what `owner-qualified` means to the
 * runner. An UPDATE or DELETE with no WHERE is the only shape whose refusal leaves the
 * USING clause unproven.
 */
export function qualificationOfStatement(statement: SQL): 'owner-qualified' | 'unqualified' {
  // Compiled by the production dialect rather than pattern-matched over the template's
  // chunks: `sql.identifier()` and every nested fragment are resolved here exactly as
  // they are when the statement runs, and the bound values become `$1`, so no fixture
  // value can spell a keyword into the text.
  const text = new PgDialect().sqlToQuery(statement).sql;

  return /^\s*insert\b/i.test(text) || /\bwhere\b/i.test(text)
    ? 'owner-qualified'
    : 'unqualified';
}

/**
 * F-345. Throws at REGISTRATION TIME — which is import time — when a shape's declared
 * `qualification` disagrees with the SQL it issues.
 */
export function assertDeclaredQualification(
  name: string,
  declared: 'owner-qualified' | 'unqualified',
  statement: SQL,
): void {
  const derived = qualificationOfStatement(statement);

  if (derived !== declared) {
    throw new Error(
      `${name} declares qualification '${declared}' and issues a statement the harness ` +
        `reads as '${derived}': ${new PgDialect().sqlToQuery(statement).sql}. An UPDATE or ` +
        'DELETE with no WHERE clause is unqualified; anything naming the rows it may ' +
        'touch — a WHERE clause, or an INSERT supplying the row — is owner-qualified. ' +
        'The field decides whether a row-level-security refusal on this statement is a ' +
        'pass or `unverified`, so a wrong label restores F-330 for this surface.',
    );
  }
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
  const mutable = sql.identifier(spec.mutableColumn);
  const projection = sql.join(
    spec.projection.map((column) => sql.identifier(column)),
    sql`, `,
  );
  // F-344. Empty for every table whose WITH CHECK asks nothing beyond tenancy, which is
  // every table in this repository today.
  //
  // F-352. Built HERE from a column and a value rather than taken as a fragment. Each
  // value reaches the statement through `sql`'s interpolation, which binds it as `$N`, so
  // the assignment is `"col" = $N` for every value the type admits and the statement
  // references no existing column. That is the whole mechanism: a SET expression reading
  // a column would pull the SELECT policies back in and silently reduce both unqualified
  // writes to the actor's own rows.
  const alsoSets =
    spec.unqualifiedWritesAlsoSet === undefined || spec.unqualifiedWritesAlsoSet.length === 0
      ? sql.empty()
      : sql`, ${sql.join(
          spec.unqualifiedWritesAlsoSet.map(
            (assignment) => sql`${sql.identifier(assignment.column)} = ${assignment.value}`,
          ),
          sql`, `,
        )}`;

  return [
    shape({
      name: 'findAll',
      kind: 'read',
      reaches: 'existing-row',
      qualification: 'unqualified',
      statement: () => sql`select ${projection} from ${table} order by id`,
    }),
    shape({
      name: 'findOwnedBy',
      kind: 'read',
      reaches: 'existing-row',
      qualification: 'owner-qualified',
      statement: (_actor, target) =>
        sql`select ${projection} from ${table} where ${owner} = ${target.id}::uuid`,
    }),
    shape({
      name: 'updateOwnedBy',
      kind: 'write',
      reaches: 'existing-row',
      qualification: 'owner-qualified',
      statement: (_actor, target) =>
        sql`update ${table}
               set ${mutable} = ${spec.mutableValue ?? 'overwritten-by-another-tenant'}
             where ${owner} = ${target.id}::uuid`,
    }),
    shape({
      name: 'deleteOwnedBy',
      kind: 'write',
      reaches: 'existing-row',
      qualification: 'owner-qualified',
      statement: (_actor, target) => sql`delete from ${table} where ${owner} = ${target.id}::uuid`,
    }),
    shape({
      name: 'insertOwnedBy',
      kind: 'write',
      reaches: 'new-row',
      qualification: 'owner-qualified',
      statement: (_actor, target) => spec.plantedRow(spec.plantedOwnerId(target)),
    }),
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
     *
     * F-344: `alsoSets` is empty unless the table's WITH CHECK asks for more than
     * tenancy, in which case the registration names the columns it asks for and this
     * statement is ADMITTED rather than refused. It still carries no WHERE clause, so it
     * still reaches every row the USING clause admits, and the count rule still judges it.
     */
    shape({
      name: 'updateAll',
      kind: 'write',
      reaches: 'existing-row',
      qualification: 'unqualified',
      statement: () =>
        sql`update ${table} set ${mutable} = ${spec.mutableValue ?? 'overwritten-by-an-unqualified-write'}${alsoSets}`,
    }),
    /** F-302. `DELETE FROM <t>` — the auditor's measurement: DELETE 0 qualified, DELETE 2 not. */
    shape({
      name: 'deleteAll',
      kind: 'write',
      reaches: 'existing-row',
      qualification: 'unqualified',
      statement: () => sql`delete from ${table}`,
    }),
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
     * =========================================================================
     * F-342. EVERY TABLE CARRIES IT, INCLUDING THE ONE WHOSE OWNER COLUMN IS ITS KEY.
     * =========================================================================
     *
     * r3 let a registration DECLINE this shape by name, and `tenants` was the first and
     * only use — on the premise that `UPDATE tenants SET id = <actor>` is refused by the
     * primary key index "before any policy is evaluated". Measured on the migrated table,
     * as `shortkit_app` in an ordinary tenant-A transaction, on 2026-08-11:
     *
     *   tenants_self_update USING (id = ctx)  [the migration's] -> UPDATE 1, NO ERROR
     *   tenants_self_update USING (true), WITH CHECK correct    -> ERROR 23505
     *   tenants_self_update USING (true) WITH CHECK (true)      -> ERROR 23505
     *
     * The policy is evaluated FIRST and is what prevents the collision: the USING clause
     * admits only the actor's own row, so the assignment is an IDENTITY UPDATE and the key
     * is never contended. The shape separates the cases cleanly, so THE DECLINE AND THE
     * MECHANISM BEHIND IT ARE BOTH GONE. Its failing answer on such a table is a 23505,
     * which lands as `unverified` rather than as a named leak — a red run naming the
     * surface, which is narrower than a `fail` and far more than the decline gave it.
     *
     * Ordinary code paths that issue it: a re-parent, a move-between-workspaces, an
     * upsert, an ORM `save()` on a hydrated entity whose owner field was rebound.
     */
    shape({
      name: 'reparentAll',
      kind: 'write',
      reaches: 'existing-row',
      qualification: 'unqualified',
      statement: (actor) => sql`update ${table} set ${owner} = ${actor.id}::uuid${alsoSets}`,
    }),
  ];
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
 * ---------------------------------------------------------------------------
 * SO, ON THE MIGRATED PRODUCTION TABLE — RESTATED FOR r4 (F-342), BECAUSE THE PREVIOUS
 * VERSION OF THIS PARAGRAPH RESTED ON A PREMISE THAT MEASURES FALSE
 * ---------------------------------------------------------------------------
 *
 * It said `updateAll` was the ONLY live unqualified write attempt per direction, because
 * `reparentAll` had been declined here as inapplicable. It is applicable, and it runs:
 *
 *   updateAll    `UPDATE tenants SET name = <constant>`  -> live. UPDATE 1 under the
 *                migration's policies; UPDATE 2 (fail) if both halves are widened; 42501
 *                (unverified) if only the USING is.
 *   reparentAll  `UPDATE tenants SET id = <actor>`       -> live. UPDATE 1 under the
 *                migration's policies, because the USING clause admits only the actor's
 *                own row and the assignment is an IDENTITY UPDATE; ERROR 23505 under
 *                EITHER widened shape, which lands as `unverified` and names the surface.
 *                All three measured on this machine on 2026-08-11.
 *   deleteAll    `DELETE FROM tenants`                   -> inert, for the reason above.
 *
 * TWO live unqualified write attempts per direction, one of which reports its failure as
 * `unverified` rather than as a named leak. That is the honest accounting, and it is
 * narrower than a `fail` — but a decline recorded as a fact was not evidence at all.
 */
const tenantsAccess: TenantScopedSurfaceRegistration = {
  subject: 'TenantsTableAccess',
  table: 'tenants',
  ownerColumn: 'id',
  // `resetTenantFixtures`, not `createRlsFixture` — see its docblock (F-123). It calls
  // `createRlsFixture()` first and then re-seeds what that erases by cascade, so this
  // subject's reset no longer leaves another subject's table empty.
  reset: resetTenantFixtures,
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
  /** F-123, same as above: one reset, and it leaves every subject's fixture complete. */
  reset: resetTenantFixtures,
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

/**
 * ===========================================================================
 * THE MIGRATED MEMBERSHIP TABLE (TASK-002, tenant-membership-lookup.md).
 * ===========================================================================
 *
 * The third registered production table, and the first one carrying a THIRD policy
 * beside the template's two: `tenant_memberships_membership_lookup`, ADR-0045's
 * `FOR SELECT` token-mint escape. Every attempt below runs through
 * `withTenantTransaction`, which sets `app.tenant_id` and never
 * `app.membership_lookup_user`, so that policy reads NULL through its `nullif` and
 * admits nothing here — which is the property this registration incidentally proves on
 * every run. If it ever admitted something, `findAll` would return the other tenant's
 * row and the harness would name it.
 *
 * ITS FIXTURE ROWS GO IN THROUGH THE MIGRATOR DSN AND SO DOES ITS `"user"` SEED, and
 * both are structural rather than convenience: migration `0001` revokes `shortkit_app`
 * on `"user"` entirely (ADR-0050), so the runtime role cannot seed the foreign key it
 * needs. `resetTenantFixtures()` above does it — and does it for every subject, not only
 * this one, so no registration's position in this file decides whether it is seeded.
 */
const MEMBERSHIP_ROW_A = 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1';
const MEMBERSHIP_ROW_B = 'b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1';
const PLANTED_MEMBERSHIP_ROW_ID = 'f4f4f4f4-f4f4-4f4f-8f4f-f4f4f4f4f4f4';

/** Better Auth generates its own ids and they are not uuids (auth-schema.md). */
const MEMBERSHIP_USER_A = 'isolationUserA01';
const MEMBERSHIP_USER_B = 'isolationUserB01';

/**
 * A third user, for `insertOwnedBy` alone. `UNIQUE (user_id)` is one row per user, so
 * planting under A's or B's id would be refused by 23505 BEFORE any policy was
 * evaluated — a refusal indistinguishable from the 42501 the INSERT policy owes us,
 * which is the same trap `tenants` needs `TENANT_C_NEVER_SEEDED` for.
 */
const MEMBERSHIP_USER_PLANTED = 'isolationUserP01';

/** Different from the value below, so an admitted update is visible as a change. */
const MEMBERSHIP_OVERWRITE_ROLE = 'admin';
const MEMBERSHIP_SEEDED_ROLE = 'owner';

/**
 * ===========================================================================
 * THE MIGRATED `workspaces` TABLE (TASK-011, docs/contracts/workspaces.md).
 * ===========================================================================
 *
 * The fourth registered production table and the first template-shaped one whose
 * policies come from a MIGRATION rather than from the fixture — `0002_*.sql` carries
 * `tenantScopedPolicies('workspaces')` hand-appended. `id` is database-generated in
 * production; the fixture supplies fixed ids so `WorkspaceRepository`'s attempts below
 * can name the target's row without a lookup.
 */
const WORKSPACE_ROW_A = 'a2a2a2a2-a2a2-4a2a-8a2a-a2a2a2a2a2a2';
const WORKSPACE_ROW_B = 'b2b2b2b2-b2b2-4b2b-8b2b-b2b2b2b2b2b2';
const PLANTED_WORKSPACE_ROW_ID = 'f5f5f5f5-f5f5-4f5f-8f5f-f5f5f5f5f5f5';
const WORKSPACE_SEEDED_NAME = 'seeded-workspace';

/**
 * ===========================================================================
 * THE THREE 1b TABLES (TASK-1b-03, ADR-0062): `memberships`, `invitations`,
 * `invitation_workspaces`. Migration `0003_*.sql` carries `tenantScopedPolicies()` for
 * each, hand-appended, template unchanged — two policies per table, no bespoke policy.
 * ===========================================================================
 *
 * Seeded per tenant in `resetTenantFixtures()` below, one row each — except `invitations`,
 * which gets TWO per tenant, and the second exists for one reason: `invitation_workspaces`
 * is `UNIQUE (invitation_id, workspace_id)`, each tenant has one seeded workspace, so a
 * planted `invitation_workspaces` row naming the seeded (invitation, workspace) pair would
 * collide with the seeded row. Under the shipped policy the RLS refusal comes first and
 * the collision is never reached; under a WIDENED `WITH CHECK` — the defect the insert
 * shape exists to name — the row would be admitted and then refused 23505, which the
 * harness scores `unverified` rather than `fail`. Naming a leak is worth one spare row, so
 * the planted pair is (the tenant's SPARE invitation, the tenant's seeded workspace) and
 * collides with nothing. `tenants` and `tenant_memberships` solve the same trap with a
 * never-seeded id; here the foreign keys need a parent that exists.
 *
 * ROWS CROSS THE `"user"` GRANT BOUNDARY AND GO IN THROUGH THE MIGRATOR DSN, exactly as
 * `tenant_memberships`'s do: `memberships.user_id` and `invitations.invited_by_user_id`
 * reference `"user"`, which `shortkit_app` cannot read (ADR-0050). The seeded users are
 * the ones `tenant_memberships` already plants; the planted user is the third one.
 *
 * THE COMPOSITE FOREIGN KEY IS A SECOND FLOOR UNDER `reparentAll` (ADR-0062).
 * `memberships` and `invitation_workspaces` declare `FOREIGN KEY (workspace_id, tenant_id)
 * REFERENCES workspaces (id, tenant_id)`. Under the shipped policy `UPDATE <t> SET
 * tenant_id = <actor>` reaches only the actor's own rows and is an identity update. Under
 * a widened USING it would rewrite the target's row to (target's workspace, actor's tenant),
 * a pair `workspaces` does not hold, and the FK refuses it 23503 — `unverified`, naming the
 * surface, which is the F-342 accounting: narrower than a `fail`, still a red run. The
 * constraint refusing the theft is the property the ADR exists to record, not a gap.
 */
const WORKSPACE_MEMBERSHIP_ROW_A = 'a3a3a3a3-a3a3-4a3a-8a3a-a3a3a3a3a3a3';
const WORKSPACE_MEMBERSHIP_ROW_B = 'b3b3b3b3-b3b3-4b3b-8b3b-b3b3b3b3b3b3';
const PLANTED_WORKSPACE_MEMBERSHIP_ROW_ID = 'f6f6f6f6-f6f6-4f6f-8f6f-f6f6f6f6f6f6';
/** Seeded `workspace_admin`, overwritten with `viewer`: an enum, like `tenant_memberships.role`. */
const WORKSPACE_MEMBERSHIP_SEEDED_ROLE = 'workspace_admin';
const WORKSPACE_MEMBERSHIP_OVERWRITE_ROLE = 'viewer';

const INVITATION_ROW_A = 'a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a4a4';
const INVITATION_ROW_B = 'b4b4b4b4-b4b4-4b4b-8b4b-b4b4b4b4b4b4';
const INVITATION_SPARE_ROW_A = 'a5a5a5a5-a5a5-4a5a-8a5a-a5a5a5a5a5a5';
const INVITATION_SPARE_ROW_B = 'b5b5b5b5-b5b5-4b5b-8b5b-b5b5b5b5b5b5';
const PLANTED_INVITATION_ROW_ID = 'f7f7f7f7-f7f7-4f7f-8f7f-f7f7f7f7f7f7';
/**
 * `token_digest` is `bytea NOT NULL UNIQUE` (SHA-256 of a secret half, invitation-tokens.md).
 * Fixed 32-byte constants, hex, one per row that must exist at once, so the unique index
 * is never what refuses a statement. No raw token corresponds to any of them.
 */
const INVITATION_DIGEST_HEX_A = 'a4'.repeat(32);
const INVITATION_DIGEST_HEX_B = 'b4'.repeat(32);
const INVITATION_DIGEST_HEX_SPARE_A = 'a5'.repeat(32);
const INVITATION_DIGEST_HEX_SPARE_B = 'b5'.repeat(32);
const INVITATION_DIGEST_HEX_PLANTED = 'f7'.repeat(32);
const INVITATION_SEEDED_EMAIL = 'invitee@example.test';

const INVITATION_WORKSPACE_ROW_A = 'a6a6a6a6-a6a6-4a6a-8a6a-a6a6a6a6a6a6';
const INVITATION_WORKSPACE_ROW_B = 'b6b6b6b6-b6b6-4b6b-8b6b-b6b6b6b6b6b6';
const PLANTED_INVITATION_WORKSPACE_ROW_ID = 'f8f8f8f8-f8f8-4f8f-8f8f-f8f8f8f8f8f8';
const INVITATION_WORKSPACE_SEEDED_ROLE = 'member';
const INVITATION_WORKSPACE_OVERWRITE_ROLE = 'viewer';

/** The seeded parents a planted 1b row must name, keyed by the tenant that owns them. */
function seededParentsOf(tenantId: string): { workspaceId: string; spareInvitationId: string } {
  switch (tenantId) {
    case TENANT_A:
      return { workspaceId: WORKSPACE_ROW_A, spareInvitationId: INVITATION_SPARE_ROW_A };
    case TENANT_B:
      return { workspaceId: WORKSPACE_ROW_B, spareInvitationId: INVITATION_SPARE_ROW_B };
    default:
      throw new Error(
        `no seeded parents for tenant ${tenantId}; resetTenantFixtures seeds A and B only`,
      );
  }
}

/**
 * ===========================================================================
 * THE RESET EVERY REGISTRATION IN THIS FILE USES. IT REBUILDS THE WHOLE FIXTURE,
 * NOT ONE SUBJECT'S SHARE OF IT — AND THAT IS F-123.
 * ===========================================================================
 *
 * `createRlsFixture()` erases the fixture tenants, and `tenant_memberships.tenant_id` is
 * `ON DELETE CASCADE`, so ANY subject whose reset is `createRlsFixture` deletes both
 * seeded membership rows as a side effect. `coverage.ts` resets per attempt and iterates
 * the registry in insertion order, so the state the F-295 census reads is whatever the
 * LAST reset left behind.
 *
 * The first version of this file registered `tenantMembershipsAccess` third and gave the
 * other two `reset: createRlsFixture`, so the census passed **because of registration
 * order** — and registering a fourth subject after it, the ordinary way this file grows,
 * would have returned four census lines where six were expected. Loud, but the diagnosis
 * is nowhere near the failure.
 *
 * So the dependency is removed rather than documented: there is ONE reset, it leaves the
 * fixture complete for every registered subject, and whichever subject happens to run
 * last is no longer a fact anyone has to know. **A new registration uses this function.**
 * If a later subject needs its own seed, add it here rather than beside the registration,
 * for the reason this paragraph exists.
 */
function resetTenantFixtures(): void {
  // Tenants first: `createRlsFixture` erases and re-seeds them, and the erase cascades
  // every membership row away. Seeding before it would seed nothing.
  createRlsFixture();

  // ONE psql spawn for all of it. Every registration's reset now pays for this, once per
  // attempt, so the three round trips it replaced were worth collapsing — the tenant flag
  // is set inline per statement instead of through `execSql`'s session-level option.
  //
  // WORKSPACES ARE SEEDED HERE TOO (TASK-011), one row per tenant, under each tenant's
  // own flag: `workspaces` carries FORCE ROW LEVEL SECURITY, so the owning role's insert
  // has to satisfy the WITH CHECK like anyone else's. Erasing the fixture tenants above
  // already cascaded every workspace row away — seeded and planted alike — so no DELETE
  // is needed for them.
  //
  // AND THE THREE 1b TABLES (TASK-1b-03), in dependency order under the same flag:
  // `memberships` (needs the workspace and the user), `invitations` (two per tenant, the
  // second being the spare parent the docblock above explains), `invitation_workspaces`
  // (needs the invitation and the workspace). All three carry FORCE ROW LEVEL SECURITY and
  // all three cascade from `tenants`, so the erase above already cleared them.
  //
  // Deleting the `"user"` rows cascades their memberships too, which is what clears a row
  // a previous attempt planted. `"user"` carries no row-level security (ADR-0044), so
  // that half needs no tenant context — only the migrator's grant. The membership inserts
  // do: `tenant_memberships` carries FORCE ROW LEVEL SECURITY, so even the owning role's
  // insert has to satisfy the WITH CHECK, and it admits one tenant at a time.
  //
  // BOTH tenants, and that is rule 1 of this file: a table seeded for one tenant only
  // returns zero rows to four of the five shapes because there is nothing there rather
  // than because a policy denied them, and the harness scores that `unverified` (F-295).
  //
  // Every value reaches the script through a psql variable — `:'name'` quotes it as a
  // literal — so nothing is concatenated in, the same property `execSql`'s own `tenantId`
  // option has.
  execSql(
    migrationDsn(),
    `DELETE FROM "user" WHERE id IN (:'user_a', :'user_b', :'user_planted');

     INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at) VALUES
       (:'user_a',       'Isolation A', :'email_a', false, now(), now()),
       (:'user_b',       'Isolation B', :'email_b', false, now(), now()),
       (:'user_planted', 'Isolation P', :'email_p', false, now(), now());

     SELECT set_config('app.tenant_id', :'tenant_a', false) \\g /dev/null
     INSERT INTO tenant_memberships (id, tenant_id, user_id, role)
       VALUES (:'row_a', :'tenant_a', :'user_a', :'seeded_role');
     INSERT INTO workspaces (id, tenant_id, name)
       VALUES (:'workspace_a', :'tenant_a', :'workspace_name');
     INSERT INTO memberships (id, tenant_id, workspace_id, user_id, role)
       VALUES (:'membership_a', :'tenant_a', :'workspace_a', :'user_a', :'membership_role');
     INSERT INTO invitations (id, tenant_id, email, token_digest, expires_at, invited_by_user_id, inviter_email) VALUES
       (:'invitation_a',       :'tenant_a', :'invitee', decode(:'digest_a',       'hex'), now() + interval '7 days', :'user_a', :'email_a'),
       (:'invitation_spare_a', :'tenant_a', :'invitee', decode(:'digest_spare_a', 'hex'), now() + interval '7 days', :'user_a', :'email_a');
     INSERT INTO invitation_workspaces (id, tenant_id, invitation_id, workspace_id, role)
       VALUES (:'invitation_workspace_a', :'tenant_a', :'invitation_a', :'workspace_a', :'invitation_workspace_role');

     SELECT set_config('app.tenant_id', :'tenant_b', false) \\g /dev/null
     INSERT INTO tenant_memberships (id, tenant_id, user_id, role)
       VALUES (:'row_b', :'tenant_b', :'user_b', :'seeded_role');
     INSERT INTO workspaces (id, tenant_id, name)
       VALUES (:'workspace_b', :'tenant_b', :'workspace_name');
     INSERT INTO memberships (id, tenant_id, workspace_id, user_id, role)
       VALUES (:'membership_b', :'tenant_b', :'workspace_b', :'user_b', :'membership_role');
     INSERT INTO invitations (id, tenant_id, email, token_digest, expires_at, invited_by_user_id, inviter_email) VALUES
       (:'invitation_b',       :'tenant_b', :'invitee', decode(:'digest_b',       'hex'), now() + interval '7 days', :'user_b', :'email_b'),
       (:'invitation_spare_b', :'tenant_b', :'invitee', decode(:'digest_spare_b', 'hex'), now() + interval '7 days', :'user_b', :'email_b');
     INSERT INTO invitation_workspaces (id, tenant_id, invitation_id, workspace_id, role)
       VALUES (:'invitation_workspace_b', :'tenant_b', :'invitation_b', :'workspace_b', :'invitation_workspace_role');`,
    {
      variables: {
        tenant_a: TENANT_A,
        tenant_b: TENANT_B,
        row_a: MEMBERSHIP_ROW_A,
        row_b: MEMBERSHIP_ROW_B,
        user_a: MEMBERSHIP_USER_A,
        user_b: MEMBERSHIP_USER_B,
        user_planted: MEMBERSHIP_USER_PLANTED,
        email_a: `${MEMBERSHIP_USER_A}@example.test`,
        email_b: `${MEMBERSHIP_USER_B}@example.test`,
        email_p: `${MEMBERSHIP_USER_PLANTED}@example.test`,
        seeded_role: MEMBERSHIP_SEEDED_ROLE,
        workspace_a: WORKSPACE_ROW_A,
        workspace_b: WORKSPACE_ROW_B,
        workspace_name: WORKSPACE_SEEDED_NAME,
        membership_a: WORKSPACE_MEMBERSHIP_ROW_A,
        membership_b: WORKSPACE_MEMBERSHIP_ROW_B,
        membership_role: WORKSPACE_MEMBERSHIP_SEEDED_ROLE,
        invitation_a: INVITATION_ROW_A,
        invitation_b: INVITATION_ROW_B,
        invitation_spare_a: INVITATION_SPARE_ROW_A,
        invitation_spare_b: INVITATION_SPARE_ROW_B,
        invitee: INVITATION_SEEDED_EMAIL,
        digest_a: INVITATION_DIGEST_HEX_A,
        digest_b: INVITATION_DIGEST_HEX_B,
        digest_spare_a: INVITATION_DIGEST_HEX_SPARE_A,
        digest_spare_b: INVITATION_DIGEST_HEX_SPARE_B,
        invitation_workspace_a: INVITATION_WORKSPACE_ROW_A,
        invitation_workspace_b: INVITATION_WORKSPACE_ROW_B,
        invitation_workspace_role: INVITATION_WORKSPACE_SEEDED_ROLE,
      },
    },
  );
}

const tenantMembershipsAccess: TenantScopedSurfaceRegistration = {
  subject: 'TenantMembershipsTableAccess',
  table: 'tenant_memberships',
  ownerColumn: 'tenant_id',
  reset: resetTenantFixtures,
  methods: tableAccess({
    table: 'tenant_memberships',
    ownerColumn: 'tenant_id',
    // `user_id` rather than a label: it is the column the lookup policy keys on, so a
    // row that crossed a boundary is named by the user it belongs to.
    projection: ['id', 'tenant_id', 'user_id'],
    mutableColumn: 'role',
    mutableValue: MEMBERSHIP_OVERWRITE_ROLE,
    plantedOwnerId: (target) => target.id,
    plantedRow: (ownerId) =>
      sql`insert into ${sql.identifier('tenant_memberships')} (id, tenant_id, user_id, role)
          values (${PLANTED_MEMBERSHIP_ROW_ID}::uuid, ${ownerId}::uuid, ${MEMBERSHIP_USER_PLANTED}, ${MEMBERSHIP_SEEDED_ROLE})`,
  }),
};

/**
 * `workspaces`, attacked as a TABLE: the eight shapes, exactly as every other table.
 * This registration is what gives the table its three unqualified writes (rule 4) and
 * the owner-column theft attempt (F-330); the repository below issues none of those
 * shapes by design, so it cannot supply them itself.
 */
const workspacesAccess: TenantScopedSurfaceRegistration = {
  subject: 'WorkspacesTableAccess',
  table: 'workspaces',
  ownerColumn: 'tenant_id',
  reset: resetTenantFixtures,
  methods: tableAccess({
    table: 'workspaces',
    ownerColumn: 'tenant_id',
    projection: ['id', 'tenant_id', 'name'],
    mutableColumn: 'name',
    plantedOwnerId: (target) => target.id,
    plantedRow: (ownerId) =>
      sql`insert into ${sql.identifier('workspaces')} (id, tenant_id, name)
          values (${PLANTED_WORKSPACE_ROW_ID}::uuid, ${ownerId}::uuid, ${'planted-by-another-tenant'})`,
  }),
};

/**
 * `memberships`, attacked as a TABLE (TASK-1b-03). Its repository subject —
 * `MembershipRepository`'s methods, owner-qualified — arrives with the repository
 * (TASK-1b-05), the F-353 two-subjects-one-table pattern `workspaces` shipped.
 *
 * `mutableValue` for the same reason `tenant_memberships` has one: `role` is an enum and
 * the default free-text literal would fail as an enum error rather than a policy refusal.
 * The planted row names the TARGET's own workspace and the third user, so under the
 * shipped policy the only thing standing in its way is the WITH CHECK.
 */
const membershipsAccess: TenantScopedSurfaceRegistration = {
  subject: 'MembershipsTableAccess',
  table: 'memberships',
  ownerColumn: 'tenant_id',
  reset: resetTenantFixtures,
  methods: tableAccess({
    table: 'memberships',
    ownerColumn: 'tenant_id',
    projection: ['id', 'tenant_id', 'user_id'],
    mutableColumn: 'role',
    mutableValue: WORKSPACE_MEMBERSHIP_OVERWRITE_ROLE,
    plantedOwnerId: (target) => target.id,
    plantedRow: (ownerId) =>
      sql`insert into ${sql.identifier('memberships')} (id, tenant_id, workspace_id, user_id, role)
          values (${PLANTED_WORKSPACE_MEMBERSHIP_ROW_ID}::uuid, ${ownerId}::uuid, ${seededParentsOf(ownerId).workspaceId}::uuid, ${MEMBERSHIP_USER_PLANTED}, ${WORKSPACE_MEMBERSHIP_SEEDED_ROLE})`,
  }),
};

/**
 * `invitations`, attacked as a TABLE (TASK-1b-03). `InvitationRepository`'s methods and
 * the capability-token entry points arrive with them (TASK-1b-04, TASK-1b-10).
 *
 * `email` is free text, so the two update shapes keep their default literals. The planted
 * row's digest is a fifth constant, so the unique index on `token_digest` refuses nothing
 * here and the WITH CHECK is what answers. `expires_at` is in the future; `state` takes
 * its default. Nothing about a token is stored or needed: no raw token corresponds to any
 * digest in this file.
 */
const invitationsAccess: TenantScopedSurfaceRegistration = {
  subject: 'InvitationsTableAccess',
  table: 'invitations',
  ownerColumn: 'tenant_id',
  reset: resetTenantFixtures,
  methods: tableAccess({
    table: 'invitations',
    ownerColumn: 'tenant_id',
    projection: ['id', 'tenant_id', 'email'],
    mutableColumn: 'email',
    plantedOwnerId: (target) => target.id,
    plantedRow: (ownerId) =>
      sql`insert into ${sql.identifier('invitations')} (id, tenant_id, email, token_digest, expires_at, invited_by_user_id, inviter_email)
          values (${PLANTED_INVITATION_ROW_ID}::uuid, ${ownerId}::uuid, ${'planted@example.test'}, decode(${INVITATION_DIGEST_HEX_PLANTED}, 'hex'), now() + interval '7 days', ${MEMBERSHIP_USER_PLANTED}, ${'planter@example.test'})`,
  }),
};

/**
 * `invitation_workspaces`, attacked as a TABLE (TASK-1b-03). The planted row names the
 * target's SPARE invitation and the target's seeded workspace — a pair no seeded row
 * holds, so `UNIQUE (invitation_id, workspace_id)` refuses nothing and a widened WITH
 * CHECK would be named as a leak rather than masked as 23505 (see the constants above).
 * `role` is an enum, hence `mutableValue`.
 */
const invitationWorkspacesAccess: TenantScopedSurfaceRegistration = {
  subject: 'InvitationWorkspacesTableAccess',
  table: 'invitation_workspaces',
  ownerColumn: 'tenant_id',
  reset: resetTenantFixtures,
  methods: tableAccess({
    table: 'invitation_workspaces',
    ownerColumn: 'tenant_id',
    projection: ['id', 'tenant_id', 'workspace_id'],
    mutableColumn: 'role',
    mutableValue: INVITATION_WORKSPACE_OVERWRITE_ROLE,
    plantedOwnerId: (target) => target.id,
    plantedRow: (ownerId) =>
      sql`insert into ${sql.identifier('invitation_workspaces')} (id, tenant_id, invitation_id, workspace_id, role)
          values (${PLANTED_INVITATION_WORKSPACE_ROW_ID}::uuid, ${ownerId}::uuid, ${seededParentsOf(ownerId).spareInvitationId}::uuid, ${seededParentsOf(ownerId).workspaceId}::uuid, ${INVITATION_WORKSPACE_SEEDED_ROLE})`,
  }),
};

/**
 * ===========================================================================
 * `workspaces`, attacked THROUGH THE REPOSITORY: one method per public method of
 * `WorkspaceRepository`, called inside the ACTOR's tenant transaction with the TARGET's
 * arguments, which is what isolation-coverage.md's "repository method" row describes.
 * ===========================================================================
 *
 * What differs from the table battery, and why each difference is what it is:
 *
 * - EVERY METHOD IS `owner-qualified`, AND THAT IS THE REPOSITORY'S CONTRACT, NOT A
 *   CONVENIENCE. Every statement it issues carries `tenant_id = currentTenantId()` in
 *   its WHERE, or sets `tenant_id` on INSERT — `workspace.repository.spec.ts` compiles
 *   all of them and asserts exactly that, which is the same property `shape()` derives
 *   from the SQL for the table battery, checked at a different time. Nothing here can
 *   be checked by `assertDeclaredQualification()` because a repository method hands the
 *   harness a result and not a statement.
 *
 * - THE UNQUALIFIED WRITES LIVE IN `workspacesAccess` ABOVE. A registration whose writes
 *   are all owner-qualified is blind to a wide-open UPDATE or DELETE policy (F-302), so
 *   the rule is satisfied for the TABLE by the sibling registration — the F-353 pattern
 *   of two subjects on one table, one per way of attacking it.
 *
 * - `create` HAS NO TARGET ARGUMENT TO CROSS WITH. The repository writes under the
 *   context's tenant and takes no tenant parameter, so the attempt creates in the actor's
 *   context and reports as `rowsAffected` the number of rows it wrote that the TARGET
 *   owns — zero when the row landed under the actor, which is the only correct answer.
 *   The per-row digest of the target's rows judges it a second way, and `reset()`
 *   clears the created row before the next attempt.
 *
 * - `rename` AND `archive` ANSWER not-found FOR A ROW THE ACTOR DOES NOT OWN. That is
 *   the repository's contract (`WorkspaceNotFoundError`, docs/contracts/workspaces.md),
 *   so the attempt maps THAT error and no other to `rowsAffected: 0`. Anything else
 *   thrown propagates and lands as `unverified`, naming the surface.
 *
 * - READS PROJECT `tenant_id`. The repository returns `tenantId`; the harness judges a
 *   read on the owner COLUMN, so each row is mapped to `{ id, tenant_id, name }`.
 */
const workspaceRepository = new WorkspaceRepository();

function seededWorkspaceOf(tenant: TenantFixture): string {
  switch (tenant.id) {
    case TENANT_A:
      return WORKSPACE_ROW_A;
    case TENANT_B:
      return WORKSPACE_ROW_B;
    default:
      throw new Error(
        `no seeded workspace for tenant ${tenant.id}; resetTenantFixtures seeds A and B only`,
      );
  }
}

/** The user `resetTenantFixtures` gives a `memberships` row on the tenant's seeded workspace. */
function seededMembershipUserOf(tenant: TenantFixture): string {
  switch (tenant.id) {
    case TENANT_A:
      return MEMBERSHIP_USER_A;
    case TENANT_B:
      return MEMBERSHIP_USER_B;
    default:
      throw new Error(
        `no seeded membership user for tenant ${tenant.id}; resetTenantFixtures seeds A and B only`,
      );
  }
}

function ownerProjection(
  rows: ReadonlyArray<{ id: string; tenantId: string; name: string }>,
): CrossTenantAttemptResult {
  return { rows: rows.map((row) => ({ id: row.id, tenant_id: row.tenantId, name: row.name })) };
}

/**
 * A repository's OWN not-found answer to a foreign row is zero rows; anything else is not.
 * `WorkspaceNotFoundError` for `WorkspaceRepository` (docs/contracts/workspaces.md), and
 * since TASK-1b-10 `InvitationNotFoundError` for `InvitationRepository.revoke` and
 * `WorkspaceNotFoundError` for `InvitationRepository.create` (the composite foreign key's
 * refusal of a grant naming a workspace outside the transaction's tenant, mapped by the
 * repository itself — invitation-tokens.md, ADR-0062). The class is named per call so a
 * method that starts throwing the OTHER repository's error is `unverified` rather than a pass.
 */
async function affectedOrNotFound(
  work: () => Promise<unknown>,
  notFound: new () => Error = WorkspaceNotFoundError,
): Promise<CrossTenantAttemptResult> {
  try {
    await work();

    return { rowsAffected: 1 };
  } catch (error) {
    if (error instanceof notFound) {
      return { rowsAffected: 0 };
    }

    throw error;
  }
}

const workspaceRepositoryAccess: TenantScopedSurfaceRegistration = {
  subject: 'WorkspaceRepository',
  table: 'workspaces',
  ownerColumn: 'tenant_id',
  reset: resetTenantFixtures,
  methods: [
    {
      name: 'create',
      kind: 'write',
      reaches: 'new-row',
      qualification: 'owner-qualified',
      attempt: (actor, target) =>
        withTenantTransaction(actor.id, async () => {
          const created = await workspaceRepository.create({ name: 'planted-by-another-tenant' });

          return { rowsAffected: created.tenantId === target.id ? 1 : 0 };
        }),
    },
    {
      name: 'list',
      kind: 'read',
      reaches: 'existing-row',
      qualification: 'owner-qualified',
      attempt: (actor) =>
        withTenantTransaction(actor.id, async () =>
          ownerProjection(await workspaceRepository.list({ includeArchived: true })),
        ),
    },
    {
      // TASK-1b-06: the membership join `GET /api/workspaces` answers. Attempted FOR THE
      // TARGET'S seeded user (who holds a `memberships` row on the target's seeded workspace)
      // under the actor's context: the join must surface nothing, because both tables'
      // predicates and both policies name the actor's tenant and the target's rows are in
      // the other. The endpoint attempt (`route:GET /api/workspaces`) is the same statement
      // through the composition root, as a signed-in operator listing its own.
      name: 'listForUser',
      kind: 'read',
      reaches: 'existing-row',
      qualification: 'owner-qualified',
      attempt: (actor, target) =>
        withTenantTransaction(actor.id, async () =>
          ownerProjection(
            await workspaceRepository.listForUser(seededMembershipUserOf(target), { includeArchived: true }),
          ),
        ),
    },
    {
      name: 'findById',
      kind: 'read',
      reaches: 'existing-row',
      qualification: 'owner-qualified',
      attempt: (actor, target) =>
        withTenantTransaction(actor.id, async () => {
          const found = await workspaceRepository.findById(seededWorkspaceOf(target));

          return ownerProjection(found === null ? [] : [found]);
        }),
    },
    {
      name: 'rename',
      kind: 'write',
      reaches: 'existing-row',
      qualification: 'owner-qualified',
      attempt: (actor, target) =>
        withTenantTransaction(actor.id, () =>
          affectedOrNotFound(() =>
            workspaceRepository.rename(seededWorkspaceOf(target), 'renamed-by-another-tenant'),
          ),
        ),
    },
    {
      name: 'archive',
      kind: 'write',
      reaches: 'existing-row',
      qualification: 'owner-qualified',
      attempt: (actor, target) =>
        withTenantTransaction(actor.id, () =>
          affectedOrNotFound(() => workspaceRepository.archive(seededWorkspaceOf(target))),
        ),
    },
  ],
};

/**
 * ===========================================================================
 * `invitations` AND `memberships`, attacked THROUGH THEIR REPOSITORIES (TASK-1b-10, D-19):
 * one method per public method of the class, called inside the ACTOR's tenant transaction
 * with the TARGET's ids — the `WorkspaceRepository` shape above, on the two 1b classes.
 * ===========================================================================
 *
 * What is the same: every method is `owner-qualified` by the class's own contract (each
 * statement carries `tenant_id = currentTenantId()` or sets it on INSERT — the repository
 * specs compile and assert exactly that); the unqualified writes on both tables live in the
 * sibling `…TableAccess` batteries; reads project the owner column so the harness judges
 * them on it; a write that the repository answers with its OWN not-found error is zero rows,
 * anything else thrown propagates and lands `unverified`, naming the surface.
 *
 * What differs, per method, and why:
 *
 * - `InvitationRepository.create` NAMES THE TARGET'S WORKSPACE in its one grant. The row it
 *   would write is (target's workspace, actor's tenant), a pair `workspaces (id, tenant_id)`
 *   does not hold, and the composite foreign key refuses it 23503 — which the repository
 *   maps to `WorkspaceNotFoundError`, its contract's answer to a workspace the caller cannot
 *   see (ADR-0062's "second floor" under the policy). The transaction rolls back with it, so
 *   the `invitations` header row it inserted first never lands; the per-attempt census on
 *   the target's rows judges that a second way. Reported as zero rows; a create that
 *   SUCCEEDED naming the target's workspace, or whose row carried the target's tenant, is
 *   the leak. Compare `WorkspaceRepository.create`, which has no target argument to cross
 *   with; this one does, so it is crossed.
 *
 * - `MembershipRepository.create` HAS NO CONTRACT MAPPING for a foreign workspace — a grant
 *   naming the target's workspace would raise the raw 23503, which the harness cannot
 *   attribute to a policy and scores `unverified` (F-342's accounting: red, not a pass, and
 *   not evidence either). So it is attempted the way `WorkspaceRepository.create` is: the
 *   ACTOR's own workspace, the TARGET's seeded user (a `"user"` row is not tenant-bound;
 *   the pair collides with nothing), and the created row must carry the actor's tenant.
 *   `rowsAffected` is 1 only if it carried the target's. The composite key is exercised on
 *   this table by the battery's `reparentAll` (ADR-0062), not here.
 *
 * - `roleFor` and `workspaceIdsFor` return a role and a list of workspace ids, NOT rows, so
 *   the projection is reconstructed from the arguments: a non-null role for (the target's
 *   seeded workspace, the target's seeded user) can only be the target's own `memberships`
 *   row — the fixture gives that user exactly one, in the target's tenant, and the census
 *   premise has just read it there — and each entry `workspaceIdsFor(target's user)` returns
 *   is likewise a row that user holds only in the target. Both are reported with
 *   `tenant_id: target.id`, which is what makes them a leak under `judge()`. Under the shipped
 *   policy both answer nothing.
 *
 * - `revoke` on the target's seeded invitation is `InvitationNotFoundError` (the contract's
 *   404, indistinguishable from an id nobody issued); `findById` is `null`;
 *   `listForWorkspace` on the target's seeded workspace is `[]` — for both classes.
 */
const invitationRepository = new InvitationRepository();
const membershipRepository = new MembershipRepository();

/** The invitation `resetTenantFixtures` seeds for a tenant with a grant on its seeded workspace. */
function seededInvitationOf(tenant: TenantFixture): string {
  switch (tenant.id) {
    case TENANT_A:
      return INVITATION_ROW_A;
    case TENANT_B:
      return INVITATION_ROW_B;
    default:
      throw new Error(
        `no seeded invitation for tenant ${tenant.id}; resetTenantFixtures seeds A and B only`,
      );
  }
}

function invitationOwnerProjection(
  rows: ReadonlyArray<{ id: string; tenantId: string; email: string }>,
): CrossTenantAttemptResult {
  return { rows: rows.map((row) => ({ id: row.id, tenant_id: row.tenantId, email: row.email })) };
}

function membershipOwnerProjection(
  rows: ReadonlyArray<{ id: string; tenantId: string; userId: string }>,
): CrossTenantAttemptResult {
  return { rows: rows.map((row) => ({ id: row.id, tenant_id: row.tenantId, user_id: row.userId })) };
}

const invitationRepositoryAccess: TenantScopedSurfaceRegistration = {
  subject: 'InvitationRepository',
  table: 'invitations',
  ownerColumn: 'tenant_id',
  reset: resetTenantFixtures,
  methods: [
    {
      name: 'create',
      kind: 'write',
      reaches: 'existing-row',
      qualification: 'owner-qualified',
      // The foreign-key refusal ABORTS the transaction (25P02 for anything after it), so the
      // not-found is caught OUTSIDE `withTenantTransaction`, which rolls the aborted
      // transaction back — the header row inserted before the grant never lands.
      attempt: async (actor, target) => {
        try {
          return await withTenantTransaction(actor.id, async () => {
            const row = await invitationRepository.create({
              email: 'planted@example.test',
              workspaces: [{ workspaceId: seededWorkspaceOf(target), workspaceRole: 'member' }],
              invitedByUserId: seededMembershipUserOf(actor),
              inviterEmail: 'planter@example.test',
              // A digest nothing in this file or any table holds; the raw token is dropped.
              digest: issueCapabilityToken(actor.id).digest,
              expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
            });

            // Past the foreign key somehow: the row's owner decides. Under the actor it is
            // correct (and `reset()` clears it before the next attempt); under the target
            // it is the leak.
            return { rowsAffected: row.tenantId === target.id ? 1 : 0 };
          });
        } catch (error) {
          if (error instanceof WorkspaceNotFoundError) {
            return { rowsAffected: 0 };
          }

          throw error;
        }
      },
    },
    {
      name: 'listForWorkspace',
      kind: 'read',
      reaches: 'existing-row',
      qualification: 'owner-qualified',
      attempt: (actor, target) =>
        withTenantTransaction(actor.id, async () =>
          invitationOwnerProjection(
            await invitationRepository.listForWorkspace(seededWorkspaceOf(target)),
          ),
        ),
    },
    {
      name: 'findById',
      kind: 'read',
      reaches: 'existing-row',
      qualification: 'owner-qualified',
      attempt: (actor, target) =>
        withTenantTransaction(actor.id, async () => {
          const found = await invitationRepository.findById(seededInvitationOf(target));

          return invitationOwnerProjection(found === null ? [] : [found]);
        }),
    },
    {
      name: 'revoke',
      kind: 'write',
      reaches: 'existing-row',
      qualification: 'owner-qualified',
      attempt: (actor, target) =>
        withTenantTransaction(actor.id, () =>
          affectedOrNotFound(
            () => invitationRepository.revoke(seededInvitationOf(target)),
            InvitationNotFoundError,
          ),
        ),
    },
  ],
};

const membershipRepositoryAccess: TenantScopedSurfaceRegistration = {
  subject: 'MembershipRepository',
  table: 'memberships',
  ownerColumn: 'tenant_id',
  reset: resetTenantFixtures,
  methods: [
    {
      name: 'roleFor',
      kind: 'read',
      reaches: 'existing-row',
      qualification: 'owner-qualified',
      attempt: (actor, target) =>
        withTenantTransaction(actor.id, async () => {
          const role = await membershipRepository.roleFor(
            seededWorkspaceOf(target),
            seededMembershipUserOf(target),
          );

          return {
            rows:
              role === null
                ? []
                : [{ id: `${seededWorkspaceOf(target)}/${seededMembershipUserOf(target)}`, tenant_id: target.id, role }],
          };
        }),
    },
    {
      name: 'workspaceIdsFor',
      kind: 'read',
      reaches: 'existing-row',
      qualification: 'owner-qualified',
      attempt: (actor, target) =>
        withTenantTransaction(actor.id, async () => {
          const entries = await membershipRepository.workspaceIdsFor(seededMembershipUserOf(target));

          return {
            rows: entries.map((entry) => ({ id: entry.workspaceId, tenant_id: target.id, role: entry.role })),
          };
        }),
    },
    {
      name: 'create',
      kind: 'write',
      reaches: 'new-row',
      qualification: 'owner-qualified',
      attempt: (actor, target) =>
        withTenantTransaction(actor.id, async () => {
          const created = await membershipRepository.create({
            workspaceId: seededWorkspaceOf(actor),
            userId: seededMembershipUserOf(target),
            role: WORKSPACE_ROLE.member,
          });

          return { rowsAffected: created.tenantId === target.id ? 1 : 0 };
        }),
    },
    {
      name: 'listForWorkspace',
      kind: 'read',
      reaches: 'existing-row',
      qualification: 'owner-qualified',
      attempt: (actor, target) =>
        withTenantTransaction(actor.id, async () =>
          membershipOwnerProjection(
            await membershipRepository.listForWorkspace(seededWorkspaceOf(target)),
          ),
        ),
    },
  ],
};

registerTenantScopedSurfaces(tenantsAccess);
registerTenantScopedSurfaces(rlsFixtureRowsAccess);
registerTenantScopedSurfaces(tenantMembershipsAccess);
registerTenantScopedSurfaces(workspacesAccess);
registerTenantScopedSurfaces(workspaceRepositoryAccess);
registerTenantScopedSurfaces(membershipsAccess);
registerTenantScopedSurfaces(membershipRepositoryAccess);
registerTenantScopedSurfaces(invitationsAccess);
registerTenantScopedSurfaces(invitationRepositoryAccess);
registerTenantScopedSurfaces(invitationWorkspacesAccess);

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
  /** F-344. Two controls need the unqualified updates to satisfy a stricter WITH CHECK. */
  unqualifiedWritesAlsoSet?: readonly RequiredAssignment[],
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
      unqualifiedWritesAlsoSet,
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

/**
 * F-342. The cascade root's shape — owner column IS the primary key — with the UPDATE
 * policy's USING widened and its WITH CHECK left correct. See `createPkOwnerCanary()`.
 * Written out rather than built by `controlAccess()`, which assumes `tenant_id`.
 */
export const pkOwnerCanaryAccess: TenantScopedSurfaceRegistration = {
  subject: 'PkOwnerCanaryTableAccess',
  table: PK_OWNER_CANARY_TABLE,
  ownerColumn: 'id',
  reset: createPkOwnerCanary,
  methods: tableAccess({
    table: PK_OWNER_CANARY_TABLE,
    ownerColumn: 'id',
    projection: ['id', 'label'],
    mutableColumn: 'label',
    // A tenant the fixture never seeds, for the reason `tenants` needs one: an insert
    // carrying the target's id would collide on the primary key and the 23505 would be
    // indistinguishable from the 42501 the INSERT policy owes us.
    plantedOwnerId: () => TENANT_C_NEVER_SEEDED,
    plantedRow: (ownerId) =>
      sql`insert into ${sql.identifier(PK_OWNER_CANARY_TABLE)} (id, label)
          values (${ownerId}::uuid, ${'planted-by-another-tenant'})`,
  }),
};

/**
 * F-344. CORRECTLY ISOLATED, and its WITH CHECK carries one ordinary business predicate
 * beyond tenancy. See `createGuardedCheckCanary()`. The one control in this file that
 * must come back entirely GREEN.
 */
export const guardedCheckCanaryAccess = controlAccess(
  'GuardedCheckCanaryTableAccess',
  GUARDED_CHECK_CANARY_TABLE,
  createGuardedCheckCanary,
  // The one column this table's WITH CHECK asks about beyond tenancy. Without it both
  // unqualified updates are refused, score `unverified`, and the run is red over a table
  // that is correctly isolated — which is the measurement F-344 is.
  [{ column: 'status', value: 'active' }],
);

/**
 * F-352. `isolation_guarded_check_canary`'s LEAKY TWIN: the same stricter WITH CHECK,
 * over a USING clause that admits every row of every tenant. See
 * `createGuardedLeakCanary()` for the seven measured statements.
 *
 * The registration names the column the check requires, exactly as the F-344 one does.
 * What it may NOT do is derive that column's value from the column — the assignment is a
 * bound value, so the statement references no existing column and the SELECT policies
 * stay out of it, which is the only reason the unqualified writes can still see the leak.
 */
export const guardedLeakCanaryAccess = controlAccess(
  'GuardedLeakCanaryTableAccess',
  GUARDED_LEAK_CANARY_TABLE,
  createGuardedLeakCanary,
  [{ column: 'lock_token', value: 'held' }],
);

/**
 * ============================================================================
 * F-352. THE FALSIFICATION ATTEMPT, KEPT AS A CONTROL.
 * ============================================================================
 *
 * The same table and the same registration, with the value an author would reach for if
 * they were trying to write a column reference and the type would not let them: the
 * COLUMN'S OWN NAME, as a string. It binds as `$N`, so the statement reads
 * `"lock_token" = $2` with the parameter `'lock_token'` — a constant, not a reference —
 * and the leak is still reported. Measured on this table, tenant A, 2026-08-11:
 *
 *   set label = <const>, lock_token = lock_token || 'x'  -> UPDATE 1   (unexpressible now)
 *   set label = <const>, lock_token = 'lock_token'       -> UPDATE 2   the leak, still seen
 *
 * It exists because the guarantee this round makes is about VALUES BEING BOUND, and a
 * builder that inlined them instead — `sql.raw`, a template concatenation, a future
 * "convenience" — would restore the disarm for exactly this value while every other
 * control stayed green. Under that mutation this attempt reports UPDATE 1 and this
 * control goes red.
 */
export const guardedLeakBoundValueCanaryAccess = controlAccess(
  'GuardedLeakBoundValueCanaryTableAccess',
  GUARDED_LEAK_CANARY_TABLE,
  createGuardedLeakCanary,
  [{ column: 'lock_token', value: 'lock_token' }],
);

/**
 * ===========================================================================
 * THE FIVE WORKSPACE ROUTES, ATTACKED AS AUTHENTICATED HTTP (TASK-014, TASK-015; the
 * fifth, `GET /api/workspaces/:workspaceId`, and the memberships the routes now require,
 * TASK-1b-06).
 * ===========================================================================
 *
 * SC-4's clause: "one negative control per endpoint, IN THE ISOLATION HARNESS rather than
 * in a controller test." A controller test proves the controller does what its author
 * expected; this proves the composition root — guard, tenant interceptor, filter,
 * repository, policies — refuses what the controller was never asked about, issued as a
 * SECOND signed-in operator against the first's rows.
 *
 * These run against the CHILD API `signedInTenants()` booted (the real main.ts, the real
 * /api prefix), as two real operators whose tenants are the ones their own signups
 * created. So the fixtures below are the SIGNED-IN tenants, not `tenants`' TENANT_A/B, and
 * the endpoint battery is a second attempt group with its own fixtures (coverage.ts,
 * `runAttemptGroups`). The two workspace rows the routes address are seeded by hand under
 * those two tenants at fixed ids.
 *
 * EVERY ROUTE IS `owner-qualified`, AND THAT IS WHAT THE ENDPOINT ENFORCES, not merely what
 * the repository happens to do. Every statement the route issues carries
 * `tenant_id = currentTenantId()` in its WHERE, or sets `tenant_id` on insert, and no route
 * takes a parameter or body field naming another tenant — `docs/contracts/workspaces.md`
 * ("Endpoints"): a cross-tenant reference is answered 404 `not_found`, indistinguishable
 * from a malformed or missing id. There is no unqualified HTTP shape to declare, because
 * the endpoint offers no way to express one.
 *
 * SINCE TASK-1b-06 EVERY ROUTE BUT CREATE IS GATED OR FILTERED BY A `memberships` ROW
 * (workspace-authorization.md, D-10), so the fixture below seeds each signed-in user a
 * `workspace_admin` membership on ITS OWN tenant's seeded workspace: that is what keeps the
 * positive controls green (A renaming, archiving, reading and listing A's row is 2xx) while
 * the cross-tenant attempt stays 404 — twice over now: no membership row for A on B's
 * workspace, and B's rows invisible under the policy. A positive control that failed for
 * want of a membership would score every workspace route `unverified` (F-296).
 */
const ENDPOINT_WORKSPACE_A = 'e1e1e1e1-e1e1-4e1e-8e1e-e1e1e1e1e1e1';
const ENDPOINT_WORKSPACE_B = 'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2e2';
const ENDPOINT_WORKSPACE_NAME = 'signed-in-seeded-workspace';
/** The signed-in user's role on its own seeded workspace: enough for every route's minimum. */
const ENDPOINT_MEMBERSHIP_ROLE = 'workspace_admin';

/**
 * TASK-1b-10. One pending invitation per signed-in tenant, at a fixed id, naming that
 * tenant's seeded workspace at `member` — the row `DELETE /api/invitations/:id` and the two
 * token routes address. Its RAW TOKEN IS HELD IN MEMORY BY THIS MODULE and nowhere else:
 * issued once per tenant by `issueCapabilityToken`, its digest planted under the migrator
 * on every reset (the same digest every time, so the token stays valid across resets),
 * never written to a log, a report or an error message — the `UnverifiedAttempt` texts
 * quote response bodies, and no response of these routes carries a token (GC-K).
 */
const ENDPOINT_INVITATION_A = 'e3e3e3e3-e3e3-4e3e-8e3e-e3e3e3e3e3e3';
const ENDPOINT_INVITATION_B = 'e4e4e4e4-e4e4-4e4e-8e4e-e4e4e4e4e4e4';
const ENDPOINT_INVITATION_EMAIL = 'signed-in-invitee@example.test';
const ENDPOINT_INVITATION_ROLE = 'member';

interface HeldCapabilityToken {
  readonly raw: string;
  readonly digestHex: string;
}

/** Keyed by tenant id; filled lazily so a tenant that never signs in never gets a token. */
const heldInvitationTokens = new Map<string, HeldCapabilityToken>();

/** The raw token the fixture holds for a signed-in tenant's seeded invitation. In memory only. */
export function heldInvitationTokenFor(tenantId: string): string {
  const held = heldInvitationTokens.get(tenantId);

  if (held === undefined) {
    const issued = issueCapabilityToken(tenantId);
    const fresh = { raw: issued.raw, digestHex: issued.digest.toString('hex') };

    heldInvitationTokens.set(tenantId, fresh);

    return fresh.raw;
  }

  return held.raw;
}

function heldInvitationDigestHexFor(tenantId: string): string {
  heldInvitationTokenFor(tenantId);

  const held = heldInvitationTokens.get(tenantId);

  if (held === undefined) {
    throw new Error(`no capability token is held for tenant ${tenantId}`);
  }

  return held.digestHex;
}

/** `<uuid>.<secret>`: the secret half of a held token, for the prefix-swap attack. */
function secretHalfOf(rawToken: string): string {
  return rawToken.slice(rawToken.indexOf('.') + 1);
}

const WORKSPACE_ENDPOINTS: readonly EndpointAttemptSpec[] = [
  {
    name: 'create',
    method: 'POST',
    route: '/api/workspaces',
    httpKind: 'write',
    reaches: 'new-row',
    qualification: 'owner-qualified',
    // Create takes only a name and writes under the caller's tenant; the attack is that
    // the created row must belong to the ACTOR, never the target. Verified against the
    // database, because the response carries no tenantId (workspaces.md, "The client shape").
    buildRequest: () => ({ path: '/api/workspaces', body: { name: 'planted-by-another-tenant' } }),
    expectedRefusal: { kind: 'created-under-actor' },
  },
  {
    name: 'list',
    method: 'GET',
    route: '/api/workspaces',
    httpKind: 'read',
    reaches: 'existing-row',
    qualification: 'owner-qualified',
    // The actor lists its own; the target's seeded workspace must not appear. The positive
    // control is the target listing its own and seeing that row, so an empty cross-tenant
    // list is isolation and not a broken route.
    buildRequest: () => ({ path: '/api/workspaces?includeArchived=true' }),
    expectedRefusal: { kind: 'absent-from-list' },
  },
  {
    // TASK-1b-06 (D-07): the read by id, `RequireWorkspaceRole(viewer)`. The actor reads its
    // own seeded row (200, it holds the seeded membership) and the target's (404: no
    // membership, and the row is invisible under the policy — the interceptor's lookup
    // runs inside the tenant transaction). Same 404 body as an id nobody issued.
    name: 'get',
    method: 'GET',
    route: '/api/workspaces/:workspaceId',
    httpKind: 'read',
    reaches: 'existing-row',
    qualification: 'owner-qualified',
    buildRequest: (_actor, target, ctx) => ({
      path: `/api/workspaces/${ctx.seededRowId(target.id)}`,
    }),
    expectedRefusal: { kind: 'status', status: 404 },
  },
  {
    name: 'rename',
    method: 'PATCH',
    route: '/api/workspaces/:workspaceId',
    httpKind: 'write',
    reaches: 'existing-row',
    qualification: 'owner-qualified',
    buildRequest: (_actor, target, ctx) => ({
      path: `/api/workspaces/${ctx.seededRowId(target.id)}`,
      body: { name: 'renamed-by-another-tenant' },
    }),
    expectedRefusal: { kind: 'status', status: 404 },
  },
  {
    name: 'archive',
    method: 'POST',
    route: '/api/workspaces/:workspaceId/archive',
    httpKind: 'write',
    reaches: 'existing-row',
    qualification: 'owner-qualified',
    buildRequest: (_actor, target, ctx) => ({
      path: `/api/workspaces/${ctx.seededRowId(target.id)}/archive`,
    }),
    expectedRefusal: { kind: 'status', status: 404 },
  },
];

/** A fresh bearer for one signed-in tenant, minted from its cookie so it cannot expire mid-run. */
async function tokenMinter(runtime: SignedInTenants): Promise<(tenantId: string) => Promise<string>> {
  return async (tenantId: string): Promise<string> => {
    const tenant = tenantId === runtime.a.tenantId ? runtime.a : runtime.b;
    const minted = await mintToken(runtime.server, tenant.cookie);
    const token = (minted.body as { token?: unknown }).token;

    if (minted.status !== 200 || typeof token !== 'string') {
      throw new Error(`re-mint for ${tenantId} answered ${String(minted.status)}: ${minted.raw}`);
    }

    return token;
  };
}

/**
 * THE ONE RESET BOTH ENDPOINT GROUPS USE — F-123's rule applied to the signed-in fixture:
 * it leaves the fixture complete for every endpoint subject, whichever ran last.
 *
 * Seeds one workspace per signed-in tenant at a fixed id, under each tenant's own flag;
 * since TASK-1b-06 the signed-in user's `workspace_admin` membership on it, which is what
 * the routes require of a caller (see the docblock above); and since TASK-1b-10 one pending
 * invitation per tenant naming that workspace, whose digest is the held token's (above).
 * `DELETE FROM workspaces` cascades the previous attempt's memberships and grants away
 * (`ON DELETE CASCADE` on the composite key) — the create attempt's row, the creator
 * membership and the accept's rows among them — and `invitations` has no such parent, so it
 * is deleted by name: the create positive control's row and the accepted/revoked state of
 * the seeded one both go. Through the migrator DSN, like every seed: `memberships.user_id`
 * and `invitations.invited_by_user_id` reference `"user"`, which `shortkit_app` cannot read,
 * and every table here carries FORCE ROW LEVEL SECURITY, so the flag is set per tenant.
 *
 * ONE TRANSACTION (TASK-1b-10, a review finding). psql runs each statement in its own
 * transaction unless told otherwise, and a run killed — or a statement refused — between
 * the DELETE and the INSERTs left one tenant's fixed-id rows gone and the other's in place,
 * or a workspace re-inserted with its membership missing; the next reset then met a
 * `duplicate key value violates unique constraint "workspaces_pkey"` on a row a previous
 * partial reset had orphaned. `BEGIN … COMMIT` around the whole script means it either
 * lands complete or not at all (`ON_ERROR_STOP=1` aborts the script, the connection drops,
 * the transaction rolls back), and `set_config(…, false)` is session-scoped so the two
 * tenant flags still take turns inside it.
 */
function resetSignedInFixture(runtime: SignedInTenants): void {
  execSql(
    migrationDsn(),
    `BEGIN;
     SELECT set_config('app.tenant_id', :'ta', false) \\g /dev/null
     DELETE FROM invitations;
     DELETE FROM workspaces;
     INSERT INTO workspaces (id, tenant_id, name)
       VALUES (:'wa'::uuid, :'ta'::uuid, :'name');
     INSERT INTO memberships (tenant_id, workspace_id, user_id, role)
       VALUES (:'ta'::uuid, :'wa'::uuid, :'ua', :'role'::workspace_role);
     INSERT INTO invitations (id, tenant_id, email, token_digest, expires_at, invited_by_user_id, inviter_email)
       VALUES (:'ia'::uuid, :'ta'::uuid, :'invitee', decode(:'digest_a', 'hex'), now() + interval '7 days', :'ua', :'inviter_a');
     INSERT INTO invitation_workspaces (tenant_id, invitation_id, workspace_id, role)
       VALUES (:'ta'::uuid, :'ia'::uuid, :'wa'::uuid, :'invitation_role'::workspace_role);

     SELECT set_config('app.tenant_id', :'tb', false) \\g /dev/null
     DELETE FROM invitations;
     DELETE FROM workspaces;
     INSERT INTO workspaces (id, tenant_id, name)
       VALUES (:'wb'::uuid, :'tb'::uuid, :'name');
     INSERT INTO memberships (tenant_id, workspace_id, user_id, role)
       VALUES (:'tb'::uuid, :'wb'::uuid, :'ub', :'role'::workspace_role);
     INSERT INTO invitations (id, tenant_id, email, token_digest, expires_at, invited_by_user_id, inviter_email)
       VALUES (:'ib'::uuid, :'tb'::uuid, :'invitee', decode(:'digest_b', 'hex'), now() + interval '7 days', :'ub', :'inviter_b');
     INSERT INTO invitation_workspaces (tenant_id, invitation_id, workspace_id, role)
       VALUES (:'tb'::uuid, :'ib'::uuid, :'wb'::uuid, :'invitation_role'::workspace_role);
     COMMIT;`,
    {
      variables: {
        ta: runtime.a.tenantId,
        tb: runtime.b.tenantId,
        ua: runtime.a.userId,
        ub: runtime.b.userId,
        wa: ENDPOINT_WORKSPACE_A,
        wb: ENDPOINT_WORKSPACE_B,
        name: ENDPOINT_WORKSPACE_NAME,
        role: ENDPOINT_MEMBERSHIP_ROLE,
        ia: ENDPOINT_INVITATION_A,
        ib: ENDPOINT_INVITATION_B,
        invitee: ENDPOINT_INVITATION_EMAIL,
        digest_a: heldInvitationDigestHexFor(runtime.a.tenantId),
        digest_b: heldInvitationDigestHexFor(runtime.b.tenantId),
        inviter_a: runtime.a.email,
        inviter_b: runtime.b.email,
        invitation_role: ENDPOINT_INVITATION_ROLE,
      },
    },
  );
}

/** Which signed-in operator owns a tenant id, for the specs that need its user or token. */
function signedInOwnerOf(runtime: SignedInTenants, tenantId: string): SignedInTenant {
  if (tenantId === runtime.a.tenantId) {
    return runtime.a;
  }

  if (tenantId === runtime.b.tenantId) {
    return runtime.b;
  }

  throw new Error(`tenant ${tenantId} is not one of the two signed-in operators`);
}

/**
 * ===========================================================================
 * THE FIVE INVITATION ROUTES (TASK-1b-10, AC-1b-31, AC-1b-32; workspace-authorization.md
 * "the five invitation rows", invitation-tokens.md, D-01, D-04, D-19).
 * ===========================================================================
 *
 * Built per runtime because four of the five need the OTHER tenant's ids — its seeded
 * workspace, its seeded invitation, its held raw token, its user — which the module-level
 * `EndpointAttemptContext` (one `seededRowId` per group) does not carry. The group's table
 * is `invitations`, so `ctx.seededRowId(tenant)` is that tenant's seeded invitation and the
 * per-attempt census brackets each tenant's `invitations` rows.
 *
 * HOW EACH IS SCORED, AND WHY — the harness's own vocabulary:
 *
 * - `create` (POST /api/invitations, body naming the TARGET's workspace at `member`): 404
 *   `not_found`, a `status` refusal. Form B in the service asserts `workspace_admin` on
 *   every named workspace under the actor's transaction; the actor holds no `memberships`
 *   row on the target's workspace and could not see it if it did (D-10: a non-member is
 *   404, the same body as an id nobody issued). The positive control is the actor naming
 *   its OWN seeded workspace: 201, a row under the actor (its after-commit dispatch renders
 *   the mail into the Noop transport). The census on the target's `invitations` rows either
 *   side of the attempt is what says nothing was written there.
 * - `list` (GET /api/invitations?workspaceId=<the target's>): 404, a `status` refusal from
 *   the interceptor's Form A (`RequireWorkspaceRole(workspace_admin)` on the query's id).
 *   NOT `absent-from-list`: that shape needs the cross-tenant response to be 200 with an
 *   empty list, and this route refuses before it lists. Positive control: the actor's own
 *   workspace, 200 with its seeded invitation.
 * - `revoke` (DELETE /api/invitations/<the target's invitation>): 404, `status`. The
 *   service's `findById` under the actor finds nothing. Positive control: the actor revoking
 *   its own, 200 `revoked` (undone by the next reset).
 * - `accept` (POST /api/invitations/accept, body `{ token: <the TARGET's raw token> }`, the
 *   actor signed in): 409 `invitation_tenant_conflict`. THIS IS NOT A POLICY ANSWER. The
 *   accept route runs under the actor's tenant transaction, and `assertNoTenantConflict`
 *   compares the token's prefix with the active tenant BEFORE any statement (D-04,
 *   capability-lookup.ts) — so the 409 is the application refusing to route the token, and
 *   on its own it proves as little as any status. It counts because (a) the positive control
 *   is the actor accepting ITS OWN tenant's seeded invitation as a signed-in existing member,
 *   200 (`tenantMembership: 'require'` is satisfied by the signup's owner row; the grant is
 *   `ON CONFLICT DO NOTHING` against the seeded `workspace_admin` row, D-12), and (b)
 *   `targetMutated` reads the target back through the migrator: its seeded invitation must
 *   still be `pending` with no `accepted_by_user_id`, and no `memberships` row for the
 *   ACTOR's user may exist in the target's tenant. Either changed is one affected row — a
 *   fail. The census on the target's `invitations` rows judges the same thing a third way.
 * - `lookup` (POST /api/invitations/lookup, ANONYMOUS, body `{ token: <the ACTOR's raw
 *   token with its prefix replaced by the TARGET's id> }`): 404 `not_found`. THE ONE
 *   `@Public()` ROUTE, and its semantics are D-01's: the token IS the capability, a holder
 *   of the target's own token previews the target's invitation BY DESIGN, and that is not a
 *   leak this harness may score — so the attempt does not send the target's token. It sends
 *   the actor's SECRET under the target's PREFIX, which is the tenant-routing property
 *   ADR-0021 requires a test for: `findInvitationByCapabilityToken` opens the transaction
 *   from the prefix (the target) and its first statement is the digest lookup under the
 *   target's isolation policy, where the actor's digest is not visible — the actor's row
 *   is in the actor's tenant, and the table battery has already shown the target's
 *   transaction sees none of the actor's `invitations` rows. The positive control is
 *   `buildOwnRequest`: the actor's UNTOUCHED token, 200 with the actor's tenant name (an
 *   argument swap would build the target's secret under the actor's prefix — a second
 *   attack, not a control). "Zero rows read in the target" is proven by that premise plus
 *   the digest miss and NOT by a counter: no SELECT-counting trigger exists and pg_stat's
 *   scan counters are not tenant-attributable (the card records this). The int-spec adds
 *   the byte-identity assertion: the swapped-prefix answer equals a never-issued token's.
 *   The registration hand-sets `authenticated: false`, the decorator's justification and
 *   `usesCapabilityToken: true`, which is what the report lists (AC-1b-32).
 *
 * `GET /api/workspaces/:workspaceId` (the card's sixth row) is already the workspace
 * group's `get` (TASK-1b-06) and is not duplicated here.
 */
function invitationEndpoints(runtime: SignedInTenants): readonly EndpointAttemptSpec[] {
  const workspaceOf = (tenantId: string): string =>
    tenantId === runtime.a.tenantId ? ENDPOINT_WORKSPACE_A : ENDPOINT_WORKSPACE_B;

  return [
    {
      name: 'create',
      method: 'POST',
      route: '/api/invitations',
      httpKind: 'write',
      reaches: 'existing-row',
      qualification: 'owner-qualified',
      buildRequest: (_actor, target) => ({
        path: '/api/invitations',
        body: {
          email: ENDPOINT_INVITATION_EMAIL,
          workspaces: [{ workspaceId: workspaceOf(target.id), workspaceRole: ENDPOINT_INVITATION_ROLE }],
        },
      }),
      expectedRefusal: { kind: 'status', status: 404 },
    },
    {
      name: 'list',
      method: 'GET',
      route: '/api/invitations',
      httpKind: 'read',
      reaches: 'existing-row',
      qualification: 'owner-qualified',
      buildRequest: (_actor, target) => ({
        path: `/api/invitations?workspaceId=${workspaceOf(target.id)}`,
      }),
      expectedRefusal: { kind: 'status', status: 404 },
    },
    {
      name: 'revoke',
      method: 'DELETE',
      route: '/api/invitations/:id',
      httpKind: 'write',
      reaches: 'existing-row',
      qualification: 'owner-qualified',
      buildRequest: (_actor, target, ctx) => ({
        path: `/api/invitations/${ctx.seededRowId(target.id)}`,
      }),
      expectedRefusal: { kind: 'status', status: 404 },
    },
    {
      name: 'accept',
      method: 'POST',
      route: '/api/invitations/accept',
      httpKind: 'write',
      reaches: 'existing-row',
      qualification: 'owner-qualified',
      buildRequest: (_actor, target) => ({
        path: '/api/invitations/accept',
        body: { token: heldInvitationTokenFor(target.id) },
      }),
      expectedRefusal: { kind: 'status', status: 409 },
      targetMutated: (actor, target, ctx) => {
        const actorUser = signedInOwnerOf(runtime, actor.id).userId;
        const [readback] = querySql<{ still_pending: boolean; actor_rows: number }>(
          migrationDsn(),
          `SELECT (SELECT count(*)::int FROM invitations
                    WHERE id = :'invitation'::uuid AND tenant_id = :'target'::uuid
                      AND state = 'pending' AND accepted_by_user_id IS NULL) = 1 AS still_pending,
                  (SELECT count(*)::int FROM memberships
                    WHERE tenant_id = :'target'::uuid AND user_id = :'actor_user') AS actor_rows`,
          {
            tenantId: target.id,
            variables: { invitation: ctx.seededRowId(target.id), target: target.id, actor_user: actorUser },
          },
        );

        return readback === undefined || !readback.still_pending || readback.actor_rows !== 0;
      },
    },
    {
      name: 'lookup',
      method: 'POST',
      route: '/api/invitations/lookup',
      httpKind: 'read',
      reaches: 'existing-row',
      qualification: 'owner-qualified',
      auth: 'anonymous',
      buildRequest: (actor, target) => ({
        path: '/api/invitations/lookup',
        body: { token: `${target.id}.${secretHalfOf(heldInvitationTokenFor(actor.id))}` },
      }),
      buildOwnRequest: (actor) => ({
        path: '/api/invitations/lookup',
        body: { token: heldInvitationTokenFor(actor.id) },
      }),
      expectedRefusal: { kind: 'status', status: 404 },
      authenticated: false,
      publicJustification:
        'the invitee holds no account yet; the capability token is the authorisation (ADR-0021)',
      usesCapabilityToken: true,
    },
  ];
}

/**
 * The workspace endpoint attempt group: the registration whose methods are the five HTTP
 * attacks on the workspace routes, and the signed-in fixtures they run against. Built at
 * runtime because it needs the booted child and the two live sessions; the surface ids it
 * contributes are pinned in `EXPECTED_SURFACE_IDS`.
 */
export async function workspaceEndpointGroup(runtime: SignedInTenants): Promise<AttemptGroup> {
  const tokenFor = await tokenMinter(runtime);
  const seededRowId = (tenantId: string): string =>
    tenantId === runtime.a.tenantId ? ENDPOINT_WORKSPACE_A : ENDPOINT_WORKSPACE_B;

  const registration = endpointAccess({
    subject: 'WorkspaceEndpoints',
    table: 'workspaces',
    ownerColumn: 'tenant_id',
    reset: () => resetSignedInFixture(runtime),
    baseUrl: runtime.server.baseUrl,
    tokenFor,
    seededRowId,
    endpoints: WORKSPACE_ENDPOINTS,
  });

  return {
    registrations: [registration],
    fixtures: {
      tenantA: { id: runtime.a.tenantId, name: 'signed-in-tenant-a' },
      tenantB: { id: runtime.b.tenantId, name: 'signed-in-tenant-b' },
    },
  };
}

/**
 * The invitation endpoint attempt group (TASK-1b-10): the five invitation routes over the
 * SAME two signed-in operators and the same reset, with `invitations` as the table the
 * per-attempt census brackets and each tenant's seeded invitation as its addressed row.
 */
export async function invitationEndpointGroup(runtime: SignedInTenants): Promise<AttemptGroup> {
  const tokenFor = await tokenMinter(runtime);
  const seededRowId = (tenantId: string): string =>
    tenantId === runtime.a.tenantId ? ENDPOINT_INVITATION_A : ENDPOINT_INVITATION_B;

  const registration = endpointAccess({
    subject: 'InvitationEndpoints',
    table: 'invitations',
    ownerColumn: 'tenant_id',
    reset: () => resetSignedInFixture(runtime),
    baseUrl: runtime.server.baseUrl,
    tokenFor,
    seededRowId,
    endpoints: invitationEndpoints(runtime),
  });

  return {
    registrations: [registration],
    fixtures: {
      tenantA: { id: runtime.a.tenantId, name: 'signed-in-tenant-a' },
      tenantB: { id: runtime.b.tenantId, name: 'signed-in-tenant-b' },
    },
  };
}

/**
 * Every surface id this wave covers, hand-written so a battery quietly losing a method
 * fails. IN SORTED ORDER: the suite compares it against `covered.sort()`, and `repo:`
 * sorts before `route:`, so the ten route ids come last.
 */
export const EXPECTED_SURFACE_IDS = [
  // The three 1b tables (TASK-1b-03): eight shapes each — and since TASK-1b-10 the two
  // repository subjects beside them: `InvitationRepository` on `invitations` and
  // `MembershipRepository` on `memberships` (`invitation_workspaces` has no class of its own).
  // Uppercase sorts before lowercase, so `InvitationR…` < `InvitationW…` < `Invitations…`.
  'repo:InvitationRepository.create',
  'repo:InvitationRepository.findById',
  'repo:InvitationRepository.listForWorkspace',
  'repo:InvitationRepository.revoke',
  'repo:InvitationWorkspacesTableAccess.deleteAll',
  'repo:InvitationWorkspacesTableAccess.deleteOwnedBy',
  'repo:InvitationWorkspacesTableAccess.findAll',
  'repo:InvitationWorkspacesTableAccess.findOwnedBy',
  'repo:InvitationWorkspacesTableAccess.insertOwnedBy',
  'repo:InvitationWorkspacesTableAccess.reparentAll',
  'repo:InvitationWorkspacesTableAccess.updateAll',
  'repo:InvitationWorkspacesTableAccess.updateOwnedBy',
  'repo:InvitationsTableAccess.deleteAll',
  'repo:InvitationsTableAccess.deleteOwnedBy',
  'repo:InvitationsTableAccess.findAll',
  'repo:InvitationsTableAccess.findOwnedBy',
  'repo:InvitationsTableAccess.insertOwnedBy',
  'repo:InvitationsTableAccess.reparentAll',
  'repo:InvitationsTableAccess.updateAll',
  'repo:InvitationsTableAccess.updateOwnedBy',
  'repo:MembershipRepository.create',
  'repo:MembershipRepository.listForWorkspace',
  'repo:MembershipRepository.roleFor',
  'repo:MembershipRepository.workspaceIdsFor',
  'repo:MembershipsTableAccess.deleteAll',
  'repo:MembershipsTableAccess.deleteOwnedBy',
  'repo:MembershipsTableAccess.findAll',
  'repo:MembershipsTableAccess.findOwnedBy',
  'repo:MembershipsTableAccess.insertOwnedBy',
  'repo:MembershipsTableAccess.reparentAll',
  'repo:MembershipsTableAccess.updateAll',
  'repo:MembershipsTableAccess.updateOwnedBy',
  'repo:RlsFixtureRowsTableAccess.deleteAll',
  'repo:RlsFixtureRowsTableAccess.deleteOwnedBy',
  'repo:RlsFixtureRowsTableAccess.findAll',
  'repo:RlsFixtureRowsTableAccess.findOwnedBy',
  'repo:RlsFixtureRowsTableAccess.insertOwnedBy',
  'repo:RlsFixtureRowsTableAccess.reparentAll',
  'repo:RlsFixtureRowsTableAccess.updateAll',
  'repo:RlsFixtureRowsTableAccess.updateOwnedBy',
  // The third registered subject (TASK-002). Eight shapes, like the other two: no table
  // may decline one (F-342), and `tenant_memberships` answers all eight — the two
  // unqualified updates through `mutableValue`, because its only non-owner column is an
  // enum and the default literal is not a `tenant_role`.
  'repo:TenantMembershipsTableAccess.deleteAll',
  'repo:TenantMembershipsTableAccess.deleteOwnedBy',
  'repo:TenantMembershipsTableAccess.findAll',
  'repo:TenantMembershipsTableAccess.findOwnedBy',
  'repo:TenantMembershipsTableAccess.insertOwnedBy',
  'repo:TenantMembershipsTableAccess.reparentAll',
  'repo:TenantMembershipsTableAccess.updateAll',
  'repo:TenantMembershipsTableAccess.updateOwnedBy',
  'repo:TenantsTableAccess.deleteAll',
  'repo:TenantsTableAccess.deleteOwnedBy',
  'repo:TenantsTableAccess.findAll',
  'repo:TenantsTableAccess.findOwnedBy',
  'repo:TenantsTableAccess.insertOwnedBy',
  'repo:TenantsTableAccess.reparentAll',
  'repo:TenantsTableAccess.updateAll',
  'repo:TenantsTableAccess.updateOwnedBy',
  // The fourth table (TASK-011): the methods of the first real repository, attempted
  // through the class itself — five, plus `listForUser` (TASK-1b-06, the membership join) —
  // and the eight shapes on `workspaces`.
  'repo:WorkspaceRepository.archive',
  'repo:WorkspaceRepository.create',
  'repo:WorkspaceRepository.findById',
  'repo:WorkspaceRepository.list',
  'repo:WorkspaceRepository.listForUser',
  'repo:WorkspaceRepository.rename',
  'repo:WorkspacesTableAccess.deleteAll',
  'repo:WorkspacesTableAccess.deleteOwnedBy',
  'repo:WorkspacesTableAccess.findAll',
  'repo:WorkspacesTableAccess.findOwnedBy',
  'repo:WorkspacesTableAccess.insertOwnedBy',
  'repo:WorkspacesTableAccess.reparentAll',
  'repo:WorkspacesTableAccess.updateAll',
  'repo:WorkspacesTableAccess.updateOwnedBy',
  // TASK-014/015: the authenticated workspace routes, attacked as HTTP by a second
  // signed-in operator — four, plus `GET /api/workspaces/:workspaceId` and the `:id` →
  // `:workspaceId` rename (TASK-1b-06, D-07) — and since TASK-1b-10 the five invitation
  // routes, one of them `@Public()`. `route:` ids sort after every `repo:` id, and among
  // them by method then path (`DELETE` < `GET` < `PATCH` < `POST`).
  'route:DELETE /api/invitations/:id',
  'route:GET /api/invitations',
  'route:GET /api/workspaces',
  'route:GET /api/workspaces/:workspaceId',
  'route:PATCH /api/workspaces/:workspaceId',
  'route:POST /api/invitations',
  'route:POST /api/invitations/accept',
  'route:POST /api/invitations/lookup',
  'route:POST /api/workspaces',
  'route:POST /api/workspaces/:workspaceId/archive',
] as const;
