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

`RateLimitGuard` applies to `POST`, `PATCH`, `PUT` and `DELETE` on routes under the
`/api` prefix, keyed by tenant.

**`RateLimitGuard` does not apply to:** `GET` and `HEAD`; `@Public()` routes;
`GET /health`; `/api/auth/*`; and the redirect controller, which is registered outside
the `/api` prefix and therefore outside the guard entirely (AC-86). Redirect traffic is
never limited at any rate.

### `/api/auth/*` is covered by a separate limiter, not by this guard

Added 2026-08-04 (F-004). Better Auth is mounted on the raw Express instance ahead of
Nest (ADR-0013), so `RateLimitGuard` can neither see nor key a pre-auth request: it
keys on `tenantId` from `AuthGuard`, which has not run. This section previously read as
though the unauthenticated credential surface simply had no limit, which is what an
implementer would have built.

`authRateLimit` is Express middleware registered in front of `toNodeHandler`. It reuses
`redisClient` (GC-3) and carries the same degradation posture as everything else here.

| Route | Key | Limit | Key format |
|---|---|---|---|
| `POST /api/auth/sign-in/email` | client IP | 10 / 5 min | `sk:{env}:arl:v1:ip:{ip}:signin:{window}` |
| `POST /api/auth/sign-in/email` | email | 5 / 15 min | `sk:{env}:arl:v1:em:{sha256(email)}:signin:{window}` |
| `POST /api/auth/sign-up/email` | client IP | 3 / hour | `sk:{env}:arl:v1:ip:{ip}:signup:{window}` |
| everything else under `/api/auth/*` | client IP | 60 / min | `sk:{env}:arl:v1:ip:{ip}:other:{window}` |

The client IP is the platform-trusted value, `Fly-Client-IP`, never the leftmost
`X-Forwarded-For` (the same rule as `click-events.md`, F-009). The email is hashed
before it becomes a key so the keyspace holds no addresses.

A body cap, `authBodyCap`, sits ahead of both at **32 KiB**, rejecting with 413. It does
not parse: `express.json()` would consume the stream Better Auth needs.

### Accepted cost, stated

Email-keyed sign-in limiting is an account-enumeration oracle: an attacker learns which
addresses exist by observing which start returning 429 sooner. The IP limit bounds the
volume enough to accept this.

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
7. **Every route on the API is covered by exactly one limiter**: `RateLimitGuard` for
   authenticated writes, `authRateLimit` for `/api/auth/*`, and deliberately none for
   the redirect path (AC-86) and for `GET /health`. There is no unthrottled
   unauthenticated write surface.
8. No request body larger than 32 KiB reaches Better Auth, and none larger than 100 KiB
   reaches a Nest handler.

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
