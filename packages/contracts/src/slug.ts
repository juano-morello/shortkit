/**
 * Contract: docs/contracts/slug.md
 * ADR: adr-0007-short-code-generation.md, adr-0006-http-surface-partitioning.md
 * Produced by: TASK-007 (constants), TASK-024 (validateSlug)
 *
 * Single source of truth. TASK-024 and TASK-026 import from here and do NOT redeclare.
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
 * Violation order is fixed so the reported message is deterministic:
 * too_short, too_long, invalid_characters, leading_or_trailing_separator, reserved.
 */
export function validateSlug(_input: string): SlugValidation {
  throw new Error('not implemented');
}

export function isReservedSlug(_input: string): boolean {
  throw new Error('not implemented');
}
