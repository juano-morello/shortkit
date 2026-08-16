# Contract: `auth.config.ts`'s exported surface and the boot assertions beside it

- **Boundary:** `apps/api/src/auth/auth.config.ts` and `apps/api/src/auth/boot-assertions.ts`,
  between TASK-003 (which creates both) and TASK-004 (which mounts the first and extends the
  second, wave 3), and between TASK-003 and the hook appenders of item 1b, who land **after
  this initiative closes**.
- **Normative form:** the TypeScript below, and the stubs at
  `design/stubs/apps/api/src/auth/auth.config.ts` and
  `design/stubs/apps/api/src/auth/boot-assertions.ts`. Both typecheck against
  `apps/api/tsconfig.json` and pass `eslint.config.mjs`.
- **Produced by:** TASK-003.
- **Consumed by:** TASK-004 (`auth`, `beforeHooks`, the assertion file), TASK-005 (indirectly,
  through the mounted `/api/auth/jwks`, and directly for `iss`/`aud`), item 1b (`beforeHooks`,
  `AuthBeforeHook`).
- **ADRs:** ADR-0013, ADR-0046, ADR-0050, ADR-0051, ADR-0052, ADR-0055, ADR-0056, ADR-0057,
  ADR-0058, ADR-0059, ADR-0060, ADR-0061.
- **Revised 2026-08-16** after the wave-2 design security pass and three rulings by Juano.

## `auth.config.ts`

```ts
import type { Auth } from 'better-auth';
import type { createAuthMiddleware } from 'better-auth/api';

/** The context Better Auth hands a `hooks.before` middleware. Inferred, never restated. */
export type AuthBeforeHookContext = Parameters<Parameters<typeof createAuthMiddleware>[0]>[0];

export type AuthBeforeHook = (ctx: AuthBeforeHookContext) => Promise<void>;

/** Created EMPTY. Appenders `push`. Nobody assigns. */
export const beforeHooks: AuthBeforeHook[];

/** The one composed instance. TASK-004 mounts it with `toNodeHandler(auth)`. */
export const auth: Auth;
```

`AuthBeforeHookContext` is inferred from `createAuthMiddleware`'s second overload rather than
written out. The context type is a large structural type whose shape changes between Better
Auth releases; restating it produces a type that compiles and diverges.

## `boot-assertions.ts`

```ts
export const BETTER_AUTH_PUBLISHED_DEFAULT_SECRET = 'better-auth-secret-12345678901234567890';
export const BETTER_AUTH_SECRET_MIN_LENGTH = 32;

/** Thrown by every accessor and assertion below, so `main.ts` labels the refusal the same
 *  way whichever one fired. Carries the rule that was broken and never the value. */
export class AuthBindingError extends Error {
  readonly binding: 'better_auth_secret' | 'better_auth_url' | 'web_app_origins';
  constructor(binding: AuthBindingError['binding'], message: string);
}

/** Reads `process.env`. THROWS. Never returns `undefined` or `''`. */
export function betterAuthSecret(): string;

/** Reads `process.env`. THROWS. Returns an absolute origin with no trailing slash. */
export function betterAuthUrl(): string;

/** Reads `process.env`. THROWS on a bad entry. Returns `[]` when unset, which is legal. */
export function webAppOrigins(): readonly string[];

export function assertBetterAuthSecretConfigured(env: NodeJS.ProcessEnv): void;
export function assertBetterAuthUrlConfigured(env: NodeJS.ProcessEnv): void;
export function assertWebAppOriginsConfigured(env: NodeJS.ProcessEnv): void;
```

**One error class across three bindings**, replacing ADR-0058's `BetterAuthSecretError`. The
reason is unchanged and now applies three times: from wave 3 `main.ts` imports
`auth.config.ts` for the mount, so every accessor throws during module evaluation and no
assertion runs. `main.ts` maps `AuthBindingError.binding` onto `boot_precondition` so the log
line is identical whichever path raised it.

