/**
 * Contract: docs/contracts/workspace-authorization.md ("The two enforcement forms", Form A;
 *           "Normative form": this file is the enforcement half, `packages/contracts/src/roles.ts`
 *           the value half)
 * ADR: adr-0015-user-tenant-cardinality.md (tenant role and workspace role are two enums at
 *      two levels), adr-0023 (both branded; `TENANT_ROLE.member` is unpassable as a minimum)
 * Produced by: TASK-1b-05
 *
 * The two Form A decorators. Each writes ONE metadata key and nothing else; the reader is
 * `workspace-authorization.interceptor.ts` beside this file, which reads handler first and
 * then class (`Reflector.getAllAndOverride`), so a class-level decorator covers every handler
 * on the controller and a handler-level one covers itself alone: the same reading
 * `@Public()` and `@NoTenantTransaction()` get.
 *
 * THE MINIMUM IS VALIDATED AT DECORATION TIME, WHICH IS MODULE LOAD. `roleRank` /
 * `tenantRoleRank` throw on a value outside the enum, so a route decorated with something
 * that is not a role fails the process at boot rather than passing every request or refusing
 * every request at run time. The types already forbid a bare literal (ADR-0023); this is the
 * runtime backstop for a cast.
 *
 * `RequireTenantRole` takes `AuthorisingTenantRole`, so `TENANT_ROLE.member` (rank 0, every
 * user in the tenant) cannot be a minimum: by type, and the rank check below does not need
 * to know.
 */
import { SetMetadata } from '@nestjs/common';
import { roleRank, tenantRoleRank } from '@shortkit/contracts';
import type { AuthorisingTenantRole, WorkspaceRole } from '@shortkit/contracts';

/** The key `RequireWorkspaceRole()` writes. The value is the branded minimum. */
export const WORKSPACE_ROLE_METADATA = Symbol('WORKSPACE_ROLE_METADATA');

/** The key `RequireTenantRole()` writes. The value is the branded minimum. */
export const TENANT_ROLE_METADATA = Symbol('TENANT_ROLE_METADATA');

/**
 * Form A: the workspace id is on the request (`params.workspaceId`, then `body.workspaceId`,
 * then `query.workspaceId`), and the caller must hold a membership in it of at least `min`.
 * No membership, another tenant's workspace or a non-uuid → 404 `not_found`; a membership
 * below `min` → 403 `insufficient_workspace_role`; no id resolvable → 400
 * `workspace_id_required`. The status table is `workspace-authorization.md`'s.
 */
export function RequireWorkspaceRole(min: WorkspaceRole): MethodDecorator & ClassDecorator {
  // Throws for a value outside WORKSPACE_ROLES: a boot failure, not a request failure.
  roleRank(min);

  return SetMetadata(WORKSPACE_ROLE_METADATA, min);
}

/**
 * Form A at tenant level: the caller's `tenant_memberships` row must carry a role of at least
 * `min`. Below → 403 `insufficient_tenant_role`; no row at all → 404 `not_found`
 * (error-envelope.md invariant 6: the 403 codes are only for a member whose role is too low).
 */
export function RequireTenantRole(min: AuthorisingTenantRole): MethodDecorator & ClassDecorator {
  tenantRoleRank(min);

  return SetMetadata(TENANT_ROLE_METADATA, min);
}
