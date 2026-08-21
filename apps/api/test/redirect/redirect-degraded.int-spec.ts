import { RequestMethod } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppModule } from '../../src/app.module';
import { dbQueryCounter } from '../../src/cache/db-query-counter';
import {
  cacheAvailable,
  closeRedisClient,
  restoreRedisAvailability,
  simulateRedisUnavailable,
} from '../../src/cache/redis-client';
import { REDIRECT_CACHE } from '../../src/cache/redirect-cache';
import { UnavailableRedirectCache } from '../../src/cache/unavailable-redirect-cache';
import { closeDatabase } from '../../src/db/client';
import { PLATFORM_TENANT_ID } from '../../src/db/platform';
import { RedirectModule, REDIRECT_ROUTE_PREFIX_EXCLUSION } from '../../src/redirect/redirect.module';
import { RedirectService } from '../../src/redirect/redirect.service';
import { startScratchRedis } from '../cache/scratch-redis';
import type { ScratchRedis } from '../cache/scratch-redis';
import {
  assertAppRoleCannotBypassRls,
  createRlsFixture,
  dropRlsFixture,
} from '../support/rls-fixture';

import {
  ACTIVE_SLUG,
  DESTINATION,
  PLATFORM_HOSTNAME,
  UNKNOWN_SLUG,
  eraseTenant,
  onPlatform,
  plantRedirectFixture,
} from './redirect-fixture';

/**
 * TASK-2-07 (item 2, wave 4). STORY-2-06 on the redirect itself:
 * AC-2-29 (Redis gone: the correct 302 from Postgres, `dbQueryCounter` above zero, no 5xx,
 * and `'unavailable'` never conflated with `'miss'`), AC-2-30 (a hung-but-connected server is
 * bounded by `commandTimeout` and the request completes from Postgres), AC-2-31 (it comes
 * back and the redirect is served from the cache again, with no restart and no new client),
 * and the `REDIS_URL`-unset binding serving every redirect from Postgres.
 *
 * Contract: `docs/contracts/redirect-cache.md` (invariant 2, "The binding"),
 * `redirect-resolution.md` (invariants 1 and 3). ADR-0012, GC-O; D-2-09.
 *
 * ============================================================================
 * WHAT THIS FILE ADDS TO `test/cache/redirect-cache.int-spec.ts`, WHICH ALREADY PROVES THE
 * CACHE LAYER DEGRADES.
 * ============================================================================
 *
 * That suite proves the three failures produce `'unavailable'` at the cache's own surface.
 * This one proves the WIRING inherits it: that a visitor's `GET /:slug` still answers 302
 * with the right `Location`, that the answer comes from Postgres (the counter says so), that
 * nothing on the path turns a degraded read back into a throw or a 404, and that recovery
 * needs no restart. A redirect that 404s during a Redis outage is the specific failure
 * `'unavailable'` and `'miss'` were separated to prevent, so the pair is measured here rather
 * than reasoned about.
 *
 * The container is this suite's own, on port 56382, because it stops and pauses its server.
 */

const NAMESPACE = `it-2-07-degraded-${String(process.pid)}`;
const CONTAINER_TIMEOUT_MS = 180_000;
const TEST_TIMEOUT_MS = 120_000;
const REDIS_PORT = 56_382;

/**
 * One request against a server that is CONNECTED and never answering. The path makes at most
 * four cache calls (two reads, two write-backs), each bounded at 50 ms by `commandTimeout`,
 * plus one ordinary Postgres resolution. The budget is generous against that arithmetic
 * because it is measuring the presence of a bound, not its exact value: without
 * `commandTimeout` the first read never returns at all and the request never completes.
 */
const HUNG_REQUEST_BUDGET_MS = 1500;

let redis: ScratchRedis;
let app: INestApplication | undefined;
let port = 0;

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

/** Reset, drive one request, and report what it cost in statements. */
async function cost(path: string): Promise<{ status: number; queries: number; location?: string }> {
  dbQueryCounter.reset();

  const probe = await onPlatform(port, path);

  return {
    status: probe.status,
    queries: dbQueryCounter.read(),
    ...(probe.headers.location === undefined ? {} : { location: probe.headers.location }),
  };
}

