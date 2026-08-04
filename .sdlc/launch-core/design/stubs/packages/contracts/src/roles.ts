/**
 * Contract: design/contracts/workspace-authorization.md
 * ADR: adr-0015-user-tenant-cardinality.md, adr-0023-branded-role-types.md
 * Produced by: TASK-016
 *
 * Role sets are FIXED by refinement amendments. Not open for reinterpretation.
 *   WORKSPACE_ROLES  Amendment A-1, unchanged.
 *   TENANT_ROLES     Amendment A-8 (2026-08-04), which SUPERSEDES A-1's tenant enum.
 * Lives in packages/contracts because apps/web renders role names (TASK-019).
 *
 * ============================================================================
 * BOTH ROLE TYPES ARE NOMINALLY BRANDED. Juano's ruling, 2026-08-04 (F-023).
 * ============================================================================
 *
 * `member` is a value in BOTH enums. A variable typed TenantRole was already not
 * assignable to WorkspaceRole ('owner' and 'admin' are not members of it), so confusing
 * ctx.tenantRole with ctx.workspaceRole was ALREADY a compile error.
 *
 * THE BARE LITERAL WAS THE HOLE. A Form B handler meaning
 *     assert(resource.workspaceId, 'member')
 * that writes
 *     assertTenant('member')
 * got a check passing for every authenticated user in the tenant, letting a tenant
 * member with access to W1 write in W2.
 *
 * With a REQUIRED brand, no bare literal is assignable to either type. Call sites use
 * the pre-branded constants below, so the ergonomic cost is one property access.
 */

declare const roleBrand: unique symbol;

type Branded<TValue extends string, TBrand extends string> = TValue & {
  readonly [roleBrand]: TBrand;
};

export const TENANT_ROLES = ['owner', 'admin', 'member'] as const;
export const WORKSPACE_ROLES = ['workspace_admin', 'member', 'viewer'] as const;

/** Unbranded unions. Use these ONLY for storage columns and zod enum sources. */
export type TenantRoleValue = (typeof TENANT_ROLES)[number];
export type WorkspaceRoleValue = (typeof WORKSPACE_ROLES)[number];

export type TenantRole = Branded<TenantRoleValue, 'tenant'>;
export type WorkspaceRole = Branded<WorkspaceRoleValue, 'workspace'>;

/**
 * Belt and braces alongside the brand: the minimum for a tenant-role check can never be
 * `member`, which is rank 0 and authorises every user in the tenant.
 * workspace-authorization.md already stated that no @RequireTenantRole in launch-core
 * has a minimum below `admin`. This makes it a compile error rather than a rule.
 */
export type AuthorisingTenantRole = Branded<'owner' | 'admin', 'tenant'>;

/** Pre-branded constants. Call sites use these, never a bare literal. */
export const TENANT_ROLE = {
  owner: 'owner' as Branded<'owner', 'tenant'>,
  admin: 'admin' as Branded<'admin', 'tenant'>,
  member: 'member' as Branded<'member', 'tenant'>,
} as const;

export const WORKSPACE_ROLE = {
  workspace_admin: 'workspace_admin' as Branded<'workspace_admin', 'workspace'>,
  member: 'member' as Branded<'member', 'workspace'>,
  viewer: 'viewer' as Branded<'viewer', 'workspace'>,
} as const;

/**
 * THE ONLY SANCTIONED CASTS. Used at the two boundaries where a role arrives as a plain
 * string: a Drizzle row and a zod parse. Both validate membership before branding.
 * Nothing else in the codebase casts to a role type; an `as TenantRole` anywhere else
 * is a defect.
 */
export function asTenantRole(_value: string): TenantRole {
  throw new Error('not implemented');
}

export function asWorkspaceRole(_value: string): WorkspaceRole {
  throw new Error('not implemented');
}

/** Rank is data, in one table. No conditional anywhere else compares role names. */
export const WORKSPACE_ROLE_RANK: Record<WorkspaceRoleValue, number> = {
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
export const TENANT_ROLE_RANK: Record<TenantRoleValue, number> = {
  owner: 20,
  admin: 10,
  member: 0,
};

/** Throws on an unknown key rather than returning undefined. */
export function roleRank(_role: WorkspaceRole): number {
  throw new Error('not implemented');
}

/** Throws on an unknown key rather than returning undefined. */
export function tenantRoleRank(_role: TenantRole): number {
  throw new Error('not implemented');
}

export function meetsWorkspaceRole(actual: WorkspaceRole, minimum: WorkspaceRole): boolean {
  return roleRank(actual) >= roleRank(minimum);
}

/** `minimum` is AuthorisingTenantRole: 'member' cannot be passed, by type. */
export function meetsTenantRole(actual: TenantRole, minimum: AuthorisingTenantRole): boolean {
  return tenantRoleRank(actual) >= tenantRoleRank(minimum);
}

/**
 * The tenant role an invitee receives on accepting (Amendment A-8, ADR-0015).
 * NOT 'admin': that gated POST /api/workspaces and every future tenant-level surface,
 * with no way for the inviting operator to see or revoke it.
 */
export const INVITEE_TENANT_ROLE: TenantRole = TENANT_ROLE.member;

/** Only a tenant owner may grant or revoke any tenant role (F-011). */
export const TENANT_ROLE_GRANT_MINIMUM: AuthorisingTenantRole = TENANT_ROLE.owner;

/**
 * Roles TASK-022's picker offers. `viewer` is deliberately absent: nothing in
 * launch-core grants it outside test fixtures (TASK-016, TASK-019, TASK-021).
 * The API accepts `viewer`; the UI does not offer it.
 */
export const INVITABLE_WORKSPACE_ROLES = [
  WORKSPACE_ROLE.workspace_admin,
  WORKSPACE_ROLE.member,
] as const;
