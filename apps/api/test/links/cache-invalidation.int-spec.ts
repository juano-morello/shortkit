import type { Server } from 'node:http';

import { RequestMethod } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import pg from 'pg';
import type { PoolClient } from 'pg';
import { linkContract } from '@shortkit/contracts';
import type { Link } from '@shortkit/contracts';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { runTransaction, SEED_TRANSACTIONS } from '../../scripts/seed.mts';
import { AppModule } from '../../src/app.module';
import { cacheAvailable, closeRedisClient } from '../../src/cache/redis-client';
import { LINK_MISS_TTL_S, LINK_TTL_S, REDIRECT_CACHE } from '../../src/cache/redirect-cache';
import type { CachedLink, RedirectCache } from '../../src/cache/redirect-cache';
import { closeDatabase } from '../../src/db/client';
import { PLATFORM_TENANT_ID } from '../../src/db/platform';
import {
  CACHE_INVALIDATION_FAILED_CODE,
  INVALIDATION_SECOND_PASS_DELAY_MS,
  cancelScheduledInvalidationPasses,
} from '../../src/links/cache-invalidation.subscriber';
import { logger } from '../../src/observability/logger';
import { startScratchRedis } from '../cache/scratch-redis';
import type { ScratchRedis } from '../cache/scratch-redis';
import { startApiServer } from '../support/api-server';
import type { ApiServer } from '../support/api-server';
import {
  POLICY_COMPLIANT_PASSWORD,
  authServerEnv,
  clearSignupState,
  jwtClaims,
  mintToken,
  signIn,
  signUp,
} from '../support/auth-fixture';
import { execSql } from '../support/psql';
import { appDsn, assertAppRoleCannotBypassRls, migrationDsn } from '../support/rls-fixture';

/**
 * STORY-2-04 end to end on the shipped routes and a LIVE Redis: AC-2-21 (a destination edit
 * deletes the `rdr:` key within 5 s, with the shipped TTL of 3600 s on it), AC-2-22 (a slug
 * change deletes BOTH keys), AC-2-23 (a create deletes the negative entry rather than leaving
 * the link invisible for 60 s), AC-2-24 (an expiry change and a delete), AC-2-25 (a Redis
 * that refuses writes produces the retry schedule and ONE line, and the operator's PATCH
 * still answers 200). TASK-2-08, wave 3.
 *
 * Contract: `docs/contracts/redirect-cache.md` ("Invalidation", "On failure", invariant 1),
 * `link-mutation-events.md` ("Two phases"), `logging-and-headers.md`. ADR-0008, ADR-0012;
 * D-2-15.
 *
 * ============================================================================
 * WHAT THIS FILE ASSERTS, AND WHY IT IS THE KEY AND NOT A `GET /:slug`.
 * ============================================================================
 *
 * Invalidation ships a wave AHEAD of the read-through fill: TASK-2-07 is what makes the
 * redirect read `rdr:` records at all, and it lands in wave 4. That order is the safe one and
 * the contract now says so: a cache filled before anything deletes its keys serves a
 * pre-edit record for up to an hour. The consequence for this suite is that "the redirect
 * serves the new destination within 5 s" cannot be observed through the redirect yet, so the
 * property is asserted where it is actually decided: the key Redis holds is gone, on a live
 * server, within the budget, measured. When wave 4 lands, nothing here changes meaning.
 *
 * ============================================================================
 * THE PROPAGATION FIGURE, MEASURED RATHER THAN ASSUMED.
 * ============================================================================
 *
 * `withTenantTransaction` awaits its `afterCommit` hooks before the interceptor's promise
 * settles, so the deletion has already happened when the operator's response is written.
 * MEASURED 2026-08-19 on this suite: the PATCH itself reports `duration_ms` between 4 and 16,
 * and the edit-to-key-gone round trip this file times came to 83 ms, of which 73 ms was the
 * fixture's first `docker exec redis-cli` poll rather than anything the API did. The worst
 * case in the suite is the failure test, where the exhausted retry schedule puts 1216 ms on
 * the request and the key is then deliberately still there. Every assertion below uses a
 * 5000 ms budget it does not approach, and the retry schedule is admissible precisely because
 * 200 ms plus 1000 ms still fits inside GC-2's five seconds.
 *
 * ============================================================================
 * ITS OWN REDIS CONTAINER, AND IT MUTATES THE SERVER'S CONFIGURATION.
 * ============================================================================
 *
 * AC-2-25 needs a server that is CONNECTED and REFUSES WRITES, which is
 * `min-replicas-to-write 1` on a master with no replicas: `DEL` answers `NOREPLICAS`, `GET`
 * keeps working, and the client stays `ready`. That is the one state exercising the retry rather
 * than the disconnected branch `redirect-cache.ts` short-circuits. A suite that did that to
 * the compose Redis on 56379/56380 would break every other suite sharing it, so this file
 * runs `scratch-redis.ts`'s throwaway container like `test/cache/redirect-cache.int-spec.ts`
 * does, and removes it in `afterAll`.
 */

