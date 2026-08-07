/**
 * Contract: design/contracts/auth-tokens.md
 * ADR: adr-0013-better-auth-in-nestjs.md, adr-0002, adr-0015
 * Produced by: TASK-009 (issuance), TASK-011 (verification)
 */

export interface ShortkitJwtClaims {
  /**
   * user id.
   *
   * F-227: SET BY BETTER AUTH, NOT BY definePayload. sign.mjs:53-61 spreads
   * definePayload's return and THEN overwrites sub with
   * `getSubject?.(session) ?? session.user.id`. A `sub` in definePayload is inert.
   */
  sub: string;
  /** tenant id. ADR-0015: exactly one per user, stable for the token's life. */
  tid: string;
  email: string;
  /** email verified. AC-17's 403 email_not_verified. */
  ev: boolean;
  /**
   * THE BETTER AUTH SESSION ID. NOT UNIQUE PER TOKEN. NOT A NONCE.
   *
   * F-227, two halves.
   *
   * (1) better-auth@1.6.26 issues NO jti unless definePayload returns one —
   *     dist/plugins/jwt/sign.mjs:49, `if (payload.jti) jwt.setJti(payload.jti)`. A probe
   *     with the previous config returned aud, email, ev, exp, iat, iss, sub, tid and no
   *     jti, which would leave AuthGuard's revocation check reading undefined, matching
   *     nothing, and reporting a successful logout that revoked nothing. AC-21 asserts
   *     the opposite.
   *
   * (2) It is the SESSION id rather than a per-token random, because sign-out holds a
   *     session and no token (dist/api/routes/sign-out.mjs:20-22 reads the cookie and
   *     deletes the row). A random per-token jti could only be revoked by whoever holds
   *     that exact token, and the web app mints ~12 per hour per session, so every
   *     earlier token would survive the logout.
   *
   * The cost: jti is not unique per token, so it cannot serve replay detection. A change
   * that needs that adds a `sid` claim and moves revocation onto it IN THE SAME CHANGE.
   * Making jti unique on its own breaks revocation SILENTLY — the guard keeps working and
   * sign-out quietly stops covering earlier tokens.
   */
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

/** F-015: every key carries an environment segment. See redirect-cache.md. */
export function revocationKey(env: string, jti: string): string {
  return `sk:${env}:revoked:jti:${jti}`;
}

/**
 * The claims definePayload returns. Better Auth adds sub, iat, exp, iss and aud.
 *
 * `session` is better-auth's Session row; only `id` is read. Typed structurally so this
 * stub does not import from better-auth.
 */
export type DefinedJwtPayload = Pick<ShortkitJwtClaims, 'jti' | 'tid' | 'email' | 'ev'>;

export function defineJwtPayload(_session: {
  user: { id: string; email: string; emailVerified: boolean };
  session: { id: string };
}): Promise<DefinedJwtPayload> {
  throw new Error('not implemented');
}

/**
 * TASK-009 registers this as `databaseHooks.session.delete.after`.
 *
 * F-227. THE WRITE SITE IS THE SESSION DELETE HOOK, NOT A /sign-out HANDLER.
 * better-auth/dist/db/with-hooks.mjs:115-190 reads each row before deleting it and
 * passes the whole row to delete.after, so `session.id` is available even though
 * internalAdapter.deleteSession is called with the session TOKEN. deleteManyWithHooks
 * does the same per row, so this one hook covers sign-out, revoke-session,
 * revoke-other-sessions, delete-user and bulk cleanup. Hooking /sign-out alone would
 * have left the other four paths revoking nothing.
 *
 * TTL IS THE FULL JWT_LIFETIME_S, NOT `exp - now`. There is no token here to read exp
 * from, and a token minted one second before the delete still has 299 seconds of life.
 * Anything shorter lets a live token outlive its own revocation entry.
 *
 * MUST NOT THROW. The row is already deleted and the hook is queued after the
 * transaction commits. Failing the sign-out response because Redis is down contradicts
 * ADR-0012's posture: a failed write degrades to the same 300-second window a failed
 * read does, and increments auth_revocation_degraded_total.
 */
export function revokeSessionTokens(_sessionId: string): Promise<void> {
  throw new Error('not implemented');
}

/**
 * `tid` is what removes AuthGuard's chicken-and-egg problem: the guard needs a tenant
 * to open the transaction, and a database lookup for it would run OUTSIDE tenant
 * context, which is the hole GC-5 forbids.
 *
 * Called once at token mint time, never per request. Single-row lookup on
 * tenant_memberships' UNIQUE (user_id) index.
 */
/**
 * THROWS NoTenantMembershipError when no tenant_memberships row exists (F-029).
 *
 * That is the primary stop for ADR-0015's orphan residue: signup is not atomic across
 * the user insert and the membership insert, so a failure between them leaves a user
 * with no membership. Throwing here means token minting fails and the orphaned account
 * NEVER RECEIVES A JWT AT ALL. Returning a null or empty tid instead would push the
 * failure into withTenantTransaction's uuid validation and surface as a 500.
 */
export function tenantIdForUser(_userId: string): Promise<string> {
  throw new Error('not implemented');
}

export class NoTenantMembershipError extends Error {
  constructor(userId: string) {
    super(`User ${userId} has no tenant membership; no token can be minted.`);
    this.name = 'NoTenantMembershipError';
  }
}

/**
 * Ordered and short-circuiting. NO DATABASE QUERY AT ANY STEP.
 *
 * RENUMBERED 2026-08-04 (F-014). The @Public() check was step 6 while the text claimed
 * public routes skip steps 1-5. An implementer copying the block literally would reject
 * every anonymous request at step 1 — and the anonymous redirect GET /:slug is
 * @Public(), so a visitor would get 401 instead of a 302 or the branded 404, breaking
 * GC-8 and SC-7, and the invitation-accept route would be unreachable.
 *
 *   0. handler or controller marked @Public()  -> RETURN TRUE IMMEDIATELY.
 *      No token read, no RequestContext, steps 1-8 do not run. FIRST thing the guard does.
 *
 *   For every other route:
 *   1. Authorization: Bearer present        else 401 unauthenticated
 *   2. signature valid against cached JWKS  else 401 unauthenticated
 *   3. exp in the future                    else 401 token_expired  <- BFF branches on this
 *   4. iss and aud match                    else 401 unauthenticated
 *   5. jti not revoked in Redis             else 401 unauthenticated
 *      (SKIPPED on any Redis error; increments auth_revocation_degraded_total)
 *      jti is an OPAQUE revocation handle here. Do not assume it is unique per token —
 *      it is the session id, so one entry revokes every token that session minted (F-227).
 *   6. CLAIM SHAPE: sub non-empty, tid present and uuid-shaped
 *                                           else 401 unauthenticated       <- F-029
 *      Without it a tid-less token passed the guard and was stopped one layer down by
 *      withTenantTransaction's uuid validation, surfacing as a 500 rather than a 401.
 *   7. ev === true                          else 403 email_not_verified
 *   8. populate RequestContext from claims
 *
 * A handler that FORGETS @Public() is treated as authenticated and returns 401, which
 * is the safe direction.
 */
export function verifyAccessToken(_token: string): Promise<ShortkitJwtClaims> {
  throw new Error('not implemented');
}
