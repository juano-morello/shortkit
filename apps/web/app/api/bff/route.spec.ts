/**
 * TASK-007 (STORY-003, AC-18). The BFF proxy route handler.
 *
 * The handler is exercised with plain `Request` objects and an awaited `params` context,
 * exactly as Next 16 invokes it. `fetch` (the upstream leg) is the only boundary stubbed.
 *
 * Contract: docs/contracts/web-api-client.md ("The proxy route" and its sub-sections),
 * auth-tokens.md, trusted-client-address.md, ADR-0014.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { isErrorEnvelope } from '@shortkit/contracts';

import { DELETE, GET, POST } from './[...path]/route';

const DEPLOYMENT_ORIGIN = 'https://app.shortkit.test';
const API_BASE = 'http://api.internal:3001/api';
const PROXY_SECRET = 'FIXTURE-bff-proxy-secret_not_a_real_value_00';

function ctx(...path: string[]): { params: Promise<{ path: string[] }> } {
  return { params: Promise.resolve({ path }) };
}

function bffRequest(
  method: string,
  path: string[],
  init: { cookie?: string; origin?: string; headers?: Record<string, string>; body?: unknown } = {},
): Request {
  const headers = new Headers(init.headers ?? {});
  headers.set('x-forwarded-proto', 'https');
  headers.set('x-forwarded-host', 'app.shortkit.test');

  if (init.cookie !== undefined) {
    headers.set('cookie', init.cookie);
  }

  if (init.origin !== undefined) {
    headers.set('origin', init.origin);
  }

  const url = `${DEPLOYMENT_ORIGIN}/api/bff/${path.join('/')}`;

  return new Request(url, {
    method,
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

/** Every upstream call's [url, init], for asserting what reached the API. */
function upstreamCalls(): Array<{ url: string; init: RequestInit }> {
  return vi.mocked(globalThis.fetch).mock.calls.map(([input, init]) => ({
    url: String(input),
    init: init ?? {},
  }));
}

function upstreamHeader(init: RequestInit, name: string): string | null {
  return new Headers(init.headers).get(name);
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

beforeEach(() => {
  process.env.API_BASE_URL = API_BASE;
  delete process.env.BFF_PROXY_SECRET;
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.API_BASE_URL;
  delete process.env.BFF_PROXY_SECRET;
});

describe('upstream URL construction and origin safety', () => {
  it('rejects a traversal segment with 400 and makes no upstream call', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');

    const response = await GET(bffRequest('GET', ['x', '..', '..', 'health']), ctx('x', '..', '..', 'health'));

    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('forwards a clean path to the API origin with /api prefixed', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(200, { ok: true }));

    await GET(bffRequest('GET', ['links']), ctx('links'));

    expect(upstreamCalls()[0].url).toBe('http://api.internal:3001/api/links');
  });

  it('does not follow an upstream redirect (redirect: manual) so the bearer cannot leave the API origin', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, { status: 302, headers: { location: 'https://evil.test/' } }),
    );

    const response = await GET(bffRequest('GET', ['links'], { cookie: 'sk_at=the.jwt' }), ctx('links'));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1]?.redirect).toBe('manual');
    expect(response.status).toBe(302);
  });
});

describe('header allowlists in both directions', () => {
  it('forwards content-type/accept/x-request-id and the bearer, never the browser cookie', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(200, { ok: true }));

    await GET(
      bffRequest('GET', ['links'], {
        cookie: 'sk_at=the.jwt; sk_rt=sess',
        headers: { accept: 'application/json', 'x-request-id': 'req-1', 'x-secret-header': 'nope' },
      }),
      ctx('links'),
    );

    const { init } = upstreamCalls()[0];
    expect(upstreamHeader(init, 'authorization')).toBe('Bearer the.jwt');
    expect(upstreamHeader(init, 'accept')).toBe('application/json');
    expect(upstreamHeader(init, 'x-request-id')).toBe('req-1');
    expect(upstreamHeader(init, 'cookie')).toBeNull();
    expect(upstreamHeader(init, 'x-secret-header')).toBeNull();
  });

  it('returns only content-type/retry-after/x-request-id, drops upstream Set-Cookie, sets no-store', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse(200, { ok: true }, {
        'set-cookie': 'better-auth.session=leak; HttpOnly',
        'x-request-id': 'req-9',
        'cache-control': 'public, max-age=600',
        'x-internal': 'secret',
      }),
    );

    const response = await GET(bffRequest('GET', ['links'], { cookie: 'sk_at=the.jwt' }), ctx('links'));

    expect(response.headers.get('x-request-id')).toBe('req-9');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-internal')).toBeNull();
    expect(response.headers.getSetCookie()).toEqual([]);
  });
});

