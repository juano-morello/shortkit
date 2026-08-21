/**
 * Contract: docs/contracts/invitation-tokens.md ("Token format", "Storage", "The single
 *           entry point")
 * ADR: adr-0021-tenant-routing-capability-tokens.md, adr-0029-credentials-are-never-constructible-into-error-text.md
 * Produced by: TASK-1b-04
 *
 * ============================================================================
 * PURE. NO DATABASE, NO LOGGER, NO TENANT CONTEXT. THREE FUNCTIONS AND ONE ERROR.
 * ============================================================================
 *
 * `<tenantId>.<secret>`: a canonical lower-case uuid (36), the first `.`, and 32 bytes
 * from `crypto.randomBytes` as unpadded base64url (43). The left half ROUTES: it is the
 * tenant id `capability-lookup.ts` opens `withTenantTransaction` on. The right half
 * AUTHORISES: only its SHA-256 digest is stored (`invitations.token_digest`, 32 bytes),
 * and possession of the raw secret is the whole proof. Nothing here verifies anything;
 * verification is the digest lookup under RLS, which is the other file's job and the
 * only place `parseCapabilityToken` may be called from (`capability-lookup.spec.ts`
 * greps for it; GC-L, D-17).
 *
 * ============================================================================
 * THE RAW TOKEN NEVER REACHES A STRING THIS MODULE BUILDS (ADR-0029, GC-K).
 * ============================================================================
 *
 * `MalformedCapabilityToken.message` is one fixed literal. Not a prefix of the input,
 * not its length, not which half failed: the value is an unauthenticated body field, and
 * a well-formed token that fails the digest must be indistinguishable from a malformed
 * one at every surface (invitation-tokens.md: "404 is one body"). `assertUuid` in
 * `tenant-context.ts` is deliberately NOT used for the left half: its
 * `InvalidTenantIdError` echoes eight characters of the value, which is right for a
 * programming error and wrong for a bearer credential. The uuid shape is checked here
 * with the same regex, so `withTenantTransaction`'s own assertion is a second floor and
 * never the first to see the value.
 *
 * `digestOf` hashes THE SECRET HALF ONLY (invitation-tokens.md "Storage"): the tenant id
 * is already a column, and hashing the whole token would bind the digest to the routing
 * prefix without adding entropy.
 */
import { createHash, randomBytes } from 'node:crypto';

export interface CapabilityToken {
  readonly tenantId: string;
  readonly secret: string;
}

/** The whole of the message. Fixed, so a test can assert on it and nothing can leak into it. */
export const MALFORMED_MESSAGE = 'Capability token is malformed.';

/**
 * Thrown by `parseCapabilityToken` and nothing else. A plain `Error`, not a
 * `DomainError`: the caller decides the answer (`null` from a lookup, `not_found` from an
 * accept), and this class carrying a code would tempt a route to let it propagate and so
 * disclose "malformed" as distinct from "unknown".
 */
export class MalformedCapabilityToken extends Error {
  constructor() {
    super(MALFORMED_MESSAGE);
    this.name = 'MalformedCapabilityToken';
  }
}

/** The same shape `assertUuid` accepts, any version, either casing on the way in. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 32 bytes as unpadded base64url is always 43 characters and never contains `.`. */
const SECRET = /^[A-Za-z0-9_-]{43}$/;

const SECRET_BYTES = 32;

export const CAPABILITY_TOKEN_SEPARATOR = '.';

/**
 * Splits on the FIRST `.`; the secret's alphabet excludes it, so a second one is
 * malformed rather than ambiguous. Lower-cases the tenant half (F-130: the canonical
 * form, which is what Postgres renders and what `withTenantTransaction` compares against
 * an active context).
 *
 * `raw` is typed `string` and checked at runtime anyway: the Better Auth hooks hand this
 * an unvalidated body field (F-228), and a `TypeError` on `.indexOf` there is an
 * unauthenticated 500 generator.
 */
export function parseCapabilityToken(raw: string): CapabilityToken {
  if (typeof raw !== 'string') {
    throw new MalformedCapabilityToken();
  }

  const separator = raw.indexOf(CAPABILITY_TOKEN_SEPARATOR);

  if (separator === -1) {
    throw new MalformedCapabilityToken();
  }

  const tenantId = raw.slice(0, separator);
  const secret = raw.slice(separator + 1);

  if (!UUID.test(tenantId) || !SECRET.test(secret)) {
    throw new MalformedCapabilityToken();
  }

  return { tenantId: tenantId.toLowerCase(), secret };
}

/** SHA-256 of the secret half, 32 bytes, the value `invitations.token_digest` holds. */
export function digestOf(secret: string): Buffer {
  return createHash('sha256').update(secret, 'utf8').digest();
}

/**
 * Mints one token for a tenant. Returns the raw token (which the caller hands to the mail
 * template and to nothing else (GC-K)), and the digest the repository stores. The tenant
 * id is the caller's own (`currentTenantId()` on the create route), so a bad one is a
 * programming error; it is still refused, because the string is about to be sent to a
 * stranger as a routing prefix. The message names no value.
 */
export function issueCapabilityToken(tenantId: string): {
  readonly raw: string;
  readonly digest: Buffer;
} {
  if (typeof tenantId !== 'string' || !UUID.test(tenantId)) {
    throw new Error('issueCapabilityToken needs a uuid tenant id.');
  }

  const secret = randomBytes(SECRET_BYTES).toString('base64url');

  return {
    raw: `${tenantId.toLowerCase()}${CAPABILITY_TOKEN_SEPARATOR}${secret}`,
    digest: digestOf(secret),
  };
}
