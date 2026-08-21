/**
 * Contract: docs/contracts/auth-schema.md
 * ADR: adr-0043-better-auth-schema-is-hand-written-and-pinned.md,
 *      adr-0044-better-auth-tables-carry-no-rls.md,
 *      adr-0046-better-auth-drizzle-client.md, adr-0004-schema-layout-and-migrations.md
 * Produced by: TASK-002
 *
 * ============================================================================
 * HAND-WRITTEN, AND PINNED BY `auth.spec.ts` AGAINST `getSchema()` (ADR-0043).
 * ============================================================================
 *
 * ADR-0013 said these tables are generated once with the Better Auth CLI. That CLI is not
 * installed, `better-auth` declares no `bin`, and the config it would read is TASK-003's:
 * one wave later than this file is needed. `better-auth/db`'s `getSchema(options)` answers
 * the same question from a plain options object with no connection and no instance, and
 * `plugins` is the only option that changes its answer (measured). So the shape is
 * transcribed here and asserted on every `pnpm test` run, which is a guarantee a one-time
 * generation never had.
 *
 * THIS FILE IMPORTS FROM `drizzle-orm/pg-core` ONLY. `drizzle.config.ts` globs
 * `./src/db/schema/*.ts` and evaluates every match; pulling `better-auth/plugins` into
 * migration generation buys nothing and can only break. The plugin list lives in
 * `auth.spec.ts` and in `auth.config.ts`.
 *
 * NO `tenant_id`, NO ROW-LEVEL SECURITY, ON ANY OF THE FIVE (ADR-0044). `shortkit_app`
 * holds full DML on all of them through `ALTER DEFAULT PRIVILEGES` and there is no
 * predicate to write. `apps/api/scripts/check-policies.mts` exempts exactly these five
 * names and asserts its own list is exactly five long.
 *
 * PROPERTY NAMES ARE camelCase, COLUMN NAMES ARE snake_case, AND BOTH HALVES ARE
 * LOAD-BEARING. The adapter indexes this table object by Better Auth's field key
 * (`schema[fieldName]`, `@better-auth/drizzle-adapter/dist/index.mjs:298`), which is a TS
 * property name, so the property MUST be `emailVerified`. The column name is free, and
 * the adapter's own `camelCase` option documents its default as "snake case is used for
 * table and field names", which is also what `tenants.ts` does.
 *
 * `id` is `text` and application-supplied on all five: Better Auth generates its own ids
 * and they are not uuids. That is why ADR-0015's `tenant_memberships.user_id` is `text`.
 */
import { boolean, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

export const authUser = pgTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').notNull(),
  image: text('image'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
});

export const authSession = pgTable('session', {
  id: text('id').primaryKey(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  // THE SESSION CREDENTIAL, IN PLAINTEXT. Never logged, never rendered, never returned
  // by anything but Better Auth's own handler (ADR-0044).
  token: text('token').notNull().unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  userId: text('user_id')
    .notNull()
    .references(() => authUser.id, { onDelete: 'cascade' }),
});

export const authAccount = pgTable('account', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull(),
  providerId: text('provider_id').notNull(),
  userId: text('user_id')
    .notNull()
    .references(() => authUser.id, { onDelete: 'cascade' }),
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  idToken: text('id_token'),
  accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
  refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true }),
  scope: text('scope'),
  // The credential hash. Nullable: a social account row carries none.
  password: text('password'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
});

/**
 * Unused in this initiative: email verification is off. It exists because Better Auth
 * writes rows here for flows we do not enable, and omitting it fails `checkMissingFields`
 * the first time one is turned on.
 */
export const authVerification = pgTable('verification', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
});

/**
 * The `jwt` plugin's key store, served at GET /api/auth/jwks (ADR-0013).
 *
 * `privateKey` is symmetrically encrypted with `BETTER_AUTH_SECRET`
 * (`plugins/jwt/utils.mjs:46-54`), so a row alone is not a signing key: a row plus the
 * environment variable is. `expiresAt` is nullable and is set only when
 * `jwks.rotationInterval` is configured, which this initiative does not configure.
 */
export const authJwks = pgTable('jwks', {
  id: text('id').primaryKey(),
  publicKey: text('public_key').notNull(),
  privateKey: text('private_key').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
});

/**
 * The model map `drizzleAdapter` resolves through (ADR-0046).
 *
 * THE KEYS ARE BETTER AUTH'S MODEL NAMES because both resolution paths index by them:
 * `config.schema[model]` and `db.query[model]`
 * (`@better-auth/drizzle-adapter/dist/index.mjs:92,299-315`). The table constants keep
 * `auth`-prefixed names so `export * from './auth'` does not put `user`, `session` and
 * `account` into the schema barrel's namespace alongside every product table.
 *
 * A typo in a KEY here is not caught by `auth.spec.ts`, which compares the Drizzle tables
 * to `getSchema()` and not this map. It surfaces as a `BetterAuthError` on whichever
 * request path first touches that model.
 */
export const betterAuthSchema = {
  user: authUser,
  session: authSession,
  account: authAccount,
  verification: authVerification,
  jwks: authJwks,
} as const;