describe('CSRF: a mutating request requires the deployment Origin', () => {
  it('403s a POST whose Origin is not the deployment origin, with no upstream call', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');

    const response = await POST(
      bffRequest('POST', ['links'], { origin: 'https://evil.test', body: { url: 'x' } }),
      ctx('links'),
    );

    expect(response.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('forwards Origin upstream on a mutating method and sends none on a GET', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.resolve(jsonResponse(200, { ok: true })));

    await POST(
      bffRequest('POST', ['links'], { origin: DEPLOYMENT_ORIGIN, body: { url: 'x' }, cookie: 'sk_at=j' }),
      ctx('links'),
    );
    await GET(bffRequest('GET', ['links'], { cookie: 'sk_at=j' }), ctx('links'));

    const calls = upstreamCalls();
    expect(upstreamHeader(calls[0].init, 'origin')).toBe(DEPLOYMENT_ORIGIN);
    expect(upstreamHeader(calls[1].init, 'origin')).toBeNull();
  });
});

describe('the browser address is forwarded only when BFF_PROXY_SECRET is set', () => {
  it('adds neither client-ip nor proxy-auth when the secret is unset', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(200, { ok: true }));

    await GET(
      bffRequest('GET', ['links'], { cookie: 'sk_at=j', headers: { 'x-vercel-forwarded-for': '203.0.113.7' } }),
      ctx('links'),
    );

    const { init } = upstreamCalls()[0];
    expect(upstreamHeader(init, 'x-shortkit-client-ip')).toBeNull();
    expect(upstreamHeader(init, 'x-shortkit-proxy-auth')).toBeNull();
  });

  it('adds both, authenticating the address with the secret, when it is set and the address is a valid IP', async () => {
    process.env.BFF_PROXY_SECRET = PROXY_SECRET;
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(200, { ok: true }));

    await GET(
      bffRequest('GET', ['links'], { cookie: 'sk_at=j', headers: { 'x-vercel-forwarded-for': '203.0.113.7' } }),
      ctx('links'),
    );

    const { init } = upstreamCalls()[0];
    expect(upstreamHeader(init, 'x-shortkit-client-ip')).toBe('203.0.113.7');
    expect(upstreamHeader(init, 'x-shortkit-proxy-auth')).toBe(PROXY_SECRET);
  });

  it('drops a non-IP (comma-joined) forwarded value rather than taking a leftmost entry', async () => {
    process.env.BFF_PROXY_SECRET = PROXY_SECRET;
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(200, { ok: true }));

    await GET(
      bffRequest('GET', ['links'], {
        cookie: 'sk_at=j',
        headers: { 'x-vercel-forwarded-for': '203.0.113.7, 10.0.0.1' },
      }),
      ctx('links'),
    );

    expect(upstreamHeader(upstreamCalls()[0].init, 'x-shortkit-client-ip')).toBeNull();
  });

  it('never forwards an inbound x-shortkit-client-ip', async () => {
    process.env.BFF_PROXY_SECRET = PROXY_SECRET;
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(200, { ok: true }));

    await GET(
      bffRequest('GET', ['links'], {
        cookie: 'sk_at=j',
        headers: { 'x-shortkit-client-ip': '1.2.3.4', 'x-shortkit-proxy-auth': 'forged' },
      }),
      ctx('links'),
    );

    // No x-vercel-forwarded-for present, so nothing is set; the inbound spoof is ignored.
    expect(upstreamHeader(upstreamCalls()[0].init, 'x-shortkit-client-ip')).toBeNull();
    expect(upstreamHeader(upstreamCalls()[0].init, 'x-shortkit-proxy-auth')).toBeNull();
  });
});

