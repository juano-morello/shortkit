/**
 * Contract: docs/contracts/web-api-client.md ("Session": `useSession` reads
 *   `GET /api/bff/session`, which returns `{ user: SessionUser | null, status }`; "No token
 *   is ever exposed to the client, in any form").
 * ADR: adr-0014-web-session-handling.md ("`useSession()` reads a non-sensitive projection").
 * Produced by: TASK-007.
 * Consumed by: `useSession` (`src/lib/session/use-session.ts`).
 *
 * The session projection. Answers `{ user: { id, email, emailVerified }, status }` from the
 * `sk_at` cookie's claims. `status` is one of the stub's `SessionStatus` values:
 * `authenticated` or `unauthenticated` (`loading` is the hook's own pre-fetch state and is
 * never sent by this route). No token, no claim beyond the three above, ever leaves here.
 *
 * WHY THE JWT IS DECODED AND NOT VERIFIED HERE. The claims are read without a signature
 * check because (a) the BFF is the ONLY writer of `sk_at` (it is `HttpOnly` on this origin
 * and only `sign-in`, the refresh path and this app's own route handlers ever set it), and
 * (b) the API verifies the signature, issuer, audience, expiry and revocation on every use
 * (`AuthGuard`, auth-tokens.md). This projection is DISPLAY CONTEXT, never a security
 * control (web-api-client.md, "Workspace scoping in the UI is display context"); a forged
 * `sk_at` could at most make the header say a name, and would fail the first API call.
 * `exp` IS checked, so an expired cookie does not report a signed-in user.
 *
 * WHEN `sk_at` IS ABSENT OR EXPIRED BUT `sk_rt` IS PRESENT, the route refreshes once via
 * `refreshAccessToken()` (a 5-minute JWT expires long before the 30-day session; without
 * this, every page opened six minutes after sign-in would show signed-out). A failed refresh
 * has already cleared both cookies and reports `unauthenticated`.
 *
 * `Cache-Control: no-store` on every response (F-287). A static segment route: Next 16
 * resolves `/api/bff/session` here by specificity, so the `[...path]` catch-all never sees
 * `session` (asserted in `route.spec.ts`).
 */
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

import { PROXY_RESPONSE_CACHE_CONTROL } from '../../../../src/lib/api/client';
import {
  ACCESS_COOKIE,
  REFRESH_COOKIE,
  jwtIsExpired,
  refreshAccessToken,
  sessionUserFromJwt,
} from '../../../../src/lib/session/session';
import type { SessionStatus, SessionUser } from '../../../../src/lib/session/session';

export interface SessionProjection {
  user: SessionUser | null;
  status: Extract<SessionStatus, 'authenticated' | 'unauthenticated'>;
}

const SIGNED_OUT: SessionProjection = { user: null, status: 'unauthenticated' };

export async function GET(): Promise<Response> {
  return projectionResponse(await currentProjection());
}

async function currentProjection(): Promise<SessionProjection> {
  const store = await cookies();
  let accessToken = store.get(ACCESS_COOKIE)?.value;

  if (accessToken === undefined || accessToken === '' || jwtIsExpired(accessToken)) {
    const sessionToken = store.get(REFRESH_COOKIE)?.value;

    if (sessionToken === undefined || sessionToken === '') {
      return SIGNED_OUT;
    }

    try {
      accessToken = await refreshAccessToken();
    } catch {
      return SIGNED_OUT;
    }
  }

  const user = sessionUserFromJwt(accessToken);

  return user === null ? SIGNED_OUT : { user, status: 'authenticated' };
}

function projectionResponse(projection: SessionProjection): Response {
  const response = NextResponse.json(projection, { status: 200 });
  response.headers.set('cache-control', PROXY_RESPONSE_CACHE_CONTROL);

  return response;
}
