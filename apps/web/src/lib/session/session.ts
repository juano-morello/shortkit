/**
 * Contract: docs/contracts/web-api-client.md ("Cookies", "Session"),
 *           docs/contracts/auth-tokens.md ("Web cookies (Vercel origin, ADR-0014)")
 * ADR: adr-0014-web-session-handling.md
 * Produced by: TASK-007 (materialising the surviving foundation design stub).
 * Consumed by: TASK-008 (the sign-in/sign-up screens), TASK-013 and every authenticated
 *   screen (`requireAuth`).
 *
 * ============================================================================
 * NO TOKEN IS EVER EXPOSED TO CLIENT JAVASCRIPT, IN ANY FORM (TASK-012's constraint).
 * ============================================================================
 *
 * Both cookies are `HttpOnly; SameSite=Lax; Path=/` on the app's own origin, and `Secure`
 * whenever that origin is `https`. `sk_at` carries the Better Auth JWT (Max-Age 300, the
 * token lifetime, ADR-0013); `sk_rt` carries the Better Auth SESSION token used to mint a
 * new JWT (Max-Age 30 days). `HttpOnly` is what satisfies the constraint; `SameSite=Lax`
 * is available because the cookie is same-origin with the page.
 *
 * ----------------------------------------------------------------------------
 * TWO DEVIATIONS FROM THE FOUNDATION STUB, BOTH FORCED BY NEXT 16, BOTH REPORTED.
 * ----------------------------------------------------------------------------
 *
 * 1. `setSessionCookies` and `clearSessionCookies` return `Promise<void>`, not `void`.
 *    Next 16's `cookies()` is async (`node_modules/next/dist/server/request/cookies.d.ts`
 *    declares `cookies(): Promise<ReadonlyRequestCookies>`), so a synchronous writer
 *    cannot set a cookie on the ambient response: a `void` body could only fire the write
 *    off an un-awaited promise, which races the response being sent. The stub predates the
 *    Next 15/16 async-request-API migration. The stub-drift gate that compared the two was
 *    retired at 9c236f4, so nothing enforces the old signature; names and parameter order
 *    are unchanged.
 *
 * 2. The `Secure` flag is derived from the request/app origin SCHEME, never from
 *    `NODE_ENV` — a repo-wide rule (it mirrors `auth.config.ts`'s `useSecureCookies:
 *    baseUrl.startsWith('https://')`, ADR-0059). On `http://localhost` the cookie is still
 *    set, just without `Secure`; a `NODE_ENV` gate would refuse the cookie on a local
 *    stack running the production image (the F-380 trap, ADR-0040).
 */
import { createHash } from 'node:crypto';

import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';

import { ACCESS_TOKEN_LIFETIME_SECONDS, shortkitJwtClaimsContract } from '@shortkit/contracts';
import { z } from 'zod';

import { originIsSecureFrom } from './request-origin';

/**
 * `useSession` lives in the sibling `'use client'` module; it is re-exported here so the
 * stub's export name still resolves from `./session`. It cannot be defined in THIS module:
 * this one is imported by the BFF route (a server component) for the cookie builders, and a
 * React-hook import in a server-component graph fails the build. THE REVERSE HOLDS TOO: a
 * client component must import `useSession` from `./use-session`, not from here — this
 * module imports `next/headers` and `node:crypto`, which a client bundle cannot carry.
 */
export { useSession, BFF_SESSION_PATH } from './use-session';

/** The JWT. Max-Age 300, matching the token lifetime (ADR-0013). */
export const ACCESS_COOKIE = 'sk_at';
/** The Better Auth session token, used to mint a new JWT. Max-Age 2592000. */
export const REFRESH_COOKIE = 'sk_rt';

export const ACCESS_COOKIE_MAX_AGE_S = ACCESS_TOKEN_LIFETIME_SECONDS;
export const REFRESH_COOKIE_MAX_AGE_S = 30 * 24 * 60 * 60;

