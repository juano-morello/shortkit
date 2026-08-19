/**
 * Contract: docs/contracts/web-api-client.md ("The proxy route", "Upstream URL
 *   construction", "The Origin header the proxy forwards", "Which methods are mutating",
 *   "Caching of proxied responses", "The browser address the proxy forwards", "Cookies",
 *   "Session", "Invariants"), docs/contracts/auth-tokens.md (token mint, Better Auth error
 *   shapes), docs/contracts/error-envelope.md, docs/contracts/trusted-client-address.md.
 * ADR: adr-0014-web-session-handling.md, adr-0040-trusted-client-address-is-declared-and-may-be-absent.md
 * Produced by: TASK-007 (identity-membership wave 4).
 * Consumed by: `apiClient` (the browser leg) and every authenticated screen through it.
 *
 * ============================================================================
 * THE ARCHITECT'S RULING (ADR-0014): THE BROWSER REACHES THE API THROUGH THIS ROUTE.
 * ============================================================================
 *
 * ADR-0014 decided the BFF topology: the browser never talks to Fly. It calls this
 * same-origin route, which forwards to `API_BASE_URL` (a value that already carries the
 * `/api` prefix — `buildUpstreamUrl` replaces the path, never appends) with `Authorization: Bearer
 * <sk_at>`, never forwarding the browser's cookies upstream and never returning upstream's
 * `Set-Cookie`. The alternative (browser calls the API's own origin, this route not built)
 * was rejected; the ruling is recorded here and is normative in `web-api-client.md`, "The
 * proxy route".
 *
 * ONE HANDLER FOR GET/POST/PATCH/PUT/DELETE (`proxy`). The header allowlists, the upstream
 * URL construction, `isMutatingMethod`, the cache-control constant and the client-address
 * header names all live in `../../../../src/lib/api/client.ts`, which `web-api-client.md`
 * names as its normative form; this route imports them rather than restating them (F-288).
 *
 * ----------------------------------------------------------------------------
 * F-157: THIS ROUTE IS INVISIBLE TO `assert-no-inlined-secrets.mjs`, BY CONSTRUCTION.
 * ----------------------------------------------------------------------------
 *
 * It is a DYNAMIC route (it reads cookies and forwards per request), so Next produces no
 * `.next` artifact the secret scan can read (F-157, the scan's stated known ceiling). The
 * absence of a finding from that script is therefore NOT evidence for this file. What keeps
 * `BFF_PROXY_SECRET` off the client is that it is read only here, server-side, and only ever
 * placed in an UPSTREAM request header — never rendered, never returned to the browser.
 */
import { isIP } from 'node:net';

import { NextResponse } from 'next/server';

import { authSessionContract, isErrorEnvelope } from '@shortkit/contracts';

import {
  BFF_CLIENT_IP_HEADER,
  BFF_PROXY_AUTH_HEADER,
  FORWARDED_REQUEST_HEADERS,
  FORWARDED_REQUEST_HEADERS_MUTATING_ONLY,
  PROXY_RESPONSE_CACHE_CONTROL,
  RETURNED_RESPONSE_HEADERS,
  UPSTREAM_FETCH_REDIRECT,
  VERCEL_CLIENT_IP_HEADER,
  buildUpstreamUrl,
  isMutatingMethod,
  mapBetterAuthError,
} from '../../../../src/lib/api/client';
import {
  ACCESS_COOKIE,
  REFRESH_COOKIE,
  buildAccessCookie,
  buildClearedSessionCookies,
  buildSessionCookies,
  mintAccessToken,
} from '../../../../src/lib/session/session';
import type { SessionCookie } from '../../../../src/lib/session/session';
import { deploymentOriginFrom, originIsSecureFrom } from '../../../../src/lib/session/request-origin';

interface RouteContext {
  params: Promise<{ path?: string[] }>;
}

export function GET(request: Request, context: RouteContext): Promise<Response> {
  return proxy(request, context);
}

export function POST(request: Request, context: RouteContext): Promise<Response> {
  return proxy(request, context);
}

export function PATCH(request: Request, context: RouteContext): Promise<Response> {
  return proxy(request, context);
}

export function PUT(request: Request, context: RouteContext): Promise<Response> {
  return proxy(request, context);
}

