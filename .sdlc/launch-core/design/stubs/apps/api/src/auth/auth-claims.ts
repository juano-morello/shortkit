/**
 * Contract: design/contracts/auth-tokens.md
 * ADR: adr-0013-better-auth-in-nestjs.md, adr-0002, adr-0015
 * Produced by: TASK-009 (issuance), TASK-011 (verification)
 */

export interface ShortkitJwtClaims {
  /** user id */
  sub: string;
  /** tenant id. ADR-0015: exactly one per user, stable for the token's life. */
  tid: string;
  email: string;
  /** email verified. AC-17's 403 email_not_verified. */
  ev: boolean;
  jti: string;
  iat: number;
  /** iat + JWT_LIFETIME_S */
  exp: number;
  iss: string;
  aud: string;
}

/**
 * 5 minutes, not Better Auth's default 15. Revocation is best-effort (it is skipped
 * when Redis is down), so the lifetime IS the worst-case replay window.
 */
export const JWT_LIFETIME_S = 300;
export const JWKS_CACHE_TTL_S = 600;

export function revocationKey(jti: string): string {
  return `revoked:jti:${jti}`;
}

/**
 * `tid` is what removes AuthGuard's chicken-and-egg problem: the guard needs a tenant
 * to open the transaction, and a database lookup for it would run OUTSIDE tenant
 * context, which is the hole GC-5 forbids.
 *
 * Called once at token mint time, never per request. Single-row lookup on
 * tenant_memberships' UNIQUE (user_id) index.
 */
export function tenantIdForUser(_userId: string): Promise<string> {
  throw new Error('not implemented');
}

/**
 * Ordered. Any failure short-circuits. NO DATABASE QUERY AT ANY STEP.
 *
 *   1. Authorization: Bearer present        else 401 unauthenticated
 *   2. signature valid against cached JWKS  else 401 unauthenticated
 *   3. exp in the future                    else 401 token_expired  <- BFF branches on this
 *   4. iss and aud match                    else 401 unauthenticated
 *   5. jti not revoked in Redis             else 401 unauthenticated
 *      (SKIPPED on any Redis error; increments auth_revocation_degraded_total)
 *   6. route not @Public()                  public routes skip 1..5 entirely
 *   7. ev === true                          else 403 email_not_verified
 *   8. populate RequestContext from claims
 */
export function verifyAccessToken(_token: string): Promise<ShortkitJwtClaims> {
  throw new Error('not implemented');
}