/**
 * The sign-in screen `requireAuth` sends an unauthenticated visitor to. TASK-008 ships it
 * at `apps/web/app/(auth)/sign-in/page.tsx`. The foundation contract's docblock still says
 * `/login`; the identity-membership initiative renamed the route to `/sign-in` (STORY-003
 * AC-19 "the sign-in screen", TASK-008 "the redirect target `requireAuth()` sends an
 * unauthenticated visitor to"). Reported as a stale comment in `web-api-client.md`.
 */
export const SIGN_IN_ROUTE = '/sign-in';

/** The non-sensitive projection GET /api/bff/session returns. */
export interface SessionUser {
  id: string;
  email: string;
  emailVerified: boolean;
}

export type SessionStatus = 'loading' | 'authenticated' | 'unauthenticated';

/**
 * A cookie write, shaped for both `cookies().set()` (next/headers) and
 * `NextResponse.cookies.set()` (the BFF route). One source of truth for the attributes so
 * the two writers cannot drift, which is what `web-api-client.md`'s "Cookies" row and
 * AC-18 turn on.
 */
export interface SessionCookie {
  name: string;
  value: string;
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'lax';
  path: string;
  maxAge: number;
}

function cookieAttributes(secure: boolean): Omit<SessionCookie, 'name' | 'value' | 'maxAge'> {
  return { httpOnly: true, secure, sameSite: 'lax', path: '/' };
}

/**
 * The two cookies a successful sign-in sets, as descriptors. AC-18: both `HttpOnly` and
 * `SameSite=Lax`; `Secure` follows the origin scheme.
 */
export function buildSessionCookies(jwt: string, sessionToken: string, secure: boolean): SessionCookie[] {
  return [
    { name: ACCESS_COOKIE, value: jwt, maxAge: ACCESS_COOKIE_MAX_AGE_S, ...cookieAttributes(secure) },
    { name: REFRESH_COOKIE, value: sessionToken, maxAge: REFRESH_COOKIE_MAX_AGE_S, ...cookieAttributes(secure) },
  ];
}

/** The single cookie a refresh rewrites: a fresh `sk_at`, `sk_rt` left untouched. */
export function buildAccessCookie(jwt: string, secure: boolean): SessionCookie {
  return { name: ACCESS_COOKIE, value: jwt, maxAge: ACCESS_COOKIE_MAX_AGE_S, ...cookieAttributes(secure) };
}

/** Both cookies with `Max-Age=0`, which expires them. Same attributes, so the browser matches and drops them. */
export function buildClearedSessionCookies(secure: boolean): SessionCookie[] {
  return [
    { name: ACCESS_COOKIE, value: '', maxAge: 0, ...cookieAttributes(secure) },
    { name: REFRESH_COOKIE, value: '', maxAge: 0, ...cookieAttributes(secure) },
  ];
}

/**
 * `true` when the app's own origin is `https`, through the shared `originIsSecureFrom`
 * (`request-origin.ts`, which states the trust assumption). Read off `headers()`, so it is
 * usable wherever `cookies()` is; Next's own server populates `x-forwarded-proto` from the
 * connection when no hop in front set it, so the header is always present here. NOT
 * `NODE_ENV`.
 */
export async function originIsSecure(): Promise<boolean> {
  return originIsSecureFrom(await headers());
}

/**
 * Sets both cookies on the ambient response. Better Auth's own `Set-Cookie` for the Fly
 * origin is DROPPED by the BFF route (it never forwards upstream `set-cookie`), so nothing
 * competes with these.
 *
 * Returns `Promise<void>` — see the file header, deviation 1. `Secure` follows the origin
 * scheme, deviation 2.
 */
export async function setSessionCookies(jwt: string, sessionToken: string): Promise<void> {
  const store = await cookies();
  const secure = await originIsSecure();

  for (const cookie of buildSessionCookies(jwt, sessionToken, secure)) {
    store.set(cookie);
  }
}

/**
 * AC-21. Clears both cookies with `Max-Age=0`. The upstream Better Auth sign-out call
 * (which revokes the `jti`, ADR-0013) is the BFF route's job on `POST /api/bff/auth/sign-out`;
 * this primitive clears the browser's copy. The cookie clear alone satisfies AC-21;
 * revocation closes the replay window, bounded at 300 s and skipped when Redis is down.
 */
