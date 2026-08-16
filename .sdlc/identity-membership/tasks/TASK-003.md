---
id: TASK-003
story: STORY-001
epic: EPIC-001
title: The Better Auth instance, its plugin configuration, and tenant creation on signup
status: todo
owner_slot: sdlc-implementer-backend
depends_on: [TASK-001, TASK-002]
paths: ["apps/api/src/auth/auth.config.ts", "apps/api/src/auth/on-user-created.ts", "apps/api/src/auth/revocation-store.ts", "apps/api/src/auth/auth.module.ts", "apps/api/src/app.module.ts", "apps/api/src/auth/boot-assertions.ts", "apps/api/src/main.ts", "apps/api/src/db/better-auth-database-callers.spec.ts", "packages/contracts/src/auth/index.ts", "docker-compose.yml", "apps/api/.env.example"]
# WIDENED 2026-08-13 at the Design wave-1 gate by Juano's ruling on F-033. boot-assertions.ts
# is CREATED here rather than by TASK-004, because the secret guard has to land in the same
# wave as the config it guards. main.ts is reached only to call it. TASK-004 remains the sole
# owner of the mount itself and is a wave later, so the two never write concurrently.
#
# WIDENED AGAIN 2026-08-15 at the Design wave-2 gate by Juano's ruling on F-168, to ONE FILE in
# packages/contracts and ONE DOCBLOCK in it. packages/contracts/src/auth/index.ts:133-138
# instructs `expirationTime: ACCESS_TOKEN_LIFETIME_SECONDS`, which mints tokens that expired in
# 1970 - see the correction below. TASK-001 owns that file and is `done`, so the correction has
# no live carrier otherwise. You correct the docblock in the same commit that writes the correct
# call site. THE EXPORTED VALUE DOES NOT CHANGE and nothing else in that package is yours.
#
# WIDENED A THIRD TIME 2026-08-15 by Juano's ruling on the wave-2 sequencing risk, to TWO
# ENTRIES and no more: BETTER_AUTH_URL and WEB_APP_ORIGINS, in docker-compose.yml's `api`
# environment block and in apps/api/.env.example. THIS WAVE ASSERTS BOTH AT BOOT, and
# docker-compose.yml belongs to TASK-018/TASK-019 (done) while apps/api/.env.example belongs to
# TASK-009 (wave 4) - so without a wave-2 owner the CI `compose` job cannot go green from this
# wave onward. THAT IS F-034's EXACT SHAPE, which cost five rulings and an amended criterion in
# a closed initiative; the same ruling that fixed it then applies now - the declarations land in
# the same wave as the assertions that read them. TASK-009 KEEPS EVERY OTHER ENTRY IN BOTH
# FILES, four waves later, exactly as it kept them around TASK-018's three.
contracts: [design/contracts/auth-tokens.md, design/contracts/tenant-context.md, design/contracts/auth-contracts.md, design/contracts/revocation-store.md, design/contracts/auth-config-surface.md]
# CONTRACTS LIST CORRECTED AND EXTENDED 2026-08-15 (F-167). The first two resolve under
# `.sdlc/foundation/design/contracts/`; the last three under this initiative's own `design/`.
# auth-contracts.md was missing and NAMES THIS CARD AS A CONSUMER at its own :9-11 - it fixes
# the claim shape, the password bounds and ACCESS_TOKEN_LIFETIME_SECONDS. It was frozen at the
# wave-1 gate and no card of nineteen cited it. revocation-store.md and auth-config-surface.md
# are new in wave 2 and are normative for this card.
test_files: ["apps/api/src/auth/auth.config.spec.ts (unit)", "apps/api/src/auth/on-user-created.spec.ts (unit)", "apps/api/src/auth/boot-assertions.spec.ts (unit — the secret half AND the BETTER_AUTH_URL loopback rule: http://localhost:3001 accepted, http://api.example.com refused; TASK-004 extends this file with assertAuthRoleSeparation in wave 3)", "apps/api/test/auth/signup-creates-tenant.int-spec.ts (integration)", "apps/api/test/auth/mint-refuses-without-membership.int-spec.ts (integration, NEW — AC-4's mint half; TASK-002 covers only tenantIdForUser throwing)", "apps/api/src/auth/revocation-store.spec.ts (unit — NEW, wave 2: eviction order, TTL, revoke-never-rejects)"]
acceptance: [AC-1, AC-3, AC-5, AC-4]
# AC-4 ADDED 2026-08-13, Test phase. It was claimed by TASK-002 alone and half of it - the mint
# leg - is not dischargeable there. NOTE: this breaks plan.md's "36 ACs each claimed by EXACTLY
# one TASK" for AC-4, which is now claimed by two. That is deliberate and recorded rather than
# resolved by re-cutting the AC, because both halves are real and they land in different waves.
rework_count: 0
---

