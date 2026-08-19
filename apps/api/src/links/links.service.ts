/**
 * Contract: docs/contracts/slug.md ("Error mapping"), link-mutation-events.md
 *           ("Firing rules"), workspace-authorization.md (Form B), workspaces.md
 *           ("Archive"), error-envelope.md, tenant-context.md (GC-H, `afterCommit`)
 * ADR: adr-0007, adr-0009-expiry-eviction.md, adr-0024-domain-error-transport.md,
 *      adr-0063-platform-tenant-and-system-default-domain.md
 * Produced by: TASK-2-05
 *
 * The five link operations, the slug rules, and the one place a `links` row becomes the
 * client shape `@shortkit/contracts` declares.
 *
 * IT OPENS NO TRANSACTION AND COMPARES NO RANK ITSELF. Every method runs inside the tenant
 * transaction `TenantTransactionInterceptor` opened around the handler. Create and list
 * carry the workspace id in the request, so `WorkspaceAuthorizationInterceptor` (Form A)
 * has already decided 404/403 before the handler ran; the three by-id routes cannot know
 * the workspace before loading the link, so they use Form B: load through the
 * tenant-scoped repository first (RLS makes another tenant's link a 404 before any role is
 * consulted, AC-2-6) and then `authorizer.assert(link.workspaceId, min)`.
 *
 * ============================================================================
 * THE HOSTNAME IS RESOLVED ONCE, HERE, AND NO SUBSCRIBER LOOKS IT UP (D-2-06, D-2-19).
 * ============================================================================
 *
 * Every link in item 2 sits on the seeded system default domain, whose row belongs to the
 * PLATFORM tenant and is therefore invisible inside a customer's transaction, by design,
 * and nothing needs it to be otherwise (`db/platform.ts`). So `hostname` is read from
 * `SYSTEM_DEFAULT_DOMAIN` at construction, exactly as the seed read it when it wrote the
 * row, and handed to both the wire shape and `LinkSnapshot`. That is what lets the cache
 * invalidator build `rdr:v1:{hostname}:{slug}` with no query, and it is why there is no
 * domain lookup in this file to go looking for.
 *
 * ============================================================================
 * ONE MUTATION PER SUCCESSFUL OPERATION, AND THE HANDLERS KNOW NOTHING ELSE ABOUT IT.
 * ============================================================================
 *
 * `emit` runs the `in-transaction` subscribers with the live handle and then enqueues the
 * `after-commit` ones on the ambient transaction through `withTenantTransaction`'s reuse
 * branch, the shape `dispatchInvitationMailAfterCommit` established for mail (GC-H). A
 * failed operation fires nothing: every `emit` call sits after the statement that
 * succeeded.
 */
import { Inject, Injectable } from '@nestjs/common';
import {
  FORM_ERROR_KEY,
  LINK_WINDOW_MESSAGE,
  SLUG_GENERATION_MAX_ATTEMPTS,
  validateSlug,
  WORKSPACE_ROLE,
} from '@shortkit/contracts';
import type {
  CreateLinkRequest,
  Link,
  Paginated,
  PaginationQuery,
  UpdateLinkRequest,
  WorkspaceRole,
} from '@shortkit/contracts';

import { WorkspaceAuthorizer } from '../common/authorization/workspace-authorizer';
import { DomainError } from '../common/errors/domain-error';
import { VALIDATION_FAILED_MESSAGE } from '../common/errors/parse-or-throw';
import { systemDefaultHostname } from '../db/platform';
import { currentTenantId, tenantDb, withTenantTransaction } from '../tenancy/tenant-context';
import type { RequestContext } from '../tenancy/tenant-context';
import { WorkspaceNotFoundError } from '../workspaces/workspace-not-found.error';
import { WorkspaceRepository } from '../workspaces/workspace.repository';

import { SlugGenerator } from './codes/slug-generator';
import { LinkNotFoundError, SlugGenerationExhaustedError, SlugTakenError } from './errors';
import {
  runAfterCommitSubscribers,
  runInTransactionSubscribers,
} from './link-mutation.events';
import type { LinkMutation, LinkMutationAction, LinkSnapshot } from './link-mutation.events';
import { LinkRepository } from './link.repository';
import type { CreateLinkRow, LinkRow, UpdateLinkRow } from './link.repository';

