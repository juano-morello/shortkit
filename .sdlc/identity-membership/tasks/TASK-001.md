---
id: TASK-001
story: STORY-001
epic: EPIC-001
title: Auth and tenant-membership contracts in packages/contracts
status: tests-red
owner_slot: sdlc-implementer-backend
depends_on: []
paths: ["packages/contracts/src/auth/**", "packages/contracts/src/members/**", "packages/contracts/src/roles.ts", "packages/contracts/src/index.ts"]
contracts: [design/contracts/auth-tokens.md, design/contracts/error-envelope.md]
test_files: ["packages/contracts/src/auth/auth.spec.ts (unit)", "packages/contracts/src/members/members.spec.ts (unit)", "packages/contracts/src/roles.spec.ts (unit)"]
acceptance: [AC-8]
rework_count: 0
---

## Intent

Give both deployables one zod-declared vocabulary for signup, sign-in, the JWT claim set and
tenant membership, replacing two of the commented-out placeholder lines in the contracts
barrel.

## Approach

Two new modules under `packages/contracts/src`, plus two re-export lines in
`packages/contracts/src/index.ts` inserted alphabetically into the existing commented block
(`// export * from './auth';` at line 24 and `// export * from './members';` at line 29
become real exports).

`packages/contracts/src/auth/` declares the request and response shapes for
`POST /api/auth/sign-up/email` and `POST /api/auth/sign-in/email`, and the JWT claim shape
ADR-0013 fixes. Better Auth owns those two endpoints' wire format, so these schemas describe
what the client sends and what it may rely on receiving, not a shape this repository is free
to choose. `better-auth@1.6.26` **requires** `name` on sign-up (a body without it answers
400 — measured, and recorded at `apps/api/test/support/auth-fixture.ts:56-60`), so the
request schema requires it. There is no email-verification field on any response shape:
verification is off in this initiative by a dated decision.

The claim schema carries `sub`, `tid`, `email`, `ev`, `jti`, `exp`, `iat`, `iss` and `aud`,
per ADR-0013's claim table. `tid` is uuid-shaped; `jti` is the Better Auth session id and is
**not** unique per token, and the schema's doc comment must say so, because ADR-0013's F-227
correction turns on a later reader assuming otherwise.

`packages/contracts/src/members/` declares the tenant-membership shape ADR-0015 fixes:
`id`, `tenantId`, `userId`, `role` and `createdAt`. `role` is a `TenantRole` and is
constructed through `asTenantRole` from `packages/contracts/src/roles.ts`, which already
ships — the brands, constants and rank tables there are real and importable today, and
`asTenantRole`/`roleRank`/`tenantRoleRank` still throw `not implemented`. **This TASK
implements `asTenantRole` and `tenantRoleRank`**, because a contract that cannot construct
its own `role` value is unusable and no other TASK in this initiative touches `roles.ts`.
`asWorkspaceRole` and `roleRank` stay throwing: workspace membership is out of scope for
this initiative and implementing them would ship a function with no caller and no test.

`user_id` is `text`, not `uuid`. ADR-0015 references `"user"(id)`, which is Better Auth's
shape, and this is the one place in the repository where a foreign key is not a uuid.

**This package may import `zod` and nothing else.** Lint bans `node:*`, `@nestjs/*`,
`drizzle-orm`, `pg` and `react`, because `apps/web` imports this source directly with no
build step (ADR-0005). A Node-only import here breaks the Next.js build rather than this
package's own.

Validation failures flow through the existing `isZodError` / `toValidationDetails` pair in
`packages/contracts/src/errors.ts:102-196`. No new error code is added: `ERROR_CODES` is
append-only and already carries every code this initiative's auth surface needs
(`unauthenticated`, `token_expired`, `email_not_verified`, `rate_limited`).

## Out of scope for this TASK

The workspace contracts (`packages/contracts/src/workspaces/**`, TASK-012). Invitation
contracts (item 1b). `asWorkspaceRole` and `roleRank`. Any API code, any web code, any
database schema. Adding an entry to `ERROR_CODES` — if a shape here appears to need a code
that does not exist, that is a finding, not an edit.

## Interfaces

**Consumes**

From `packages/contracts/src/errors.ts` (shipped):
- `errorEnvelopeContract` — zod schema for `{ code: ErrorCode, message: string, details?: unknown }`
- `ERROR_CODES: readonly ErrorCode[]`, `ERROR_CODE_STATUS: Record<ErrorCode, number>`
- `isZodError(value: unknown): value is ZodError`
- `toValidationDetails(error: ZodError): ValidationDetails`
- `MAX_VALIDATION_ISSUES = 100`, `MAX_MESSAGES_PER_FIELD = 10`

From `packages/contracts/src/roles.ts` (shipped, partly stubbed):
- `type TenantRole` — branded; no bare string is assignable
- `TENANT_ROLES: readonly TenantRole[]`, `TENANT_ROLE: { owner; admin; member }`
- `TENANT_ROLE_RANK: Record<TenantRole, number>` — `member` is rank 0
- `asTenantRole(value: string): TenantRole` — **currently `throw new Error('not implemented')` at `roles.ts:90`; this TASK implements it**
- `tenantRoleRank(role: TenantRole): number` — **currently throwing at `roles.ts:118-125`; this TASK implements it**

**Produces**

- `packages/contracts/src/auth/index.ts` exporting:
  - `signUpRequestContract` — zod schema for `{ email: string; password: string; name: string }`
  - `signInRequestContract` — zod schema for `{ email: string; password: string }`
  - `type SignUpRequest = z.infer<typeof signUpRequestContract>`
  - `type SignInRequest = z.infer<typeof signInRequestContract>`
  - `authSessionContract` — zod schema for the session shape a successful sign-up or sign-in returns
  - `type AuthSession = z.infer<typeof authSessionContract>`
  - `shortkitJwtClaimsContract` — zod schema for `{ sub: string; tid: string; email: string; ev: boolean; jti: string; exp: number; iat: number; iss: string; aud: string }`, `tid` uuid-shaped
  - `type ShortkitJwtClaims = z.infer<typeof shortkitJwtClaimsContract>`
  - `ACCESS_TOKEN_LIFETIME_SECONDS = 300` — the value ADR-0013 fixes; TASK-003 reads it rather than restating `'5m'`
- `packages/contracts/src/members/index.ts` exporting:
  - `tenantMembershipContract` — zod schema for `{ id: string; tenantId: string; userId: string; role: TenantRole; createdAt: string }`
  - **Superseded 2026-08-13 by ADR-0048.** Not `z.infer`: a brand inside an inferred contract
    type is what `roles.ts:150-156` names and refuses. Export `tenantMembershipContract` with
    an UNBRANDED `role` (`z.enum(TENANT_ROLES)`), plus `TenantMembershipWire`, a declared
    `interface TenantMembership` whose `role` is branded, and `parseTenantMembership()` — the
    one place `asTenantRole` is called. Wire type and domain type are separate.
- `packages/contracts/src/roles.ts` — `asTenantRole` and `tenantRoleRank` implemented, no longer throwing
- `packages/contracts/src/index.ts` — `export * from './auth';` and `export * from './members';` uncommented and live
