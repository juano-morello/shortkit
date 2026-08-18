/**
 * Contract: docs/contracts/workspaces.md, rls-policy-template.md, isolation-coverage.md
 * ADR: adr-0003-rls-policy-template-and-roles.md, adr-0004-schema-layout-and-migrations.md,
 *      adr-0019-tenant-scoped-table-enumeration.md, adr-0049-context-flags-are-never-cast-directly.md,
 *      adr-0062-workspace-membership-is-a-second-table.md
 * Produced by: TASK-011. Composite unique added by TASK-1b-03.
 *
 * ============================================================================
 * THREE OBLIGATIONS, ONE MIGRATION, ONE COMMIT (GC-A, F-239).
 * ============================================================================
 *
 * 1. `tenant_id` declared through `TENANT_ID_COLUMN_SQL` (`db/rls.ts`), character for
 *    character: `uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE`. The cascade is
 *    what lets ADR-0019's privileged erase reach this table.
 * 2. The output of `tenantScopedPolicies('workspaces')` hand-appended to migration `0002`,
 *    because Drizzle Kit generates no policy DDL. This is a template-shaped table and it
 *    takes the template UNCHANGED — two policies, not `tenants`' bespoke four.
 * 3. A `registerTenantScopedSurfaces()` call in `test/isolation/registrations.ts`.
 *
 * Splitting any of the three into a follow-up is a defect and not a sequencing choice:
 * `ALTER DEFAULT PRIVILEGES` grants `shortkit_app` full DML on every table the migrator
 * creates, so this table is writable by every tenant from the moment it exists and
 * before any policy is evaluated.
 *
 * ARCHITECT RULINGS, RECORDED HERE AND IN docs/contracts/workspaces.md.
 *
 * `archived_at timestamptz NULL`, null meaning active. It is the observable AC-23 needs
 * (leaves the default list, stays visible when archived rows are asked for), it records
 * WHEN, and it needs no enum migration when a third state arrives. Not a boolean, not a
 * status enum.
 *
 * `id` IS DATABASE-GENERATED, unlike `tenants.id`. `tenants` carries an application-
 * supplied id because signup mints it and opens the tenant transaction under it before
 * inserting, so the row it writes is the one `tenants_self_insert` admits (ADR-0021).
 * A workspace is created inside an already-open tenant transaction, so that reason does
 * not apply and `gen_random_uuid()` is the plainer choice.
 *
 * NO UNIQUENESS ON `name`. No AC requires it, a duplicate name is harmless, and a unique
 * constraint would need an error code the workspace contract does not have. Name bounds
 * are TASK-012's contract concern (packages/contracts); the table stores `text`.
 *
 * `updated_at` is maintained by the repository on every write, not by a trigger — there
 * is no trigger anywhere in this schema and this table is not the place to start.
 *
 * `UNIQUE (id, tenant_id)` — ADDED BY 1b (TASK-1b-03, ADR-0062), A CONSTRAINT AND NOT A
 * COLUMN. `id` alone is already the primary key, so the pair is trivially unique; the
 * constraint exists to be the TARGET of the composite foreign keys `memberships` and
 * `invitation_workspaces` declare — `FOREIGN KEY (workspace_id, tenant_id) REFERENCES
 * workspaces (id, tenant_id)`. Referential checks run with row security bypassed, so a plain
 * FK to `workspaces(id)` would accept any tenant's workspace id; the composite form makes a
 * grant naming another tenant's workspace a constraint violation at the database, whatever
 * an application check did. It changes no column, no policy and no row, migration `0002`
 * is untouched, and `workspace-repository.int-spec.ts`'s verbatim hold on it stays green.
 */
import { pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';

import { tenants } from './tenants';

export const workspaces = pgTable(
  'workspaces',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique('workspaces_id_tenant_unique').on(table.id, table.tenantId)],
);
