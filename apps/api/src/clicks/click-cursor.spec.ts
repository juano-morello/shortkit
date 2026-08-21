/**
 * The cursor's own claim: decoding is TOTAL, and everything it refuses becomes a 400 rather
 * than a widened page or a driver error from inside the reader's query. TASK-2-09, wave 4.
 *
 * Contract: `docs/contracts/click-events.md` (the read surface), `error-envelope.md`
 * (invariant 1: a caller's value never produces a 500).
 */
import { describe, expect, it } from 'vitest';

import { decodeClickCursor, encodeClickCursor } from './click-cursor';
import { CLICK_INSTANT_MAX_MS, CLICK_INSTANT_MIN_MS } from './click-instant';

const ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

/** What a client would have to forge, since nothing this endpoint issues carries these. */
function forged(timestamp: string): string {
  return Buffer.from(`${timestamp}|${ID}`, 'utf8').toString('base64url');
}

describe('the clicks cursor', () => {
  it('round-trips the keyset it was built from', () => {
    const occurredAt = new Date('2026-08-19T12:34:56.789Z');

    expect(decodeClickCursor(encodeClickCursor({ occurredAt, id: ID }))).toEqual({
      occurredAt,
      id: ID,
    });
  });

  it('refuses anything this endpoint did not issue, without throwing', () => {
    const refused = [
      '',
      'not-a-cursor',
      Buffer.from('no separator', 'utf8').toString('base64url'),
      forged('not-a-date'),
      Buffer.from(`2026-08-19T12:34:56.789Z|${ID}|extra`, 'utf8').toString('base64url'),
      Buffer.from('2026-08-19T12:34:56.789Z|not-a-uuid', 'utf8').toString('base64url'),
    ];

    for (const cursor of refused) {
      expect(() => decodeClickCursor(cursor), cursor).not.toThrow();
      expect(decodeClickCursor(cursor), cursor).toBeNull();
    }
  });

  /**
   * The class the `NaN` check missed: a `Date` JavaScript accepts and Postgres refuses.
   * Unbounded, each of these reached the reader as a `timestamptz` parameter and raised
   * 22008 from inside the query, which is a 500 on a value the caller chose.
   */
  it('refuses an instant Postgres cannot hold, which is what made the old check partial', () => {
    expect(decodeClickCursor(forged('+275760-09-13T00:00:00.000Z'))).toBeNull();
    expect(decodeClickCursor(forged('0000-01-01T00:00:00.000Z'))).toBeNull();
    expect(decodeClickCursor(forged('-000001-01-01T00:00:00.000Z'))).toBeNull();
  });

  it('accepts both ends of the window it does admit', () => {
    const floor = new Date(CLICK_INSTANT_MIN_MS);
    const ceiling = new Date(CLICK_INSTANT_MAX_MS);

    expect(decodeClickCursor(encodeClickCursor({ occurredAt: floor, id: ID }))?.occurredAt).toEqual(floor);
    expect(decodeClickCursor(encodeClickCursor({ occurredAt: ceiling, id: ID }))?.occurredAt).toEqual(
      ceiling,
    );
    expect(ceiling.toISOString()).toBe('9999-12-31T23:59:59.999Z');
  });
});