/** Everything an insert needs except the slug, which the two create paths choose differently. */
type LinkValues = Omit<CreateLinkRow, 'slug'>;

/** The one message an archived workspace carries. Names no workspace: the caller named it. */
export const ARCHIVED_WORKSPACE_MESSAGE = 'An archived workspace cannot be edited.';

/** What a cursor that did not come out of `encodeCursor` is answered with. */
export const CURSOR_INVALID_MESSAGE = 'The cursor is not one this endpoint issued.';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 400 `validation_failed` keyed on one field, in the shape `validationDetailsContract` fixes. */
function fieldError(field: string, message: string): DomainError {
  return new DomainError('validation_failed', VALIDATION_FAILED_MESSAGE, {
    details: { fieldErrors: { [field]: [message] } },
  });
}

/**
 * The cursor is `<createdAt ISO>|<id>` in base64url. OPAQUE BY INTENT: a client that
 * decoded it would be reading the ordering key, and `pagination.ts` promises only that
 * `nextCursor` comes back verbatim.
 */
function encodeCursor(row: LinkRow): string {
  return Buffer.from(`${row.createdAt.toISOString()}|${row.id}`, 'utf8').toString('base64url');
}

/**
 * The reverse, TOTALLY: base64url decoding never throws (it drops what it cannot read),
 * so every part is checked and anything that fails is 400 rather than a silently widened
 * page or a Postgres 22P02.
 */
function decodeCursor(cursor: string): { createdAt: Date; id: string } {
  const [createdAt, id, ...rest] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');

  if (createdAt === undefined || id === undefined || rest.length > 0 || !UUID.test(id)) {
    throw fieldError('cursor', CURSOR_INVALID_MESSAGE);
  }

  const at = new Date(createdAt);

  if (Number.isNaN(at.getTime())) {
    throw fieldError('cursor', CURSOR_INVALID_MESSAGE);
  }

  return { createdAt: at, id };
}

/**
 * A wire timestamp to a column value. `undefined` (absent) is the caller's "leave it
 * alone" and never reaches here; `null` (clear) stays null.
 */
function toInstant(value: string | null): Date | null {
  return value === null ? null : new Date(value);
}

/**
 * `validateSlug`'s violation, verbatim, under `slug` (AC-2-2). The VIOLATION is the value
 * (`too_short`, `reserved`) and not prose: the fixed five-token vocabulary is what lets the
 * web map it to the same copy its own pre-submit check shows (D-2-18), and prose here
 * would be a second source for that string.
 */
function assertSlugValid(slug: string): void {
  const validation = validateSlug(slug);

  if (!validation.ok) {
    throw fieldError('slug', validation.violation);
  }
}

@Injectable()
export class LinksService {
  /**
   * Read once, at construction, from the same variable the seed read (GC-B: nothing here
   * consults `NODE_ENV`). `process.env` rather than a config service because there is no
   * config service; `db/platform.ts` owns the normalisation.
   */
  private readonly hostname = systemDefaultHostname(process.env);

  /** `@Inject(...)` written out for the reason `workspaces.service.ts` gives. */
  constructor(
    @Inject(LinkRepository) private readonly links: LinkRepository,
    @Inject(WorkspaceRepository) private readonly workspaces: WorkspaceRepository,
    @Inject(WorkspaceAuthorizer) private readonly authorizer: WorkspaceAuthorizer,
    @Inject(SlugGenerator) private readonly slugs: SlugGenerator,
  ) {}

  /**
   * Form A has already established `member` on `body.workspaceId`. What is left is the
   * archive state, the slug, and the collision loop.
   */
  async create(actor: RequestContext, input: CreateLinkRequest): Promise<Link> {
    await this.assertWorkspaceOpen(input.workspaceId, 'workspaceId');

    const values = {
      workspaceId: input.workspaceId,
      destinationUrl: input.destinationUrl,
      expiresAt: toInstant(input.expiresAt ?? null),
      activatesAt: toInstant(input.activatesAt ?? null),
    };

    const row =
      input.slug === undefined
        ? await this.createGenerated(values)
        : await this.createSupplied(values, input.slug);

    await this.emit(actor, 'created', null, row);

    return this.toClient(row);
  }

