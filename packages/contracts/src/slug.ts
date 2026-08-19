/**
 * Contract: docs/contracts/slug.md
 * ADR: adr-0007-short-code-generation.md, adr-0006-http-surface-partitioning.md
 * Produced by: TASK-007 (constants), TASK-2-01 (validateSlug, isReservedSlug — item 2's
 *              renumbering of the card slug.md still calls TASK-024)
 *
 * Single source of truth. TASK-2-05 (the generator and the routes) and TASK-2-13 (the
 * web's inline validation) import from here and do NOT redeclare.
 */

/** 57 symbols. 0, 1, I, O and l removed; one member of each confusable group kept. */
export const SLUG_ALPHABET =
  '23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export const GENERATED_SLUG_LENGTH = 7;
export const SLUG_MIN_LENGTH = 1;
export const SLUG_MAX_LENGTH = 64;
export const SLUG_GENERATION_MAX_ATTEMPTS = 5;

/** Custom slugs. Wider than the generated alphabet: operators type words. */
export const SLUG_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,62}[A-Za-z0-9])?$/;

/**
 * Compared case-insensitively.
 * First six are structural (they would shadow a real path or a platform convention).
 * The rest are brand protection.
 * ADDING AN ENTRY IS BREAKING: an operator may already own that slug.
 */
export const RESERVED_SLUGS = [
  'api',
  'health',
  'robots.txt',
  'favicon.ico',
  '.well-known',
  '_static',
  'admin',
  'login',
  'signup',
  'verify',
  'invite',
  'settings',
  'support',
  'status',
  'terms',
  'privacy',
] as const;

export type ReservedSlug = (typeof RESERVED_SLUGS)[number];

export type SlugViolation =
  | 'too_short'
  | 'too_long'
  | 'invalid_characters'
  | 'leading_or_trailing_separator'
  | 'reserved';

export type SlugValidation =
  | { ok: true; slug: string }
  | { ok: false; violation: SlugViolation };

/**
 * The character set `SLUG_PATTERN` admits, with nothing said about position.
 *
 * `SLUG_PATTERN` conflates two rules an operator experiences separately — which
 * characters are allowed, and where a separator may sit — because one regex has to
 * express both. `validateSlug` splits them so a form can say WHICH rule broke, and the
 * spec asserts the split reconstructs the pattern exactly rather than drifting from it.
 * Neither constant may be edited alone.
 */
const SLUG_CHARACTERS = /^[A-Za-z0-9_-]+$/;

/** Legal anywhere except the first and last position. */
const SLUG_SEPARATORS = '-_';

/**
 * Violation order is fixed so the reported message is deterministic:
 * too_short, too_long, invalid_characters, leading_or_trailing_separator, reserved.
 *
 * THE INPUT COMES BACK VERBATIM. No trim, no lower-casing, no normalisation: slugs are
 * case-sensitive for storage and lookup, matching the unique index, so a validator that
 * returned a normalised value would store something the operator did not type and then
 * fail to find it under the slug they did.
 *
 * The order is also why four `RESERVED_SLUGS` entries never report `reserved`:
 * `robots.txt`, `favicon.ico` and `.well-known` carry a character outside the set and
 * `_static` leads with a separator, so each is refused a rung earlier. They are still
 * refused, which is what the list exists for.
 */
export function validateSlug(input: string): SlugValidation {
  if (input.length < SLUG_MIN_LENGTH) {
    return { ok: false, violation: 'too_short' };
  }

  if (input.length > SLUG_MAX_LENGTH) {
    return { ok: false, violation: 'too_long' };
  }

  if (!SLUG_CHARACTERS.test(input)) {
    return { ok: false, violation: 'invalid_characters' };
  }

  if (
    SLUG_SEPARATORS.includes(input[0]) ||
    SLUG_SEPARATORS.includes(input[input.length - 1])
  ) {
    return { ok: false, violation: 'leading_or_trailing_separator' };
  }

  if (isReservedSlug(input)) {
    return { ok: false, violation: 'reserved' };
  }

  return { ok: true, slug: input };
}

/**
 * Whole-string, case-insensitive membership of `RESERVED_SLUGS`, so `Admin` is reserved
 * and `my-admin-panel` is not.
 *
 * `toLowerCase`, not `toLocaleLowerCase`: the comparison must not change with the
 * process locale (a Turkish locale lower-cases `I` to a dotless `ı` and `ADMIN` would
 * stop matching `admin`).
 *
 * ============================================================================
 * THE GENERATOR MUST CALL THIS TOO (TASK-2-05).
 * ============================================================================
 *
 * `slug.md` invariant 1 claims no generated slug can be reserved because "every reserved
 * slug contains a character outside SLUG_ALPHABET or a length other than 7". That is
 * false for `support` and `privacy`: both are exactly `GENERATED_SLUG_LENGTH` characters
 * drawn entirely from `SLUG_ALPHABET`, so a draw can produce them at 2/57^7. The
 * generator redraws while this returns true, on the attempt loop it already runs for
 * `23505`. `slug.spec.ts` pins the drawable set so a future reserved entry cannot grow
 * it unnoticed.
 */
export function isReservedSlug(input: string): boolean {
  const lowered = input.toLowerCase();

  return RESERVED_SLUGS.some((reserved) => reserved === lowered);
}
