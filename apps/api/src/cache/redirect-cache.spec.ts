import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { dbQueryCounter } from './db-query-counter';
import {
  HOST_MISS_TTL_S,
  HOST_TTL_S,
  LINK_MISS_TTL_S,
  LINK_TTL_S,
  MISS_SENTINEL,
  RedisRedirectCache,
  hostKey,
  linkKey,
  linkTtlSeconds,
} from './redirect-cache';
import type { CachedHost, CachedLink, RedirectCacheClient } from './redirect-cache';

/**
 * STORY-2-06 — AC-2-28 (the clamp), AC-2-29 ('unavailable' is not 'miss'), AC-2-30 (bounded,
 * never a throw). TASK-2-03, wave 1.
 *
 * Contract: `docs/contracts/redirect-cache.md` — normative for the keys, the two value
 * shapes, the sentinel, the four TTLs, `linkTtlSeconds`, `SET key value EX ttl` as ONE
 * command, and `'unavailable'` ≠ `'miss'`. ADR-0008 (the shape), ADR-0009 (the clamp is
 * hygiene, not correctness), ADR-0012 (bounded reads that fall through), GC-P (`sk:{env}:`).
 *
 * NO REDIS HERE. The client is the structural interface `RedisRedirectCache` is written
 * against, so the key strings, the codecs and the degradation branches are asserted without
 * Docker — AC-1's clean-clone rule. `test/cache/redirect-cache.int-spec.ts` runs the same
 * class against a real server for the things a fake cannot answer: that the server accepts
 * these commands, that the TTLs are the ones it holds, and that a stopped server degrades.
 */

type Command = readonly [string, ...unknown[]];

/** What the fake was told to do when a command arrives. */
type Behaviour = 'ok' | 'reject' | 'throw';

class FakeRedis implements RedirectCacheClient {
  status = 'ready';
  behaviour: Behaviour = 'ok';
  readonly commands: Command[] = [];
  readonly store = new Map<string, string>();

  get(key: string): Promise<string | null> {
    this.commands.push(['get', key]);

    return this.answer(() => this.store.get(key) ?? null);
  }

  set(key: string, value: string, mode: 'EX', ttl: number): Promise<unknown> {
    this.commands.push(['set', key, value, mode, ttl]);

    return this.answer(() => {
      this.store.set(key, value);

      return 'OK';
    });
  }

  del(key: string): Promise<unknown> {
    this.commands.push(['del', key]);

    return this.answer(() => (this.store.delete(key) ? 1 : 0));
  }

  private answer<T>(produce: () => T): Promise<T> {
    if (this.behaviour === 'throw') {
      // ioredis rejects rather than throwing synchronously, but a caller that assumes
      // either shape is a caller that can be made to throw at the visitor.
      throw new Error('command failed synchronously');
    }

    return this.behaviour === 'reject'
      ? Promise.reject(new Error('Stream isn’t writeable and enableOfflineQueue options is false'))
      : Promise.resolve(produce());
  }
}

const HOSTNAME = 'links.example.test';
const SLUG = 'AbC1234';

const host: CachedHost = {
  v: 1,
  dm: '11111111-1111-4111-8111-111111111111',
  t: '22222222-2222-4222-8222-222222222222',
  w: '33333333-3333-4333-8333-333333333333',
  b: { lg: 'https://cdn.example.test/l.png', bc: '#ff0000', fb: 'https://example.test/gone' },
};

const link: CachedLink = {
  v: 1,
  id: '44444444-4444-4444-8444-444444444444',
  d: 'https://example.test/destination?a=1',
  dm: host.dm,
  w: host.w,
  t: host.t,
  ea: null,
  aa: null,
};

let client: FakeRedis;
let cache: RedisRedirectCache;

beforeEach(() => {
  client = new FakeRedis();
  cache = new RedisRedirectCache(client, 'dev');
});

describe('keys (redirect-cache.md "Keys", GC-P)', () => {
  it('the two builders produce the contract’s key strings, namespace first', () => {
    expect({ host: hostKey('dev', HOSTNAME), link: linkKey('dev', HOSTNAME, SLUG) }).toEqual({
      host: 'sk:dev:hst:v1:links.example.test',
      link: 'sk:dev:rdr:v1:links.example.test:AbC1234',
    });
  });

  it('the slug segment is verbatim and case-sensitive (ADR-0007)', () => {
    expect(linkKey('ci-42', HOSTNAME, 'abc1234')).not.toBe(linkKey('ci-42', HOSTNAME, 'ABC1234'));
  });

  it('GC-P: every key the cache touches begins sk:{namespace}:', async () => {
    const namespaced = new RedisRedirectCache(client, 'ci-1234');

    await namespaced.getHost(HOSTNAME);
    await namespaced.setHost(HOSTNAME, host);
    await namespaced.delHost(HOSTNAME);
    await namespaced.getLink(HOSTNAME, SLUG);
    await namespaced.setLink(HOSTNAME, SLUG, link);
    await namespaced.delLink(HOSTNAME, SLUG);

    expect(client.commands.map(([, key]) => key).filter((key) => !String(key).startsWith('sk:ci-1234:'))).toEqual([]);
    expect(client.commands.length).toBe(6);
  });
});

