# Contract: rate limiting

- **Boundary:** every route under `/api`, including `@Public()` routes and the pre-auth `/api/auth/*` surface; and the web client that renders a 429.
- **Normative form:** `apps/api/src/common/rate-limit/rate-limit.types.ts`, `apps/api/src/auth/ports/auth-rate-limit.port.ts`, and `apps/api/src/auth/resolve-rate-limit-principal.ts` (stubs under `design/stubs/`).
- **Produced by:** TASK-009 (auth surface: body cap, IP buckets, email hook, the port) and TASK-051 (`RateLimitGuard`, the Redis implementations). See the ownership table below.
- **Consumed by:** TASK-052 (web handling), TASK-056 (enumeration).
- **ADRs:** ADR-0012, ADR-0006, ADR-0013.

Retitled 2026-08-04: this was "per-tenant write rate limiting" and its Boundary line read
"every authenticated write route", which F-018's fix made false and F-026 caught. The
tenant-keyed write limiter is now one of four buckets.

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

**AC-84 is unchanged and unweakened by the IP-keyed buckets.** AC-84 constrains the
limiter that applies to a tenant's writes: it must be per tenant rather than global, so
tenant A's traffic cannot exhaust tenant B's allowance. The IP-keyed buckets apply to
`@Public()` and pre-auth routes, where **there is no tenant to key on** because the
caller has not authenticated. They are a disjoint surface, not a coarser key for the
same one. No authenticated write is ever decided by an IP bucket, and no anonymous
request consumes a tenant's allowance.

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

### Which address "the client IP" means, under the BFF

**Found during round 4 while verifying F-030, and not previously filed.** Every IP-keyed
bucket in this contract was specified as keying on `Fly-Client-IP`. Under ADR-0014's BFF
topology the browser never talks to Fly: `/api/auth/*` and every `@Public()` route arrive
from the Next.js proxy, so `Fly-Client-IP` is **Vercel's egress address for every user**.

Left as it was, all four IP buckets would have collapsed into one shared bucket:
3 signups per hour and 10 sign-ins per 5 minutes **across the entire product**, and 30
requests a minute total on the invitation routes. That is a product outage, not a
limiter, and it would have appeared only once the BFF and the limiter were deployed
together.

```
BFF sets   X-Shortkit-Client-IP: <browser address, from x-vercel-forwarded-for>
           X-Shortkit-Proxy-Auth: <shared secret, BFF_PROXY_SECRET>
```

**The resolution rule is normative in
`apps/api/src/auth/resolve-rate-limit-principal.ts`** (F-031), which exports the header
constants (`BFF_CLIENT_IP_HEADER`, `BFF_PROXY_AUTH_HEADER`, `FLY_CLIENT_IP_HEADER`) and
`resolveRateLimitPrincipal(headers)` — **the only site that makes the trusted-proxy
decision**. Every IP-keyed bucket, in the Express auth middleware (TASK-009) and in
`RateLimitGuard` (TASK-051), obtains its principal from that function. Nothing else
reads these headers.

`resolveRateLimitPrincipal` returns `X-Shortkit-Client-IP` **only when all four hold**
(F-033):

1. `BFF_PROXY_SECRET` is set and non-empty on the API side. Unset or empty **disables
   the trusted-proxy branch unconditionally** — the comparison in rule 3 is never
   *reached*, not merely never equal.
2. `X-Shortkit-Proxy-Auth` is present and non-empty. An absent or empty header never
   matches — again the comparison is never reached. Rules 1 and 2 close the naive
   implementation's bypass: `header === process.env.BFF_PROXY_SECRET` is
   `undefined === undefined` for a direct anonymous request with the variable unset.
3. A constant-time comparison of the header against `BFF_PROXY_SECRET` matches. This is
   the BFF acting as a configured trusted proxy.
4. `X-Shortkit-Client-IP` parses as an IPv4 or IPv6 address (`net.isIP`). This bounds
   the value before it becomes a Redis key segment or a local map key; Node accepts
   16 KiB headers, and an unparsed value would void the local limiter's memory budget.

