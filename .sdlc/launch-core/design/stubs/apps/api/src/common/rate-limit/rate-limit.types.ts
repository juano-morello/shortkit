/**
 * Contract: design/contracts/rate-limit.md
 * ADR: adr-0012-redis-client-and-rate-limit-degradation.md, adr-0006
 * Produced by: TASK-051
 * Consumed by: TASK-052, TASK-056
 */

export const RATE_LIMIT_WINDOW_S = 60;
export const RATE_LIMIT_MAX_WRITES = 120;

/**
 * Keyed by TENANT, never a global bucket (AC-84).
 * Fixed window: up to 240 writes can land across a window boundary. Documented,
 * not fixed; a sliding window buys precision nobody measures.
 */
export function rateLimitKey(tenantId: string, nowEpochS: number): string {
  return `rl:v1:${tenantId}:${Math.floor(nowEpochS / RATE_LIMIT_WINDOW_S)}`;
}

export interface RateLimitDecision {
  readonly allowed: boolean;
  readonly remaining: number;
  /** Delta-seconds, at least 1. Sent as the Retry-After header. */
  readonly retryAfterSeconds: number;
  /** True when the decision came from the local fallback because Redis failed. */
  readonly degraded: boolean;
}

export interface RateLimiter {
  check(tenantId: string): Promise<RateLimitDecision>;
}

/**
 * In-process token bucket. Same limit, same window. LRU-capped at 10,000 tenants.
 *
 * NEITHER fail-open NOR fail-closed: on a Redis error or a 50 ms timeout, the limit
 * STILL APPLIES, per machine instead of per fleet.
 *
 * ACCEPTED GAP: with N machines the degraded limit is N * RATE_LIMIT_MAX_WRITES.
 * Fly runs one machine at launch. Revisit before enabling more.
 */
export interface LocalRateLimiter {
  check(tenantId: string): RateLimitDecision;
}

export const LOCAL_LIMITER_MAX_TENANTS = 10_000;

/** INCR then EXPIRE, atomically. */
export const RATE_LIMIT_LUA = `
local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
return n
`;

/**
 * Applies to POST, PATCH, PUT, DELETE under the /api prefix.
 *
 * NOT applied to: GET and HEAD; @Public() routes; GET /health; and the redirect
 * controller, which is registered OUTSIDE the /api prefix and therefore outside this
 * guard entirely (AC-86). Redirect traffic is never limited at any rate.
 *
 * Ordering: after AuthGuard (needs tenantId), before TenantTransactionInterceptor
 * (a rejected request must not open a transaction).
 */
export declare class RateLimitGuard {
  canActivate(context: unknown): Promise<boolean>;
}
