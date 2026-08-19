/**
 * Contract: docs/contracts/slug.md ("Uniqueness and collision"), tenant-context.md
 *           (invariant 4, "Driver errors inside `fn`"), isolation-coverage.md,
 *           link-mutation-events.md
 * ADR: adr-0002-tenant-context-binding.md, adr-0003-rls-policy-template-and-roles.md,
 *      adr-0020-isolation-suite-enumeration.md, adr-0062, adr-0063
 * Produced by: TASK-2-05
 * Consumed by: `links.service.ts`; TASK-2-10 (isolation subjects)
 *
 * `WorkspaceRepository`'s shape, which every repository here copies: `tenantDb()` and
 * nothing else, EVERY STATEMENT OWNER-QUALIFIED even though the policy already scopes it
 * (F-302: an owner-qualified write is routed through the SELECT policy, so a refusal that
 * relied on the policy alone would prove less than it appears to), a malformed id answered
 * as not-found without reaching Postgres, `@TenantScopedRepository()` for ADR-0020's
 * enumeration.
 *
 * NO UPSERT ANYWHERE (F-341). `ON CONFLICT DO UPDATE` reaches the UPDATE policy's `USING`,
 * and the collision this table actually has is settled by the savepoint redraw below
 * instead. A later edit reaching for `save()` is a defect, not a simplification.
 *
 * ============================================================================
 * EVERY INSERT WRITES BOTH DOMAIN COLUMNS (ADR-0063 as amended 2026-08-19).
 * ============================================================================
 *
 * `links` names its domain as the PAIR `(domain_id, domain_tenant_id)`, with a composite
 * foreign key into `domains (id, tenant_id)` and `links_domain_owner_check` narrowing the
 * admitted pairs to the row's own tenant or the platform default. For item 2 that pair is
 * always `SYSTEM_DEFAULT_DOMAIN_ID` / `PLATFORM_TENANT_ID`, the two frozen constants in
 * `db/platform.ts`; item 3 is where a second domain can appear. Writing `domain_id`
 * without its partner, or with the wrong partner, is refused 23503 or 23514 by the
 * database rather than producing a link on another tenant's hostname, and both are mapped
 * below so the refusal is a named error and not a driver object with the destination URL
 * in its message.
 *
 * ============================================================================
 * THE COLLISION READ GOES THROUGH THE ACCESSORS. NEVER `.code`, NEVER `.message` (F-120).
 * ============================================================================
 *
 * These statements run inside the request's `withTenantTransaction`, so a caught value is
 * drizzle's `DrizzleQueryError` wrapper and `error.code` is `undefined`: reading it
 * directly makes every collision a 500 instead of a redraw or AC-2-3's 409.
 * `postgresErrorCode` and `postgresErrorConstraint` from `db/client.ts` unwrap it. And the
 * wrapper's MESSAGE is `Failed query: <the INSERT>\nparams: <every bound parameter>`,
 * which on this statement is the destination URL, the slug and the tenant id, so it is never read,
 * never logged and never interpolated anywhere in this module.
 */
import { Injectable } from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';

import { postgresErrorCode, postgresErrorConstraint } from '../db/client';
import { PLATFORM_TENANT_ID, SYSTEM_DEFAULT_DOMAIN_ID } from '../db/platform';
import { links } from '../db/schema';
import { currentTenantId, tenantDb, TenantScopedRepository } from '../tenancy/tenant-context';
import { WorkspaceNotFoundError } from '../workspaces/workspace-not-found.error';

import { LinkDomainUnavailableError, LinkNotFoundError, SlugTakenError } from './errors';

/** The row shape `linkContract` mirrors, plus the two owner columns the wire drops. */
export interface LinkRow {
  readonly id: string;
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly domainId: string;
  readonly domainTenantId: string;
  readonly slug: string;
  readonly destinationUrl: string;
  readonly expiresAt: Date | null;
  readonly activatesAt: Date | null;
  readonly createdAt: Date;
}

export interface CreateLinkRow {
  readonly workspaceId: string;
  readonly slug: string;
  /** Already `u.href` from `destinationUrlContract`; this class never parses a URL. */
  readonly destinationUrl: string;
  readonly expiresAt: Date | null;
  readonly activatesAt: Date | null;
}

/** Absent keys are left alone; `null` clears. An empty patch issues no statement. */
export interface UpdateLinkRow {
  readonly slug?: string;
  readonly destinationUrl?: string;
  readonly expiresAt?: Date | null;
  readonly activatesAt?: Date | null;
}

/** One page's worth, keyed on the last row of the previous page. */
export interface ListLinksOptions {
  readonly limit: number;
  readonly after: LinkCursor | null;
}