Otherwise it returns `Fly-Client-IP`, for anything reaching Fly directly. The leftmost
`X-Forwarded-For` entry is never used, for any purpose.

**Fail-open-with-signal, not fail-to-boot, not silent** (F-033). A present
`X-Shortkit-Proxy-Auth` that fails rule 1, 2 or 3 — and a valid secret whose forwarded
value fails rule 4 — increments **`bff_proxy_auth_mismatch_total`** and logs at warn
once per minute, so a secret mismatch shows up as a counter rather than as users
reporting that signup is broken. The request itself proceeds under the `Fly-Client-IP`
fallback; an unauthenticated forwarded header is ignored, never rejected, so probing
reveals nothing. Failing boot on a mismatch would be wrong: the same Fly process serves the
redirect path (GC-8, AC-86), and "matches" cannot be verified locally. What *is*
locally checkable is asserted: **`assertBffProxySecretConfigured()` fails boot in
production when `BFF_PROXY_SECRET` is unset or empty** — TASK-009 calls it in `main.ts`
beside the auth mount. `BFF_PROXY_SECRET` is required configuration on both
deployables: Fly (this assertion) and Vercel (TASK-004, `web-api-client.md`).

**This does not weaken F-009.** That rule forbids trusting a *client-supplied* address,
and an anonymous attacker cannot produce the shared secret.

**Click events are unaffected and keep `trustedClientIp()` verbatim** — a **separate
function that must not be merged with `resolveRateLimitPrincipal`**. The redirect path
is served by Fly directly, because custom domains CNAME to `fly.dev` and never traverse
the BFF, so it must never honour a forwarded address; a shared resolver would put an
attacker-settable value into `ip_hash` and reopen F-009 on the append-only store.
`click-events.md` needs no change.

The secret is rotated by setting both sides and redeploying; a mismatch degrades to
the `Fly-Client-IP` fallback, which is safe, and is visible on
`bff_proxy_auth_mismatch_total`.

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

The client IP is the value returned by `resolveRateLimitPrincipal(headers)` — see
"Which address the client IP means" above (F-031). Behind the BFF, `Fly-Client-IP`
read directly is Vercel's egress address for every user, which is exactly the
collapsed-bucket outage that section exists to prevent; and the leftmost
`X-Forwarded-For` is never used (F-009). The email is hashed before it becomes a key
so the keyspace holds no addresses.

**Better Auth's own limiter is disabled on this surface** — TASK-009 sets
`rateLimit: { enabled: false }` (ADR-0013, F-030) and owns a unit test asserting the
composed `betterAuth` config carries it. The table above is the complete set of
limiters on `/api/auth/*`, and invariant 3's enumeration of 429 sources depends on that
disable, which otherwise degrades silently and only in production.

### Ownership and injection order

Added 2026-08-04 (F-024). The email hook lives inside the `betterAuth()` config in
`apps/api/src/auth/**`, which is TASK-009's territory, while this contract named
TASK-051 as producer. TASK-051 cannot write that file, and TASK-009 runs in wave 2
while `redisClient` does not exist until TASK-030 in wave 6. Nobody owned the bucket
and nothing said how a wave-2 mount reaches a wave-6 dependency, so the predictable
outcome was that it never got built.

