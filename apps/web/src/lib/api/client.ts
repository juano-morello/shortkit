/**
 * Contract: design/contracts/web-api-client.md
 * ADR: adr-0014-web-session-handling.md, adr-0005, adr-0013
 * Produced by: TASK-008
 * Consumed by: TASK-012, 015, 019, 022, 026, 028, 041, 044, 047, 050, 052, 055, 057
 *
 * NO SCREEN CALLS fetch() DIRECTLY. Every request goes through one of these two.
 */
import { isErrorEnvelope } from '@shortkit/contracts';
import type { z } from 'zod';
import type { ErrorCode } from '@shortkit/contracts';

export interface ApiRequest<TRes, TBody = unknown> {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  /** API path WITHOUT the /api prefix, e.g. '/links/abc'. */
  path: string;
  /** The response IS validated against this. A mismatch throws ContractViolationError. */
  contract: z.ZodType<TRes>;
  body?: TBody;
  query?: Record<string, string | number | boolean | undefined>;
  signal?: AbortSignal;
}

export class ApiError extends Error {
  readonly code: ErrorCode;
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
  readonly path: string;
  readonly issues: z.ZodIssue[];

  constructor(path: string, issues: z.ZodIssue[]) {
    super(`Response from ${path} did not match its contract.`);
    this.name = 'ContractViolationError';
    this.path = path;
    this.issues = issues;
  }
}

export class NetworkError extends Error {}

/**
 * The same-origin prefix every browser request is sent under. `apiClient` names no origin
 * and reads no base URL: the browser calls THIS app, which forwards to Fly.
 *
 * `NEXT_PUBLIC_API_BASE_URL` is deliberately not read here. web-api-client.md: "it is not
 * used for anything authenticated. Authenticated traffic uses the same-origin `/api/bff`
 * path or the server-only `API_BASE_URL`." Reading it would also be the F-174 trap the
 * TASK card warns about, one step earlier.
 */
const BFF_PATH_PREFIX = '/api/bff';

/**
 * The message an `ApiError` carries when the API answered with something that is not an
 * `ErrorEnvelope` (response handling step 5), so there is no server-supplied message to
 * show. Same text as the API's own `INTERNAL_ERROR_MESSAGE`, which lives in
 * `apps/api/src/common/errors/domain-error.ts` and is not importable from here.
 */
const UNEXPECTED_RESPONSE_MESSAGE = 'The request could not be completed.';

/** Query values that are `undefined` are omitted, not sent as the string "undefined". */
function requestUrl(path: string, query: ApiRequest<unknown>['query']): string {
  const url = `${BFF_PATH_PREFIX}${path}`;

  if (query === undefined) {
    return url;
  }

  const search = new URLSearchParams();

  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) {
      search.set(key, String(value));
    }
  }

  const serialised = search.toString();

  return serialised === '' ? url : `${url}?${serialised}`;
}

function requestInit<TRes>(req: ApiRequest<TRes>): RequestInit {
  if (req.body === undefined) {
    return { method: req.method, signal: req.signal };
  }

  return {
    method: req.method,
    signal: req.signal,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(req.body),
  };
}

/**
 * Response handling steps 2 and 5. A body the shared envelope contract accepts becomes an
 * `ApiError` carrying the API's own `code`, `status` and `details`; anything else — Better
 * Auth's native shape, an HTML page from an interposed proxy, an empty body — becomes an
 * `ApiError` with `internal_error` and the original status.
 *
 * Neither is a `ContractViolationError`. AC-15 reserves that for a response the caller was
 * told to expect data in; an error the API deliberately returned is not malformed data.
 */
function toApiError(status: number, raw: string): ApiError {
  const body = tryParseJson(raw);

  if (isErrorEnvelope(body)) {
    return new ApiError({
      code: body.code,
      status,
      message: body.message,
      details: body.details,
    });
  }

  return new ApiError({
    code: 'internal_error',
    status,
    message: UNEXPECTED_RESPONSE_MESSAGE,
  });
}

