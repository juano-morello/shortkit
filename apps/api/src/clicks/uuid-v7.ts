/**
 * Contract: docs/contracts/click-events.md ("`id` is client-generated (UUID v7) rather than
 *           a database default. That is what makes the flush retry idempotent … and it sorts
 *           by time.")
 * ADR: adr-0010-click-event-write-path.md
 * Produced by: TASK-2-09 (item 2, wave 4).
 *
 * RFC 9562 §5.7, the "fixed-length dedicated counter" variant: 48 bits of Unix milliseconds,
 * version 7, a 12-bit counter in `rand_a`, the RFC variant, then 62 bits of randomness.
 *
 * WHY A COUNTER AND NOT TWELVE MORE RANDOM BITS. The timestamp is millisecond resolution and
 * a flush window is a thousand of them, so a hundred clicks can share a tick. With random
 * `rand_a` those ids sort arbitrarily among themselves, and `id` is the tie-break the
 * reader pages on under `occurred_at DESC`, which is a column with the same resolution. The
 * counter makes the tie-break agree with arrival order instead of contradicting it. It is
 * seeded randomly on each new millisecond, so it leaks no rate, and on the (unreachable at
 * this scale) 4096th draw within one millisecond the id borrows the next millisecond rather
 * than wrapping into an earlier value.
 *
 * NO DEPENDENCY. `node:crypto` has `randomUUID` for v4 and nothing for v7, and this is
 * fifteen lines: adding a package to the API's dependency list for it would be the larger
 * change. `randomFillSync` rather than `randomBytes` for the same reason `slug-generator.ts`
 * uses it: it fills a buffer this function already owns, with no allocation per call beyond
 * the one.
 */
import { randomFillSync } from 'node:crypto';

/** 12 bits. */
const COUNTER_MAX = 0xfff;

const bytes = Buffer.allocUnsafe(16);

let lastMilliseconds = -1;
let counter = 0;

export function uuidV7(): string {
  let milliseconds = Date.now();

  if (milliseconds === lastMilliseconds) {
    counter += 1;

    if (counter > COUNTER_MAX) {
      // Borrow the next millisecond rather than wrap: 4096 ids inside one tick is far past
      // anything this path produces, and a wrap would emit an id that sorts before its
      // predecessor.
      milliseconds += 1;
      lastMilliseconds = milliseconds;
      counter = 0;
    }
  } else {
    lastMilliseconds = milliseconds;
    // Seeded rather than zeroed: a counter always starting at 0 would make the first id of
    // every millisecond distinguishable, and the RFC's own guidance is to seed randomly.
    randomFillSync(bytes, 6, 2);
    counter = bytes.readUInt16BE(6) & (COUNTER_MAX >> 1);
  }

  randomFillSync(bytes, 8, 8);

  // 48 bits of Unix milliseconds. `Number` is exact to 2^53, so the two halves are written
  // through arithmetic rather than a BigInt allocation per id.
  bytes.writeUIntBE(milliseconds, 0, 6);
  // Version 7 in the high nibble of byte 6, the counter in the remaining 12 bits.
  bytes.writeUInt16BE(0x7000 | counter, 6);
  // Variant 10xx in the two high bits of byte 8.
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = bytes.toString('hex');

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
