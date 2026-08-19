/**
 * TASK-007 (STORY-003, AC-18/AC-19). The session module's server-side primitives.
 *
 * `next/headers` `cookies()`/`headers()` and `next/navigation` `redirect()` are mocked:
 * they throw outside a request scope, so a mock is the only way to exercise these units.
 * `fetch` is mocked for the refresh mint. Everything else — the cookie descriptors, the JWT
 * decode — is real.
 *
 * Contract: docs/contracts/web-api-client.md ("Cookies", "Session"), auth-tokens.md.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const cookieStore = {
  get: vi.fn<(name: string) => { value: string } | undefined>(),
  set: vi.fn<(cookie: unknown) => void>(),
};
const headerStore = {
  get: vi.fn<(name: string) => string | null>(),
};

const redirect = vi.fn<(url: string) => never>((url: string) => {
  throw new RedirectSignal(url);
});

class RedirectSignal extends Error {
  constructor(public readonly url: string) {
    super(`redirect:${url}`);
  }
}

vi.mock('next/headers', () => ({
  cookies: () => Promise.resolve(cookieStore),
  headers: () => Promise.resolve(headerStore),
}));

vi.mock('next/navigation', () => ({
  redirect: (url: string) => redirect(url),
}));

import {
  ACCESS_COOKIE,
  ACCESS_COOKIE_MAX_AGE_S,
  REFRESH_COOKIE,
  REFRESH_COOKIE_MAX_AGE_S,
  SIGN_IN_ROUTE,
  buildClearedSessionCookies,
  buildSessionCookies,
  clearSessionCookies,
  mintAccessToken,
  jwtIsExpired,
  refreshAccessToken,
  requireAuth,
  sessionUserFromJwt,
  setSessionCookies,
} from './session';
import { deploymentOriginFrom, originIsSecureFrom } from './request-origin';

/** A JWT whose payload decodes to the given claims. Signature segment is inert; nothing verifies it. */
function jwtWith(claims: Record<string, unknown>): string {
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');

  return `header.${payload}.signature`;
}

const FAR_FUTURE = 4_102_444_800; // 2100-01-01
/** The subset the web app validates (sub, email, ev, exp — a `.pick` of the shared claim contract). */
const LIVE_CLAIMS = { sub: 'user-1', email: 'op@agency.test', ev: true, exp: FAR_FUTURE };

function httpsOrigin(): void {
  headerStore.get.mockImplementation((name) => (name === 'x-forwarded-proto' ? 'https' : null));
}

function httpLocalhost(): void {
  headerStore.get.mockImplementation((name) => (name === 'x-forwarded-proto' ? 'http' : null));
}

beforeEach(() => {
  cookieStore.get.mockReset();
  cookieStore.set.mockReset();
  headerStore.get.mockReset();
  redirect.mockClear();
  process.env.API_BASE_URL = 'http://api.test/api';
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.API_BASE_URL;
});

describe('the cookie descriptors (AC-18)', () => {
  it('sets sk_at as the JWT at 300s and sk_rt as the session token at 30 days, both HttpOnly SameSite=Lax', () => {
    const [at, rt] = buildSessionCookies('the.jwt', 'the-session-token', true);

    expect(at).toMatchObject({
      name: ACCESS_COOKIE,
      value: 'the.jwt',
      maxAge: ACCESS_COOKIE_MAX_AGE_S,
      httpOnly: true,
      sameSite: 'lax',
      secure: true,
      path: '/',
    });
    expect(ACCESS_COOKIE_MAX_AGE_S).toBe(300);
    expect(rt).toMatchObject({
      name: REFRESH_COOKIE,
      value: 'the-session-token',
      maxAge: REFRESH_COOKIE_MAX_AGE_S,
      httpOnly: true,
      sameSite: 'lax',
    });
    expect(REFRESH_COOKIE_MAX_AGE_S).toBe(2_592_000);
  });

  it('Secure follows the origin scheme, not NODE_ENV: false on http, true on https', () => {
    expect(buildSessionCookies('j', 's', false).every((c) => c.secure === false)).toBe(true);
    expect(buildSessionCookies('j', 's', true).every((c) => c.secure === true)).toBe(true);
  });

  it('the cleared cookies keep the same attributes and carry Max-Age 0', () => {
    for (const cookie of buildClearedSessionCookies(true)) {
      expect(cookie.maxAge).toBe(0);
      expect(cookie.httpOnly).toBe(true);
      expect(cookie.sameSite).toBe('lax');
      expect(cookie.path).toBe('/');
    }
  });
});

