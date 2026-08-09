---
id: ADR-0013
slug: foundation
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
  authRateLimit(authRateLimitPort),       // IP-keyed only: headers, never the body.
                                          // Through AUTH_RATE_LIMIT_PORT (F-024), never
                                          // redisClient directly; principal from
                                          // resolveRateLimitPrincipal (F-031).
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
      // ctx.body is UNVALIDATED here. See below.
      const principal = normaliseEmailForKey(ctx.body?.email);
      if (principal === null) return;
      await authRateLimit.check('signInPerEmail', sha256(principal));  // throws APIError 429
    }),
  },
})
```

Same Redis client, same key format, same degradation posture, and nothing buffers or
re-emits a request stream.

**`hooks.before` runs ahead of the endpoint's zod validation, so `ctx.body` is whatever
the client sent.** Added 2026-08-07 (F-228). Probes against 1.6.26 delivered
`ctx.body.email` as an object, as a number, and `ctx.body` itself as `undefined`, each
time reaching the hook before the endpoint returned its 400. This ADR previously wrote
`normaliseEmailForKey(ctx.body.email)` with no guard, and `rate-limit.md` claimed an
absent body "gives a 500 on every sign-in, which nobody misses". Neither holds: the 500
happens only on the requests an attacker chooses to send.

`normaliseEmailForKey` therefore takes `unknown` and returns `string | null`. It returns
`null` for anything that is not a string, and for a string that normalises to empty. The
hook returns on `null` and the request continues to the endpoint, which rejects it with
the same 400 `VALIDATION_ERROR` it would have returned anyway.

**Falling through is deliberate and it is not a bypass.** A request with no usable address
cannot be attributed to an account, so there is no email bucket to charge it to, and
inventing a shared sentinel bucket would let one attacker's malformed requests exhaust a
bucket that legitimate traffic falls into. The IP bucket in Express still counts the
request, so the volume is bounded, and the endpoint still rejects it.

**Throwing instead is the failure this guard exists to prevent.** `dist/api/dispatch.mjs:
86-89` rethrows anything from a before hook that is not an `APIError`, aborting the
request before the endpoint runs. A `TypeError` from `.trim()` on a number means the
attempt is never recorded against the bucket, the response is a 500 rather than a 400, and
`beforeHooks` never reaches the later entries. An unauthenticated caller would get an
unlimited 500 generator against the credential surface with the email bucket charging
nothing.

Two details this bucket lives or dies on, both silent when wrong (F-025). The key is
hashed over `email.trim().toLowerCase()`, matching the form Better Auth uses for its
account lookup, so a case-varied address cannot mint a fresh allowance. And the
`ctx.path` predicate assumes a base-path-relative value; if that is wrong the hook
returns on every request and the bucket does not exist. Four integration tests in
`rate-limit.md` pin the key, the predicate, the 429 and the malformed-body guard
together, because no AC covers pre-auth limiting and nothing else would notice.

Both the Express middlewares and the hook reach Redis through `AUTH_RATE_LIMIT_PORT`
rather than through `redisClient` directly, which is what lets TASK-058 build them
against a dependency TASK-030 does not produce until wave 6 (F-024, re-attributed by
F-054).

Recorded in `rate-limit.md`'s Scope section, which previously read as though the surface
simply had no limit.

**Better Auth shares the application's Drizzle client** through
`drizzleAdapter(db, { provider: 'pg' })`. Its tables are generated once with the Better
Auth CLI, checked into `apps/api/src/db/schema/auth.ts`, and owned from then on by
drizzle-kit. One migration system, which ADR-0004 and ADR-0019 both depend on.

**Auth tables carry no `tenant_id` and no RLS.** ADR-0003 explains why this is not a
GC-5 exception and ADR-0015 explains where the tenant relation lives instead.

**Better Auth's own rate limiter is disabled. We are the limiter of record.**

```ts
betterAuth({ rateLimit: { enabled: false }, /* ... */ })
```

Added 2026-08-04 (F-030). **Figures re-read against the pinned `better-auth@1.6.26`
rather than against the documentation, 2026-08-07 (F-229).** The original wording was
verified against current-latest docs at design time, and three of its numbers did not
survive the pin. The decision did not move; the numbers below are the release's.

The built-in limiter is disabled in development and **enabled in production by default**
(`dist/context/create-context.mjs:171`, `enabled: options.rateLimit?.enabled ??
isProduction`), at **10 seconds** and 100 requests
(`create-context.mjs:172-173`), backed by an in-memory store, and it returns
`X-Retry-After` on a 429 (`dist/api/rate-limiter/index.mjs:64-69`). An explicit
`enabled: false` still wins. Nothing in this design had disabled, configured or accounted
for it.

Four reasons, and the last two are worse than the debugging-trap argument:

1. Two limiters on one surface is a debugging trap. A 429 with no obvious cause costs
   an afternoon.
2. It is invisible everywhere it would be caught: off in development, off in the test
   environment the three `rate-limit.md` integration tests run in, on only in production.
3. **Its header is `X-Retry-After`, not `Retry-After`.** `apiClient` reads `Retry-After`
   and falls back to a `retryAfterSeconds` body field (F-027), and its body carries no
   `code: "rate_limited"`. So a 429 from it maps to `internal_error` and the login
   screen shows the generic error, which is exactly the outcome F-027 was filed to
   prevent. Verified unchanged in 1.6.26.
4. **It is IP-keyed**, and under the BFF topology its key would be Vercel's egress
   address rather than the visitor's (see below), so it would limit the entire product
   collectively. That is the load-bearing half and it is unchanged.

   This reason previously also read "its store is in-memory and unbounded, which is
   F-028's defect inside a dependency where we cannot add the cap". **That half is false
   for 1.6.26.** `dist/api/rate-limiter/index.mjs:6-18` caps the map at
   `MEMORY_STORE_MAX_ENTRIES = 1e5` and `pruneMemoryStore()` drops expired entries first,
   then evicts in insertion order on overflow. Corrected rather than deleted, because a
   reader who checks reason 4 against the package should find the record of the check.

Disabling a framework's security default deserves the explicit note: we are not removing
a protection, we are removing a **second** one that is weaker, mis-keyed, and shaped
wrong for our client.

Our buckets are correctly keyed, and on sign-in they are tighter over the window that
matters. The comparison figure here used to read "10 per 5 minutes on sign-in against its
100 per 60 seconds across everything", which does not describe 1.6.26:
`getDefaultSpecialRules()` (`rate-limiter/index.mjs:370-384`) gives any path starting
`/sign-in`, `/sign-up`, `/change-password` or `/change-email` its own 3-per-10-seconds
rule, and password-reset and verification-email paths 3 per 60 seconds. **The built-in
sign-in rule is stricter per burst than ours and looser per five minutes**: 3 per 10 s
sustains 90 attempts in five minutes where our bucket allows 10. Ours still binds on the
attack that matters, which is sustained guessing, and it is keyed on the address as well
as the address's source. The 100-per-60-seconds figure applied to everything else and does
not apply here.

**Plugins: `jwt` and `bearer`.** Claim set, fixed here because ADR-0002's `AuthGuard`
reads it without a database query:

```ts
jwt({
  jwt: {
    expirationTime: '5m',
    definePayload: async ({ user, session }) => ({
      // `jti` is the session id, not a per-token random. See below: it is the
      // revocation handle, and sign-out holds a session rather than a token.
      jti: session.id,
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
| `jti` | Better Auth session id, and the revocation handle | `AuthGuard`'s revocation check |
| `exp`, `iat`, `iss`, `aud` | standard | signature and expiry checks |

`tid` is what removes the guard's chicken-and-egg problem: the guard needs a tenant to
open the transaction, and a database lookup for it would have to run outside tenant
context.

**`definePayload` returns `jti`, because Better Auth does not issue one on its own.**
Added 2026-08-07 (F-227), ruled by Juano. `dist/plugins/jwt/sign.mjs:49` reads `if
(payload.jti) jwt.setJti(payload.jti)`, so the claim exists only when `definePayload`
puts it there. A probe against 1.6.26 using this ADR's own config returned `aud, email,
ev, exp, iat, iss, sub, tid` and no `jti`. Revocation below keys on `jti`, so without this
line sign-out would write a key nobody looks up, `AuthGuard` would read `undefined`, and
the prior credential would keep working for its remaining lifetime while the logout
reported success. AC-21 asserts the opposite.

**`jti` is the Better Auth session id, not a fresh random per token.** Both are
implementable and the choice decides whether revocation works at all. A random `jti`
changes on every mint, and the web app mints roughly twelve per hour per session
(ADR-0014), so a random one can only be revoked by whoever holds that exact token.
Sign-out does not: `dist/api/routes/sign-out.mjs:20-22` reads the session cookie and
deletes the session row, and no token is presented. Every token minted before the sign-out
would survive it. Keying on the session id means one entry revokes every token the session
ever issued, past and future, which is what "log out" is understood to mean.

The cost is that `jti` is no longer unique per token, which is what RFC 7519 §4.1.7
describes it as. Nothing here uses it for replay detection, and adding a second `sid`
claim to keep `jti` unique would add a claim no code reads. The session id is a row id,
not the session token in the cookie, so this exposes no credential. **If a later change
needs per-token replay detection, `jti` is taken and that change adds `sid` and moves
revocation onto it.**

The claim also does not need `sub`. `sign.mjs:53-61` spreads `definePayload`'s return and
**then overwrites `sub`** with `getSubject?.(session) ?? session.user.id`. This ADR
previously wrote `sub: user.id` inside `definePayload`, which resolved to the same value
and had no effect. Removed 2026-08-07 (F-227) so the line does not read as load bearing.
`sub` is still in the claim table and still `user.id`; Better Auth sets it.

**Verification is stateless, against cached JWKS.** `AuthGuard` fetches
`/api/auth/jwks` once and caches the key set in process for 10 minutes. No database
read, no Redis read on the happy path.

**Revocation.** Deleting a session pushes its id into Redis at `revoked:jti:<jti>` with a
TTL of the **full** token lifetime, 300 seconds, counted from the write. `AuthGuard`
checks it. With Redis unavailable the check is skipped, matching ADR-0012's posture, so a
captured token stays usable for at most its remaining 5 minutes. Bounded, stated, and the
reason the lifetime is 5 minutes rather than the library default of 15.

Two details corrected 2026-08-07 (F-227), both consequences of `jti` being the session id:

**The TTL is 300 seconds, not the presented token's remaining life.** The write site holds
a session, not a token, so there is no `exp` to subtract from. A token minted one second
before sign-out has 299 seconds left, so anything shorter than the full lifetime lets a
live token outlive its own revocation entry. 300 seconds from the write covers every token
the session can have outstanding.

**The write site is `databaseHooks.session.delete.after`, not a `/sign-out` handler.**

```ts
betterAuth({
  databaseHooks: {
    session: {
      delete: {
        after: async (session) => {
          await revocationStore.revoke(session.id);   // TTL 300s. Best-effort.
        },
      },
    },
  },
})
```

`dist/db/with-hooks.mjs:115-147` reads the row before deleting it and passes the whole row
to `delete.after`, so `session.id` is available even though
`internalAdapter.deleteSession` is called with the session token. `deleteManyWithHooks`
does the same per row, so this one hook covers sign-out, `revoke-session`,
`revoke-other-sessions`, delete-user, and any bulk session deletion, rather than sign-out
alone. Hooking `/sign-out` would have left the other four paths issuing no revocation.

`delete.after` is queued to run after the transaction commits, so a Redis failure cannot
roll back the session deletion. It must not throw: the session is already gone, and
failing the sign-out response because Redis is down contradicts ADR-0012's posture. A
failed revocation write degrades to the same 5-minute window as a failed revocation read,
and increments `auth_revocation_degraded_total`.

**`onUserCreated` is a Better Auth `databaseHooks.user.after` hook,** which TASK-013
attaches tenant creation to. It runs **after** the user row commits, so the membership is
a separate transaction and signup is not atomic across the two. Corrected 2026-08-04
(F-029); ADR-0015 holds the residue argument and the two mechanisms that make it safe.

**`hooks.before` has three owners and one slot, so it is a registry.** Re-attributed
2026-08-04 (F-054). Better Auth takes a single `before` function. TASK-009 creates
`auth.config.ts` with an empty registry, TASK-058 appends the email rate limiter, and
TASK-013 appends invitation validation, eight waves later. If either appender replaces
rather than extends, the email bucket silently vanishes and F-019 returns.

```ts
// apps/api/src/auth/auth.config.ts. TASK-009 creates this shape, empty.
const beforeHooks: AuthBeforeHook[] = [
  emailRateLimitHook,        // TASK-058 APPENDS.
  invitationValidationHook,  // TASK-013 APPENDS. It does not replace.
];

hooks: { before: createAuthMiddleware(async (ctx) => {
  for (const hook of beforeHooks) await hook(ctx);   // ordered, short-circuit on throw
}) }
```

Rate limiting runs first, so an attacker cannot use invitation-token probing to bypass
it. A hook that does not apply to `ctx.path` returns immediately.

TASK-058's four integration tests fail loudly if a later author replaces the array,
which is why this is a stated rule rather than a mechanism. They land before TASK-013
appends, so the protection is in place when the second appender arrives.

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
  error responses do not match `ErrorEnvelope`. TASK-008 has to map them at the web
  client boundary, and the contract records the exception.
- A 5-minute token means the web app refreshes roughly twelve times an hour per active
  session. ADR-0014 owns that traffic.
- Revocation is best-effort. With Redis down, a stolen token works for up to 5 minutes
  after sign-out. AC-21 passes because the browser's cookies are cleared; a test that
  replays a captured bearer token would see the gap.
- **`jti` carries the session id, so it is not unique per token and cannot later be used
  for replay detection.** A change that needs that has to add a `sid` claim and move
  revocation onto it, touching TASK-009's mint and TASK-011's guard together. Accepted
  because the alternative was a revocation mechanism that sign-out cannot reach.
- The session id appears in a JWT the BFF holds and passes to the API. It is a row id
  rather than the session token, so it grants nothing, and it is one more identifier that
  must never reach a log body under GC-9.
- Revocation writes now happen on every session deletion, including expired-session
  cleanup, so Redis takes a write per deleted row where before it took one per sign-out.
  The keys are 300-second TTLs on a small value, and the trade buys revocation coverage on
  `revoke-session`, `revoke-other-sessions` and delete-user, which a sign-out-only hook
  would have missed entirely.
- The email bucket ignores requests whose body carries no usable address. That is the
  right call for a bucket keyed on an address, and it means the email bucket contributes
  nothing against a caller sending deliberately malformed bodies. Only the IP bucket
  bounds that traffic.

### Follow-ups this creates

**TASK-009 mounts the auth surface; TASK-058 protects it.** Re-attributed 2026-08-04
(F-054). This list previously read "TASK-009 owns the entire auth surface, including its
rate limiting", which was true when F-024 added it. Juano split the protection surface
out to TASK-058 on 2026-08-04, after Design roughly doubled TASK-009's scope, and the
list did not follow. TASK-058 depends on TASK-009 and lands in the same wave sequence,
so F-024's original point still holds: the auth surface protection has a named owner
inside `apps/api/src/auth/**`, and it is not TASK-051.

- TASK-009 owns the mount, the plugin configuration, `tenantIdForUser`, JWKS caching,
  and an e2e test asserting `POST /api/auth/sign-up/email` receives a parsed body.
- TASK-009 also owns `assertBffProxySecretConfigured()` and its call in
  `apps/api/src/main.ts`. `main.ts` is in TASK-009's `paths` and in nobody else's, so
  TASK-058 cannot write it. Without that assertion production boots with
  `BFF_PROXY_SECRET` unset, the trusted-proxy branch turns itself off, and every
  IP-keyed bucket collapses onto Vercel's egress address.
- **TASK-058 owns `authBodyCap`, `authRateLimit`, the `hooks.before` email bucket,
  `resolveRateLimitPrincipal`, the `AUTH_RATE_LIMIT_PORT` declaration, and
  `LocalAuthRateLimiter`**, plus the four integration tests in `rate-limit.md` that pin
  the email bucket's key, predicate and 429 together. The port is required at boot
  rather than `@Optional()`: an unbound token fails startup, because a missing limiter
  opens the credential surface where a missing branding port only degrades a 404.
- **TASK-051 binds `RedisAuthRateLimiter` to that token** and owns nothing inside
  `apps/api/src/auth/**`. The local limiter stays bound as ADR-0012's degraded fallback.
  The upgrade is per-machine to per-fleet; TASK-051 does not introduce the bucket.
- `design/contracts/rate-limit.md`'s ownership table predates the split and still
  assigns auth-surface pieces to TASK-009. Parked as F-037, with the correction written
  into both TASK files. This list is the current attribution; that table is not. Parked
  F-036 covers a second stale line, the `principal` doc comment in
  `design/stubs/apps/api/src/auth/ports/auth-rate-limit.port.ts`, which still says
  "platform-trusted client IP" where the rule is `resolveRateLimitPrincipal(headers)`.
- TASK-011 owns `AuthGuard`, the revocation check, and the mapping from claims to
  `RequestContext`. It reads `jti` as an opaque revocation handle and must not assume it
  is unique per token (F-227).
- **TASK-009 owns the `jti` claim and the `databaseHooks.session.delete.after` revocation
  write**, both in `apps/api/src/auth/auth.config.ts`, plus a unit test asserting the
  composed config's `definePayload` returns a `jti` equal to the session id. Added
  2026-08-07 (F-227). The claim and the write are two halves of one mechanism and they
  live in the same file; splitting them across TASK-009 and TASK-011 would let the mint
  land without the write, and the symptom is a logout that reports success and revokes
  nothing. The revocation write reaches Redis through the same port pattern the buckets
  use, so it does not depend on TASK-030's `redisClient` existing in wave 2.
- **TASK-058's `normaliseEmailForKey` takes `unknown` and returns `string | null`**, and
  the hook returns rather than throwing when it gets `null` (F-228). `rate-limit.md` gains
  a fourth required integration test for it: a sign-in body whose `email` is a JSON object
  returns the endpoint's 400 and not a 500, and does not consume the bucket. The set that
  pins this hook is now four tests, not three.
- TASK-008 maps Better Auth's native error bodies onto `ErrorEnvelope` at the client
  boundary, **including reading `retryAfterSeconds` from a 429 body when the header is
  absent** (F-027).
- Contracts: `design/contracts/auth-tokens.md`, `design/contracts/rate-limit.md`.
- **TASK-058 and TASK-013 both append to `beforeHooks`. Neither replaces the array.**
  TASK-009 creates it empty (F-054).
- TASK-009 sets `rateLimit: { enabled: false }`, owns the comment saying why, **and
  owns a unit test asserting the composed `betterAuth` config carries
  `rateLimit.enabled === false`**. Of the four verified Better Auth facts this design
  leans on, this is the only one that degrades silently and only in production. The hook
  signature and `ctx.body.email` fail loudly, and TASK-058's four integration tests pin
  the `ctx.path` predicate, so those three need no separate assertion. This one gets its
  own pin.

  **The unit test stays with TASK-009 even though the argument for it now spans two
  TASKs.** Noted 2026-08-04 (F-054). TASK-009 writes `auth.config.ts` and the `rateLimit`
  key, so the test that reads the composed config belongs beside the code that sets it,
  and it must run in wave 2 rather than waiting for TASK-058. The `ctx.path` clause above
  reduces what TASK-009 has to assert; it does not move anything into TASK-058. This
  matches TASK-009's `## Approach`. The obligation to re-verify all four facts against
  the pinned version travels with TASK-009's own pinning step (ADR-0018). Re-attributed
  from TASK-001 on 2026-08-04 (F-040).
