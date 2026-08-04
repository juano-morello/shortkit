/**
 * Contract: design/contracts/invitation-tokens.md
 * ADR: adr-0021-tenant-routing-capability-tokens.md, adr-0003, adr-0015
 * Produced by: TASK-020
 * Consumed by: TASK-021 (both @Public() routes), TASK-013 (invited signup branch)
 *
 * ============================================================================
 * The ONLY sanctioned way a @Public() route obtains tenant context.
 * NOT a GC-5 escape: every statement still runs under
 * set_config('app.tenant_id', ...) and the ordinary tenant_isolation policy.
 * ISOLATION_EXCLUSIONS stays at 2.
 * ============================================================================
 *
 * Format:  <tenantId>.<secret>
 *   tenantId  uuid, 36 chars   -- ROUTES. Caller-controlled. Grants nothing alone.
 *   secret    32 random bytes base64url, 43 chars -- AUTHORISES.
 *
 * Only sha256(secret) is stored. The raw token exists once, in the email body:
 * never stored, never logged, never returned by any read.
 */

export interface CapabilityToken {
  readonly tenantId: string;
  readonly secret: string;
}

export class MalformedCapabilityToken extends Error {}

export const CAPABILITY_SECRET_BYTES = 32;
export const INVITATION_TTL_DAYS = 7;

/** Splits on the FIRST '.', validates the left segment as a uuid. */
export function parseCapabilityToken(_raw: string): CapabilityToken {
  throw new Error('not implemented');
}

export function issueCapabilityToken(_tenantId: string): {
  raw: string;
  digest: Buffer;
} {
  throw new Error('not implemented');
}

/** SHA-256 of the secret half only. The tenant id is already a column. */
export function digestSecret(_secret: string): Buffer {
  throw new Error('not implemented');
}

/**
 * THE SINGLE ENTRY POINT for anonymous callers. There is deliberately no
 * findByToken() that skips the digest check, and no way to obtain the transaction
 * handle separately: a handler holds no invitation object until this returns, so it
 * has nothing to act on before verification.
 *
 * Normative sequence:
 *   1. parseCapabilityToken(raw)              -> malformed => null (caller sends 404)
 *   2. withTenantTransaction(tenantId, ...)   -- caller-controlled tenant id
 *   3. SELECT ... WHERE token_digest = $1     -- FIRST statement, RLS-scoped by step 2
 *   4. timingSafeEqual on the stored digest   -- constant time
 *   5. state / expiry checks
 *   6. everything else
 *
 * NO STATEMENT BETWEEN STEP 2 AND STEP 4 MAY ACT ON THE TENANT. The caller chooses
 * the tenant id, so step 4 is the only thing between an anonymous request and tenant
 * write context.
 *
 * Malformed, unknown, and wrong-tenant all return null -> 404 not_found, same body,
 * no timing difference beyond the indexed lookup.
 */
export interface InvitationCapabilityReader {
  findByCapabilityToken(rawToken: string): Promise<unknown | null>;
}
