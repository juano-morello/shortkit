/**
 * Contract: design/contracts/redirect-cache.md
 * ADR: adr-0008-redirect-cache-shape.md, adr-0009-expiry-eviction.md, adr-0012
 * Produced by: TASK-030
 * Consumed by: TASK-027, 031, 032, 034, 045, 046; redisClient reused by TASK-051
 */
import type Redis from 'ioredis';

export const CACHE_VERSION = 'v1' as const;

/** Bump this for ANY change to CachedHost or CachedLink. Old keys expire on their own. */
export function hostKey(normalisedHostname: string): string {
  return `hst:${CACHE_VERSION}:${normalisedHostname}`;
}

export function linkKey(normalisedHostname: string, slug: string): string {
  return `rdr:${CACHE_VERSION}:${normalisedHostname}:${slug}`;
}

export interface CachedHost {
  v: 1;
  dm: string; // domainId
  t: string; // tenantId
  w: string; // workspaceId
  b: { lg: string | null; bc: string | null; fb: string | null } | null; // branding
}

export interface CachedLink {
  v: 1;
  id: string;
  d: string; // destinationUrl
  dm: string; // domainId
  w: string; // workspaceId
  /** Lets the click writer open a tenant transaction with no lookup. Keeps GC-5 intact. */
  t: string; // tenantId
  ea: number | null; // expiresAt   epoch ms
  aa: number | null; // activatesAt epoch ms
}

/** Single NUL byte. A GET returning this is a cached negative and answers the request. */
export const MISS_SENTINEL = '\u0000';

export const HOST_TTL_S = 300;
export const HOST_MISS_TTL_S = 300;
/** Production value, used in tests too. SC-3 requires the test to pass at one hour. */
export const LINK_TTL_S = 3600;
export const LINK_MISS_TTL_S = 60;

/**
 * Memory and cost hygiene, NOT the correctness mechanism for expiry.
 * Correctness is isLinkActive() evaluated on every read (ADR-0009).
 */
export function linkTtlSeconds(_link: CachedLink, _nowEpochMs: number): number {
  throw new Error('not implemented');
}

/**
 * 'unavailable' is DISTINCT from 'miss'.
 *   'miss'        -> a cached negative; answers the request with the not-found path
 *   'unavailable' -> Redis failed; the caller MUST query Postgres (AC-52, AC-53)
 * Collapsing the two returns a 404 during a Redis outage and breaks AC-52.
 */
export type CacheRead<T> = T | 'miss' | 'unavailable';

export interface RedirectCache {
  getHost(hostname: string): Promise<CacheRead<CachedHost>>;
  setHost(hostname: string, value: CachedHost | 'miss'): Promise<void>;
  delHost(hostname: string): Promise<void>;

  getLink(hostname: string, slug: string): Promise<CacheRead<CachedLink>>;
  setLink(hostname: string, slug: string, value: CachedLink | 'miss'): Promise<void>;
  delLink(hostname: string, slug: string): Promise<void>;
}

/**
 * ADR-0012. Every option earns its place against an AC:
 *   enableOfflineQueue: false -> reject immediately while disconnected (AC-52, AC-53)
 *   commandTimeout: 50        -> bound a hung-but-connected Redis (TASK-032)
 *   retryStrategy             -> reconnect without a restart (AC-54)
 *
 * ONE client. TASK-051 reuses it; it does not open a second connection (GC-3).
 */
export function createRedisClient(_url: string): Redis {
  throw new Error('not implemented');
}

/** Increments on every Postgres query issued by the redirect path. AC-49, AC-54. */
export interface DbQueryCounter {
  increment(): void;
  readonly count: number;
  reset(): void;
}
