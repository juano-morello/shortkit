/**
 * Contract: docs/contracts/workspace-authorization.md ("The two enforcement forms", Form B;
 *           "Status rules": 404 before 403), error-envelope.md (invariants 1, 5),
 *           click-events.md (invariants 5 and 6)
 * ADR: adr-0024-domain-error-transport.md, adr-0020
 * Decision: D-2-12 (`GET /api/links/:linkId/clicks`, Form B, `viewer`), D-2-19
 * Produced by: TASK-2-09 (item 2, wave 4).
 *
 * FORM B, AND THE ORDER IS THE STATUS TABLE. The link is loaded through `LinkRepository`
 * inside the request's tenant transaction, so another tenant's id, an id nobody issued and a
 * non-uuid are ONE 404 before any role is read (AC-2-6, envelope invariant 5); only then is
 * the caller's rank on the link's workspace checked, which is what distinguishes "you are not
 * a member" (404) from "you are a viewer and this needs more" (403, not reachable here,
 * since `viewer` is this route's minimum).
 *
 * `LinkRepository` ARRIVES BY IMPORTING `LinksModule`, which exports it, rather than by
 * registering a second copy: two providers of a `@TenantScopedRepository()` class would give
 * ADR-0020's discovery two subjects for one repository. The clicks module owns no link
 * lookup of its own for the same reason: a `SELECT` on `links` here would be a second place
 * the 404 rule is written.
 *
 * THE WINDOW DEFAULTS ARE THE READER'S CONTRACT AND ARE CHOSEN HERE. `clickQueryContract`
 * leaves `from`/`to` optional precisely so the common case sends neither; `ClickEventQuery`
 * types them as required `Date`s. An absent `from` is the epoch and an absent `to` is now,
 * so the default page is "everything up to this moment" and a client that sends only `from`
 * does not have to name a future date to mean "since".
 *
 * AND A SUPPLIED BOUND IS CHECKED AGAINST WHAT POSTGRES CAN HOLD, not only against what zod
 * parsed. `z.string().datetime()` admits `0000-01-01T00:00:00.000Z`, which is a `Date` and is
 * not a timestamptz: unchecked it reached the driver and raised 22008, so one query parameter
 * from any viewer produced a 500. The bound and its message live in `click-instant.ts`,
 * because the cursor decoder needs exactly the same one.
 */
import { Inject, Injectable } from '@nestjs/common';
import { WORKSPACE_ROLE } from '@shortkit/contracts';
import type { ClickEvent, ClickQuery, Paginated } from '@shortkit/contracts';

import { WorkspaceAuthorizer } from '../common/authorization/workspace-authorizer';
import { DomainError } from '../common/errors/domain-error';
import { VALIDATION_FAILED_MESSAGE } from '../common/errors/parse-or-throw';
import { LinkNotFoundError } from '../links/errors';
import { LinkRepository } from '../links/link.repository';

import { CLICK_CURSOR_INVALID_MESSAGE, decodeClickCursor } from './click-cursor';
import { ClickEventReaderRepository } from './click-event.reader';
import { CLICK_INSTANT_OUT_OF_RANGE_MESSAGE, isStorableInstant } from './click-instant';
import type { ClickCursor } from './click-event.types';

/** The far end of an absent `to`. Read per request: "now" moves. */
function defaultTo(): Date {
  return new Date();
}

/**
 * A supplied ISO bound as an instant, or 400 `validation_failed` keyed on the field that
 * carried it. Keyed rather than a form error, because the caller can fix exactly one value.
 */
function instantOrThrow(value: string, field: 'from' | 'to'): Date {
  const at = new Date(value);

  if (!isStorableInstant(at)) {
    throw new DomainError('validation_failed', VALIDATION_FAILED_MESSAGE, {
      details: { fieldErrors: { [field]: [CLICK_INSTANT_OUT_OF_RANGE_MESSAGE] } },
    });
  }

  return at;
}

/** The near end of an absent `from`. Older than any row this system can hold. */
const BEGINNING_OF_TIME = new Date(0);

@Injectable()
export class ClicksService {
  /** `@Inject(...)` written out for the reason `workspaces.service.ts` gives. */
  constructor(
    @Inject(LinkRepository) private readonly links: LinkRepository,
    @Inject(ClickEventReaderRepository) private readonly clicks: ClickEventReaderRepository,
    @Inject(WorkspaceAuthorizer) private readonly authorizer: WorkspaceAuthorizer,
  ) {}

  async list(linkId: string, query: ClickQuery): Promise<Paginated<ClickEvent>> {
    const link = await this.links.findById(linkId);

    if (link === null) {
      throw new LinkNotFoundError();
    }

    await this.authorizer.assert(link.workspaceId, WORKSPACE_ROLE.viewer);

    return this.clicks.query({
      linkId: link.id,
      from: query.from === undefined ? BEGINNING_OF_TIME : instantOrThrow(query.from, 'from'),
      to: query.to === undefined ? defaultTo() : instantOrThrow(query.to, 'to'),
      limit: query.limit,
      after: this.cursorOf(query.cursor),
    });
  }

  /** A cursor this endpoint did not issue is 400 `validation_failed` keyed on `cursor`. */
  private cursorOf(cursor: string | undefined): ClickCursor | null {
    if (cursor === undefined) {
      return null;
    }

    const decoded = decodeClickCursor(cursor);

    if (decoded === null) {
      throw new DomainError('validation_failed', VALIDATION_FAILED_MESSAGE, {
        details: { fieldErrors: { cursor: [CLICK_CURSOR_INVALID_MESSAGE] } },
      });
    }

    return decoded;
  }
}
