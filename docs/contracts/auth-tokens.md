# Contract: JWT claims, verification, and request context

- **Boundary:** Better Auth (issuer) to `AuthGuard` (verifier) to every authenticated handler; and the Next.js BFF (holder).
- **Normative form:** types below; issuance config in `apps/api/src/auth/auth.config.ts`.
- **Produced by:** TASK-009 (issuance), TASK-011 (verification, `RequestContext`, `@Public()`).
- **Consumed by:** TASK-010, 011, 012, 013, 014, 017, 018, 021, 025, 040, 045, 049, 051, 053, 054, 056.
- **ADRs:** ADR-0013, ADR-0014, ADR-0015, ADR-0002.

## Claim set

```ts
export interface ShortkitJwtClaims {
  sub: string;      // user id. SET BY BETTER AUTH, not by definePayload (F-227).
  tid: string;      // tenant id (uuid). ADR-0015: exactly one per user.
  email: string;
  ev: boolean;      // email verified
  jti: string;      // Better Auth SESSION id. Revocation handle. NOT unique per token.
  iat: number;
  exp: number;      // iat + 300
  iss: string;      // API base URL
  aud: string;      // API base URL
}
```

Issued by Better Auth's `jwt` plugin with `expirationTime: '5m'` and a `definePayload`
returning `{ jti, tid, email, ev }`.

**`definePayload` must return `jti`.** Corrected 2026-08-07 (F-227). `better-auth@1.6.26`
sets the claim only when the payload carries it (`dist/plugins/jwt/sign.mjs:49`,
`if (payload.jti) jwt.setJti(payload.jti)`). A probe with the previous config returned
`aud, email, ev, exp, iat, iss, sub, tid` and no `jti`, which would leave the revocation
step below reading `undefined` and matching nothing.

**`definePayload` must NOT return `sub`.** `sign.mjs:53-61` spreads the returned object
and then overwrites `sub` with `getSubject?.(session) ?? session.user.id`. A `sub` in
`definePayload` is inert. `sub` is still in the claim set above; Better Auth sets it.

**`jti` is `session.id`, so every token minted for one session carries the same `jti`.**
This is deliberate (ADR-0013): sign-out holds a session and no token, so a per-token
random `jti` would be unrevokable. Callers may not treat `jti` as a per-token nonce and
may not use it for replay detection.

## Endpoints

| Method | Path | Auth | Notes |
|---|---|---|---|
| `POST` | `/api/auth/sign-up/email` | public | body `{ email, password, name, invitationToken? }`. `name` is **required** (F-234). Requires `Origin` (F-233). |
| `POST` | `/api/auth/sign-in/email` | public | body `{ email, password }`. Requires `Origin` (F-233). |
| `POST` | `/api/auth/sign-out` | session | deletes the session, which fires the revocation write (below). Requires `Origin` (F-233). |
| `GET` | `/api/auth/get-session` | session | no `Origin` required; Better Auth skips the origin check on `GET` |
| `GET` | `/api/auth/token` | session | mints a JWT. No `Origin` required |
| `GET` | `/api/auth/jwks` | public | public key set |

These are mounted outside Nest (ADR-0013). **Their error bodies are Better Auth's
native shape, not `ErrorEnvelope`.** TASK-008 maps them at the client boundary.

Session-authenticated routes accept `Authorization: Bearer <better-auth session token>`
through the `bearer` plugin. That is the session token from the sign-in response, held by
the BFF as `sk_rt`, and not the JWT.

### The sign-up body: `name` is required

Corrected 2026-08-08 (F-234). This table previously wrote `name?`. `better-auth@1.6.26`
declares the endpoint body as `z.object({ name: z.string(), email: z.email(),
password: z.string().nonempty(), ... }).and(z.record(z.string(), z.any()))`
(`dist/api/routes/sign-up.mjs:14-21`). A body without `name` is rejected before the
handler runs:

```
400 {"message":"[body.name] Invalid input: expected string, received undefined","code":"VALIDATION_ERROR"}
```

**The mount cannot relax this.** `name: z.string()` is written into the endpoint's own
schema, not derived from configuration, so no `betterAuth` option makes it optional. The
choice is where the value comes from, and it is the signup form: TASK-012's `/signup`
screen collects a display name and sends it. See ADR-0014 for why the alternative, a
default supplied inside the proxy, was rejected.