describe('values (redirect-cache.md "Values", ADR-0008)', () => {
  it('a host record round-trips through the codec', async () => {
    await cache.setHost(HOSTNAME, host);

    await expect(cache.getHost(HOSTNAME)).resolves.toEqual(host);
  });

  it('a host with no branding round-trips as null rather than as undefined', async () => {
    const unbranded: CachedHost = { ...host, b: null };
    await cache.setHost(HOSTNAME, unbranded);

    await expect(cache.getHost(HOSTNAME)).resolves.toEqual(unbranded);
  });

  it('a link record round-trips, including the two epoch-millisecond timestamps', async () => {
    const dated: CachedLink = { ...link, ea: 1_800_000_000_000, aa: 1_700_000_000_000 };
    await cache.setLink(HOSTNAME, SLUG, dated);

    await expect(cache.getLink(HOSTNAME, SLUG)).resolves.toEqual(dated);
  });

  it('the stored bytes are the contract’s short field names and v:1, and nothing else', async () => {
    await cache.setHost(HOSTNAME, host);
    await cache.setLink(HOSTNAME, SLUG, link);

    expect([...client.store.values()].map((raw) => Object.keys(JSON.parse(raw) as object).sort())).toEqual([
      ['b', 'dm', 't', 'v', 'w'],
      ['aa', 'd', 'dm', 'ea', 'id', 't', 'v', 'w'],
    ]);
  });

  it('MISS_SENTINEL is the single byte the contract fixes, and a sentinel read is a cached negative', async () => {
    await cache.setHost(HOSTNAME, 'miss');
    await cache.setLink(HOSTNAME, SLUG, 'miss');

    expect({
      sentinel: MISS_SENTINEL,
      stored: [...client.store.values()],
      host: await cache.getHost(HOSTNAME),
      link: await cache.getLink(HOSTNAME, SLUG),
    }).toEqual({
      sentinel: '\u0000',
      stored: ['\u0000', '\u0000'],
      host: 'miss',
      link: 'miss',
    });
  });
});

