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
- **Amended 2026-08-18 (TASK-1b-09, item 1b wave 3).** The two `beforeHooks` entries and the
  invited branch of `databaseHooks.user.create.after` shipped. `AuthBeforeHookContext` and
  `AuthBeforeHook` are now DEFINED in `apps/api/src/auth/before-hook.ts` and re-exported by
  `auth.config.ts` under the same names, because `db/better-auth-database-callers.spec.ts` scan 5
  bounds — by text, type imports included — who may import `auth.config`, and the two hook
  modules must not be on that list. The exported surface below is unchanged. The F-216 note under
  invariant 4 is now met (fixed strings); the composed-config table and the error-cases table
  carry the new rows, marked with this date.

## `auth.config.ts`

```ts
import type { Auth } from 'better-auth';
import type { createAuthMiddleware } from 'better-auth/api';

/** The context Better Auth hands a `hooks.before` middleware. Inferred, never restated. */
export type AuthBeforeHookContext = Parameters<Parameters<typeof createAuthMiddleware>[0]>[0];

export type AuthBeforeHook = (ctx: AuthBeforeHookContext) => Promise<void>;

/** Created EMPTY. Appenders `push`. Nobody assigns. */
export const beforeHooks: AuthBeforeHook[];

/** Added 2026-08-18 (TASK-1b-09). Same rule. Holds the email bucket's release hook. */
export type AuthAfterHook = (ctx: AuthBeforeHookContext) => Promise<void>;
export const afterHooks: AuthAfterHook[];

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

> **CORRECTED 2026-08-16 (F-210). THE LINE IS NOT IDENTICAL, AND THIS PARAGRAPH CLAIMED IT WAS.**
> Measured by the implement-phase security audit: a refusal raised at **module scope** during
> import bypasses `bootstrap().catch` entirely, so the handler that turns a binding refusal into
> a clean exit with a named `boot_precondition` never runs. What an operator sees is an
> unhandled rejection, not the designed message.
>
> ADR-0058 carried the same claim and `main.ts` now states the real behaviour alone. **Three
> artifacts asserted a property none of them had checked** — which is why nobody would have
> looked when it failed. TASK-004 owns the mount and inherits the dynamic-import shape `main.ts`
> now documents.

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
| `advanced.disableOriginCheck` | **`false`, explicitly.** Absent, `create-context.mjs:210` derives it from `isTest()` — see below | F-206 | **yes** |
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
| `databaseHooks.user.create.after` | ~~`createTenantForNewUser`~~ **`createTenant(user, ctx)` → `provisionForNewUser(user, ctx)` (`auth/invitation-signup.ts`), amended 2026-08-18 (TASK-1b-09):** with a string `ctx.body.invitationToken` → `acceptInvitationByCapabilityToken(token, { userId, tenantMembership: 'create' })` — the memberships land in the INVITER's tenant, taken from the verified row, and NO `tenants` row is written; otherwise `createTenantForNewUser(user)`. `ctx` is the endpoint context `with-hooks.mjs` passes as the second argument (the request's `AsyncLocalStorage`), so `ctx.body` is the body the before hook saw; no per-request stash exists. Either branch's failure is `500 TENANT_PROVISIONING_FAILED` | ADR-0015, ADR-0054, ADR-0021, D-18 | |
| `databaseHooks.session.delete.after` | `revocationStore.revoke(session.id)` | ADR-0013 | |
| `hooks.after` | *added 2026-08-18 (TASK-1b-09, architect ruling):* `createAuthMiddleware` iterating `afterHooks`, an exported registry with the same appended-never-assigned rule as `beforeHooks`, holding exactly `[emailRateLimitReleaseHook]` — on `/sign-in/email`, when `ctx.context.returned` is defined and not an `APIError` (the endpoint's value on success, the thrown `APIError` on failure; the numeric status is not on the context), the email bucket's charge is released under the same key. An after hook NEVER throws: the endpoint already answered. `auth.config.spec.ts` pins the contents and the text rule | `rate-limit.md`, ADR-0013, F-054 | |
| `hooks.before` | `createAuthMiddleware` iterating `beforeHooks`. **Since 2026-08-18 (TASK-1b-09) the array holds exactly `[emailRateLimitHook, invitationValidationHook]`, in that order, pushed by `auth.config.ts` itself** — the email-keyed sign-in bucket first (D-15; `auth/email-rate-limit-hook.ts`, port bound by `main.ts` through `bindEmailRateLimitPort`), then invitation validation on `/sign-up/email` (`auth/invitation-signup.ts`). `auth.config.spec.ts` asserts the contents, the order, and that the file never assigns the binding after its declaration | ADR-0013, F-054, D-15, D-18 | |

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
| `better-auth.session_data` | same | **300** |
| `better-auth.dont_remember` | same | **none** |
| `better-auth.account_data` | same | **300** |

> **CORRECTED AND COMPLETED 2026-08-16 (F-197), Juano's ruling — an amendment to a contract that
> froze the same morning.** The table gave `session_data` a Max-Age of 604800 and listed two
> cookies. The composed instance sets **four**, measured off `$context.authCookies`:
> `session_data` is **300**, and `dont_remember` and `account_data` were in no artifact at all.
>
> **`session_data`'s 300 does not come from `session.expiresIn`** — it is the session-cookie-cache
> default, which is a different knob and is why the number looked like a typo for the session
> lifetime and was not. Nothing asserted the wrong value, so nothing was failing.
>
> Worth naming plainly: **this table was added in round 1 to close the finding where a session
> cookie shipped with no `Secure` flag**, and it was wrong on the first measurement ever taken
> against it. A table of decided values is only as good as the run that checked it, and this one
> had not been run — the same shape as every other control this wave found that could not fail.

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
| Sign-in for one address, sixth **failed** attempt in 15 minutes (any client IP, any casing or padding of the address; a successful sign-in releases its charge, so successes never count) — *added 2026-08-18, TASK-1b-09* | `429 {"code":"rate_limited","message":"Too many sign-in attempts for this account. Try again shortly.","retryAfterSeconds":<n>}` from `emailRateLimitHook`, with `Retry-After: <n>` measured present on 1.6.26 (best effort per `rate-limit.md`). Charged BEFORE the endpoint, so a padded address that Better Auth would 400 still costs one; a non-string or empty `email` is neither charged nor refused (F-228) | `rate-limit.md`, ADR-0013, F-025, F-027 |
| Sign-up carrying a string `invitationToken` that is malformed, unknown, or names another tenant — *added 2026-08-18, TASK-1b-09* | `404 {"code":"INVITATION_NOT_FOUND","message":"Invitation not found."}` from `invitationValidationHook`. **No `user` row is created.** One body for all three (ADR-0021) | `invitation-tokens.md`, ADR-0021, D-18 |
| … whose invitation is expired / revoked / already accepted | `410 {"code":"INVITATION_EXPIRED","message":"This invitation has expired."}` / `410 {"code":"INVITATION_REVOKED","message":"This invitation has been revoked."}` / `409 {"code":"INVITATION_ALREADY_ACCEPTED","message":"This invitation has already been accepted."}`. No `user` row | `invitation-tokens.md`, D-18 |
| … and the lookup itself fails (a driver fault) | `500 {"code":"INVITATION_LOOKUP_FAILED","message":"The invitation could not be verified. Try again shortly."}` — an `APIError` WITH a body rather than the body-less 500 above, after one `logger.error` with `code: invitation_lookup_failed` and `errorLogFields(error, { includeMessage: false })`. No `user` row | ADR-0055, F-228, GC-G |
| Sign-up whose `invitationToken` is present but not a non-empty string (object, number, `''`, `null`, array) | Treated as an UNINVITED signup by both hooks: `200`, a tenant of its own (AC-1b-10). Never a 500 | F-228, D-18 |
| Sign-up with a valid token for an address that already has an account | ADR-0061's generic `200`; no hook fires; the invitation stays `pending` (AC-1b-11) | ADR-0061, D-04 |
| The invited branch's accept fails after the `user` row commits | The same `500 TENANT_PROVISIONING_FAILED` as the uninvited row above; the accept transaction rolled back, so the invitation is still `pending` and no membership row exists anywhere; the orphaned `user` row is ADR-0015's accepted residue | ADR-0054, ADR-0015 |
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
   short-circuits on a throw. *Since 2026-08-18 the array holds two entries — the email
   bucket, then invitation validation — pushed by `auth.config.ts` in one statement; a third
   appender pushes after them, and `auth.config.spec.ts`'s text rule (no `beforeHooks =` after
   the declaration) is what it will meet.*
4. **A `hooks.before` entry that refuses throws an `APIError` and nothing else.** Anything
   else aborts the request with a body-less 500 and skips every later hook.

   > **AND ITS MESSAGE ESCAPES THE FIELD ALLOWLIST — 2026-08-16, F-216.** ADR-0052's "exactly
   > one censoring mechanism" does not hold for the `onError` path. `api/index.mjs:199` is
   > `const log = optLogLevel === "error" || optLogLevel === "warn" || optLogLevel === "debug"
   > ? logger : void 0`, and that `logger` is better-auth's **package-level singleton**, not the
   > bound `log` hook — then `log?.error(e.message)`. No hook, no `disableColors`, straight to
   > `console.error`, past the pino allowlist. Verified at the source.
   >
   > **The level is not the cause**: `error`, `warn` and `debug` are all enabling values, so
   > this was equally true before F-175 moved the level to `'warn'`. Nothing leaks today because
   > every message on this path is a fixed string.
   >
   > **Item 1b makes it live.** The invitation-validation hook this initiative ships the empty
   > registry for is mandated to refuse with an `APIError`, and an invitation refusal is exactly
   > the message that would carry a token and an email. **Whoever writes that hook owns the
   > decision about what its message may contain**, and this invariant is where they will meet
   > it.
   >
   > **MET 2026-08-18 (TASK-1b-09): fixed strings only.** Every `APIError` either hook throws
   > carries one of the exported constants `EMAIL_RATE_LIMITED_MESSAGE`,
   > `INVITATION_NOT_FOUND_MESSAGE`, `INVITATION_EXPIRED_MESSAGE`, `INVITATION_REVOKED_MESSAGE`,
   > `INVITATION_ALREADY_ACCEPTED_MESSAGE`, `INVITATION_LOOKUP_FAILED_MESSAGE` — no token,
   > address, tenant id, user id or invitation id is ever interpolated. `invitation-signup.spec.ts`
   > asserts the constants name no value; `test/auth/signup-invited.int-spec.ts` and
   > `test/auth/sign-in-email-bucket.int-spec.ts` scan the child's captured stdout+stderr for
   > every token minted and every address used and find none. The unexpected-failure branch
   > logs once through the bound logger with `includeMessage: false` and rethrows a fixed 500.
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
- **`advanced.disableOriginCheck` is `false` and is stated, because absent it is not.**
  ADDED 2026-08-16 (F-206), found by the implement-phase security audit and verified at the
  source and by measurement. `create-context.mjs:210` reads
  `skipOriginCheck: options.advanced?.disableOriginCheck !== undefined ? … : isTest() ? true :
  false`, and `isTest()` is `nodeENV === 'test' || toBoolean(env.TEST)` where
  `toBoolean(v) = v ? v !== 'false' : false`.

  Two consequences, both measured. **`TEST=0` in production disables CSRF origin checking** —
  the string is truthy and is not the literal `'false'`, and a cross-origin `POST /sign-out`
  returned 200. And **the test tier runs at `NODE_ENV=test`**, so from wave 3 every request a
  test issues would bypass the check entirely: the whole `trustedOrigins` apparatus this
  contract specifies would never be consulted where it is measured.

  That makes it **the fourth finding on this one predicate** — F-170 no owner, F-181 admitting
  the platform wildcard, F-203 the wildcard branch validating less than the plain branch, and
  this — and it subsumes the other three, because a control that never runs cannot be tested
  into correctness. **Assert the resolved `$context.skipOriginCheck`, never the option**: this
  tier runs at `NODE_ENV=test`, so an unpinned key reads `true` in the assertion itself.

- **`get-session` returns the plaintext session token in its response body**, so `HttpOnly`
  protects it from nothing that already runs script on a trusted origin, and `bearer()` accepts
  that value as a complete credential. Recorded 2026-08-16 (F-208) as an **accepted cost with
  no owner in this initiative** rather than a defect: reaching it requires same-origin script
  execution, which is a different compromise from the one the cookie flag defends. The next
  initiative that ships a browser surface owns the decision to suppress the field.

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
