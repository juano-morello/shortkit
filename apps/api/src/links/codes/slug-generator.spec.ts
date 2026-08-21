/**
 * STORY-2-02, AC-2-11 (rejection sampling, uniformity over 57), AC-2-13 (every generated
 * slug validates, and none of them is reserved). TASK-2-05.
 *
 * Contract: docs/contracts/slug.md ("Generation", invariant 1 as corrected 2026-08-19).
 * ADR: adr-0007-short-code-generation.md.
 *
 * The scripted source is the whole point of `RandomSource` existing: uniformity and the
 * two redraw loops are properties of a mapping and a control flow, and neither can be
 * measured against `crypto.randomFillSync` without asserting on chance.
 */
import { describe, expect, it } from 'vitest';
import {
  GENERATED_SLUG_LENGTH,
  RESERVED_SLUGS,
  SLUG_ALPHABET,
  validateSlug,
} from '@shortkit/contracts';

import {
  cryptoRandomSource,
  REJECTION_BOUND,
  RESERVED_REDRAW_LIMIT,
  SlugGenerator,
  symbolForByte,
} from './slug-generator';
import type { RandomSource } from './slug-generator';

/** The bytes that draw `slug` verbatim: every index is below 57, so `byte % 57` is the index. */
function bytesFor(slug: string): number[] {
  return [...slug].map((character) => {
    const index = SLUG_ALPHABET.indexOf(character);

    if (index < 0) {
      throw new Error(`${character} is not in SLUG_ALPHABET, so no byte draws it.`);
    }

    return index;
  });
}

/**
 * A source that answers from a queue and refuses to invent bytes. An exhausted script is a
 * test that scripted fewer draws than the code takes, which has to fail loudly rather than
 * quietly returning zeroes (and drawing `2222222` seven times over).
 */
class ScriptedSource implements RandomSource {
  calls = 0;

  constructor(private readonly script: number[][]) {}

  bytes(out: Uint8Array): void {
    const next = this.script[this.calls];
    this.calls += 1;

    if (next === undefined) {
      throw new Error(`the scripted RandomSource ran out after ${String(this.calls - 1)} calls.`);
    }

    if (next.length !== out.length) {
      throw new Error(
        `the scripted RandomSource was handed a ${String(out.length)}-byte buffer and holds ` +
          `${String(next.length)} bytes for this call.`,
      );
    }

    out.set(next);
  }
}

describe('AC-2-11: rejection sampling, and the mapping it protects', () => {
  it('the bound is 228, the largest multiple of 57 that fits in a byte', () => {
    expect(SLUG_ALPHABET.length).toBe(57);
    expect(REJECTION_BOUND).toBe(228);
    expect(REJECTION_BOUND % SLUG_ALPHABET.length).toBe(0);
    expect(REJECTION_BOUND + SLUG_ALPHABET.length).toBeGreaterThan(255);
  });

  it('every byte is either one symbol or a redraw, and the 228 accepted ones are uniform over the 57', () => {
    const counts = new Map<string, number>();
    let rejected = 0;

    for (let byte = 0; byte <= 255; byte += 1) {
      const symbol = symbolForByte(byte);

      if (symbol === null) {
        rejected += 1;
        continue;
      }

      expect(SLUG_ALPHABET).toContain(symbol);
      counts.set(symbol, (counts.get(symbol) ?? 0) + 1);
    }

    // 256 - 228. Plain `byte % 57` would reject none and hand the first 28 symbols a fifth
    // chance each, which is the bias this test exists to fail on.
    expect(rejected).toBe(28);
    expect(counts.size).toBe(SLUG_ALPHABET.length);
    expect([...new Set(counts.values())]).toEqual([4]);
  });

  it('a draw whose bytes are all at or above the bound is discarded and redrawn, not folded down', () => {
    const rejectAll = [228, 229, 230, 231, 232, 233, 234];
    const accept = [100, 101, 102, 103, 104, 105, 106];
    const source = new ScriptedSource([rejectAll, accept]);

    const slug = new SlugGenerator(source).next();

    // Under `byte % 57` the first array alone would have produced a slug and the second
    // call would never have happened: 228..234 fold onto indices 0..6.
    expect(source.calls).toBe(2);
    expect(slug).toBe(accept.map((byte) => SLUG_ALPHABET[byte % SLUG_ALPHABET.length]).join(''));
  });
});

describe('AC-2-13: what comes out of the generator', () => {
  it('is seven characters of SLUG_ALPHABET and validates, ten thousand times, on the production source', () => {
    const generator = new SlugGenerator(cryptoRandomSource);

    for (let draw = 0; draw < 10_000; draw += 1) {
      const slug = generator.next();

      expect(slug).toHaveLength(GENERATED_SLUG_LENGTH);
      expect(validateSlug(slug)).toEqual({ ok: true, slug });
    }
  });

  it('redraws a reserved candidate: `support` is drawable, and never returned (slug.md invariant 1, corrected)', () => {
    const benign = bytesFor('spring9');
    const source = new ScriptedSource([bytesFor('support'), bytesFor('privacy'), benign]);

    const slug = new SlugGenerator(source).next();

    // Both drawable reserved entries were drawn and both were discarded. Without the
    // redraw the first call's `support` would be a live link on a brand-protected slug
    // that `validateSlug` then refuses.
    expect(source.calls).toBe(3);
    expect(slug).toBe('spring9');
  });

  it('the two drawable reserved entries are exactly the ones the contract pins', () => {
    const drawable = RESERVED_SLUGS.filter(
      (reserved) =>
        reserved.length === GENERATED_SLUG_LENGTH &&
        [...reserved].every((character) => SLUG_ALPHABET.includes(character)),
    );

    expect(drawable).toEqual(['support', 'privacy']);
  });

  it('a source that keeps drawing reserved slugs fails loudly rather than looping forever', () => {
    const source = new ScriptedSource(
      Array.from({ length: RESERVED_REDRAW_LIMIT }, () => bytesFor('support')),
    );

    expect(() => new SlugGenerator(source).next()).toThrow(/reserved/i);
    expect(source.calls).toBe(RESERVED_REDRAW_LIMIT);
  });
});
