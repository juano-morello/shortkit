# Contract: Better Auth's five tables in the Drizzle schema

- **Boundary:** `apps/api/src/db/schema/auth.ts`, between the TASK that declares the tables
  (TASK-002) and the TASK that configures the adapter that reads them (TASK-003).
- **Normative form:** the Drizzle DDL and the field table below. The field table is
  transcribed from `getSchema({ plugins: [jwt(), bearer()] })` against the pinned
  `better-auth@1.6.26`, executed 2026-08-12.
- **Produced by:** TASK-002.
- **Consumed by:** TASK-003 (`drizzleAdapter`), TASK-011 (`workspaces` migration ordering),
  TASK-014 and TASK-015 (isolation harness), and `apps/api/test/support/auth-fixture.ts`.
- **ADRs:** ADR-0043, ADR-0044, ADR-0046, ADR-0013, ADR-0004.

## Where the shape comes from

`better-auth/db` exports `getSchema(options)`. It takes a plain options object, opens no
connection and constructs no instance. **`plugins` is the only option that changes its
answer**: measured, `getSchema({})` and `getSchema({ emailAndPassword: { enabled: true } })`
return identical table and field sets, and `[jwt(), bearer()]` adds exactly one table.

`bearer()` contributes no table. `jwt()` contributes `jwks`.

## The five tables

`getSchema` does not report `id`. Every table carries `id text PRIMARY KEY`, supplied by
Better Auth's own id generator, never by the database. This is why ADR-0015's
`tenant_memberships.user_id` is `text` and not `uuid`.

Type mapping, fixed here and not by Better Auth: `string` → `text`, `boolean` → `boolean`,
`date` → `timestamp with time zone`.

Naming, fixed here: **Drizzle property names are camelCase, database column names are
snake_case.** The adapter indexes the Drizzle table object by Better Auth's field key
(`schema[fieldName]`, `@better-auth/drizzle-adapter/dist/index.mjs:298`), which is a TS
property name, so the property must be `emailVerified`. The column name is free, and the
adapter's `camelCase` option documents its default as "snake case is used for table and
field names", which is also what `tenants.ts` already does.

### `user`

| Property | Column | Type | Null | Other |
|---|---|---|---|---|
| `id` | `id` | `text` | no | primary key |
| `name` | `name` | `text` | no | |
| `email` | `email` | `text` | no | `UNIQUE` |
| `emailVerified` | `email_verified` | `boolean` | no | |
| `image` | `image` | `text` | **yes** | |
| `createdAt` | `created_at` | `timestamptz` | no | |
| `updatedAt` | `updated_at` | `timestamptz` | no | |

### `session`

| Property | Column | Type | Null | Other |
|---|---|---|---|---|
| `id` | `id` | `text` | no | primary key |
| `expiresAt` | `expires_at` | `timestamptz` | no | |
| `token` | `token` | `text` | no | `UNIQUE` |
| `createdAt` | `created_at` | `timestamptz` | no | |
| `updatedAt` | `updated_at` | `timestamptz` | no | |
| `ipAddress` | `ip_address` | `text` | **yes** | |
| `userAgent` | `user_agent` | `text` | **yes** | |
| `userId` | `user_id` | `text` | no | `REFERENCES "user"(id) ON DELETE CASCADE` |

### `account`

| Property | Column | Type | Null | Other |
|---|---|---|---|---|
| `id` | `id` | `text` | no | primary key |
| `accountId` | `account_id` | `text` | no | |
| `providerId` | `provider_id` | `text` | no | |
| `userId` | `user_id` | `text` | no | `REFERENCES "user"(id) ON DELETE CASCADE` |
| `accessToken` | `access_token` | `text` | **yes** | |
| `refreshToken` | `refresh_token` | `text` | **yes** | |
| `idToken` | `id_token` | `text` | **yes** | |
| `accessTokenExpiresAt` | `access_token_expires_at` | `timestamptz` | **yes** | |
| `refreshTokenExpiresAt` | `refresh_token_expires_at` | `timestamptz` | **yes** | |
| `scope` | `scope` | `text` | **yes** | |
| `password` | `password` | `text` | **yes** | the credential hash |
| `createdAt` | `created_at` | `timestamptz` | no | |
| `updatedAt` | `updated_at` | `timestamptz` | no | |

### `verification`

| Property | Column | Type | Null | Other |
|---|---|---|---|---|
| `id` | `id` | `text` | no | primary key |
| `identifier` | `identifier` | `text` | no | |
| `value` | `value` | `text` | no | |
| `expiresAt` | `expires_at` | `timestamptz` | no | |
| `createdAt` | `created_at` | `timestamptz` | no | |
| `updatedAt` | `updated_at` | `timestamptz` | no | |

Unused in this initiative: email verification is off. The table exists because Better Auth
creates rows in it for flows we do not enable, and omitting it would fail
`checkMissingFields` the first time one is enabled.

### `jwks`

| Property | Column | Type | Null | Other |
|---|---|---|---|---|
| `id` | `id` | `text` | no | primary key |
| `publicKey` | `public_key` | `text` | no | |
| `privateKey` | `private_key` | `text` | no | symmetrically encrypted with `BETTER_AUTH_SECRET` |
| `createdAt` | `created_at` | `timestamptz` | no | |
| `expiresAt` | `expires_at` | `timestamptz` | **yes** | set only when `jwks.rotationInterval` is configured |

