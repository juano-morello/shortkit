/**
 * Contract: docs/contracts/workspace-authorization.md
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

/**
 * EXPORTED, and `declare` so it emits no runtime value.
 *
 * A module-local `declare const roleBrand` referenced by an exported type alias is a
 * TS4023 declaration-emit failure ("cannot be named"). ADR-0005 has apps/web import
 * this package as source under `composite: true`, which implies `declaration: true`,
 * so the non-exported form would have failed the first `pnpm typecheck` in TASK-001.
 */
export declare const roleBrand: unique symbol;

export type Branded<TValue extends string, TBrand extends string> = TValue & {
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
 * is a defect, and TASK-056 greps for one.
 *
 * The parameter type REJECTS ALREADY-BRANDED INPUT, so these cannot be used to launder
 * one role type into the other: `assert(wsId, asWorkspaceRole(ctx.tenantRole))` is a
 * compile error rather than a re-brand. It could not reproduce the Form B escalation
 * ADR-0023 closed, but leaving the path open would have been the obvious way to
 * "fix" a brand mismatch under time pressure.
 */
/** Exported for the same TS4023 reason as `roleBrand`: it appears in exported signatures. */
export type Unbranded<T> = T extends { readonly [roleBrand]: unknown } ? never : T;

export function asTenantRole<T extends string>(_value: Unbranded<T>): TenantRole {
  if (!(TENANT_ROLES as readonly string[]).includes(_value)) {
    throw new Error(`not a tenant role: ${_value}`);
  }

  return _value as unknown as TenantRole;
}

export function asWorkspaceRole<T extends string>(_value: Unbranded<T>): WorkspaceRole {
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

/**
 * Throws on an unknown key rather than returning undefined. Guards with `TENANT_ROLES`
 * membership rather than an `undefined` check on the lookup: an object literal indexed by
 * an arbitrary string returns an inherited property (`toString`, `__proto__`, ...) instead
 * of `undefined`, so that check alone lets those keys through with a typeof-mismatched
 * value rather than a throw. Same guard `asTenantRole` uses, for the same reason.
 */
export function tenantRoleRank(_role: TenantRole): number {
  if (!(TENANT_ROLES as readonly string[]).includes(_role)) {
    throw new Error(`not a tenant role: ${_role}`);
  }

  return TENANT_ROLE_RANK[_role as unknown as TenantRoleValue];
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
 *
 * UNBRANDED, deliberately. This feeds z.enum() in the invitation contract, and a
 * branded member type would carry the brand into the inferred contract type — a brand
 * at a JSON boundary, which ADR-0023 forbids. A brand is a compile-time claim about
 * where a value has been validated; a value arriving in a request body has been
 * nowhere.
 *
 * RULE: every zod enum sources from an unbranded array — TENANT_ROLES, WORKSPACE_ROLES,
 * or this one. Branding happens after parsing, via asTenantRole / asWorkspaceRole.
 *
 * `as const satisfies`, not a `readonly WorkspaceRoleValue[]` annotation: z.enum needs
 * the literal tuple type, and the annotation would widen it to string[] and break it.
 */
export const INVITABLE_WORKSPACE_ROLES = [
  'workspace_admin',
  'member',
] as const satisfies readonly WorkspaceRoleValue[];