export function DELETE(request: Request, context: RouteContext): Promise<Response> {
  return proxy(request, context);
}

const AUTH_SEGMENT = 'auth';

async function proxy(request: Request, context: RouteContext): Promise<Response> {
  const segments = (await context.params).path ?? [];
  const requestUrl = new URL(request.url);

  const upstream = buildUpstreamUrl(segments, requestUrl.searchParams, apiBaseUrl());

  if (upstream === null) {
    // A traversal or off-origin path; the browser leg should never build one (invariant 12),
    // so this is a defensive 400 rather than a user-facing condition.
    return bffErrorResponse(400, 'validation_failed', 'The request path is not valid.');
  }

  // CSRF: a mutating request must carry the deployment's own Origin (else 403). The check
  // runs BEFORE the header is forwarded, so no other value can reach the API (invariant 9).
  const mutating = isMutatingMethod(request.method);

  if (mutating) {
    const origin = request.headers.get('origin');

    // Comparand from the shared helper, which states the trust assumption on the forwarded
    // pair (`request-origin.ts`).
    if (origin === null || origin !== deploymentOriginFrom(request.headers, requestUrl)) {
      return bffErrorResponse(403, 'validation_failed', 'The request origin is not allowed.');
    }
  }

  const cookies = parseCookies(request.headers.get('cookie'));
  const secure = originIsSecureFrom(request.headers, requestUrl);

  // The auth surface has three flows that set or clear cookies. Everything else is a plain
  // authenticated proxy call with refresh-once on token_expired.
  if (segments[0] === AUTH_SEGMENT) {
    if (isSignIn(request.method, segments)) {
      return signIn(request, upstream, secure);
    }

    if (isSignOut(request.method, segments)) {
      return signOut(request, upstream, cookies, secure);
    }
  }

  return proxyWithRefresh(request, upstream, segments, cookies, secure, mutating);
}

/**
 * The general proxied call. Attaches `Authorization: Bearer <sk_at>`, forwards only the
 * allowlisted request headers (+ `origin` when mutating), forwards the browser address when
 * `BFF_PROXY_SECRET` is set, and on a 401 `token_expired` refreshes from `sk_rt` once and
 * retries once, setting the fresh `sk_at` on the response.
 */
async function proxyWithRefresh(
  request: Request,
  upstream: URL,
  segments: string[],
  cookies: Map<string, string>,
  secure: boolean,
  mutating: boolean,
): Promise<Response> {
  const body = await readBody(request);
  const accessToken = cookies.get(ACCESS_COOKIE);

  const first = await forwardUpstream(request, upstream, accessToken, body, mutating);
  const firstRaw = await first.text();

  if (first.status !== 401 || !isTokenExpired(firstRaw)) {
    return finishProxied(first, firstRaw, segments);
  }

  // Refresh once. Two consecutive failures (no sk_rt, mint refuses, or the retry 401s again)
  // clear both cookies and return 401 (ADR-0014).
  const sessionToken = cookies.get(REFRESH_COOKIE);

  if (sessionToken === undefined || sessionToken === '') {
    return unauthenticatedAndCleared(secure);
  }

  // The ONE mint path (session.ts), collapsed on a hash of sk_rt across parallel callers.
  const newJwt = await mintAccessToken(sessionToken);

  if (newJwt === null) {
    return unauthenticatedAndCleared(secure);
  }

  const retry = await forwardUpstream(request, upstream, newJwt, body, mutating);
  const retryRaw = await retry.text();

  if (retry.status === 401 && isTokenExpired(retryRaw)) {
    return unauthenticatedAndCleared(secure);
  }

  const response = finishProxied(retry, retryRaw, segments);
  // Persist the refreshed access token so the next request does not refresh again.
  appendCookies(response, [buildAccessCookie(newJwt, secure)]);

  return response;
}

/** Issues the upstream request with the allowlisted headers, the bearer token, and the client address. */
async function forwardUpstream(
  request: Request,
  upstream: URL,
  accessToken: string | undefined,
  body: BodyInit | undefined,
  mutating: boolean,
): Promise<Response> {
  const headers = buildUpstreamHeaders(request, accessToken, mutating);

  return fetch(upstream, {
    method: request.method,
    headers,
    body,
    redirect: UPSTREAM_FETCH_REDIRECT,
  });
}

