/**
 * STORY-2-02, AC-2-2 (the violation order and the case-insensitive reserved compare),
 *              AC-2-13 (the generated-alphabet subset property). TASK-2-01.
 *
 * Contract: docs/contracts/slug.md
 * ADR: adr-0007-short-code-generation.md, adr-0006-http-surface-partitioning.md
 *
 * `validateSlug` and `isReservedSlug` threw `not implemented` until this card; the
 * constants shipped with TASK-007 and are untouched here.
 *
 * ============================================================================
 * THE ORDER IS THE CONTRACT, NOT AN IMPLEMENTATION DETAIL.
 * ============================================================================
 *
 * `slug.md` fixes it (`too_short`, `too_long`, `invalid_characters`,
 * `leading_or_trailing_separator`, `reserved`) because the violation is what
 * `details.fieldErrors.slug` carries to a form (AC-2-2), and a message that changes
 * with the implementation's branch order is a message no test can pin. Every input
 * below that breaks more than one rule asserts which violation wins.
 *
 * ============================================================================
 * THE GENERATOR IS NOT IN THIS PACKAGE. THE PROPERTY IT RESTS ON IS.
 * ============================================================================
 *
 * `crypto` may not enter `packages/contracts` (ADR-0005), so `SlugGenerator` is
 * TASK-2-05's. What lives here is the half AC-2-13 rests on: that a 7-character draw
 * from `SLUG_ALPHABET` satisfies `validateSlug`, and the two entries for which
 * `slug.md`'s invariant 1 is FALSE as written. See the last describe block.
 */
import { describe, expect, it } from 'vitest';

import {
  GENERATED_SLUG_LENGTH,
  RESERVED_SLUGS,
  SLUG_ALPHABET,
  SLUG_MAX_LENGTH,
  SLUG_MIN_LENGTH,
  SLUG_PATTERN,
  isReservedSlug,
  validateSlug,
} from './slug';

/** The violation, or `'ok'`. One helper so every table row reads as one value. */
function outcomeOf(input: string): string {
  const result = validateSlug(input);

  return result.ok ? 'ok' : result.violation;
}

describe('validateSlug: the accepting branch', () => {
  it('returns the input VERBATIM: no trim, no lower-casing, no normalisation', () => {
    // Slugs are case-sensitive for storage and lookup (slug.md), so a validator that
    // returned a normalised value would store something the operator did not type and
    // break the `(domain_id, slug)` lookup for the one they did.
    expect(validateSlug('Spring-Sale-2026')).toEqual({ ok: true, slug: 'Spring-Sale-2026' });
  });

  it('AC-2-2: a valid custom slug is accepted case-sensitively', () => {
    expect(validateSlug('spring-sale-2026')).toEqual({ ok: true, slug: 'spring-sale-2026' });
  });

  it('admits the boundary lengths the constants name', () => {
    expect(outcomeOf('a'.repeat(SLUG_MIN_LENGTH))).toBe('ok');
    expect(outcomeOf('a'.repeat(SLUG_MAX_LENGTH))).toBe('ok');
  });

  it('admits interior separators, which is the point of the wider custom alphabet', () => {
    expect(outcomeOf('spring_sale-2026')).toBe('ok');
    expect(outcomeOf('a-b_c-d')).toBe('ok');
  });
});

describe('validateSlug: one violation at a time', () => {
  it.each([
    ['the empty string', '', 'too_short'],
    ['one character over the maximum', 'a'.repeat(SLUG_MAX_LENGTH + 1), 'too_long'],
    ['a dot', 'spring.sale', 'invalid_characters'],
    ['a space', 'spring sale', 'invalid_characters'],
    ['a slash', 'spring/sale', 'invalid_characters'],
    ['a non-ASCII letter', 'sprïng', 'invalid_characters'],
    ['a leading hyphen', '-spring', 'leading_or_trailing_separator'],
    ['a trailing hyphen', 'spring-', 'leading_or_trailing_separator'],
    ['a leading underscore', '_spring', 'leading_or_trailing_separator'],
    ['a trailing underscore', 'spring_', 'leading_or_trailing_separator'],
    ['a lone hyphen, which leads and trails at once', '-', 'leading_or_trailing_separator'],
    ['a lone underscore', '_', 'leading_or_trailing_separator'],
    ['a reserved slug', 'api', 'reserved'],
  ])('%s is %s', (_label, input, violation) => {
    expect(outcomeOf(input)).toBe(violation);
  });
});

