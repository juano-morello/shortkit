---
id: ADR-0012
slug: foundation
title: One ioredis connection with offline queueing off; the rate limiter falls back to a local bucket
status: accepted
supersedes: null
date: 2026-08-04
---

## Context

TASK-051 leaves one question open: what does the per-tenant write limiter do when
Redis is unavailable? SC-7 covers the redirect path only and says nothing about this.

Fail-closed makes a Redis blip a total write outage for every tenant, while the
redirect path next to it is committed to degrading gracefully. Fail-open removes the
only bound on write volume at the moment the system is already unhealthy, and the
limiter's second job is protecting Neon. Postgres is what SC-7's degraded redirect
path falls back to, so an unbounded write flood during a Redis outage can take down
redirects too. Neither pure answer is right.

The client choice is entangled with this and with AC-52, AC-53 and AC-54. TASK-030
produces `redisClient` and TASK-051 must reuse it rather than opening a second
connection (GC-3).

## Decision

**One `ioredis` client, created in `apps/api/src/cache/`, shared by the redirect cache
and the rate limiter.**

```ts
new Redis(process.env.REDIS_URL!, {
  enableOfflineQueue: false,
  maxRetriesPerRequest: 1,
  commandTimeout: 50,
  connectTimeout: 1000,
  retryStrategy: (times) => Math.min(times * 200, 5000),
  lazyConnect: false,
});
```

RESP over TLS, not the Upstash REST client. A persistent connection avoids a TLS
handshake per command on a path measured at 500 RPS, and it supports pipelining.

Each option earns its place against an AC. `enableOfflineQueue: false` makes a command
reject immediately while disconnected instead of queueing until reconnect, which is
what lets AC-52 and AC-53 return a correct answer from Postgres rather than hanging.
`commandTimeout: 50` bounds a hung-but-connected Redis, which TASK-032 requires.
`retryStrategy` reconnects on its own, which is AC-54's "without a restart".

**Rate limiter algorithm.** Fixed window, 60 seconds, 120 writes per tenant. Key
`rl:v1:{tenantId}:{windowStartEpochS}`. One Lua script does `INCR` then `EXPIRE`
atomically. `Retry-After` is the seconds remaining in the window.

**On Redis failure the limiter falls back to an in-process token bucket with the same
limits and windows.** It does not fail open and it does not fail closed. The limit
still applies; it applies per machine instead of per fleet.

**The fallback holds two maps, one per key space** (revised 2026-08-04, F-034; the
stub's `LocalRateLimiter` is the normative shape). Tenant principals — produced only
by authenticated callers — live in a plain LRU capped at
`LOCAL_LIMITER_MAX_TENANTS = 10_000`. `@Public()` IP principals — chosen by anonymous
callers — live in a **separate** map capped at `LOCAL_LIMITER_MAX_PUBLIC_IPS =
10_000`, carrying the same three rules F-028 set for `LocalAuthRateLimiter`: lazy
expiry plus a periodic sweep, and eviction that skips entries at or over their limit,
with forced eviction counted and logged. Separating the key spaces is what stops an
anonymous attacker churning addresses from evicting a tenant's write bucket during an
outage.

A fallback decision increments `rate_limit_degraded_total` and logs once per minute at
warn level. It never returns 5xx.

**AC-86 stands unchanged.** `RateLimitGuard` is applied to write routes under the
`/api` prefix. The redirect controller is outside the prefix and outside the guard, so
redirect traffic is never limited, degraded or otherwise.

**The same fail-open-with-local-fallback posture applies to the JWT revocation check**
in ADR-0014, so there is one rule for what the API does when Redis is gone rather than
one per feature.

## Alternatives considered

| Option | Pros | Cons | Why not |
|---|---|---|---|
| Fail closed: 429 every write while Redis is down | The limit is never exceeded; simple to state | One Redis blip locks every tenant out of every write while redirects keep serving. It converts a cache outage into a product outage, and the 429 tells the operator to retry later when the problem has nothing to do with their rate | The blast radius is the entire product, for a control that is a fairness mechanism rather than a security boundary |
| Fail fully open: allow all writes while Redis is down | Writes keep working; trivial | Removes the only bound on write volume exactly when the system is degraded. A runaway client can then saturate Neon, and Neon is SC-7's fallback for redirects | Couples a Redis outage to a possible Postgres outage on the visitor-facing path |
| `@upstash/ratelimit` with the REST client | Well-tested sliding window; less code to own | Needs `@upstash/redis`, which is a second client and a second connection path, against GC-3 and against TASK-051's instruction to reuse `redisClient`. Per-command HTTP also costs more latency than the persistent connection the redirect path needs | Contradicts the reuse constraint the plan set |
| Sliding-window log in Redis (sorted set per tenant) | Exact rate over any window; no boundary burst | Three commands and unbounded set growth per tenant per window, against one `INCR`. The precision buys nothing an agency would notice | Cost and complexity for a property nobody measures |
| Postgres-backed limiter | No dependency on Redis at all | Puts a write on every write request, on the database the limiter exists to protect | Inverts the purpose |

## Consequences

### Positive

- One connection, one client library, one failure posture for everything that touches
  Redis.
- During a Redis outage tenants keep writing and the limit still applies, so neither
  the product nor the database is left unprotected.
- AC-52, AC-53 and AC-54 map onto three named client options rather than onto
  hand-written reconnection logic.
- AC-86 needs no work: the guard and the redirect controller live on opposite sides of
  the `/api` prefix.

### Negative / accepted cost

- With N machines running, the degraded limit is N times the configured limit. Fly runs
  one machine at launch, so this is 1x today and becomes a real gap the day autoscaling
  is turned on, with nothing to warn about it.
- The token bucket is a second implementation of the same policy. The two can drift
  when the limit or window changes, and only the Redis one has an integration test
  unless someone writes the other.
- A fixed window allows up to 240 writes across a window boundary, twice the stated
  limit. Documented in the contract rather than fixed.
- `commandTimeout: 50` will occasionally abort a healthy command during a network
  hiccup and fall through to Postgres. On the redirect path that is a slow request; on
  the limiter it is a degraded decision. Both are logged, so the logs will contain
  noise that looks like an outage and is not.
- The tenant map's LRU cap means a burst spanning more than 10,000 distinct tenants
  evicts buckets and effectively resets their limits. Not reachable at this scale.
- **The fallback is now two maps rather than one** (F-034), so the earlier cross-talk
  — anonymous IP churn evicting tenant buckets during an outage — is gone by
  construction, at the cost of a second cap, a sweep, and roughly double the worst-case
  fallback memory (still ~3 MB per map bound). The public-IP map's forced-eviction
  path shares `local_rate_limit_forced_eviction_total`, so pressure on either local
  auth or public-IP maps surfaces on one counter.

### Follow-ups this creates

- TASK-030 owns the client, its options, and a `cacheAvailable` health signal.
- TASK-032 uses `enableOfflineQueue: false` and the 50 ms timeout for the bounded
  cache access, and owns `simulateRedisUnavailable()`.
- TASK-051 owns the Lua script, **both local fallback maps** (tenant-keyed and
  public-IP-keyed, F-034), `rate_limit_degraded_total`, and
  `docs/architecture/rate-limits.md` recording 120 writes per 60 seconds and the
  boundary-burst caveat. The public-IP map's principal comes from
  `resolveRateLimitPrincipal` (TASK-009, `rate-limit.md`).
- Revisit the degraded multiplier before enabling more than one Fly machine.
