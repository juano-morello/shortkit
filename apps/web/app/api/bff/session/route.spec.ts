/**
 * TASK-007. The two static session routes that shadow the `[...path]` catch-all:
 * `GET /api/bff/session` (the projection `useSession` reads) and
 * `GET /api/bff/session/refresh` (the refresh-and-bounce `serverApiClient` redirects to).
 *
 * `next/headers` is mocked (it throws outside a request scope); `fetch` is mocked for the
 * upstream mint. Contract: web-api-client.md ("Session", invariant 5), ADR-0014.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const cookieStore = {
  get: vi.fn<(name: string) => { value: string } | undefined>(),
  set: vi.fn<(cookie: unknown) => void>(),
};
const headerStore = { get: vi.fn<(name: string) => string | null>() };

vi.mock('next/headers', () => ({
  cookies: () => Promise.resolve(cookieStore),
  headers: () => Promise.resolve(headerStore),
}));

import { GET as getSession } from './route';
import { DEFAULT_RETURN_TO, GET as getRefresh, redirectLocation, safeReturnTo } from './refresh/route';

const ORIGIN = 'https://app.shortkit.test';

function jwtWith(claims: Record<string, unknown>): string {
  return `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;
}

const NOW = Math.floor(Date.now() / 1000);
const LIVE_JWT = jwtWith({ sub: 'u1', email: 'op@agency.test', ev: true, exp: NOW + 200 });
const EXPIRED_JWT = jwtWith({ sub: 'u1', email: 'op@agency.test', ev: true, exp: NOW - 5 });

function cookiesAre(values: Record<string, string>): void {
  cookieStore.get.mockImplementation((name) => (name in values ? { value: values[name] } : undefined));
}

beforeEach(() => {
  cookieStore.get.mockReset();
  cookieStore.set.mockReset();
  headerStore.get.mockReset();
  headerStore.get.mockImplementation((name) => (name === 'x-forwarded-proto' ? 'https' : null));
  process.env.API_BASE_URL = 'http://api.internal:3001/api';
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.API_BASE_URL;
});

describe('the static session routes shadow the catch-all', () => {
  it('both route modules exist at the static segments Next resolves ahead of [...path]', () => {
    const here = path.dirname(new URL(import.meta.url).pathname);

    expect(existsSync(path.join(here, 'route.ts'))).toBe(true);
    expect(existsSync(path.join(here, 'refresh', 'route.ts'))).toBe(true);
    // The catch-all sits one level up; a static sibling segment wins by specificity in the
    // App Router, so `session` never reaches it. Its own handler has no `session` branch.
    expect(existsSync(path.join(here, '..', '[...path]', 'route.ts'))).toBe(true);
  });
});

describe('GET /api/bff/session: the projection', () => {
  it('returns { user, status: authenticated } from a live sk_at, no token in the body, no-store', async () => {
    cookiesAre({ sk_at: LIVE_JWT, sk_rt: 'sess' });

    const response = await getSession();
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(body).toEqual({
      user: { id: 'u1', email: 'op@agency.test', emailVerified: true },
      status: 'authenticated',
    });
    expect(JSON.stringify(body)).not.toContain(LIVE_JWT);
    expect(JSON.stringify(body)).not.toContain('sess');
  });

  it('returns { user: null, status: unauthenticated } with no cookies at all', async () => {
    cookiesAre({});

    const response = await getSession();

    expect(await response.json()).toEqual({ user: null, status: 'unauthenticated' });
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('an expired sk_at with no sk_rt is unauthenticated', async () => {
    cookiesAre({ sk_at: EXPIRED_JWT });

    expect(await (await getSession()).json()).toEqual({ user: null, status: 'unauthenticated' });
  });

  it('an expired sk_at with an sk_rt refreshes once and reports authenticated', async () => {
    cookiesAre({ sk_at: EXPIRED_JWT, sk_rt: 'sess' });
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ token: LIVE_JWT }), { status: 200 }));

    const body = await (await getSession()).json();

    expect(body).toMatchObject({ status: 'authenticated', user: { id: 'u1' } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe('http://api.internal:3001/api/auth/token');
  });

  it('an expired sk_at whose refresh is refused is unauthenticated (cookies cleared by the refresh)', async () => {
    cookiesAre({ sk_at: EXPIRED_JWT, sk_rt: 'sess' });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 401 }));

    expect(await (await getSession()).json()).toEqual({ user: null, status: 'unauthenticated' });
    const cleared = cookieStore.set.mock.calls.map((c) => c[0] as { maxAge: number });
    expect(cleared.length).toBe(2);
    expect(cleared.every((c) => c.maxAge === 0)).toBe(true);
  });
});

describe('safeReturnTo: the open-redirect guard', () => {
  it('accepts a same-origin relative path with query and hash', () => {
    expect(safeReturnTo('/workspaces/w1?tab=links#top')).toBe('/workspaces/w1?tab=links#top');
  });

  it.each([
    ['https://evil.test/x', 'absolute URL'],
    ['//evil.test/x', 'protocol-relative'],
    ['/\\evil.test/x', 'backslash protocol-relative'],
    ['javascript:alert(1)', 'scheme'],
    ['evil.test', 'no leading slash'],
    ['', 'empty'],
  ])('rejects %s (%s) and falls back to /', (candidate) => {
    expect(safeReturnTo(candidate)).toBe(DEFAULT_RETURN_TO);
  });

  it('rejects null (absent param) with the default', () => {
    expect(safeReturnTo(null)).toBe('/');
  });

  /**
   * Security review round 1, BLOCKER. A raw-prefix check alone passes `/..//evil.test`,
   * whose RESOLVED pathname is `//evil.test`: a network-path reference on re-parse. Every
   * case here must yield a final Location on the request origin.
   */
  it.each([
    ['/..//evil.test'],
    ['/%2e%2e//evil.test'],
    ['/a/..//evil.test'],
    ['/..%2f%2fevil.test'],
    ['/\\evil.test'],
    ['//evil.test'],
    ['/workspaces?x=1#y'],
  ])('%s: the final Location origin is the request origin', (candidate) => {
    const relative = safeReturnTo(candidate);
    const location = redirectLocation(relative, ORIGIN);

    expect(relative.startsWith('//')).toBe(false);
    expect(relative.startsWith('/\\')).toBe(false);
    expect(location.origin).toBe(ORIGIN);
    expect(location.hostname).not.toBe('evil.test');
  });

  it('keeps the positive case intact end to end', () => {
    expect(redirectLocation(safeReturnTo('/workspaces?x=1#y'), ORIGIN).href).toBe(`${ORIGIN}/workspaces?x=1#y`);
  });

  it('redirectLocation itself refuses to leave the origin even if handed a bad relative path', () => {
    expect(redirectLocation('//evil.test/x', ORIGIN).href).toBe(`${ORIGIN}/`);
  });
});

