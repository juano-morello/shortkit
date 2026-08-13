# Contract: the auth and tenant-membership vocabulary in `packages/contracts`

- **Boundary:** `packages/contracts/src/auth/` and `packages/contracts/src/members/`,
  between the TASK that declares them (TASK-001) and every TASK on either side of the wire.
- **Normative form:** the TypeScript and zod in `design/stubs/packages/contracts/src/auth/`
  and `.../members/`. The prose here states what the shapes mean; the stubs state the
  shapes.
- **Produced by:** TASK-001.
- **Consumed by:** TASK-003 (`ACCESS_TOKEN_LIFETIME_SECONDS`, the password bounds, the claim
  shape), TASK-005 (`AuthGuard` reads the claim shape), TASK-007 and TASK-008 (`apps/web`
  transport and screens), TASK-012 (follows the same split for workspaces).
- **ADRs:** ADR-0047, ADR-0048, ADR-0013, ADR-0005, ADR-0023, ADR-0025.

## What this package may import

`zod`, and nothing else. Lint bans `node:*`, `@nestjs/*`, `drizzle-orm`, `pg` and `react`
(`packages/contracts/src/index.ts:9-11`), because `apps/web` imports this source directly
with no build step (ADR-0005). A Node-only import here breaks the Next.js build rather than
this package's own.

## Better Auth owns two of these wire formats

`POST /api/auth/sign-up/email` and `POST /api/auth/sign-in/email` are handled by Better
Auth, mounted ahead of Nest (ADR-0013, GC-C). **These schemas describe what the client sends
and what it may rely on receiving. They do not define the endpoint.** No Nest pipe validates
against them; nothing in `apps/api` parses a request body with them.

The shapes below are read from `better-auth@1.6.26`:
`dist/api/routes/sign-up.mjs:252-265` and `dist/api/routes/sign-in.mjs:336-341`.

## `packages/contracts/src/auth/`

### Requests

```ts
export const signUpRequestContract = z.object({
  email: z.string().email(),
  password: z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH),
  name: z.string().min(1),
});

export const signInRequestContract = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});
```

**`name` is required on sign-up.** `better-auth@1.6.26` answers 400 to a body without it —
measured, and recorded at `apps/api/test/support/auth-fixture.ts:56-60`.

**Sign-in does not apply the length bounds.** A password floor raised later would otherwise
lock out every account created under the old one, and the sign-in check would reject a
correct password with a validation error instead of an authentication one. `.min(1)` is the
only bound sign-in carries.

There is no email-verification field on any shape here. Verification is off in this
initiative by a dated decision (refinement, Scope/In).

### Password bounds

```ts
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;
```

ADR-0047. `auth.config.ts` reads the same two constants into
`emailAndPassword.minPasswordLength` and `.maxPasswordLength`, so the two enforcement points
cannot disagree about the number. **Better Auth is the enforcer of record**; the zod bound is
a form check that happens to run on both sides.

### Responses

```ts
export const authUserContract = z.object({
  id: z.string().min(1),
  name: z.string(),
  email: z.string().email(),
  emailVerified: z.boolean(),
  image: z.string().nullable().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const authSessionContract = z.object({
  token: z.string().nullable(),
  user: authUserContract,
});
```

`id` is `z.string()`, not a uuid: Better Auth generates its own ids and they are not uuids.
This is the same fact that makes `tenant_memberships.user_id` a `text` column.

`token` is nullable because sign-up returns `token: null` when auto-sign-in is disabled
(`sign-up.mjs:252-255`). It is the Better Auth **session token**, not a JWT, and it is the
credential — it must never be logged, never be rendered, and never leave the server side of
`apps/web` (ADR-0014, GC-G).

`authSessionContract` is a plain `z.object`, so zod strips unknown keys. Sign-in additionally
returns `redirect` and `url`, which this repository does not use; parsing tolerates them by
dropping them. **Do not make it `.strict()`**: a Better Auth release adding a field would
then fail every sign-in.

`createdAt` and `updatedAt` are ISO strings because they crossed JSON. In the database they
are `timestamptz` (`auth-schema.md`).

### The claim set

```ts
export const shortkitJwtClaimsContract = z.object({
  sub: z.string().min(1),
  tid: z.string().uuid(),
  email: z.string().email(),
  ev: z.boolean(),
  jti: z.string().min(1),
  exp: z.number().int(),
  iat: z.number().int(),
  iss: z.string().min(1),
  aud: z.string().min(1),
});

export const ACCESS_TOKEN_LIFETIME_SECONDS = 300;
```

Fixed by ADR-0013 and GC-D. Three things a later reader must not re-derive:

- **`jti` is the Better Auth session id and is not unique per token.** It is the revocation
  handle. A random per-token `jti` cannot be revoked by sign-out, which holds a session and
  not a token (F-227). The schema's doc comment says so, because the correction turns on a
  later reader assuming RFC 7519 §4.1.7 semantics.
- **`sub` is not written by `definePayload`.** `dist/plugins/jwt/sign.mjs:53-61` spreads the
  payload and then overwrites `sub` with `getSubject?.(session) ?? session.user.id`. It is
  in the claim set and Better Auth sets it.
- **`aud` is a single string**, not an array. `sign.mjs:45` calls
  `setAudience(aud ?? defaultAud)` with one value.

