# Contract: per-tenant write rate limiting

- **Boundary:** every authenticated write route; and the web client that renders a 429.
- **Normative form:** `apps/api/src/common/rate-limit/rate-limit.types.ts` (stub: `design/stubs/apps/api/src/common/rate-limit/rate-limit.types.ts`).
- **Produced by:** TASK-051.
- **Consumed by:** TASK-052 (web handling), TASK-056 (enumeration).
- **ADRs:** ADR-0012, ADR-0006.

## Limits

```ts
export const RATE_LIMIT_WINDOW_S = 60;
export const RATE_LIMIT_MAX_WRITES = 120;   // per tenant, per window
```

Fixed window. The key embeds the window start, so a window boundary allows up to 240
writes across two adjacent windows. Documented rather than fixed; a sliding window buys
precision nobody measures (ADR-0012).

## Key

```
rl:v1:{tenantId}:{floor(nowEpochS / 60)}
```

**Keyed by tenant, never a global bucket** (AC-84). One tenant hitting the limit has no
effect on another.

Atomic via one Lua script:

```lua
local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
return n
```

## Scope

Applies to `POST`, `PATCH`, `PUT` and `DELETE` on routes under the `/api` prefix.

**Does not apply to:** `GET` and `HEAD`; `@Public()` routes; `GET /health`; and the
redirect controller, which is registered outside the `/api` prefix and therefore
outside `RateLimitGuard` entirely (AC-86). Redirect traffic is never limited at any
rate.

## Response on limit

```
HTTP/1.1 429 Too Many Requests
Retry-After: <seconds remaining in the window>
Content-Type: application/json

{ "code": "rate_limited", "message": "..." }
```

`Retry-After` is delta-seconds, at least 1. **The write does not occur** (AC-83): the
guard runs before the handler and before the tenant transaction opens.

## Behaviour when Redis is unavailable

Neither fail-open nor fail-closed. **The limit still applies, locally.**

```ts
export interface LocalRateLimiter {
  /** In-process token bucket, same limit and window, LRU-capped at 10,000 tenants. */
  check(tenantId: string): { allowed: boolean; retryAfterSeconds: number };
}
```

On a Redis error or a 50 ms timeout the guard consults `LocalRateLimiter`, increments
`rate_limit_degraded_total`, and logs at warn once per minute. It never returns 5xx.

**Accepted gap:** with N machines running, the effective limit during degradation is
N times `RATE_LIMIT_MAX_WRITES`. Fly runs one machine at launch. Revisit before
enabling more.

The same posture governs the JWT revocation check (`auth-tokens.md`): one rule for what
the API does when Redis is gone.

## Invariants a caller may rely on

1. Tenant A being limited never affects tenant B (AC-84).
2. After the window elapses, A's next write succeeds (AC-85).
3. A 429 always carries `Retry-After` and `code: "rate_limited"` (AC-83).
4. The redirect path returns 302 at any rate (AC-86).
5. A Redis outage never produces a 5xx from the limiter and never lifts the limit
   entirely.
6. The guard reuses `redisClient` from TASK-030. It opens no second connection (GC-3).

## Web handling (TASK-052)

Handled in `apiClient`, centrally, so no screen reimplements it.

- The message states the limit was hit and when to retry, computed from
  `retryAfterSeconds`.
- **Form state survives.** The client throws `ApiError`; it does not reset, navigate or
  clear any input (AC-87).
- No automatic retry. The operator decides.

## What the implementer must guarantee

- The guard runs **after** `AuthGuard` (it needs `tenantId`) and **before**
  `TenantTransactionInterceptor` (a rejected request must not open a transaction).
- `docs/architecture/rate-limits.md` records the limit, the window, the fixed-window
  boundary caveat, and the degraded multiplier.
- `RateLimitGuard` appears in TASK-056's route enumeration like any other guard, and
  every write route is covered.

## Versioning

`RATE_LIMIT_MAX_WRITES` and `RATE_LIMIT_WINDOW_S` are configuration, changeable by
deploy. The key prefix `rl:v1:` changes only if the algorithm changes; bumping it
resets every tenant's current window.
