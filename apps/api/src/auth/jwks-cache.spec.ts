import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { logger } from '../observability/logger';
import { JWKS_CACHE_TTL_MS, JWKS_PATH, createJwksCache, fetchKeySetOverHttp, jwksUrl } from './jwks-cache';
import type { JsonWebKeySet } from './jwks-cache';

/**
 * STORY-002 — no AC states this; ADR-0013 does ("fetches `/api/auth/jwks` once and caches
 * the key set in process for 10 minutes"). TASK-005, wave 4.
 *
 * Contract: `docs/contracts/auth-tokens.md` ("Verification", step 2; "What the implementer
 * must guarantee": fetched over loopback, not the public internet). ADR-0013.
 *
 * TIME AND THE FETCH ARE INJECTED, NOT FAKED — the convention `revocation-store.spec.ts`
 * started and says why. The cache under test is a fresh instance per test, built by the same
 * factory the process-wide one is built by, so the singleton the guard reads is never touched.
 */

const KEY_SET_A: JsonWebKeySet = { keys: [{ kty: 'OKP', crv: 'Ed25519', kid: 'a', alg: 'EdDSA', x: 'AAAA' }] };
const KEY_SET_B: JsonWebKeySet = { keys: [{ kty: 'OKP', crv: 'Ed25519', kid: 'b', alg: 'EdDSA', x: 'BBBB' }] };

const URL_UNDER_TEST = 'http://127.0.0.1:43111/api/auth/jwks';

interface Harness {
  readonly cachedKeySet: () => Promise<JsonWebKeySet>;
  readonly fetches: readonly string[];
  advance(ms: number): void;
  /** Resolves the fetch that is currently pending. Throws when none is. */
  resolveNext(keySet: JsonWebKeySet): void;
  rejectNext(error: Error): void;
}

/** A cache whose fetches are held open until the test releases them. */
function harness(): Harness {
  let now = 1_700_000_000_000;
  const fetches: string[] = [];
  const pending: Array<{ resolve: (v: JsonWebKeySet) => void; reject: (e: Error) => void }> = [];

  const cache = createJwksCache({
    now: () => now,
    jwksUrl: () => URL_UNDER_TEST,
    fetchKeySet: (url) => {
      fetches.push(url);
      return new Promise<JsonWebKeySet>((resolve, reject) => {
        pending.push({ resolve, reject });
      });
    },
  });

  const take = (): { resolve: (v: JsonWebKeySet) => void; reject: (e: Error) => void } => {
    const next = pending.shift();
    if (next === undefined) {
      throw new Error('no fetch is pending');
    }
    return next;
  };

  return {
    cachedKeySet: () => cache.cachedKeySet(),
    fetches,
    advance: (ms) => {
      now += ms;
    },
    resolveNext: (keySet) => take().resolve(keySet),
    rejectNext: (error) => take().reject(error),
  };
}

