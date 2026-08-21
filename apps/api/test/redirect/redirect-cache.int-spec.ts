import { RequestMethod } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppModule } from '../../src/app.module';
import { dbQueryCounter } from '../../src/cache/db-query-counter';
import { cacheAvailable, closeRedisClient } from '../../src/cache/redis-client';
import {
  HOST_MISS_TTL_S,
  HOST_TTL_S,
  LINK_MISS_TTL_S,
  LINK_TTL_S,
  MISS_SENTINEL,
  hostKey,
  linkKey,
} from '../../src/cache/redirect-cache';
import type { CachedLink } from '../../src/cache/redirect-cache';
import { closeDatabase } from '../../src/db/client';
import { PLATFORM_TENANT_ID, SYSTEM_DEFAULT_DOMAIN_ID } from '../../src/db/platform';
import { REDIRECT_ROUTE_PREFIX_EXCLUSION } from '../../src/redirect/redirect.module';
import { SCRATCH_REDIS_PORTS, startScratchRedis } from '../cache/scratch-redis';
import type { ScratchRedis } from '../cache/scratch-redis';
import {
  TENANT_A,
  assertAppRoleCannotBypassRls,
  createRlsFixture,
  dropRlsFixture,
} from '../support/rls-fixture';

import {
  ACTIVE_SLUG,
  DESTINATION,
  EXPIRED_SLUG,
  NOT_ACTIVE_HOSTNAME,
  ON_INACTIVE_DOMAIN_SLUG,
  PLATFORM_HOSTNAME,
  SOON_EXPIRY_SECONDS,
  SOON_SLUG,
  UNKNOWN_HOSTNAME,
  UNKNOWN_SLUG,
  eraseTenant,
  get,
  onPlatform,
  plantRedirectFixture,
} from './redirect-fixture';

/**
 * TASK-2-07 (item 2, wave 4), against a real Redis and a real Postgres.
 * AC-2-15 (a warm hit costs zero Postgres queries, expiry and the click ids included),
 * AC-2-26 (an expired hit answers 404 from the record and does not fall through),
 * AC-2-28 (`setLink` applies `linkTtlSeconds`, and the clamp is hygiene rather than the
 * rule), and the negative entries at both namespaces including their TTL bounds.
 *
 * Contract: `docs/contracts/redirect-cache.md` (invariants 2, 4, 5 and 6; "Only an `active`
 * domain is cached"), `redirect-resolution.md` (decision order, invariants 2 and 3).
 * ADR-0008, ADR-0009, ADR-0012; D-2-09.
 *
 * ============================================================================
 * THE MEASUREMENT IS `dbQueryCounter`, AND IT COUNTS STATEMENTS, NOT ROUND TRIPS.
 * ============================================================================
 *
 * `withRedirectRead` increments it on EVERY statement it issues, the two-statement preamble
 * included (`SET TRANSACTION READ ONLY`, `set_config`), so the numbers this file asserts are:
 *
 *   4  both keys cold: one transaction, its preamble, and the two reads. This is exactly
 *      what wave 3's redirect cost per request, which is the card's bound: a MISS may cost
 *      what a cold resolve cost and no more.
 *   3  one key cold: the same preamble and the ONE statement that key needs.
 *   0  both keys warm, and 0 for a cached negative at either namespace.
 *
 * `redirect.int-spec.ts` asserts the 4 with no Redis configured at all; this file asserts the
 * 0 and the 3 with one configured, and the two files together are the whole claim.
 *
 * THE SCRATCH CONTAINER IS THIS SUITE'S OWN, ON ITS OWN PORT (56382). The compose stacks
 * publish 56379 and 56380 and `test/cache/redirect-cache.int-spec.ts` takes 56381; a suite
 * that flushed a shared instance would take the others down with it, and this one flushes
 * before every test.
 */

const NAMESPACE = `it-2-07-cache-${String(process.pid)}`;
const CONTAINER_TIMEOUT_MS = 180_000;
const REDIS_PORT = SCRATCH_REDIS_PORTS.redirectCache;

let redis: ScratchRedis;
let app: INestApplication | undefined;
let port = 0;