/** The keyset the list orders by: `(created_at DESC, id DESC)`, both columns, both ways. */
export interface LinkCursor {
  readonly createdAt: Date;
  readonly id: string;
}

const UNIQUE_VIOLATION = '23505';
const FOREIGN_KEY_VIOLATION = '23503';
const CHECK_VIOLATION = '23514';

/**
 * The constraint slug.md names, character for character. Renaming it in a migration
 * silently turns every collision into a 500, which is why the name is asserted in
 * `test/db/migration-0005.int-spec.ts` as well as read here.
 */
const SLUG_UNIQUE_CONSTRAINT = 'links_domain_id_slug_unique';

/** The two the database raises when a row lies about, or cannot find, its domain. */
const DOMAIN_PAIR_CONSTRAINTS = new Set(['links_domain_tenant_fk', 'links_domain_owner_check']);

/** The one the database raises when a row names a workspace this tenant does not own. */
const WORKSPACE_PAIR_CONSTRAINT = 'links_workspace_tenant_fk';

/** The same shape `assertUuid` accepts; a non-uuid names no row this tenant owns. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Named so `ROLLBACK TO SAVEPOINT` cannot be aimed at the wrong one. A literal, never built. */
const SLUG_SAVEPOINT = sql`slug_try`;

const ROW_COLUMNS = {
  id: links.id,
  tenantId: links.tenantId,
  workspaceId: links.workspaceId,
  domainId: links.domainId,
  domainTenantId: links.domainTenantId,
  slug: links.slug,
  destinationUrl: links.destinationUrl,
  expiresAt: links.expiresAt,
  activatesAt: links.activatesAt,
  createdAt: links.createdAt,
} as const;

/**
 * The two refusals that mean the row's `(domain_id, domain_tenant_id)` pair is not one this
 * tenant may use, and the one that means its workspace is not this tenant's. Anything else
 * 23505 included, which is the caller's to interpret, is rethrown untouched.
 */
function mapInsertRefusal(error: unknown): never {
  const code = postgresErrorCode(error);
  const constraint = postgresErrorConstraint(error);

  if (code === FOREIGN_KEY_VIOLATION && constraint === WORKSPACE_PAIR_CONSTRAINT) {
    // The composite key refused a `(workspace_id, tenant_id)` pair `workspaces` does not
    // hold: another tenant's workspace, or none. The route's Form A check answered 404
    // long before this; the constraint is the floor, and the answer is the same 404.
    throw new WorkspaceNotFoundError();
  }

  if (
    (code === FOREIGN_KEY_VIOLATION || code === CHECK_VIOLATION) &&
    constraint !== undefined &&
    DOMAIN_PAIR_CONSTRAINTS.has(constraint)
  ) {
    throw new LinkDomainUnavailableError(error);
  }

  throw error;
}

@TenantScopedRepository()
@Injectable()
export class LinkRepository {
  /**
   * One INSERT attempt, inside `SAVEPOINT slug_try`. Answers `null`, having rolled the
   * savepoint back, when `links_domain_id_slug_unique` refused the slug, so the caller
   * decides between redrawing (a generated slug) and 409 `slug_taken` (a supplied one).
   *
   * THE SAVEPOINT IS NOT OPTIONAL. A unique violation aborts the enclosing transaction, so
   * without one the second attempt answers `current transaction is aborted` and the whole
   * request fails. slug.md says so, and it is the reason this method exists rather than a
   * plain `create` the service retries.
   */
  async createIfSlugFree(input: CreateLinkRow): Promise<LinkRow | null> {
    const db = tenantDb();

    await db.execute(sql`savepoint ${SLUG_SAVEPOINT}`);

    try {
      const [row] = await db
        .insert(links)
        .values({
          tenantId: currentTenantId(),
          workspaceId: input.workspaceId,
          // Both columns, always, and only ever this pair in item 2 (ADR-0063).
          domainId: SYSTEM_DEFAULT_DOMAIN_ID,
          domainTenantId: PLATFORM_TENANT_ID,
          slug: input.slug,
          destinationUrl: input.destinationUrl,
          expiresAt: input.expiresAt,
          activatesAt: input.activatesAt,
        })
        .returning(ROW_COLUMNS);

      if (row === undefined) {
        // RETURNING on a row the WITH CHECK admitted always yields it; reaching here means
        // the driver answered something this class does not understand.
        throw new Error('links insert returned no row.');
      }

      await db.execute(sql`release savepoint ${SLUG_SAVEPOINT}`);

      return row;
    } catch (error: unknown) {
      if (
        postgresErrorCode(error) === UNIQUE_VIOLATION &&
        postgresErrorConstraint(error) === SLUG_UNIQUE_CONSTRAINT
      ) {
        // Back to a usable transaction, then the savepoint is destroyed so the next attempt
        // opens a fresh one rather than shadowing this.
        await db.execute(sql`rollback to savepoint ${SLUG_SAVEPOINT}`);
        await db.execute(sql`release savepoint ${SLUG_SAVEPOINT}`);

        return null;
      }

      mapInsertRefusal(error);
    }
  }

