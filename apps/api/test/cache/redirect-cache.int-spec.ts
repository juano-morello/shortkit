import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { redirectCacheFor } from '../../src/cache/cache.module';
import {
  cacheAvailable,
  closeRedisClient,
  restoreRedisAvailability,
  simulateRedisUnavailable,
} from '../../src/cache/redis-client';
import { HOST_TTL_S, LINK_MISS_TTL_S, LINK_TTL_S, MISS_SENTINEL } from '../../src/cache/redirect-cache';
import type { CachedHost, CachedLink, RedirectCache } from '../../src/cache/redirect-cache';

import { SCRATCH_REDIS_PORTS, startScratchRedis } from './scratch-redis';
import type { ScratchRedis } from './scratch-redis';

/**
 * STORY-2-06, AC-2-29 (a gone Redis degrades, never 5xx), AC-2-30 (a hung Redis is bounded
 * by `commandTimeout`), AC-2-31 (it comes back with no restart), AC-2-32 (every key begins
 * `sk:{namespace}:`, asserted on a live connection). TASK-2-03, wave 1.
 *
 * Contract: `docs/contracts/redirect-cache.md`. ADR-0012 (the client and its posture),
 * ADR-0008 (the shape), GC-O (bounded, no 5xx), GC-P (namespaced keys).
 *
 * WHAT ONLY A REAL SERVER CAN ANSWER, and therefore what is here rather than in
 * `src/cache/redirect-cache.spec.ts`: that Redis ACCEPTS the commands this cache issues,
 * that the TTLs it holds are the ones the contract fixes, that `SET … EX` really is one
 * command (`INFO commandstats` counts them: a fake cannot lie about that either way), and
 * that a server which goes away, hangs, or comes back produces the three behaviours the ACs
 * name. The fixture owns its own container because it breaks its server on purpose.
 */

/** Long enough for an image pull on a cold machine; a warm start takes ~1s. */
const CONTAINER_TIMEOUT_MS = 180_000;
const TEST_TIMEOUT_MS = 90_000;

/**
 * The bound on how long a cache call may take against a server that is CONNECTED and never
 * answering. ADR-0012's `commandTimeout` is 50 ms; the margin is for the runner, not for the
 * mechanism: at 500 ms this still fails if the timeout is removed, because an unanswered
 * command against a paused server never returns at all.
 */
const HUNG_CALL_BUDGET_MS = 500;

const HOSTNAME = 'links.example.test';
const SLUG = 'AbC1234';
/** The key `eventuallyServes` writes. Flushed by `beforeEach` like every other key. */
const PROBE_SLUG = 'probe00';

const NAMESPACE = `it-${String(process.pid)}`;

const host: CachedHost = {
  v: 1,
  dm: '11111111-1111-4111-8111-111111111111',
  t: '22222222-2222-4222-8222-222222222222',
  w: '33333333-3333-4333-8333-333333333333',
  b: { lg: null, bc: '#123456', fb: null },
};

const link: CachedLink = {
  v: 1,
  id: '44444444-4444-4444-8444-444444444444',
  d: 'https://example.test/destination?a=1&b=2',
  dm: host.dm,
  w: host.w,
  t: host.t,
  ea: null,
  aa: null,
};

let redis: ScratchRedis;
let cache: RedirectCache;

