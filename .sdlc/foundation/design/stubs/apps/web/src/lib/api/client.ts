/**
 * Contract: design/contracts/web-api-client.md
 * ADR: adr-0014-web-session-handling.md, adr-0005, adr-0013, adr-0029
 * Produced by: TASK-008
 * Consumed by: TASK-012, 015, 019, 022, 026, 028, 041, 044, 047, 050, 052, 055, 057
 *
 * NO SCREEN CALLS fetch() DIRECTLY. Every request goes through one of these two.
 *
 * Amended 2026-08-10 (F-284, F-285, F-287, F-292; ADR-0029): route templates replace the
 * raw `path`, abort is its own error class, and the proxy sets its own Cache-Control.
 */
import type { z } from 'zod';
import type { ErrorCode } from '@shortkit/contracts';

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';

/**
 * ============================================================================
 * ADR-0029. A CREDENTIAL IS NEVER CONSTRUCTIBLE INTO AN ERROR STRING.
 * ============================================================================
 *
 * `path` is a ROUTE TEMPLATE and a string literal in the source. Caller-supplied values
 * go in `params` and reach the URL, the wire, and NOTHING ELSE — not a message, not an
 * own enumerable property, not the message of a validation failure that rejects them.
 *
 *   apiClient({ method: 'GET', path: '/invitations/:token',
 *               params: { token: raw }, contract: invitationContract })
 *
 * NEVER `path: `/invitations/${raw}``. TASK-022's invitation token is
 * <tenantId>.<43-char base64url secret> — a bearer credential whose own contract says it
 * is "never stored, never logged, and never returned by any read" — and every default
 * sink downstream (unhandled rejection, Next error overlay, any telemetry SDK added
 * later) prints `message` and own properties with no code written to make it happen.
 */
export interface ApiRequest<TRes, TBody = unknown> {
  method: HttpMethod;
  /** Route template. Literal segments lowercase kebab; values are `:name` placeholders. */
  path: string;
  /** Exactly one entry per placeholder in `path`. No extras, no omissions. */
  params?: Record<string, string | number>;
  /** The response IS validated against this. A mismatch throws ContractViolationError. */
  contract: z.ZodType<TRes>;
  body?: TBody;
  query?: Record<string, string | number | boolean | undefined>;
  signal?: AbortSignal;
}

/**
 * A literal segment, or a `:name` placeholder. Nothing else.
 *
 * This is a backstop, not the guarantee — the RULE is what forbids interpolation. It does
 * reject the invitation token deterministically, on the `.` separator, which is not in
 * the literal-segment alphabet and cannot be. It also rejects `..`, `%2e%2e`, `?`, `#`,
 * `\`, `:` inside a literal, and the empty segment, which is the browser-leg mirror of
 * the segment rejection buildUpstreamUrl performs on the Fly leg (F-008, F-285).
 *
 * The bounds are there so a placeholder name cannot itself become a carrier.
 */
export const ROUTE_TEMPLATE_PATTERN =
  /^(?:\/(?:[a-z0-9][a-z0-9-]{0,63}|:[a-zA-Z][a-zA-Z0-9]{0,29}))+$/;

/**
 * Used ONLY to assert the built URL is still under BFF_PATH_PREFIX after WHATWG
 * normalisation. `.invalid` is reserved (RFC 2606) and never resolves; the request is
 * sent with the relative string, not with this.
 */
export const ROUTE_ASSERTION_BASE = 'https://route-assertion.invalid';

/**
 * Message builders. THEY INTERPOLATE `method` AND `path` AND NOTHING ELSE (ADR-0029):
 * `method` is a closed union of four literals, and `path` is a source literal that has
 * passed ROUTE_TEMPLATE_PATTERN by the time every builder but `invalidRouteMessage` runs.
 *
 * `invalidRouteMessage` names NO path: at that point the path is the value under
 * suspicion, and a rejection that echoes what it rejected is the leak wearing a different
 * hat. `invalidParamValueMessage` names no value, for the same reason and always.
 *
 * Reached only through CLIENT_MESSAGES, which exists so a spec can assert the exact text
 * without copying the literals. No screen calls them.
 */
const contractViolationMessage = (m: HttpMethod, p: string): string =>
  `Response from ${m} ${p} did not match its contract.`;
const networkSendMessage = (m: HttpMethod, p: string): string =>
  `Request to ${m} ${p} could not be sent.`;
const networkReadMessage = (m: HttpMethod, p: string): string =>
  `Response from ${m} ${p} could not be read.`;
const requestAbortedMessage = (m: HttpMethod, p: string): string =>
  `Request to ${m} ${p} was aborted by the caller.`;
const invalidRouteMessage = (m: HttpMethod): string =>
  `apiClient: the ${m} path is not a route template.`;
