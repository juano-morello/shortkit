/**
 * Contract: design/contracts/workspace-authorization.md
 * ADR: adr-0015-user-tenant-cardinality.md
 * Produced by: TASK-016
 *
 * Role sets are FIXED by refinement amendments. Not open for reinterpretation.
 *   WORKSPACE_ROLES  Amendment A-1, unchanged.
 *   TENANT_ROLES     Amendment A-8 (2026-08-04), which SUPERSEDES A-1's tenant enum.
 * Lives in packages/contracts because apps/web renders role names (TASK-019).
 *
 * ============================================================================
 * WARNING: 'member' is a member of BOTH enums and is assignable to both types.
 * TypeScript will NOT catch assertTenant('member') written for a workspace check.
 * Mitigations are normative in workspace-authorization.md:
 *   1. tenant-role and workspace-role mutation are distinct routes, distinct guards
 *   2. request bodies name the enum: `tenantRole` / `workspaceRole`, never `role`
 *   3. tenantRoleRank and roleRank are separate functions that THROW on an unknown key
 * ============================================================================
 */

export const TENANT_ROLES = ['owner', 'admin', 'member'] as const;
export type TenantRole = (typeof TENANT_ROLES)[number];

export const WORKSPACE_ROLES = ['workspace_admin', 'member', 'viewer'] as const;
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

/** Rank is data, in one table. No conditional anywhere else compares role names. */
export const WORKSPACE_ROLE_RANK: Record<WorkspaceRole, number> = {
  workspace_admin: 30,
  member: 20,
  viewer: 10,
};

/**
 * Tenant `member` is rank 0 and grants NOTHING at tenant level (Amendment A-8).
 * Every @RequireTenantRole in launch-core has a minimum of 'admin' or 'owner', so
 * `member` passes none of them. Invitees receive it; their access comes entirely from
 * workspace roles.
 */
export const TENANT_ROLE_RANK: Record<TenantRole, number> = {
  owner: 20,
  admin: 10,
  member: 0,
};

/** Throws on an unknown key rather than returning undefined. See the 'member' warning. */
export function roleRank(_role: WorkspaceRole): number {
  throw new Error('not implemented');
}

/** Throws on an unknown key rather than returning undefined. See the 'member' warning. */
export function tenantRoleRank(_role: TenantRole): number {
  throw new Error('not implemented');
}

export function meetsWorkspaceRole(actual: WorkspaceRole, minimum: WorkspaceRole): boolean {
  return roleRank(actual) >= roleRank(minimum);
}

export function meetsTenantRole(actual: TenantRole, minimum: TenantRole): boolean {
  return tenantRoleRank(actual) >= tenantRoleRank(minimum);
}

/**
 * The tenant role an invitee receives on accepting (Amendment A-8, ADR-0015).
 * NOT 'admin': that gated POST /api/workspaces and every future tenant-level surface,
 * with no way for the inviting operator to see or revoke it.
 */
export const INVITEE_TENANT_ROLE: TenantRole = 'member';

/** Only a tenant owner may grant or revoke any tenant role (F-011). */
export const TENANT_ROLE_GRANT_MINIMUM: TenantRole = 'owner';

/**
 * Roles TASK-022's picker offers. `viewer` is deliberately absent: nothing in
 * launch-core grants it outside test fixtures (TASK-016, TASK-019, TASK-021).
 * The API accepts `viewer`; the UI does not offer it.
 */
export const INVITABLE_WORKSPACE_ROLES = ['workspace_admin', 'member'] as const;
