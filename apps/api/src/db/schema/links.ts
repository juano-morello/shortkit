/**
 * Contract: docs/contracts/slug.md, redirect-resolution.md, link-mutation-events.md,
 *           rls-policy-template.md, isolation-coverage.md
 * ADR: adr-0007-short-code-generation.md, adr-0009-expiry-eviction.md,
 *      adr-0003-rls-policy-template-and-roles.md, adr-0004-schema-layout-and-migrations.md,
 *      adr-0019-tenant-scoped-table-enumeration.md, adr-0049-context-flags-are-never-cast-directly.md,
 *      adr-0062-workspace-membership-is-a-second-table.md,
 *      adr-0063-platform-tenant-and-system-default-domain.md
 * Produced by: TASK-2-02
 *
 * ============================================================================
 * THREE OBLIGATIONS, ONE MIGRATION, ONE COMMIT (GC-A, F-239). FOUR HERE.
 * ============================================================================
 *
 * 1. `tenant_id` through `TENANT_ID_COLUMN_SQL` (`db/rls.ts`), character for character.
 * 2. `tenantScopedPolicies('links')` hand-appended to migration `0005`.
 * 3. `LinksTableAccess` in `test/isolation/registrations.ts`. (`LinkRepository`'s own
 *    subject arrives with the repository, TASK-2-05, the F-353 two-subjects-one-table
 *    pattern `workspaces` shipped.)
 * 4. AND `redirectReadPolicy('links')`, in the SAME migration: the second of the two
 *    first applied instances (see `domains.ts` for why it cannot wait for TASK-2-06).
 *
 * ============================================================================
 * WHO OWNS THE DOMAIN A LINK NAMES: `domain_tenant_id`, A COMPOSITE KEY, AND A CHECK
 * (ADR-0063 as amended 2026-08-19; the ADR-0062 discipline reaching the second reference)
 * ============================================================================
 *
 * THE SHAPE THIS REPLACED, AND WHAT IT ADMITTED. `domain_id` was a plain `REFERENCES
 * domains(id)`, on the argument that a composite `(domain_id, tenant_id) -> domains (id,
 * tenant_id)` was impossible: the system default domain belongs to the PLATFORM tenant, so
 * that pair is not a row for any customer link and the key would refuse every link ever
 * created. The premise was right and the conclusion was wrong. Measured against the live
 * database on 2026-08-19: tenant A inserted a `links` row naming tenant B's `domains` row,
 * and the redirect's own two permitted queries then served A's destination under B's
 * hostname. A could also take a slug on B's domain and hold it forever, because
 * `links_domain_id_slug_unique` is an index and an index is never policy filtered. Item 2
 * was safe only because no second domain exists yet, and item 3 is where the second domain
 * arrives.
 *
 * THE SHAPE THAT WORKS IS THE PAIR, NOT THE COLUMN. `links` carries `domain_tenant_id uuid
 * NOT NULL`: the tenant the WRITER claims owns the domain it is naming. The foreign key is
 * `(domain_id, domain_tenant_id) REFERENCES domains (id, tenant_id)`, against the
 * `domains_id_tenant_unique` constraint. Referential integrity is not policy filtered, so
 * the pair has to be a real `domains` row, which is what makes the claim unlieable: a writer
 * that names B's domain must write B's tenant id beside it, and one that writes its own
 * tenant id must name a domain that tenant really owns.
 *
 * THE CHECK IS WHAT NARROWS "A REAL PAIR" TO "A PAIR THIS TENANT MAY USE".
 *
 *     CONSTRAINT links_domain_owner_check
 *       CHECK (domain_tenant_id = tenant_id OR domain_tenant_id = <PLATFORM_TENANT_ID>)
 *
 * Two legitimate cases and no third: a domain the row's own tenant owns, and the shared
 * platform default. Every other tenant's domain is refused by the database whatever an
 * application check did, and whatever the isolation policies admitted. The two constraints
 * are not redundant. The key alone still permits A to point at B's domain by telling the
 * truth about it; the check alone still permits A to point at B's domain by lying about who
 * owns it. Together they leave exactly the two cases above.
 *
 * WHAT IS STILL SHARED, STATED SO NOBODY READS THIS AS MORE THAN IT IS. Uniqueness stays
 * `(domain_id, slug)`, so on the ONE domain every tenant legitimately shares, the system
 * default, a slug taken by any tenant is taken for all of them. That is the contract, not a
 * residue of the defect: `slug.md` scopes uniqueness to the domain and AC-2-3 says a slug
 * already taken on the system default domain by any tenant answers 409 `slug_taken`.
 *
 * WHAT THE CREATE PATH OWES (TASK-2-05, unbuilt, so this costs no rework): both columns on
 * every insert. For item 2 that is always the pair `SYSTEM_DEFAULT_DOMAIN_ID` and
 * `PLATFORM_TENANT_ID`, the two frozen constants in `db/platform.ts`.
 *
 * Referential checks run with row security bypassed, which is what lets this key resolve
 * against the platform's row inside a transaction that cannot read it. ADR-0063 records the
 * measurement, in both directions.
 *
 * ============================================================================
 * UNIQUENESS IS `(domain_id, slug)` AND NEVER GLOBAL (GC-6, AC-2-3, slug.md)
 * ============================================================================
 *
 * Two tenants may hold the same slug on two different domains; on one domain the second
 * loses. The constraint NAME is load-bearing beyond the schema: `slug.md` requires the
 * collision catch to read `postgresErrorConstraint(error) === 'links_domain_id_slug_unique'`
 * through the `db/client.ts` accessors (F-120: inside `withTenantTransaction` the caught
 * value is drizzle's wrapper and `.code` is `undefined`), so renaming it silently turns
 * every generated-slug collision into a 500 and every supplied-slug collision into a 500
 * instead of AC-2-3's 409.
 *
 * `slug` IS `text` AND CASE-SENSITIVE, matching the index and `slug.md` ("Slugs are
 * case-sensitive for storage and lookup"). `RESERVED_SLUGS` is compared
 * case-INsensitively, in the contracts package, at validation, not here. No CHECK
 * constraint on the shape: `validateSlug` owns it and a database-level duplicate of a
 * regex in `packages/contracts` is a second source of truth for the same rule.
 *
 * `destination_url` IS `text` AND STORED PARSED (D-2-08). The 302's `Location` is this
 * value byte for byte, so `javascript:`/`data:` must be unstorable. The refusal is
 * `destinationUrlContract` in the contracts package (scheme allowlist, `u.href` stored,
 * never the raw input), 2048 characters bounded there. No CHECK here for the same reason
 * as the slug.
 *
 * `expires_at` AND `activates_at` ARE NULLABLE AND CARRY NO DEFAULT. Both null is an
 * always-active link. The window is evaluated ON EVERY READ by `isLinkActive` (ADR-0009),
 * cache hit included, so the database never filters on them and they need no index; a
 * partial index on "currently active" would be an index whose predicate changes with the
 * clock.
 *
 * `links_workspace_created_idx (workspace_id, created_at DESC)` serves the list route's
 * cursor order (`created_at DESC, id`, D-2-12) and, as the leading column, the `ON DELETE
 * CASCADE` walk from `workspaces`: the 0004 debt sweep's rule (ledger 1b-W1-11) met at
 * creation. `domain_id` leads `links_domain_id_slug_unique`, so its cascade is covered too.
 *
 * DELETE IS HARD, AND THE CLICK ROWS GO WITH IT (D-2-03, D-2-12, AC-2-7). There is no
 * `archived_at` here: `link-mutation-events.md` fixes `deleted` as a real delete with a
 * pre-image, and `click_events.link_id` cascades. That is a stated cost, ruled by Juano on
 * 2026-08-19, not an oversight, and the UI names it at the confirmation (AC-2-50).
 */
