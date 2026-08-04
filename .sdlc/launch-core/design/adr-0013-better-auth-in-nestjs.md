---
id: ADR-0013
slug: launch-core
title: Mount Better Auth's node handler directly on Express, ahead of Nest
status: accepted
supersedes: null
date: 2026-08-04
---

## Context

`refinement.md` names Better Auth inside NestJS as a risk with thinner public prior art
than the Next.js pairing, and says a timeboxed spike is the right response if it
resists during Design rather than improvisation.

It did not resist. Better Auth publishes a NestJS integration page recommending the
community package `@thallesp/nestjs-better-auth`, and the underlying mechanism is
`toNodeHandler(auth)` mounted on the Express instance with NestJS's own body parser
disabled. Both the mechanism and the caveat are documented. **No spike is needed.**

The community package registers a global `AuthGuard` that protects every route unless
decorated. That collides with three things this initiative already fixed: TASK-011's
own `AuthGuard`, TASK-017's `WorkspaceGuard`, and ADR-0002's requirement that
`TenantTransactionInterceptor` runs after authentication and before the handler. It
also puts the most security-critical component of the system behind a community
dependency.

## Decision

**Mount the handler directly. Do not take the community package.**

```ts
// apps/api/src/main.ts
const app = await NestFactory.create(AppModule, { bodyParser: false });

const server = app.getHttpAdapter().getInstance();

// Must precede any body parser: Better Auth reads the raw request stream.
// NestJS 11 ships Express 5, whose wildcard syntax is {*splat}, not *.
server.all(
  '/api/auth/{*splat}',
  authBodyCap({ maxBytes: 32 * 1024 }),   // bounds the body without consuming the stream
  authRateLimit(redisClient),             // IP-keyed only: headers, never the body
  toNodeHandler(auth),
);

app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: true, limit: '100kb' }));

app.setGlobalPrefix('api', { exclude: [{ path: 'health', method: RequestMethod.GET }] });
```

Ordering is the whole trick, and it is one registration in one file rather than a module
whose middleware ordering has to be reasoned about.

**The two middlewares are the fix for what mounting ahead of Nest costs.** Added
2026-08-04 (F-004): the mount sits outside the Nest graph, so `RateLimitGuard` cannot
see it (that guard keys on `tenantId` from `AuthGuard`, which has not run) and
`express.json`'s limit does not apply. That left the unauthenticated credential surface
with no throttle and no body cap: unlimited credential stuffing, unlimited sign-up, each
one creating a tenant row and dispatching a verification email until Resend's 100-a-day
free tier is exhausted and every legitimate signup silently fails, and a multi-gigabyte
body read into memory on the single machine that must never return 5xx to a visitor.

`authBodyCap` **does not parse**. `express.json({ limit })` would consume the stream
Better Auth needs, which is the whole reason for `bodyParser: false`. It rejects with
413 when `Content-Length` exceeds the cap, and for a chunked request with no or an
understated `Content-Length` it counts bytes as they pass and destroys the socket once
the cap is crossed, without a response body.

`authRateLimit` reuses `redisClient` (GC-3, no second connection) and carries ADR-0012's
degradation posture verbatim: on a Redis error it falls back to an in-process bucket
rather than failing open or closed. Limits are tighter than the 120-per-60s tenant
limit, because these are pre-auth:

| Route | Key | Limit | Enforced by |
|---|---|---|---|
| `POST /api/auth/sign-in/email` | IP | 10 / 5 min | Express middleware |
| `POST /api/auth/sign-in/email` | email | 5 / 15 min | **Better Auth `hooks.before`** |
| `POST /api/auth/sign-up/email` | IP | 3 / hour | Express middleware |
| everything else under `/api/auth/*` | IP | 60 / min | Express middleware |

**The email bucket runs inside Better Auth, not in Express.** Revised 2026-08-04
(F-019): the email lives in the JSON body, and reading it from Express middleware
consumes the stream Better Auth needs, which is the same rule that stops `authBodyCap`
parsing. The two constraints contradicted each other, and the cheap resolution is to
drop the email bucket, leaving an attacker across 1,000 IPs 10,000 password guesses per
5 minutes against one named account.

The IP buckets need only headers, so they stay in Express. The email bucket becomes a
`hooks.before` middleware inside Better Auth, where the framework that owns the body has
already parsed it:

```ts
betterAuth({
  hooks: {
    before: createAuthMiddleware(async (ctx) => {
      if (ctx.path !== '/sign-in/email') return;
      const principal = sha256(normaliseEmailForKey(ctx.body.email));
      await authRateLimit.check('signInPerEmail', principal);  // throws APIError 429
    }),
  },
})
```