/**
 * The upstream request headers. TWO allowlists read together (F-288): the unconditional set
 * plus `origin` on mutating methods. Inbound `x-shortkit-*` are NEVER forwarded — the proxy
 * sets its own afresh. Browser cookies are NEVER forwarded upstream.
 */
function buildUpstreamHeaders(request: Request, accessToken: string | undefined, mutating: boolean): Headers {
  const headers = new Headers();

  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = request.headers.get(name);

    if (value !== null) {
      headers.set(name, value);
    }
  }

  if (mutating) {
    for (const name of FORWARDED_REQUEST_HEADERS_MUTATING_ONLY) {
      const value = request.headers.get(name);

      if (value !== null) {
        headers.set(name, value);
      }
    }
  }

  if (accessToken !== undefined && accessToken !== '') {
    headers.set('authorization', `Bearer ${accessToken}`);
  }

  attachClientAddress(request, headers);

  return headers;
}

/**
 * The browser address, forwarded ONLY when `BFF_PROXY_SECRET` is set
 * (trusted-client-address.md): `x-shortkit-client-ip` from `x-vercel-forwarded-for`,
 * authenticated by `x-shortkit-proxy-auth = BFF_PROXY_SECRET`. With no secret, forward
 * NEITHER header.
 *
 * `x-vercel-forwarded-for` is read whole and forwarded only when it is a single valid IP
 * (`isIP`). A comma-joined or otherwise non-IP value is dropped — never the leftmost entry
 * of a list (F-035/F-009, web-api-client.md "read whole, never a leftmost list entry"). A
 * comma-bearing value fails `isIP` and so is omitted, which is also what the API-side
 * `readTrustedClientAddress` requires (it returns null for any list).
 */
function attachClientAddress(request: Request, headers: Headers): void {
  const secret = process.env.BFF_PROXY_SECRET;

  if (secret === undefined || secret.trim() === '') {
    return;
  }

  const forwarded = request.headers.get(VERCEL_CLIENT_IP_HEADER);

  if (forwarded === null) {
    return;
  }

  const address = forwarded.trim();

  if (address === '' || isIP(address) === 0) {
    return;
  }

  headers.set(BFF_CLIENT_IP_HEADER, address);
  headers.set(BFF_PROXY_AUTH_HEADER, secret);
}

/**
 * `POST /api/bff/auth/sign-in/email`. On success, take the Better Auth SESSION token from
 * the upstream body's `token` field (auth-tokens.md `authSessionContract`), mint a JWT via
 * `GET {API}/api/auth/token` with `Bearer <session token>`, set both cookies, and return
 * the body with the session token STRIPPED (F-208). An error body is mapped through
 * `mapBetterAuthError`.
 */
async function signIn(request: Request, upstream: URL, secure: boolean): Promise<Response> {
  const body = await readBody(request);
  const upstreamResponse = await forwardUpstream(request, upstream, undefined, body, true);
  const raw = await upstreamResponse.text();

  if (!upstreamResponse.ok) {
    return mappedAuthError(upstreamResponse, raw);
  }

  // The upstream body is validated against the shared `authSessionContract` (`{ token, user }`;
  // `token` is the SESSION token, nullable), not duck-typed. A 2xx that fails it carries no
  // credential this route can act on, so no cookies are set and the body goes back stripped.
  const parsed = tryParseJson(raw);
  const session = authSessionContract.safeParse(parsed);
  const sessionToken = session.success && session.data.token !== null && session.data.token !== '' ? session.data.token : null;

  if (sessionToken === null) {
    return authBodyResponse(upstreamResponse.status, stripSessionToken(parsed));
  }

  const jwt = await mintAccessToken(sessionToken);

  if (jwt === null) {
    return bffErrorResponse(500, 'internal_error', 'The request could not be completed.');
  }

  const response = authBodyResponse(upstreamResponse.status, stripSessionToken(parsed));
  appendCookies(response, buildSessionCookies(jwt, sessionToken, secure));

  return response;
}

/**
 * `POST /api/bff/auth/sign-out`. Calls Better Auth sign-out upstream with the session token
 * (which revokes the `jti`, ADR-0013), then clears both cookies with `Max-Age=0`. AC-21
 * passes on the cookie clear alone; revocation closes the replay window.
 */
