/**
 * Contract: docs/contracts/auth-contracts.md (tenant membership),
 *           docs/contracts/workspace-authorization.md (workspace membership)
 * ADR: adr-0048-role-brands-are-applied-after-parsing.md,
 *      adr-0015-user-tenant-cardinality.md, adr-0023-branded-role-types.md
 * Produced by: TASK-001 (tenant pair), TASK-1b-01 (workspace pair)
 *
 * ============================================================================
 * TWO TYPES PER SHAPE. THE WIRE TYPE IS UNBRANDED; THE DOMAIN TYPE IS BRANDED.
 * ============================================================================
 *
 * `roles.ts`'s RULE comment, on `INVITABLE_WORKSPACE_ROLES`, states the rule: every zod
 * enum sources from an unbranded array, and branding happens AFTER parsing, via
 * `asTenantRole`. A brand is a compile-time claim that a value was validated somewhere; a
 * value arriving in a request body has been nowhere. ADR-0048 is where that rule became a
 * shape.
 *
 * Any contract in this package whose `z.infer` carries a role brand is a defect.
 * `workspaces/` (TASK-012) and `invitations/` (TASK-1b-01) follow this same split, and the
 * workspace-membership pair at the bottom of this file is the second instance of it.
 */
import { z } from 'zod';

import { idContract } from '../pagination';
import { TENANT_ROLES, WORKSPACE_ROLES, asTenantRole, asWorkspaceRole } from '../roles';
import type { TenantRole, WorkspaceRole } from '../roles';

/**
 * The wire shape. ADR-0015 fixes all five fields.
 *
 * `id` and `tenantId` reuse `idContract` rather than redeclaring a uuid check.
 * `userId` DOES NOT: it is Better Auth's own id and is not a uuid, which is why
 * `tenant_memberships.user_id` is the one non-uuid foreign key in the schema.
 *
 * `role` is `z.enum(TENANT_ROLES)`: the unbranded array. `member` is rank 0 and grants
 * nothing at tenant level (Amendment A-8).
 */
export const tenantMembershipContract = z.object({
  id: idContract,
  tenantId: idContract,
  userId: z.string().min(1),
  role: z.enum(TENANT_ROLES),
  createdAt: z.string().datetime(),
});

/** What `z.infer` gives: `role` is `TenantRoleValue`, unbranded. Safe at a JSON boundary. */
export type TenantMembershipWire = z.infer<typeof tenantMembershipContract>;

/**
 * The domain shape. DECLARED, not inferred, because its `role` is branded and an
 * inferred branded type is what ADR-0023 forbids at a JSON boundary.
 */
export interface TenantMembership {
  readonly id: string;
  readonly tenantId: string;
  readonly userId: string;
  readonly role: TenantRole;
  readonly createdAt: string;
}

/**
 * Parses, then brands. THE ONE SANCTIONED WAY TO OBTAIN A `TenantMembership`, and the
 * first caller `asTenantRole` has ever had.
 *
 * Throws a `ZodError` when `value` does not satisfy `tenantMembershipContract`, and an
 * `Error` from `asTenantRole` if the parsed role is somehow not a member of
 * `TENANT_ROLES`, which the enum already excludes, and which is checked again anyway so
 * the brand keeps meaning "checked" rather than "cast".
 */
export function parseTenantMembership(value: unknown): TenantMembership {
  const wire = tenantMembershipContract.parse(value);

  return brandTenantMembership(wire);
}

/** Kept importable so a caller that has already parsed can brand without re-parsing. */
export function brandTenantMembership(wire: TenantMembershipWire): TenantMembership {
  return {
    id: wire.id,
    tenantId: wire.tenantId,
    userId: wire.userId,
    role: asTenantRole(wire.role),
    createdAt: wire.createdAt,
  };
}

/**
 * ============================================================================
 * THE WORKSPACE-MEMBERSHIP PAIR. Same split, second table (TASK-1b-01, item 1b).
 * ============================================================================
 *
 * The wire shape of one `memberships` row (D-11: `id`, `tenant_id`, `workspace_id`,
 * `user_id`, `role workspace_role`, `created_at`). NO 1b ROUTE RETURNS IT: the caller's
 * role travels as `workspaceRole` on `workspaceContract` (TASK-1b-06) and on the invitation
 * shapes. It exists so `MembershipRepository` (TASK-1b-05) brands a row through one
 * sanctioned path: `parseWorkspaceMembership` is `asWorkspaceRole`'s first caller, the
 * way `parseTenantMembership` was `asTenantRole`'s.
 *
 * `tenantId` is on the wire type because the row carries it and the repository parses the
 * row; it is not because any client reads it. `userId` is again Better Auth's own id.
 */
export const workspaceMembershipContract = z.object({
  id: idContract,
  tenantId: idContract,
  workspaceId: idContract,
  userId: z.string().min(1),
  role: z.enum(WORKSPACE_ROLES),
  createdAt: z.string().datetime(),
});

/** What `z.infer` gives: `role` is `WorkspaceRoleValue`, unbranded. */
export type WorkspaceMembershipWire = z.infer<typeof workspaceMembershipContract>;

/** The domain shape. DECLARED, not inferred, because its `role` is branded. */
export interface WorkspaceMembership {
  readonly id: string;
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly userId: string;
  readonly role: WorkspaceRole;
  readonly createdAt: string;
}

/**
 * Parses, then brands. THE ONE SANCTIONED WAY TO OBTAIN A `WorkspaceMembership`. Throws a
 * `ZodError` when `value` does not satisfy `workspaceMembershipContract`, and an `Error`
 * from `asWorkspaceRole` if the parsed role is somehow outside `WORKSPACE_ROLES`, checked
 * again so the brand keeps meaning "checked" rather than "cast".
 */
export function parseWorkspaceMembership(value: unknown): WorkspaceMembership {
  const wire = workspaceMembershipContract.parse(value);

  return brandWorkspaceMembership(wire);
}

/** Kept importable so a caller that has already parsed can brand without re-parsing. */
export function brandWorkspaceMembership(wire: WorkspaceMembershipWire): WorkspaceMembership {
  return {
    id: wire.id,
    tenantId: wire.tenantId,
    workspaceId: wire.workspaceId,
    userId: wire.userId,
    role: asWorkspaceRole(wire.role),
    createdAt: wire.createdAt,
  };
}