describe('TTLs (redirect-cache.md "TTLs", ADR-0009)', () => {
  it('the four constants are the contract’s, in every environment — there is no test TTL', () => {
    expect({ HOST_TTL_S, HOST_MISS_TTL_S, LINK_TTL_S, LINK_MISS_TTL_S }).toEqual({
      HOST_TTL_S: 300,
      HOST_MISS_TTL_S: 300,
      LINK_TTL_S: 3600,
      LINK_MISS_TTL_S: 60,
    });
  });

  const now = 1_700_000_000_000;
  const seconds = (n: number): number => now + n * 1000;

  it.each([
    ['no window at all', null, null, LINK_TTL_S],
    ['an expiry beyond the default', seconds(7200), null, LINK_TTL_S],
    ['an expiry inside the default', seconds(100), null, 100],
    ['an expiry that has passed', seconds(-100), null, 1],
    ['an expiry at this instant', now, null, 1],
    ['an activation in the future', null, seconds(50), 50],
    ['an activation in the past', null, seconds(-50), LINK_TTL_S],
    ['both, expiry the nearer', seconds(30), seconds(90), 30],
    ['both, activation the nearer', seconds(300), seconds(90), 90],
    ['a sub-second expiry', now + 400, null, 1],
  ])('linkTtlSeconds with %s', (_case, ea, aa, expected) => {
    expect(linkTtlSeconds({ ...link, ea, aa }, now)).toBe(expected);
  });

  it('AC-2-28: setLink applies the clamp, and it is hygiene — deleting the read-time isLinkActive check is still a defect', () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);

    try {
      void cache.setLink(HOSTNAME, SLUG, { ...link, ea: seconds(120) });
      void cache.setLink(HOSTNAME, 'other12', link);

      expect(client.commands.map(([, , , , ttl]) => ttl)).toEqual([120, LINK_TTL_S]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('setHost uses the flat TTL, and both negatives use their own', async () => {
    await cache.setHost(HOSTNAME, host);
    await cache.setHost(HOSTNAME, 'miss');
    await cache.setLink(HOSTNAME, SLUG, 'miss');

    expect(client.commands.map(([, , , , ttl]) => ttl)).toEqual([HOST_TTL_S, HOST_MISS_TTL_S, LINK_MISS_TTL_S]);
  });
});

describe('one command per write (redirect-cache.md "What the implementer must guarantee")', () => {
  it('a write is SET key value EX ttl — never SET then EXPIRE', async () => {
    await cache.setLink(HOSTNAME, SLUG, link);

    expect(client.commands).toEqual([['set', 'sk:dev:rdr:v1:links.example.test:AbC1234', expect.any(String), 'EX', LINK_TTL_S]]);
  });

  it('a read is one GET, whatever the outcome', async () => {
    await cache.getLink(HOSTNAME, SLUG);
    await cache.setLink(HOSTNAME, SLUG, 'miss');
    client.commands.length = 0;
    await cache.getLink(HOSTNAME, SLUG);

    expect(client.commands).toEqual([['get', 'sk:dev:rdr:v1:links.example.test:AbC1234']]);
  });
});

describe("'unavailable' is not 'miss' (AC-2-29, invariant 2)", () => {
  it('a rejected read answers unavailable rather than throwing into the caller', async () => {
    client.behaviour = 'reject';

    await expect(cache.getLink(HOSTNAME, SLUG)).resolves.toBe('unavailable');
    await expect(cache.getHost(HOSTNAME)).resolves.toBe('unavailable');
  });

  it('a client that throws synchronously is the same answer — GC-O admits no 5xx from here', async () => {
    client.behaviour = 'throw';

    await expect(cache.getLink(HOSTNAME, SLUG)).resolves.toBe('unavailable');
    await expect(cache.getHost(HOSTNAME)).resolves.toBe('unavailable');
  });

  it('a client that is not ready answers unavailable without issuing a command', async () => {
    // `enableOfflineQueue: false` would reject anyway; not issuing the command at all is
    // what keeps a disconnected client off the 50 ms budget entirely.
    client.status = 'reconnecting';

    expect({
      host: await cache.getHost(HOSTNAME),
      link: await cache.getLink(HOSTNAME, SLUG),
      commands: client.commands,
    }).toEqual({ host: 'unavailable', link: 'unavailable', commands: [] });
  });

  it('an ABSENT key is unavailable, not miss — only the sentinel answers the request', async () => {
    // The amendment of 2026-08-19 in redirect-cache.md. 'miss' 404s with zero queries, so
    // an empty cache answering 'miss' would 404 every link that was never cached.
    expect({ host: await cache.getHost(HOSTNAME), link: await cache.getLink(HOSTNAME, SLUG) }).toEqual({
      host: 'unavailable',
      link: 'unavailable',
    });
  });

  it('a value that does not decode is unavailable — the safe direction is a Postgres read', async () => {
    client.store.set(hostKey('dev', HOSTNAME), '{not json');
    client.store.set(linkKey('dev', HOSTNAME, SLUG), JSON.stringify({ ...link, v: 2 }));

    expect({ host: await cache.getHost(HOSTNAME), link: await cache.getLink(HOSTNAME, SLUG) }).toEqual({
      host: 'unavailable',
      link: 'unavailable',
    });
  });

  it('a decoded record missing a required field is unavailable, not a half-built answer', async () => {
    client.store.set(linkKey('dev', HOSTNAME, SLUG), JSON.stringify({ v: 1, id: link.id, d: link.d }));

    await expect(cache.getLink(HOSTNAME, SLUG)).resolves.toBe('unavailable');
  });
});

describe('writes and deletions under failure', () => {
  it('GC-O: a failed cache fill is swallowed — setHost and setLink never reject', async () => {
    client.behaviour = 'reject';

    await expect(
      Promise.all([cache.setHost(HOSTNAME, host), cache.setLink(HOSTNAME, SLUG, link), cache.setHost(HOSTNAME, 'miss')]),
    ).resolves.toEqual([undefined, undefined, undefined]);
  });

  it('a set against a client that is not ready issues no command and does not reject', async () => {
    client.status = 'end';

    await expect(cache.setLink(HOSTNAME, SLUG, link)).resolves.toBeUndefined();
    expect(client.commands).toEqual([]);
  });

  it('a failed DELETION rejects — the invalidation subscriber owns the retry and the log line (D-2-15)', async () => {
    // The one asymmetry, and it is deliberate: swallowing here would leave TASK-2-08 with
    // nothing to retry and nothing to report, and staleness past GC-2 with no signal at all.
    client.behaviour = 'reject';

    await expect(cache.delLink(HOSTNAME, SLUG)).rejects.toThrow();
    await expect(cache.delHost(HOSTNAME)).rejects.toThrow();
  });

  it('a deletion against a client that is not ready rejects rather than reporting success', async () => {
    client.status = 'close';

    await expect(cache.delLink(HOSTNAME, SLUG)).rejects.toThrow(/redirect cache/i);
    expect(client.commands).toEqual([]);
  });

  it('a deletion that succeeds resolves undefined and removes the key', async () => {
    await cache.setLink(HOSTNAME, SLUG, link);
    await expect(cache.delLink(HOSTNAME, SLUG)).resolves.toBeUndefined();

    await expect(cache.getLink(HOSTNAME, SLUG)).resolves.toBe('unavailable');
  });
});

describe('dbQueryCounter (redirect-cache.md "What the implementer must guarantee", AC-49)', () => {
  afterEach(() => {
    dbQueryCounter.reset();
  });

  it('counts what the redirect path tells it to count, and reads back', () => {
    dbQueryCounter.reset();
    dbQueryCounter.increment();
    dbQueryCounter.increment();

    expect(dbQueryCounter.read()).toBe(2);
  });

  it('reset is what a test uses to assert zero queries on a cache hit', () => {
    dbQueryCounter.increment();
    dbQueryCounter.reset();

    expect(dbQueryCounter.read()).toBe(0);
  });
});
