/**
 * Contract: design/contracts/redirect-resolution.md, rls-policy-template.md
 * ADR: adr-0003-rls-policy-template-and-roles.md
 * Produced by: TASK-029
 *
 * ============================================================================
 * THE ONE DELIBERATE GC-5 EXCEPTION. Exclusion 1 of exactly 2 (TASK-056).
 * ============================================================================
 *
 * WHY: redirect resolution runs before a tenant is known. The visitor is anonymous
 * and the only inputs are a hostname and a slug. There is no tenant to set.
 *
 * NARROWED FOUR WAYS:
 *   1. FOR SELECT policies only  -> cannot write
 *   2. `domains` and `links` only -> cannot reach memberships, invitations,
 *      audit entries or click events
 *   3. SET TRANSACTION READ ONLY  -> cannot write even if a policy were wrong
 *   4. one file                   -> the isolation suite greps for
 *                                    `app.redirect_context` and asserts it appears
 *                                    in exactly one non-test source file
 *
 * THIS IS THE ONLY FILE THAT MAY CONTAIN THE STRING `app.redirect_context`.
 * A security auditor should challenge this specifically. If the justification does
 * not hold, SC-1's claim is narrower than refinement.md states.
 */
import type { PgTransaction } from 'drizzle-orm/pg-core';
import type * as schema from '../../db/schema';

declare const redirectReadBrand: unique symbol;

/** Read-only handle. Distinct from TenantDb so the two can never be confused. */
export type RedirectReadDb = PgTransaction<any, typeof schema, any> & {
  readonly [redirectReadBrand]: true;
};

/**
 * Issues:
 *   BEGIN;
 *   SET TRANSACTION READ ONLY;
 *   SET LOCAL app.redirect_context = 'on';
 *   ... fn ...
 *   COMMIT;
 *
 * Exactly two query shapes are permitted inside:
 *   SELECT ... FROM domains WHERE hostname = $1
 *   SELECT ... FROM links   WHERE domain_id = $1 AND slug = $2
 */
export async function withRedirectRead<T>(
  _fn: (db: RedirectReadDb) => Promise<T>,
): Promise<T> {
  throw new Error('not implemented');
}

export interface RedirectReadRepository {
  resolveHostByHostname(hostname: string): Promise<{
    domainId: string;
    tenantId: string;
    workspaceId: string;
  } | null>;

  resolveByHostAndSlug(hostname: string, slug: string): Promise<{
    id: string;
    destinationUrl: string;
    domainId: string;
    workspaceId: string;
    tenantId: string;
    expiresAt: Date | null;
    activatesAt: Date | null;
  } | null>;
}