TASK-004 adds `assertTrustedClientIpHeaderConfigured(env)`,
`assertBffProxySecretConfigured(env)` and `assertAuthRoleSeparation()` to this file in wave 3.
It does not create the file and does not touch the six functions above.

## The declared bindings

| Variable | Values | Unset binds to | Asserted | Declared in |
|---|---|---|---|---|
| `BETTER_AUTH_SECRET` | at least 32 characters, not `better-auth-secret-12345678901234567890` | **nothing. Boot fails** | unconditional | compose, no default (`:?`) |
| `BETTER_AUTH_URL` | absolute origin, no path, query or fragment. **`https:` any host; `http:` loopback only** (`localhost`, `127.0.0.0/8`, `[::1]`) | **nothing. Boot fails** | unconditional | compose, default `http://localhost:3001`; `apps/api/.env.example` |
| `WEB_APP_ORIGINS` | comma-separated absolute origins, wildcards bounded by the two rules below | **the empty list, which is legal and is what the integration tier runs on** | unconditional on entries that are present | compose, default `http://localhost:3000`; `apps/api/.env.example` |

Three rejections for `BETTER_AUTH_SECRET`, not four (ADR-0058). No environment is consulted
and `NODE_ENV` is read by none of them.

**TASK-003 declares the two new bindings in wave 2** (Juano's ruling, 2026-08-16), in
`docker-compose.yml`'s `api` service and in a new `apps/api/.env.example`. Both carry a
compose default because neither is a credential, so `docker compose up` on a fresh clone still
works and the `compose` job needs nothing exported. `BETTER_AUTH_SECRET` remains the only
variable in that file with no default. ADR-0059 holds the exact entries and the refusal text.

### `BETTER_AUTH_URL`: `http:` is loopback-only

`advanced.useSecureCookies` is derived from this one string, so its scheme decides whether the
session cookie carries `Secure` and nothing else can catch a wrong one. Measured:
`http://api.example.com` yields `secure: false` and no `__Secure-` prefix **with every
assertion green**, because a value is set.

`https:` is permitted for any host. `http:` is permitted only for `localhost`, an address in
`127.0.0.0/8`, or `[::1]`. It reads no `NODE_ENV`, so GC-B holds, and the compose default
`http://localhost:3001` is unaffected.

It is a string test, not a resolution test. A TLS-terminating proxy speaking `http` to a
non-loopback backend is refused, and the correct value there is the **public `https:` origin**,
because that is what the browser sees and what `iss`, `aud` and the cookie's `Secure` flag must
describe. `boot-assertions.spec.ts` covers both directions: loopback-http accepted,
non-loopback-http refused.

### Wildcard rules for `WEB_APP_ORIGINS`

The metacharacters are **`*` and `?`**, both of them: `trusted-origins.mjs:18` enters wildcard
mode on either, and `?` matches a single character.

1. **No host label may consist entirely of metacharacters.** Refuses `*`, `https://*`,
   `https://*.vercel.app`, `https://?.example.com`.
2. **No metacharacter may appear in the final two labels**, so the registrable domain is
   literal. Refuses `https://shortkit-*.app`, `https://app.example.co?`.

`https://shortkit-*.vercel.app` passes both and is the preview form `auth-tokens.md:158-162`
documents. `https://*.vercel.app` is refused **by name** in the unit test, because
`auth-tokens.md:159-162` rules exactly that entry out: "it trusts every application on the
platform".

Rule 2 approximates "the registrable domain" and is unsound under a multi-label public suffix:
`https://ex*.co.uk` passes and should not. Closing it needs a public-suffix list. Stated, not
closed (ADR-0059).

## The composed configuration, key by key

Every key is fixed by an ADR. The nine marked **silent** are facts that degrade with no
error, which is why `auth.config.spec.ts` asserts each one.

**This table is normative on conflict.** Where a TASK card, an ADR's prose or a stub disagrees
with a row here, this row is what the implementer builds. It exists because the same key has
now been decided in three artifacts across two audit rounds, and the card is the artifact the
implementer works from while the amendments are still being applied.

| Key | Value | Fixed by | Silent |
|---|---|---|---|
| `database` | `drizzleAdapter(betterAuthDatabase(), { provider: 'pg', schema: betterAuthSchema, transaction: false })` | ADR-0046, ADR-0050 | |
| `secret` | `betterAuthSecret()` | ADR-0051 | **yes** |
| `baseURL` | `betterAuthUrl()` | ADR-0059 | **yes** |
| `trustedOrigins` | `webAppOrigins()`. Extends the API's own origin, never replaces it | ADR-0059, `auth-tokens.md` | **yes** |
| `advanced.useSecureCookies` | `betterAuthUrl().startsWith('https://')`. **Never `NODE_ENV`** | ADR-0059 | **yes** |
| `session.expiresIn` | `SESSION_LIFETIME_SECONDS = 604800`. The library's default, stated | ADR-0059 | |
| `logger` | `{ level: 'warn', disableColors: true, log }` | ADR-0052, **level amended by ADR-0060** | **yes** |
| `rateLimit` | `{ enabled: false }` | ADR-0013 | **yes** |
| `plugins` | `[jwt({ ... }), bearer()]` | ADR-0013 | |
| `jwt.issuer` / `jwt.audience` | `betterAuthUrl()`, both | ADR-0059 | **yes** |
| `jwt.expirationTime` | `` `${String(ACCESS_TOKEN_LIFETIME_SECONDS)}s` ``. **A time-span string. A number is an absolute `exp`** | ADR-0013, corrected here | **yes** |
| `jwt.definePayload` | returns `{ jti, email, ev, tid }`. Never `sub` | ADR-0013, F-227 | |
| `disableSettingJwtHeader` | `true` | ADR-0055 | |
| `jwks.disablePrivateKeyEncryption` | **deliberately unset**, so the default `false` stands | ADR-0057 | |
| `emailAndPassword.enabled` | `true`. **Not a default.** `sign-up.mjs:144` answers `400 EMAIL_PASSWORD_SIGN_UP_DISABLED` when it is falsy, so without this there is no signup | ADR-0061 | |
| `emailAndPassword.autoSignIn` | **`false`.** Stops signup issuing a session, and turns the duplicate-address 422 into a 200. **Closes the status-code oracle, not necessarily the disclosure** (invariant 12) | ADR-0061 | **yes** |
| `emailAndPassword.requireEmailVerification` | **deliberately unset**, so the default `false` stands. Mail is out of scope | ADR-0061 | |
| `emailAndPassword.minPasswordLength` / `.maxPasswordLength` | **deliberately unset.** The library's 8 and 128 are inherited | `auth-tokens.md`, **Juano's ruling 2026-08-16** | |
| `databaseHooks.user.create.after` | `createTenantForNewUser` | ADR-0015, ADR-0054 | |
| `databaseHooks.session.delete.after` | `revocationStore.revoke(session.id)` | ADR-0013 | |
| `hooks.before` | `createAuthMiddleware` iterating `beforeHooks` | ADR-0013, F-054 | |

### Password bounds: `auth.config.ts` sets neither key

**Ruled by Juano, 2026-08-16.** Foundation's `auth-tokens.md` wins: "auth.config.ts sets
neither `emailAndPassword.minPasswordLength` nor `maxPasswordLength`", and the library's own
8 and 128 (`create-context.mjs:185-186`) are the policy of record.
`auth-contracts.md:65-67` said the opposite; Juano is amending it. `PASSWORD_MIN_LENGTH` and
`PASSWORD_MAX_LENGTH` in `@shortkit/contracts` remain the client-side form check and are not
read by `auth.config.ts`.

### `jwt.expirationTime` must be a string

**Measured, twice.** `dist/plugins/jwt/utils.mjs:15-19` returns a numeric `expirationTime`
as the claim directly, and `JwtOptions`' own doc comment says so. The security pass minted a
real token with `expirationTime: 300` and got `exp = 300`, i.e. 1970-01-01T00:05:00Z. Every
token would be issued already expired, `AuthGuard` step 4 would answer `token_expired`, and
the BFF would refresh forever.

**Ruled by Juano, 2026-08-16: the call site converts.** The constant stays a number in
`@shortkit/contracts`, because `REVOCATION_TTL_SECONDS` derives from it and arithmetic on a
string is worse. `auth.config.ts` writes:

```ts
jwt: { expirationTime: `${String(ACCESS_TOKEN_LIFETIME_SECONDS)}s` }
```

`sec('300s')` is 300 (`dist/utils/time.mjs:53-59, 94-96`), so `exp` is `iat + 300`.

**The spec asserts the resulting `exp`, not the option.** Asserting `expirationTime ===
'300s'` restates the config. Minting a token and asserting `exp - iat ===
ACCESS_TOKEN_LIFETIME_SECONDS` is what catches the number form.

### Cookies

Resolved by `cookies/index.mjs:21,29-40` from the keys above. Decided values, not inherited:

| Cookie | Attributes | Max-Age |
|---|---|---|
| `better-auth.session_token` | `HttpOnly`, `SameSite=Lax`, `Path=/`, `Secure` iff `BETTER_AUTH_URL` is `https://` | 604800 |
| `better-auth.session_data` | same | 604800 |

`better-auth.session_data` carries an encrypted copy of the session and is set when session
cookie caching is active. **It is recorded here because no other artifact in this repository
mentions it**, and it is left enabled: turning it off is a performance decision this wave has
no basis for.

**`useSecureCookies` also drives the `__Secure-` name prefix** (`cookies/index.mjs:20,30`).
Moving a deployment from `http` to `https` renames every cookie and signs every session out.

## Error cases

| Situation | Shape | Where |
|---|---|---|
| `BETTER_AUTH_SECRET` unset, empty, under 32 chars, or the published default | `AuthBindingError`. Boot refuses, exit 1, line carries `boot_precondition: "better_auth_secret"` | ADR-0058 |
| `BETTER_AUTH_URL` unset, unparseable, wrong scheme, or carrying a path | `AuthBindingError`, `boot_precondition: "better_auth_url"` | ADR-0059 |
| A `WEB_APP_ORIGINS` entry is `*`, or its host part is a bare wildcard | `AuthBindingError`, `boot_precondition: "web_app_origins"` | ADR-0059 |
| A user with no `tenant_memberships` row calls `GET /api/auth/token` | `403 {"message":"This account has no tenant membership, so no access token can be issued.","code":"NO_TENANT_MEMBERSHIP"}` | ADR-0055 |
| The same user calls `GET /api/auth/get-session` | **200 with the session.** `disableSettingJwtHeader: true` keeps the mint off this route | ADR-0055 |
| `createTenantForNewUser` fails after the `user` row commits | `500 {"message":"Sign-up completed but tenant provisioning failed. This account cannot be used; contact support.","code":"TENANT_PROVISIONING_FAILED"}`. The `user` and `account` rows survive. **No session row and no `Set-Cookie`**, because `autoSignIn` is false | ADR-0054, ADR-0061 |
| Sign-up with an address that already has an account | **`200` with a synthetic user and `token: null`**, indistinguishable from a fresh signup, with the password hashed first so the timing does not disclose either. `autoSignIn: false` puts `shouldReturnGenericDuplicateResponse` on this path. **The 422 in `auth-tokens.md`'s table no longer occurs** | ADR-0061 |
| Sign-up that succeeds | `200` with `token: null` and **no `Set-Cookie`**. The caller must sign in separately | ADR-0061 |
| `POST` under `/api/auth/*` with no `Origin`, or an untrusted one | `403 MISSING_OR_NULL_ORIGIN` or `403 INVALID_ORIGIN` | `auth-tokens.md` |
| A `before` hook throws something that is not an `APIError` | `dist/api/dispatch.mjs:86-89` rethrows it, the endpoint never runs, and the caller gets a **body-less 500** from `better-call/dist/router.mjs:94-98` | ADR-0013 F-228, ADR-0055 |
| `jwks` rows encrypted under a previous secret | `BetterAuthError('Failed to decrypt private key...')` from `sign.mjs:34-39`, surfacing as a body-less 500 on `GET /token` while the process stays healthy | ADR-0057 |
| Any other failure inside the mount | body-less `500`, and the error with its stack written by a `console.error` **inside `better-call`** that ADR-0052's binding does not reach | ADR-0055 |

**Better Auth's error bodies are not `ErrorEnvelope` and nothing in `apps/api` maps them.**
The mount sits outside the Nest graph so `ApiExceptionFilter` never sees it. TASK-008 maps
them at the web client boundary. `NO_TENANT_MEMBERSHIP` and `TENANT_PROVISIONING_FAILED` are
additions to the eight rows in `auth-tokens.md`'s table and are escalated there.

## Invariants a caller may rely on

1. **`auth` is the only composed Better Auth instance in the process.** Nothing else calls
   `betterAuth()`.
2. **`iss` and `aud` on every minted token equal `BETTER_AUTH_URL`** and do not vary with the
   request's `Host` header. `AuthGuard` step 4 compares against that same value.
3. **`beforeHooks` is appended to and never assigned.** A caller may rely on every earlier
   hook still being present after it pushes. Ordering is registration order, and the loop
   short-circuits on a throw.
4. **A `hooks.before` entry that refuses throws an `APIError` and nothing else.** Anything
   else aborts the request with a body-less 500 and skips every later hook.
5. **A hook that does not apply to `ctx.path` returns immediately.** `ctx.body` is
   **unvalidated** at this point: probes against 1.6.26 delivered `ctx.body.email` as an
   object, as a number, and `ctx.body` as `undefined` (ADR-0013, F-228).
6. **`definePayload` returns `jti` and never returns `sub`.** `sign.mjs:49` sets `jti` only
   when the payload carries it; `sign.mjs:56-59` spreads the payload and then overwrites
   `sub`.
7. **`GET /api/auth/token` is the only path that mints a JWT.**
   `disableSettingJwtHeader: true` removes the `set-auth-jwt` header the plugin would
   otherwise set from the `/get-session` after-hook (`dist/plugins/jwt/index.mjs:185-188`).
8. **A token's lifetime is exactly `ACCESS_TOKEN_LIFETIME_SECONDS` from `iat`.**
9. **The session credential lives 604800 seconds.** A caller holding `sk_rt` for longer holds
   a cookie whose credential has already expired.
10. **No accessor returns a falsy value.** `options.secret` is the first operand of a `||`
    chain (`create-context.mjs:70`), so a falsy return is not an override; the same shape
    applies to `baseURL`.
11. **Four scans in `apps/api/src/db/better-auth-database-callers.spec.ts` bound who can
    reach the auth role** (ADR-0056) — three equalities and one subset — and they are not of
    equal weight:

    | Scan | Permitted | Direction |
    |---|---|---|
    | `betterAuthDatabase` | `db/client.ts`, `auth/auth.config.ts` | equality |
    | `DATABASE_AUTH_URL`, the bare identifier | `db/client.ts`, `main.ts`, `auth/boot-assertions.ts` | **subset** |
    | `process.env.DATABASE_AUTH_URL`, the use | `db/client.ts` **(load-bearing)** | equality |
    | module specifiers `'pg'` and `'drizzle-orm/node-postgres'` | `db/client.ts` (tripwire) | equality |

    **Scan 2 is a subset and the other three are equalities.** Its permitted set is
    deliberately ahead of the tree: `main.ts` and `auth/boot-assertions.ts` are pre-authorised
    for wave 3 and contain the identifier zero times today, so an equality would fail on the
    day TASK-003 lands. Subset costs only the removal direction, which cannot reach the auth
    role and which scan 3's equality catches anyway (ADR-0056).

    **TASK-004 may name `DATABASE_AUTH_URL` in `AUTH_VERDICT_PREFIX` and in
    `assertAuthRoleSeparation`'s refusal message. It may not write
    `process.env.DATABASE_AUTH_URL` in either**; it reaches the auth pool through
    `db/client.ts`, which ADR-0050 already requires.
12. **A `POST /api/auth/sign-up/email` for an existing address answers 200 with a synthetic
    user** (ADR-0061), so a caller may not rely on the 422 that `auth-tokens.md` still
    records. **This closes the status-code oracle and is not a guarantee that the response
    discloses nothing**: on better-auth's in-memory adapter the duplicate body carries an
    `image` key the fresh body omits, and whether that survives the drizzle adapter is decided
    by the integration assertion below, not by this contract.
13. **Sign-up issues no session and no cookie.** A caller that needs one signs in.

## What the implementer must guarantee

- **`boot-assertions.ts` imports nothing from `auth.config.ts`.** The dependency runs one way.
  `auth.config.ts` evaluates `betterAuth({ secret: betterAuthSecret(), baseURL: betterAuthUrl(),
  ... })` at module scope, so the reverse edge makes `main.ts`'s import construct the auth
  instance before `bootstrap()` runs (ADR-0058).
- **`baseURL` and `jwt.issuer`/`jwt.audience` are all three set**, from the same accessor.
  Setting only `baseURL` leaves the claims on a derivation; setting only the claims leaves the
  cookie flag and the trusted-origin list on the request-derived origin (ADR-0059).
- **`advanced.useSecureCookies` is derived from `BETTER_AUTH_URL`'s scheme and from nothing
  else.** Reading `NODE_ENV` here is the defect GC-B forbids and is what the library already
  does when the key is absent.
- **`schema: betterAuthSchema` is passed explicitly to `drizzleAdapter`.** Without it the
  adapter falls back to `db._.fullSchema`, whose keys are `authUser` and `authSession` rather
  than `user` and `session`, and every model lookup raises `BetterAuthError`
  (`@better-auth/drizzle-adapter/dist/index.mjs:90-92`).
- **`transaction: false` is stated rather than inherited** (ADR-0046).
- **`betterAuthDatabase()` is called exactly once**, and its result is not re-exported, not
  stored on a module-level binding another file can import, and not passed anywhere except
  into `drizzleAdapter`.
- **The `logger.log` hook drops `args`** and passes only `{ code: 'better_auth' }` and the
  message (ADR-0052). Forwarding `args` puts an arbitrary object's enumerable properties on
  the line, which is what `serializers.err` exists to prevent.
- **`level: 'warn'`, not `'error'` and not `'info'`** (ADR-0060). `'error'` discards
  `create-context.mjs:64`'s unresolved-baseURL warning and three other security-relevant
  lines. `'info'` puts `sign-up.mjs:168`'s email line on the stream, which GC-G forbids.
- **No key added here reads `NODE_ENV`.**
- **`auth.config.spec.ts` asserts the nine silent facts**: the secret is not the published
  default; `logger.level === 'warn'` and `log` is a function; `rateLimit.enabled === false`;
  `emailAndPassword.enabled === true` and **`emailAndPassword.autoSignIn === false`**;
  `baseURL` equals `BETTER_AUTH_URL`; a minted token's `iss` and `aud` equal that value **and
  do not change when the request carries a different `Host`**; the session cookie's resolved
  attributes off `$context.authCookies`, including `secure` following the configured scheme;
  `trustedOrigins` contains every entry of `WEB_APP_ORIGINS`; and a minted token's `exp - iat`
  equals `ACCESS_TOKEN_LIFETIME_SECONDS`.
- **The origins assertion refuses `https://*.vercel.app` by name**, not only the bare `*`.
  Naming the entry the frozen contract names is what stops the rule drifting back to the
  version that admitted it.
- **`signup-creates-tenant.int-spec.ts` asserts a duplicate signup returns 200, writes no
  second `user` row, and that the duplicate-address and fresh-address response bodies are
  byte-identical after normalising `id`, `createdAt` and `updatedAt`.** The third is the
  assertion that decides whether the response-shape channel exists against the real adapter;
  it is written as whole-body equality rather than as the absence of `image`, so it survives a
  library change to either branch (ADR-0061).
- **`boot-assertions.spec.ts` covers both directions of the loopback rule**: `http://localhost`
  accepted, `http://api.example.com` refused.

## Versioning and backward compatibility

`Auth` is `better-auth`'s exported type and `better-auth` is pinned to an exact version
(ADR-0013, F-016). An upgrade can change `AuthBeforeHookContext`'s inferred shape, which is a
compile error at every hook rather than a runtime surprise. That is the compatibility
mechanism.

**Three claims in this contract are version-bound and an upgrade re-reads them**: the secret
fallback chain in `create-context.mjs`, every `logger.warn` call site (ADR-0060), and
`toExpJWT`'s numeric branch. None has a gate behind it.

`beforeHooks` is append-only in the same sense `ERROR_CODES` is: adding an entry is
compatible, replacing the array is breaking and silent. Changing `AuthBeforeHook`'s signature
is breaking and must land with every appender in the same commit; there are none inside this
initiative, so the first breaking change is free and the second is not.

Adding a key to the composed config is compatible unless it appears in the table above.
Changing one that does requires an amendment to the ADR that fixed it.

## Conflicts and escalations recorded on this boundary

**Resolved by Juano, 2026-08-16:** the password-bound contradiction between `auth-tokens.md`
and `auth-contracts.md` (foundation wins, neither key is set); `expirationTime`'s form (the
call site converts); ownership of `trustedOrigins` (TASK-003, this wave); ADR-0015's residue
description (superseded in part by ADR-0054); **`autoSignIn: false` (taken, ADR-0061)**; and
**the wave-2 declaration of both new bindings (TASK-003, ADR-0059)**.