/**
 * POLLS THE THING THE AC CLAIMS, WHICH IS THAT THE REDIRECT IS SERVED FROM THE CACHE AGAIN,
 * not that a status flag flipped. `cacheAvailable()` is `status === 'ready'`, and a client
 * that has just reconnected still has to answer a command; what recovery means here is a
 * request costing zero statements, which takes one re-warming request first.
 */
async function eventuallyServedFromCache(budgetMs: number): Promise<boolean> {
  const deadline = Date.now() + budgetMs;

  for (;;) {
    await onPlatform(port, `/${ACTIVE_SLUG}`);

    if ((await cost(`/${ACTIVE_SLUG}`)).queries === 0) {
      return true;
    }

    if (Date.now() >= deadline) {
      return false;
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

beforeAll(async () => {
  redis = startScratchRedis('2-07-degraded', REDIS_PORT);

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
    throw new Error('the client never reached `ready` against the scratch Redis; nothing below would measure a degradation');
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
 * EVERY TEST STARTS FROM A CACHE THAT IS ACTUALLY SERVING. These tests take the server away
 * on purpose; a suite that assumed recovery rather than waiting for it would bleed a
 * half-dead client into whatever ran next and fail three tests later for no visible reason.
 */
beforeEach(async () => {
  restoreRedisAvailability();
  expect(await eventually(cacheAvailable, 30_000)).toBe(true);

  redis.cli('flushall');
  dbQueryCounter.reset();
}, TEST_TIMEOUT_MS);

describe('AC-2-29: Redis is gone and the redirect keeps serving from Postgres', () => {
  it(
    'answers the same 302 from Postgres, every request, and never a 5xx',
    async () => {
      const warm = await cost(`/${ACTIVE_SLUG}`);

      expect(warm.queries).toBe(4);
      expect(await cost(`/${ACTIVE_SLUG}`)).toEqual({ status: 302, queries: 0, location: DESTINATION });

      const restore = simulateRedisUnavailable();

      try {
        // POLLED, NOT ASSUMED: `disconnect()` ends the socket and the status follows when
        // Node delivers the close.
        expect(await eventually(() => !cacheAvailable(), 20_000)).toBe(true);

        const first = await cost(`/${ACTIVE_SLUG}`);
        const second = await cost(`/${ACTIVE_SLUG}`);

        // FOUR EVERY TIME, not four and then zero: a write-back into a dead cache is a no-op,
        // so the outage costs the cold resolve per request and buys correctness with it.
        expect({ first, second }).toEqual({
          first: { status: 302, queries: 4, location: DESTINATION },
          second: { status: 302, queries: 4, location: DESTINATION },
        });
        expect(first.status).toBeLessThan(500);
      } finally {
        restore();
      }
    },
    TEST_TIMEOUT_MS,
  );

  /**
   * ============================================================================
   * THE BEHAVIOURAL SPLIT: `'miss'` ANSWERS THE REQUEST, `'unavailable'` QUERIES POSTGRES.
   * ============================================================================
   *
   * One slug, one row (none), two cache states. A cached negative answers 404 for zero
   * statements; an unavailable cache answers the SAME 404 for four, because it went and
   * looked. The 404s are identical on the wire, which is exactly why the counter is the
   * instrument: a resolver that collapsed the two values would look correct here and would
   * 404 every live link in the database for the length of an outage.
   */
  it(
    'a cached negative answers with no query, and an unavailable cache queries for the same answer',
    async () => {
      await onPlatform(port, `/${UNKNOWN_SLUG}`);

      const cachedNegative = await cost(`/${UNKNOWN_SLUG}`);
      const restore = simulateRedisUnavailable();
      let whileUnavailable;

      try {
        expect(await eventually(() => !cacheAvailable(), 20_000)).toBe(true);
        whileUnavailable = await cost(`/${UNKNOWN_SLUG}`);
      } finally {
        restore();
      }

      expect({ cachedNegative, whileUnavailable }).toEqual({
        cachedNegative: { status: 404, queries: 0 },
        whileUnavailable: { status: 404, queries: 4 },
      });
    },
    TEST_TIMEOUT_MS,
  );
});

describe('AC-2-30: a hung but connected server does not hang the visitor', () => {
  it(
    'completes from Postgres inside the command timeouts budget',
    async () => {
      await onPlatform(port, `/${ACTIVE_SLUG}`);
      expect((await cost(`/${ACTIVE_SLUG}`)).queries).toBe(0);

      // SIGSTOP: the socket stays open and the client stays `ready`, and the server will
      // never answer. Without `commandTimeout` the first read never returns.
      redis.pause();

      try {
        dbQueryCounter.reset();

        const startedAt = Date.now();
        const probe = await onPlatform(port, `/${ACTIVE_SLUG}`);
        const elapsed = Date.now() - startedAt;

        expect({
          status: probe.status,
          location: probe.headers.location,
          queries: dbQueryCounter.read(),
          withinBudget: elapsed < HUNG_REQUEST_BUDGET_MS,
          elapsed,
        }).toEqual({
          status: 302,
          location: DESTINATION,
          queries: 4,
          withinBudget: true,
          elapsed,
        });
      } finally {
        redis.unpause();
      }

      expect(await eventuallyServedFromCache(30_000)).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );
});

describe('AC-2-31: the server comes back and the redirect is fast again, with no restart', () => {
  it(
    'serves from Postgres while it is down and from the cache once it returns',
    async () => {
      await onPlatform(port, `/${ACTIVE_SLUG}`);
      expect((await cost(`/${ACTIVE_SLUG}`)).queries).toBe(0);

      // The real thing rather than the fixture: the server process goes away and the socket
      // closes. `retryStrategy` is what brings the SAME client back, which is why the
      // container is stopped rather than removed.
      redis.stopServer();

      try {
        expect(await eventually(() => !cacheAvailable(), 20_000)).toBe(true);
        expect(await cost(`/${ACTIVE_SLUG}`)).toEqual({
          status: 302,
          queries: 4,
          location: DESTINATION,
        });
      } finally {
        redis.startServer();
      }

      // No `connect()` call, no new client, no process restart: only the wait is ours.
      expect(await eventuallyServedFromCache(60_000)).toBe(true);
      expect(cacheAvailable()).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );
});

describe('a process that declared no Redis serves every redirect from Postgres (D-2-09)', () => {
  /**
   * `REDIS_URL` unset binds `UnavailableRedirectCache`, whose reads are all `'unavailable'`
   * and whose writes are no-ops, so this is the Redis outage made permanent and it must be
   * indistinguishable from an ordinary redirect except in cost. Compiled as its own module
   * graph rather than as a second HTTP application: what the binding changes is one provider,
   * and `redirect.int-spec.ts`, which runs with no Redis variables at all, is the whole
   * HTTP surface under exactly this binding already.
   */
  it('binds the degraded cache and resolves from Postgres on every request', async () => {
    const declared = process.env.REDIS_URL;

    delete process.env.REDIS_URL;

    const moduleRef = await Test.createTestingModule({ imports: [RedirectModule] }).compile();

    try {
      expect(moduleRef.get(REDIRECT_CACHE)).toBeInstanceOf(UnavailableRedirectCache);

      const service = moduleRef.get(RedirectService);

      dbQueryCounter.reset();
      const first = await service.resolve(PLATFORM_HOSTNAME, ACTIVE_SLUG, new Date());
      const firstCost = dbQueryCounter.read();

      dbQueryCounter.reset();
      const second = await service.resolve(PLATFORM_HOSTNAME, ACTIVE_SLUG, new Date());
      const secondCost = dbQueryCounter.read();

      expect({
        first: first.kind === 'redirect' ? first.location : first.kind,
        second: second.kind === 'redirect' ? second.location : second.kind,
        firstCost,
        secondCost,
      }).toEqual({
        first: DESTINATION,
        second: DESTINATION,
        firstCost: 4,
        secondCost: 4,
      });
    } finally {
      await moduleRef.close();

      if (declared !== undefined) {
        process.env.REDIS_URL = declared;
      }
    }
  });
});
