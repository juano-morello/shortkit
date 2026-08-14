---
id: TASK-003
story: STORY-001
epic: EPIC-001
title: The Better Auth instance, its plugin configuration, and tenant creation on signup
status: todo
owner_slot: sdlc-implementer-backend
depends_on: [TASK-001, TASK-002]
paths: ["apps/api/src/auth/auth.config.ts", "apps/api/src/auth/on-user-created.ts", "apps/api/src/auth/revocation-store.ts", "apps/api/src/auth/auth.module.ts", "apps/api/src/app.module.ts", "apps/api/src/auth/boot-assertions.ts", "apps/api/src/main.ts", "apps/api/src/db/better-auth-database-callers.spec.ts"]
# WIDENED 2026-08-13 at the Design wave-1 gate by Juano's ruling on F-033. boot-assertions.ts
# is CREATED here rather than by TASK-004, because the secret guard has to land in the same
# wave as the config it guards. main.ts is reached only to call it. TASK-004 remains the sole
# owner of the mount itself and is a wave later, so the two never write concurrently.
contracts: [design/contracts/auth-tokens.md, design/contracts/tenant-context.md]
test_files: ["apps/api/src/auth/auth.config.spec.ts (unit)", "apps/api/src/auth/on-user-created.spec.ts (unit)", "apps/api/src/auth/boot-assertions.spec.ts (unit — the secret half; TASK-004 extends this file with assertAuthRoleSeparation in wave 3)", "apps/api/test/auth/signup-creates-tenant.int-spec.ts (integration)", "apps/api/test/auth/mint-refuses-without-membership.int-spec.ts (integration, NEW — AC-4's mint half; TASK-002 covers only tenantIdForUser throwing)"]
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

**Adapter.** `drizzleAdapter(db, { provider: 'pg' })`, sharing the application's Drizzle
client (ADR-0013). One migration system, which ADR-0004 and ADR-0019 both depend on. The
client `apps/api/src/db/client.ts` exports is `databaseTransaction` alone, against an
enumerated caller list at `client.ts:11-23` — how the adapter obtains a client without
widening that list unilaterally is a **Design decision**, listed for the architect.

**Plugins: `jwt` and `bearer`.** The `jwt` plugin's `expirationTime` is 300 seconds — read
`ACCESS_TOKEN_LIFETIME_SECONDS` from `@shortkit/contracts` rather than restating `'5m'`.
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
- **Do not write `sub` inside `definePayload`.** `sign.mjs:53-61` spreads the return and
  then overwrites `sub` with `getSubject?.(session) ?? session.user.id`. A `sub` line there
  reads as load-bearing and is not.
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
ADR-0013's Redis one across more than one process, and that weakening is a **Design
decision** listed for the architect, not a choice this TASK makes on its own.

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

`betterAuthSecret(): string` **throws** — on unset, on empty, under 32 characters, and on
**either** published constant. Amended 2026-08-14 (F-074): there are now **two** rejected by
exact value — better-auth's `better-auth-secret-12345678901234567890` and the compose default
`development-compose-better-auth-secret-not-a-real-value` that TASK-018 introduced. The
disqualifying property is **publication, not length or shape**: the compose value is committed
to a public repository, so it sits in a history nobody can rewrite, which is the same property
as F-020's blocker rather than one comparable to it. A locally generated string of identical
shape is fine. It must never return `''` or `undefined`, and the reason is the
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
instance, `level: 'error'`, `disableColors: true`, args deliberately dropped (ADR-0052).
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