async function signOut(
  request: Request,
  upstream: URL,
  cookies: Map<string, string>,
  secure: boolean,
): Promise<Response> {
  const sessionToken = cookies.get(REFRESH_COOKIE);

  // Best-effort upstream revocation; the response is built from the cookie clear regardless.
  if (sessionToken !== undefined && sessionToken !== '') {
    try {
      await forwardUpstream(request, upstream, sessionToken, undefined, true);
    } catch {
      // A sign-out never fails on the browser's side for an unreachable upstream: the
      // cookie clear is what AC-21 turns on, and the 300 s window closes the rest.
    }
  }

  const response = authBodyResponse(200, { success: true });
  appendCookies(response, buildClearedSessionCookies(secure));

  return response;
}

/**
 * Builds the browser-facing response from an upstream one: only the allowlisted response
 * headers, `Cache-Control: no-store` on every response (F-287), upstream `Set-Cookie`
 * DROPPED. `session.token` is stripped from any proxied auth-surface body (F-208).
 *
 * EVERY ERROR ON THE AUTH SURFACE IS MAPPED through `mapBetterAuthError` (review round 1,
 * CRITICAL). `/api/auth/*` is mounted outside Nest (ADR-0013), so its errors are Better
 * Auth's native `{ message, code }` — a shape whose `code` is a string too, which is why the
 * earlier guard ("already has a string `code`") let every native body through to the browser
 * to fail `errorEnvelopeContract` client-side and degrade to `internal_error`. The one
 * exception is a body that IS an `ErrorEnvelope` by the shared contract's CLOSED code enum
 * (`isErrorEnvelope`, @shortkit/contracts): the Express limiters in front of the mount emit
 * that shape with `Retry-After` set, and it passes through untouched.
 */
function finishProxied(upstreamResponse: Response, raw: string, segments: string[]): Response {
  const onAuthSurface = segments[0] === AUTH_SEGMENT;

  if (onAuthSurface && !upstreamResponse.ok && !isErrorEnvelope(tryParseJson(raw))) {
    return mappedAuthError(upstreamResponse, raw);
  }

  // F-208: strip the session token from any proxied body (get-session returns it in the body).
  const bodyText = onAuthSurface ? stripSessionTokenText(raw) : raw;

  const response = new NextResponse(bodyText, { status: upstreamResponse.status });
  copyReturnedHeaders(upstreamResponse, response);

  return response;
}

/**
 * Maps a Better Auth error body to an `ErrorEnvelope`-shaped JSON response. The upstream
 * `Retry-After` header is threaded into the mapping (header first, `retryAfterSeconds` body
 * fallback, F-027) and re-emitted on the browser-facing response as delta-seconds.
 * `x-request-id` is kept so the two legs can be correlated.
 */
function mappedAuthError(upstreamResponse: Response, raw: string): Response {
  const error = mapBetterAuthError(
    upstreamResponse.status,
    tryParseJson(raw),
    upstreamResponse.headers.get('retry-after'),
  );
  const response = bffErrorResponse(error.status, error.code, error.message, error.details);

  if (error.retryAfterSeconds !== undefined) {
    response.headers.set('retry-after', String(error.retryAfterSeconds));
  }

  const requestId = upstreamResponse.headers.get('x-request-id');

  if (requestId !== null) {
    response.headers.set('x-request-id', requestId);
  }

  return response;
}

/** Only the allowlisted response headers survive, and `cache-control` is set by the proxy. */
function copyReturnedHeaders(upstreamResponse: Response, response: Response): void {
  for (const name of RETURNED_RESPONSE_HEADERS) {
    const value = upstreamResponse.headers.get(name);

    if (value !== null) {
      response.headers.set(name, value);
    }
  }

  response.headers.set('cache-control', PROXY_RESPONSE_CACHE_CONTROL);
}

/** A JSON body from the proxy itself (auth flows, sign-out), always `no-store`. */
function authBodyResponse(status: number, body: unknown): NextResponse {
  const response = NextResponse.json(body, { status });
  response.headers.set('cache-control', PROXY_RESPONSE_CACHE_CONTROL);

  return response;
}