## Intent

Compose the one Better Auth instance this repository has — adapter, plugins, claim set,
hook registry — and attach tenant creation to it, so that a signup produces exactly one
tenant and exactly one membership.

## Approach

`apps/api/src/auth/auth.config.ts` holds the whole `betterAuth({ ... })` composition. It is
one file with one exported instance, and nothing else in this initiative writes to it.

**Adapter — DECIDED, and this paragraph was rewritten 2026-08-16 because its old form is now
wrong.** It read `drizzleAdapter(db, { provider: 'pg' })` "sharing the application's Drizzle
client", and closed by listing the client question as an open Design decision for the
architect. Both are stale: ADR-0046 and ADR-0050 answered it in wave 1, and an implementer
reading that line top-down writes an adapter on the wrong pool as the wrong role.

**Write `drizzleAdapter(betterAuthDatabase(), { provider: 'pg', schema: betterAuthSchema,
transaction: false })`** — the exact value is in `auth-config-surface.md`'s table, which is
normative. `betterAuthDatabase()` is a **second pool** on `DATABASE_AUTH_URL`, connecting as
`shortkit_auth`; `shortkit_app` was revoked on all five auth tables by migration `0001`, so the
application's own client cannot read `user` at all. One migration system still holds (ADR-0004,
ADR-0019). `databaseTransaction`'s enumerated caller list at `client.ts:11-23` is **not**
widened by this card — the adapter never touches it, which was the point of a separate export.

**You are the first and only caller of `betterAuthDatabase()`**, and you ship the control that
keeps it that way — see the caller-list scans below.

**Plugins: `jwt` and `bearer`.** The `jwt` plugin's `expirationTime` is 300 seconds — read
`ACCESS_TOKEN_LIFETIME_SECONDS` from `@shortkit/contracts` rather than restating `'5m'`.

> **CORRECTED 2026-08-15, F-168, Juano's ruling. Write it as
> `` expirationTime: `${ACCESS_TOKEN_LIFETIME_SECONDS}s` ``, a STRING.**
>
> The bare number mints tokens that expired in 1970. `sign.mjs:13` passes the value to
> `toExpJWT`, and `utils.mjs:15-19` returns a **number unchanged** as the `exp` claim — only a
> string goes through `iat + sec(expirationTime)`. So `expirationTime: 300` sets `exp` to epoch
> second 300, `1970-01-01T00:05:00Z`. Measured twice: read at the source, then minted as a real
> token by the wave-2 security auditor, which read `exp = 300` back off it.
>
> **The constant stays a number** — `REVOCATION_TTL_SECONDS` derives from it and needs seconds —
> so the conversion happens here, at the call site. The same defect is instructed by
> `packages/contracts/src/auth/index.ts:133-138`, which is now in your paths, and by frozen
> `auth-contracts.md:136-138`, which is amended. It fails **closed**: every token is rejected the
> instant it is issued, which is why this is a correctness finding and not a security one.
`definePayload` returns `jti: session.id`, `email: user.email`, `ev: user.emailVerified` and
`tid: await tenantIdForUser(user.id)`.

Four things about that payload are load-bearing and every one of them fails silently:

- **`jti` must be returned explicitly.** `dist/plugins/jwt/sign.mjs:49` reads
  `if (payload.jti) jwt.setJti(payload.jti)`, so the claim exists only when `definePayload`
  puts it there. A probe against 1.6.26 with this exact config returned `aud, email, ev,
  exp, iat, iss, sub, tid` and **no `jti`** (ADR-0013, F-227). Revocation keys on `jti`.
- **`jti` is the session id, not a per-token random**, deliberately: sign-out holds a
  session and not a token (`dist/api/routes/sign-out.mjs:20-22`), so keying on the session
  id is what makes one revocation cover every token that session ever minted. It is
  therefore **not unique per token** and must never be used for replay detection.
