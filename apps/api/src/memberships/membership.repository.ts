/**
 * Contract: docs/contracts/workspace-authorization.md ("Roles": `WorkspaceRole` lives in
 *           `memberships`), tenant-context.md (invariant 4: `tenantDb()` throws outside a
 *           context), isolation-coverage.md ("qualification is derived from the statement")
 * ADR: adr-0062-workspace-membership-is-a-second-table.md, adr-0002, adr-0003, adr-0020
 *      (`@TenantScopedRepository()`), adr-0048 (rows brand through the contracts' one path)
 * Produced by: TASK-1b-05
 *
 * The workspace-level membership rows: one per user per workspace, carrying the caller's
 * `WorkspaceRole` (`db/schema/memberships.ts`, TASK-1b-03). Written the way
 * `WorkspaceRepository` is written, and for the same reasons — that file's docblock is the
 * fuller statement; the two rules that matter here:
 *
 * IT REACHES THE DATABASE THROUGH `tenantDb()` AND NOTHING ELSE. The ambient handle of the
 * open tenant transaction, which THROWS `TenantContextMissingError` outside one. This is what
 * makes the authorization interceptor fail closed: a decorated route with no transaction
 * cannot read a row, so it cannot pass.
 *
 * EVERY STATEMENT IS OWNER-QUALIFIED EVEN THOUGH THE POLICY ALREADY SCOPES IT. Every WHERE
 * carries `tenant_id = currentTenantId()` and the insert sets `tenant_id` explicitly (F-302:
 * two independent scopes, the policy and the predicate, both have to be wrong for a row to
 * cross a tenant). The unit spec asserts it over the compiled SQL; the isolation suite
 * attempts every method across tenants (TASK-1b-10 registers them).
 *
 * ROWS BRAND THROUGH `brandWorkspaceMembership` (ADR-0048), so `role` reaches a caller as a
 * `WorkspaceRole` and never as a bare string; `roleFor` brands through `asWorkspaceRole`,
 * the second of that function's two sanctioned callers (`packages/contracts/src/roles.ts`).
 *
 * WHAT IS NOT HERE. No update path — 1b has no route that changes a workspace role. No
 * `ON CONFLICT` write — the accept path (D-12, `INSERT ... ON CONFLICT (workspace_id,
 * user_id) DO NOTHING`) belongs to `acceptInvitationByCapabilityToken` (TASK-1b-04), which
 * runs outside the Nest graph and issues its own statement. `create` is the plain insert
 * `POST /api/workspaces` uses for the creator's `workspace_admin` row (D-10, TASK-1b-06); a
 * duplicate raises `23505` and propagates.
 */
import { Injectable } from '@nestjs/common';
import { and, asc, eq } from 'drizzle-orm';
import { asWorkspaceRole, brandWorkspaceMembership } from '@shortkit/contracts';
import type { WorkspaceMembership, WorkspaceRole } from '@shortkit/contracts';

import { memberships } from '../db/schema';
import { currentTenantId, tenantDb, TenantScopedRepository } from '../tenancy/tenant-context';

export interface CreateMembershipInput {
  readonly workspaceId: string;
  readonly userId: string;
  readonly role: WorkspaceRole;
}

/** One entry of `workspaceIdsFor`: the workspace and the caller's role in it. */
export interface WorkspaceRoleEntry {
  readonly workspaceId: string;
  readonly role: WorkspaceRole;
}

/**
 * The same shape `assertUuid` accepts. A workspace id that is not a uuid names no row this
 * tenant owns, so it is answered as "no membership" here rather than reaching Postgres and
 * raising `22P02`, which the filter would turn into a 500 for a client's malformed reference.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The drizzle row, `createdAt` a `Date`; the wire contract carries it as an ISO string. */
type MembershipRow = typeof memberships.$inferSelect;

function toMembership(row: MembershipRow): WorkspaceMembership {
  return brandWorkspaceMembership({
    id: row.id,
    tenantId: row.tenantId,
    workspaceId: row.workspaceId,
    userId: row.userId,
    role: row.role,
    createdAt: row.createdAt.toISOString(),
  });
}

@TenantScopedRepository()
@Injectable()
export class MembershipRepository {
  /**
   * The caller's role in one workspace, or `null` for no membership — which is also the
   * answer for another tenant's workspace (invisible under RLS and to the predicate alike)
   * and for a non-uuid. The authorizer turns `null` into the contract's 404.
   */
  async roleFor(workspaceId: string, userId: string): Promise<WorkspaceRole | null> {
    if (!UUID.test(workspaceId)) {
      return null;
    }

    const [row] = await tenantDb()
      .select({ role: memberships.role })
      .from(memberships)
      .where(
        and(
          eq(memberships.tenantId, currentTenantId()),
          eq(memberships.workspaceId, workspaceId),
          eq(memberships.userId, userId),
        ),
      )
      .limit(1);

    return row === undefined ? null : asWorkspaceRole(row.role);
  }

  /**
   * Every workspace the user holds a membership in, with the role. What
   * `GET /api/workspaces` filters by (D-10, TASK-1b-06). Ordered by workspace id so two calls
   * agree; the list route orders the workspaces themselves.
   */
  async workspaceIdsFor(userId: string): Promise<WorkspaceRoleEntry[]> {
    const rows = await tenantDb()
      .select({ workspaceId: memberships.workspaceId, role: memberships.role })
      .from(memberships)
      .where(and(eq(memberships.tenantId, currentTenantId()), eq(memberships.userId, userId)))
      .orderBy(asc(memberships.workspaceId));

    return rows.map((row) => ({ workspaceId: row.workspaceId, role: asWorkspaceRole(row.role) }));
  }

  /**
   * The plain insert. `tenant_id` set explicitly from the context: the policy's WITH CHECK
   * would refuse a wrong one, the composite foreign key `(workspace_id, tenant_id) →
   * workspaces (id, tenant_id)` refuses another tenant's workspace id at the database
   * whatever else happened (ADR-0062), and the predicate says which tenant this is.
   */
  async create(input: CreateMembershipInput): Promise<WorkspaceMembership> {
    const [row] = await tenantDb()
      .insert(memberships)
      .values({
        tenantId: currentTenantId(),
        workspaceId: input.workspaceId,
        userId: input.userId,
        role: input.role,
      })
      .returning();

    if (row === undefined) {
      // RETURNING on a row the WITH CHECK admitted always yields it; reaching here means
      // the driver answered something this class does not understand.
      throw new Error('memberships insert returned no row.');
    }

    return toMembership(row);
  }

  /** Every membership row of one workspace. Member management (not built in 1b) reads it. */
  async listForWorkspace(workspaceId: string): Promise<WorkspaceMembership[]> {
    if (!UUID.test(workspaceId)) {
      return [];
    }

    const rows = await tenantDb()
      .select()
      .from(memberships)
      .where(and(eq(memberships.tenantId, currentTenantId()), eq(memberships.workspaceId, workspaceId)))
      .orderBy(asc(memberships.createdAt), asc(memberships.id));

    return rows.map(toMembership);
  }
}
