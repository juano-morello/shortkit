---
id: TASK-058
story: STORY-005
epic: EPIC-002
title: Auth-surface protection — body cap, IP buckets, email bucket, and the rate-limit port
status: deferred
owner_slot: sdlc-implementer-backend
depends_on: [TASK-009]
paths: ["apps/api/src/auth/middleware/**", "apps/api/src/auth/ports/**", "apps/api/src/auth/auth.config.ts", "apps/api/test/auth/**"]
contracts: [design/contracts/auth-tokens.md, design/contracts/error-envelope.md, design/contracts/rate-limit.md]
test_files: []
acceptance: [AC-108, AC-109, AC-110, AC-111]
rework_count: 0
---

## Intent

Protect the unauthenticated credential surface that TASK-009 mounts. Better Auth
sits ahead of the Nest graph, so no Nest guard, filter, or limiter reaches it —
this TASK supplies what Nest would otherwise have provided.

**Created 2026-08-04 by splitting TASK-009**, on Juano's ruling, after Design
roughly doubled that TASK's scope. TASK-009 keeps the mount, the four auth
routes, and JWT issuance; everything protecting them is here.

## Approach

Constraints from ADR-0013, ADR-0012 and `design/contracts/rate-limit.md`.

**Three pieces, one seam.**

1. **`authBodyCap`** — rejects on `Content-Length` over the cap and byte-counts
   chunked bodies, **without parsing**. It must not consume the stream: that is
   the entire reason `bodyParser: false` exists, and an `express.json()` cap
   here breaks Better Auth. Over the cap on the chunked path destroys the socket.
2. **`authRateLimit`** — IP-keyed buckets, headers only, registered ahead of
   `toNodeHandler`. Tighter on sign-in and sign-up than the tenant limit.
3. **The email bucket** — a `hooks.before` middleware **inside** the Better Auth
   config, where `ctx.body.email` is already parsed by the framework that owns
   the body. This is why it is not Express middleware: nothing buffers, nothing
   re-emits.

**The key normalises case and whitespace only** — `sha256(email.trim().toLowerCase())`,
matching the form the credential lookup uses. **No dot-stripping and no `+tag`
stripping:** those can be distinct real accounts, and collapsing them lets one
user lock out another.

**The port, and why it exists.** `AUTH_RATE_LIMIT_PORT` is declared here and
bound to `LocalAuthRateLimiter`, a real in-process token bucket with the same
algorithm and limits, per machine rather than per fleet. TASK-051 later binds
`RedisAuthRateLimiter` to the same token and the local one remains as ADR-0012's
degraded fallback. This exists because the mount lands in wave 2 and
`redisClient` does not arrive until wave 6 — without the port, either the
protection waits eight waves or the mount reaches for a client that does not
exist.

**The port is required at boot, not `@Optional()`.** An unbound token fails
startup. A missing branding port degrades a 404; a missing limiter opens the
credential surface. Do not copy ADR-0011's optional binding here.

**`ctx.path` is an assumption, not a fact.** Nobody has verified it is
base-path-relative against a running install. AC-108 exists to convert that
assumption into a checked one — if the predicate never matches, the hook returns
on every request and the bucket silently does not exist. That is a fail-open,
which is why the test is required rather than advisory.

## Out of scope for this TASK

The Better Auth mount, the auth routes, and JWT issuance (TASK-009). The
Redis-backed limiter and its binding (TASK-051). Tenant-keyed rate limiting on
`/api` routes (TASK-051). The invitation `before` hook (TASK-013).

## Interfaces

**Consumes**

The Better Auth mount and `auth.config.ts` (TASK-009); `ErrorCode` and
`ErrorEnvelope` (TASK-007).

**Produces**

`authBodyCap` and `authRateLimit` Express middleware; the `hooks.before` email
bucket; `AUTH_RATE_LIMIT_PORT` and its interface; `LocalAuthRateLimiter`. The
429 carries `retryAfterSeconds` **in the body**, because header control from
inside a Better Auth hook is not guaranteed — `apiClient` prefers the header and
falls back to the body field, so TASK-052's central rendering works unchanged.


## ⚠ Parked design findings you must read (F-036, F-037)

Two findings were **parked at the Design ladder cap** rather than fixed, because the
security auditor classified both as self-contained. They are real. Read them before
you write the rate-limit code.

**F-036 — a stale doc comment will mislead you.**
`design/stubs/apps/api/src/auth/ports/auth-rate-limit.port.ts` still documents its
`principal` parameter as "the platform-trusted client IP". **That wording is obsolete.**
"Platform-trusted" is this design's vocabulary for `Fly-Client-IP`, and following it
behind the backend-for-frontend passes Vercel's egress address for every user — the whole
product then shares 3 signups per hour and 10 sign-ins per 5 minutes.

The correct rule, stated in `rate-limit.md`, `rate-limit.types.ts` and
`stubs/apps/api/src/auth/resolve-rate-limit-principal.ts`: the principal for the IP
buckets is **`resolveRateLimitPrincipal(headers)`**, never `Fly-Client-IP` read directly.
Fix the comment as you go.

**F-037 — the ownership table's TASK attribution is stale.**
`rate-limit.md`'s ownership table was written before TASK-009 was split, so it assigns
auth-surface pieces to TASK-009 that now belong here. The split is authoritative; the
table is not.


## ⚠ Composition boundary with TASK-009 (ADR-0013, F-054, 2026-08-04)

You own `authBodyCap`, `authRateLimit`, the `hooks.before` email bucket,
`resolveRateLimitPrincipal`, the `AUTH_RATE_LIMIT_PORT` declaration, `LocalAuthRateLimiter`
and the three integration tests in `rate-limit.md`.

You **append** `emailRateLimitHook` to the `beforeHooks` array TASK-009 creates; you do not
replace it. The port is required at boot, not `@Optional()`.

Your three integration tests are what pins `ctx.path` being base-path-relative. ADR-0013
now leans on them for that, so they are **required rather than advisory**. You do not own
`assertBffProxySecretConfigured()` or its call in `main.ts` — those stay with TASK-009,
whose `paths` reach `main.ts` while yours do not.