Same Redis client, same key format, same degradation posture, and nothing buffers or
re-emits a request stream.

Two details this bucket lives or dies on, both silent when wrong (F-025). The key is
hashed over `email.trim().toLowerCase()`, matching the form Better Auth uses for its
account lookup, so a case-varied address cannot mint a fresh allowance. And the
`ctx.path` predicate assumes a base-path-relative value; if that is wrong the hook
returns on every request and the bucket does not exist. Three integration tests in
`rate-limit.md` pin the key, the predicate and the 429 together, because no AC covers
pre-auth limiting and nothing else would notice.

Both the Express middlewares and the hook reach Redis through `AUTH_RATE_LIMIT_PORT`
rather than through `redisClient` directly, which is what lets TASK-009 build them in
wave 2 against a dependency TASK-030 does not produce until wave 6 (F-024).

Recorded in `rate-limit.md`'s Scope section, which previously read as though the surface
simply had no limit.

**Better Auth shares the application's Drizzle client** through
`drizzleAdapter(db, { provider: 'pg' })`. Its tables are generated once with the Better
Auth CLI, checked into `apps/api/src/db/schema/auth.ts`, and owned from then on by
drizzle-kit. One migration system, which ADR-0004 and ADR-0019 both depend on.

**Auth tables carry no `tenant_id` and no RLS.** ADR-0003 explains why this is not a
GC-5 exception and ADR-0015 explains where the tenant relation lives instead.

**Plugins: `jwt` and `bearer`.** Claim set, fixed here because ADR-0002's `AuthGuard`
reads it without a database query:

```ts
jwt({
  jwt: {
    expirationTime: '5m',
    definePayload: async ({ user }) => ({
      sub: user.id,
      email: user.email,
      ev: user.emailVerified,
      tid: await tenantIdForUser(user.id),
    }),
  },
})
```

| Claim | Meaning | Read by |
|---|---|---|
| `sub` | user id | `RequestContext.userId` |
| `tid` | tenant id | `RequestContext.tenantId`, then `set_config('app.tenant_id', ...)` |
| `ev` | email verified | AC-17's 403 `email_not_verified` |
| `jti`, `exp`, `iat`, `iss`, `aud` | standard | signature and revocation checks |

`tid` is what removes the guard's chicken-and-egg problem: the guard needs a tenant to
open the transaction, and a database lookup for it would have to run outside tenant
context.

**Verification is stateless, against cached JWKS.** `AuthGuard` fetches
`/api/auth/jwks` once and caches the key set in process for 10 minutes. No database
read, no Redis read on the happy path.

**Revocation.** Sign-out pushes `jti` into Redis at `revoked:jti:<jti>` with a TTL
equal to the token's remaining life. `AuthGuard` checks it. With Redis unavailable the
check is skipped, matching ADR-0012's posture, so a captured token stays usable for at
most its remaining 5 minutes. Bounded, stated, and the reason the lifetime is 5 minutes
rather than the library default of 15.

**`onUserCreated` is a Better Auth `databaseHooks.user.after` hook,** which TASK-013
attaches tenant creation to, inside the same transaction as the user insert.

## Alternatives considered

| Option | Pros | Cons | Why not |
|---|---|---|---|
| `@thallesp/nestjs-better-auth` | Documented on Better Auth's own site; `@Session()` decorator; re-adds body parsers for non-auth routes; less code to own | Registers a global guard that has to be fought or disabled, competing with TASK-011 and TASK-017 and with the interceptor ordering ADR-0002 depends on. It is a community package in the authentication path, so its release cadence gates Better Auth upgrades | The ergonomics it adds are small; the control it takes away is over the exact thing SC-1 rests on |
| Nest middleware in an `AuthModule` via `configure(consumer)` | The mount lives in the module graph and is unit-testable | Nest applies middleware after its own pipeline setup, so guaranteeing it runs before `express.json` needs care, and the ordering becomes implicit. It also puts a raw-stream handler inside a module that AC-55's graph test then has to reason about | Three explicit lines beat implicit ordering for something whose failure mode is a silently empty request body |
| Hand-rolled auth: argon2, sessions table, own JWT issuance | Total control; no framework-integration risk at all | Password reset, verification tokens, session rotation and account linking all become code to write and get right. The refinement fixed Better Auth | Reinvents a solved problem, and contradicts a fixed decision |
| Better Auth in Next.js, NestJS verifying its JWTs | The well-trodden pairing; most prior art | Splits authentication across two deployables and puts user writes in the frontend app. The refinement fixed Better Auth mounted in NestJS | Contradicts a fixed decision |

## Consequences

### Positive

- The mount is three lines whose ordering constraint is written in a comment above
  them. Nothing hidden.
