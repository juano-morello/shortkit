/**
 * Contract: docs/contracts/domain-provisioning.md, redirect-resolution.md,
 *           rls-policy-template.md, isolation-coverage.md
 * ADR: adr-0016-domain-provisioning.md, adr-0003-rls-policy-template-and-roles.md,
 *      adr-0004-schema-layout-and-migrations.md, adr-0019-tenant-scoped-table-enumeration.md,
 *      adr-0049-context-flags-are-never-cast-directly.md, adr-0062-workspace-membership-is-a-second-table.md,
 *      adr-0063-platform-tenant-and-system-default-domain.md
 * Produced by: TASK-2-02 (D-2-06, D-2-07)
 *
 * ============================================================================
 * THREE OBLIGATIONS, ONE MIGRATION, ONE COMMIT (GC-A, F-239). FOUR HERE.
 * ============================================================================
 *
 * 1. `tenant_id` declared through `TENANT_ID_COLUMN_SQL` (`db/rls.ts`), character for
 *    character: `uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE`. The cascade is
 *    what lets ADR-0019's privileged erase reach this table.
 * 2. The output of `tenantScopedPolicies('domains')` hand-appended to migration `0005`,
 *    because Drizzle Kit generates no policy DDL.
 * 3. A `registerTenantScopedSurfaces()` call in `test/isolation/registrations.ts`
 *    (`DomainsTableAccess`).
 * 4. AND `redirectReadPolicy('domains')`, in the SAME migration. This is the FIRST APPLIED
 *    INSTANCE of that builder. Until now `rls.ts` said "`domains` and `links` do not exist
 *    yet, so this policy has no applied instance", and that sentence is corrected in this
 *    commit. GC-A is amended for item 2 rather than stretched: a table the redirect can
 *    read before its escape policy exists would simply read nothing, but a policy appended
 *    in a LATER migration is a second F-239 window, and the whole point of GC-A is that
 *    there is no window.
 *
 * Splitting any of the four into a follow-up is a defect and not a sequencing choice:
 * `ALTER DEFAULT PRIVILEGES` grants `shortkit_app` full DML on every table the migrator
 * creates, so this table is writable by every tenant from the moment it exists.
 *
 * ============================================================================
 * WHAT ITEM 2 USES THIS TABLE FOR, AND WHAT IS DELIBERATELY UNREACHABLE
 * ============================================================================
 *
 * ONE ROW EXISTS: the seeded system default domain, owned by the platform tenant
 * (`db/platform.ts`, ADR-0063, D-2-06). There is no `POST /api/domains`, no verification,
 * no certificate provisioning and no reconciler, since those are item 3's, so `active` is the
 * only state anything reaches, and it is reached by the seed writing it directly.
 *
 * THE FULL SIX-VALUE ENUM SHIPS ANYWAY (D-2-07). Item 3 then adds no `ALTER TYPE`, and an
 * `ALTER TYPE ... ADD VALUE` cannot run in the same transaction as a statement using the
 * new value in older PostgreSQL, which is the kind of migration nobody wants to discover
 * later. The values are `domain-provisioning.md`'s `DOMAIN_STATES`, in its order, written
 * out here rather than imported: `packages/contracts/src/domains/` carries only
 * `reserved-hostnames.ts` today and item 2 adds nothing to it (the initiative's "Out"
 * list), so an import would name an export that does not exist.
 *
 * ============================================================================
 * THE TWO UNIQUENESS SHAPES, AND WHY NEITHER IS A PLAIN `UNIQUE (hostname)`
 * ============================================================================
 *
 * `domains_hostname_owned_unique` is a PARTIAL unique index over
 * `WHERE state IN ('verified','provisioning','active')`, per `domain-provisioning.md`
 * verbatim. A plain `UNIQUE (hostname)` enforces uniqueness at CREATION, before any proof
 * of ownership, and F-010 measured what that costs: an attacker bounded only by the write
 * rate limit claims ~172,000 hostnames a day and every real owner meets a permanent 409
 * with no support path. First to VERIFY wins; unverified claims coexist and expire.
 * Item 2 reaches none of that, but the index is the schema item 3 is written against, and
 * shipping the weaker shape now would mean a migration to widen it later.
 *
 * `domains_id_tenant_unique` on `(id, tenant_id)` is UNUSED IN ITEM 2 and deliberate. It is
 * the target item 3's tenant-owned-domain composite foreign key needs: `links` would
 * declare `FOREIGN KEY (domain_id, tenant_id) REFERENCES domains (id, tenant_id)` the day a
 * domain can belong to a customer, and `workspaces` needed exactly this constraint added
 * by a later migration in 1b (ADR-0062). A constraint costs an index now; adding it later
 * costs a migration on a table with rows.
 *
 * THE COMPOSITE FOREIGN KEY TO `workspaces` IS THE 1b DISCIPLINE (ADR-0062), NOT DECORATION.
 * `FOREIGN KEY (workspace_id, tenant_id) REFERENCES workspaces (id, tenant_id)` rather than
 * `workspace_id REFERENCES workspaces(id)`. Referential checks run with row security
 * BYPASSED, so a plain FK is satisfied by ANY tenant's workspace id: a domain row carrying
 * tenant A's `tenant_id` and tenant B's `workspace_id` would be admitted by the policy (its
 * tenant_id matches the flag) and by the FK (the workspace exists). The composite form makes
 * that row a constraint violation at the database, whatever an application check did.
 *
 * `domains_workspace_id_idx` is the 0004 debt sweep's rule applied at creation rather than
 * three migrations later (ledger 1b-W1-11): `workspace_id` leads no other index here, since
 * the primary key is `id` and `domains_id_tenant_unique` leads with `id`, so the `ON DELETE
 * CASCADE` walk from `workspaces` would sequentially scan this table without it.
 */
import { boolean, foreignKey, index, pgEnum, pgTable, text, timestamp, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

import { tenants } from './tenants';
import { workspaces } from './workspaces';

/** `domain-provisioning.md`'s `DOMAIN_STATES`, all six, in its order. Only `active` is reachable in item 2. */
export const domainState = pgEnum('domain_state', [
  'pending_verification',
  'verified',
  'provisioning',
  'active',
  'verification_failed',
  'certificate_failed',
]);

export const domains = pgTable(
  'domains',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    workspaceId: uuid('workspace_id').notNull(),
    /** Stored NORMALISED (lowercase, IDNA, no port). `db/platform.ts`'s `normaliseHostname`. */
    hostname: text('hostname').notNull(),
    state: domainState('state').notNull(),
    /** The seeded platform row and nothing else. No customer domain can ever set it. */
    isSystemDefault: boolean('is_system_default').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('domains_id_tenant_unique').on(table.id, table.tenantId),
    foreignKey({
      name: 'domains_workspace_tenant_fk',
      columns: [table.workspaceId, table.tenantId],
      foreignColumns: [workspaces.id, workspaces.tenantId],
    }).onDelete('cascade'),
    // `domain-provisioning.md`, verbatim. The predicate is the 409's whole disclosure rule
    // (F-097) as well as the uniqueness rule, so the three states are not interchangeable
    // with "anything past pending".
    uniqueIndex('domains_hostname_owned_unique')
      .on(table.hostname)
      .where(sql`state in ('verified', 'provisioning', 'active')`),
    index('domains_workspace_id_idx').on(table.workspaceId),
  ],
);