| Piece | File | Owning TASK |
|---|---|---|
| `authBodyCap` | `apps/api/src/auth/middleware/auth-body-cap.ts` | **TASK-009** |
| `authRateLimit` (IP buckets) | `apps/api/src/auth/middleware/auth-rate-limit.ts` | **TASK-009** |
| `resolveRateLimitPrincipal`, header constants, `assertBffProxySecretConfigured` | `apps/api/src/auth/resolve-rate-limit-principal.ts` | **TASK-009** (wave 2; TASK-051's guard imports it) |
| email bucket, `hooks.before` | `apps/api/src/auth/auth.config.ts` | **TASK-009** |
| `AuthRateLimitPort` and its token | `apps/api/src/auth/ports/auth-rate-limit.port.ts` | **TASK-009** |
| `LocalAuthRateLimiter` (in-process) | `apps/api/src/auth/ports/local-auth-rate-limiter.ts` | **TASK-009** |
| `RedisAuthRateLimiter` | `apps/api/src/common/rate-limit/redis-auth-rate-limiter.ts` | **TASK-051** |
| `RateLimitGuard` and the tenant bucket | `apps/api/src/common/rate-limit/**` | **TASK-051** |
| binding the Redis implementation to the token | `apps/api/src/app.module.ts` | **TASK-051** |

**The injection order.** The auth module **declares the port**, exactly as the redirect
module declares its branding port (ADR-0011). The mount and the hook call through the
token and never touch `redisClient` directly.

```
wave 2  TASK-009  declares AUTH_RATE_LIMIT_PORT, wires all three call sites to it,
                  and binds LocalAuthRateLimiter — a real in-process token bucket,
                  same algorithm and same limits, per machine rather than per fleet.
wave 6  TASK-030  produces redisClient.
wave 10 TASK-051  binds RedisAuthRateLimiter to the same token. The local limiter
                  stays bound as the degraded fallback ADR-0012 already specifies.
```

**There is no unprotected window and no no-op default.** From wave 2 the auth surface is
limited by the in-process bucket, which is the same implementation ADR-0012 already
requires for Redis-unavailable degradation. TASK-051 upgrades it from per-machine to
per-fleet; it does not introduce it. Fly runs one machine, so the wave-2 protection is
equivalent in practice, and the accepted N-times-limit cost is the one already recorded
in ADR-0012.

### `LocalAuthRateLimiter` is bounded, per bucket

Added 2026-08-04 (F-028). This was specified only as "same algorithm, same limits" while
its sibling `LocalRateLimiter` states an explicit `LOCAL_LIMITER_MAX_TENANTS = 10_000`
cap. The omission mattered more here, not less: the sibling's principals are tenant ids,
which only an authenticated caller produces, whereas these are client IPs and
`sha256(email)`, both chosen by an **unauthenticated** caller. An IPv6 /64 is free, so
one live map entry per request with nothing to reap it.

Two live windows: the whole wave-2-to-wave-10 interval when this is the only auth
limiter, and any Redis outage in production, when ADR-0012 routes every auth decision
here. In the second, an attacker converts a Redis outage into an API OOM-restart loop
**while the redirect path is already degraded onto its Postgres fallback**, which GC-1
constrains and GC-8 forbids 5xx on.

```ts
export const LOCAL_AUTH_LIMITER_MAX_PRINCIPALS = 10_000;   // per bucket, not total
export const LOCAL_AUTH_LIMITER_SWEEP_MS = 60_000;
```

- **One map per bucket**, each capped at `LOCAL_AUTH_LIMITER_MAX_PRINCIPALS`. Four
  buckets, so roughly 6 MB at worst against a click buffer already budgeted at 4 MiB.
- **Entries whose window has elapsed are dead.** Dropped lazily on access and by a
  sweep every `LOCAL_AUTH_LIMITER_SWEEP_MS`. The sweep is what bounds `signUpPerIp`,
  whose one-hour window would otherwise hold an hour of distinct IPs.
- **Eviction skips entries at or over their limit.** LRU otherwise. This closes the
  bypass the cap would otherwise open: an attacker who has exhausted an account's five
  attempts could churn 10,000 distinct principals to evict that entry and reset the
  count. Evicting only under-limit entries makes the attack require 10,000
  *simultaneously limited* principals, which itself has to pass the IP buckets first.
- **If every entry is over its limit and the cap is reached**, evict the oldest anyway,
  increment `local_rate_limit_forced_eviction_total`, and log at warn. Memory is bounded
  absolutely; the counter is the signal that the limiter is under pressure. Failing
  closed for new principals instead would let an attacker lock out every new user.

The Redis implementation has none of these properties to reason about: keys expire on
their own and Upstash's eviction is not our problem.

`AUTH_RATE_LIMIT_PORT` is bound with `@Optional()` nowhere. It is a **required**
provider: an unbound token fails at boot, unlike ADR-0011's branding port, because an
absent limiter is a security failure rather than a cosmetic one.

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
      const normalised = normaliseEmailForKey(ctx.body?.email);   // unknown -> string | null
      if (normalised === null) return;                            // F-228. See below.
      await emailRateLimit.check(sha256(normalised));             // throws APIError 429
    }),
  },
})
```

Same Redis client, same key format, same degradation posture. Nothing buffers or
re-emits a request stream.

### `ctx.body` is unvalidated at hook time

Added 2026-08-07 (F-228), verified by probe against `better-auth@1.6.26`. `hooks.before`
runs **ahead of the endpoint's zod validation**. Observed inputs at the hook:

| Request | `typeof ctx.body.email` | Endpoint's eventual status |
|---|---|---|
| `{"email":{"ne":null},"password":"x"}` | `object` | 400 `VALIDATION_ERROR` |
| `{"email":12345,"password":"x"}` | `number` | 400 `VALIDATION_ERROR` |
| no body at all | `ctx.body` is `undefined` | 400 `VALIDATION_ERROR` |
| form-encoded `email=a@b.com` | `string` | 401 |

**The hook must not throw on any of these.**
`better-auth/dist/api/dispatch.mjs:86-89` rethrows anything from a before hook that is not
an `APIError`, so a `TypeError` from `.trim()` aborts the request before the endpoint runs.
The attempt is then never charged to the bucket, the response is a 500 rather than a 400,
and no later entry in `beforeHooks` executes. An unauthenticated caller gets an unlimited
500 generator on the credential surface.

`normaliseEmailForKey` therefore accepts `unknown` and returns `string | null`:

```ts
export function normaliseEmailForKey(email: unknown): string | null;
```

| Input | Returns |
|---|---|
| a string that trims to non-empty | `email.trim().toLowerCase()` |
| a string that trims to empty | `null` |
| any non-string, including `undefined`, `null`, numbers, objects, arrays | `null` |

On `null` the hook **returns without checking or consuming the bucket**, and the request
continues to the endpoint, which rejects it with the 400 it would have returned anyway. It
does not throw a 429 and it does not key on a sentinel: a shared sentinel bucket would let
one caller's malformed traffic exhaust an allowance that other callers fall into. The IP
bucket in Express still counts these requests, so the volume is bounded.

This corrects a sentence in the paragraph below that read "`ctx.body` being undefined gives
a 500 on every sign-in, which nobody misses". It gives a 500 only on the requests a caller
chooses to malform, which nobody notices.

### The email key is normalised, and both failure modes are tested

Added 2026-08-04 (F-025). Both plausible ways this bucket fails are silent, unlike the
adjacent ones. These two give a limiter that quietly does not exist.

**(a) Normalisation.** The key is computed over the **same normalised form Better Auth
uses for the credential lookup**, not over the raw submitted string:

```ts
const normalisedEmail = normaliseEmailForKey(ctx.body?.email);   // null-checked above
const key = authRateLimitKey(env, 'signInPerEmail', sha256(normalisedEmail), now);
```

Better Auth lowercases the address for its account lookup, so `Foo@x.com` and
`foo@x.com` are one account. Hashing the raw string would mint a fresh allowance per
casing, and an attacker varying the case of the local part would never bind. Only case
folding and surrounding whitespace are normalised. **Nothing else is stripped** — no
dot-removal, no `+tag` removal — because two addresses differing that way may be two
real accounts at some providers, and collapsing them would let one user's failures lock
out another's.

**(b) The trigger predicate.** The hook fires on `ctx.path === '/sign-in/email'`, which
is base-path-relative inside Better Auth. If that assumption is wrong the hook returns on
every request and the bucket silently does not exist.

**Required integration test**, which pins the key, the predicate and the 429 together
and turns an unverified framework assumption into a checked one:

> Six sign-in attempts for one address from **six different client IPs**, so no IP bucket
> can fire. The sixth returns 429 with `code: "rate_limited"`.

Two more, cheap and covering the rest:

> The same six attempts with the address case-varied on each attempt still 429 on the
> sixth.
>
> A sign-in for a **different** address from the same six IPs succeeds, so the bucket is
> keyed on the address rather than firing globally.

A fourth, added 2026-08-07 (F-228):

> A sign-in whose `email` is a JSON object rather than a string returns the endpoint's
> **400**, not a 500, and a following legitimate sign-in for that address is not one
> attempt closer to its limit.

No AC covers pre-auth limiting, so these tests are the only thing standing between this
design and F-019's original failure. TASK-009 owns them.

A body cap, `authBodyCap`, sits ahead of the Express limiter at **32 KiB**. It does not
parse: it rejects with 413 when `Content-Length` exceeds the cap, and for a chunked
request with no or an understated `Content-Length` it counts bytes as they pass and
destroys the socket once the cap is crossed, without a response body.

### Accepted costs, stated

- Email-keyed sign-in limiting is an account-enumeration oracle: an attacker learns which
  addresses exist by observing which start returning 429 sooner. The IP limit bounds the
  volume enough to accept this.
- **The `@Public()` IP bucket is shared by everyone behind one NAT.** Thirty requests a
  minute is generous for a person opening an invitation link and tight for an agency
  whose whole office egresses from one address: several invitees accepting at once can
  429 each other on the accept route. The copy for that 429 says to retry shortly rather
  than implying the link is broken (TASK-022). Raising the limit weakens the
  connection-pool protection F-018 exists to provide, so the limit stays and the cost is
  recorded.
- An email-keyed lockout is a denial-of-service against a known account: an attacker who
  knows an address can keep it at five failed attempts per fifteen minutes. The window is
  short and the account stays reachable between windows. Accepting this is the standard
  trade for binding distributed credential stuffing, and it is why the window is fifteen
  minutes rather than a day.

## Response on limit

**From a Nest route** (`RateLimitGuard`, tenant-keyed and public IP-keyed):

```
HTTP/1.1 429 Too Many Requests
Retry-After: <seconds remaining in the window>
Content-Type: application/json

