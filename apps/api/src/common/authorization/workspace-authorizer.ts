/**
 * Contract: docs/contracts/workspace-authorization.md ("The two enforcement forms", Form B and
 *           Form C; "Status rules": 404 before 403; "Invariants": 2, 4, 6),
 *           docs/contracts/error-envelope.md (invariants 5, 6)
 * ADR: adr-0015, adr-0023 (branded minimums; `assertTenant` takes `AuthorisingTenantRole`),
 *      adr-0062 (the lookup is one read of one table under its policy)
 * Produced by: TASK-1b-05
 *
 * THE ONE PLACE A ROLE IS COMPARED WITH A MINIMUM. Both enforcement forms end here: Form A's
 * interceptor and Form B's handler call `requireWorkspaceRank` / `requireTenantRank` below,
 * so "no membership is 404, below rank is 403, `viewer` never writes" is decided once
 * (invariant 2: `viewer` is denied every write with no per-endpoint code, because every write
 * route's minimum is at least `member` and rank 10 < 20).
 *
 * RANK IS COMPARED THROUGH `meetsWorkspaceRole` / `meetsTenantRole` (`roleRank` /
 * `tenantRoleRank` underneath) AND NOWHERE ELSE. No string compare of role names exists in
 * this directory; the rank tables in `packages/contracts/src/roles.ts` are the data.
 *
 * 404 BEFORE 403. A caller with no membership learns nothing about whether the workspace
 * exists (error-envelope.md invariant 5); a member below rank learns they are a member. The
 * lookup runs inside the request's tenant transaction, so another tenant's workspace answers
 * "no membership" from the policy before this class sees anything: that is what makes the
 * two indistinguishable, and why the 404 body is `WorkspaceNotFoundError`'s byte for byte.
 *
 * FORM B READS THE CALLER FROM `currentActor()`, which the authorization interceptor
 * establishes for the request; a call outside a request throws (500). Form C (a
 * `@NoTenantTransaction` handler calling `assertTenant(TENANT_ROLE.owner)` inside its own
 * first `withTenantTransaction`) is the same call, and the repository joins that transaction.
 */
import { Inject, Injectable } from '@nestjs/common';
import { meetsTenantRole, meetsWorkspaceRole } from '@shortkit/contracts';
import type { AuthorisingTenantRole, TenantRole, WorkspaceRole } from '@shortkit/contracts';

import { MembershipRepository } from '../../memberships/membership.repository';
import { TenantMembershipRepository } from '../../memberships/tenant-membership.repository';
import { currentActor } from './actor-context';
import {
  InsufficientTenantRoleError,
  InsufficientWorkspaceRoleError,
  TenantMembershipNotFoundError,
  WorkspaceAccessNotFoundError,
} from './errors';

/**
 * The status table for a workspace role, applied to a lookup's answer. `null` (no membership,
 * another tenant's workspace, non-uuid) → 404; below `min` → 403 `insufficient_workspace_role`.
 * Returns the role so a caller can record it.
 */
export function requireWorkspaceRank(role: WorkspaceRole | null, min: WorkspaceRole): WorkspaceRole {
  if (role === null) {
    throw new WorkspaceAccessNotFoundError();
  }

  if (!meetsWorkspaceRole(role, min)) {
    throw new InsufficientWorkspaceRoleError();
  }

  return role;
}

/**
 * The status table for a tenant role. `null` (no row in this tenant) → 404; below `min` →
 * 403 `insufficient_tenant_role`. `min` is `AuthorisingTenantRole`: `member` cannot be one.
 */
export function requireTenantRank(role: TenantRole | null, min: AuthorisingTenantRole): TenantRole {
  if (role === null) {
    throw new TenantMembershipNotFoundError();
  }

  if (!meetsTenantRole(role, min)) {
    throw new InsufficientTenantRoleError();
  }

  return role;
}

@Injectable()
export class WorkspaceAuthorizer {
  /** `@Inject(...)` written out for the reason `auth.guard.ts` gives (`consistent-type-imports`). */
  constructor(
    @Inject(MembershipRepository) private readonly memberships: MembershipRepository,
    @Inject(TenantMembershipRepository) private readonly tenantMemberships: TenantMembershipRepository,
  ) {}

  /**
   * Form B. The handler has loaded its resource through a tenant-scoped repository (so
   * another tenant's resource was already a 404) and asks whether the caller holds at least
   * `min` in `workspaceId`. Throws per the status table; resolves to nothing.
   */
  async assert(workspaceId: string, min: WorkspaceRole): Promise<void> {
    const actor = currentActor();
    const role = await this.memberships.roleFor(workspaceId, actor.userId);

    requireWorkspaceRank(role, min);
  }

  /** Form B and Form C at tenant level. */
  async assertTenant(min: AuthorisingTenantRole): Promise<void> {
    const actor = currentActor();
    const role = await this.tenantMemberships.roleFor(actor.userId);

    requireTenantRank(role, min);
  }
}