**Still open, all escalated in the ADR named. None blocks TASK-003's implementation:**

1. **`auth-tokens.md`'s `sk_rt` `Max-Age` of 2592000 outlives a 604800-second session** by 23
   days (ADR-0059).
2. **`auth-tokens.md`'s error table needs three edits**: add `403 NO_TENANT_MEMBERSHIP` and
   `500 TENANT_PROVISIONING_FAILED` (ADR-0055), and the `422` row no longer occurs
   (ADR-0061). Its invariant 8 also stops holding, because a 200 may describe a synthetic
   user. Juano is amending it.
3. **`shortkitJwtClaimsContract` types `iss` and `aud` as free strings** where both are now
   configured constants (ADR-0059).
4. **`packages/contracts/src/auth/index.ts:134-135` still instructs the numeric
   `expirationTime` form**, as does `auth-contracts.md:136-138`. Both are shipped or frozen.
5. ~~`ADR-0052` and `TASK-003.md` still state `logger.level: 'error'`.~~ **Closed 2026-08-16:**
   both were amended by Juano, including ADR-0052's `:192` follow-up, which is the line that
   instructs the spec's assertion. Nothing in either artifact reads `'error'`.
6. **TASK-008's mapping of `USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL` becomes dead** under
   ADR-0061, and nothing tells that card.
7. **`https://ex*.co.uk` passes both wildcard rules** and trusts any registrable domain under
   `.co.uk` beginning `ex`. **Parked by Juano, 2026-08-16, with a written reason**: reaching it
   needs a multi-label public suffix, which this repository does not use, and closing it needs
   a public-suffix list. It becomes real the day a `.co.uk`, `.com.au` or `.github.io` origin
   joins `WEB_APP_ORIGINS`. Recorded as a decision, not left as an observation.