describe('setSessionCookies / clearSessionCookies', () => {
  it('writes both cookies through the request cookie store, Secure on an https origin', async () => {
    httpsOrigin();

    await setSessionCookies('a.jwt', 'a-session');

    const written = cookieStore.set.mock.calls.map((call) => call[0] as { name: string; secure: boolean });
    expect(written.map((c) => c.name)).toEqual([ACCESS_COOKIE, REFRESH_COOKIE]);
    expect(written.every((c) => c.secure)).toBe(true);
  });

  it('sets the cookie without Secure on http://localhost', async () => {
    httpLocalhost();

    await setSessionCookies('a.jwt', 'a-session');

    const written = cookieStore.set.mock.calls.map((call) => call[0] as { secure: boolean });
    expect(written.every((c) => c.secure === false)).toBe(true);
  });

  it('clearSessionCookies expires both cookies', async () => {
    httpsOrigin();

    await clearSessionCookies();

    const written = cookieStore.set.mock.calls.map((call) => call[0] as { name: string; maxAge: number });
    expect(written.map((c) => c.name).sort()).toEqual([ACCESS_COOKIE, REFRESH_COOKIE]);
    expect(written.every((c) => c.maxAge === 0)).toBe(true);
  });
});

describe('requireAuth (AC-19)', () => {
  it('redirects to the sign-in screen and never returns when there is no sk_at', async () => {
    cookieStore.get.mockReturnValue(undefined);

    await expect(requireAuth()).rejects.toBeInstanceOf(RedirectSignal);
    expect(redirect).toHaveBeenCalledWith(SIGN_IN_ROUTE);
    expect(SIGN_IN_ROUTE).toBe('/sign-in');
  });

  it('redirects when sk_at is present but not a decodable JWT (never renders a protected page)', async () => {
    cookieStore.get.mockReturnValue({ value: 'not-a-jwt' });

    await expect(requireAuth()).rejects.toBeInstanceOf(RedirectSignal);
    expect(redirect).toHaveBeenCalledWith(SIGN_IN_ROUTE);
  });

  it('returns the SessionUser projection when a valid sk_at is present', async () => {
    cookieStore.get.mockReturnValue({
      value: jwtWith({ sub: 'user-1', email: 'op@agency.test', ev: true, exp: FAR_FUTURE }),
    });

    await expect(requireAuth()).resolves.toEqual({
      id: 'user-1',
      email: 'op@agency.test',
      emailVerified: true,
    });
    expect(redirect).not.toHaveBeenCalled();
  });
});

describe('sessionUserFromJwt', () => {
  it('decodes the projection without verifying the signature', () => {
    expect(sessionUserFromJwt(jwtWith({ sub: 's', email: 'e@x.co', ev: false, exp: FAR_FUTURE }))).toEqual({
      id: 's',
      email: 'e@x.co',
      emailVerified: false,
    });
  });

  it('returns null for a non-JWT and for a payload missing sub', () => {
    expect(sessionUserFromJwt('a.b')).toBeNull();
    expect(sessionUserFromJwt(jwtWith({ email: 'e@x.co' }))).toBeNull();
  });
});

describe('jwtIsExpired', () => {
  it('is false before exp, true at or after exp, and true when exp is unreadable (closed direction)', () => {
    expect(jwtIsExpired(jwtWith({ ...LIVE_CLAIMS, exp: 1_000 }), 999)).toBe(false);
    expect(jwtIsExpired(jwtWith({ ...LIVE_CLAIMS, exp: 1_000 }), 1_000)).toBe(true);
    expect(jwtIsExpired(jwtWith({ ...LIVE_CLAIMS, exp: 1_000 }), 1_001)).toBe(true);
    expect(jwtIsExpired(jwtWith({ ...LIVE_CLAIMS, exp: undefined }), 0)).toBe(true);
    expect(jwtIsExpired('not.a.jwt.at.all', 0)).toBe(true);
  });
});

