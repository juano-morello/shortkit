/**
 * Contract: docs/contracts/tenant-membership-lookup.md, rls-policy-template.md
 * ADR: adr-0015-user-tenant-cardinality.md, adr-0045-token-mint-membership-lookup.md,
 *      adr-0003-rls-policy-template-and-roles.md, adr-0004-schema-layout-and-migrations.md
 * Produced by: TASK-002
 *
 * ============================================================================
 * THREE OBLIGATIONS, ONE MIGRATION, ONE COMMIT (GC-A, F-239).
 * ============================================================================
 *
 * 1. `tenant_id` declared through `TENANT_ID_COLUMN_SQL` (`db/rls.ts:103-104`), character
 *    for character.
 * 2. The output of `tenantScopedPolicies('tenant_memberships')` AND of
 *    `membershipLookupPolicy()` hand-appended to the generated migration, because Drizzle
 *    Kit generates no policy DDL.
 * 3. A `registerTenantScopedSurfaces()` call in `test/isolation/registrations.ts`.
 *
 * Splitting any of the three into a follow-up is a defect and not a sequencing choice:
 * `ALTER DEFAULT PRIVILEGES` (`docker-compose.yml:334-337`) grants `shortkit_app` full DML
 * on every table the migrator creates, so this table is writable by the runtime role from
 * the moment it exists and before any policy is evaluated.
 *
 * `UNIQUE (user_id)` IS THE DECISION, NOT AN INDEX (ADR-0015). It is what makes
 * one-tenant-per-user structural, and it is what bounds `tenantIdForUser` to one row.
 *
 * `user_id` IS `text`. It references Better Auth's `user(id)`, which is `text` because
 * Better Auth generates its own ids. This is the only non-uuid foreign key in the schema
 * and it will look like a mistake to every later reader, which is why it says so here.
 *
 * FOUR POLICIES, NOT THREE. `tenantScopedPolicies` emits the isolation policy and the
 * privileged-erase policy; `membershipLookupPolicy()` adds a third, `FOR SELECT`, admitting
 * the single row whose `user_id` equals the token-mint lookup flag (ADR-0045). That third
 * policy is the reason `ISOLATION_EXCLUSIONS` goes from two entries to three in the same
 * commit as this file.
 *
 * THE FLAG IS NAMED BY DESCRIPTION AND NOT BY LITERAL, AND THAT IS THE RULE RATHER THAN
 * A STYLE. isolation-coverage.md clause A2 asserts that the files in the scan set
 * CONTAINING the string are a subset of `{ src/auth/membership-lookup.ts, src/db/rls.ts }`
 * — anywhere at all, "code, comment, template string, JSDoc", because a copy of the
 * literal is the step before someone sets it. The design stub this file was materialised
 * from carried the literal here and would have failed that clause on the day TASK-056
 * arms it. `membershipLookupPolicy()` in `src/db/rls.ts` is where the name is written.
 */
import { pgEnum, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { TENANT_ROLES } from '@shortkit/contracts';

import { authUser } from './auth';
import { tenants } from './tenants';

/** `owner | admin | member`, Amendment A-8. Sourced from the contracts package so the
 *  database enum and the branded type cannot disagree about the value set. */
export const tenantRole = pgEnum('tenant_role', TENANT_ROLES);

export const tenantMemberships = pgTable(
  'tenant_memberships',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => authUser.id, { onDelete: 'cascade' }),
    role: tenantRole('role').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique('tenant_memberships_user_unique').on(table.userId)],
);