const unresolvedParamsMessage = (m: HttpMethod, p: string): string =>
  `apiClient: params do not match ${m} ${p}.`;
const invalidParamValueMessage = (m: HttpMethod, p: string): string =>
  `apiClient: a param value for ${m} ${p} is empty, '.' or '..'.`;

/** For specs. The client builds its own messages; no screen calls these. */
export const CLIENT_MESSAGES = {
  contractViolation: contractViolationMessage,
  networkSend: networkSendMessage,
  networkRead: networkReadMessage,
  requestAborted: requestAbortedMessage,
  invalidRoute: invalidRouteMessage,
  unresolvedParams: unresolvedParamsMessage,
  invalidParamValue: invalidParamValueMessage,
} as const;

export class ApiError extends Error {
  readonly code: ErrorCode;
  /**
   * The TRANSPORT status, verbatim. INDEPENDENT of `code`: step 5 pairs `internal_error`
   * with the original status, and Better Auth's 422 has no row in ERROR_CODE_STATUS at
   * all. Never assume ERROR_CODE_STATUS[code] === status (F-289).
   */
  readonly status: number;
  readonly details?: unknown;
  /**
   * Present when code === 'rate_limited'. From the Retry-After header, falling back to
   * a `retryAfterSeconds` field in the body (F-027): /api/auth/* is mounted outside
   * Nest, so the email rate limiter's 429 carries the value in the body. Normalising
   * both here is what lets TASK-052's central rendering work on the login screen.
   */
  readonly retryAfterSeconds?: number;

  constructor(_init: {
    code: ErrorCode;
    status: number;
    message: string;
    details?: unknown;
    retryAfterSeconds?: number;
  }) {
    super(_init.message);
    this.name = 'ApiError';
    this.code = _init.code;
    this.status = _init.status;
    this.details = _init.details;
    this.retryAfterSeconds = _init.retryAfterSeconds;
  }
}

/** AC-15: raised instead of returning malformed data. */
export class ContractViolationError extends Error {
  /** The ROUTE TEMPLATE. Never a resolved path, never a param value (ADR-0029). */
  readonly path: string;
  readonly issues: z.ZodIssue[];

  constructor(method: HttpMethod, path: string, issues: z.ZodIssue[], options?: ErrorOptions) {
    super(contractViolationMessage(method, path), options);
    this.name = 'ContractViolationError';
    this.path = path;
    this.issues = issues;
  }
}

export class NetworkError extends Error {
  /** The ROUTE TEMPLATE. */
  readonly path: string;

  constructor(message: string, path: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'NetworkError';
    this.path = path;
  }
}

/**
 * F-292. A cancellation the CALLER initiated through `req.signal`.
 *
 * It does NOT extend NetworkError. A screen that aborts on each keystroke must not render
 * a network-failure state for its own cancellation, and a retry wrapper keyed on
 * NetworkError must not re-issue a request the caller deliberately cancelled.
 *
 * `cause` is the platform rejection or `signal.reason`. `signal.reason` is CALLER-SUPPLIED
 * and sits outside ADR-0029's guarantee for `message` and `path`.
 */
export class RequestAbortedError extends Error {
  /** The ROUTE TEMPLATE. */
  readonly path: string;

  constructor(method: HttpMethod, path: string, options?: ErrorOptions) {
    super(requestAbortedMessage(method, path), options);
    this.name = 'RequestAbortedError';
    this.path = path;
  }
}

/**
 * The same-origin prefix every browser request is sent under. `apiClient` names no origin
 * and reads no base URL: the browser calls THIS app, which forwards to Fly.
 *
 * `NEXT_PUBLIC_API_BASE_URL` is deliberately not read here (F-174).
 */
export const BFF_PATH_PREFIX = '/api/bff';

/**
 * Request path construction, ORDERED AND NORMATIVE (web-api-client.md). Throws a plain
 * Error on every rejection: these are programming defects, no request was made, and none
 * of the four ApiRequest failure classes applies.
 *
 *   1. ROUTE_TEMPLATE_PATTERN.test(path) === false -> invalidRouteMessage(method)
 *   2. placeholder set !== Object.keys(params ?? {}) -> unresolvedParamsMessage
 *   3. encodeURIComponent(String(value)) is '' or '.' or '..' -> invalidParamValueMessage
 *      ('..' survives encodeURIComponent because dot is unreserved; the browser then
 *      normalises it away and escapes the prefix. THIS is the check that stops F-285.)
 *   4. substitute the ENCODED values into the template
 *   5. BFF_PATH_PREFIX + resolved, then the query from URLSearchParams
 *   6. assert new URL(url, ROUTE_ASSERTION_BASE).pathname starts with BFF_PATH_PREFIX + '/'
 *      <- unreachable given 1 and 3, and NOT redundant with them: it is what makes any
 *         future change to them safe. Same role as step 3 of buildUpstreamUrl.
 */