`ACCESS_TOKEN_LIFETIME_SECONDS` exists so TASK-003 writes `expirationTime:
ACCESS_TOKEN_LIFETIME_SECONDS` rather than restating `'5m'`, and so the revocation TTL and
the lifetime are the same number in one place (ADR-0013).

## `packages/contracts/src/members/`

Two types and a parse step, per ADR-0048.

```ts
export const tenantMembershipContract = z.object({
  id: idContract,
  tenantId: idContract,
  userId: z.string().min(1),
  role: z.enum(TENANT_ROLES),
  createdAt: z.string().datetime(),
});

export type TenantMembershipWire = z.infer<typeof tenantMembershipContract>;

export interface TenantMembership {
  readonly id: string;
  readonly tenantId: string;
  readonly userId: string;
  readonly role: TenantRole;   // branded
  readonly createdAt: string;
}

export function parseTenantMembership(value: unknown): TenantMembership;
```

`id` and `tenantId` reuse `idContract` from `pagination.ts` rather than redeclaring a uuid
check. `userId` does not: it is Better Auth's id and is not a uuid.

`role` on the wire is `z.enum(TENANT_ROLES)` — unbranded, per the rule at `roles.ts:150-156`.
`parseTenantMembership` parses and then brands through `asTenantRole`. It is the one
sanctioned way to obtain a `TenantMembership`.

## What the caller may assume

1. Parsing succeeds only for a value satisfying every bound above. `.parse()` throws a
   `ZodError`; `.safeParse()` does not.
2. `parseTenantMembership` returns a value whose `role` is assignable to `TenantRole`, so it
   can be passed to `meetsTenantRole` without a cast.
3. `ACCESS_TOKEN_LIFETIME_SECONDS`, `PASSWORD_MIN_LENGTH` and `PASSWORD_MAX_LENGTH` are the
   values the running system uses, not documentation of them.
4. No type exported from this package carries a role brand in a `z.infer` position, so a
   request body can be built from any of these types (ADR-0048).
5. Every schema here has identical input and output types. None uses `.transform()`.

## What the implementer must guarantee

1. `packages/contracts/src/index.ts` gains `export * from './auth';` and
   `export * from './members';`, replacing the commented lines at 24 and 29. Re-exports
   only; a wave conflict there must stay one line.
2. `asTenantRole` and `tenantRoleRank` are implemented. `asWorkspaceRole` and `roleRank`
   keep throwing `not implemented`: workspace membership is out of scope and implementing
   them ships two functions with no caller and no test.
3. `asTenantRole` validates membership in `TENANT_ROLES` and throws on anything else, so the
   brand keeps meaning "checked" and not "cast".
4. `tenantRoleRank` throws on an unknown key rather than returning `undefined`
   (`roles.ts:122`).
5. **No entry is added to `ERROR_CODES`.** It is append-only and already carries every code
   this surface needs: `unauthenticated`, `token_expired`, `email_not_verified`,
   `rate_limited`, `validation_failed`. A shape that appears to need a missing code is a
   finding, not an edit.
6. No `email` field name is added to `LOGGABLE_FIELDS` by anything reading these shapes
   (GC-G). This package writes no log lines; the rule is stated because these are the types
   that carry an address.

## Error cases

| Situation | Shape | Where |
|---|---|---|
| A request body fails a bound | `ZodError` → `isZodError` → `toValidationDetails` → `validation_failed` envelope, 400 | `packages/contracts/src/errors.ts:102-196`, unchanged |
| Better Auth rejects a short password | `{ code: 'PASSWORD_TOO_SHORT', message: 'Password too short' }`, 400. **Not an `ErrorEnvelope`** | `dist/api/routes/sign-up.mjs:152-161`. Mapped at the web client boundary by TASK-008 |
| Better Auth rejects a long password | `{ code: 'PASSWORD_TOO_LONG' }`, 400. Not an `ErrorEnvelope` | same |
| Sign-up without `name` | Better Auth 400 | measured; the contract requires `name` so the client does not reach this |
| `asTenantRole` receives a non-role | `Error` | `roles.ts` |
| A claim is missing or misshapen | `AuthGuard` answers 401 `unauthenticated` | TASK-005, `auth-tokens.md` step 6 |

**Better Auth's error bodies do not match `ErrorEnvelope` and nothing in `apps/api` maps
them.** The mount is outside the Nest graph, so `ApiExceptionFilter` never sees them
(ADR-0013). This is the most-skipped fact on this boundary and it is TASK-008's to absorb.

## Invariants

1. `ERROR_CODES` is append-only. Nothing here renames, removes or restatuses a code.
2. `TENANT_ROLES` is `['owner', 'admin', 'member']` and `member` is rank 0, granting nothing
   at tenant level (Amendment A-8).
3. Every zod enum in this package sources from an unbranded array.
4. `ACCESS_TOKEN_LIFETIME_SECONDS` and the revocation TTL are the same number, declared once.

## Versioning and compatibility

`apps/web` imports this source directly with no build step, so an incompatible change breaks
`pnpm typecheck` at the moment it is made (ADR-0005). That is the compatibility mechanism;
there is no versioned artifact and no deprecation window.

A field added to a response schema is compatible. A field added to a request schema, a bound
tightened, or a type narrowed is breaking and must land with every call site in the same
commit.

`shortkitJwtClaimsContract` is pinned to ADR-0013's claim table. Adding a claim — `sid`, a
role, a workspace — requires an ADR, because the guard, the mint and the token lifetime move
together.
