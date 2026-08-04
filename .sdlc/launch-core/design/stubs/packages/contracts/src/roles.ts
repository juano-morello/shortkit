/**
 * Contract: design/contracts/workspace-authorization.md
 * ADR: adr-0015-user-tenant-cardinality.md
 * Produced by: TASK-016
 *
 * Role set is FIXED by refinement.md Amendment A-1. Not open for reinterpretation.
 * Lives in packages/contracts because apps/web renders role names (TASK-019).
 */

export const TENANT_ROLES = ['owner', 'admin'] as const;
export type TenantRole = (typeof TENANT_ROLES)[number];

export const WORKSPACE_ROLES = ['workspace_admin', 'member', 'viewer'] as const;
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

/** Rank is data, in one table. No conditional anywhere else compares role names. */
export const WORKSPACE_ROLE_RANK: Record<WorkspaceRole, number> = {
  workspace_admin: 30,
  member: 20,
  viewer: 10,
};

export const TENANT_ROLE_RANK: Record<TenantRole, number> = {
  owner: 20,
  admin: 10,
};

export function roleRank(role: WorkspaceRole): number {
  return WORKSPACE_ROLE_RANK[role];
}

export function tenantRoleRank(role: TenantRole): number {
  return TENANT_ROLE_RANK[role];
}

export function meetsWorkspaceRole(actual: WorkspaceRole, minimum: WorkspaceRole): boolean {
  return roleRank(actual) >= roleRank(minimum);
}

export function meetsTenantRole(actual: TenantRole, minimum: TenantRole): boolean {
  return tenantRoleRank(actual) >= tenantRoleRank(minimum);
}

/**
 * Roles TASK-022's picker offers. `viewer` is deliberately absent: nothing in
 * launch-core grants it outside test fixtures (TASK-016, TASK-019, TASK-021).
 * The API accepts `viewer`; the UI does not offer it.
 */
export const INVITABLE_WORKSPACE_ROLES = ['workspace_admin', 'member'] as const;
