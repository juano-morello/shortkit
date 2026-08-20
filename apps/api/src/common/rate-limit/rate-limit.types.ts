/**
 * Contract: `docs/contracts/rate-limit.md` ("Limits", "Scope", "Behaviour when Redis is
 *           unavailable", "Ownership and injection order")
 * ADR: adr-0012 (degradation posture), adr-0040 (a `null` principal), adr-0013, adr-0038
 * Produced by: TASK-1b-07 (wave 1 of item 1b) — the `@Public()` per-IP half.
 *              Debt sweep D1 (2026-08-19) — `checkTenant`, the tenant-keyed write bucket,
 *              process-local. TASK-051 keeps the Redis-backed implementation and the
 *              `rate_limit_degraded_total` path.
 *
 * ============================================================================
 * THE PORT `RateLimitGuard` CALLS. TWO METHODS, ONE PER BUCKET.
 * ============================================================================
 *
 * The contract names two buckets for the guard: the tenant-keyed write bucket (120 per 60 s,
 * every method that is not `GET`/`HEAD` on authenticated routes — ADR-0038's rule, which is
 * the contract's `POST`/`PATCH`/`PUT`/`DELETE` list closed against unexpected methods) and
 * the IP-keyed bucket on `@Public()` routes (30 per 60 s, every method). Item 1b shipped the
 * second (F-018); the debt sweep's D1 shipped the first as `checkTenant`, process-local,
 * closing the "authenticated writes are covered by nothing but `AuthGuard`" window the
 * contract recorded under invariant 7. What remains TASK-051's: rebinding this token to the
 * Redis implementation (with `LocalRateLimiter` kept as the degraded fallback) and the
 * `rate_limit_degraded_total` counter that rebinding makes reachable.
 *
 * Like `AUTH_RATE_LIMIT_PORT` (`auth/ports/auth-rate-limit.port.ts`), the token is REQUIRED,
 * never `@Optional()`: an unbound limiter is a security failure, not a cosmetic one, and
 * `RateLimitModule` binds `LocalRateLimiter` to it from wave 1 so no unprotected window exists
 * ("Ownership and injection order": there is no no-op default).
 */

/** The tenant-keyed write bucket's window (`rate-limit.md`, "Limits"). */
export const RATE_LIMIT_WINDOW_S = 60;

/** The tenant-keyed write bucket's limit per window, per tenant (`rate-limit.md`, "Limits"). */
export const RATE_LIMIT_MAX_WRITES = 120;

/**
 * The `@Public()` bucket: 30 requests per 60 s per client IP, every method including `GET`
 * (`rate-limit.md`, "Scope"). Thirty is generous for a person opening an invitation link and
 * tight for an office behind one NAT; the contract records that cost and keeps the number,
 * because raising it weakens the connection-pool protection F-018 exists to provide.
 */
export const PUBLIC_IP_LIMIT = 30;

export const PUBLIC_IP_WINDOW_S = 60;

/**
 * The cap on the process-local IP map (F-034, F-028). Principals here are client IPs chosen
 * by an unauthenticated caller and an IPv6 /64 is free, so the map is bounded absolutely and
 * SEPARATE from the tenant map TASK-051 adds: in a shared map an attacker churning addresses
 * across `@Public()` routes could evict a tenant's write bucket and reset its window at will.
 */
export const LOCAL_LIMITER_MAX_PUBLIC_IPS = 10_000;

/**
 * The cap on the process-local tenant map (`rate-limit.md`, "Behaviour when Redis is
 * unavailable"). A PLAIN LRU, deliberately without F-028's extra eviction rules: tenant ids
 * are produced only by authenticated callers, so the churn attack those rules close — an
 * anonymous caller minting principals to evict an exhausted entry — requires 10,000
 * authenticated tenants here. The map is SEPARATE from the IP map (F-034) so that anonymous
 * address churn can never evict a tenant's write bucket.
 */
export const LOCAL_LIMITER_MAX_TENANTS = 10_000;

/**
 * What a bucket answers. `retryAfterSeconds` is delta-seconds, at least 1, so a refused caller
 * can wait rather than retry into the same window; it becomes the `Retry-After` header.
 */
export type RateLimitDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly retryAfterSeconds: number };

export const RATE_LIMIT_PORT = Symbol('RATE_LIMIT_PORT');

export interface RateLimitPort {
  /**
   * Charges one request to `clientIp` in the `@Public()` bucket and says whether it is
   * admitted. `clientIp` is a principal `resolveRateLimitPrincipal` established — never a
   * client-supplied value, never a sentinel. A caller holding `null` does not call this at
   * all: the bucket does not run and the request proceeds (ADR-0040,
   * `trusted-client-address.md`).
   *
   * A rejection is a store failure, never a refusal — a refusal is a resolved decision with
   * `allowed: false`. The guard degrades with signal on a rejection rather than answering
   * 5xx (ADR-0012, `rate-limit.md` invariant 5).
   */
  checkPublicIp(clientIp: string): Promise<RateLimitDecision>;

  /**
   * Charges one mutating request to `tenantId` in the tenant-keyed write bucket (120 per
   * 60 s, `rate-limit.md` "Limits") and says whether it is admitted. `tenantId` is the
   * `RequestContext`'s tenant — written by `AuthGuard` from the token's claims, never a
   * client-chosen value — so tenant A being limited never affects tenant B (AC-84).
   *
   * Added by debt sweep D1 (2026-08-19), process-local; TASK-051 rebinds the token to the
   * Redis implementation without changing this shape. A rejection is a store failure, never
   * a refusal, exactly as `checkPublicIp` states.
   */
  checkTenant(tenantId: string): Promise<RateLimitDecision>;
}
