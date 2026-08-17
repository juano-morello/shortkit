/**
 * Contract: docs/contracts/web-api-client.md (invariant 5: "`serverApiClient` cannot set
 *   cookies during render, so on `token_expired` it throws a redirect to a refresh route
 *   handler that bounces back").
 * ADR: adr-0014-web-session-handling.md ("Server components skip the proxy").
 * Produced by: TASK-007.
 * Consumed by: `serverApiClient` (`SERVER_COMPONENT_REFRESH_PATH` points here).
 *
 * The refresh-and-bounce handler. A server component that meets a 401 `token_expired`
 * cannot write `sk_at` mid-render, so it redirects here; this route handler runs in the
 * mutable-cookie phase, mints a fresh JWT from `sk_rt` through `refreshAccessToken()` (which
 * sets `sk_at`, or clears both cookies on failure), and redirects back.
 *
 * `returnTo` is an OPEN-REDIRECT surface, guarded the same way `buildUpstreamUrl` guards
 * its path: only a same-origin RELATIVE path is accepted — it must start with a single `/`,
 * never `//` (protocol-relative) or a scheme, and after WHATWG normalisation against a
 * fixed `.invalid` base it must still be same-origin. Anything else falls back to `/`.
 * On refresh failure the redirect is to `/sign-in`, with both cookies already cleared.
 *
 * A static segment route: Next 16 resolves `/api/bff/session/refresh` here by specificity,
 * so the `[...path]` catch-all never sees it (asserted in `route.spec.ts`).
 */
import { NextResponse } from 'next/server';

import { PROXY_RESPONSE_CACHE_CONTROL } from '../../../../../src/lib/api/client';
import { SIGN_IN_ROUTE, refreshAccessToken } from '../../../../../src/lib/session/session';

/** A fixed, unresolvable base for the same-origin assertion only (RFC 2606). */
const RETURN_TO_ASSERTION_BASE = 'https://return-to-assertion.invalid';

export const DEFAULT_RETURN_TO = '/';

/**
 * Accepts only a same-origin relative path. Rejects absolute URLs, protocol-relative `//`,
 * backslash-prefixed forms browsers normalise to `//`, and anything whose normalised origin
 * is not the assertion base (i.e. would leave the deployment). Falls back to `/`.
 *
 * THE CHECK RUNS ON THE RESOLVED PATH, NOT ONLY ON THE RAW STRING (security review round 1,
 * BLOCKER). `/..//evil.test` starts with a single `/` and passes a raw-prefix check, but
 * WHATWG dot-segment removal turns its pathname into `//evil.test`, and handing that to
 * `new URL(target, origin)` re-parses it as a network-path reference — `https://evil.test/`.
 * The same holds for `/%2e%2e//evil.test`, `/a/..//evil.test` and `/..%2f%2fevil.test`
 * (the encoded slashes stay encoded, but the leading `..` still collapses). So after
 * resolution the pathname itself is refused when it starts with `//`, and the re-emitted
 * string is refused when it starts with `//` or `/\`, belt and braces. `GET` then asserts
 * the final `Location`'s origin equals the request origin before answering.
 */
export function safeReturnTo(candidate: string | null): string {
  if (candidate === null || candidate === '') {
    return DEFAULT_RETURN_TO;
  }

  // Must be a single-slash-rooted path: not `//host`, not `\\host`, not `/\host`, not `scheme:`.
  if (!candidate.startsWith('/') || candidate.startsWith('//') || candidate.startsWith('/\\')) {
    return DEFAULT_RETURN_TO;
  }

  let resolved: URL;

  try {
    resolved = new URL(candidate, RETURN_TO_ASSERTION_BASE);
  } catch {
    return DEFAULT_RETURN_TO;
  }

  if (resolved.origin !== RETURN_TO_ASSERTION_BASE) {
    return DEFAULT_RETURN_TO;
  }

  // Dot-segment removal can leave a pathname that starts with `//`, which a later parse
  // reads as a network-path reference. Refuse it here, on the RESOLVED form.
  if (resolved.pathname.startsWith('//')) {
    return DEFAULT_RETURN_TO;
  }

  // Re-emit from the parsed parts, never the raw string — and check the emitted string too.
  const emitted = `${resolved.pathname}${resolved.search}${resolved.hash}`;

  if (emitted.startsWith('//') || emitted.startsWith('/\\')) {
    return DEFAULT_RETURN_TO;
  }

  return emitted;
}

/**
 * The redirect target as an absolute URL on the request origin. Built from the already
 * vetted relative path and asserted to be same-origin; the assertion is the load-bearing
 * line, the same role `buildUpstreamUrl` step 3 plays.
 */
export function redirectLocation(relativePath: string, requestOrigin: string): URL {
  const location = new URL(relativePath, requestOrigin);

  if (location.origin !== requestOrigin) {
    return new URL(DEFAULT_RETURN_TO, requestOrigin);
  }

  return location;
}

export async function GET(request: Request): Promise<Response> {
  const requestUrl = new URL(request.url);
  const returnTo = safeReturnTo(requestUrl.searchParams.get('returnTo'));

  let target = returnTo;

  try {
    await refreshAccessToken();
  } catch {
    // refreshAccessToken has already cleared both cookies. Send the visitor to sign in.
    target = SIGN_IN_ROUTE;
  }

  const response = NextResponse.redirect(redirectLocation(target, requestUrl.origin), 303);
  response.headers.set('cache-control', PROXY_RESPONSE_CACHE_CONTROL);

  return response;
}