{ "code": "rate_limited", "message": "..." }
```

`Retry-After` is delta-seconds, at least 1. **The write does not occur** (AC-83): the
guard runs before the handler and before the tenant transaction opens.

**From the auth surface.** Added 2026-08-04 (F-027). `/api/auth/*` is mounted outside
Nest (ADR-0013), so its 429s do not pass the exception filter and the previous
unqualified invariant was false for the one 429 a user is most likely to see: a
rate-limited login.

The Express IP buckets run before `toNodeHandler` and **do** set the header, so they
match the shape above apart from the body, which they emit themselves.

The email bucket throws Better Auth's `APIError`, whose body we control and whose header
control is not guaranteed by the framework. It therefore carries the retry value **in
the body as well**:

```ts
throw new APIError(429, {
  code: 'rate_limited',
  message: 'Too many sign-in attempts for this account. Try again shortly.',
  retryAfterSeconds: decision.retryAfterSeconds,
});
```

| Surface | `Retry-After` header | Body |
|---|---|---|
| Nest routes | yes | `ErrorEnvelope` |
| `/api/auth/*` IP buckets | yes | `{ code: 'rate_limited', message, retryAfterSeconds }` |
| `/api/auth/*` email bucket | best effort | `{ code: 'rate_limited', message, retryAfterSeconds }` |

**`apiClient` normalises all three** into `ApiError.retryAfterSeconds`, preferring the
header and falling back to the body field (`web-api-client.md`). TASK-052's central 429
rendering therefore works on the login screen without a special case, which is the point
of stating this rather than leaving the fallthrough to a generic error.

## Behaviour when Redis is unavailable

Neither fail-open nor fail-closed. **The limit still applies, locally.**

```ts
export interface LocalRateLimiter {
  /** Authenticated writes. Tenant-keyed map, LRU-capped at LOCAL_LIMITER_MAX_TENANTS. */
  checkTenant(tenantId: string): RateLimitDecision;
  /** @Public() routes. SEPARATE IP-keyed map (F-034), capped at LOCAL_LIMITER_MAX_PUBLIC_IPS. */
  checkPublicIp(clientIp: string): RateLimitDecision;
}
```

**Two maps, two key spaces** (F-034, and ADR-0012 revised to match). Tenant ids are
produced only by authenticated callers; `@Public()` IPs are chosen by anonymous ones.
In a shared map an attacker churning ~10,000 addresses across `@Public()` routes during
a Redis outage would evict a tenant's write bucket and reset its 120/60s window at will
— during exactly the window when the redirect path is already on its Postgres fallback
(GC-1, GC-8). So:

- `checkTenant` keeps its plain LRU at `LOCAL_LIMITER_MAX_TENANTS = 10_000`; its keys
  require authentication, so F-028's extra rules are unnecessary there.
- `checkPublicIp` gets its own map at `LOCAL_LIMITER_MAX_PUBLIC_IPS = 10_000` with
  **all three F-028 rules**: lazy expiry plus a sweep every
  `LOCAL_AUTH_LIMITER_SWEEP_MS`, and eviction that skips entries at or over their
  limit, with forced eviction counted on `local_rate_limit_forced_eviction_total` and
  logged at warn.

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
3. A 429 always carries `code: "rate_limited"` and a retry value the client can read.
   From a Nest route that is the `Retry-After` header and an `ErrorEnvelope` body
   (AC-83). From `/api/auth/*` the retry value is also in the body as
   `retryAfterSeconds`, because that surface is mounted outside Nest and its header
   control is not guaranteed. `apiClient` normalises both into
   `ApiError.retryAfterSeconds`, so no screen sees the difference (F-027). This
   enumeration is complete **only because Better Auth's built-in limiter — a fourth
   429 source, on by default in production — is disabled**: `rateLimit: { enabled:
   false }`, set and unit-tested by TASK-009 (ADR-0013, F-030).
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
- **Every IP-keyed decision obtains its principal from `resolveRateLimitPrincipal`**
  (F-031). No second resolver, no inlined header reads, and the redirect path's
  `trustedClientIp()` is never called for rate limiting nor merged with it.
- `docs/architecture/rate-limits.md` records the limit, the window, the fixed-window
  boundary caveat, and the degraded multiplier.
- `RateLimitGuard` appears in TASK-056's route enumeration like any other guard, and
  every write route is covered.

## Versioning

`RATE_LIMIT_MAX_WRITES` and `RATE_LIMIT_WINDOW_S` are configuration, changeable by
deploy. The key prefix `rl:v1:` changes only if the algorithm changes; bumping it
resets every tenant's current window.

## BFF_PROXY_SECRET — enforced format (added 2026-08-05, F-169)

This contract previously required only that `BFF_PROXY_SECRET` be **set and non-empty**. That is
now insufficient to describe the system, because the Vercel half enforces a format the Fly half
does not document.

**Normative:** `BFF_PROXY_SECRET` is **base64url** — `A-Z`, `a-z`, `0-9`, `-`, `_`, **no padding**
— and **at least 32 characters**. Generate it with:

```
openssl rand 24 | base64 | tr '+/' '-_' | tr -d '='
```

`apps/web/scripts/assert-no-inlined-secrets.mjs` rejects any value outside that alphabet before it
scans anything, and that script is chained into `vercel.json`'s `buildCommand` — so a value that
satisfies this contract's old wording but not this one **fails the Vercel deploy**, while being
accepted by every consumer on the API side.

The constraint exists so that no HTML-entity, `\uXXXX` or JSON-string escaping can ever apply to
the value, which is what lets the leak scan match it verbatim in prerendered HTML and RSC payloads
(F-164). It matches the house convention already used by `invitation-tokens.md`,
`domain-provisioning.md` and ADR-0021.
