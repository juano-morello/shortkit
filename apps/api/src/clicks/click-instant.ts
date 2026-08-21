/**
 * Contract: docs/contracts/click-events.md (the read surface), error-envelope.md
 *           (invariant 1: a caller's value is answered 400, never 500)
 * Produced by: TASK-2-09 (item 2, wave 4).
 *
 * ============================================================================
 * THE INSTANTS JAVASCRIPT ACCEPTS AND POSTGRES DOES NOT. BOTH ENTRY POINTS BOUND HERE.
 * ============================================================================
 *
 * `z.string().datetime()` admits `0000-01-01T00:00:00.000Z`, and `new Date()` admits
 * `+275760-09-13T00:00:00.000Z`. Neither is a timestamp Postgres will take: the first has no
 * year zero in the calendar it uses and the second is outside what its parser reads, and both
 * arrive as a bound parameter that raises 22008 from inside the query. Nothing downstream
 * catches a driver error on a read path, so each was ONE QUERY PARAMETER from any viewer to a
 * 500 with the generic body: no disclosure, because the message is stripped before logging,
 * but a 500 on a value the caller chose is exactly what `error-envelope.md` invariant 1
 * forbids, and `click-cursor.ts` claimed its decoding was total while one class of input went
 * straight through it.
 *
 * THE WINDOW IS `[1970-01-01T00:00:00.000Z, 9999-12-31T23:59:59.999Z]`. The floor is the
 * epoch, which no click can predate: `occurred_at` is written by the buffer from the API's
 * own clock. The ceiling is the last instant `Date.prototype.toISOString()` renders with a
 * four-digit year, so every value inside it round-trips through the wire, the cursor and the
 * driver in one shape. Anything outside is refused where it entered, as a 400 keyed on the
 * field that carried it.
 */

export const CLICK_INSTANT_MIN_MS = 0;

/** `Date.UTC(9999, 11, 31, 23, 59, 59, 999)`, written out so the constant is readable. */
export const CLICK_INSTANT_MAX_MS = 253_402_300_799_999;

export const CLICK_INSTANT_OUT_OF_RANGE_MESSAGE =
  'The timestamp must be between 1970-01-01T00:00:00.000Z and 9999-12-31T23:59:59.999Z.';

/** Whether a parsed instant is one this system can store, compare and page on. */
export function isStorableInstant(value: Date): boolean {
  const milliseconds = value.getTime();

  return (
    !Number.isNaN(milliseconds) &&
    milliseconds >= CLICK_INSTANT_MIN_MS &&
    milliseconds <= CLICK_INSTANT_MAX_MS
  );
}