const platformHostKey = (): string => hostKey(NAMESPACE, PLATFORM_HOSTNAME);
const platformLinkKey = (slug: string): string => linkKey(NAMESPACE, PLATFORM_HOSTNAME, slug);

/** Every key Redis holds, sorted, so a test can say what was written AND what was not. */
function keys(): string[] {
  return redis.cli('keys', '*').split('\n').filter(Boolean).sort();
}

function ttl(key: string): number {
  return Number(redis.cli('ttl', key));
}

function raw(key: string): string {
  return redis.cli('get', key);
}

/** Reset, drive one request, and report what it cost in statements. */
async function cost(request: () => Promise<{ status: number }>): Promise<{ status: number; queries: number }> {
  dbQueryCounter.reset();

  const probe = await request();

  return { status: probe.status, queries: dbQueryCounter.read() };
}

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

beforeAll(async () => {
  redis = startScratchRedis('2-07-cache', REDIS_PORT);

  // Read once, by `CacheModule`'s factory, when the module below compiles. Set before the
  // compile or the process binds `UnavailableRedirectCache` and every assertion here is
  // vacuous, which is the failure mode this suite is most exposed to, so `beforeEach`
  // additionally waits for a cache that actually serves.
  process.env.REDIS_URL = redis.url;
  process.env.REDIS_KEY_NAMESPACE = NAMESPACE;

  assertAppRoleCannotBypassRls();
  createRlsFixture();
  eraseTenant(PLATFORM_TENANT_ID);
  plantRedirectFixture();

  vi.stubEnv('BETTER_AUTH_URL', 'http://127.0.0.1:1/api/auth');
  vi.stubEnv('GIT_COMMIT_SHA', '3d1f7a0c94b25e68af31c07d5b8e4a2196fd0c7b');

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();

  app = moduleRef.createNestApplication({ logger: false });
  app.setGlobalPrefix('api', {
    exclude: [{ path: 'health', method: RequestMethod.GET }, REDIRECT_ROUTE_PREFIX_EXCLUSION],
  });
  await app.listen(0, '127.0.0.1');
  port = Number(new URL(await app.getUrl()).port);

  if (!(await eventually(cacheAvailable, 20_000))) {
    throw new Error('the client never reached `ready` against the scratch Redis; nothing below would measure a cache');
  }
}, CONTAINER_TIMEOUT_MS);

afterAll(async () => {
  await app?.close();
  await closeRedisClient();
  redis?.stop();
  eraseTenant(PLATFORM_TENANT_ID);
  dropRlsFixture();
  await closeDatabase();
  vi.unstubAllEnvs();

  delete process.env.REDIS_URL;
  delete process.env.REDIS_KEY_NAMESPACE;
});

/**
 * EVERY TEST STARTS COLD, and the rows are planted once. Nothing here writes to Postgres
 * (the redirect's transaction is `READ ONLY`), so the only state a test can disturb is in
 * Redis, and that is what is flushed.
 */
beforeEach(() => {
  redis.cli('flushall');
  dbQueryCounter.reset();
});