/** Polls a predicate rather than sleeping on it. Returns false when the budget is spent. */
async function eventually(predicate: () => boolean, budgetMs: number): Promise<boolean> {
  const deadline = Date.now() + budgetMs;

  while (Date.now() < deadline) {
    if (predicate()) {
      return true;
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  return predicate();
}

/**
 * THE RECOVERY ASSERTION, AND IT IS A ROUND TRIP RATHER THAN A STATUS READ.
 *
 * `cacheAvailable()` is `status === 'ready'`, and `disconnect()` is asynchronous: for the
 * few milliseconds between the call and Node delivering the close, the client reports itself
 * ready while its socket is already going away. A poll on that flag therefore returns `true`
 * on its first tick after a `simulate`, which is how the first version of this suite
 * "recovered" instantly and then failed on the next line. What every AC here actually claims
 * is that the cache SERVES again, so that is what is polled.
 */
async function eventuallyServes(budgetMs: number): Promise<boolean> {
  const deadline = Date.now() + budgetMs;

  for (;;) {
    await cache.setLink(HOSTNAME, PROBE_SLUG, link);

    if ((await cache.getLink(HOSTNAME, PROBE_SLUG)) !== 'unavailable') {
      return true;
    }

    if (Date.now() >= deadline) {
      return false;
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

beforeAll(async () => {
  redis = startScratchRedis('2-03', SCRATCH_REDIS_PORTS.cacheCodec);

  // The module reads these once, on the first `redirectCacheFor`, and the client is built
  // from them. `REDIS_KEY_NAMESPACE` carries the pid so two runs on one machine cannot
  // collide, the `ci-{run_id}` rule, one scale down.
  process.env.REDIS_URL = redis.url;
  process.env.REDIS_KEY_NAMESPACE = NAMESPACE;

  cache = redirectCacheFor(process.env);

  if (!(await eventually(cacheAvailable, 20_000))) {
    redis.stop();
    throw new Error('the client never reached `ready` against the scratch Redis');
  }
}, CONTAINER_TIMEOUT_MS);

afterAll(async () => {
  await closeRedisClient();
  redis?.stop();

  delete process.env.REDIS_URL;
  delete process.env.REDIS_KEY_NAMESPACE;
});

beforeEach(async () => {
  // EVERY TEST STARTS FROM A CACHE THAT IS ACTUALLY SERVING. The degradation tests take the
  // server away on purpose; a suite that assumed recovery rather than waiting for it bleeds
  // a half-dead client into whatever runs next, and the failure surfaces three tests later
  // as an unexplained 'unavailable'.
  expect(await eventuallyServes(30_000)).toBe(true);

  redis.cli('flushall');
  redis.cli('config', 'resetstat');
}, TEST_TIMEOUT_MS);

describe('round trip against a live server', () => {
  it('a host record and a link record survive Redis and decode back to themselves', async () => {
    await cache.setHost(HOSTNAME, host);
    await cache.setLink(HOSTNAME, SLUG, link);

    expect({ host: await cache.getHost(HOSTNAME), link: await cache.getLink(HOSTNAME, SLUG) }).toEqual({
      host,
      link,
    });
  });

  it('AC-2-32: every key on the live connection begins sk:{namespace}:', async () => {
    await cache.setHost(HOSTNAME, host);
    await cache.setLink(HOSTNAME, SLUG, link);
    await cache.setLink(HOSTNAME, 'other12', 'miss');

    const keys = redis.cli('keys', '*').split('\n').filter(Boolean).sort();

    expect({
      count: keys.length,
      unnamespaced: keys.filter((key) => !key.startsWith(`sk:${NAMESPACE}:`)),
      keys,
    }).toEqual({
      count: 3,
      unnamespaced: [],
      keys: [
        `sk:${NAMESPACE}:hst:v1:${HOSTNAME}`,
        `sk:${NAMESPACE}:rdr:v1:${HOSTNAME}:${SLUG}`,
        `sk:${NAMESPACE}:rdr:v1:${HOSTNAME}:other12`,
      ].sort(),
    });
  });

  it('the TTLs Redis holds are the contract’s, including the clamp on a windowed link', async () => {
    await cache.setHost(HOSTNAME, host);
    await cache.setLink(HOSTNAME, SLUG, link);
    await cache.setLink(HOSTNAME, 'expires', { ...link, ea: Date.now() + 120_000 });
    await cache.setLink(HOSTNAME, 'negativ', 'miss');

    const ttl = (key: string): number => Number(redis.cli('ttl', key));

    expect({
      host: ttl(`sk:${NAMESPACE}:hst:v1:${HOSTNAME}`),
      link: ttl(`sk:${NAMESPACE}:rdr:v1:${HOSTNAME}:${SLUG}`),
      clamped: ttl(`sk:${NAMESPACE}:rdr:v1:${HOSTNAME}:expires`),
      negative: ttl(`sk:${NAMESPACE}:rdr:v1:${HOSTNAME}:negativ`),
    }).toEqual({
      host: HOST_TTL_S,
      link: LINK_TTL_S,
      clamped: 120,
      negative: LINK_MISS_TTL_S,
    });
  });

  it('the sentinel Redis holds is one NUL byte, and it reads back as a cached negative', async () => {
    await cache.setLink(HOSTNAME, SLUG, 'miss');

    expect({
      length: Number(redis.cli('strlen', `sk:${NAMESPACE}:rdr:v1:${HOSTNAME}:${SLUG}`)),
      sentinelLength: MISS_SENTINEL.length,
      read: await cache.getLink(HOSTNAME, SLUG),
    }).toEqual({ length: 1, sentinelLength: 1, read: 'miss' });
  });

  it('a write is ONE command: the server counts a SET and no EXPIRE (redirect-cache.md)', async () => {
    await cache.setLink(HOSTNAME, SLUG, link);

    const stats = redis.cli('info', 'commandstats');
    const calls = (command: string): string | undefined =>
      stats.split('\n').find((line) => line.startsWith(`cmdstat_${command}:`));

    expect({
      set: calls('set')?.includes('calls=1'),
      expire: calls('expire'),
      pexpire: calls('pexpire'),
      setex: calls('setex'),
    }).toEqual({ set: true, expire: undefined, pexpire: undefined, setex: undefined });
  });

  it('invalidation deletes the key, and the next read no longer answers from the cache', async () => {
    await cache.setLink(HOSTNAME, SLUG, link);
    await cache.delLink(HOSTNAME, SLUG);

    expect({
      exists: Number(redis.cli('exists', `sk:${NAMESPACE}:rdr:v1:${HOSTNAME}:${SLUG}`)),
      read: await cache.getLink(HOSTNAME, SLUG),
    }).toEqual({ exists: 0, read: 'unavailable' });
  });

  it('deleting a key that is not there is not a failure: delete-on-create fires on every create', async () => {
    await expect(cache.delLink(HOSTNAME, 'nothere')).resolves.toBeUndefined();
  });
});

describe('simulateRedisUnavailable (AC-2-29)', () => {
  it(
    'reads degrade to unavailable and writes are no-ops, with nothing thrown at the caller',
    async () => {
      await cache.setLink(HOSTNAME, SLUG, link);
      expect(await cache.getLink(HOSTNAME, SLUG)).toEqual(link);

      const restore = simulateRedisUnavailable();

      try {
        // POLLED, NOT ASSUMED: `disconnect()` ends the socket and the status follows when
        // Node delivers the close. The fixture is in force once the client is no longer
        // ready, and everything below is asserted from there.
        expect(await eventually(() => !cacheAvailable(), 20_000)).toBe(true);

        expect({
          available: cacheAvailable(),
          link: await cache.getLink(HOSTNAME, SLUG),
          host: await cache.getHost(HOSTNAME),
          write: await cache.setLink(HOSTNAME, SLUG, link),
        }).toEqual({ available: false, link: 'unavailable', host: 'unavailable', write: undefined });

        // The one call that reports failure rather than swallowing it: TASK-2-08 retries and
        // logs on this rejection, and a resolved promise here would be a silent stale key.
        await expect(cache.delLink(HOSTNAME, SLUG)).rejects.toThrow(/redirect cache/i);
      } finally {
        restore();
      }

      expect(await eventuallyServes(30_000)).toBe(true);
      expect({ available: cacheAvailable(), link: await cache.getLink(HOSTNAME, SLUG) }).toEqual({
        available: true,
        link,
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'restore is idempotent, and a restore called in the same tick as the simulate still recovers',
    async () => {
      // The order that cost a debugging round: `disconnect()` has not landed yet, so the
      // client still reads `ready` when `restore` runs. It must reconnect anyway rather than
      // leaving the process without a cache for the rest of the run.
      restoreRedisAvailability();
      simulateRedisUnavailable();
      restoreRedisAvailability();
      restoreRedisAvailability();

      expect(await eventuallyServes(30_000)).toBe(true);

      await cache.setLink(HOSTNAME, SLUG, link);

      expect(await cache.getLink(HOSTNAME, SLUG)).toEqual(link);
    },
    TEST_TIMEOUT_MS,
  );
});

describe('a hung but connected server (AC-2-30)', () => {
  it(
    'every cache call resolves inside the commandTimeout budget, and the caller gets unavailable',
    async () => {
      await cache.setLink(HOSTNAME, SLUG, link);

      // Not vacuous: a client that was already down would answer 'unavailable' in zero
      // milliseconds and this test would pass while asserting nothing about the timeout.
      expect({ available: cacheAvailable(), warm: await cache.getLink(HOSTNAME, SLUG) }).toEqual({
        available: true,
        warm: link,
      });

      redis.pause();

      try {
        // The socket is open and the client is `ready`; the server is stopped in the kernel
        // and will never answer. Without `commandTimeout` this read never returns.
        const startedAt = Date.now();
        const answer = await cache.getLink(HOSTNAME, SLUG);
        const elapsed = Date.now() - startedAt;

        expect({ answer, withinBudget: elapsed < HUNG_CALL_BUDGET_MS, elapsed }).toEqual({
          answer: 'unavailable',
          withinBudget: true,
          elapsed,
        });
      } finally {
        redis.unpause();
      }

      expect(await eventuallyServes(30_000)).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );
});

describe('the server goes away and comes back (AC-2-29, AC-2-31)', () => {
  it(
    'reads degrade while it is down and are served from the cache again after it returns (no restart, no new client)',
    async () => {
      await cache.setLink(HOSTNAME, SLUG, link);

      expect({ available: cacheAvailable(), warm: await cache.getLink(HOSTNAME, SLUG) }).toEqual({
        available: true,
        warm: link,
      });

      redis.stopServer();

      try {
        expect(await eventually(() => !cacheAvailable(), 20_000)).toBe(true);

        // Nothing throws at the caller. This is the whole of AC-2-29's "no 5xx" as this
        // layer can state it: the redirect handler above simply queries Postgres.
        expect({
          link: await cache.getLink(HOSTNAME, SLUG),
          host: await cache.getHost(HOSTNAME),
          write: await cache.setHost(HOSTNAME, host),
        }).toEqual({ link: 'unavailable', host: 'unavailable', write: undefined });
      } finally {
        redis.startServer();
      }

      // `retryStrategy` reconnects on its own: no `connect()` call, no new client, no
      // process restart. Only the wait is ours.
      expect(await eventuallyServes(30_000)).toBe(true);

      await cache.setLink(HOSTNAME, SLUG, link);

      expect({ available: cacheAvailable(), link: await cache.getLink(HOSTNAME, SLUG) }).toEqual({
        available: true,
        link,
      });
    },
    TEST_TIMEOUT_MS,
  );
});
