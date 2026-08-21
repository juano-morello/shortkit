/**
 * Contract: docs/contracts/workspace-authorization.md, rls-policy-template.md, isolation-coverage.md
 * ADR: adr-0015-user-tenant-cardinality.md, adr-0062-workspace-membership-is-a-second-table.md,
 *      adr-0003-rls-policy-template-and-roles.md, adr-0004-schema-layout-and-migrations.md,
 *      adr-0019-tenant-scoped-table-enumeration.md, adr-0049-context-flags-are-never-cast-directly.md
 * Produced by: TASK-1b-03
 *
 * ============================================================================
 * THREE OBLIGATIONS, ONE MIGRATION, ONE COMMIT (GC-A, F-239).
 * ============================================================================
 *
 * 1. `tenant_id` declared through `TENANT_ID_COLUMN_SQL` (`db/rls.ts`), character for
 *    character: `uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE`.
 * 2. The output of `tenantScopedPolicies('memberships')` hand-appended to migration `0003`,
 *    because Drizzle Kit generates no policy DDL. Template-shaped, template UNCHANGED: two
 *    policies. No bespoke policy: nothing reads this table outside a tenant context.
 * 3. A `registerTenantScopedSurfaces()` call in `test/isolation/registrations.ts`
 *    (`MembershipsTableAccess`; the repository subject arrives with the repository, TASK-1b-05).
 *
 * Splitting any of the three into a follow-up is a defect and not a sequencing choice:
 * `ALTER DEFAULT PRIVILEGES` grants `shortkit_app` full DML on every table the migrator
 * creates, so this table is writable by every tenant from the moment it exists.
 *
 * WHAT THIS TABLE IS. The workspace-level membership ADR-0015 separates from tenant-level
 * membership: `tenant_memberships` holds the `TenantRole` (one row per user, ever);
 * `memberships` holds the `WorkspaceRole` (one row per user per workspace). Two tables at
 * two levels, never a nullable `workspace_id` on one (ADR-0015, alternatives table).
 *
 * `UNIQUE (workspace_id, user_id)` IS THE DECISION. One role per user per workspace, and it
 * is what `INSERT ... ON CONFLICT (workspace_id, user_id) DO NOTHING` keys on when an
 * accept meets a membership that already exists (D-12: the existing role wins).
 *
 * THE COMPOSITE FOREIGN KEY IS THE ISOLATION ARGUMENT, NOT DECORATION (ADR-0062).
 * `FOREIGN KEY (workspace_id, tenant_id) REFERENCES workspaces (id, tenant_id)` rather than
 * `workspace_id REFERENCES workspaces(id)`. Referential checks run with row security
 * BYPASSED, so a plain FK is satisfied by ANY tenant's workspace id: a membership row
 * carrying tenant A's `tenant_id` and tenant B's `workspace_id` would be admitted by the
 * policy (its tenant_id matches the flag) and by the FK (the workspace exists). The
 * composite form makes that row a constraint violation at the database, whatever an
 * application check did. `workspaces` gained `UNIQUE (id, tenant_id)` in the same
 * migration to be its target; that is the only change 1b makes to `workspaces`.
 *
 * `user_id` IS `text`, referencing Better Auth's `user(id)`, for the reason
 * `tenant-memberships.ts` gives: Better Auth generates its own non-uuid ids. `ON DELETE
 * CASCADE` from `"user"` is the one path across the ADR-0050 grant boundary and it runs as a
 * referential action (rls-policy-template.md, invariant 7).
 *
 * `workspace_role` IS SOURCED FROM `WORKSPACE_ROLES` in the contracts package, exactly as
 * `tenant_role` sources from `TENANT_ROLES`, so the database enum and the branded type
 * cannot disagree about the value set. `viewer` is in the enum; nothing in 1b's UI offers
 * it (workspace-authorization.md).
 *
 * NO BACKFILL FOR PRE-EXISTING WORKSPACES, AND WHY THAT IS A RULING RATHER THAN AN OMISSION
 * (ADR-0062, D-10). An `INSERT ... SELECT` from `workspaces` inside migration `0003` would
 * run as `shortkit_migrator`, which is `NOBYPASSRLS` under `FORCE ROW LEVEL SECURITY` with
 * no `app.tenant_id` set: it reads zero rows, inserts nothing, and reports success:
 * F-236's shape. There is no deploy target (ADR-0030); a compose volume carrying 1a rows is
 * reset (`docker compose down -v`, ADR-0032).
 */
import { foreignKey, index, pgEnum, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { WORKSPACE_ROLES } from '@shortkit/contracts';

import { authUser } from './auth';
import { tenants } from './tenants';
import { workspaces } from './workspaces';

/** `workspace_admin | member | viewer`, Amendment A-1. Shared with `invitation_workspaces`. */
export const workspaceRole = pgEnum('workspace_role', WORKSPACE_ROLES);

export const memberships = pgTable(
  'memberships',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    workspaceId: uuid('workspace_id').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => authUser.id, { onDelete: 'cascade' }),
    role: workspaceRole('role').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('memberships_workspace_user_unique').on(table.workspaceId, table.userId),
    foreignKey({
      name: 'memberships_workspace_tenant_fk',
      columns: [table.workspaceId, table.tenantId],
      foreignColumns: [workspaces.id, workspaces.tenantId],
    }).onDelete('cascade'),
    // Added 2026-08-19 (debt sweep, ledger 1b-W1-11, migration 0004): `user_id` leads no
    // index (it is only the SECOND column of the UNIQUE above) so `listForUser`'s join
    // (`m.user_id = $user`, TASK-1b-06) and the `ON DELETE CASCADE` walk from `"user"`
    // both scan. `tenant_id` already has its hand-appended index in migration 0003.
    index('memberships_user_id_idx').on(table.userId),
  ],
);