export async function clearSessionCookies(): Promise<void> {
  const store = await cookies();
  const secure = await originIsSecure();

  for (const cookie of buildClearedSessionCookies(secure)) {
    store.set(cookie);
  }
}

/**
 * The server-only API base, e.g. `http://api:3001/api` in compose. Read at REQUEST time
 * (never inlined) and NEVER `NEXT_PUBLIC_*` — the browser reaches the API through the BFF
 * only (ADR-0014). Thrown-on rather than defaulted, so a missing value fails loudly.
 */
function apiBaseUrl(): string {
  const value = process.env.API_BASE_URL;

  if (value === undefined || value.trim() === '') {
    throw new Error('API_BASE_URL is not set. The session module reaches the API through it (ADR-0014).');
  }

  return value;
}

/**
 * ============================================================================
 * THE ONE MINT PATH. Every refresh in `apps/web` goes through `mintAccessToken`.
 * ============================================================================
 *
 * `GET {API}/api/auth/token` with `Authorization: Bearer <sk_rt>` (the Better Auth session
 * token is accepted by the `bearer` plugin, auth-tokens.md). `GET` needs no `Origin`
 * (Better Auth skips the check on `GET`). Returns the JWT, or `null` on ANY failure —
 * unreachable mint, non-2xx, or a body without a `token` string. It writes NO cookies:
 * `refreshAccessToken` writes through `cookies()` for route handlers that let Next merge
 * the response, and the BFF proxy writes `Set-Cookie` on the `NextResponse` it hand-builds.
 * One mint, two cookie writers, deliberately (review round 1, MEDIUM a).
 *
 * CONCURRENT CALLERS ARE COLLAPSED by `inFlightMints` (ADR-0014, "a per-request in-flight
 * map collapses them"): a burst of parallel fetches that all see `token_expired` triggers
 * ONE upstream mint. The map is keyed by a SHA-256 of `sk_rt`, never the raw token — a Map
 * key is reachable from a heap dump and from `util.inspect` of the module, and the raw
 * session token is a 30-day credential. Entries are deleted in `finally`, so a settled mint
 * never pins a stale promise.
 */
const inFlightMints = new Map<string, Promise<string | null>>();

export function mintAccessToken(sessionToken: string): Promise<string | null> {
  const key = createHash('sha256').update(sessionToken).digest('base64url');
  const existing = inFlightMints.get(key);

  if (existing !== undefined) {
    return existing;
  }

  const mint = mintOnce(sessionToken).finally(() => {
    inFlightMints.delete(key);
  });

  inFlightMints.set(key, mint);

  return mint;
}

async function mintOnce(sessionToken: string): Promise<string | null> {
  let response: Response;

  try {
    response = await fetch(`${apiBaseUrl()}/auth/token`, {
      method: 'GET',
      headers: { authorization: `Bearer ${sessionToken}` },
      redirect: 'manual',
    });
  } catch {
    return null;
  }

  if (!response.ok) {
    return null;
  }

  return readMintedToken(response);
}

/** The mint's `{ token }` body, or `null` when it is not that shape. */
async function readMintedToken(response: Response): Promise<string | null> {
  let body: unknown;

  try {
    body = await response.json();
  } catch {
    return null;
  }

  const parsed = mintedTokenContract.safeParse(body);

  return parsed.success ? parsed.data.token : null;
}

const mintedTokenContract = z.object({ token: z.string().min(1) });

/**
 * Mints a new JWT from the `sk_rt` cookie through `mintAccessToken`, writes a fresh `sk_at`
 * through `cookies()` (route handlers only — the action phase), and returns the JWT.
 *
 * A failure — no `sk_rt`, or the mint returned `null` — clears BOTH cookies and throws,
 * which is the "two consecutive failures clear both cookies and return 401" outcome the
 * caller (the refresh-and-bounce route, the session projection) turns into a 401 or a
 * redirect to `/sign-in`.
 */
