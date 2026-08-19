/**
 * Contract: docs/contracts/redirect-resolution.md (decision step 4)
 * ADR: adr-0009-expiry-eviction.md
 * Produced by: TASK-2-01 (D-2-11; ADR-0009 calls the card TASK-027)
 *
 * THIS FILE IMPORTS NOTHING, not even zod. It is a pure comparison, and it lives in
 * `packages/contracts` for one reason: ADR-0009 requires ONE rule shared by the
 * management API and the redirect path, and this package is the only place both may
 * import from. GC-N bans the redirect module from importing `../links`, `../auth`,
 * `../workspaces`, `../members` and `../invitations` — it does not ban
 * `@shortkit/contracts`, which is exactly why the shared rule can live here (D-2-11).
 */

/**
 * One bound: a `Date`, an ISO string, or absent.
 *
 * BOTH FORMS ARE ACCEPTED SO BOTH CALLERS WORK UNCHANGED (ruled 2026-08-19). The
 * redirect path reads a row and hands over drizzle's real `Date`s; the screens read
 * `linkContract` off the wire and hand over ISO strings, because every timestamp in this
 * package is an ISO string on the wire. Forcing either side to convert first would put a
 * `new Date(...)` on the hot path or in a component — exactly the duplicated, skippable
 * step ADR-0009 wrote this function to eliminate.
 */
export type LinkValidityBound = Date | string | null;

/** The two nullable timestamps, and nothing else a caller has to supply. */
export interface LinkValidityWindow {
  readonly expiresAt: LinkValidityBound;
  readonly activatesAt: LinkValidityBound;
}

/** Epoch milliseconds, `null` for an absent bound, `NaN` for one that cannot be read. */
function boundMs(bound: LinkValidityBound): number | null {
  if (bound === null) {
    return null;
  }

  return typeof bound === 'string' ? Date.parse(bound) : bound.getTime();
}

/**
 * ============================================================================
 * SHARED BY THE API AND THE REDIRECT PATH. NEVER REIMPLEMENT IT.
 * THE CACHE TTL CLAMP IS HYGIENE; THIS IS THE CORRECTNESS. (ADR-0009)
 * ============================================================================
 *
 * `redirectCache.setLink` additionally clamps the Redis TTL by time-to-expiry, and that
 * clamp is memory and cost hygiene — it keeps a record that can no longer serve a 302
 * from occupying a key for another hour. It is NOT what makes an expired link stop
 * serving. Redis expiry is lazy and granular to the second, so a link can outlive its
 * TTL by an unbounded margin; what makes AC-2-26 true is that every read, cache hit
 * included, calls this function before responding. ADR-0009 names deleting this check as
 * redundant-looking the precise defect it was written to prevent.
 *
 * Absence of both timestamps is active (AC-2-27). The boundaries are half-open: a link
 * is active AT `activatesAt` and inactive AT `expiresAt`.
 *
 * `now` is passed in and is the API process's clock — never Redis's, never Postgres's.
 * That is what lets a cache hit decide expiry with no I/O at all (AC-2-15, AC-2-26): the
 * cached record already carries both timestamps, so an inactive link answers 404 without
 * falling through to Postgres.
 */
export function isLinkActive(window: LinkValidityWindow, now: Date): boolean {
  const nowMs = now.getTime();
  const activatesAt = boundMs(window.activatesAt);
  const expiresAt = boundMs(window.expiresAt);

  // A bound that EXISTS but cannot be read is never silently dropped. Both unreadable
  // cases fail closed — an unparseable expiry must not keep serving a link forever, and
  // an unparseable activation must not open one early — because this decides an
  // anonymous visitor's 302 and the safe answer to "I cannot tell" is 404.
  if (
    (activatesAt !== null && Number.isNaN(activatesAt)) ||
    (expiresAt !== null && Number.isNaN(expiresAt))
  ) {
    return false;
  }

  if (activatesAt !== null && nowMs < activatesAt) {
    return false;
  }

  if (expiresAt !== null && nowMs >= expiresAt) {
    return false;
  }

  return true;
}