## The model map

```ts
export const betterAuthSchema = {
  user: authUser,
  session: authSession,
  account: authAccount,
  verification: authVerification,
  jwks: authJwks,
} as const;
```

The keys are Better Auth's model names, because both adapter resolution paths index by them:
`config.schema[model]` and `db.query[model]`. The table constants keep `auth`-prefixed names
so `export * from './auth'` does not put `user`, `session` and `account` into the schema
barrel's namespace alongside every product table.

## What the caller may assume

1. Every table listed above exists in the database after migration `0001` and is declared in
   `apps/api/src/db/schema/auth.ts`.
2. `betterAuthSchema` has exactly those five keys, and each maps to the Drizzle table with
   the matching SQL name.
3. **None of the five carries `tenant_id` and none carries row-level security** (ADR-0044).
   A statement against them returns rows regardless of tenant context, including no context
   at all. **Amended 2026-08-13 (ADR-0050): what bounds them instead is a grant.** Migration
   `0001` revokes `shortkit_app` on all five and grants `shortkit_auth`, so a statement from
   the application pool fails with `permission denied for table <t>` rather than returning
   rows.
4. `id` is `text` on all five, so a foreign key into `user(id)` is `text`.
5. `betterAuthDatabase()` from `apps/api/src/db/client.ts` is typed over exactly this schema
   (ADR-0046), and is built on the **auth** pool, `DATABASE_AUTH_URL`, connecting as
   `shortkit_auth` (ADR-0050, which supersedes ADR-0046's one-pool decision — F-028).

## What the implementer must guarantee

1. The Drizzle property names equal the field keys in the table above, exactly. The adapter
   throws `BetterAuthError: The field "<key>" does not exist in the "<model>" Drizzle
   schema` at runtime on the first statement touching a missing one.
2. `apps/api/src/db/schema/auth.spec.ts` runs on `pnpm test` — the unit tier, no database, no
   network — and asserts against `getSchema({ plugins: [jwt(), bearer()] })`:
   table names, field sets, `required` against `.notNull()`, `unique` against `.unique()`,
   and `references` (target model, target field, `onDelete`) against `.references()`.
   It does **not** compare SQL types; the mapping above is this repository's and is asserted
   separately by the integration tier against `information_schema`.
3. `apps/api/src/db/schema/index.ts` gains `export * from './auth';`, alphabetically.
4. `auth.ts` imports from `drizzle-orm/pg-core` only. It must not import
   `better-auth/plugins`: `drizzle.config.ts` globs `./src/db/schema/*.ts` and evaluates
   every match, and pulling the auth runtime into migration generation is a failure mode
   with no upside. The plugin list lives in the spec and in `auth.config.ts`.
5. TASK-003 asserts the other half: `getSchema(auth.options)` equals
   `getSchema({ plugins: [jwt(), bearer()] })`. Without it, a later `user.additionalFields`
   or a sixth plugin changes the required schema and nothing fails.

## Error cases

| Situation | Shape | Where it surfaces |
|---|---|---|
| A Drizzle property is missing or misspelled | `BetterAuthError`, message `The field "<key>" does not exist in the "<model>" Drizzle schema. Please update your drizzle schema or re-generate using "npx auth@latest generate".` | Runtime, on the first request touching that model. The advice in the message is not this repository's procedure — see ADR-0043 |
| `betterAuthSchema` is missing a model key | `BetterAuthError`, message `[# Drizzle Adapter]: The model "<model>" was not found in the schema object. Please pass the schema directly to the adapter options.` | Runtime |
| A `better-auth` upgrade adds or removes a field | `auth.spec.ts` fails | `pnpm test`, CI `quality` job |
| `auth.config.ts` adds a schema-shaping option | `auth.config.spec.ts` fails | `pnpm test`, CI `quality` job |
| The migration and the schema file disagree | drizzle-kit generates a second migration on the next `db:generate` | Review, and ADR-0019's cross-check |

## Invariants

1. The five tables are the complete set for `[jwt(), bearer()]`, and
   `apps/api/scripts/check-policies.mts`'s `EXEMPT` map holds exactly these five names
   (ADR-0044).
2. `id` is application-supplied on all five. No `DEFAULT`, no sequence.
3. `user.email` and `session.token` are the only `UNIQUE` constraints.
4. Both foreign keys point at `user(id)` and both cascade on delete.
5. No table here carries `tenant_id`, and adding one to any of them is out of scope for
   every TASK in this initiative.

## Versioning and compatibility

The shape is `better-auth@1.6.26`'s, and `better-auth` is pinned exactly (ADR-0018, F-016).
An upgrade regenerates this table from `getSchema()` and lands the migration and the
contract edit in one commit. The drift test is what makes the upgrade fail loudly rather
than at runtime.

There is no backward compatibility to preserve: no database holds rows in these tables yet,
and ADR-0004's forward-only posture applies — a corrected shape is a new migration, never an
edit to an applied one.