describe('sign-in success sets both cookies and strips the session token (AC-18, F-208)', () => {
  it('mints a JWT from the upstream session token, sets HttpOnly SameSite=Lax cookies, and strips token from the body', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      // A body that validates against the shared authSessionContract (the route parses it with
      // that contract, not by duck-typing `token`).
      .mockResolvedValueOnce(
        jsonResponse(200, {
          token: 'sess-token',
          user: {
            id: 'u1',
            name: 'Op',
            email: 'e@x.co',
            emailVerified: true,
            createdAt: '2026-08-17T00:00:00.000Z',
            updatedAt: '2026-08-17T00:00:00.000Z',
          },
        }),
      )
      .mockResolvedValueOnce(jsonResponse(200, { token: 'the.jwt' }));

    const response = await POST(
      bffRequest('POST', ['auth', 'sign-in', 'email'], {
        origin: DEPLOYMENT_ORIGIN,
        body: { email: 'e@x.co', password: 'pw' },
      }),
      ctx('auth', 'sign-in', 'email'),
    );

    // upstream: sign-in, then token mint with Bearer <session token>
    const calls = upstreamCalls();
    expect(calls[1].url).toBe('http://api.internal:3001/api/auth/token');
    expect(upstreamHeader(calls[1].init, 'authorization')).toBe('Bearer sess-token');

    const setCookies = response.headers.getSetCookie();
    const atCookie = setCookies.find((c) => c.startsWith('sk_at='));
    const rtCookie = setCookies.find((c) => c.startsWith('sk_rt='));
    expect(atCookie).toContain('sk_at=the.jwt');
    expect(atCookie).toContain('HttpOnly');
    expect(atCookie).toContain('SameSite=Lax');
    expect(atCookie).toContain('Secure');
    expect(rtCookie).toContain('sk_rt=sess-token');
    expect(rtCookie).toContain('HttpOnly');

    const body = (await response.json()) as { token?: unknown };
    expect(body.token).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('a 200 sign-in body that fails authSessionContract sets no cookies and mints nothing', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse(200, { token: 'sess-token', user: { id: 'u1' } }));

    const response = await POST(
      bffRequest('POST', ['auth', 'sign-in', 'email'], {
        origin: DEPLOYMENT_ORIGIN,
        body: { email: 'e@x.co', password: 'pw' },
      }),
      ctx('auth', 'sign-in', 'email'),
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(((await response.json()) as { token?: unknown }).token).toBeUndefined();
  });

  it('maps a Better Auth sign-in error body to an ErrorEnvelope the browser can read', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse(401, { message: 'Invalid email or password', code: 'INVALID_EMAIL_OR_PASSWORD' }),
    );

    const response = await POST(
      bffRequest('POST', ['auth', 'sign-in', 'email'], {
        origin: DEPLOYMENT_ORIGIN,
        body: { email: 'e@x.co', password: 'wrong' },
      }),
      ctx('auth', 'sign-in', 'email'),
    );

    expect(response.status).toBe(401);
    const body = (await response.json()) as { code: string };
    expect(body.code).toBe('unauthenticated');
    expect(response.headers.getSetCookie()).toEqual([]);
  });
});

describe('get-session strips the session token from the proxied body (F-208)', () => {
  it('removes session.token', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse(200, { session: { token: 'sess-token', id: 's1' }, user: { id: 'u1' } }),
    );

    const response = await GET(bffRequest('GET', ['auth', 'get-session'], { cookie: 'sk_at=j' }), ctx('auth', 'get-session'));

    const body = (await response.json()) as { session: { token?: unknown; id?: unknown } };
    expect(body.session.token).toBeUndefined();
    expect(body.session.id).toBe('s1');
  });
});

describe('sign-out clears both cookies (AC-21)', () => {
  it('clears sk_at and sk_rt with Max-Age=0 and revokes upstream', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(200, {}));

    const response = await POST(
      bffRequest('POST', ['auth', 'sign-out'], { origin: DEPLOYMENT_ORIGIN, cookie: 'sk_rt=sess-token' }),
      ctx('auth', 'sign-out'),
    );

    expect(upstreamHeader(fetchMock.mock.calls[0][1]?.headers ? fetchMock.mock.calls[0][1] as RequestInit : {}, 'authorization')).toBe('Bearer sess-token');
    const setCookies = response.headers.getSetCookie();
    expect(setCookies.every((c) => c.includes('Max-Age=0'))).toBe(true);
    expect(setCookies.some((c) => c.startsWith('sk_at='))).toBe(true);
    expect(setCookies.some((c) => c.startsWith('sk_rt='))).toBe(true);
  });
});

