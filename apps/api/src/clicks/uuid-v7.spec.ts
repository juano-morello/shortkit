/**
 * ADR-0010: "every event carries a UUID v7 `id` generated at enqueue time", which buys the
 * idempotent retry (`ON CONFLICT (id) DO NOTHING` on a client-generated id) and an id that
 * sorts by time. TASK-2-09, wave 4.
 */
import { describe, expect, it } from 'vitest';

import { uuidV7 } from './uuid-v7';

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('uuidV7 (ADR-0010)', () => {
  it('carries version 7 and the RFC variant, so `uuid` accepts it and a human can see what it is', () => {
    for (let draw = 0; draw < 100; draw += 1) {
      expect(uuidV7()).toMatch(UUID_V7);
    }
  });

  it('is unique across a tight loop', () => {
    const drawn = new Set<string>();

    for (let draw = 0; draw < 10_000; draw += 1) {
      drawn.add(uuidV7());
    }

    expect(drawn.size).toBe(10_000);
  });

  /**
   * SORTS BY TIME, INCLUDING WITHIN ONE MILLISECOND. The timestamp is only millisecond
   * resolution, so ids drawn in the same tick would otherwise sort by random bits, and
   * `click_events`' index is `(link_id, occurred_at DESC)` with `id` as the tie-break the
   * reader pages on. A counter in `rand_a` is what makes the tie-break agree with arrival
   * order rather than contradict it.
   */
  it('is lexicographically ordered by draw order, within a millisecond and across them', () => {
    const drawn = Array.from({ length: 1000 }, () => uuidV7());

    expect(drawn).toEqual([...drawn].sort());
  });

  it('encodes the current time in its first 48 bits', () => {
    const before = Date.now();
    const id = uuidV7();
    const after = Date.now();

    const milliseconds = Number.parseInt(id.slice(0, 8) + id.slice(9, 13), 16);

    expect(milliseconds).toBeGreaterThanOrEqual(before);
    expect(milliseconds).toBeLessThanOrEqual(after);
  });
});
