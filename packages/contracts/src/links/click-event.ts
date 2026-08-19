/**
 * Contract: docs/contracts/click-events.md, error-envelope.md
 * ADR: adr-0010-click-event-write-path.md, adr-0005-contract-distribution.md
 * Produced by: TASK-2-01 (the wire shapes; the buffer, the writer and the reader are
 *              TASK-2-09's)
 *
 *   GET /api/links/:linkId/clicks   clickQueryContract -> 200 paginated(clickEventContract)
 *
 * Form B on the link id, `WORKSPACE_ROLE.viewer`, ordered `occurred_at DESC` (D-2-12).
 *
 * THIS PACKAGE MAY IMPORT `zod` AND NOTHING ELSE (ADR-0005).
 */
import { z } from 'zod';

import { idContract, paginationQueryContract } from '../pagination';

/**
 * `varchar(512)` in `click-events.md`, and the point at which `enqueue` truncates —
 * TASK-2-09 imports this rather than writing 512 a second time. Truncating at enqueue
 * rather than at flush is what bounds the buffer's live heap (invariant 8); truncating
 * late leaves the full 16 KiB string in memory, which is the cost the cap exists for.
 */
export const CLICK_USER_AGENT_MAX_LENGTH = 512;

/**
 * One click, as a tenant reads it back.
 *
 * ============================================================================
 * `ipHash` IS NOT ON THE WIRE, AND NEITHER IS THE RAW IP (D-2-19, GC-R).
 * ============================================================================
 *
 * The column exists — it is what makes a visitor countable without being identifiable —
 * but it is pseudonymous per tenant and never leaves the database: not in a response,
 * not in a log line, not in an error. Adding an `ipHash` field to this shape is a
 * defect, and `links.spec.ts` asserts the key is absent from a parse that was handed
 * one. Whether an export ever carries it is item 4's decision to make, in item 4.
 *
 * `tenantId` and `domainId` are likewise absent: both are columns on the row, and
 * neither tells a caller already inside their own tenant anything they can act on.
 *
 * The `.max()` on `userAgent` equals the column width, so it can never refuse a row the
 * server produced — the permissive-response rule holds with the bound stated rather than
 * in spite of it.
 */
export const clickEventContract = z.object({
  id: idContract,
  linkId: idContract,
  occurredAt: z.string().datetime(),
  userAgent: z.string().max(CLICK_USER_AGENT_MAX_LENGTH).nullable(),
});

export type ClickEvent = z.infer<typeof clickEventContract>;

/**
 * `GET /api/links/:linkId/clicks?from=&to=&limit=&cursor=`.
 *
 * `from` and `to` extend the SHARED pagination query rather than restating `limit` and
 * `cursor`, so the 1..100 bounds and the default of 25 have one source. Both bounds are
 * optional ISO strings — the package-wide timestamp convention, ruled 2026-08-19 — and
 * an unparseable one answers 400 `validation_failed` rather than being dropped and
 * silently widening the window.
 *
 * `ClickEventReader.query` in `click-events.md` types `from`/`to` as required `Date`s, so
 * the route converts at the same boundary every other timestamp converts at. The defaults
 * for an absent bound are the reader's to choose, not this schema's, so a client can send
 * neither for the common case.
 *
 * NO `from <= to` REFINEMENT, deliberately. An inverted range returns an empty page,
 * which is not a safety property and costs nothing, and refining here would turn this
 * into a `ZodEffects` that TASK-2-09 could not `.extend()` if the read route grows a
 * filter.
 */
export const clickQueryContract = paginationQueryContract.extend({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});

export type ClickQuery = z.infer<typeof clickQueryContract>;