describe('token_expired triggers a single refresh and retry (ADR-0014)', () => {
  it('refreshes sk_at from sk_rt on a 401 token_expired and retries the request once', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse(401, { code: 'token_expired', message: 'expired' }))
      .mockResolvedValueOnce(jsonResponse(200, { token: 'fresh.jwt' }))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));

    const response = await GET(
      bffRequest('GET', ['links'], { cookie: 'sk_at=stale.jwt; sk_rt=sess-token' }),
      ctx('links'),
    );

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    // retry carried the fresh bearer
    expect(upstreamHeader(upstreamCalls()[2].init, 'authorization')).toBe('Bearer fresh.jwt');
    // the fresh access cookie is persisted
    expect(response.headers.getSetCookie().some((c) => c.startsWith('sk_at=fresh.jwt'))).toBe(true);
  });

  it('clears both cookies and returns 401 when the retry also 401s (two consecutive failures)', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse(401, { code: 'token_expired', message: 'expired' }))
      .mockResolvedValueOnce(jsonResponse(200, { token: 'fresh.jwt' }))
      .mockResolvedValueOnce(jsonResponse(401, { code: 'token_expired', message: 'expired' }));

    const response = await GET(
      bffRequest('GET', ['links'], { cookie: 'sk_at=stale.jwt; sk_rt=sess-token' }),
      ctx('links'),
    );

    expect(response.status).toBe(401);
    const body = (await response.json()) as { code: string };
    expect(body.code).toBe('unauthenticated');
    expect(response.headers.getSetCookie().every((c) => c.includes('Max-Age=0'))).toBe(true);
  });

  it('clears both cookies when there is no sk_rt to refresh from', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(401, { code: 'token_expired', message: 'expired' }));

    const response = await DELETE(
      bffRequest('DELETE', ['links', 'l1'], { origin: DEPLOYMENT_ORIGIN, cookie: 'sk_at=stale.jwt' }),
      ctx('links', 'l1'),
    );

    expect(response.status).toBe(401);
    expect(response.headers.getSetCookie().length).toBe(2);
  });
});

describe('every /api/auth/* error through the GENERAL proxy path arrives as an ErrorEnvelope (review round 1, CRITICAL)', () => {
  function signUp(body: unknown, status: number, headers: Record<string, string> = {}) {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(status, body, headers));

    return POST(
      bffRequest('POST', ['auth', 'sign-up', 'email'], {
        origin: DEPLOYMENT_ORIGIN,
        body: { email: 'e@x.co', password: 'short', name: 'n' },
      }),
      ctx('auth', 'sign-up', 'email'),
    );
  }

  it.each([
    [400, 'PASSWORD_TOO_SHORT', 'Password too short', 'validation_failed'],
    [400, 'VALIDATION_ERROR', '[body.name] Invalid input: expected string, received undefined', 'validation_failed'],
    [403, 'MISSING_OR_NULL_ORIGIN', 'Missing or null Origin', 'internal_error'],
    [422, 'USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL', 'User already exists. Use another email.', 'validation_failed'],
  ])('%s %s maps to code %s with the transport status kept', async (status, nativeCode, message, expectedCode) => {
    const response = await signUp({ message, code: nativeCode }, status);
    const body = (await response.json()) as { code: string; message: string };

    expect(response.status).toBe(status);
    expect(body.code).toBe(expectedCode);
    // The mapped body validates against the shared envelope contract, so `apiClient`
    // step 2 reads it and never degrades it to internal_error.
    expect(isErrorEnvelope(body)).toBe(true);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('a 429 keeps Retry-After (header preferred) and maps to rate_limited', async () => {
    const response = await signUp({ message: 'Too many', retryAfterSeconds: 9 }, 429, { 'retry-after': '30' });
    const body = (await response.json()) as { code: string };

    expect(response.status).toBe(429);
    expect(body.code).toBe('rate_limited');
    expect(response.headers.get('retry-after')).toBe('30');
  });

  it('a 429 with no header falls back to the retryAfterSeconds body field', async () => {
    const response = await signUp({ retryAfterSeconds: 9 }, 429);

    expect(response.headers.get('retry-after')).toBe('9');
    expect(((await response.json()) as { code: string }).code).toBe('rate_limited');
  });

  it('a body that already IS an ErrorEnvelope (closed code enum) passes through untouched', async () => {
    const response = await signUp({ code: 'rate_limited', message: 'slow down' }, 429, { 'retry-after': '12' });
    const body = (await response.json()) as { code: string; message: string };

    expect(body).toEqual({ code: 'rate_limited', message: 'slow down' });
    expect(response.headers.get('retry-after')).toBe('12');
  });
});
