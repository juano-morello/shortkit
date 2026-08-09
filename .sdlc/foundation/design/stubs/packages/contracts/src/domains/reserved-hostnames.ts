/**
 * Contract: design/contracts/domain-provisioning.md
 * ADR: adr-0016-domain-provisioning.md (F-003)
 * Produced by: TASK-038
 * Consumed by: TASK-040 (rejection at POST /api/domains), TASK-041 (inline validation)
 *
 * Single source of truth, beside RESERVED_SLUGS. Imported, never redeclared.
 */
import { z } from 'zod';

/** RFC 1123 label. Lowercase only: the hostname is normalised before this runs. */
export const HOSTNAME_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export const HOSTNAME_MAX_LENGTH = 253;
export const HOSTNAME_MIN_LENGTH = 4;

/**
 * Claiming one of these would serve attacker-controlled redirects and attacker-supplied
 * branding from an origin the platform assigns us.
 *
 * A leading '.' means "this suffix and everything under it".
 * APEX and API hostnames are read from env because the apex domain is still
 * unregistered — whoever registers it MUST set them (ADR-0016 accepted cost).
 */
export const RESERVED_HOSTNAME_SUFFIXES = [
  '.fly.dev',
  '.vercel.app',
  '.upstash.io',
  '.neon.tech',
  '.localhost',
  '.local',
  '.internal',
] as const;

export const RESERVED_HOSTNAME_EXACT = [
  'localhost',
  'fly.dev',
  'vercel.app',
] as const;

/** Adds the apex, its www, the API host, and the seeded system default domain. */
export function reservedHostnamesFromEnv(): string[] {
  throw new Error('not implemented');
}

export function isIpLiteral(_hostname: string): boolean {
  throw new Error('not implemented');
}

export function isReservedHostname(_hostname: string): boolean {
  throw new Error('not implemented');
}

/**
 * Normalises ONCE, at validation. The stored value is the normalised one, and it is the
 * same form redirect-cache.md keys on, so a unicode homograph cannot produce two rows
 * or two cache keys for one hostname.
 */
export const hostnameContract = z
  .string()
  .min(HOSTNAME_MIN_LENGTH)
  .max(HOSTNAME_MAX_LENGTH)
  .transform((h) => h.trim().toLowerCase())
  .transform((h) => new URL(`https://${h}`).hostname)
  .refine((h) => h.split('.').length >= 2, 'Must be a fully qualified hostname.')
  .refine((h) => h.split('.').every((l) => HOSTNAME_LABEL.test(l)), 'Invalid hostname.')
  .refine((h) => !isIpLiteral(h), 'An IP address cannot be used as a custom domain.')
  .refine((h) => !isReservedHostname(h), 'That hostname is not available.');