  /**
   * `SLUG_GENERATION_MAX_ATTEMPTS` draws, each inside its own savepoint, each a real INSERT
   * uniqueness is settled by the index and never by a `SELECT` the next statement could
   * invalidate. Exhausting them is 500 `slug_generation_exhausted` (slug.md).
   */
  private async createGenerated(values: LinkValues): Promise<LinkRow> {
    for (let attempt = 0; attempt < SLUG_GENERATION_MAX_ATTEMPTS; attempt += 1) {
      const row = await this.links.createIfSlugFree({ ...values, slug: this.slugs.next() });

      if (row !== null) {
        return row;
      }
    }

    throw new SlugGenerationExhaustedError();
  }

  /** One attempt: there is nothing to redraw on a code the operator chose (AC-2-3). */
  private async createSupplied(values: LinkValues, slug: string): Promise<LinkRow> {
    assertSlugValid(slug);

    const row = await this.links.createIfSlugFree({ ...values, slug });

    if (row === null) {
      throw new SlugTakenError();
    }

    return row;
  }

  /** Form A, `viewer`, on `query.workspaceId`. Newest first, cursor by `(created_at, id)`. */
  async list(workspaceId: string, query: PaginationQuery): Promise<Paginated<Link>> {
    const after = query.cursor === undefined ? null : decodeCursor(query.cursor);

    // One more than asked for: the extra row is how `hasMore` is known without a count.
    const rows = await this.links.listForWorkspace(workspaceId, {
      limit: query.limit + 1,
      after,
    });

    const hasMore = rows.length > query.limit;
    const items = hasMore ? rows.slice(0, query.limit) : rows;
    const last = items[items.length - 1];

    return {
      items: items.map((row) => this.toClient(row)),
      nextCursor: hasMore && last !== undefined ? encodeCursor(last) : null,
      hasMore,
    };
  }

  /** Form B, `viewer`. */
  async get(linkId: string): Promise<Link> {
    return this.toClient(await this.load(linkId, WORKSPACE_ROLE.viewer));
  }

  /**
   * Form B, `member`. Patchable: `destinationUrl`, `slug`, `expiresAt`, `activatesAt`.
   *
   * THE WINDOW IS CHECKED AGAINST THE PRE-IMAGE, and that is this route's job rather than
   * the schema's: `updateLinkContract` sees one body, so a PATCH naming `activatesAt` alone
   * cannot be compared there against a stored `expires_at` (the contract says so, and this
   * is the comparison it points at). The pre-image is already loaded for `before`.
   */
  async update(actor: RequestContext, linkId: string, input: UpdateLinkRequest): Promise<Link> {
    const before = await this.load(linkId, WORKSPACE_ROLE.member);

    await this.assertWorkspaceOpen(before.workspaceId, FORM_ERROR_KEY);

    if (input.slug !== undefined) {
      assertSlugValid(input.slug);
    }

    const patch: UpdateLinkRow = {
      ...(input.slug === undefined ? {} : { slug: input.slug }),
      ...(input.destinationUrl === undefined ? {} : { destinationUrl: input.destinationUrl }),
      ...(input.expiresAt === undefined ? {} : { expiresAt: toInstant(input.expiresAt) }),
      ...(input.activatesAt === undefined ? {} : { activatesAt: toInstant(input.activatesAt) }),
    };

    assertOrderedWindow(
      patch.expiresAt === undefined ? before.expiresAt : patch.expiresAt,
      patch.activatesAt === undefined ? before.activatesAt : patch.activatesAt,
    );

    const after = await this.links.update(linkId, patch);

    // A PATCH that changed nothing still fires, with `before` deep-equal to `after`
    // (link-mutation-events.md's firing rule, AC-2-7). Subscribers decide whether to act.
    await this.emit(actor, 'updated', before, after);

    return this.toClient(after);
  }

  /**
   * Form B, `member`. HARD delete, and the link's `click_events` rows cascade away with it
   * (D-2-03, AC-2-7).
   *
   * AN ARCHIVED WORKSPACE'S LINKS CAN STILL BE DELETED, deliberately. AC-2-8 gates a
   * "create or edit" on the archive state, and archiving does not stop a link serving
   * (AC-2-8's second half); refusing the delete too would leave a live redirect with no
   * management path at all, which is a worse answer than either.
   */
  async delete(actor: RequestContext, linkId: string): Promise<Link> {
    const before = await this.load(linkId, WORKSPACE_ROLE.member);
    const removed = await this.links.delete(linkId);

    await this.emit(actor, 'deleted', before, null);

    return this.toClient(removed);
  }