/** `undefined` for a body that is not JSON. Only ever fed to a schema that rejects it. */
function tryParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/**
 * Browser-side. Targets the SAME-ORIGIN BFF proxy at /api/bff/<path>, which attaches
 * the Bearer JWT from the httpOnly `sk_at` cookie.
 * The browser never talks to Fly and never holds a token (TASK-012's constraint).
 *
 * Token refresh happens inside the proxy and is invisible here: a screen never sees
 * `token_expired`.
 * 429 handling and Retry-After belong here, centrally (TASK-052, AC-87) — see the seam
 * noted below. Form state survives: this throws, it never resets, navigates or clears an
 * input.
 *
 * Response handling follows web-api-client.md in its stated order. AC-15 turns on the
 * three-way split it produces: a 2xx body the declared contract rejects raises
 * `ContractViolationError`, an error the API returned raises `ApiError`, and a transport
 * failure raises `NetworkError`. Nothing collapses the last two into the first.
 *
 * 429/`Retry-After` normalisation is NOT implemented here. It is TASK-052's (AC-87), which
 * is deferred; `ApiError.retryAfterSeconds` is therefore always undefined today. A 429
 * arrives through step 2 as an ordinary `ApiError` with `code: 'rate_limited'`.
 */
export async function apiClient<TRes>(req: ApiRequest<TRes>): Promise<TRes> {
  let response: Response;

  try {
    response = await fetch(requestUrl(req.path, req.query), requestInit(req));
  } catch (cause) {
    // Step 6. `fetch` rejects only on a transport failure; an HTTP error status resolves.
    throw new NetworkError(`Request to ${req.path} could not be sent.`, { cause });
  }

  let raw: string;

  try {
    raw = await response.text();
  } catch (cause) {
    // The response headers arrived and the body did not. Still transport, still step 6.
    throw new NetworkError(`Response from ${req.path} could not be read.`, { cause });
  }

  if (!response.ok) {
    throw toApiError(response.status, raw);
  }

  let body: unknown;

  try {
    body = JSON.parse(raw);
  } catch {
    // Ruled 2026-08-06 (TASK-008.md): a 2xx carrying something unparseable as JSON is a
    // CONTRACT VIOLATION, not a transport error. AC-15 makes no exception for a body that
    // fails earlier than `safeParse`, and a caller retrying on `NetworkError` would
    // otherwise retry an HTML error page that can never become data. `issues` is empty
    // because validation never ran; there is nothing zod reported to carry.
    throw new ContractViolationError(req.path, []);
  }

  const result = req.contract.safeParse(body);

  if (!result.success) {
    throw new ContractViolationError(req.path, result.error.issues);
  }

  // Step 1's guarantee, and invariant 1: what this resolves with validated against
  // `contract`. The parse OUTPUT is returned, never the input.
  return result.data;
}

/**
 * Server components. Reads `sk_at` via next/headers cookies() and calls Fly directly,
 * one hop instead of two. It cannot set cookies during render, so on `token_expired`
 * it throws a redirect to a refresh route handler that bounces back.
 */
export function serverApiClient<TRes>(_req: ApiRequest<TRes>): Promise<TRes> {
  throw new Error('not implemented');
}

/**
 * Better Auth's routes are mounted outside Nest (ADR-0013), so their error bodies are
 * Better Auth's native shape, NOT ErrorEnvelope. TASK-008 maps them here.
 */
export function mapBetterAuthError(_status: number, _body: unknown): ApiError {
  throw new Error('not implemented');
}

/**
 * ============================================================================
 * BFF proxy upstream URL. F-008. Used by app/api/bff/[...path]/route.ts.
 * ============================================================================
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
 */
export const FORWARDED_REQUEST_HEADERS = ['content-type', 'accept', 'x-request-id'] as const;
export const RETURNED_RESPONSE_HEADERS = ['content-type', 'retry-after', 'x-request-id'] as const;

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
