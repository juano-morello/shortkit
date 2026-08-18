# Rate limits

The contract puts every route under `/api` behind a limiter keyed on something the caller
cannot choose; the table below says which buckets exist today and which are still owed. This
is the working version of `docs/contracts/rate-limit.md`: the buckets, their keys, what has
shipped, and the two caveats a fixed-window limiter carries.

Sources: `docs/contracts/rate-limit.md` (normative), `docs/contracts/trusted-client-address.md`
(what a `null` principal is), ADR-0012 (degradation posture), ADR-0013 (the auth mount),
ADR-0040 (the trusted address is declared and may be absent).

## The buckets

| Surface | Key | Methods | Limit / window | Enforced by | Status |
| --- | --- | --- | --- | --- | --- |
| `@Public()` routes under `/api` | client IP | all, `GET` included | 30 / 60 s | `RateLimitGuard` → `RATE_LIMIT_PORT` (`LocalRateLimiter.checkPublicIp`) | shipped, TASK-1b-07 (2026-08-18) |
| authenticated routes under `/api` | `tenantId` | `POST`, `PATCH`, `PUT`, `DELETE` | 120 / 60 s | `RateLimitGuard` → `checkTenant` | **not built** (TASK-051); the guard passes these routes and charges nothing |
| `POST /api/auth/sign-in/email` | client IP | `POST` | 10 / 5 min | `authRateLimit` (Express, ahead of Better Auth) | shipped, TASK-004 |
| `POST /api/auth/sign-in/email` | `sha256(email)` | `POST` | 5 / 15 min | Better Auth `hooks.before` | item 1b, TASK-1b-09 |
| `POST /api/auth/sign-up/email` | client IP | `POST` | 3 / hour | `authRateLimit` | shipped, TASK-004 |
| everything else under `/api/auth/*` | client IP | all | 60 / min | `authRateLimit` | shipped, TASK-004 |

Deliberately unlimited: `GET /health` (outside the `/api` prefix; the guard tests the request
path, not the route's justification) and the redirect path (outside the prefix too, AC-86).

## Where the client IP comes from

One function, `resolveRateLimitPrincipal(headers, env)` in
`apps/api/src/auth/resolve-rate-limit-principal.ts`, for every IP-keyed bucket. It returns
the BFF-forwarded address only under an authenticated `X-Shortkit-Proxy-Auth`, otherwise the
header `TRUSTED_CLIENT_IP_HEADER` declares, otherwise `null`. **`null` means the bucket does
not run and the request proceeds**; nothing substitutes a sentinel or the peer address. In
compose, CI and local dev no header is declared, so no IP-keyed bucket binds there. The
integration tier declares `x-test-client-ip` to exercise them.

## The response

From a Nest route: `429`, `Retry-After: <delta-seconds ≥ 1>`, body `{ "code": "rate_limited",
"message": "…" }`. The guard throws a `DomainError('rate_limited', …)` whose `headers` carry
`Retry-After`; `ApiExceptionFilter` writes the header before the envelope. The auth surface's
Express buckets emit their own `429` with the same header and `retryAfterSeconds` in the body
as well, because that surface is mounted outside Nest.

## Order of the guards

`AuthGuard` first, `RateLimitGuard` second. `AppModule` imports `RateLimitModule` after
`AuthModule`, and Nest applies `APP_GUARD` providers in that order. Every guard runs before
any interceptor, so a refused request never reaches `TenantTransactionInterceptor` or a handler
that would open a transaction from a token (F-018). `app.module.spec.ts` reads the resolved
guard list and pins the order.

## Two caveats, both accepted

- **Fixed windows, aligned to the epoch.** A caller can spend one full allowance at the end
  of a window and another at the start of the next: up to 60 public requests, or 240 tenant
  writes, across a boundary. Recorded rather than fixed: a sliding window buys precision
  nobody measures (ADR-0012).
- **The store is process-local until Redis lands.** `LocalRateLimiter` is one map per bucket,
  capped at 10 000 principals with F-028's rules (lazy expiry plus a 60 s sweep; eviction
  skips entries at or over their limit; a forced eviction is counted on
  `local_rate_limit_forced_eviction_total` and warned). With N machines the effective limit
  is N × the number in the table; one machine runs today. When TASK-051 binds the Redis
  implementation, this map stays as the fallback ADR-0012 requires, and a Redis outage
  degrades to it, never to a 5xx and never to no limit.