beforeEach(() => {
  vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  vi.spyOn(logger, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createJwksCache', () => {
  it('fetches once and serves the same set for the whole TTL', async () => {
    const h = harness();

    const first = h.cachedKeySet();
    h.resolveNext(KEY_SET_A);
    expect(await first).toBe(KEY_SET_A);

    h.advance(JWKS_CACHE_TTL_MS - 1);
    expect(await h.cachedKeySet()).toBe(KEY_SET_A);
    expect(await h.cachedKeySet()).toBe(KEY_SET_A);

    expect(h.fetches).toEqual([URL_UNDER_TEST]);
  });

  it('refetches once the TTL has elapsed', async () => {
    const h = harness();

    const first = h.cachedKeySet();
    h.resolveNext(KEY_SET_A);
    await first;

    h.advance(JWKS_CACHE_TTL_MS);
    const second = h.cachedKeySet();
    h.resolveNext(KEY_SET_B);

    expect(await second).toBe(KEY_SET_B);
    expect(h.fetches).toHaveLength(2);
  });

  it('concurrent callers share one in-flight fetch', async () => {
    const h = harness();

    const callers = [h.cachedKeySet(), h.cachedKeySet(), h.cachedKeySet()];
    expect(h.fetches).toHaveLength(1);

    h.resolveNext(KEY_SET_A);
    expect(await Promise.all(callers)).toEqual([KEY_SET_A, KEY_SET_A, KEY_SET_A]);
  });

  it('a failed refresh keeps the stale set and does not poison the cache', async () => {
    const h = harness();

    const first = h.cachedKeySet();
    h.resolveNext(KEY_SET_A);
    await first;

    h.advance(JWKS_CACHE_TTL_MS + 1);
    const refresh = h.cachedKeySet();
    h.rejectNext(new Error('ECONNREFUSED 127.0.0.1:43111'));

    // The caller that triggered the failed refresh still gets a key set: the stale one.
    expect(await refresh).toBe(KEY_SET_A);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'auth_jwks_refresh_failed' }),
      expect.any(String),
    );

    // The next call tries again rather than serving the failure back, and a success replaces the stale set.
    const retry = h.cachedKeySet();
    expect(h.fetches).toHaveLength(3);
    h.resolveNext(KEY_SET_B);
    expect(await retry).toBe(KEY_SET_B);
  });

  it('a failed first fetch rejects, and the next call fetches again rather than caching the failure', async () => {
    const h = harness();

    const first = h.cachedKeySet();
    h.rejectNext(new Error('ECONNREFUSED 127.0.0.1:43111'));
    await expect(first).rejects.toThrow('ECONNREFUSED');

    const second = h.cachedKeySet();
    expect(h.fetches).toHaveLength(2);
    h.resolveNext(KEY_SET_A);
    expect(await second).toBe(KEY_SET_A);
  });

  it('a set that is not a key set is refused rather than cached', async () => {
    const h = harness();

    const first = h.cachedKeySet();
    h.resolveNext({ nope: true } as unknown as JsonWebKeySet);

    await expect(first).rejects.toThrow();
  });

  it('never logs the URL or the key material on failure', async () => {
    const h = harness();

    const first = h.cachedKeySet();
    h.rejectNext(new Error('boom'));
    await first.catch(() => undefined);

    const h2 = harness();
    const a = h2.cachedKeySet();
    h2.resolveNext(KEY_SET_A);
    await a;
    h2.advance(JWKS_CACHE_TTL_MS + 1);
    const b = h2.cachedKeySet();
    h2.rejectNext(new Error('boom'));
    await b;

    for (const call of [...vi.mocked(logger.warn).mock.calls, ...vi.mocked(logger.error).mock.calls]) {
      const line = JSON.stringify(call);
      expect(line).not.toContain('AAAA');
      expect(line).not.toContain('boom');
    }
  });
});

describe('jwksUrl', () => {
  beforeEach(() => {
    vi.stubEnv('BETTER_AUTH_URL', 'http://127.0.0.1:43111/');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('is the declared origin plus the jwks path, so it agrees with the iss the tokens carry', () => {
    expect(JWKS_PATH).toBe('/api/auth/jwks');
    expect(jwksUrl()).toBe(URL_UNDER_TEST);
  });
});

describe('fetchKeySetOverHttp', () => {
  it('parses a 200 JSON key set', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(KEY_SET_A), { status: 200, headers: { 'content-type': 'application/json' } }));

    expect(await fetchKeySetOverHttp(URL_UNDER_TEST, fetchImpl as unknown as typeof fetch)).toEqual(KEY_SET_A);
    expect(fetchImpl).toHaveBeenCalledWith(URL_UNDER_TEST, expect.objectContaining({ method: 'GET' }));
  });

  it('refuses a non-200 status without reading it as a key set', async () => {
    const fetchImpl = vi.fn(async () => new Response('{"keys":[]}', { status: 503 }));

    await expect(fetchKeySetOverHttp(URL_UNDER_TEST, fetchImpl as unknown as typeof fetch)).rejects.toThrow(/503/);
  });

  it('refuses a body that is not a key set', async () => {
    const fetchImpl = vi.fn(async () => new Response('{"message":"nope"}', { status: 200 }));

    await expect(fetchKeySetOverHttp(URL_UNDER_TEST, fetchImpl as unknown as typeof fetch)).rejects.toThrow();
  });
});