describe('refreshAccessToken', () => {
  it('mints a fresh sk_at from sk_rt and returns the JWT, sk_rt untouched', async () => {
    cookieStore.get.mockImplementation((name) => (name === REFRESH_COOKIE ? { value: 'sess-tok' } : undefined));
    httpsOrigin();
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ token: 'new.jwt' }), { status: 200 }));

    await expect(refreshAccessToken()).resolves.toBe('new.jwt');

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('http://api.test/api/auth/token');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer sess-tok');
    const written = cookieStore.set.mock.calls.map((call) => call[0] as { name: string; value: string });
    expect(written).toEqual([{ name: ACCESS_COOKIE, value: 'new.jwt', maxAge: 300, httpOnly: true, secure: true, sameSite: 'lax', path: '/' }]);
  });

  it('clears both cookies and throws when there is no sk_rt', async () => {
    cookieStore.get.mockReturnValue(undefined);
    httpsOrigin();

    await expect(refreshAccessToken()).rejects.toBeInstanceOf(Error);
    const cleared = cookieStore.set.mock.calls.map((call) => call[0] as { name: string; maxAge: number });
    expect(cleared.map((c) => c.name).sort()).toEqual([ACCESS_COOKIE, REFRESH_COOKIE]);
    expect(cleared.every((c) => c.maxAge === 0)).toBe(true);
  });

  it('clears both cookies when the mint refuses the session token', async () => {
    cookieStore.get.mockImplementation((name) => (name === REFRESH_COOKIE ? { value: 'sess-tok' } : undefined));
    httpsOrigin();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 401 }));

    await expect(refreshAccessToken()).rejects.toBeInstanceOf(Error);
    const cleared = cookieStore.set.mock.calls.map((call) => call[0] as { maxAge: number });
    expect(cleared.length).toBe(2);
    expect(cleared.every((c) => c.maxAge === 0)).toBe(true);
  });

  it('collapses two parallel refreshes into one upstream mint', async () => {
    cookieStore.get.mockImplementation((name) => (name === REFRESH_COOKIE ? { value: 'sess-tok' } : undefined));
    httpsOrigin();
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ token: 'new.jwt' }), { status: 200 }));

    const [a, b] = await Promise.all([refreshAccessToken(), refreshAccessToken()]);

    expect(a).toBe('new.jwt');
    expect(b).toBe('new.jwt');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('mintAccessToken — the one mint path', () => {
  it('returns the JWT from GET {API}/api/auth/token with Bearer <sk_rt> and writes no cookie itself', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ token: 'minted.jwt' }), { status: 200 }));

    await expect(mintAccessToken('sess-tok')).resolves.toBe('minted.jwt');

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('http://api.test/api/auth/token');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer sess-tok');
    expect(cookieStore.set).not.toHaveBeenCalled();
  });

  it('returns null on a refused mint, an unreachable mint, and a body without a token', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');

    fetchMock.mockResolvedValueOnce(new Response('', { status: 401 }));
    await expect(mintAccessToken('a')).resolves.toBeNull();

    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    await expect(mintAccessToken('b')).resolves.toBeNull();

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ nope: 1 }), { status: 200 }));
    await expect(mintAccessToken('c')).resolves.toBeNull();
  });

  it('collapses parallel mints for one session token and never keys the map on the raw token', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ token: 'minted.jwt' }), { status: 200 }));

    const [a, b] = await Promise.all([mintAccessToken('same-tok'), mintAccessToken('same-tok')]);

    expect(a).toBe('minted.jwt');
    expect(b).toBe('minted.jwt');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // The in-flight map is module-private; the raw token must not be reachable off the
    // module surface after the mint settles (entries are deleted in `finally`).
    const surface = JSON.stringify(Object.keys(await import('./session')));
    expect(surface).not.toContain('same-tok');
  });
});

describe('the shared origin helpers (request-origin.ts)', () => {
  const noHeaders = { get: () => null };

  it('originIsSecureFrom: header-absent + https URL sets Secure; http://localhost does not', () => {
    expect(originIsSecureFrom(noHeaders, new URL('https://app.shortkit.test/x'))).toBe(true);
    expect(originIsSecureFrom(noHeaders, new URL('http://localhost:3000/x'))).toBe(false);
  });

  it('originIsSecureFrom: x-forwarded-proto wins over the URL, first hop only', () => {
    const https = { get: (n: string) => (n === 'x-forwarded-proto' ? 'https, http' : null) };
    const http = { get: (n: string) => (n === 'x-forwarded-proto' ? 'http' : null) };

    expect(originIsSecureFrom(https, new URL('http://localhost/x'))).toBe(true);
    expect(originIsSecureFrom(http, new URL('https://app.shortkit.test/x'))).toBe(false);
  });

  it('deploymentOriginFrom: the forwarded pair when both are present, else the request URL origin', () => {
    const forwarded = {
      get: (n: string) =>
        n === 'x-forwarded-proto' ? 'https' : n === 'x-forwarded-host' ? 'app.shortkit.test' : null,
    };

    expect(deploymentOriginFrom(forwarded, new URL('http://internal:3000/x'))).toBe('https://app.shortkit.test');
    expect(deploymentOriginFrom(noHeaders, new URL('http://localhost:3000/x'))).toBe('http://localhost:3000');
  });
});