describe('AC-2-15: the warm hit costs no Postgres query at all', () => {
  it('pays the cold resolve once and nothing on the request after it', async () => {
    const cold = await cost(async () => onPlatform(port, `/${ACTIVE_SLUG}`));
    const warm = await cost(async () => onPlatform(port, `/${ACTIVE_SLUG}`));

    expect({ cold, warm }).toEqual({
      cold: { status: 302, queries: 4 },
      warm: { status: 302, queries: 0 },
    });
  });

  it('serves the same destination byte for byte from the cache as from the row', async () => {
    const fromRow = await onPlatform(port, `/${ACTIVE_SLUG}`);
    const fromCache = await onPlatform(port, `/${ACTIVE_SLUG}`);

    expect([fromRow.headers.location, fromCache.headers.location]).toEqual([
      DESTINATION,
      DESTINATION,
    ]);
    // The marker: `res.redirect` would have made this `a%7Cb` on either path.
    expect(fromCache.headers.location).toContain('a|b');
  });

  it('writes both records, namespaced, and nothing else', async () => {
    await onPlatform(port, `/${ACTIVE_SLUG}`);

    expect(keys()).toEqual([platformHostKey(), platformLinkKey(ACTIVE_SLUG)].sort());
    expect(keys().filter((key) => !key.startsWith(`sk:${NAMESPACE}:`))).toEqual([]);
  });

  /**
   * AC-2-15 names the click enqueue's tenant id specifically, because it is the field a
   * record designed only for the 302 would have left to a lookup, and a lookup on the hot
   * path is what makes click emission a GC-5 exception instead of an ordinary tenant write.
   * The record holds it, so the zero above covers the click too.
   */
  it('the cached record carries the tenant, domain and link ids the click sink needs', async () => {
    await onPlatform(port, `/${ACTIVE_SLUG}`);

    const record = JSON.parse(raw(platformLinkKey(ACTIVE_SLUG))) as CachedLink;

    expect({ v: record.v, t: record.t, dm: record.dm, d: record.d, id: typeof record.id }).toEqual({
      v: 1,
      t: TENANT_A,
      dm: SYSTEM_DEFAULT_DOMAIN_ID,
      d: DESTINATION,
      id: 'string',
    });
  });

  /**
   * The two TTLs differ by a factor of twelve, so BOTH mixed states are ordinary rather than
   * exotic, and each costs the preamble plus the ONE statement its missing key needs. A
   * design that re-read the whole resolution for either would pay four statements for one
   * missing row.
   */
  it('costs three statements when the host key is gone under a live link key', async () => {
    await onPlatform(port, `/${ACTIVE_SLUG}`);
    redis.cli('del', platformHostKey());

    expect(await cost(async () => onPlatform(port, `/${ACTIVE_SLUG}`))).toEqual({
      status: 302,
      queries: 3,
    });
    // And the host record is back, so the next request is free again.
    expect(await cost(async () => onPlatform(port, `/${ACTIVE_SLUG}`))).toEqual({
      status: 302,
      queries: 0,
    });
  });

  it('costs three statements when the link key is gone under a live host record', async () => {
    await onPlatform(port, `/${ACTIVE_SLUG}`);
    redis.cli('del', platformLinkKey(ACTIVE_SLUG));

    expect(await cost(async () => onPlatform(port, `/${ACTIVE_SLUG}`))).toEqual({
      status: 302,
      queries: 3,
    });
    expect(await cost(async () => onPlatform(port, `/${ACTIVE_SLUG}`))).toEqual({
      status: 302,
      queries: 0,
    });
  });

  /**
   * ============================================================================
   * THE STATE WITH TWO REASONS TO READ POSTGRES STILL OPENS ONE TRANSACTION.
   * ============================================================================
   *
   * A cold host key under a cached record that names ANOTHER domain needs statement 1 to
   * decide and statement 2 to replace the record. Both go inside one `withRedirectRead`, so
   * the cost is four and not six: two transactions would pay the two-statement preamble
   * twice, which is what reading both cache keys before choosing a read exists to avoid.
   *
   * The record is planted rather than produced, because a link's domain cannot change in item
   * 2 (`links_domain_tenant_fk` and the composite key see to that). Domain reassignment is
   * item 3's, and this is the measurement that will already be here when it lands.
   */
  it('costs four statements, in ONE transaction, when a cached record names another domain', async () => {
    await onPlatform(port, `/${ACTIVE_SLUG}`);

    const record = JSON.parse(raw(platformLinkKey(ACTIVE_SLUG))) as CachedLink;
    const elsewhere: CachedLink = { ...record, dm: '00000000-0000-4000-8000-0000000000d9' };

    redis.cli('set', platformLinkKey(ACTIVE_SLUG), JSON.stringify(elsewhere), 'EX', String(LINK_TTL_S));
    redis.cli('del', platformHostKey());

    const probe = await cost(async () => onPlatform(port, `/${ACTIVE_SLUG}`));

    expect(probe).toEqual({ status: 302, queries: 4 });
    // The row on the domain that really resolved replaced the stale record, so the next
    // request is free again and serves the right destination.
    expect(await cost(async () => onPlatform(port, `/${ACTIVE_SLUG}`))).toEqual({
      status: 302,
      queries: 0,
    });
    expect((await onPlatform(port, `/${ACTIVE_SLUG}`)).headers.location).toBe(DESTINATION);
  });

  /** Step 0 again, now that there is a cache to reach: neither store is touched. */
  it('a segment that cannot be a slug reaches neither Redis nor Postgres', async () => {
    const probe = await cost(async () => onPlatform(port, '/favicon.ico'));

    expect(probe).toEqual({ status: 404, queries: 0 });
    expect(keys()).toEqual([]);
  });
});

