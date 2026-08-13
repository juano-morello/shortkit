---
id: TASK-005
story: STORY-002
epic: EPIC-001
title: AuthGuard — claim verification against cached JWKS, revocation check, and RequestContext
status: todo
owner_slot: sdlc-implementer-backend
depends_on: [TASK-004]
paths: ["apps/api/src/auth/auth.guard.ts", "apps/api/src/auth/auth-claims.ts", "apps/api/src/auth/jwks-cache.ts"]
contracts: [design/contracts/auth-tokens.md, design/contracts/error-envelope.md]
test_files: ["apps/api/src/auth/auth-claims.spec.ts (unit)", "apps/api/src/auth/jwks-cache.spec.ts (unit)", "apps/api/test/auth/auth-guard.int-spec.ts (integration)"]
acceptance: [AC-10, AC-11, AC-12, AC-13]
rework_count: 0
---

## Intent

Turn a bearer token into a `RequestContext`, or into a 401, with no database read on the
happy path.

## Approach

An ordered, short-circuiting guard. The order is the specification, because each step
assumes the previous one held:

1. **Public-route check first.** Read `PUBLIC_ROUTE_METADATA` from the handler and its
   class; if present, return `true` immediately and populate nothing.
2. **Bearer presence.** No `Authorization: Bearer <token>` header — 401,
   `code: "unauthenticated"`.
3. **Signature**, against the cached JWKS. Failure — 401, `unauthenticated`.
4. **Expiry.** `exp` in the past — 401, `code: "token_expired"`. This is the one 401 with a
   distinct code, and the web client depends on it to decide whether to refresh.
5. **`iss` and `aud`.** Mismatch — 401, `unauthenticated`.
6. **Revocation.** `revocationStore.isRevoked(claims.jti)`. Revoked — 401,
   `unauthenticated`. **`jti` is an opaque revocation handle and is the Better Auth session
   id, not a per-token random** (ADR-0013, F-227): do not assume uniqueness per token, and do
   not use it for replay detection. **The check skips open when the store is unavailable**,
   matching ADR-0012's posture, so a captured token stays usable for at most its remaining
   300 seconds.
7. **Claim shape.** `tid` present and uuid-shaped, `sub` present and non-empty, `ev`
   boolean. Otherwise 401, `unauthenticated`. **This step is the backstop ADR-0015's F-029
   correction added**: without it a tid-less token passes the guard and is stopped one layer
   down by `withTenantTransaction`'s uuid validation, surfacing as a **500 instead of a 401**.
8. **Populate `RequestContext`** — `userId` from `sub`, `tenantId` from `tid`,
   `emailVerified` from `ev`. **From claims only. No database read.**

**Email verification is off in this initiative**, so a false `ev` does **not** produce a 403
`email_not_verified` here. The code exists in `ERROR_CODES` and stays unused. Recording that
as a decision rather than an omission: requiring verification would make signup
uncompletable while `MAIL_TRANSPORT` unset binds a no-op sender, and mail is out of scope.

**Verification is stateless against cached JWKS.** Fetch `/api/auth/jwks` once and cache the
key set in process for 10 minutes. No database read and no store read on the happy path —
the revocation check is a store read and is the one exception, and it is what makes step 6's
skip-open posture matter.

Every refusal renders through the existing `ApiExceptionFilter` and
`errorEnvelopeContract`, so a 401 body is `{ code, message }` with the code drawn from
`ERROR_CODES` and the status drawn from `ERROR_CODE_STATUS`. **Nothing may return a code
with a different status than that map fixes.**

The guard must not log the token, the `Authorization` header, the email claim or the
decoded claim set. `LOGGABLE_FIELDS` is an allowlist and an unnamed field renders as
`[redacted]`, but `msg` is a top-level key no censoring path can reach — so a refusal
message must not interpolate a claim value.

## Out of scope for this TASK

Opening the tenant transaction and the three decorator implementations (TASK-006 — this TASK
**reads** `PUBLIC_ROUTE_METADATA`, and the decorator that writes it is TASK-006's). Any
workspace or tenant role check — `RequireTenantRole`, `RequireWorkspaceRole` and
`WorkspaceGuard` are item 1b. The revocation **write** and the store implementation
(TASK-003). Anything under `apps/api/src/auth/auth.config.ts` or `main.ts`.

## Interfaces

**Consumes**

From TASK-003:
- `revocationStore: RevocationStore` with
  `isRevoked(sessionId: string): Promise<boolean>` and `revoke(sessionId: string): Promise<void>`

From TASK-004: the mounted `/api/auth/{*splat}` surface, which is what serves `/api/auth/jwks`.

From `apps/api/src/tenancy/tenant-context.ts` (shipped):
- `interface RequestContext { readonly userId: string; readonly tenantId: string; readonly emailVerified: boolean; workspaceId?: string; workspaceRole?: WorkspaceRole; tenantRole?: TenantRole }` — declared at `tenant-context.ts:342-349`, populated by this guard from claims only
- `PUBLIC_ROUTE_METADATA: symbol`
- `assertUuid(value: string): string` — throws `InvalidTenantIdError`; returns the lower-cased canonical form

From `packages/contracts` (TASK-001 and shipped):
- `shortkitJwtClaimsContract`, `type ShortkitJwtClaims`
- `ERROR_CODES`, `ERROR_CODE_STATUS`, `errorEnvelopeContract`

From `apps/api/src/common/errors/` (shipped): `DomainError`, `ApiExceptionFilter`.

**Produces**

- `apps/api/src/auth/auth-claims.ts` exporting:
  - `verifyAndReadClaims(token: string, keySet: JsonWebKeySet, env: NodeJS.ProcessEnv): Promise<ShortkitJwtClaims>` — throws a `DomainError` carrying `unauthenticated` or `token_expired`
  - `assertClaimShape(claims: unknown): asserts claims is ShortkitJwtClaims` — `tid` uuid-shaped or `unauthenticated`
- `apps/api/src/auth/jwks-cache.ts` exporting:
  - `JWKS_CACHE_TTL_MS = 600_000`
  - `cachedKeySet(): Promise<JsonWebKeySet>` — one fetch per TTL per process
- `apps/api/src/auth/auth.guard.ts` exporting:
  - `AuthGuard implements CanActivate` — populates `RequestContext` on the request; the eight steps above in that order
  - `REQUEST_CONTEXT_KEY` — the request property the interceptor (TASK-006) reads the populated `RequestContext` from
