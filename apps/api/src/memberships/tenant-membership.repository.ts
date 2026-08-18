/**
 * Contract: docs/contracts/workspace-authorization.md ("Roles": `TenantRole` lives in
 *           `tenant_memberships`), tenant-membership-lookup.md ("Versioning": 1b does not change
 *           it — this file is not that path), tenant-context.md invariant 4
 * ADR: adr-0015 (one `tenant_memberships` row per user), adr-0045 (the token-mint lookup is
 *      `withMembershipLookup`, single-caller, and stays so), adr-0002, adr-0020
 * Produced by: TASK-1b-05
 *
 * ============================================================================
 * THE REQUEST-TIME READ OF THE CALLER'S TENANT ROLE, INSIDE THE TENANT TRANSACTION.
 * ============================================================================
 *
 * The JWT carries no role claim (workspace-authorization.md invariant 6: no cached
 * authorization), so a `RequireTenantRole` check has to read `tenant_memberships` on the
 * request. It reads through `tenantDb()` under `app.tenant_id`, and
 * `tenant_memberships_tenant_isolation` (migration `0001`, the ordinary template policy)
 * admits exactly the current tenant's rows — the caller's own row among them. Nothing here
 * sets or names the lookup flag.
 *
 * THIS IS NOT `withMembershipLookup`. That function (`auth/membership-lookup.ts`) opens its
 * OWN transaction under `app.membership_lookup_user` to find WHICH tenant a user belongs to
 * before any tenant is known — the token-mint path, ADR-0045's one exclusion, single-caller
 * by contract. Here the tenant is already known (it is the transaction's), the question is
 * the role, and the ordinary policy answers it. Adding a second caller of
 * `withMembershipLookup` would need an ADR; this class needs none.
 *
 * Owner-qualified like every repository (`WorkspaceRepository`'s docblock, F-302): the WHERE
 * carries `tenant_id = currentTenantId()` beside `user_id`.
 */
import { Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { asTenantRole } from '@shortkit/contracts';
import type { TenantRole } from '@shortkit/contracts';

import { tenantMemberships } from '../db/schema';
import { currentTenantId, tenantDb, TenantScopedRepository } from '../tenancy/tenant-context';

@TenantScopedRepository()
@Injectable()
export class TenantMembershipRepository {
  /**
   * The user's role in the CURRENT tenant, or `null` when they hold no row in it. `null` is
   * reachable for a live token only inside the 300 s after the row is removed: the mint
   * refuses without a membership (`test/auth/mint-refuses-without-membership.int-spec.ts`).
   */
  async roleFor(userId: string): Promise<TenantRole | null> {
    const [row] = await tenantDb()
      .select({ role: tenantMemberships.role })
      .from(tenantMemberships)
      .where(and(eq(tenantMemberships.tenantId, currentTenantId()), eq(tenantMemberships.userId, userId)))
      .limit(1);

    return row === undefined ? null : asTenantRole(row.role);
  }
}