export async function refreshAccessToken(): Promise<string> {
  const store = await cookies();
  const sessionToken = store.get(REFRESH_COOKIE)?.value;

  if (sessionToken === undefined || sessionToken === '') {
    await clearSessionCookies();
    throw new Error('refreshAccessToken: no session token to mint from.');
  }

  const jwt = await mintAccessToken(sessionToken);

  if (jwt === null) {
    await clearSessionCookies();
    throw new Error('refreshAccessToken: the token mint refused the session token.');
  }

  const secure = await originIsSecure();
  store.set(buildAccessCookie(jwt, secure));

  return jwt;
}

/**
 * Used by every authenticated server component before it renders. Reads `sk_at`; when
 * there is no session it `redirect`s to the sign-in screen and NEVER returns — so a
 * protected page cannot render-then-hide (AC-19). It does not itself verify the JWT; the
 * API is the enforcement point, and a present-but-invalid `sk_at` fails at the first
 * `serverApiClient`/BFF call, which refreshes or clears.
 *
 * `redirect()` throws, so the `SessionUser` return is only reached with a session present.
 * The projection is decoded from the JWT payload without a signature check, because this is
 * display context (`web-api-client.md`, "Workspace scoping in the UI is display context").
 */
export async function requireAuth(): Promise<SessionUser> {
  const store = await cookies();
  const accessToken = store.get(ACCESS_COOKIE)?.value;

  if (accessToken === undefined || accessToken === '') {
    redirect(SIGN_IN_ROUTE);
  }

  const user = sessionUserFromJwt(accessToken);

  if (user === null) {
    redirect(SIGN_IN_ROUTE);
  }

  return user;
}



/**
 * The subset of `ShortkitJwtClaims` (auth-tokens.md, `shortkitJwtClaimsContract`) the web
 * app reads: `sub`, `email`, `ev` for the projection and `exp` for the expiry check.
 * Derived from the shared contract by `.pick`, not re-declared, so a renamed or re-typed
 * claim breaks `pnpm typecheck` here rather than silently decoding to `undefined`
 * (ADR-0005, invariant 2 of web-api-client.md).
 */
const webJwtClaimsContract = shortkitJwtClaimsContract.pick({
  sub: true,
  email: true,
  ev: true,
  exp: true,
});

type WebJwtClaims = z.infer<typeof webJwtClaimsContract>;

/**
 * Decodes the non-sensitive `{ id, email, emailVerified }` projection from a JWT's payload
 * segment. NO signature verification and NO network call: the BFF is the only writer of the
 * HttpOnly `sk_at`, the API verifies signature/iss/aud/exp/revocation on every use
 * (`AuthGuard`), and this is display context (`web-api-client.md`, "Workspace scoping in
 * the UI is display context"). Returns `null` for anything that is not a well-formed
 * three-segment JWT whose payload validates against `webJwtClaimsContract`, which
 * `requireAuth` treats as no session.
 */
export function sessionUserFromJwt(jwt: string): SessionUser | null {
  const claims = decodeJwtPayload(jwt);

  if (claims === null) {
    return null;
  }

  return { id: claims.sub, email: claims.email, emailVerified: claims.ev };
}

/**
 * `true` when the JWT's `exp` claim is at or before `nowSeconds` — or when the payload does
 * not validate at all: a token with no readable expiry is treated as expired, the closed
 * direction. Decode only; the API verifies the signature on use.
 */
export function jwtIsExpired(jwt: string, nowSeconds: number = Math.floor(Date.now() / 1000)): boolean {
  const claims = decodeJwtPayload(jwt);

  return claims === null || claims.exp <= nowSeconds;
}

/**
 * The payload segment of a three-segment JWT, base64url-decoded, JSON-parsed and validated
 * against `webJwtClaimsContract`. `null` otherwise.
 */
function decodeJwtPayload(jwt: string): WebJwtClaims | null {
  const segments = jwt.split('.');

  if (segments.length !== 3) {
    return null;
  }

  let payload: unknown;

  try {
    payload = JSON.parse(Buffer.from(segments[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }

  const parsed = webJwtClaimsContract.safeParse(payload);

  return parsed.success ? parsed.data : null;
}