The trailing `.and(z.record(z.string(), z.any()))` is what lets `invitationToken` ride
along on the same body without failing validation (TASK-013).

`name: ""` is accepted and returns 200. It is not a valid value for this product; the
signup form must reject an empty name client-side before the request is sent.

### Password policy

Stated 2026-08-08, ruled by Juano (F-235). AC-16 requires "a password meeting the stated
policy" and this is the stated policy:

> **Minimum 8 characters. No composition requirement: no mandatory uppercase, digit,
> or symbol. Maximum 128 characters.**

These are `better-auth@1.6.26`'s own defaults, not overrides. `dist/context/create-context.mjs:185-186`
reads `minPasswordLength: options.emailAndPassword?.minPasswordLength || 8` and
`maxPasswordLength: options.emailAndPassword?.maxPasswordLength || 128`, and
`dist/api/routes/sign-up.mjs:152-158` enforces both. Probed against the pin: 7 characters
returns 400, 8 returns 200, 128 returns 200, 129 returns 400.

**`auth.config.ts` sets neither key.** The contract states the library's default so that
the two agree. Setting a stricter value here would require the mount to configure it as
well, and a contract that states one number while the mount leaves another in force is
exactly the divergence F-234 records.

Length-only matches current NIST guidance. Composition rules push users toward
predictable substitutions and buy little.

**What `sdlc-product-auditor` verifies AC-16's "stated policy" clause against:** this
section. A password of 8 or more characters and 128 or fewer, with any composition, is
policy-compliant. A password of 7 or fewer characters is not, and signup rejects it with
`400 PASSWORD_TOO_SHORT`. TASK-009's test 4 uses a one-character password, which is below
this floor, so it verifies the clause as stated.

### `Origin` is required on state-changing auth routes

Added 2026-08-08 (F-233). `better-auth@1.6.26` rejects a state-changing request to
`/api/auth/*` that carries no `Origin` header:

```
403 {"message":"Missing or null Origin","code":"MISSING_OR_NULL_ORIGIN"}
```

and rejects one whose `Origin` is not in `trustedOrigins`:

```
403 {"message":"Invalid origin","code":"INVALID_ORIGIN"}
```

`GET` requests short-circuit before the check (`dist/api/middlewares/origin-check.mjs:43`),
so `GET /api/auth/token`, `GET /api/auth/get-session` and `GET /api/auth/jwks` need no
`Origin`. Every `POST` under `/api/auth/*` does.

**The API side.** `auth.config.ts` passes `trustedOrigins`, read from `WEB_APP_ORIGINS`:

```ts
// apps/api/src/auth/auth.config.ts, TASK-009.
// Comma-separated list of every origin the dashboard is served from.
// Server-only. Required configuration in production. Never NEXT_PUBLIC_*.
const webAppOrigins = (process.env.WEB_APP_ORIGINS ?? '')
  .split(',')
  .map((o) => o.trim())
  .filter((o) => o.length > 0);

betterAuth({ trustedOrigins: webAppOrigins, /* ... */ })
```

An array passed here **extends** the default rather than replacing it
(`dist/context/helpers.mjs:74-77`): the resolved list is `[new URL(baseURL).origin,
...webAppOrigins]`. The API's own origin stays trusted whatever `WEB_APP_ORIGINS`
contains, which is what lets the integration suite pass with the variable unset.

Entries are matched by `matchesOriginPattern` (`dist/auth/trusted-origins.mjs:13-26`).
An entry with no `*` is an exact origin match including scheme. An entry containing `*`
is a wildcard over the origin. Verified against the pin:

| Entry | Matches | Does not match |
|---|---|---|
| `https://shortkit.vercel.app` | `https://shortkit.vercel.app` | `http://shortkit.vercel.app`, any preview host |
| `https://shortkit-*.vercel.app` | `https://shortkit-git-feat-x-juano.vercel.app` | `https://shortkit.vercel.app`, `https://evil.vercel.app` |
| `https://*.vercel.app` | every `*.vercel.app` host, **including ones we do not own** | `http://` hosts |

**Production and preview need two entries**, because a prefix wildcard does not match the
bare production host. `https://*.vercel.app` is not an acceptable entry: it trusts every
application on the platform.

`http://localhost:3000` is **not** trusted by default and must be listed in
`WEB_APP_ORIGINS` for local development. Without it a local signup returns
`403 INVALID_ORIGIN`.

