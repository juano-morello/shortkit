/**
 * Contract: `docs/contracts/trusted-client-address.md` (the one normative home for the trust
 *           rule; its "Normative source" fence is what this file materialises)
 * ADR: adr-0040-trusted-client-address-is-declared-and-may-be-absent.md, adr-0030
 * Produced by: TASK-004 (wave 3, the first of TASK-004 and TASK-033 to land). Consumed by:
 *              `auth/resolve-rate-limit-principal.ts` (TASK-004), `RateLimitGuard`
 *              (TASK-051), `trustedClientIp` in the click path (TASK-033).
 *
 * ============================================================================
 * ONE IMPLEMENTATION OF THE READ. BOTH RESOLVERS CALL IT. A SECOND LOOKUP IS A DEFECT.
 * ============================================================================
 *
 * A trusted-header model is worth exactly as much as the hop that strips the header. ADR-0030
 * deleted the platform that set and stripped `Fly-Client-IP`, so the header is now DECLARED
 * by the deployment (`TRUSTED_CLIENT_IP_HEADER`) rather than named in source, and where no
 * address is established the result is `null` — no principal, never a client-supplied one.
 * `X-Forwarded-For` and `Forwarded` are read at NO position, for NO purpose: both are defined
 * to be appended to rather than replaced, so no hop can strip-and-set them, and reading
 * either reintroduces F-009 through the front door.
 *
 * THE BOOT ASSERTION FOR THE DECLARATION IS NOT HERE. `assertTrustedClientIpHeaderConfigured`
 * lives in `auth/boot-assertions.ts` beside the other boot refusals (TASK-004's card puts it
 * there) and imports the constants below, so the assertion and the read cannot disagree on
 * the pattern or the forbidden list. It keys on `CLIENT_TRUST_BOUNDARY`, never `NODE_ENV`
 * (F-380). The boundary governs whether FORGETTING the header is an error; it never governs
 * what is read, so a harness may declare the header alone.
 *
 * NEITHER THE HEADER NAME NOR ITS VALUE IS EVER LOGGED. `LOGGABLE_FIELDS` is an allowlist
 * (ADR-0028), so a configured name nobody enumerated is censored by default; nothing here
 * puts either on a line at all.
 */
import { isIP } from 'node:net';

export const TRUSTED_CLIENT_IP_HEADER_ENV = 'TRUSTED_CLIENT_IP_HEADER';

/** Lowercase, as Node presents incoming header names. */
export const TRUSTED_CLIENT_IP_HEADER_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Defined to be appended to, never replaced. No hop can strip-and-set them. */
export const FORBIDDEN_TRUSTED_HEADERS: readonly string[] = ['x-forwarded-for', 'forwarded'];

/**
 * The counter every IP-keyed bucket increments on a `null` principal. There is no metrics
 * pipeline in this repository yet, so it is carried in the `msg` of the once-per-minute warn
 * line rather than as a field, and only where a header was declared and the read still
 * failed — an environment that declares nothing is in a stated condition, and one warn per
 * request in `docker compose up` trains a developer to ignore the channel.
 */
export const TRUSTED_CLIENT_IP_UNRESOLVED_COUNTER = 'trusted_client_ip_unresolved_total';

/** Shape-compatible with Express's `req.headers` (`IncomingHttpHeaders`). */
export type TrustedAddressHeaders = Record<string, string | string[] | undefined>;

export const CLIENT_TRUST_BOUNDARY_ENV = 'CLIENT_TRUST_BOUNDARY';

/** Unset is read as 'direct'. Anything outside this set fails boot, everywhere. */
export const CLIENT_TRUST_BOUNDARIES = ['proxy', 'direct'] as const;
export type ClientTrustBoundary = (typeof CLIENT_TRUST_BOUNDARIES)[number];

export const CLIENT_TRUST_BOUNDARY_INVALID_MESSAGE =
  'CLIENT_TRUST_BOUNDARY must be "proxy" or "direct", or unset. It is not NODE_ENV and it is not a boolean.';

export const TRUSTED_CLIENT_IP_HEADER_UNSET_MESSAGE =
  'CLIENT_TRUST_BOUNDARY is "proxy" but TRUSTED_CLIENT_IP_HEADER is not set. A proxied deployment must name the header its hop sets and strips. See docs/contracts/trusted-client-address.md.';

export const TRUSTED_CLIENT_IP_HEADER_MALFORMED_MESSAGE =
  'TRUSTED_CLIENT_IP_HEADER is not a valid lowercase HTTP header name.';

export const TRUSTED_CLIENT_IP_HEADER_FORBIDDEN_MESSAGE =
  'TRUSTED_CLIENT_IP_HEADER may not name a forwarding header that is appended to rather than replaced.';

/**
 * Whether the declared name is one this contract permits: well formed and not a forwarding
 * header. Shared by the read (rule 2) and by the boot assertion, so the two agree by
 * construction.
 */
export function isAcceptableTrustedHeaderName(name: string): boolean {
  return TRUSTED_CLIENT_IP_HEADER_PATTERN.test(name) && !FORBIDDEN_TRUSTED_HEADERS.includes(name);
}

/**
 * The single read. Returns a value `isIP()` accepts, or `null`. Never throws.
 * Never reads `x-forwarded-for` or `forwarded`, in any position, for any purpose.
 *
 * The four rules, each of which returns `null` on failure (`trusted-client-address.md`,
 * "The read, rule by rule"):
 *
 *   1. `TRUSTED_CLIENT_IP_HEADER` is set and non-empty. Unset or empty disables the read
 *      UNCONDITIONALLY — no header is looked up at all, so a request carrying a plausible
 *      header under an undeclared name is a client choosing its own principal and gets
 *      nothing.
 *   2. The declared name matches the pattern and is not forbidden. Under
 *      `CLIENT_TRUST_BOUNDARY=proxy` this cannot fail, because boot already refused it;
 *      anywhere else it can, and it returns `null` rather than throwing.
 *   3. The header is present, a SINGLE string, and non-empty after `trim()`. An array — what
 *      Node presents for a repeated header — is `null`, and so is a value containing a comma.
 *      NO LIST IS EVER PARSED, AT EITHER END: a repeated or comma-joined header means
 *      something upstream appended instead of replacing, which is the condition rule 2 exists
 *      to prevent, and it returns nothing rather than a guess.
 *   4. `isIP(value.trim()) !== 0`. This bounds the value before it becomes a Redis key
 *      segment, a local-limiter map key or an HMAC message; Node accepts 16 KiB headers.
 *
 * `Object.hasOwn` rather than `headers[name]` alone: a header object is a plain record, and a
 * declared name of `constructor` or `__proto__` must read as absent rather than reach the
 * prototype (invariant 4, never throws).
 */
export function readTrustedClientAddress(
  headers: TrustedAddressHeaders,
  env: Record<string, string | undefined>,
): string | null {
  const declared = env[TRUSTED_CLIENT_IP_HEADER_ENV];

  if (declared === undefined || declared.trim() === '') {
    return null;
  }

  if (!isAcceptableTrustedHeaderName(declared)) {
    return null;
  }

  const value = Object.hasOwn(headers, declared) ? headers[declared] : undefined;

  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();

  if (trimmed === '' || trimmed.includes(',')) {
    return null;
  }

  return isIP(trimmed) === 0 ? null : trimmed;
}
