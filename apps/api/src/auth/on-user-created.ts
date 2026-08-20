/**
 * Contract: `docs/contracts/auth-config-surface.md`
 *           (the `databaseHooks.user.create.after` row and its error case)
 * ADR: adr-0015-user-tenant-cardinality.md, adr-0054-signup-residue-repriced-across-two-roles.md,
 *      adr-0002-tenant-context-binding.md, adr-0003-rls-policy-template-and-roles.md
 * Produced by: TASK-003. Called by: `auth/invitation-signup.ts`'s `provisionForNewUser`, which
 *              `auth.config.ts`'s `databaseHooks.user.create.after` runs.
 *
 * ADR-0015's UNINVITED branch: mint a tenant id, open the tenant transaction on it, and
 * write both rows inside that one context. It was the only branch while identity-membership
 * shipped; since 2026-08-18 (TASK-1b-09) `provisionForNewUser` takes the invited branch when
 * the signup body carried a valid `invitationToken` — `acceptInvitationByCapabilityToken`
 * writes the membership rows in the INVITER's tenant and this function is not called — and
 * this one otherwise.
 *
 * ============================================================================
 * THE ID IS MINTED HERE BECAUSE THE POLICY NEEDS IT BEFORE THE INSERT (ADR-0021).
 * ============================================================================
 *
 * `tenants_self_insert` admits a row only when the transaction's own `app.tenant_id`
 * equals the id being written, and `tenant_memberships_tenant_isolation`'s `WITH CHECK`
 * admits the membership only in the same context. So the id cannot come from a `DEFAULT`
 * on the column: it has to exist before `withTenantTransaction` opens.
 *
 * ============================================================================
 * IT RUNS AFTER THE `user` ROW COMMITS, SO SIGNUP IS NOT ATOMIC ACROSS THE TWO.
 * ============================================================================
 *
 * The residue if either write fails is a `user` row with no `tenant_memberships` row: an
 * account that cannot obtain a `tid` claim and therefore cannot authenticate anywhere.
 * ADR-0015 rules that orphan ACCEPTED and rules the alternative — a membership row in a
 * tenant nobody proved access to — unacceptable. NO COMPENSATING DELETE OF THE `user` ROW
 * is added here; a cleanup path is a second decision and needs an ADR amendment, and the
 * two rows are written by two different roles on two different pools (ADR-0050), so this
 * function could not roll the first one back even if it were allowed to.
 *
 * ============================================================================
 * AND IT DOES NOT SWALLOW (ADR-0054, decision part 2).
 * ============================================================================
 *
 * A swallowed failure hands the caller a 200 over an account that fails on its next request
 * at a different layer with a different error. The rejection propagates verbatim: no
 * context is added to it, because the values in scope here are a user id and arbitrary
 * operator-typed text and `LOGGABLE_FIELDS` has a name for neither (GC-G). `auth.config.ts`
 * is where it becomes `500 TENANT_PROVISIONING_FAILED` and where it is logged, once.
 */
import { randomUUID } from 'node:crypto';

import { TENANT_ROLE } from '@shortkit/contracts';

import { tenantMemberships } from '../db/schema/tenant-memberships';
import { tenants } from '../db/schema/tenants';
import { withTenantTransaction } from '../tenancy/tenant-context';

/**
 * Writes the tenant and the owner membership for a user Better Auth has just created, and
 * resolves only after that transaction commits.
 *
 * `name` is the display name the operator typed at signup and it is written to
 * `tenants.name` VERBATIM (F-198, Juano's ruling): nothing derived, nothing parsed, no
 * placeholder. The operator renames the agency later if they want to. The alternatives were
 * the email's domain, which is wrong for anyone on a consumer address, and a shared
 * literal, which is unhelpful in every list until someone renames it.
 */
export async function createTenantForNewUser(user: {
  id: string;
  name: string;
}): Promise<{ tenantId: string; membershipId: string }> {
  const tenantId = randomUUID();

  return withTenantTransaction(tenantId, async (db) => {
    await db.insert(tenants).values({ id: tenantId, name: user.name });

    const [membership] = await db
      .insert(tenantMemberships)
      .values({ tenantId, userId: user.id, role: TENANT_ROLE.owner })
      .returning({ id: tenantMemberships.id });

    if (membership === undefined) {
      // ======================================================================
      // UNREACHABLE TODAY, DELIBERATELY KEPT, AND SAYING SO IS THE POINT (F-202).
      // ======================================================================
      //
      // `INSERT ... RETURNING` gives back the row it wrote, and a write that
      // `tenant_memberships_tenant_isolation`'s `WITH CHECK` refuses raises `42501` rather
      // than returning an empty result — so against the migrated policies this branch
      // cannot fire, and no test exercises it. It is beyond what the card asks for, was
      // disclosed as such, and is kept for one reason: if a later policy, adapter or
      // driver ever DOES filter this write silently, the alternative is a resolved signup
      // carrying a `membershipId` that names no row, which is ADR-0054 part 2's failure
      // one layer lower and invisible at every layer above.
      throw new Error(
        'the tenant_memberships insert returned no row, so the owner membership for this ' +
          'signup cannot be confirmed (ADR-0015).',
      );
    }

    return { tenantId, membershipId: membership.id };
  });
}