**The BFF side** is normative in `web-api-client.md`: the proxy forwards the browser's
`Origin` verbatim on mutating methods, having already required it to equal the deployment
origin.

**`BETTER_AUTH_TRUSTED_ORIGINS` is read by the library on its own**
(`helpers.mjs:83-84`, comma-split and appended). Nothing in this design sets it. Anyone
with access to the API's environment can widen the trusted list through it without
touching `auth.config.ts`.

### Error bodies, verbatim from 1.6.26

Recorded 2026-08-08 so TASK-008's mapping and TASK-012's screens have exact shapes rather
than inferred ones. Every row was produced by probing the pinned release. All carry
`{ message, code }` and no `ErrorEnvelope` fields.

| Condition | Status | Body |
|---|---|---|
| sign-up body missing `name` | 400 | `{"message":"[body.name] Invalid input: expected string, received undefined","code":"VALIDATION_ERROR"}` |
| sign-up password shorter than 8 | 400 | `{"message":"Password too short","code":"PASSWORD_TOO_SHORT"}` |
| sign-up password longer than 128 | 400 | `{"message":"Password too long","code":"PASSWORD_TOO_LONG"}` |
| sign-up password empty string | 400 | `{"message":"[body.password] Too small: expected string to have >=1 characters","code":"VALIDATION_ERROR"}` |
| sign-up email already has an account | **422** | `{"message":"User already exists. Use another email.","code":"USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL"}` |
| sign-in wrong password or unknown address | 401 | `{"message":"Invalid email or password","code":"INVALID_EMAIL_OR_PASSWORD"}` |
| state-changing request with no `Origin` | 403 | `{"message":"Missing or null Origin","code":"MISSING_OR_NULL_ORIGIN"}` |
| state-changing request with an untrusted `Origin` | 403 | `{"message":"Invalid origin","code":"INVALID_ORIGIN"}` |

**Duplicate signup answers 422, not 409 and not 400.** A caller branching on status alone
will miss it. Branch on `code`.

> **AMENDED 2026-08-15 by Juano's ruling on ADR-0061 (`identity-membership`, wave 2). THE 422
> ROW ABOVE STOPS BEING TRUE ONCE `emailAndPassword.autoSignIn: false` LANDS IN TASK-003.**
>
> `sign-up.mjs:162` computes its generic-duplicate branch from `requireEmailVerification ||
> autoSignIn === false`. With `autoSignIn` on — the state this contract was written against — a
> duplicate address answers `422 USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL` and a fresh one answers
> 200, **which is an unauthenticated user-enumeration oracle**: an attacker tests an address
> list against a public route and learns who has an account. The wave-2 design security pass
> filed it, and `rateLimit: { enabled: false }` removes the library's own brake in the same card
> while the replacement limiter is IP-keyed and lands a wave later.
>
> Taking `autoSignIn: false` closes it, and closes a second finding with the same key: signup no
> longer returns a session, so the failed-signup residue stops handing the caller a live
> credential by `Set-Cookie` on its own 500 (ADR-0054). **Two findings, one key** — which is why
> it was worth falsifying a frozen row for.
>
> **What the row becomes:** a duplicate address answers the same generic success shape as a
> fresh one, and signup no longer establishes a session. The exact status and body are
> ADR-0061's to state and TASK-003's to assert. **A signup flow that assumed it was logged in
> afterwards no longer is** — that is TASK-007's and TASK-012's, both `todo`, both carrying the
> change on their cards.

`INVALID_EMAIL_OR_PASSWORD` is returned for both a wrong password and an address with no
account, which is deliberate on Better Auth's part and is the behaviour AC-20's 401 rests
on.

## Verification, performed by `AuthGuard`

Ordered and short-circuiting. Renumbered 2026-08-04 (F-014): the `@Public()` check was
step 6 while the text claimed public routes skip steps 1 through 5, which an implementer
copying this block literally would resolve by rejecting every anonymous request at step
1. The anonymous redirect `GET /:slug` is `@Public()`, so a visitor would get 401
instead of a 302 or the branded 404, breaking GC-8 and SC-7, and the invitation-accept
route would be unreachable.

**Step 0. Is the handler or its controller marked `@Public(justification)`?**
If yes, `AuthGuard` returns true immediately. `RequestContext` is not populated, no
token is read, and steps 1 through 8 do not run. This is the first thing the guard does.

