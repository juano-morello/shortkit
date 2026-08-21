/**
 * Contract: docs/contracts/invitation-tokens.md, workspace-authorization.md, rls-policy-template.md,
 *           isolation-coverage.md
 * ADR: adr-0021-anonymous-routes-reach-tenant-data-through-a-capability-token.md,
 *      adr-0062-workspace-membership-is-a-second-table.md,
 *      adr-0003-rls-policy-template-and-roles.md, adr-0004-schema-layout-and-migrations.md,
 *      adr-0019-tenant-scoped-table-enumeration.md, adr-0049-context-flags-are-never-cast-directly.md
 * Produced by: TASK-1b-03
 *
 * ============================================================================
 * THREE OBLIGATIONS, ONE MIGRATION, ONE COMMIT (GC-A, F-239).
 * ============================================================================
 *
 * 1. `tenant_id` declared through `TENANT_ID_COLUMN_SQL` (`db/rls.ts`), character for
 *    character.
 * 2. The output of `tenantScopedPolicies('invitation_workspaces')` hand-appended to
 *    migration `0003`. Template UNCHANGED, two policies, no bespoke policy.
 * 3. A `registerTenantScopedSurfaces()` call in `test/isolation/registrations.ts`
 *    (`InvitationWorkspacesTableAccess`).
 *
 * WHAT THIS TABLE IS. One invitation names a SET of workspaces, each at a role
 * (`workspaces: [{ workspaceId, workspaceRole }]`, min 1, max 20; D-13). This is that
 * set, one row per named workspace; on accept, each row becomes a `memberships` row for
 * the accepting user at this role (D-12: `ON CONFLICT DO NOTHING`, an existing membership's
 * role wins).
 *
 * `tenant_id` IS CARRIED HERE EVEN THOUGH `invitation_id` ALREADY IMPLIES IT. Every
 * tenant-scoped table carries its own `tenant_id` and its own policy set (ADR-0003,
 * ADR-0019): RLS does not follow a join, so a table scoped "through its parent" is a table
 * scoped by nothing. And the column is what the composite foreign key below needs.
 *
 * `FOREIGN KEY (workspace_id, tenant_id) REFERENCES workspaces (id, tenant_id)`: THE
 * SAME ARGUMENT `memberships.ts` MAKES (ADR-0062). Referential checks bypass row security,
 * so a plain FK to `workspaces(id)` would let an invitation in tenant A name a workspace of
 * tenant B; the composite form refuses that row at the database. `POST /api/invitations`
 * answers 404 for a workspace the caller does not admin (D-09) long before this is
 * reached; the constraint is the floor under that check, not the check.
 *
 * `invitation_id ... ON DELETE CASCADE`: the parent invitation owns these rows outright.
 * There is no delete route in 1b (revoke is a state change), so the cascade is reached
 * only by tenant erasure through the parent, and by `tenants(id)` directly, through the
 * template column, which is what ADR-0019's residue check depends on.
 *
 * `UNIQUE (invitation_id, workspace_id)`: one role per workspace per invitation. The
 * contract refuses duplicate `workspaceId`s in the request body (D-13); this is the
 * database saying the same thing.
 */
import { foreignKey, index, pgTable, unique, uuid } from 'drizzle-orm/pg-core';

import { invitations } from './invitations';
import { workspaceRole } from './memberships';
import { tenants } from './tenants';
import { workspaces } from './workspaces';

export const invitationWorkspaces = pgTable(
  'invitation_workspaces',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    invitationId: uuid('invitation_id')
      .notNull()
      .references(() => invitations.id, { onDelete: 'cascade' }),
    workspaceId: uuid('workspace_id').notNull(),
    role: workspaceRole('role').notNull(),
  },
  (table) => [
    unique('invitation_workspaces_invitation_workspace_unique').on(
      table.invitationId,
      table.workspaceId,
    ),
    foreignKey({
      name: 'invitation_workspaces_workspace_tenant_fk',
      columns: [table.workspaceId, table.tenantId],
      foreignColumns: [workspaces.id, workspaces.tenantId],
    }).onDelete('cascade'),
    // Added 2026-08-19 (debt sweep, ledger 1b-W1-11, migration 0004): `workspace_id` is
    // only the SECOND column of the UNIQUE above, so the composite-FK cascade from
    // `workspaces` and the invitation list's workspace filter scan without this. The
    // cascade from `invitations(id)` is covered by the UNIQUE's leading column;
    // `tenant_id` has its hand-appended index in migration 0003.
    index('invitation_workspaces_workspace_id_idx').on(table.workspaceId),
  ],
);