export function buildRequestUrl<TRes>(_req: ApiRequest<TRes>): string {
  throw new Error('not implemented');
}

/**
 * Browser-side. Targets the SAME-ORIGIN BFF proxy at /api/bff/<path>, which attaches
 * the Bearer JWT from the httpOnly `sk_at` cookie.
 * The browser never talks to Fly and never holds a token (TASK-012's constraint).
 *
 * Token refresh happens inside the proxy and is invisible here: a screen never sees
 * `token_expired`.
 * 429 handling and Retry-After live here, centrally (TASK-052, AC-87). Form state
 * survives: this throws, it never resets, navigates or clears an input.
 *
 * Four outcomes, distinguishable without inspecting internals (AC-15):
 *   2xx failing contract.safeParse   -> ContractViolationError
 *   an error the API returned        -> ApiError
 *   a transport failure              -> NetworkError
 *   req.signal aborted               -> RequestAbortedError   (F-292; NOT a NetworkError)
 *
 * The abort discriminator is `req.signal?.aborted`, NOT `cause.name === 'AbortError'`:
 * abort(reason) makes fetch reject with signal.reason, which has no guaranteed `name`.
 */
export function apiClient<TRes>(_req: ApiRequest<TRes>): Promise<TRes> {
  throw new Error('not implemented');
}

/**
 * DEFERRED 2026-08-10 by the F-291 ruling (TASK-008.md). Its consumer, the proxy route
 * and the auth surface, left with EPIC-002. No caller exists today. Do not treat this
 * as an oversight; do not implement it under another TASK without re-scoping.
 *
 * Server components. Reads `sk_at` via next/headers cookies() and calls Fly directly,
 * one hop instead of two. It cannot set cookies during render, so on `token_expired`
 * it throws a redirect to a refresh route handler that bounces back.
 */
export function serverApiClient<TRes>(_req: ApiRequest<TRes>): Promise<TRes> {
  throw new Error('not implemented');
}

/**
 * DEFERRED 2026-08-10 by the F-291 ruling (TASK-008.md), with one design question left
 * open for whoever materialises it: 422 has no row in ERROR_CODE_STATUS, and the code
 * that carries USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL is undecided. Constraints on the
 * answer are in error-envelope.md, "Open: the code Better Auth's 422 carries" (F-289).
 *
 * Better Auth's routes are mounted outside Nest (ADR-0013), so their error bodies are
 * Better Auth's native shape, NOT ErrorEnvelope. Eight probed shapes: auth-tokens.md.
 */
export function mapBetterAuthError(_status: number, _body: unknown): ApiError {
  throw new Error('not implemented');
}

/**
 * ============================================================================
 * BFF proxy upstream URL. F-008. Used by app/api/bff/[...path]/route.ts.
 * ============================================================================
 *
 * DEFERRED 2026-08-10 by the F-291 ruling (TASK-008.md): the proxy route is TASK-012's
 * and left with EPIC-002.
 *
 * NEVER `${API_BASE_URL}/api/${path}` and NEVER `new URL(path, API_BASE_URL)`.
 *
 * Next.js DECODES route params, so `%2e%2e%2f` arrives as `../` and escapes the /api
 * prefix. And a path beginning `//evil.example/` resolves PROTOCOL-RELATIVE under
 * new URL(), which would attach `Authorization: Bearer <sk_at>` — a live tenant
 * credential — to an attacker-chosen origin, from a same-origin request the victim's
 * browser makes.
 *
 *   1. reject any decoded segment that is '', '.', '..', or contains / \ :
 *   2. encodeURIComponent each segment and join
 *   3. assert upstream.origin === new URL(API_BASE_URL).origin   <- load-bearing
 *   4. rebuild the query from parsed searchParams, never concatenate
 *
 * Returns null when the path is rejected; the route handler then answers 400.
 */
export function buildUpstreamUrl(
  _segments: string[],
  _searchParams: URLSearchParams,
  _apiBaseUrl: string,
): URL | null {
  throw new Error('not implemented');
}

/** `redirect: 'manual'`. An upstream 3xx is returned to the caller, never followed. */
export const UPSTREAM_FETCH_REDIRECT = 'manual' as const;

/**
 * Allowlists, not denylists. `cookie` upstream and `set-cookie` downstream are absent.
 * Inbound `x-shortkit-*` headers are NEVER forwarded: the proxy sets both of its own
 * afresh on every request (below).
 *
 * THIS IS NOT THE WHOLE REQUEST-HEADER SET. Read it together with
 * FORWARDED_REQUEST_HEADERS_MUTATING_ONLY below. Building `upstreamHeaders` from this
 * constant alone answers 403 MISSING_OR_NULL_ORIGIN to every signup, sign-in and
 * sign-out in production, while every test that speaks to the API directly passes
 * (F-233, F-288).
 */