For every other route, in order, any failure short-circuiting:

1. `Authorization: Bearer <jwt>` present, else 401 `unauthenticated`.
2. Signature valid against JWKS cached in process for 600 s, else 401 `unauthenticated`.
3. `exp` in the future, else 401 **`token_expired`** (distinct from `unauthenticated`;
   the BFF branches on it to refresh).
4. `iss` and `aud` equal the configured API base URL, else 401 `unauthenticated`.
5. Redis `EXISTS sk:{env}:revoked:jti:<jti>` is 0, else 401 `unauthenticated`. **On any
   Redis error this step is skipped** (ADR-0012 posture) and
   `auth_revocation_degraded_total` increments.
6. **Claim shape: `sub` is a non-empty string and `tid` is present and uuid-shaped,
   else 401 `unauthenticated`.** Added 2026-08-04 (F-029). Without it a tid-less or
   malformed-tid token passed the guard and was stopped one layer down by
   `withTenantTransaction`'s uuid validation, surfacing as a **500 rather than a 401**.
   The safety was real but accidental; this makes it deliberate and correctly shaped.
7. `ev === true`, else 403 `email_not_verified` (AC-17).
8. Populate `RequestContext` from `{ sub, tid, email, ev }`. **No database query at any
   step.**

`TenantTransactionInterceptor` then opens `withTenantTransaction(ctx.tenantId, ...)`,
unless the route carries `@Public()` or `@NoTenantTransaction()` (`tenant-context.md`).

A handler that forgets `@Public()` is treated as authenticated and returns 401, which is
the safe direction. A `@Public()` route touching a tenant-scoped table must reach it
through a capability-token entry point (ADR-0021); TASK-056 asserts that.

## Revocation

Rewritten 2026-08-07 (F-227). The previous form read "`POST /api/auth/sign-out` sets
`sk:{env}:revoked:jti:<jti>` with `EX = max(1, exp - now)`", which assumed a token at the
write site. There is none.

**Write.** `databaseHooks.session.delete.after` sets `sk:{env}:revoked:jti:<session.id>`
with `EX = 300`, the full `JWT_LIFETIME_S`. The environment segment is F-015's rule; see
`redirect-cache.md`.

```ts
// apps/api/src/auth/auth.config.ts, TASK-009.
databaseHooks: {
  session: {
    delete: {
      after: async (session: { id: string }): Promise<void> => {
        // MUST NOT THROW. The session row is already deleted and the hook is queued
        // after the transaction. A Redis failure degrades to the 300s window; it does
        // not fail the sign-out response. Increments auth_revocation_degraded_total.
      },
    },
  },
}
```

**`EX` is 300, not `exp - now`.** The hook receives a session, not a token. A token minted
one second before the delete still has 299 seconds of life, so any shorter TTL lets a live
token outlive its own revocation entry.

**The hook fires on every session deletion, not only sign-out.** `deleteWithHooks` and
`deleteManyWithHooks` (`better-auth/dist/db/with-hooks.mjs:115-190`) read the rows before
deleting and invoke `delete.after` once per row, so `POST /api/auth/sign-out`,
`revoke-session`, `revoke-other-sessions`, delete-user and expired-session cleanup all
revoke. A caller may rely on this: **if a session no longer exists, its tokens are revoked
within the write's latency, or Redis was unavailable.**

**Read.** Step 5 of verification below, `EXISTS sk:{env}:revoked:jti:<jti>`. Unchanged.

| Failure at the write site | Shape |
|---|---|
| Redis unreachable or errors | Swallowed. `auth_revocation_degraded_total` increments. The sign-out response is still 200. Tokens for that session stay valid until `exp`, at most 300 s. |
| `session.id` absent from the hook payload | Cannot happen: `with-hooks.mjs` passes the row it read. If it is absent the hook logs and returns; it does not throw into a completed deletion. |

## Web cookies (Vercel origin, ADR-0014)

| Cookie | Value | Attributes | Max-Age |
|---|---|---|---|
| `sk_at` | the JWT | `HttpOnly; Secure; SameSite=Lax; Path=/` | 300 |
| `sk_rt` | Better Auth session token | `HttpOnly; Secure; SameSite=Lax; Path=/` | 2592000 |

Neither is readable by client JavaScript. Nothing else stores a credential.

## Invariants a caller may rely on