describe('the negative entries, and the 60 seconds that bound a scan', () => {
  it('caches the unknown slug at rdr: as the sentinel, and the next 404 costs nothing', async () => {
    const cold = await cost(async () => onPlatform(port, `/${UNKNOWN_SLUG}`));
    const warm = await cost(async () => onPlatform(port, `/${UNKNOWN_SLUG}`));

    expect({ cold, warm }).toEqual({
      cold: { status: 404, queries: 4 },
      warm: { status: 404, queries: 0 },
    });
    expect({
      value: raw(platformLinkKey(UNKNOWN_SLUG)),
      ttl: ttl(platformLinkKey(UNKNOWN_SLUG)),
    }).toEqual({ value: MISS_SENTINEL, ttl: LINK_MISS_TTL_S });
  });

  /**
   * Invariant 5 of `redirect-cache.md`: a scan of unknown slugs holds at most
   * `missRate * 60` keys, which is the whole reason the negative TTL is 60 seconds and not
   * the link TTL. Sixty is asserted rather than described because it is the bound.
   */
  it('bounds a scan of unknown slugs at 60 seconds per key', async () => {
    for (const slug of ['scan0001', 'scan0002', 'scan0003']) {
      await onPlatform(port, `/${slug}`);
    }

    const scanned = keys().filter((key) => key.includes(':rdr:v1:'));

    expect(scanned).toHaveLength(3);
    expect(scanned.map((key) => raw(key))).toEqual([MISS_SENTINEL, MISS_SENTINEL, MISS_SENTINEL]);
    expect(scanned.every((key) => ttl(key) <= LINK_MISS_TTL_S && ttl(key) > 0)).toBe(true);
  });

  /**
   * An unknown HOSTNAME ends the request at step 2, so its negative lands at `hst:` and
   * NOTHING is written at `rdr:`. The host key is read first, so a link key under a
   * hostname that serves nothing would be a key nobody ever looks at.
   */
  it('caches the unknown hostname at hst: only, and the next 404 costs nothing', async () => {
    const cold = await cost(async () => get(port, `/${ACTIVE_SLUG}`, UNKNOWN_HOSTNAME));
    const warm = await cost(async () => get(port, `/${ACTIVE_SLUG}`, UNKNOWN_HOSTNAME));

    // THREE, not four: a hostname that resolves to no active domain never issues the second
    // statement, in this path exactly as in wave 3. Reading `links` for a hostname that
    // resolves to nothing would be a slug lookup across every domain in the system.
    expect({ cold, warm }).toEqual({
      cold: { status: 404, queries: 3 },
      warm: { status: 404, queries: 0 },
    });
    expect(keys()).toEqual([hostKey(NAMESPACE, UNKNOWN_HOSTNAME)]);
    expect({
      value: raw(hostKey(NAMESPACE, UNKNOWN_HOSTNAME)),
      ttl: ttl(hostKey(NAMESPACE, UNKNOWN_HOSTNAME)),
    }).toEqual({ value: MISS_SENTINEL, ttl: HOST_MISS_TTL_S });
  });

  /**
   * F-003 THROUGH THE CACHE, which is the half a state predicate on the query alone does not
   * cover. A domain in `pending_verification` must cache as MISS: a positive record for it
   * would serve an unverified claim for up to 300 seconds while the SQL kept its
   * `AND state = 'active'` and looked correct.
   */
  it('caches a domain that is not active as MISS, never as a record', async () => {
    const cold = await cost(async () =>
      get(port, `/${ON_INACTIVE_DOMAIN_SLUG}`, NOT_ACTIVE_HOSTNAME),
    );
    const warm = await cost(async () =>
      get(port, `/${ON_INACTIVE_DOMAIN_SLUG}`, NOT_ACTIVE_HOSTNAME),
    );

    expect({ cold, warm }).toEqual({
      cold: { status: 404, queries: 3 },
      warm: { status: 404, queries: 0 },
    });
    expect(keys()).toEqual([hostKey(NAMESPACE, NOT_ACTIVE_HOSTNAME)]);
    expect(raw(hostKey(NAMESPACE, NOT_ACTIVE_HOSTNAME))).toBe(MISS_SENTINEL);
  });
});