/** An `ErrorEnvelope`-shaped response the browser's `apiClient` reads through step 2. */
function bffErrorResponse(status: number, code: string, message: string, details?: unknown): NextResponse {
  const body: { code: string; message: string; details?: unknown } = { code, message };

  if (details !== undefined) {
    body.details = details;
  }

  const response = NextResponse.json(body, { status });
  response.headers.set('cache-control', PROXY_RESPONSE_CACHE_CONTROL);

  return response;
}

/** 401 `unauthenticated` with both cookies cleared — the two-consecutive-failures outcome. */
function unauthenticatedAndCleared(secure: boolean): Response {
  const response = bffErrorResponse(401, 'unauthenticated', 'The request could not be completed.');
  appendCookies(response, buildClearedSessionCookies(secure));

  return response;
}

function appendCookies(response: Response, cookies: SessionCookie[]): void {
  for (const cookie of cookies) {
    response.headers.append('set-cookie', serializeCookie(cookie));
  }
}

function serializeCookie(cookie: SessionCookie): string {
  const parts = [
    `${cookie.name}=${cookie.value}`,
    `Path=${cookie.path}`,
    `Max-Age=${String(cookie.maxAge)}`,
    'SameSite=Lax',
  ];

  if (cookie.httpOnly) {
    parts.push('HttpOnly');
  }

  if (cookie.secure) {
    parts.push('Secure');
  }

  return parts.join('; ');
}

// --------------------------------------------------------------------------
// Small request/body helpers.
// --------------------------------------------------------------------------

function isSignIn(method: string, segments: string[]): boolean {
  return (
    method.toUpperCase() === 'POST' &&
    segments.length === 3 &&
    segments[1] === 'sign-in' &&
    segments[2] === 'email'
  );
}

function isSignOut(method: string, segments: string[]): boolean {
  return method.toUpperCase() === 'POST' && segments.length === 2 && segments[1] === 'sign-out';
}

/** Reads the request body once, as a Buffer, so it can be forwarded (and re-forwarded on retry). */
async function readBody(request: Request): Promise<BodyInit | undefined> {
  if (request.method === 'GET' || request.method === 'HEAD') {
    return undefined;
  }

  const buffer = await request.arrayBuffer();

  return buffer.byteLength === 0 ? undefined : Buffer.from(buffer);
}

function parseCookies(header: string | null): Map<string, string> {
  const jar = new Map<string, string>();

  if (header === null) {
    return jar;
  }

  for (const pair of header.split(';')) {
    const index = pair.indexOf('=');

    if (index === -1) {
      continue;
    }

    const name = pair.slice(0, index).trim();
    const value = pair.slice(index + 1).trim();

    if (name !== '') {
      jar.set(name, value);
    }
  }

  return jar;
}

function tryParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function isTokenExpired(raw: string): boolean {
  const body = tryParseJson(raw);

  return (
    typeof body === 'object' &&
    body !== null &&
    (body as { code?: unknown }).code === 'token_expired'
  );
}

/**
 * Removes the session token from a parsed body: both a top-level `token` and a nested
 * `session.token` (F-208). Arrays pass through untouched — no array-shaped auth response is
 * proxied today (`list-sessions` is not on any card), and spreading one into `{}` would
 * turn it into an index-keyed object.
 */
function stripSessionToken(body: unknown): unknown {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return body;
  }

  const clone: Record<string, unknown> = { ...(body as Record<string, unknown>) };
  delete clone.token;

  const session = clone.session;

  if (typeof session === 'object' && session !== null) {
    const sessionClone: Record<string, unknown> = { ...(session as Record<string, unknown>) };
    delete sessionClone.token;
    clone.session = sessionClone;
  }

  return clone;
}

/** Same as `stripSessionToken` but on the raw text; passes non-JSON through untouched. */
function stripSessionTokenText(raw: string): string {
  const body = tryParseJson(raw);

  if (body === undefined) {
    return raw;
  }

  return JSON.stringify(stripSessionToken(body));
}

function apiBaseUrl(): string {
  const value = process.env.API_BASE_URL;

  if (value === undefined || value.trim() === '') {
    throw new Error('API_BASE_URL is not set. The BFF proxy forwards to it (ADR-0014).');
  }

  return value;
}