- **Do not write `sub` inside `definePayload`.** `sign.mjs:56-59` spreads the return and
  then overwrites `sub` with `getSubject?.(session) ?? session.user.id`. A `sub` line there
  reads as load-bearing and is not. *(Citation corrected 2026-08-15 from `:53-61`, which was
  the enclosing function; the statement is at `:56-59` in the installed 1.6.26. The substance
  was right and was re-verified against the install.)*
- **`tid` is what removes the guard's chicken-and-egg problem.** The guard needs a tenant to
  open a transaction, and a database lookup for it would run outside tenant context.
  `tenantIdForUser` throwing (TASK-002) is the primary stop for an orphaned account.

**`rateLimit: { enabled: false }`. We are the limiter of record.** Better Auth's built-in
limiter is enabled in production by default (`dist/context/create-context.mjs:171`,
`enabled: options.rateLimit?.enabled ?? isProduction`), and it is invisible everywhere it
would be caught: off in development, off in the test environment, on only in production.
Its header is `X-Retry-After`, not `Retry-After`, and its body carries no
`code: "rate_limited"`, so a 429 from it maps to `internal_error` at the web client. It is
also IP-keyed on a topology where the key would be the BFF's egress address. **This TASK
owns a unit test asserting the composed config carries `rateLimit.enabled === false`**
(AC-5): of the Better Auth facts this design leans on, it is the only one that degrades
silently and only in production.

**`hooks.before` is a registry, not a function.** Better Auth takes a single `before`
function; this TASK creates the array **empty** and iterates it, so that item 1b's
invitation-validation hook and any rate-limit hook **append** rather than replace. A later
author who replaces the array silently deletes every earlier hook (ADR-0013, F-054, F-019).

```ts
const beforeHooks: AuthBeforeHook[] = [];   // appended to, never replaced
hooks: { before: createAuthMiddleware(async (ctx) => {
  for (const hook of beforeHooks) await hook(ctx);   // ordered, short-circuit on throw
}) }
```

**`databaseHooks.session.delete.after`** calls `revocationStore.revoke(session.id)` with a
TTL of the **full 300-second token lifetime counted from the write** — the write site holds
a session and not a token, so there is no `exp` to subtract from, and anything shorter lets
a live token outlive its own revocation entry (ADR-0013, F-227). `with-hooks.mjs:115-147`
reads the row before deleting and passes the whole row, so `session.id` is available;
`deleteManyWithHooks` does the same per row, so this one hook covers sign-out,
`revoke-session`, `revoke-other-sessions` and delete-user rather than sign-out alone. **It
must not throw**: the session is already gone, and failing a sign-out because a store is
unavailable contradicts ADR-0012's posture.

`apps/api/src/auth/revocation-store.ts` declares the port and ships the process-local
implementation. **Redis is not available in this repository** — `redisClient` is deferred
TASK-030 and no Redis client exists in `apps/api/src`. A process-local store is weaker than
ADR-0013's Redis one across more than one process.

**DECIDED 2026-08-16 by ADR-0053 — this was listed as an open Design decision and is not one
any more.** `design/contracts/revocation-store.md` is normative for the port; build to it, not
to this paragraph. Three things in it are easy to get wrong:

- **`revoke` never rejects; `isRevoked` may.** That asymmetry is deliberate. A sign-out must not
  fail because a store is unavailable (ADR-0012), but a guard that cannot tell "not revoked"
  from "could not tell" is forced to treat an unreachable store as proof of validity — F-245's
  rule one level down. `RevocationStoreUnavailableError` is what the port uses to say so, and
  the in-memory implementation never raises it because a `Map` read cannot fail.
- **`delete` before `set` in `revoke`.** `Map.set` on an existing key keeps its original
  insertion position, and `revoke` is idempotent with a refreshed TTL — so without the delete, a
  session revoked twice holds the newest expiry at the oldest position and is evicted **first**.
  Assert it.
- **Eviction is a control-bypass primitive, not a memory accident** (F-177). Every session
  deletion writes an entry and sign-in/sign-out is attacker-reachable; what makes flushing the
  map expensive is **TASK-004's IP-keyed limiter, in another card**. ADR-0053 names that
  coupling — do not weaken the ceiling without reading it.

**Correct on exactly one API process, which is everything this repository runs today** — compose
declares one `api` service with no `scale`, and there is no deploy manifest at all. ADR-0053
carries what makes that assumption visible if the topology ever changes.

