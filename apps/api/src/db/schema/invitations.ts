/**
 * Contract: docs/contracts/invitation-tokens.md, workspace-authorization.md, rls-policy-template.md,
 *           isolation-coverage.md
 * ADR: adr-0021-anonymous-routes-reach-tenant-data-through-a-capability-token.md,
 *      adr-0062-workspace-membership-is-a-second-table.md, adr-0050-better-auth-tables-get-their-own-database-role.md,
 *      adr-0003-rls-policy-template-and-roles.md, adr-0004-schema-layout-and-migrations.md,
 *      adr-0019-tenant-scoped-table-enumeration.md, adr-0049-context-flags-are-never-cast-directly.md
 * Produced by: TASK-1b-03
 *
 * ============================================================================
 * THREE OBLIGATIONS, ONE MIGRATION, ONE COMMIT (GC-A, F-239).
 * ============================================================================
 *
 * 1. `tenant_id` declared through `TENANT_ID_COLUMN_SQL` (`db/rls.ts`), character for
 *    character.
 * 2. The output of `tenantScopedPolicies('invitations')` hand-appended to migration `0003`.
 *    Template UNCHANGED, two policies, NO BESPOKE POLICY. The `@Public()` lookup leg reads
 *    this table, but it does so INSIDE `withTenantTransaction(<token's tenant prefix>)`
 *    under the ordinary isolation policy: ADR-0021's third sanctioned pattern for
 *    obtaining a tenant id, "not a GC-5 escape". `invitation-tokens.md` invariant 1: no
 *    policy admits an out-of-context read, so `ISOLATION_EXCLUSIONS` stays at three.
 * 3. A `registerTenantScopedSurfaces()` call in `test/isolation/registrations.ts`
 *    (`InvitationsTableAccess`; `InvitationRepository`'s methods arrive with it, TASK-1b-04).
 *
 * `token_digest bytea NOT NULL UNIQUE`: THE RAW TOKEN IS NEVER STORED (ADR-0021, GC-K).
 * The column holds SHA-256 of the SECRET HALF only (32 bytes); the tenant half is already
 * `tenant_id`. The unique index is what the first statement of every capability lookup
 * hits (`WHERE token_digest = $1`, RLS-scoped to the token's tenant), and the comparison
 * that follows is `timingSafeEqual`. `bytea` through `customType` because drizzle-orm
 * 0.45 ships no bytea column; the driver reads and writes it as a `Buffer`.
 *
 * `state invitation_state NOT NULL DEFAULT 'pending'`, `pending | accepted | expired |
 * revoked`. `expired` IS NEVER WRITTEN BY 1b: expiry is derived from `expires_at` at read
 * time and reported 410 `invitation_expired`; the enum value is reserved for a later
 * sweeper (D-11). `expires_at` is 7 days from creation (ADR-0021, closed).
 *
 * `email` IS THE MAIL RECIPIENT AND A PREFILL, NOT A BINDING (D-01, Juano's ruling
 * 2026-08-18: the link is the capability). Acceptance never compares the accepting
 * account's address with it. Stored lower-cased and trimmed by the contract's parse. No
 * index on `(tenant_id, email)`: nothing in 1b looks an invitation up by address, and
 * re-inviting an address creates a second row (D-11, cost accepted).
 *
 * `inviter_email text NOT NULL` IS DENORMALISED ON PURPOSE. `shortkit_app` holds no
 * privilege on `"user"` (ADR-0050), so the mail template and the public preview cannot
 * join to the inviter's row; the value is copied from the inviter's JWT `email` claim at
 * create time. `invited_by_user_id` still references `"user"` for the cascade.
 *
 * `accepted_by_user_id text NULL ... ON DELETE SET NULL`: an accepted invitation outlives
 * the acceptor's account as a record, unlike the inviter's whose deletion cascades.
 *
 * `invitation_state` IS SOURCED FROM `INVITATION_STATES` in the contracts package
 * (TASK-1b-01), exactly as `tenant_role` sources from `TENANT_ROLES`, so the database enum
 * and the contract cannot disagree about the value set.
 */
import { customType, index, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { INVITATION_STATES } from '@shortkit/contracts';

import { authUser } from './auth';
import { tenants } from './tenants';

/**
 * `bytea`, read and written as a Node `Buffer`. drizzle-orm 0.45 has no built-in bytea
 * column; the pg driver already maps `bytea` to `Buffer` in both directions, so nothing
 * here converts anything: the type only names the SQL type for the migration.
 */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return 'bytea';
  },
});

export const invitationState = pgEnum('invitation_state', INVITATION_STATES);

export const invitations = pgTable(
  'invitations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    tokenDigest: bytea('token_digest').notNull(),
    state: invitationState('state').notNull().default('pending'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    invitedByUserId: text('invited_by_user_id')
      .notNull()
      .references(() => authUser.id, { onDelete: 'cascade' }),
    inviterEmail: text('inviter_email').notNull(),
    acceptedByUserId: text('accepted_by_user_id').references(() => authUser.id, {
      onDelete: 'set null',
    }),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('invitations_token_digest_unique').on(table.tokenDigest),
    // Added 2026-08-19 (debt sweep, ledger 1b-W1-11, migration 0004): the two `"user"`
    // foreign keys lead no index, so the referential actions on a user deletion
    // (CASCADE through `invited_by_user_id`, SET NULL through `accepted_by_user_id`)
    // scan this table. `tenant_id` has its hand-appended index in migration 0003.
    index('invitations_invited_by_user_id_idx').on(table.invitedByUserId),
    index('invitations_accepted_by_user_id_idx').on(table.acceptedByUserId),
  ],
);
