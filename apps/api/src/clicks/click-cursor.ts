/**
 * Contract: docs/contracts/error-envelope.md (shared primitives: `paginated`,
 *           `paginationQueryContract`), click-events.md (the read is ordered
 *           `occurred_at DESC`)
 * Produced by: TASK-2-09 (item 2, wave 4).
 *
 * The clicks cursor, in the shape `links.service.ts` established: base64url of
 * `<timestamp ISO>|<id>`, OPAQUE BY INTENT: `pagination.ts` promises only that `nextCursor`
 * comes back verbatim, and a client that decoded it would be reading the ordering key.
 *
 * ORDERED `(occurred_at DESC, id DESC)`, BOTH DESCENDING, so the keyset predicate is one row
 * comparison rather than the disjunction a mixed direction would need, and
 * `click_events_link_occurred_idx (link_id, occurred_at DESC)` serves it. The tie-break on
 * `id` is not decoration: `occurred_at` is written by the buffer at millisecond resolution
 * and a hundred clicks can share a value, so without it a page boundary landing inside a tie
 * would repeat or skip rows. UUID v7 makes that tie-break agree with arrival order.
 *
 * DECODING IS TOTAL, AND THE TIMESTAMP CHECK IS PART OF WHAT MAKES THAT TRUE.
 * `Buffer.from(value, 'base64url')` never throws (it drops what it cannot read), so every
 * part is checked and anything that fails is a 400 rather than a silently widened page or a
 * Postgres 22P02. A `NaN` check alone was not enough: `new Date('+275760-09-13T00:00:00.000Z')`
 * is a valid `Date` and an invalid timestamptz, so a forged cursor carrying one passed every
 * check here and raised 22008 from inside the reader's query, which is a 500 on a value the
 * caller chose. `isStorableInstant` is the bound, and it is the same bound the route applies
 * to `from` and `to` (`click-instant.ts`).
 */
import { isStorableInstant } from './click-instant';
import type { ClickCursor } from './click-event.types';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What a cursor that did not come out of `encodeClickCursor` is answered with. */
export const CLICK_CURSOR_INVALID_MESSAGE = 'The cursor is not one this endpoint issued.';

export function encodeClickCursor(cursor: ClickCursor): string {
  return Buffer.from(`${cursor.occurredAt.toISOString()}|${cursor.id}`, 'utf8').toString(
    'base64url',
  );
}

/** `null` for anything this endpoint did not issue; the caller turns that into the 400. */
export function decodeClickCursor(cursor: string): ClickCursor | null {
  const [occurredAt, id, ...rest] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');

  if (occurredAt === undefined || id === undefined || rest.length > 0 || !UUID.test(id)) {
    return null;
  }

  const at = new Date(occurredAt);

  if (!isStorableInstant(at)) {
    return null;
  }

  return { occurredAt: at, id };
}
