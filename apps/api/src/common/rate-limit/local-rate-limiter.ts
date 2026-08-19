/**
 * Contract: `docs/contracts/rate-limit.md` ("Behaviour when Redis is unavailable": two maps,
 *           two key spaces; "`LocalAuthRateLimiter` is bounded, per bucket": F-028's rules)
 * ADR: adr-0012 (the local bucket is the degradation floor, not a stand-in), adr-0040
 * Produced by: TASK-1b-07 (wave 1 of item 1b). Bound to `RATE_LIMIT_PORT` in
 *              `rate-limit.module.ts`. Debt sweep D1 (2026-08-19) added `checkTenant` with
 *              its own map. TASK-051 binds the Redis implementation to the same token,
 *              keeping this one as the fallback.
 *
 * ============================================================================
 * THE SAME ALGORITHM AS `LocalAuthRateLimiter`, DELIBERATELY NOT THAT CLASS.
 * ============================================================================
 *
 * The auth surface's limiter (`auth/auth-rate-limit.ts`) is typed over its own bucket table —
 * `signInPerIp`, `signUpPerIp`, `otherPerIp` — and those buckets are the auth surface's
 * (`rate-limit.md`, "Ownership and injection order"). This class holds the `@Public()` IP
 * map the contract lists under "Behaviour when Redis is unavailable" as `LocalRateLimiter`,
 * a sibling with its own key space (F-034). The algorithm is copied rather than shared
 * through inheritance because the two ports differ in shape (`check` throws a refusal, this
 * one returns a decision) and TASK-051 rebinds them separately; the one thing imported is
 * `LOCAL_AUTH_LIMITER_SWEEP_MS`, so the two sweep on the same cadence the contract names.
 *
 * Fixed windows aligned to the epoch, TWO maps with disjoint key spaces (F-034):
 *
 *   - `publicIps`, the `@Public()` bucket, bounded by F-028's three rules below;
 *   - `tenants`, the tenant-keyed write bucket (debt sweep D1), a PLAIN LRU capped at
 *     `LOCAL_LIMITER_MAX_TENANTS`, swept on the same cadence. Its keys are produced only by
 *     authenticated callers, so F-028's churn defences (eviction that skips at-or-over-limit
 *     entries, the forced-eviction counter) are deliberately absent there — the contract
 *     states the rule ("`checkTenant` keeps its plain LRU ... its keys require
 *     authentication, so F-028's extra rules are unnecessary there"). Keeping the maps
 *     separate is what stops anonymous address churn evicting a tenant's write bucket.
 *
 * The `@Public()` IP map is bounded by F-028's three rules:
 *
 *   - entries whose window has elapsed are dead: dropped lazily on access and by a sweep
 *     every `LOCAL_AUTH_LIMITER_SWEEP_MS`;
 *   - at the cap, eviction takes the least recently used entry that is UNDER its limit. That
 *     order closes the bypass the cap would otherwise open: an attacker who has exhausted an
 *     address's allowance could churn 10,000 fresh addresses to evict that entry and reset
 *     its count. Skipping at-or-over-limit entries makes the attack require 10,000
 *     SIMULTANEOUSLY LIMITED addresses;
 *   - if every entry is at its limit and the cap is reached, the oldest is evicted anyway,
 *     counted on `local_rate_limit_forced_eviction_total` and warned. Memory is bounded
 *     absolutely; failing closed for new addresses instead would let an attacker lock out
 *     every new user.
 *
 * NO PATH LOGS A PRINCIPAL. A client IP is a raw IP and is not in `LOGGABLE_FIELDS`; the one
 * warn line carries `msg` and nothing else. The counter is carried in `msg` because there is
 * no metrics pipeline to increment yet.
 *
 * The sweep timer is `unref()`ed so an idle process — or a unit suite that compiled
 * `AppModule` — is not held open by it, and `onModuleDestroy` clears it when Nest closes the
 * container. There is no constructor argument, deliberately: Nest instantiates this class for
 * the token, and a clock parameter would be read as an injection.
 */
import { Injectable } from '@nestjs/common';
import type { OnModuleDestroy } from '@nestjs/common';

import { LOCAL_AUTH_LIMITER_SWEEP_MS } from '../../auth/auth-rate-limit';
import { logger } from '../../observability/logger';
import {
  LOCAL_LIMITER_MAX_PUBLIC_IPS,
  LOCAL_LIMITER_MAX_TENANTS,
  PUBLIC_IP_LIMIT,
  PUBLIC_IP_WINDOW_S,
  RATE_LIMIT_MAX_WRITES,
  RATE_LIMIT_WINDOW_S,
} from './rate-limit.types';
import type { RateLimitDecision, RateLimitPort } from './rate-limit.types';

const LOCAL_FORCED_EVICTION_COUNTER = 'local_rate_limit_forced_eviction_total';

const MILLISECONDS_PER_SECOND = 1000;

