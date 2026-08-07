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
| `POST` | `/api/auth/sign-up/email` | public | body `{ email, password, name?, invitationToken? }` |
| `POST` | `/api/auth/sign-in/email` | public | |
| `POST` | `/api/auth/sign-out` | session | deletes the session, which fires the revocation write (below) |
| `GET` | `/api/auth/get-session` | session | |
| `GET` | `/api/auth/token` | session | mints a JWT |
| `GET` | `/api/auth/jwks` | public | public key set |

These are mounted outside Nest (ADR-0013). **Their error bodies are Better Auth's
native shape, not `ErrorEnvelope`.** TASK-008 maps them at the client boundary.

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

## What the implementer must guarantee

- `AuthGuard` performs no database query. Adding one reintroduces the ordering problem
  in ADR-0002.
- `@Public()` requires a non-empty justification string. TASK-056 prints it.
- JWKS is fetched over the loopback interface or from the in-process auth instance, not
  over the public internet.
- The JWT is never logged, never placed in a URL, and never returned in a response body
  read by client JavaScript.

## Versioning

Adding a claim is additive; `AuthGuard` ignores unknown claims. Removing or repurposing
`tid`, `sub`, `ev` or `jti` breaks `AuthGuard` and requires an ADR superseding ADR-0013.
Making `jti` unique per token is such a change: it breaks revocation silently rather than
loudly, because the guard keeps working and sign-out stops covering earlier tokens. The
supported route is to add `sid` and move step 5 onto it in the same change.
Rolling the signing key is handled by JWKS: publish the new key, wait 600 s for caches
to expire, then start signing with it.
