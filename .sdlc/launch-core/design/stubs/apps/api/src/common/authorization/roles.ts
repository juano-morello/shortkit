/**
 * Contract: design/contracts/workspace-authorization.md
 * ADR: adr-0015-user-tenant-cardinality.md
 * Produced by: TASK-017
 * Consumed by: TASK-014, 018, 021, 025, 040, 045, 049, 051, 053, 054
 *
 * The role values and ranks live in @shortkit/contracts (apps/web renders role names).
 * This file holds enforcement only.
 */
import type { TenantRole, WorkspaceRole } from '@shortkit/contracts';

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

export function RequireTenantRole(_min: TenantRole): MethodDecorator {
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
  /** Throws 403 insufficient_tenant_role. */
  assertTenant(min: TenantRole): Promise<void>;
}

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
 */
export declare class WorkspaceGuard {
  canActivate(context: unknown): Promise<boolean>;
}

/**
 * AC-31. A SELECT ... FOR UPDATE count INSIDE the mutating transaction.
 * A read-then-write outside one races. Throws 409 last_owner_protected.
 */
export function assertNotLastOwner(_tenantId: string, _userId: string): Promise<void> {
  throw new Error('not implemented');
}