1. `RequestContext.tenantId` on an authenticated request equals the `tenant_id` of
   every row that request can read or write. There is no path to another tenant.
2. `tid` never changes for a user (ADR-0015). A token's tenant is stable for its life.
3. A route reaching a handler has passed checks 1 through 7 and step 8 has populated
   `RequestContext`, unless step 0 exempted it.
   In particular `RequestContext.tenantId` is always present and uuid-shaped, so
   `withTenantTransaction` never receives a malformed tenant id from the guard path.
4. `token_expired` means the signature verified and the clock passed `exp`. Refreshing
   is the correct response. `unauthenticated` means it is not, and re-login is.
5. Maximum token lifetime is 300 seconds, so the worst-case revocation gap with Redis
   unavailable is 300 seconds.
5a. `jti` identifies the **session**, not the token. Every token minted for one session
   carries the same value, and one revocation entry covers all of them, including tokens
   minted before the entry was written. `jti` is not a nonce and callers may not use it
   for replay detection or as a per-token cache key.
6. Public routes in `launch-core`, each with a recorded justification:
   `GET /:slug` (anonymous visitor), `GET /health` (platform probe),
   `GET /api/invitations/:token` and `POST /api/invitations/:token/accept`
   (the invitee may have no account yet).
7. A `POST` to `/api/auth/*` carrying an `Origin` that is the API's own origin or one of
   `WEB_APP_ORIGINS` passes the origin check. One carrying no `Origin`, or an origin
   outside that list, gets a 403 with `code` `MISSING_OR_NULL_ORIGIN` or `INVALID_ORIGIN`
   and never reaches the handler. No account is created, no session is issued, no rate
   limit bucket is charged by the endpoint (F-233).
8. A signup that returns 200 created a user whose `name` is exactly the string the caller
   sent and whose password was 8 to 128 characters. Nothing else about the password is
   guaranteed (F-234, F-235).

   > **FALSIFIED 2026-08-16 by ADR-0061 (`identity-membership` wave 2), amended under the same
   > ruling as the 422 row above. A 200 NO LONGER MEANS A USER WAS CREATED.**
   >
   > Under `emailAndPassword.autoSignIn: false`, a signup against an address that **already has
   > an account** also returns 200, carrying a response body byte-identical to a real creation
   > apart from the caller's own `email` — measured against the real drizzle adapter: same key
   > set, a **fresh** `id` and `createdAt` rather than the existing account's, `token: null`,
   > and **no row written**. That indistinguishability is the point: it is what closes the
   > enumeration oracle the 422 used to be.
   >
   > **What survives:** when a row *is* created, `name` is exactly the string sent and the
   > password was 8 to 128 characters. What does not survive is reading 200 as proof that
   > anything was created. A caller that needs to know has to sign in.

## What the implementer must guarantee

- `AuthGuard` performs no database query. Adding one reintroduces the ordering problem
  in ADR-0002.
- `@Public()` requires a non-empty justification string. TASK-056 prints it.
- JWKS is fetched over the loopback interface or from the in-process auth instance, not
  over the public internet.
- The JWT is never logged, never placed in a URL, and never returned in a response body
  read by client JavaScript.
- `auth.config.ts` passes `trustedOrigins` from `WEB_APP_ORIGINS` and sets neither
  `emailAndPassword.minPasswordLength` nor `maxPasswordLength`. A unit test asserts the
  composed config's `trustedOrigins` contains every entry in `WEB_APP_ORIGINS`, in the
  same place as the existing `rateLimit.enabled === false` assertion (ADR-0013).
- `WEB_APP_ORIGINS` is server-only on the API. It is never `NEXT_PUBLIC_*` and it is not
  a secret, so it may be logged. The API logs the resolved trusted-origin list once at
  boot, which is the only cheap way to catch a mis-set value before a user hits a 403 on
  the login screen.

## Versioning

Adding a claim is additive; `AuthGuard` ignores unknown claims. Removing or repurposing
`tid`, `sub`, `ev` or `jti` breaks `AuthGuard` and requires an ADR superseding ADR-0013.
Making `jti` unique per token is such a change: it breaks revocation silently rather than
loudly, because the guard keeps working and sign-out stops covering earlier tokens. The
supported route is to add `sid` and move step 5 onto it in the same change.
Rolling the signing key is handled by JWKS: publish the new key, wait 600 s for caches
to expire, then start signing with it.