const PUBLIC_IP_WINDOW_MS = PUBLIC_IP_WINDOW_S * MILLISECONDS_PER_SECOND;

const TENANT_WINDOW_MS = RATE_LIMIT_WINDOW_S * MILLISECONDS_PER_SECOND;

interface Entry {
  /** The fixed window this count belongs to, as its start in epoch milliseconds. */
  windowStart: number;
  count: number;
}

@Injectable()
export class LocalRateLimiter implements RateLimitPort, OnModuleDestroy {
  /** LRU order is `Map` insertion order, maintained by deleting and re-inserting on every hit. */
  private readonly publicIps = new Map<string, Entry>();

  /** The tenant-keyed write bucket's map. SEPARATE from `publicIps` (F-034); plain LRU. */
  private readonly tenants = new Map<string, Entry>();

  private readonly sweep: NodeJS.Timeout;

  constructor() {
    this.sweep = setInterval(() => {
      this.sweepExpired(Date.now());
    }, LOCAL_AUTH_LIMITER_SWEEP_MS);
    this.sweep.unref();
  }

  async checkPublicIp(clientIp: string): Promise<RateLimitDecision> {
    const now = Date.now();
    const windowStart = Math.floor(now / PUBLIC_IP_WINDOW_MS) * PUBLIC_IP_WINDOW_MS;

    let entry = this.publicIps.get(clientIp);

    if (entry !== undefined) {
      this.publicIps.delete(clientIp);

      if (entry.windowStart !== windowStart) {
        entry = undefined;
      }
    }

    if (entry === undefined) {
      if (this.publicIps.size >= LOCAL_LIMITER_MAX_PUBLIC_IPS) {
        evictOne(this.publicIps);
      }

      entry = { windowStart, count: 0 };
    }

    entry.count += 1;
    this.publicIps.set(clientIp, entry);

    if (entry.count > PUBLIC_IP_LIMIT) {
      const remaining = (windowStart + PUBLIC_IP_WINDOW_MS - now) / MILLISECONDS_PER_SECOND;

      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(remaining)) };
    }

    return { allowed: true };
  }

  async checkTenant(tenantId: string): Promise<RateLimitDecision> {
    const now = Date.now();
    const windowStart = Math.floor(now / TENANT_WINDOW_MS) * TENANT_WINDOW_MS;

    let entry = this.tenants.get(tenantId);

    if (entry !== undefined) {
      this.tenants.delete(tenantId);

      if (entry.windowStart !== windowStart) {
        entry = undefined;
      }
    }

    if (entry === undefined) {
      if (this.tenants.size >= LOCAL_LIMITER_MAX_TENANTS) {
        // Plain LRU, no skip rules and no counter: see the docblock. The oldest entry goes,
        // exhausted or not, because reaching this line takes 10,000 authenticated tenants.
        const oldest = this.tenants.keys().next();

        if (!oldest.done) {
          this.tenants.delete(oldest.value);
        }
      }

      entry = { windowStart, count: 0 };
    }

    entry.count += 1;
    this.tenants.set(tenantId, entry);

    if (entry.count > RATE_LIMIT_MAX_WRITES) {
      const remaining = (windowStart + TENANT_WINDOW_MS - now) / MILLISECONDS_PER_SECOND;

      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(remaining)) };
    }

    return { allowed: true };
  }

  /** How many addresses the IP map currently holds. For the spec's bounding assertions. */
  size(): number {
    return this.publicIps.size;
  }

  /** How many tenants the tenant map currently holds. For the spec's bounding assertions. */
  tenantSize(): number {
    return this.tenants.size;
  }

  onModuleDestroy(): void {
    clearInterval(this.sweep);
  }

  private sweepExpired(now: number): void {
    for (const [key, entry] of this.publicIps) {
      if (entry.windowStart + PUBLIC_IP_WINDOW_MS <= now) {
        this.publicIps.delete(key);
      }
    }

    for (const [key, entry] of this.tenants) {
      if (entry.windowStart + TENANT_WINDOW_MS <= now) {
        this.tenants.delete(key);
      }
    }
  }
}

/**
 * Removes one entry from the full map: the least recently used entry under its limit, or —
 * when every entry is at or over the limit — the least recently used entry outright, with the
 * forced eviction counted and warned. No key is on the line: it is a client IP.
 */
function evictOne(entries: Map<string, Entry>): void {
  for (const [key, entry] of entries) {
    if (entry.count < PUBLIC_IP_LIMIT) {
      entries.delete(key);
      return;
    }
  }

  const oldest = entries.keys().next();

  if (!oldest.done) {
    entries.delete(oldest.value);
    logger.warn(
      `${LOCAL_FORCED_EVICTION_COUNTER}: the @Public() rate-limit map reached ` +
        `${String(LOCAL_LIMITER_MAX_PUBLIC_IPS)} addresses with every entry at its limit, ` +
        'and the oldest was evicted to admit a new one (docs/contracts/rate-limit.md, F-028). ' +
        'The limiter is under pressure.',
    );
  }
}
