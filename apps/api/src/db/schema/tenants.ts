/**
 * Contract: docs/contracts/rls-policy-template.md
 * ADR: adr-0003-rls-policy-template-and-roles.md, adr-0004-schema-layout-and-migrations.md
 * Produced by: TASK-005
 *
 * The cascade root. `tenants` carries `id`, not `tenant_id`, so `tenantScopedPolicies()`
 * does not apply to it: it gets the bespoke four-policy set from rls-policy-template.md,
 * written by hand into the migration that creates the table. There is deliberately no
 * ordinary DELETE policy (F-005): deleting a tenant row cascades to every tenant-scoped
 * table, and the only path to it is `tenants_privileged_erase`.
 */
import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export const tenants = pgTable('tenants', {
  // Supplied by the application, never by the database: signup generates the id and
  // then opens the tenant transaction it inserts under, so the row it writes is the
  // one `tenants_self_insert` admits (ADR-0021).
  id: uuid('id').primaryKey(),
  name: text('name').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