export const FORWARDED_REQUEST_HEADERS = ['content-type', 'accept', 'x-request-id'] as const;

/**
 * F-287. `cache-control` is ABSENT on purpose: the proxy does not forward upstream's
 * value, it sets PROXY_RESPONSE_CACHE_CONTROL on every response instead.
 */
export const RETURNED_RESPONSE_HEADERS = ['content-type', 'retry-after', 'x-request-id'] as const;

/**
 * F-287. Written on EVERY response the proxy returns, whatever the upstream said.
 *
 * Without it an API response carrying `no-store` for tenant data reached the browser with
 * no cache directive at all and the decision fell to browser heuristics on a 200 GET —
 * another tenant's links, members or domains readable out of the HTTP cache by anyone
 * with later access to the browser profile. Allowlisting upstream's header instead would
 * make that depend on every present and future /api route setting one header, enforced by
 * nothing; setting it here fails closed.
 *
 * Cost accepted: nothing through /api/bff/* can ever be cached by the browser. Changing
 * that means amending web-api-client.md, not special-casing a call site.
 */
export const PROXY_RESPONSE_CACHE_CONTROL = 'no-store' as const;

/**
 * ============================================================================
 * F-233. `Origin` on mutating requests, and why dropping it breaks all of auth.
 * ============================================================================
 *
 * better-auth@1.6.26 answers 403 {"code":"MISSING_OR_NULL_ORIGIN"} to a state-changing
 * request to /api/auth/* carrying no Origin, and a server-side fetch sends none. Without
 * this header every signup, sign-in and sign-out through the proxy returns 403 in
 * production while every test that speaks to the API directly passes.
 *
 * Forward the INBOUND value VERBATIM. Never synthesise it, never default it. The CSRF
 * check below has already required it to equal the deployment origin, so the value that
 * reaches the API is that origin or the request never left Vercel.
 *
 * Mutating methods ONLY. The CSRF check does not run on GET, so a GET would forward an
 * unvalidated attacker-chosen value; and Better Auth skips the origin check on GET
 * anyway (dist/api/middlewares/origin-check.mjs:43), so GET /api/auth/token and
 * /get-session need none.
 *
 * F-288: these three exports are NOT optional and are not deferred with the proxy route.
 * web-api-client.md names this file as its normative form, so the proxy implementer reads
 * THIS, not the contract. A file that offers one allowlist under a docblock enumerating
 * what is deliberately absent tells that reader the set is complete.
 *
 * API side: trustedOrigins from WEB_APP_ORIGINS. See auth-tokens.md.
 */
export const FORWARDED_REQUEST_HEADERS_MUTATING_ONLY = ['origin'] as const;

/** Methods on which the proxy runs the CSRF check and forwards `Origin`. */
export const MUTATING_METHODS = ['POST', 'PATCH', 'PUT', 'DELETE'] as const;

/**
 * True when the proxy must require `Origin` to equal the deployment origin (403
 * otherwise) and then forward it upstream.
 */
export function isMutatingMethod(_method: string): boolean {
  throw new Error('not implemented');
}

/**
 * ============================================================================
 * F-035. The client address the proxy forwards, and where it comes from.
 * ============================================================================
 *
 * The proxy adds, on every upstream request:
 *   BFF_CLIENT_IP_HEADER:  the browser's address, read from VERCEL_CLIENT_IP_HEADER
 *   BFF_PROXY_AUTH_HEADER: process.env.BFF_PROXY_SECRET (server-only, REQUIRED,
 *                          registered by TASK-004; NEVER logged — see
 *                          logging-and-headers.md F-032 for the API-side mirror)
 *
 * VERCEL_CLIENT_IP_HEADER is read WHOLE. Vercel sets it to the connecting client's
 * public address and overwrites inbound forwarding headers (non-Enterprise), so a
 * client cannot spoof it, and unlike x-forwarded-for it is not rewritten by a proxy
 * stacked on top of Vercel.
 *
 * NEVER x-forwarded-for.split(',')[0] — the leftmost entry of a multi-valued list is
 * the construct F-009 forbids, moved one hop upstream. If the header is absent (local
 * next dev), OMIT BFF_CLIENT_IP_HEADER entirely; the API falls back to Fly-Client-IP.
 *
 * ANY proxy placed in front of Vercel (Cloudflare, a corporate gateway, an Enterprise
 * trusted-proxy config) invalidates this assumption and requires revisiting
 * web-api-client.md, not just DNS.
 *
 * API-side resolution: apps/api/src/auth/resolve-rate-limit-principal.ts (F-031).
 */
export const VERCEL_CLIENT_IP_HEADER = 'x-vercel-forwarded-for';
export const BFF_CLIENT_IP_HEADER = 'x-shortkit-client-ip';
export const BFF_PROXY_AUTH_HEADER = 'x-shortkit-proxy-auth';
