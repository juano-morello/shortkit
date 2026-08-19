/**
 * Contract: docs/contracts/redirect-cache.md ("Interface"; the binding rules)
 * ADR: adr-0012 (one client, one failure posture), D-2-09 (presence is a declared binding,
 *      absence binds the degraded cache loudly)
 * Produced by: TASK-2-03 (item 2, wave 1).
 * Consumed by: TASK-2-06's `RedirectModule` and TASK-2-08's invalidation subscriber, which
 *              import this module and inject `@Inject(REDIRECT_CACHE) cache: RedirectCache`.
 *              `AppModule` is not this card's file (GC-C wave separation), so the import
 *              lands with the card that first needs the token.
 *
 * ONE PROVIDER, ONE EXPORT — `MailModule`'s shape, for the same reasons. The factory runs
 * when the module compiles rather than when this file is imported, so `AppModule` can be
 * compiled in the unit tier with no Redis variables set (it resolves to
 * `UnavailableRedirectCache`), and the environment is read at `NestFactory.create`, after
 * `assertBootPreconditions()` has already refused a malformed URL or a missing namespace in
 * `main.ts`.
 *
 * `redirectCacheFor` is exported so the specs can drive the selection with an explicit
 * environment; shipped code calls it with `process.env` and nowhere else.
 *
 * THE ONLY FILE THAT NAMES `redisClient`. ADR-0012's single client is reached here and
 * handed to `RedisRedirectCache` as the three-command structural interface; nothing
 * downstream holds the client, so the limiters and the revocation store cannot quietly
 * acquire a second failure posture (D-2-01 deferred their rebind, and that deferral is
 * enforced by the scan in `redis-client.spec.ts`, not by memory).
 */
import { Module } from '@nestjs/common';

import { readRedisBinding, redisClient } from './redis-client';
import { REDIRECT_CACHE, RedisRedirectCache } from './redirect-cache';
import type { RedirectCache } from './redirect-cache';
import { UnavailableRedirectCache } from './unavailable-redirect-cache';

/**
 * The bound cache for an environment. `readRedisBinding` throws on a declared-but-malformed
 * binding rather than returning `undefined`, so a module compiled without `main.ts`'s
 * assertion (a testing module) still cannot turn a typo into a silently degraded redirect —
 * the `resolveMailTransport` rule.
 */
export function redirectCacheFor(env: NodeJS.ProcessEnv): RedirectCache {
  const binding = readRedisBinding(env);

  return binding === undefined
    ? new UnavailableRedirectCache()
    : new RedisRedirectCache(redisClient(binding), binding.namespace);
}

@Module({
  providers: [{ provide: REDIRECT_CACHE, useFactory: (): RedirectCache => redirectCacheFor(process.env) }],
  exports: [REDIRECT_CACHE],
})
export class CacheModule {}