**`databaseHooks.user.after` (`onUserCreated`) creates the tenant.** Per ADR-0015's
uninvited branch, which is the only branch in this initiative: generate a tenant id with
`crypto.randomUUID()`, open `withTenantTransaction` on it, insert the `tenants` row under
`tenants_self_insert`, and insert the `tenant_memberships` row at `TENANT_ROLE.owner`.

**It runs after the user row commits, so signup is not atomic across the two** (ADR-0013
F-029, ADR-0015's correction). The residue if the membership write fails is a `user` row
with no `tenant_memberships` row: an account that cannot obtain a `tid` claim and therefore
cannot authenticate anywhere. That orphan is the **accepted** failure mode. Do not add a
compensating delete of the user row to tidy it away without an ADR amendment — ADR-0015
rules the orphan acceptable and the alternative (a membership row in an unproven tenant)
unacceptable, and a cleanup path is a second decision.

`app.module.ts` gains `AuthModule` in its `imports` array. That is the file's only change
here; `APP_FILTER` and `HealthModule` are untouched.

## The secret and the logger — added 2026-08-13, Design rounds 3 and 4

**Both keys go on the composed config, and neither was in this card before the Design gate**
(F-032). ADR-0051 and ADR-0052 are the sources; read them.

**`secret: betterAuthSecret()`.** Without an explicit key, better-auth@1.6.26 falls back to a
**published constant** — `create-context.mjs:70` is `options.secret || env.BETTER_AUTH_SECRET
|| env.AUTH_SECRET || ""` and then `|| DEFAULT_SECRET`. That constant is the symmetric key
for `jwks.privateKey`, so one `jwks` row plus a value anyone can read from npm forges any
`tid` claim in the product. `validateSecret` returns early under `isTest()` and throws only
under `isProduction`, so **the two environments that exist here are the two it does not
cover** (F-020).

`betterAuthSecret(): string` **throws** — on unset, on empty, under 32 characters, and on the
published constant.

> **THREE REJECTIONS, NOT FOUR — settled 2026-08-15 at the Design wave-2 gate.** F-074 amended
> this card on 2026-08-14 to reject **two** values by exact match: better-auth's
> `better-auth-secret-12345678901234567890` and the compose default
> `development-compose-better-auth-secret-not-a-real-value` that TASK-018 introduced. **F-144
> then removed that compose literal.** `docker-compose.yml:295` is now
> `${BETTER_AUTH_SECRET:?...}`, a required reference with no fallback, and the literal appears
> nowhere in the tree — verified by grep twice, once by the wave-2 scout and once by the
> architect. ADR-0051's own conditional made the fourth rejection contingent on that literal
> still being there, so it is not owed. Reject: unset-or-empty, shorter than 32, and
> `better-auth-secret-12345678901234567890`.

The disqualifying property is **publication, not length or shape**: a value committed to a
public repository sits in a history nobody can rewrite, which is the same property as F-020's
blocker rather than one comparable to it. A locally generated string of identical shape is fine. It must never return `''` or `undefined`, and the reason is the
`||` chain above: a falsy return is not an override, it falls straight through to the
default and restores exactly the state this is fixing (F-033).

**`assertBetterAuthSecretConfigured()` is yours, not TASK-004's.** Juano moved it here from
wave 3 at the Design gate, because the alternative was one whole wave in which `pnpm dev`
boots an auth surface on the published constant with no assertion anywhere. Create
`apps/api/src/auth/boot-assertions.ts` and call it from `main.ts`. TASK-004 adds
`assertAuthRoleSeparation()` to the same file in wave 3.

**`logger`.** Better Auth's own `console.error`/`console.warn` channel bypasses the field
allowlist entirely, which defeats ADR-0028's "exactly one censoring mechanism" by
construction rather than by defect. State a `log` hook forwarding into the shared pino
instance, **`level: 'warn'`**, `disableColors: true`, args deliberately dropped (ADR-0052).

> **`'warn'`, not `'error'` — corrected 2026-08-15 (F-175, ADR-0060).** Composed with the exact
> logger ADR-0052 mandates, the bound hook received **zero lines**: `'error'` filtered out
> `create-context.mjs:64`'s warning that the base URL is unset and the origin is being derived
> per request — the line that reports two of this wave's major findings — plus the short-secret
> warning and `rate-limiter/index.mjs:284`'s "cannot determine a client IP", which is the
> control TASK-004 depends on. The email line that justified `'error'` is `logger.info` at the
> source, so `'warn'` suppresses it just as completely. **`auth.config.spec.ts` asserts
> `level === 'warn'`.**
`auth.config.spec.ts` asserts the secret is not the default and the logger key is present.

## AC-4's mint half is yours — added 2026-08-13, Test phase

**TASK-002 cannot discharge AC-4 alone**, found by the test architect while writing wave 1's
tests. AC-4's clause *"when a JWT is minted … no JWT is returned, and the caller receives an
error rather than a token with an absent `tid`"* needs the mint path, and the mint path is this
card's `definePayload`. TASK-002 covers only `tenantIdForUser` throwing — the primary stop
ADR-0015 names — so **AC-4 is green on a partial proof until a test here asserts the mint leg.**

Write it against the composed instance: a user with no `tenant_memberships` row produces an
**error, not a token**, and no token is issued carrying an absent or empty `tid`. GC-D fixes the
claim set and `definePayload` must return `jti`, so the failure has to be raised before a payload
is signed rather than by omitting a claim from one.

## The auth handle needs its file-list control HERE — added 2026-08-14, F-108, Juano's ruling

**You are the first card that actually uses `betterAuthDatabase()`, and you ship its only control.**

`client.ts:259` exports an unconstrained handle: outside any transaction, no context flag, on the
auth pool. A security auditor **read another user's plaintext `session.token` through it from a bare
script.** That is not a defect in `client.ts` — the handle has to exist for the adapter — it is that
nothing bounds who may hold it.

ADR-0046 specified the bound as "`betterAuthDatabase` appears in exactly two files" and **deferred it
to TASK-056, which is not in this initiative.** Juano pulled it here. The reason the deferral stopped
being acceptable is worth understanding rather than just complying with:

**It was priced against a model that no longer holds.** When ADR-0046 accepted the deferral, this
handle sat on the *same* pool as `databaseTransaction` — as `shortkit_app`, which the `REVOKE` in
migration `0001` has since stripped of every privilege on the five auth tables. ADR-0050 moved it to
`shortkit_auth`, **the one role that can read `session.token`**. The exposure changed from
tenant-scoped rows to plaintext session tokens and password hashes, and nobody re-priced it.

That is F-024's exact shape — a cost priced against one model, the model changed, the price never
revisited — which is the thing this initiative's whole role split exists to correct.

**Build it as the same shape as the A1/A4 control TASK-002 already ships**: a unit spec under
`src/**` that greps `apps/api/src` for `betterAuthDatabase` and asserts the set of files equals the
permitted list. It must live under `src/**` — `vitest.config.ts:10` includes `src/**/*.spec.ts` and
nothing else, and a file under `test/` named `*.spec.ts` collects in neither tier and passes by
never running.

**The permitted list is `client.ts` and this card's `auth.config.ts`.** Anything else is a diff
somebody has to justify, which is the whole point.

## The composition is specified key by key in a contract — added 2026-08-16, Design wave 2

**`design/contracts/auth-config-surface.md` is normative for `betterAuth({ ... })` and it is in
your `contracts:` list. Read it before you write the file, and where this card and that table
disagree, the table wins.** It carries every key, its exact value, the ADR behind it, and an
**assert-in-spec** column naming the ones `auth.config.spec.ts` must pin. This card does not
restate the table — two mechanisms carrying one permitted list is what F-044 was spent undoing.

What the wave-2 security pass established, all of it by execution, and none of it visible in a
passing test unless you write the assertion:

- **`baseURL` is load-bearing.** Unset, better-auth re-derives the origin from the **Host
  header** per request, and `iss`/`aud` come from that. Measured: one session, two Hosts, two
  validly-signed tokens with different issuers, same `kid`, both conforming to
  `shortkitJwtClaimsContract` because it types `iss` as `z.string().min(1)`. Pin `jwt.issuer`
  and `jwt.audience` too — the plugin does not inherit them from a fixed `baseURL` for free.
- **Never let `Secure` fall out of `NODE_ENV`.** It is `advanced.useSecureCookies`, derived
  from the resolved `BETTER_AUTH_URL`'s scheme. The measured default issued a session cookie
  with no `Secure` and no `__Secure-` prefix, and that cookie is a full credential through the
  `bearer` plugin.
- **`emailAndPassword.enabled: true` is not a default.** `sign-up.mjs:144` answers
  `400 EMAIL_PASSWORD_SIGN_UP_DISABLED` without it, so omitting it means there is no signup.
- **`emailAndPassword.autoSignIn: false`** (ADR-0061) and **`minPasswordLength`/
  `maxPasswordLength` deliberately unset** (Juano's ruling — the library's 8 and 128 are
  inherited, and frozen `auth-tokens.md:99` has a test asserting this file sets neither).
- **`disableSettingJwtHeader: true`** (ADR-0055).

**Two boot assertions, not one.** `assertBetterAuthSecretConfigured()` and the
`BETTER_AUTH_URL` one; `boot-assertions.ts`'s stub carries both signatures and the shared error
class. `assertWebAppOriginsConfigured` rejects wildcard forms `auth-tokens.md:158-162` rules
out — a developer clearing a local 403 reaches for `*`, and the assertion is what stops it
reaching production. **TASK-004 adds `assertAuthRoleSeparation` to the same file in wave 3.**

**The caller-list spec ships four scans, and ADR-0056 says plainly which one is load-bearing**
(the `process.env.DATABASE_AUTH_URL` equality, permitted in `db/client.ts` only) and which is a
tripwire. Do not describe the tripwire as coverage. **Scan 2 is a subset assertion and the other
three are equalities** — the table in ADR-0056 gives the direction per scan, and scan 2 is the
one that cannot be an equality because its permitted set is deliberately ahead of the tree.

> **Two of the four go red on first run if you write the regex the obvious way** (F-191, found
> by the wave-2 security pass). A bare `/'pg'/` for scan 4 matches the **mandated**
> `provider: 'pg'` in your own `auth.config.ts`. Scan 3's bracket forms under a bare
> `/process\.env\[/` match `build-commit.ts:39` today. Both anchor correctly in one regex —
> anchor them.
>
> **This matters more than a first-run annoyance.** F-186 was this same failure one round
> earlier in the design, and its lesson is what a red control costs: the cheapest way to green
> it is to trim the permitted set to whatever the tree contains, **which deletes the bound the
> scan exists to enforce**. You will meet these with no memory of F-186, which is why it is
> written here rather than in the ADR.

**`test_files` gains `apps/api/src/auth/revocation-store.spec.ts` (unit).** The eviction order
assertion is real work: `revoke` must `delete` before `set`, or a re-revoked session keeps its
original insertion position, holds the newest expiry, and is evicted first.

## Where `BETTER_AUTH_URL` and `WEB_APP_ORIGINS` are declared — added 2026-08-16

Both entries are yours this wave, in `docker-compose.yml`'s `api` environment block and in
`apps/api/.env.example`, **which does not exist yet and you create**. TASK-009 fills in the rest
of that file four waves later. **Exact entries and the `pnpm dev` refusal text are in ADR-0059,
"Where the two bindings are declared" — copy them from there.**

**Both carry a compose default** (`BETTER_AUTH_URL:-http://localhost:3001`,
`WEB_APP_ORIGINS:-http://localhost:3000`), because neither is a credential and the file already
commits four role passwords. That is what keeps the CI `compose` job green from this wave
onward without anything exported, and it leaves **`BETTER_AUTH_SECRET` as the only variable in
that file with no default**, which is the property worth protecting.

## Two assertions that decide open questions — added 2026-08-16, Design wave 2

**`signup-creates-tenant.int-spec.ts`: a duplicate-address signup and a fresh-address signup
return bodies that are byte-identical after normalising `id`, `createdAt` and `updatedAt`.**

Assert **whole-body equality**, not the absence of an `image` key. The named-key form passes
the day the library changes either branch; whole-body equality is the only shape that stays
true.

> **This test settles a question the design could not.** ADR-0061 takes
> `emailAndPassword.autoSignIn: false`, which closes the `422 USER_ALREADY_EXISTS` status-code
> oracle. Whether it closes the **oracle** is undetermined: measured on better-auth's in-memory
> adapter, an existing address returns a `user` object carrying `image` and a fresh one does
> not — present if and only if the address exists, deterministically, no timing analysis. Under
> the real drizzle adapter the two branches may both serialise a stored row and converge, since
> `user.image` is nullable in migration `0001`. **Both outcomes are pre-committed:** if this
> test passes it is the standing guard; if it fails, the existence disclosure is real, gets
> accepted explicitly, and ADR-0061 is superseded rather than left claiming a closure it does
> not have.

Keep the existing check beside it: the duplicate answers 200 and **no second `user` row and no
second tenant** are created.

**`boot-assertions.spec.ts`: `http://localhost:3001` is accepted and `http://api.example.com`
is refused**, with the refusal naming the rule.

> `http:` is permitted **only** for a loopback host — `localhost`, an address in `127.0.0.0/8`,
> or `[::1]`; `https:` for any host. Without that rule the binding that exists to force a
> `Secure` session cookie permits a non-Secure one: measured, `http://api.example.com` issued
> `better-auth.session_token` with `secure: false` and no `__Secure-` prefix, **with every
> assertion green**, because a value was set. `advanced.useSecureCookies` derives from this one
> string, so nothing downstream can catch it. It reads no `NODE_ENV`, so GC-B holds, and the
> compose default `http://localhost:3001` keeps working unchanged — the rule is what makes a
> committed default safe **wherever it is copied**, not only where it sits.
>
> Two residuals, both deliberate and both stated in ADR-0059: it is a **string** test and not a
> resolution test, so a hostname resolving to `127.0.0.1` is still refused under `http:`; and it
> refuses a TLS-terminating proxy speaking `http` to a non-loopback backend, on purpose.

## Out of scope for this TASK

The Express mount, `bodyParser: false`, `authBodyCap` and `authRateLimit` (TASK-004 —
ADR-0013 fixes the mount as one registration in one file). **`assertAuthRoleSeparation` and
`assertBffProxySecretConfigured` are TASK-004's**, in the file this TASK creates; the secret
assertion above is the only boot assertion here. `AuthGuard` and the revocation **read**
(TASK-005). Invitation validation and any `before` hook body (item 1b — this TASK ships the
registry empty). Email verification, mail, password reset. Any Redis binding.

## Interfaces

**Consumes**

From TASK-002:
- `tenantIdForUser(userId: string): Promise<string>` — throws `NoTenantMembershipError`
- `class NoTenantMembershipError extends Error`
- `tenantMemberships` Drizzle table with columns `id`, `tenantId`, `userId`, `role`, `createdAt`
- `apps/api/src/db/schema/auth.ts` — Better Auth's `user`, `session`, `account`, `verification` and key table

From TASK-001 (`@shortkit/contracts`):
- `ACCESS_TOKEN_LIFETIME_SECONDS = 300`
- `shortkitJwtClaimsContract`, `type ShortkitJwtClaims`
- `asTenantRole(value: string): TenantRole`, `TENANT_ROLE.owner`

From `apps/api/src/tenancy/tenant-context.ts` (shipped):
- `withTenantTransaction<T>(tenantId: string, fn: (db: TenantDb) => Promise<T>, options?: { afterCommit?: () => Promise<void> }): Promise<T>` — nesting under the same `tenantId` reuses the outer transaction; a different `tenantId` throws `TenantContextMismatchError`. **Third-party I/O goes in `afterCommit`, never in `fn`** (ADR-0002).
- `assertUuid(value: string): string` — returns the lower-cased canonical form

From `apps/api/src/db/schema/tenants.ts` (shipped): `tenants`.

**Produces**

- `apps/api/src/auth/auth.config.ts` exporting:
  - `auth` — the composed Better Auth instance, the single value TASK-004 mounts
  - `beforeHooks: AuthBeforeHook[]` — created **empty**; appenders push, never assign
  - `type AuthBeforeHook = (ctx: AuthMiddlewareContext) => Promise<void>`
- `apps/api/src/auth/on-user-created.ts` exporting:
  - `createTenantForNewUser(user: { id: string; email: string }): Promise<{ tenantId: string; membershipId: string }>` — mints the tenant id with `crypto.randomUUID()`, writes both rows, and resolves only after the transaction commits
- `apps/api/src/auth/revocation-store.ts` exporting:
  - `interface RevocationStore { revoke(sessionId: string): Promise<void>; isRevoked(sessionId: string): Promise<boolean> }` — `revoke` never throws
  - `REVOCATION_TTL_SECONDS = 300`
  - `revocationStore: RevocationStore` — the bound instance TASK-005 reads
- `apps/api/src/auth/auth.module.ts` exporting `AuthModule`