- Authentication adds zero database round trips per request, so ADR-0002's interceptor
  can open the tenant transaction immediately after the guard.
- Better Auth's tables live in the same migration system as everything else, so
  ADR-0019's enumeration sees a complete picture of the database.
- The risk `refinement.md` flagged is closed with a documented mechanism rather than a
  spike.

### Negative / accepted cost

- Roughly 50 lines of mounting, JWKS caching and revocation are hand-written and owned
  forever, plus the body cap and the pre-auth limiter that the community package's
  in-graph mount would have got from Nest for free. A Better Auth release changing
  `toNodeHandler`'s signature or its plugin config breaks the build, and no community
  package absorbs it. **`better-auth` is pinned to an exact version** rather than a
  caret range for exactly this reason (F-016).
- `authBodyCap` counts bytes on a stream it must not consume. That is fiddlier than a
  parser limit and the failure mode of getting it wrong is a hung request rather than an
  error. Its chunked path destroys the socket with no response, so a legitimate oversized
  upload sees a connection reset rather than a 413.
- Rate limiting for the auth surface now lives in **two** places, Express for the IP
  buckets and a Better Auth hook for the email bucket, which is one more place to look
  when a 429 is unexpected. Splitting it is what avoids buffering and re-emitting a
  request stream, and the split follows the body: whoever has parsed it does the check.
- The pre-auth limiter is a third rate-limiting implementation alongside the Redis
  tenant limiter and its local fallback. All four buckets share ADR-0012's posture and
  none of them shares code.
- The email bucket depends on Better Auth's `hooks.before` API and on `ctx.body.email`
  keeping its shape. That is a second place a Better Auth upgrade can break
  authentication, alongside the mount itself.
- Email-keyed sign-in limiting is itself an enumeration oracle: an attacker learns which
  addresses have accounts by watching which ones start returning 429 sooner. The IP key
  bounds the volume enough that this is worth accepting, and it is stated rather than
  hidden.
- `bodyParser: false` is a global setting made for one route. Any future middleware
  added before `app.use(express.json())` silently receives an unparsed body, and the
  symptom is `undefined` rather than an error.
- The `/api/auth/*` mount sits outside the Nest module graph, so AC-55's test cannot
  see it and no Nest guard, interceptor or filter applies to it. Better Auth's own
  error responses do not match `ErrorEnvelope`. TASK-009 has to map them at the web
  client boundary, and the contract records the exception.
- A 5-minute token means the web app refreshes roughly twelve times an hour per active
  session. ADR-0014 owns that traffic.
- Revocation is best-effort. With Redis down, a stolen token works for up to 5 minutes
  after sign-out. AC-21 passes because the browser's cookies are cleared; a test that
  replays a captured bearer token would see the gap.

### Follow-ups this creates

**TASK-009 owns the entire auth surface, including its rate limiting.** Added
2026-08-04 (F-024): the previous list omitted the limiter and the body cap entirely,
while `rate-limit.md` named TASK-051 as their producer. TASK-051 cannot write
`apps/api/src/auth/**`, and TASK-009 runs in wave 2 while `redisClient` arrives with
TASK-030 in wave 6. Nobody owned the bucket and nothing said how a wave-2 mount reaches
a wave-6 dependency.

- TASK-009 owns the mount, the plugin configuration, `tenantIdForUser`, JWKS caching,
  and an e2e test asserting `POST /api/auth/sign-up/email` receives a parsed body.
- TASK-009 also owns `authBodyCap`, `authRateLimit`, the `hooks.before` email bucket,
  the `AUTH_RATE_LIMIT_PORT` declaration, and `LocalAuthRateLimiter`, plus the three
  integration tests in `rate-limit.md` that pin the email bucket's key, predicate and
  429 together.
- **TASK-051 binds `RedisAuthRateLimiter` to that token** and owns nothing inside
  `apps/api/src/auth/**`. The local limiter stays bound as ADR-0012's degraded fallback.
  The upgrade is per-machine to per-fleet; TASK-051 does not introduce the bucket.
- TASK-011 owns `AuthGuard`, the revocation check, and the mapping from claims to
  `RequestContext`.
- TASK-008 maps Better Auth's native error bodies onto `ErrorEnvelope` at the client
  boundary, **including reading `retryAfterSeconds` from a 429 body when the header is
  absent** (F-027).
- Contracts: `design/contracts/auth-tokens.md`, `design/contracts/rate-limit.md`.
- **TASK amendments this implies** are recorded in the design return for Juano's ruling,
  not applied here: TASK-009 needs `apps/api/src/main.ts` in `paths` and `rate-limit.md`
  in `contracts`.