const ADDRESS = 'wave3-invalidation-a@example.com';
const NAMESPACE = `it-inv-${String(process.pid)}`;
/** D-2-02: the seeded system default domain locally, and what the service denormalises. */
const HOSTNAME = 'localhost';
const DESTINATION = 'https://example.test/spring?utm=1';
const EDITED_DESTINATION = 'https://example.test/summer?utm=2';

/** GC-2's five seconds, as a budget for a poll rather than a sleep to wait out. */
const PROPAGATION_BUDGET_MS = 5000;

let redis: ScratchRedis;
let server: ApiServer;
let app: INestApplication | undefined;
let baseUrl: string;
let cache: RedirectCache;

let token = '';
let tenantId = '';
let workspaceId = '';

/** One slug per test, and they are unique per DOMAIN, which every link here shares. */
let testNumber = 0;

function slugFor(suffix: string): string {
  return `inv${String(testNumber)}${suffix}`;
}

/* ========================================================================== *
 * HTTP, the shape `links.int-spec.ts` uses.
 * ========================================================================== */

interface Probe {
  readonly status: number;
  readonly body: unknown;
  readonly raw: string;
}

async function api(
  path: string,
  options: { method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'; body?: unknown } = {},
): Promise<Probe> {
  const payload = options.body === undefined ? undefined : JSON.stringify(options.body);

  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      authorization: `Bearer ${token}`,
      ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(payload === undefined ? {} : { body: payload }),
  });
  const raw = await response.text();

  let body: unknown = raw;
  try {
    body = JSON.parse(raw) as unknown;
  } catch {
    /* left as the raw text */
  }

  return { status: response.status, body, raw };
}

async function createLink(body: Record<string, unknown>): Promise<Link> {
  const created = await api('/api/links', {
    method: 'POST',
    body: { workspaceId, destinationUrl: DESTINATION, ...body },
  });

  expect(created.status, created.raw).toBe(201);

  return linkContract.parse(created.body);
}

/* ========================================================================== *
 * The cache, read through the live server rather than through the port.
 * ========================================================================== */

/**
 * The key the contract fixes, built here rather than imported, so a change to `linkKey` that
 * silently moved every record shows up as a red suite rather than as a test that watches the
 * wrong key and never sees it deleted.
 */
function keyFor(slug: string): string {
  return `sk:${NAMESPACE}:rdr:v1:${HOSTNAME}:${slug}`;
}

function exists(slug: string): boolean {
  return redis.cli('exists', keyFor(slug)) === '1';
}

function ttlOf(slug: string): number {
  return Number(redis.cli('ttl', keyFor(slug)));
}

/** A positive record for `link`, written through the shipped cache so the TTL is the real one. */
async function warm(link: Link, slug = link.slug): Promise<void> {
  const record: CachedLink = {
    v: 1,
    id: link.id,
    d: link.destinationUrl,
    dm: link.domainId,
    w: link.workspaceId,
    t: tenantId,
    ea: null,
    aa: null,
  };

  await cache.setLink(HOSTNAME, slug, record);

  expect(exists(slug), `the fixture failed to warm ${slug}`).toBe(true);
}