describe('AC-2-26 and AC-2-28: the window is the read-time check, the TTL is hygiene', () => {
  /**
   * ============================================================================
   * THE EXPIRED LINK IS CACHED POSITIVE, AND THE 404 COMES FROM THE RECORD.
   * ============================================================================
   *
   * Nothing filters an out-of-window link out of the cache, deliberately: the record is
   * correct, and what decides the response is `isLinkActive` on every read (ADR-0009). So the
   * second request answers 404 with ZERO queries, the case AC-2-26 calls "no fall-through on
   * an inactive hit", which a resolver that treated an inactive record as a miss would fail
   * by silently costing a query per request on every expired link a scanner finds.
   */
  it('answers 404 from a cached record whose window has closed, with no query', async () => {
    const cold = await cost(async () => onPlatform(port, `/${EXPIRED_SLUG}`));
    const warm = await cost(async () => onPlatform(port, `/${EXPIRED_SLUG}`));

    expect({ cold, warm }).toEqual({
      cold: { status: 404, queries: 4 },
      warm: { status: 404, queries: 0 },
    });
    expect(raw(platformLinkKey(EXPIRED_SLUG))).not.toBe(MISS_SENTINEL);
  });

  /**
   * ============================================================================
   * THE CLOCK PASSES THE INSTANT WITH NO WRITE ANYWHERE, WHICH IS AC-2-26 EXACTLY.
   * ============================================================================
   *
   * The record below is the one the SERVICE wrote a line earlier, read back out and put back
   * with its `ea` behind us and its TTL untouched. That is not a contrivance: `linkTtlSeconds`
   * clamps to whole seconds and Redis expiry is LAZY, so a record whose window closes between
   * two requests is the ordinary case, and it is the one where a resolver that leaned on the
   * TTL for correctness would serve a 302 it must not. No Postgres row is touched, and the
   * answer is 404 for zero queries.
   */
  it('404s a record whose expiry passed since it was written, from the record alone', async () => {
    await onPlatform(port, `/${ACTIVE_SLUG}`);

    const record = JSON.parse(raw(platformLinkKey(ACTIVE_SLUG))) as CachedLink;
    const passed: CachedLink = { ...record, ea: Date.now() - 1000 };

    redis.cli('set', platformLinkKey(ACTIVE_SLUG), JSON.stringify(passed), 'EX', String(LINK_TTL_S));

    expect(await cost(async () => onPlatform(port, `/${ACTIVE_SLUG}`))).toEqual({
      status: 404,
      queries: 0,
    });
  });

  /**
   * AC-2-28. `setLink` applies `linkTtlSeconds`, so a link two minutes from its expiry holds a
   * key for at most those two minutes rather than for the flat hour, and the host key keeps
   * its own flat 300. THE CLAMP IS MEMORY AND COST HYGIENE: the test above is the correctness
   * mechanism, and deleting the read-time check on the reasoning that this clamp already
   * expires the record is the defect ADR-0009 was written to prevent.
   */
  it('clamps the link TTL by time-to-expiry, while the host TTL stays flat', async () => {
    await onPlatform(port, `/${SOON_SLUG}`);

    const clamped = ttl(platformLinkKey(SOON_SLUG));

    expect({
      withinExpiry: clamped <= SOON_EXPIRY_SECONDS && clamped > 0,
      clamped,
      belowFlat: clamped < LINK_TTL_S,
      host: ttl(platformHostKey()),
    }).toEqual({ withinExpiry: true, clamped, belowFlat: true, host: HOST_TTL_S });
  });

  it('holds the flat hour for a link with no window at all', async () => {
    await onPlatform(port, `/${ACTIVE_SLUG}`);

    expect(ttl(platformLinkKey(ACTIVE_SLUG))).toBe(LINK_TTL_S);
  });
});
