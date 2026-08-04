/**
 * Contract: design/contracts/web-api-client.md
 * ADR: adr-0014-web-session-handling.md, adr-0005, adr-0013
 * Produced by: TASK-008
 * Consumed by: TASK-012, 015, 019, 022, 026, 028, 041, 044, 047, 050, 052, 055, 057
 *
 * NO SCREEN CALLS fetch() DIRECTLY. Every request goes through one of these two.
 */
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
  /** Present when code === 'rate_limited'. From the Retry-After header. */
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
 * Browser-side. Targets the SAME-ORIGIN BFF proxy at /api/bff/<path>, which attaches
 * the Bearer JWT from the httpOnly `sk_at` cookie.
 * The browser never talks to Fly and never holds a token (TASK-012's constraint).
 *
 * Token refresh happens inside the proxy and is invisible here: a screen never sees
 * `token_expired`.
 * 429 handling and Retry-After live here, centrally (TASK-052, AC-87). Form state
 * survives: this throws, it never resets, navigates or clears an input.
 */
export function apiClient<TRes>(_req: ApiRequest<TRes>): Promise<TRes> {
  throw new Error('not implemented');
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

/** Allowlists, not denylists. `cookie` upstream and `set-cookie` downstream are absent. */
export const FORWARDED_REQUEST_HEADERS = ['content-type', 'accept', 'x-request-id'] as const;
export const RETURNED_RESPONSE_HEADERS = ['content-type', 'retry-after', 'x-request-id'] as const;
