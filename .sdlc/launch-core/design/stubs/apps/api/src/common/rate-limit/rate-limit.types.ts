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
 *
 * F-015: every key carries an environment segment. See redirect-cache.md.
 */
export function rateLimitKey(env: string, tenantId: string, nowEpochS: number): string {
  return `sk:${env}:rl:v1:${tenantId}:${Math.floor(nowEpochS / RATE_LIMIT_WINDOW_S)}`;
}

/**
 * ============================================================================
 * F-004. /api/auth/* is NOT covered by RateLimitGuard.
 * ============================================================================
 *
 * Better Auth is mounted on the raw Express instance ahead of Nest (ADR-0013), so
 * RateLimitGuard can neither see nor key a pre-auth request: it keys on tenantId from
 * AuthGuard, which has not run. Without this, the unauthenticated credential surface
 * had no throttle at all — unlimited credential stuffing, and unlimited signup, each
 * creating a tenant row and dispatching a verification email until Resend's 100/day
 * free tier is exhausted and every legitimate signup silently fails.
 *
 * Express middleware, registered in front of toNodeHandler. Reuses redisClient (GC-3)
 * and carries ADR-0012's degradation posture: local bucket on Redis error, never
 * fail-open, never 5xx.
 */
export const AUTH_RATE_LIMITS = {
  signInPerIp: { limit: 10, windowS: 300 },
  signInPerEmail: { limit: 5, windowS: 900 },
  signUpPerIp: { limit: 3, windowS: 3600 },
  otherPerIp: { limit: 60, windowS: 60 },
} as const;

/**
 * The client IP is the platform-trusted value (Fly-Client-IP), NEVER the leftmost
 * X-Forwarded-For — same rule as click-events.md (F-009).
 * The email is hashed before it becomes a key, so the keyspace holds no addresses.
 */
export function authRateLimitKey(
  _env: string,
  _bucket: keyof typeof AUTH_RATE_LIMITS,
  _principal: string,
  _nowEpochS: number,
): string {
  throw new Error('not implemented');
}

/**
 * 32 KiB, rejecting with 413.
 *
 * DOES NOT PARSE. express.json({ limit }) would consume the stream Better Auth needs,
 * which is the whole reason for bodyParser: false. Rejects on Content-Length above the
 * cap and, for chunked requests, counts bytes as they pass and destroys the socket.
 */
export const AUTH_BODY_MAX_BYTES = 32 * 1024;

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
