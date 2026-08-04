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

Revised 2026-08-04 (F-018). `RateLimitGuard` previously skipped `@Public()` routes
entirely, and `authRateLimit` is mounted only on `/api/auth/*`. That left the two
capability-token invitation routes covered by nothing: an attacker looping
`POST /api/invitations/<uuid>.<garbage>/accept` opened a Postgres transaction per
request, on the pooled connection set shared with the redirect hot path that GC-1
constrains and GC-8 forbids 5xx on. Invariant 7 was false as written.

`RateLimitGuard` now applies to **every route under `/api`**, with the key and the
method set depending on whether the caller is authenticated.

| Surface | Key | Methods | Limit |
|---|---|---|---|
| authenticated routes under `/api` | `tenantId` | `POST`, `PATCH`, `PUT`, `DELETE` | 120 / 60 s |
| **`@Public()` routes under `/api`** | **client IP** | **all methods, including `GET`** | **30 / 60 s** |
| `/api/auth/*` | client IP, and email inside Better Auth | all | see below |

`@Public()` routes are limited on `GET` too, because
`GET /api/invitations/:token` opens a tenant transaction exactly as the accept route
does. Authenticated `GET`s remain unlimited; that is unchanged and deliberate.

**Not limited, deliberately:** `GET /health` (platform probe), and the redirect
controller, which is registered outside the `/api` prefix and therefore outside the
guard entirely (AC-86). Redirect traffic is never limited at any rate.

The client IP is the platform-trusted value, `Fly-Client-IP`, never the leftmost
`X-Forwarded-For` (same rule as `click-events.md`, F-009).

### `/api/auth/*` is covered by a separate limiter, not by this guard

Added 2026-08-04 (F-004). Better Auth is mounted on the raw Express instance ahead of
Nest (ADR-0013), so `RateLimitGuard` can neither see nor key a pre-auth request: it
keys on `tenantId` from `AuthGuard`, which has not run. This section previously read as
though the unauthenticated credential surface simply had no limit, which is what an
implementer would have built.

`authRateLimit` is Express middleware registered in front of `toNodeHandler`. It reuses
`redisClient` (GC-3) and carries the same degradation posture as everything else here.

| Route | Key | Limit | Enforced by | Key format |
|---|---|---|---|---|
| `POST /api/auth/sign-in/email` | client IP | 10 / 5 min | Express middleware | `sk:{env}:arl:v1:ip:{ip}:signin:{window}` |
| `POST /api/auth/sign-in/email` | email | 5 / 15 min | **Better Auth `hooks.before`** | `sk:{env}:arl:v1:em:{sha256(email)}:signin:{window}` |
| `POST /api/auth/sign-up/email` | client IP | 3 / hour | Express middleware | `sk:{env}:arl:v1:ip:{ip}:signup:{window}` |
| everything else under `/api/auth/*` | client IP | 60 / min | Express middleware | `sk:{env}:arl:v1:ip:{ip}:other:{window}` |

The client IP is the platform-trusted value, `Fly-Client-IP`, never the leftmost
`X-Forwarded-For` (the same rule as `click-events.md`, F-009). The email is hashed
before it becomes a key so the keyspace holds no addresses.

### The email bucket runs inside Better Auth, not in Express

Revised 2026-08-04 (F-019). The email lives in the JSON body, and `authRateLimit` is
Express middleware registered ahead of `toNodeHandler`. Reading the body there consumes
the stream Better Auth needs, which is the stated reason `authBodyCap` must not parse.
The two rules contradicted each other, and an implementer meeting that would have
dropped the email bucket, leaving only the IP bucket: an attacker spread across 1,000
IPs then gets 10,000 password guesses per 5 minutes against one named account.

The IP-keyed buckets stay in Express, where only headers are needed. **The email-keyed
bucket moves inside Better Auth as a `hooks.before` middleware**, where `ctx.body.email`
is already parsed by the framework that owns the body:

```ts
betterAuth({
  hooks: {
    before: createAuthMiddleware(async (ctx) => {
      if (ctx.path !== '/sign-in/email') return;
      await emailRateLimit.check(sha256(ctx.body.email));   // throws APIError 429
    }),
  },
})
```

Same Redis client, same key format, same degradation posture. Nothing buffers or
re-emits a request stream.

A body cap, `authBodyCap`, sits ahead of the Express limiter at **32 KiB**. It does not
parse: it rejects with 413 when `Content-Length` exceeds the cap, and for a chunked
request with no or an understated `Content-Length` it counts bytes as they pass and
destroys the socket once the cap is crossed, without a response body.

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
7. **Every route under `/api` is covered by a limiter.** `RateLimitGuard` keyed by
   tenant for authenticated writes and **by IP for `@Public()` routes on all methods**;
   `authRateLimit` plus the Better Auth hook for `/api/auth/*`. The only unlimited
   surfaces are `GET /health` and the redirect path (AC-86), both deliberate and neither
   opening a tenant transaction. **There is no unthrottled surface that can open a
   Postgres transaction.**
8. No request body larger than 32 KiB reaches Better Auth, and none larger than 100 KiB
   reaches a Nest handler.
9. A `@Public()` route cannot be used to exhaust the connection pool the redirect path
   shares (GC-1, GC-8).

## Web handling (TASK-052)

Handled in `apiClient`, centrally, so no screen reimplements it.

- The message states the limit was hit and when to retry, computed from
  `retryAfterSeconds`.
- **Form state survives.** The client throws `ApiError`; it does not reset, navigate or
  clear any input (AC-87).
- No automatic retry. The operator decides.

## What the implementer must guarantee

- The guard runs **after** `AuthGuard` (it needs `tenantId`) and **before**
  `TenantTransactionInterceptor` (a rejected request must not open a transaction). On a
  `@Public()` route `AuthGuard` returns at step 0 without populating `RequestContext`,
  so the guard falls back to the IP key rather than reading a tenant that is not there.
- The `@Public()` IP bucket is checked **before** the handler parses the capability
  token, so a malformed-token flood costs one Redis `INCR` and no transaction.
- `docs/architecture/rate-limits.md` records the limit, the window, the fixed-window
  boundary caveat, and the degraded multiplier.
- `RateLimitGuard` appears in TASK-056's route enumeration like any other guard, and
  every write route is covered.

## Versioning

`RATE_LIMIT_MAX_WRITES` and `RATE_LIMIT_WINDOW_S` are configuration, changeable by
deploy. The key prefix `rl:v1:` changes only if the algorithm changes; bumping it
resets every tenant's current window.