  async findById(id: string): Promise<LinkRow | null> {
    if (!UUID.test(id)) {
      return null;
    }

    const [row] = await tenantDb()
      .select(ROW_COLUMNS)
      .from(links)
      .where(and(eq(links.id, id), eq(links.tenantId, currentTenantId())))
      .limit(1);

    return row ?? null;
  }

  /**
   * One page of a workspace's links, newest first (D-2-12).
   *
   * ORDERED `(created_at DESC, id DESC)`, BOTH DESCENDING, so the keyset predicate is one
   * row comparison, `(created_at, id) < (cursor)`, rather than the disjunction a mixed
   * direction would need. `links_workspace_created_idx (workspace_id, created_at DESC)`
   * serves it. The tie-break on `id` is what keeps two links created in one transaction,
   * which share a `now()`, from paginating unstably.
   *
   * NO TOKEN PARSING HERE. The cursor arrives as the two values it names; turning an opaque
   * string into them is the service's, where a malformed one becomes a 400.
   */
  async listForWorkspace(workspaceId: string, options: ListLinksOptions): Promise<LinkRow[]> {
    if (!UUID.test(workspaceId)) {
      return [];
    }

    const owned = and(
      eq(links.tenantId, currentTenantId()),
      eq(links.workspaceId, workspaceId),
    );

    return tenantDb()
      .select(ROW_COLUMNS)
      .from(links)
      .where(
        options.after === null
          ? owned
          : and(
              owned,
              sql`(${links.createdAt}, ${links.id}) < (${options.after.createdAt.toISOString()}::timestamptz, ${options.after.id}::uuid)`,
            ),
      )
      .orderBy(desc(links.createdAt), desc(links.id))
      .limit(options.limit);
  }

  /**
   * The post-image. An EMPTY patch issues no statement and answers the row unchanged: a
   * no-op PATCH is valid, answers 200 and still fires `onLinkMutated` with `before`
   * deep-equal to `after` (AC-2-7), and `UPDATE ... SET` with nothing to set is not SQL.
   *
   * A 23505 here is unambiguous, since there is nothing to redraw on a slug the operator typed,
   * so it becomes 409 `slug_taken` at once. The transaction is aborted by then and the
   * throw is what rolls it back; no savepoint is opened, because nothing would run in it.
   */
  async update(id: string, patch: UpdateLinkRow): Promise<LinkRow> {
    if (!UUID.test(id)) {
      throw new LinkNotFoundError();
    }

    if (Object.keys(patch).length === 0) {
      const unchanged = await this.findById(id);

      if (unchanged === null) {
        throw new LinkNotFoundError();
      }

      return unchanged;
    }

    let row: LinkRow | undefined;

    try {
      [row] = await tenantDb()
        .update(links)
        .set(patch)
        .where(and(eq(links.id, id), eq(links.tenantId, currentTenantId())))
        .returning(ROW_COLUMNS);
    } catch (error: unknown) {
      if (
        postgresErrorCode(error) === UNIQUE_VIOLATION &&
        postgresErrorConstraint(error) === SLUG_UNIQUE_CONSTRAINT
      ) {
        throw new SlugTakenError();
      }

      mapInsertRefusal(error);
    }

    if (row === undefined) {
      throw new LinkNotFoundError();
    }

    return row;
  }

  /**
   * Hard delete, returning the row that was removed: the pre-image
   * `link-mutation-events.md` requires for the `deleted` mutation, read back by the same
   * statement that removed it so nothing can change between the two.
   *
   * The link's `click_events` rows cascade away with it. Stated cost, ruled 2026-08-19
   * (D-2-03, AC-2-7), not an oversight.
   */
  async delete(id: string): Promise<LinkRow> {
    if (!UUID.test(id)) {
      throw new LinkNotFoundError();
    }

    const [row] = await tenantDb()
      .delete(links)
      .where(and(eq(links.id, id), eq(links.tenantId, currentTenantId())))
      .returning(ROW_COLUMNS);

    if (row === undefined) {
      throw new LinkNotFoundError();
    }

    return row;
  }
}