describe('GET /api/bff/session/refresh: refresh and bounce', () => {
  it('refreshes sk_at from sk_rt and 303s back to the same-origin returnTo', async () => {
    cookiesAre({ sk_rt: 'sess' });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ token: LIVE_JWT }), { status: 200 }),
    );

    const response = await getRefresh(new Request(`${ORIGIN}/api/bff/session/refresh?returnTo=/workspaces`));

    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(`${ORIGIN}/workspaces`);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const written = cookieStore.set.mock.calls.map((c) => c[0] as { name: string; value: string });
    expect(written).toEqual([expect.objectContaining({ name: 'sk_at', value: LIVE_JWT })]);
  });

  it('bounces to / when returnTo is absent, and never to an off-origin returnTo', async () => {
    cookiesAre({ sk_rt: 'sess' });
    vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify({ token: LIVE_JWT }), { status: 200 })),
    );

    const plain = await getRefresh(new Request(`${ORIGIN}/api/bff/session/refresh`));
    const evil = await getRefresh(
      new Request(`${ORIGIN}/api/bff/session/refresh?returnTo=${encodeURIComponent('//evil.test/x')}`),
    );

    expect(plain.headers.get('location')).toBe(`${ORIGIN}/`);
    expect(evil.headers.get('location')).toBe(`${ORIGIN}/`);
  });

  it('on refresh failure clears both cookies and redirects to /sign-in', async () => {
    cookiesAre({ sk_rt: 'sess' });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 401 }));

    const response = await getRefresh(new Request(`${ORIGIN}/api/bff/session/refresh?returnTo=/workspaces`));

    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(`${ORIGIN}/sign-in`);
    const cleared = cookieStore.set.mock.calls.map((c) => c[0] as { name: string; maxAge: number });
    expect(cleared.map((c) => c.name).sort()).toEqual(['sk_at', 'sk_rt']);
    expect(cleared.every((c) => c.maxAge === 0)).toBe(true);
  });
});
