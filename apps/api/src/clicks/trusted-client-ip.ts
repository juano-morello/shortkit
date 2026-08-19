/**
 * Contract: docs/contracts/click-events.md ("Client IP: the declared trusted value only"),
 *           trusted-client-address.md ("The two callers"; NORMATIVE for the read itself,
 *           its four rules, the boot assertion and the signal; none of it is restated here,
 *           F-320)
 * ADR: adr-0040-trusted-client-address-is-declared-and-may-be-absent.md, adr-0030,
 *      adr-0010-click-event-write-path.md
 * Produced by: TASK-2-09 (item 2, wave 4).
 * Consumed by: `click-event-buffer.ts`, at `enqueue`, and nowhere else.
 *
 * ============================================================================
 * THE CLICK PATH'S RESOLVER. IT IS NOT THE RATE LIMITER'S, AND THE TWO ARE NOT TO BE
 * MERGED (F-031).
 * ============================================================================
 *
 * `resolveRateLimitPrincipal` honours `X-Shortkit-Client-IP` when `X-Shortkit-Proxy-Auth`
 * matches the shared secret, because `/api/auth/*` is reached through the BFF and the peer
 * address there is the BFF's for every user. This function honours it NEVER, secret or no
 * secret: the redirect surface is reached by custom domains that CNAME straight to the API's
 * origin and never traverse the BFF, so a forwarded address on this path is a value the
 * visitor chose, and `ip_hash` is written to an append-only store a later analytics
 * initiative reads and a GDPR export hands back. That is F-009, and honouring the pair here
 * would reopen it through the front door.
 *
 * `X-Forwarded-For` and `Forwarded` are read at NO position, for NO purpose. That rule lives
 * inside `readTrustedClientAddress` (which this function is the only click-path caller of),
 * so it cannot be relaxed here without relaxing it for the limiter too.
 *
 * ============================================================================
 * `null` BECOMES A SENTINEL HERE, AND ONLY HERE.
 * ============================================================================
 *
 * `readTrustedClientAddress` answers `null` where no address was established, and
 * `trusted-client-address.md` is explicit that a `null` principal never becomes a BUCKET
 * key: a shared sentinel bucket would let one caller exhaust everyone's allowance. A CLICK
 * ROW IS THE OPPOSITE CASE: the row exists whatever happened, `ip_hash` is `NOT NULL`, and
 * the honest value for "no address was established" is a constant that no visitor can
 * produce. So the sentinel lives here rather than in the shared read.
 *
 * ACCEPTED COST, STATED (F-320, `click-events.md`). No environment declares a trusted header
 * today, so every visitor in those environments hashes the same sentinel and unique-visitor
 * counts derived from the stream are meaningless. That is strictly better than the previous
 * behaviour, where the visitor chose their own hash, and it is still a real loss of signal.
 */
import { readTrustedClientAddress } from '../common/net/trusted-client-address';
import type { TrustedAddressHeaders } from '../common/net/trusted-client-address';

/**
 * What is hashed when no address was established. NOT AN ADDRESS: `isIP()` rejects it, and
 * `readTrustedClientAddress` returns only values `isIP()` accepts, so no real visitor can
 * ever hash to the same message as an unresolved one. It is a message component and never a
 * bucket key, a column value or a log field.
 */
export const UNKNOWN_IP_SENTINEL = 'unknown-client-address';

/**
 * The declared trusted address, or the sentinel. Never throws (the shared read does not, and
 * nothing else happens here), never reads `X-Forwarded-For`, never reads the BFF pair.
 *
 * `env` is a parameter with a default rather than a `process.env` read in the body, so a
 * spec can drive the declared-header cases without mutating the process, and shipped code
 * still calls it exactly as `click-events.md` writes it: `trustedClientIp(headers)`.
 */
export function trustedClientIp(
  headers: TrustedAddressHeaders,
  env: Record<string, string | undefined> = process.env,
): string {
  return readTrustedClientAddress(headers, env) ?? UNKNOWN_IP_SENTINEL;
}