/** The negative entry a request for an unknown slug leaves behind (60 s, ADR-0008). */
async function warmMiss(slug: string): Promise<void> {
  await cache.setLink(HOSTNAME, slug, 'miss');

  expect(exists(slug), `the fixture failed to warm the negative entry for ${slug}`).toBe(true);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Polls until the key is gone and returns how long that took. POLLED, NOT SLEPT ON: a fixed
 * sleep long enough for CI proves nothing about the five seconds, and one short enough to be
 * meaningful is a flake.
 */
async function goneWithin(slug: string, budgetMs = PROPAGATION_BUDGET_MS): Promise<number> {
  const started = Date.now();

  for (;;) {
    if (!exists(slug)) {
      return Date.now() - started;
    }

    if (Date.now() - started > budgetMs) {
      throw new Error(
        `${keyFor(slug)} still exists ${String(budgetMs)} ms after the mutation committed. ` +
          'GC-2 gives invalidation five seconds and the shipped TTL is 3600 s, so nothing ' +
          'else was going to remove it.',
      );
    }

    await sleep(25);
  }
}

/* ========================================================================== *
 * The platform seed, through the shipped units (`links.int-spec.ts`'s shape).
 * ========================================================================== */

function platformTransaction() {
  const found = SEED_TRANSACTIONS.find((transaction) => transaction.tenantId === PLATFORM_TENANT_ID);

  if (found === undefined) {
    throw new Error('scripts/seed.mts has no platform transaction; no link can be created.');
  }

  return found;
}

async function seedPlatform(): Promise<void> {
  const pool = new pg.Pool({ connectionString: appDsn() });

  try {
    const client: PoolClient = await pool.connect();

    try {
      await runTransaction(client, platformTransaction(), new Map());
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

function dropPlatformRows(): void {
  execSql(migrationDsn(), `DELETE FROM tenants WHERE id = :'tenant'::uuid;`, {
    tenantId: PLATFORM_TENANT_ID,
    flags: { 'app.privileged_erase': PLATFORM_TENANT_ID },
    variables: { tenant: PLATFORM_TENANT_ID },
  });
}

/* ========================================================================== *
 * Setup
 * ========================================================================== */

beforeAll(async () => {
  assertAppRoleCannotBypassRls();
  await seedPlatform();

  redis = startScratchRedis('2-08');

  // Read by `CacheModule`'s factory when the module below compiles, so they are set first.
  // The namespace carries the pid, which is GC-P's `ci-{run_id}` rule one scale down.
  vi.stubEnv('REDIS_URL', redis.url);
  vi.stubEnv('REDIS_KEY_NAMESPACE', NAMESPACE);

  server = await startApiServer({ env: authServerEnv });
  vi.stubEnv('BETTER_AUTH_URL', server.baseUrl);

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();

  app = moduleRef.createNestApplication({ logger: false });
  app.setGlobalPrefix('api', { exclude: [{ path: 'health', method: RequestMethod.GET }] });
  // `listen` runs the lifecycle, which is where `LinksModule` registers the invalidator.
  await app.listen(0, '127.0.0.1');
  baseUrl = await app.getUrl();
  (app.getHttpServer() as Server).keepAliveTimeout = 0;

  cache = app.get<RedirectCache>(REDIRECT_CACHE, { strict: false });

  for (let attempt = 0; attempt < 200 && !cacheAvailable(); attempt += 1) {
    await sleep(100);
  }

  expect(cacheAvailable(), 'the client never reached `ready` against the scratch Redis').toBe(true);

  // ONE principal for the file. `links.int-spec.ts` takes a fresh pair per test because it
  // signs in per test and the email-keyed bucket would refuse the sixth; this file signs in
  // ONCE and reuses the token, and its handful of writes sit well inside the tenant bucket's
  // 120 per minute.
  clearSignupState(ADDRESS);

  const signedUp = await signUp(server, ADDRESS, POLICY_COMPLIANT_PASSWORD);
  expect(signedUp.status, signedUp.raw).toBe(200);

  const signedIn = await signIn(server, ADDRESS, POLICY_COMPLIANT_PASSWORD);
  expect(signedIn.status, signedIn.raw).toBe(200);

  const minted = await mintToken(server, signedIn.cookie);
  expect(minted.status, minted.raw).toBe(200);

  token = (minted.body as { token: string }).token;
  tenantId = jwtClaims(token).tid as string;

  const workspace = await api('/api/workspaces', { method: 'POST', body: { name: 'Acme' } });
  expect(workspace.status, workspace.raw).toBe(201);
  workspaceId = (workspace.body as { id: string }).id;
}, 300_000);

beforeEach(() => {
  testNumber += 1;
  redis.cli('flushall');
});

afterEach(() => {
  vi.restoreAllMocks();
  // The delayed second deletion (TASK-2-07's stale-set mitigation) is scheduled a second after
  // every successful invalidation. Left pending, one test's pass fires inside the next one,
  // where AC-2-25 has deliberately configured the server to refuse writes, and writes a
  // failure line into that test's `toHaveBeenCalledOnce`. The test that MEASURES the pass
  // waits for it inside its own body.
  cancelScheduledInvalidationPasses();
  // Whatever a test did to the server's configuration, the next one starts from a Redis that
  // accepts writes. `config set` is idempotent and cheap; leaving it to a test's own cleanup
  // is how one failed assertion takes the rest of the file down with it.
  redis.cli('config', 'set', 'min-replicas-to-write', '0');
});

afterAll(async () => {
  cancelScheduledInvalidationPasses();
  await app?.close();
  await closeRedisClient();
  await closeDatabase();
  redis?.stop();
  vi.unstubAllEnvs();
  clearSignupState(ADDRESS);
  dropPlatformRows();
  await server?.stop();
});

/* ========================================================================== *
 * The invalidation table, on a live server
 * ========================================================================== */

describe('AC-2-21: a destination edit deletes the rdr key, with the shipped TTL on it', () => {
  it('the warm record carries TTL 3600 and is gone within 5 s of the commit', async () => {
    const link = await createLink({ slug: slugFor('dest') });

    await warm(link);

    // THE TTL IS THE POINT OF THIS ASSERTION. `LINK_TTL_S` is 3600 in every environment,
    // tests included (ADR-0008: there is no test TTL to drift from production), so nothing
    // below could be explained by expiry. If this suite ever passes with a small TTL here,
    // it has stopped testing invalidation.
    expect(ttlOf(link.slug)).toBeGreaterThan(LINK_TTL_S - 60);
    expect(ttlOf(link.slug)).toBeLessThanOrEqual(LINK_TTL_S);

    const started = Date.now();
    const edited = await api(`/api/links/${link.id}`, {
      method: 'PATCH',
      body: { destinationUrl: EDITED_DESTINATION },
    });

    expect(edited.status, edited.raw).toBe(200);
    expect(linkContract.parse(edited.body).destinationUrl).toBe(EDITED_DESTINATION);

    await goneWithin(link.slug);

    // The whole round trip, not only the poll: the hook runs inside the request, so this is
    // the operator-visible propagation delay. Measured at 83 ms locally, and 73 ms of that
    // was this fixture's first `docker exec` (see the header).
    expect(Date.now() - started).toBeLessThan(PROPAGATION_BUDGET_MS);
  }, 120_000);

  it('a no-op PATCH invalidates too: the invalidator does not skip what the audit writer would', async () => {
    const link = await createLink({ slug: slugFor('noop') });

    await warm(link);

    const edited = await api(`/api/links/${link.id}`, {
      method: 'PATCH',
      body: { destinationUrl: link.destinationUrl },
    });

    expect(edited.status, edited.raw).toBe(200);
    await goneWithin(link.slug);
  }, 120_000);
});

/**
 * ============================================================================
 * THE STALE SET RACE, ON A LIVE SERVER (TASK-2-07 review).
 * ============================================================================
 *
 * A redirect that read the pre-edit row before the commit writes it into Redis AFTER this
 * subscriber deleted the key. Nothing on the read path corrects it, so without the delayed
 * second deletion the record serves with a fresh 3600 s TTL, on the one surface with no rate
 * limit. The fill below stands in for that redirect, and it is written through the SHIPPED
 * cache with the shipped TTL, so what the second pass removes is a real record and not a
 * marker.
 */
describe('the delayed second deletion sweeps a fill that landed after the first', () => {
  it('removes a record written between the two deletions, within the budget', async () => {
    const link = await createLink({ slug: slugFor('race') });

    await warm(link);
    // THE CREATE SCHEDULED A PASS OF ITS OWN (delete-on-create is a mutation like any other),
    // and it would remove the fill below on its own schedule. Dropped, so the only sweep that
    // can explain the assertion is the edit's.
    cancelScheduledInvalidationPasses();

    const edited = await api(`/api/links/${link.id}`, {
      method: 'PATCH',
      body: { destinationUrl: EDITED_DESTINATION },
    });

    expect(edited.status, edited.raw).toBe(200);
    // The first pass runs inside the request, so the key is already gone here.
    expect(exists(link.slug)).toBe(false);

    // The racing redirect finally writes what it read before the commit.
    await warm(link);
    expect(ttlOf(link.slug)).toBeGreaterThan(LINK_TTL_S - 60);

    const started = Date.now();

    await goneWithin(link.slug);

    const elapsed = Date.now() - started;

    // IT WAS THE SECOND PASS. The key was present after the first deletion and after the
    // fill, and it went away most of a second later rather than instantly, which nothing else
    // in this process was going to do before the 3600 s TTL.
    expect(elapsed).toBeGreaterThan(INVALIDATION_SECOND_PASS_DELAY_MS / 2);
    expect(elapsed).toBeLessThan(PROPAGATION_BUDGET_MS);
  }, 120_000);

  /**
   * The residual, measured rather than described: a fill that lands after the second pass
   * survives it, and the TTL is the only bound left. `redirect-cache.md` says so under
   * "Invalidation"; this is the assertion behind the sentence.
   */
  it('does not sweep a fill that lands after the second pass', async () => {
    const link = await createLink({ slug: slugFor('late') });

    await warm(link);
    cancelScheduledInvalidationPasses();

    const edited = await api(`/api/links/${link.id}`, {
      method: 'PATCH',
      body: { destinationUrl: EDITED_DESTINATION },
    });

    expect(edited.status, edited.raw).toBe(200);

    // Past the schedule, then fill: nothing is coming to remove this one.
    await sleep(INVALIDATION_SECOND_PASS_DELAY_MS + 500);
    await warm(link);
    await sleep(INVALIDATION_SECOND_PASS_DELAY_MS + 500);

    expect(exists(link.slug)).toBe(true);
  }, 120_000);
});

describe('AC-2-22: a slug change deletes BOTH keys', () => {
  it('the old key and the new key are both gone within 5 s', async () => {
    const link = await createLink({ slug: slugFor('old') });
    const moved = slugFor('new');

    // Both sides are warm: the old slug holds the record a visitor's URL resolves through,
    // and the new one holds the negative entry a request for it left while it was unknown.
    // Deleting only one of the two is the failure this test exists for, and it is the shape
    // an implementation that keys on `after` alone produces.
    await warm(link);
    await warmMiss(moved);

    const edited = await api(`/api/links/${link.id}`, { method: 'PATCH', body: { slug: moved } });

    expect(edited.status, edited.raw).toBe(200);
    expect(linkContract.parse(edited.body).slug).toBe(moved);

    await goneWithin(link.slug);
    await goneWithin(moved);
  }, 120_000);
});

describe('AC-2-23: a create deletes the negative entry a scan left behind', () => {
  it('the 60 s miss sentinel is gone within 5 s of the create, not after 60', async () => {
    const slug = slugFor('neg');

    await warmMiss(slug);

    // The entry that would otherwise decide the next 60 seconds. Asserted before the create
    // so a fixture that never wrote it cannot make the deletion look successful.
    expect(ttlOf(slug)).toBeGreaterThan(LINK_MISS_TTL_S - 30);

    const started = Date.now();
    const link = await createLink({ slug });

    expect(link.slug).toBe(slug);
    await goneWithin(slug);
    expect(Date.now() - started).toBeLessThan(PROPAGATION_BUDGET_MS);
  }, 120_000);
});

describe('AC-2-24: the expiry-change and delete rows of the table', () => {
  it('an expiry moved into the past deletes the key', async () => {
    const link = await createLink({ slug: slugFor('exp') });

    await warm(link);

    const edited = await api(`/api/links/${link.id}`, {
      method: 'PATCH',
      body: { expiresAt: new Date(Date.now() - 60_000).toISOString() },
    });

    expect(edited.status, edited.raw).toBe(200);
    await goneWithin(link.slug);
  }, 120_000);

  it('a delete deletes the key of the row it removed', async () => {
    const link = await createLink({ slug: slugFor('del') });

    await warm(link);

    const removed = await api(`/api/links/${link.id}`, { method: 'DELETE' });

    expect(removed.status, removed.raw).toBe(200);
    await goneWithin(link.slug);
  }, 120_000);
});

/* ========================================================================== *
 * AC-2-25: the failure path, against a server that refuses writes
 * ========================================================================== */

describe('AC-2-25: a Redis that refuses writes retries, logs once, and never reaches the caller', () => {
  it('the PATCH answers 200, the line carries link_id and attempts, and no key or slug is on it', async () => {
    const link = await createLink({ slug: slugFor('fail') });

    await warm(link);
    // The CREATE's delayed second pass is dropped before the server is made to refuse writes.
    // Left pending it would fire inside the 1.2 s this PATCH spends on its retry schedule,
    // fail against that configuration, and write a second `cache_invalidation_failed` line
    // about a different mutation into the assertion below. The failing-second-pass line has
    // its own test in `cache-invalidation.subscriber.spec.ts`.
    cancelScheduledInvalidationPasses();

    const error = vi.spyOn(logger, 'error').mockReturnValue(undefined);

    // CONNECTED AND REFUSING WRITES, which is the state the retry was designed for: `DEL`
    // answers `NOREPLICAS`, the socket stays up, and `redirect-cache.ts`'s
    // `status !== 'ready'` short-circuit is NOT what produces the rejection.
    redis.cli('config', 'set', 'min-replicas-to-write', '1');

    const started = Date.now();
    const edited = await api(`/api/links/${link.id}`, {
      method: 'PATCH',
      body: { destinationUrl: EDITED_DESTINATION },
    });
    const elapsed = Date.now() - started;

    // INVARIANT 5: a Redis outage may not turn a successful PATCH into a 500. The row is
    // committed and the body is the edited link.
    expect(edited.status, edited.raw).toBe(200);
    expect(linkContract.parse(edited.body).destinationUrl).toBe(EDITED_DESTINATION);

    // The schedule was actually waited out: 200 ms + 1000 ms of delay sit inside the request,
    // which is why the two delays have to fit inside GC-2's five seconds.
    expect(elapsed).toBeGreaterThanOrEqual(1200);

    const records = error.mock.calls
      .map(([record]) => record)
      .filter(
        (record): record is Record<string, unknown> =>
          typeof record === 'object' &&
          record !== null &&
          (record as { code?: unknown }).code === CACHE_INVALIDATION_FAILED_CODE,
      );

    expect(records).toEqual([
      { code: CACHE_INVALIDATION_FAILED_CODE, link_id: link.id, attempts: 3 },
    ]);

    // GC-G on the bytes of every line the mutation produced, not only the fields of the one
    // this subscriber wrote: the dispatcher's own `link_mutation_subscriber_failed` line is
    // built from the rethrown error, whose message is `redirect-cache.ts`'s and carries no
    // key by construction.
    const emitted = error.mock.calls.map((call) => JSON.stringify(call)).join('\n');

    expect(emitted).not.toContain(link.slug);
    expect(emitted).not.toContain(HOSTNAME);
    expect(emitted).not.toContain(EDITED_DESTINATION);
    expect(emitted).not.toContain('rdr:v1');

    // THE ACCEPTED GAP, ASSERTED SO IT IS NOT A SURPRISE (ADR-0008): the key survived, so the
    // redirect may serve the pre-edit record until the TTL runs out, and the line above is
    // the only signal an operator gets.
    expect(exists(link.slug)).toBe(true);
  }, 120_000);
});