describe('validateSlug: the fixed order decides when several rules are broken', () => {
  it.each([
    ['too_long beats invalid_characters', '.'.repeat(SLUG_MAX_LENGTH + 1), 'too_long'],
    [
      'too_long beats leading_or_trailing_separator',
      `-${'a'.repeat(SLUG_MAX_LENGTH)}`,
      'too_long',
    ],
    [
      'invalid_characters beats leading_or_trailing_separator',
      '-spring.sale-',
      'invalid_characters',
    ],
    [
      'invalid_characters beats reserved (robots.txt carries a dot)',
      'robots.txt',
      'invalid_characters',
    ],
    [
      'leading_or_trailing_separator beats reserved (_static leads with an underscore)',
      '_static',
      'leading_or_trailing_separator',
    ],
  ])('%s', (_label, input, violation) => {
    expect(outcomeOf(input)).toBe(violation);
  });

  it('the order slug.md fixes is the order the violations come out in', () => {
    // One assertion over the whole ladder, so a reordered implementation fails here with
    // the sequence printed rather than in five separate places.
    expect([
      outcomeOf(''),
      outcomeOf('.'.repeat(SLUG_MAX_LENGTH + 1)),
      outcomeOf('-spring.sale-'),
      outcomeOf('-spring'),
      outcomeOf('api'),
    ]).toEqual([
      'too_short',
      'too_long',
      'invalid_characters',
      'leading_or_trailing_separator',
      'reserved',
    ]);
  });
});

describe('isReservedSlug', () => {
  it('AC-2-2: the comparison is case-insensitive, so `Admin` is reserved too', () => {
    expect({
      admin: isReservedSlug('admin'),
      Admin: isReservedSlug('Admin'),
      ADMIN: isReservedSlug('ADMIN'),
      AdMiN: isReservedSlug('AdMiN'),
    }).toEqual({ admin: true, Admin: true, ADMIN: true, AdMiN: true });
  });

  it('every entry of RESERVED_SLUGS is reserved, in every casing', () => {
    const missed = RESERVED_SLUGS.filter(
      (slug) => !isReservedSlug(slug) || !isReservedSlug(slug.toUpperCase()),
    );

    expect(missed).toEqual([]);
  });

  it('a slug that merely CONTAINS a reserved word is not reserved', () => {
    // The compare is whole-string. `my-admin-panel` is an operator's slug, not a
    // structural route, and refusing it would refuse a large class of real slugs.
    expect({
      'my-admin-panel': isReservedSlug('my-admin-panel'),
      administrator: isReservedSlug('administrator'),
      apis: isReservedSlug('apis'),
      ap: isReservedSlug('ap'),
    }).toEqual({
      'my-admin-panel': false,
      administrator: false,
      apis: false,
      ap: false,
    });
  });

  it('does not trim: whitespace-wrapped `api` is not reserved, and validateSlug refuses it earlier', () => {
    expect(isReservedSlug(' api ')).toBe(false);
    expect(outcomeOf(' api ')).toBe('invalid_characters');
  });
});

describe('every reserved slug is refused, and four of them are refused structurally first', () => {
  // The table is exhaustive on purpose: adding an entry to RESERVED_SLUGS is a BREAKING
  // change (slug.md, Versioning), so a new entry must land here deliberately rather than
  // slip in under a loop that only checks `!== 'ok'`.
  it.each([
    ['api', 'reserved'],
    ['health', 'reserved'],
    ['robots.txt', 'invalid_characters'],
    ['favicon.ico', 'invalid_characters'],
    ['.well-known', 'invalid_characters'],
    ['_static', 'leading_or_trailing_separator'],
    ['admin', 'reserved'],
    ['login', 'reserved'],
    ['signup', 'reserved'],
    ['verify', 'reserved'],
    ['invite', 'reserved'],
    ['settings', 'reserved'],
    ['support', 'reserved'],
    ['status', 'reserved'],
    ['terms', 'reserved'],
    ['privacy', 'reserved'],
  ])('%s is refused as %s', (slug, violation) => {
    expect(outcomeOf(slug)).toBe(violation);
  });

  it('the table above covers RESERVED_SLUGS exactly', () => {
    expect(RESERVED_SLUGS.length).toBe(16);
  });

  it('no reserved slug is ever accepted, whatever the reported violation', () => {
    const accepted = RESERVED_SLUGS.filter((slug) => validateSlug(slug).ok);

    expect(accepted).toEqual([]);
  });
});

