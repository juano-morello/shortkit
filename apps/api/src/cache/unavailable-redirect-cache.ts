/**
 * Contract: docs/contracts/redirect-cache.md ("Interface"; `'unavailable'` never causes a 404)
 * ADR: adr-0012 (one failure posture), D-2-09 (absence binds the degraded cache, loudly)
 * Produced by: TASK-2-03 (item 2, wave 1).
 * Bound by: `cache.module.ts` when `REDIS_URL` is unset.
 *
 * THE BINDING FOR A DEPLOYMENT THAT DECLARED NO REDIS. Every read answers `'unavailable'`,
 * so the redirect resolves from Postgres exactly as it does during an outage; every write
 * and every deletion is a no-op that resolves.
 *
 * NOTE THE ONE DIFFERENCE FROM `RedisRedirectCache`: a deletion here RESOLVES rather than
 * rejecting. There is no cache to hold a stale key, so the invalidation TASK-2-08 performs
 * has genuinely succeeded — retrying it, or logging `cache_invalidation_failed` on a
 * deployment that never had a cache, would be a per-mutation error line reporting a
 * condition that is not a failure. The loud part is the ONE boot warn line
 * (`boot_precondition: 'redirect_cache'`, `redis-client.ts`), which is the MAIL_TRANSPORT
 * posture: absence lands on the thing that can do no harm, and says so once.
 */
import type { CachedHost, CachedLink, RedirectCache } from './redirect-cache';

export class UnavailableRedirectCache implements RedirectCache {
  async getHost(_hostname: string): Promise<CachedHost | 'miss' | 'unavailable'> {
    return 'unavailable';
  }

  async setHost(_hostname: string, _value: CachedHost | 'miss'): Promise<void> {
    return undefined;
  }

  async delHost(_hostname: string): Promise<void> {
    return undefined;
  }

  async getLink(_hostname: string, _slug: string): Promise<CachedLink | 'miss' | 'unavailable'> {
    return 'unavailable';
  }

  async setLink(_hostname: string, _slug: string, _value: CachedLink | 'miss'): Promise<void> {
    return undefined;
  }

  async delLink(_hostname: string, _slug: string): Promise<void> {
    return undefined;
  }
}