  /**
   * Form B: the row first, since another tenant's id, an id nobody issued and a non-uuid are one
   * 404 before any role is read, and then the rank on the workspace the row names.
   */
  private async load(linkId: string, min: WorkspaceRole): Promise<LinkRow> {
    const row = await this.links.findById(linkId);

    if (row === null) {
      throw new LinkNotFoundError();
    }

    await this.authorizer.assert(row.workspaceId, min);

    return row;
  }

  /**
   * An archived workspace refuses creates and edits (AC-2-8). `field` differs because the
   * two requests do: a create names the workspace, a PATCH does not, so its message lands
   * on the form rather than on a field the client never sent.
   */
  private async assertWorkspaceOpen(workspaceId: string, field: string): Promise<void> {
    const workspace = await this.workspaces.findById(workspaceId);

    if (workspace === null) {
      // Unreachable behind Form A and behind the link's own row; the composite foreign key
      // is the floor under both. Same 404 either way.
      throw new WorkspaceNotFoundError();
    }

    if (workspace.archivedAt !== null) {
      throw fieldError(field, ARCHIVED_WORKSPACE_MESSAGE);
    }
  }

  /** One mutation, both phases, in that order (link-mutation-events.md). */
  private async emit(
    actor: RequestContext,
    action: LinkMutationAction,
    before: LinkRow | null,
    after: LinkRow | null,
  ): Promise<void> {
    const row = after ?? before;

    if (row === null) {
      throw new Error('A link mutation carried neither a before nor an after image.');
    }

    const mutation: LinkMutation = {
      action,
      linkId: row.id,
      actorId: actor.userId,
      tenantId: currentTenantId(),
      occurredAt: new Date(),
      before: before === null ? null : this.snapshot(before),
      after: after === null ? null : this.snapshot(after),
    };

    // Before COMMIT, on the live handle: a throw here rolls the mutation back with the
    // subscriber's work (invariant 4).
    await runInTransactionSubscribers(mutation, tenantDb());

    // Enqueued on the ambient transaction, run after COMMIT with `db: null`. The reuse
    // branch of `withTenantTransaction` is what makes this an enqueue rather than a second
    // transaction, and it registers the hook only because the callback resolved (F-125).
    await withTenantTransaction(mutation.tenantId, async () => undefined, {
      afterCommit: () => runAfterCommitSubscribers(mutation),
    });
  }

  /** A PLAIN OBJECT, never the Drizzle row (link-mutation-events.md, "What the implementer must guarantee"). */
  private snapshot(row: LinkRow): LinkSnapshot {
    return {
      id: row.id,
      tenantId: row.tenantId,
      workspaceId: row.workspaceId,
      domainId: row.domainId,
      hostname: this.hostname,
      slug: row.slug,
      destinationUrl: row.destinationUrl,
      expiresAt: row.expiresAt,
      activatesAt: row.activatesAt,
    };
  }

  /**
   * Row to client shape: `Date` to ISO string, no `tenantId` and no `domainTenantId` (a
   * caller already inside their own tenant can act on neither), `hostname` denormalised.
   * An explicit field list rather than a spread, so a column added later reaches the wire
   * only when someone adds it to the contract and here.
   */
  private toClient(row: LinkRow): Link {
    return {
      id: row.id,
      workspaceId: row.workspaceId,
      domainId: row.domainId,
      hostname: this.hostname,
      slug: row.slug,
      destinationUrl: row.destinationUrl,
      expiresAt: row.expiresAt === null ? null : row.expiresAt.toISOString(),
      activatesAt: row.activatesAt === null ? null : row.activatesAt.toISOString(),
      createdAt: row.createdAt.toISOString(),
    };
  }
}

/**
 * The refusal `createLinkContract` applies to a body carrying both bounds, applied to the
 * EFFECTIVE window a PATCH produces. Equal is refused too: the window would be empty and
 * the link would never serve.
 */
function assertOrderedWindow(expiresAt: Date | null, activatesAt: Date | null): void {
  if (expiresAt === null || activatesAt === null) {
    return;
  }

  if (activatesAt.getTime() >= expiresAt.getTime()) {
    throw fieldError('activatesAt', LINK_WINDOW_MESSAGE);
  }
}
