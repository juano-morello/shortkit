/**
 * Contract: docs/contracts/slug.md ("Generation", "Invariants a caller may rely on")
 * ADR: adr-0007-short-code-generation.md
 * Produced by: TASK-2-05
 * Consumed by: `links.service.ts` (the create path), `links.module.ts` (the binding)
 *
 * The generator, and the two loops it runs.
 *
 * ============================================================================
 * REJECTION SAMPLING, NOT `byte % 57` (AC-2-11).
 * ============================================================================
 *
 * 256 is not a multiple of 57. Folding a whole byte onto the alphabet gives the first
 * 28 symbols five chances each and the other 29 four, which is a 25% bias on four out
 * of every nine characters, visible in an aggregate of a few thousand slugs and
 * exactly the property `slug.md` calls a defect. So a byte at or above `REJECTION_BOUND`
 * (228, the largest multiple of 57 that fits) is DISCARDED and another is drawn.
 *
 * `symbolForByte` is exported so uniformity is measured over the whole byte range in a
 * unit test rather than inferred from samples of `next()`.
 *
 * ============================================================================
 * THE SECOND LOOP: A RESERVED CANDIDATE IS REDRAWN (slug.md invariant 1, CORRECTED).
 * ============================================================================
 *
 * `slug.md` used to argue that no generated slug can be reserved because "every reserved
 * slug contains a character outside `SLUG_ALPHABET` or a length other than 7". That is
 * false for two of the sixteen: `support` and `privacy` are each exactly
 * `GENERATED_SLUG_LENGTH` characters drawn wholly from `SLUG_ALPHABET`, so a draw can
 * produce either, at 2/57^7. The invariant is restored HERE rather than by narrowing the
 * alphabet: `next()` redraws while `isReservedSlug(candidate)` is true, so
 * `validateSlug(generator.next())` is `{ ok: true }` unconditionally and not merely
 * usually. A caller that had to remember to check would be a caller that eventually did
 * not.
 *
 * THE REDRAW IS NOT CHARGED TO `SLUG_GENERATION_MAX_ATTEMPTS`. That budget bounds
 * DATABASE round trips (a `23505` on `links_domain_id_slug_unique` costs a statement and
 * a savepoint rollback), and spending one of the five on a purely local condition would
 * make 500 `slug_generation_exhausted` reachable with no collision anywhere. It is bounded
 * separately by `RESERVED_REDRAW_LIMIT`, which exists only so a malfunctioning
 * `RandomSource` (a scripted one in a test, a stub that returns a constant) fails loudly
 * instead of hanging a request forever.
 */
import { randomFillSync } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import { GENERATED_SLUG_LENGTH, isReservedSlug, SLUG_ALPHABET } from '@shortkit/contracts';

/**
 * Where the entropy comes from. One method, because that is the whole of what the
 * generator needs and the whole of what a test has to script.
 *
 * `bytes` FILLS `out` IN PLACE and returns nothing, matching `crypto.randomFillSync`'s own
 * shape so the production binding is the function itself rather than an adapter with a
 * copy in it.
 */
export interface RandomSource {
  bytes(out: Uint8Array): void;
}

/** The injection token. `links.module.ts` binds `cryptoRandomSource`; a suite overrides it. */
export const RANDOM_SOURCE = Symbol('RANDOM_SOURCE');

/** Production. Node's CSPRNG, filling the buffer the generator already allocated. */
export const cryptoRandomSource: RandomSource = {
  bytes(out: Uint8Array): void {
    randomFillSync(out);
  },
};

/**
 * 228. Bytes at or above it are redrawn; below it, `byte % 57` is uniform over the
 * alphabet because the range is exactly four whole copies of it.
 */
export const REJECTION_BOUND =
  SLUG_ALPHABET.length * Math.floor(256 / SLUG_ALPHABET.length);

/**
 * How many candidates `next()` will discard for being reserved before it gives up. Two of
 * 57^7 draws are reserved, so reaching this means the source is not random (a scripted
 * source in a test, or a stub returning a constant), and a loud throw beats a hung
 * request. It is NOT `SLUG_GENERATION_MAX_ATTEMPTS`: see the header.
 */
export const RESERVED_REDRAW_LIMIT = 8;

/**
 * One byte's symbol, or `null` for a byte the sampler rejects. Exported for the
 * uniformity test, which walks 0..255; nothing else calls it.
 */
export function symbolForByte(byte: number): string | null {
  return byte >= REJECTION_BOUND ? null : SLUG_ALPHABET[byte % SLUG_ALPHABET.length];
}

@Injectable()
export class SlugGenerator {
  /** `@Inject(...)` written out for the reason `workspaces.service.ts` gives. */
  constructor(@Inject(RANDOM_SOURCE) private readonly source: RandomSource) {}

  /**
   * A candidate. Uniqueness is settled by `links_domain_id_slug_unique` and the caller's
   * savepoint retry, not by a pre-check here: a `SELECT` before the `INSERT` would be a
   * read the race can invalidate between the two statements.
   */
  next(): string {
    for (let attempt = 0; attempt < RESERVED_REDRAW_LIMIT; attempt += 1) {
      const candidate = this.draw();

      if (!isReservedSlug(candidate)) {
        return candidate;
      }
    }

    throw new Error(
      `SlugGenerator drew a reserved slug ${String(RESERVED_REDRAW_LIMIT)} times in a row. ` +
        'Two of 57^7 draws are reserved, so the RandomSource is not returning random bytes.',
    );
  }

  /** Seven accepted symbols. Refills as often as rejection costs it. */
  private draw(): string {
    const buffer = new Uint8Array(GENERATED_SLUG_LENGTH);
    let slug = '';

    while (slug.length < GENERATED_SLUG_LENGTH) {
      this.source.bytes(buffer);

      for (const byte of buffer) {
        const symbol = symbolForByte(byte);

        if (symbol === null) {
          continue;
        }

        slug += symbol;

        if (slug.length === GENERATED_SLUG_LENGTH) {
          break;
        }
      }
    }

    return slug;
  }
}