import { check, foreignKey, index, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

import { PLATFORM_TENANT_ID } from '../platform';
import { domains } from './domains';
import { tenants } from './tenants';
import { workspaces } from './workspaces';

export const links = pgTable(
  'links',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    workspaceId: uuid('workspace_id').notNull(),
    domainId: uuid('domain_id').notNull(),
    /** The tenant the writer claims owns `domain_id`. The composite key below makes the claim true. */
    domainTenantId: uuid('domain_tenant_id').notNull(),
    slug: text('slug').notNull(),
    destinationUrl: text('destination_url').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    activatesAt: timestamp('activates_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('links_domain_id_slug_unique').on(table.domainId, table.slug),
    foreignKey({
      name: 'links_workspace_tenant_fk',
      columns: [table.workspaceId, table.tenantId],
      foreignColumns: [workspaces.id, workspaces.tenantId],
    }).onDelete('cascade'),
    foreignKey({
      name: 'links_domain_tenant_fk',
      columns: [table.domainId, table.domainTenantId],
      foreignColumns: [domains.id, domains.tenantId],
    }).onDelete('cascade'),
    // `sql.raw` because this is DDL, not a query: everything the `sql` tag interpolates
    // normally becomes a bound `$N`, and a CHECK constraint has nowhere to bind one.
    // `PLATFORM_TENANT_ID` is a frozen compile-time constant in `db/platform.ts` with no
    // request-derived input anywhere near it, and `migration-0005.int-spec.ts` reads the
    // rendered constraint back out of `pg_constraint` so a drift fails a test.
    check(
      'links_domain_owner_check',
      sql`domain_tenant_id = tenant_id or domain_tenant_id = ${sql.raw(`'${PLATFORM_TENANT_ID}'::uuid`)}`,
    ),
    index('links_workspace_created_idx').on(table.workspaceId, table.createdAt.desc()),
    // `domain_id` leads `links_domain_id_slug_unique`, which serves the redirect's lookup
    // and the cascade from `domains`; `domain_tenant_id` leads nothing, and it is the second
    // column of the new key, so the cascade walk from a deleted `domains` row would scan.
    index('links_domain_tenant_id_idx').on(table.domainTenantId),
  ],
);