describe('validateSlug agrees with SLUG_PATTERN exactly', () => {
  // `validateSlug` decomposes SLUG_PATTERN into two separately reportable violations
  // (charset, then leading/trailing separator) so a form can say WHICH rule broke. This
  // pins that the decomposition reconstructs the pattern rather than drifting from it:
  // acceptance must equal `SLUG_PATTERN.test(x) && !isReservedSlug(x)` for every input.
  const CORPUS = [
    '',
    'a',
    'A',
    '9',
    '-',
    '_',
    '--',
    'a-',
    '-a',
    'a_',
    '_a',
    'a-b',
    'a_b',
    'a--b',
    'a.b',
    'a b',
    'a/b',
    'a\\b',
    'a\tb',
    'a\nb',
    'sprïng',
    '日本語',
    'api',
    'API',
    'privacy',
    'my-admin-panel',
    'a'.repeat(SLUG_MAX_LENGTH),
    'a'.repeat(SLUG_MAX_LENGTH + 1),
    `-${'a'.repeat(SLUG_MAX_LENGTH - 1)}`,
  ];

  it.each(CORPUS.map((input) => [JSON.stringify(input), input]))(
    '%s: ok === SLUG_PATTERN.test(input) && !isReservedSlug(input)',
    (_label, input) => {
      expect(validateSlug(input).ok).toBe(SLUG_PATTERN.test(input) && !isReservedSlug(input));
    },
  );
});

describe('AC-2-13: the generated alphabet is a subset of what validateSlug accepts', () => {
  it('the alphabet is the 57 symbols ADR-0007 fixed, with the five confusables removed', () => {
    expect({
      length: SLUG_ALPHABET.length,
      unique: new Set(SLUG_ALPHABET).size,
      confusables: [...'01IOl'].filter((character) => SLUG_ALPHABET.includes(character)),
      separators: [...'-_.'].filter((character) => SLUG_ALPHABET.includes(character)),
    }).toEqual({ length: 57, unique: 57, confusables: [], separators: [] });
  });

  it('every symbol is accepted in every position of a generated-length slug', () => {
    // A symbol illegal only at the ends (a separator) would pass a middle-only sweep and
    // break one draw in fifty-seven, so first, middle and last are each swept.
    const refused = [...SLUG_ALPHABET].flatMap((character) =>
      [0, 3, GENERATED_SLUG_LENGTH - 1]
        .map((position) => {
          const slug = [...'a'.repeat(GENERATED_SLUG_LENGTH)];
          slug[position] = character;

          return slug.join('');
        })
        .filter((slug) => !validateSlug(slug).ok),
    );

    expect(refused).toEqual([]);
  });

  it('AC-2-13: ten thousand deterministic draws from the alphabet all validate', () => {
    // A seeded LCG, not `crypto`: this package may import zod and nothing else
    // (ADR-0005), and a test that reruns with different values is not a pin. The real
    // generator and its rejection sampling are TASK-2-05's; what this asserts is the
    // property that makes `validateSlug(generateSlug())` true.
    let state = 20260819;
    const next = (): number => {
      state = (state * 1664525 + 1013904223) % 4294967296;

      return state;
    };
    const refused: string[] = [];

    for (let draw = 0; draw < 10_000; draw += 1) {
      let slug = '';

      for (let position = 0; position < GENERATED_SLUG_LENGTH; position += 1) {
        slug += SLUG_ALPHABET[next() % SLUG_ALPHABET.length];
      }

      if (!validateSlug(slug).ok) {
        refused.push(slug);
      }
    }

    expect(refused).toEqual([]);
  });

  it('slug.md invariant 1 is FALSE for `support` and `privacy`: both are drawable', () => {
    // ========================================================================
    // FINDING (TASK-2-01). slug.md invariant 1 says "no generated slug can be
    // reserved: every reserved slug contains a character outside SLUG_ALPHABET or
    // has a length other than 7". Two entries satisfy neither escape hatch.
    // ========================================================================
    //
    // `support` and `privacy` are exactly GENERATED_SLUG_LENGTH characters and every
    // one of those characters is in SLUG_ALPHABET, so a draw CAN produce them, at
    // 2/57^7, about one in a trillion. The consequence is small and real: that draw
    // would put a live link on a brand-protected slug, and `validateSlug` on it
    // answers `{ ok: false, violation: 'reserved' }`, contradicting the invariant a
    // caller is told to rely on.
    //
    // The fix belongs to the generator (TASK-2-05): redraw while `isReservedSlug` is
    // true, on the attempt loop that already exists for `23505`. This test names the
    // exact set so that adding a reserved entry (already BREAKING per slug.md's
    // Versioning) cannot quietly grow it unnoticed.
    const drawable = RESERVED_SLUGS.filter(
      (slug) =>
        slug.length === GENERATED_SLUG_LENGTH &&
        [...slug].every((character) => SLUG_ALPHABET.includes(character)),
    );

    expect(drawable).toEqual(['support', 'privacy']);

    for (const slug of drawable) {
      expect(validateSlug(slug)).toEqual({ ok: false, violation: 'reserved' });
    }
  });
});
