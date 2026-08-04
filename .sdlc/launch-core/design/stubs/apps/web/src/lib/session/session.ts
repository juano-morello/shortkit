/**
 * Contract: design/contracts/web-api-client.md, auth-tokens.md
 * ADR: adr-0014-web-session-handling.md
 * Produced by: TASK-012
 * Consumed by: TASK-015 and every authenticated screen
 *
 * NO TOKEN IS EVER EXPOSED TO CLIENT JAVASCRIPT, in any form.
 * Both cookies are HttpOnly; Secure; SameSite=Lax; Path=/ on the Vercel origin.
 */

/** The JWT. Max-Age 300, matching the token lifetime (ADR-0013). */
export const ACCESS_COOKIE = 'sk_at';
/** The Better Auth session token, used to mint a new JWT. Max-Age 2592000. */
export const REFRESH_COOKIE = 'sk_rt';

export const ACCESS_COOKIE_MAX_AGE_S = 300;
export const REFRESH_COOKIE_MAX_AGE_S = 30 * 24 * 60 * 60;

/** The non-sensitive projection GET /api/bff/session returns. */
export interface SessionUser {
  id: string;
  email: string;
  emailVerified: boolean;
}

export type SessionStatus = 'loading' | 'authenticated' | 'unauthenticated';

export function useSession(): { user: SessionUser | null; status: SessionStatus } {
  throw new Error('not implemented');
}

/** Used by every authenticated screen. Redirects to /login when unauthenticated. */
export function requireAuth(): Promise<SessionUser> {
  throw new Error('not implemented');
}

/**
 * Sets both cookies. Better Auth's own Set-Cookie for the Fly origin is DROPPED.
 * Called only from the BFF route handler.
 */
export function setSessionCookies(_jwt: string, _sessionToken: string): void {
  throw new Error('not implemented');
}

/**
 * AC-21. Calls Better Auth sign-out upstream (which revokes the jti), then clears both
 * cookies with Max-Age=0. The cookie clear alone satisfies AC-21; revocation closes
 * the replay window, which is bounded at 300 s and is skipped when Redis is down.
 */
export function clearSessionCookies(): void {
  throw new Error('not implemented');
}

/**
 * Mints a new JWT from `sk_rt`. Concurrent callers are collapsed by an in-flight map
 * keyed on the session, so a burst of parallel fetches triggers one refresh.
 * Two consecutive failures clear both cookies and return 401.
 */
export function refreshAccessToken(): Promise<string> {
  throw new Error('not implemented');
}
