/**
 * Contract: design/contracts/workspace-authorization.md
 * ADR: adr-0015-user-tenant-cardinality.md
 * Produced by: TASK-017
 * Consumed by: TASK-014, 018, 021, 025, 040, 045, 049, 051, 053, 054
 *
 * The role values and ranks live in @shortkit/contracts (apps/web renders role names).
 * This file holds enforcement only.
 */
import type {
  AuthorisingTenantRole,
  TenantRole,
  WorkspaceRole,
} from '@shortkit/contracts';

export const REQUIRE_WORKSPACE_ROLE = Symbol('REQUIRE_WORKSPACE_ROLE');
export const REQUIRE_TENANT_ROLE = Symbol('REQUIRE_TENANT_ROLE');

/**
 * FORM A, declarative. For routes carrying the workspace id in the request.
 * WorkspaceGuard resolves it from params.workspaceId, then body.workspaceId, then
 * query.workspaceId. None present is 400 `workspace_id_required`.
 */
export function RequireWorkspaceRole(_min: WorkspaceRole): MethodDecorator {
  throw new Error('not implemented');
}

/**
 * NEVER applied to the same handler as @RequireWorkspaceRole, and NEVER to a route
 * carrying @NoTenantTransaction (F-020).
 *
 * Takes AuthorisingTenantRole, so the minimum is always 'admin' or 'owner' BY TYPE.
 * Tenant `member` (rank 0, Amendment A-8) cannot be passed and passes none of them,
 * which is what keeps an invitee from reaching tenant-level surfaces.
 */
export function RequireTenantRole(_min: AuthorisingTenantRole): MethodDecorator {
  throw new Error('not implemented');
}

/**
 * FORM B, imperative. For resource routes such as /api/links/:id, where the workspace
 * is a property of the resource and cannot be known before loading it.
 *
 * The handler loads the resource through a tenant-scoped repository FIRST. RLS returns
 * nothing for another tenant, so cross-tenant access is already 404 before any role
 * check runs (AC-41, AC-69, AC-81). Then it calls assert().
 *
 * EVERY authenticated write route uses exactly one of the two forms. TASK-056's
 * enumeration flags a route using neither.
 */
export interface WorkspaceAuthorizer {
  /** Throws 403 insufficient_workspace_role. */
  assert(workspaceId: string, min: WorkspaceRole): Promise<void>;
  /**
   * Throws 403 insufficient_tenant_role.
   * Takes AuthorisingTenantRole, NOT TenantRole: TENANT_ROLE.member is rank 0 and
   * would authorise every user in the tenant, so it is excluded by type (ADR-0023).
   */
  assertTenant(min: AuthorisingTenantRole): Promise<void>;
}

/**
 * FORM C. Routes carrying @NoTenantTransaction (F-020).
 *
 * POST /api/gdpr/delete skips TenantTransactionInterceptor, so THERE IS NO AMBIENT
 * CONTEXT WHEN GUARDS RUN. Authorization moves into the handler; it does not disappear.
 *
 *   1. AuthGuard                            -> 401 / 403 email_not_verified
 *   2. RateLimitGuard                       -> 429
 *   3. handler opens withTenantTransaction(ctx.tenantId)
 *   4.   assertTenant(TENANT_ROLE.owner)    -> 403 insufficient_tenant_role   AC-105
 *   5.   assert body.confirmation           -> 400 confirmation_required      AC-92
 *   6.   collectTenantCensus()
 *   7. commit, then phase 2 and phase 3
 *
 * A @NoTenantTransaction route MAY NOT carry @RequireTenantRole or
 * @RequireWorkspaceRole. TASK-056 asserts the combination never exists.
 */

/**
 * 404 BEFORE 403. Existence is never disclosed to a non-member.
 *
 *   no membership in the workspace        -> 404 not_found                  (AC-27)
 *   workspace belongs to another tenant   -> 404 not_found                  (AC-24)
 *   member, rank below the minimum        -> 403 insufficient_workspace_role (AC-28)
 *   tenant admin on an owner-only surface -> 403 insufficient_tenant_role    (AC-105)
 *   viewer attempting any write           -> 403 insufficient_workspace_role (AC-104)
 *   viewer reading                        -> 200                            (AC-104)
 *
 * Runs AFTER AuthGuard and INSIDE the tenant transaction, so its membership lookup is
 * itself under RLS.
 *
 * FAILS CLOSED (F-020): with no active tenant context it THROWS
 * TenantContextMissingError, producing a 500. It NEVER returns true and NEVER degrades
 * to an unchecked pass. A 500 on a misconfigured route is correct; a silent pass on
 * POST /api/gdpr/delete is not.
 */
export declare class WorkspaceGuard {
  canActivate(context: unknown): Promise<boolean>;
}

/**
 * AC-31. A SELECT ... FOR UPDATE count INSIDE the mutating transaction.
 * A read-then-write outside one races. Throws 409 last_owner_protected.
 *
 * Applies to BOTH routes that can remove the last owner:
 *   PATCH  /api/tenant/members/:id/tenant-role   (demotion)
 *   DELETE /api/tenant/members/:id               (removal from the tenant)
 */
export function assertNotLastOwner(_tenantId: string, _userId: string): Promise<void> {
  throw new Error('not implemented');
}

/**
 * ============================================================================
 * F-011. Tenant-role mutation is a DISTINCT route with a DISTINCT guard.
 * ============================================================================
 *
 * The contract's minimum-role table previously had no row for mutating a tenant role
 * while AC-31 required the surface to exist, so the gate was the implementer's to pick
 * and the adjacent row said workspace_admin. That let a member invited to one client
 * workspace promote themselves to tenant owner and export or delete the whole agency.
 *
 *   PATCH  /api/tenant/members/:id/tenant-role   @RequireTenantRole(TENANT_ROLE.owner)
 *   DELETE /api/tenant/members/:id               @RequireTenantRole(TENANT_ROLE.owner)
 *   GET    /api/tenant/members                   @RequireTenantRole(TENANT_ROLE.owner)
 *
 * A tenant `admin` may NOT grant 'owner', may NOT revoke 'owner', may NOT grant 'admin'.
 * Only an owner grants or revokes any tenant role.
 *
 * Request bodies name the enum: `tenantRole` here, `workspaceRole` on the workspace
 * routes. NEVER a bare `role` — 'member' belongs to both enums and the compiler cannot
 * tell them apart.
 */
export interface TenantRoleAuthorizer {
  assertMayGrant(actor: TenantRole, target: TenantRole): void;
}
