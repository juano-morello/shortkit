/**
 * Deletes every redirect-cache key this run owns, so a test starts against Postgres.
 *
 * Contract: docs/contracts/redirect-cache.md ("Keys", "Namespacing")
 * ADR: adr-0008-redirect-cache-shape.md, adr-0012-redis-client-and-rate-limit-degradation.md
 * Produced by: the CI repair after item 2's first integration run on a runner
 *
 * ============================================================================
 * WHY THIS EXISTS, AND WHY THE SPECS THAT CALL IT DID NOT NEED IT WHEN THEY WERE WRITTEN
 * ============================================================================
 *
 * `test/redirect/redirect.int-spec.ts` was written in wave 3, against a redirect that read
 * Postgres on every request, and its header says so in as many words: "the cache arrives in
 * TASK-2-07 (wave 4) in front of the same decision". TASK-2-07 landed that cache and nobody
 * revisited the spec. Its assertions still describe a cold path: a resolution costs exactly
 * four statements, a saturated pool answers 404, a link seeded mid-file answers 302.
 *
 * With no `REDIS_URL` exported, all three hold by accident: `redisClient` binds nothing, the
 * cache answers `unavailable` to every read, and every resolution reaches the database. That
 * is the condition the suite was verified under locally. CI binds a real Redis, and on the
 * first integration run against a runner the same five assertions failed: 0 statements where
 * 4 were expected, 302 from cache where the saturated pool should have answered 404, a
 * cached MISS sentinel answering 404 where a newly seeded link should have answered 302, and
 * a click row written under the tenant of a cached record rather than the tenant of the
 * request.
 *
 * The repair is to make the premise TRUE rather than absent: each test starts cold, and each
 * assertion measures the path its name claims. Cache behaviour itself is not this helper's
 * subject and stays where it is measured on purpose, in `test/cache/redirect-cache.int-spec.ts`
 * and `test/links/cache-invalidation.int-spec.ts`, both of which drive a scratch Redis.
 *
 * ============================================================================
 * SCOPE
 * ============================================================================
 *
 * `sk:{namespace}:*` and nothing wider. The namespace is `ci-<run_id>` in CI and `test`
 * locally (`redirect-cache.md`'s collision rule), so this deletes keys belonging to this run
 * and cannot reach another job's, a developer's `dev`, or anything named `prod`. A `FLUSHDB`
 * would reach all of them and is never the right instrument here.
 *
 * With no binding declared it does nothing and says nothing: there is no cache to clear, the
 * reads answer `unavailable`, and the caller's premise already holds.
 *
 * ============================================================================
 * WHY IT WAITS FOR `ready` INSTEAD OF ISSUING A COMMAND AND HOPING
 * ============================================================================
 *
 * `REDIS_CLIENT_OPTIONS` sets `enableOfflineQueue: false` (ADR-0012): a command issued
 * before the socket is up is REJECTED rather than queued, which is the posture that lets a
 * redirect degrade instead of hanging. The client connects eagerly but not instantly, and
 * the first `beforeEach` runs before any request has forced a connection, so `keys()` on a
 * connecting client throws "Stream isn't writeable" and takes the test with it. Measured:
 * every test in both files failed that way before this wait existed.
 *
 * So it waits for the event, bounded, and treats a client that never becomes ready as the
 * absent-binding case: nothing is cached, because a client that cannot connect cannot have
 * written anything, and the reads the caller is about to make answer `unavailable`.
 */
import type Redis from 'ioredis';

import { readRedisBinding, redisClient } from '../../src/cache/redis-client';

/** How long to wait for a client that is still connecting. Beyond it there is no cache. */
const READY_TIMEOUT_MS = 2_000;

async function waitUntilReady(client: Redis): Promise<void> {
  if (client.status === 'ready') {
    return;
  }

  await new Promise<void>((resolve) => {
    const settle = (): void => {
      clearTimeout(timer);
      client.off('ready', settle);
      resolve();
    };

    const timer = setTimeout(settle, READY_TIMEOUT_MS);
    client.once('ready', settle);
  });
}

/** Every key under this run's namespace, deleted. A no-op when no cache is reachable. */
export async function clearRedirectCache(): Promise<void> {
  const binding = readRedisBinding(process.env);

  if (binding === undefined) {
    return;
  }

  const client = redisClient(binding);
  await waitUntilReady(client);

  if (client.status !== 'ready') {
    return;
  }

  const keys = await client.keys(`sk:${binding.namespace}:*`);

  if (keys.length > 0) {
    await client.del(...keys);
  }
}
