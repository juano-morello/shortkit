---
id: TASK-003
story: STORY-001
epic: EPIC-001
title: The Better Auth instance, its plugin configuration, and tenant creation on signup
status: todo
owner_slot: sdlc-implementer-backend
depends_on: [TASK-001, TASK-002]
paths: ["apps/api/src/auth/auth.config.ts", "apps/api/src/auth/on-user-created.ts", "apps/api/src/auth/revocation-store.ts", "apps/api/src/auth/auth.module.ts", "apps/api/src/app.module.ts"]
contracts: [design/contracts/auth-tokens.md, design/contracts/tenant-context.md]
test_files: ["apps/api/src/auth/auth.config.spec.ts (unit)", "apps/api/src/auth/on-user-created.spec.ts (unit)", "apps/api/test/auth/signup-creates-tenant.int-spec.ts (integration)"]
acceptance: [AC-1, AC-3, AC-5]
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

## Out of scope for this TASK

The Express mount, `bodyParser: false`, `authBodyCap`, `authRateLimit` and the boot
assertions (TASK-004 — ADR-0013 fixes the mount as one registration in one file and it is
`main.ts`, which this TASK does not touch). `AuthGuard` and the revocation **read**
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
