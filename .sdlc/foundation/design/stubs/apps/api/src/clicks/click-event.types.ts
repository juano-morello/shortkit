/**
 * Contract: design/contracts/click-events.md
 * ADR: adr-0010-click-event-write-path.md
 * Produced by: TASK-033 (writer, reader), TASK-034 (buffer, emission)
 *
 * Amendment A-2: append-only is scoped to the TENANT-FACING interface.
 * ClickEventWriter and ClickEventReader expose no update and no delete (AC-60).
 * The table itself is mutable by privilegedTenantEraser (TASK-054).
 * DO NOT add a row-level immutability trigger: it would block that path.
 */
import type { Paginated } from '@shortkit/contracts';

export interface ClickEventInput {
  readonly linkId: string;
  readonly domainId: string;
  readonly tenantId: string;
  readonly occurredAt: Date;
  /** HMAC-SHA256, never a bare hash: a bare SHA-256 of an IPv4 is reversible in seconds. */
  readonly ipHash: string;
  readonly userAgent: string | null;
}

export interface ClickEvent extends ClickEventInput {
  /** UUID v7, generated at ENQUEUE time. Makes the flush retry idempotent, and sorts by time. */
  readonly id: string;
}

/**
 * enqueue() is SYNCHRONOUS, allocation-only, and CANNOT THROW.
 * It must create no promise and perform no I/O: it runs on the redirect hot path
 * inside GC-1's 25 ms budget, before the response is written.
 */
export interface ClickEventBuffer {
  enqueue(input: ClickEventInput): void;
  /** Test hook and SIGTERM drain. The AC-56 test awaits this; it does NOT sleep. */
  flush(): Promise<void>;
  readonly size: number;
}

export const CLICK_BUFFER_FLUSH_SIZE = 100;
export const CLICK_BUFFER_FLUSH_INTERVAL_MS = 1000;
export const CLICK_BUFFER_CAPACITY = 10_000;
export const CLICK_BUFFER_SHUTDOWN_DRAIN_MS = 5000;

/**
 * F-013. Capacity is bounded by BYTES as well as by row count.
 * A 16 KiB User-Agent at a few hundred RPS reached ~160 MiB of live heap on the single
 * machine that also serves every redirect; the OOM kill dropped the buffer and broke
 * GC-8 for every concurrent visitor. The redirect path is never rate limited (AC-86),
 * so nothing else bounds this.
 */
export const CLICK_BUFFER_MAX_BYTES = 4 * 1024 * 1024;
export const USER_AGENT_MAX_LENGTH = 512;

/** One of exactly two tenant-facing surfaces on click_events (AC-60). */
export interface ClickEventWriter {
  append(input: ClickEventInput): Promise<void>;
}

/** The other. No update, no delete, on either. */
export interface ClickEventReader {
  query(q: {
    linkId: string;
    from: Date;
    to: Date;
    limit?: number;
    cursor?: string;
  }): Promise<Paginated<ClickEvent>>;
}

/**
 * CLICK_IP_HASH_KEY is 32 bytes from the environment. The raw IP is stored nowhere,
 * logged nowhere, and exported nowhere (GC-9, AC-58).
 *
 * F-009: the message is SALTED WITH tenantId, so the same visitor produces different
 * hashes for different tenants. Without it, two operators comparing exports could
 * confirm the same person clicked links in both agencies.
 *
 *   base64url(hmacSha256(CLICK_IP_HASH_KEY, `${tenantId}:${ip}`)).slice(0, 22)
 */
export function hashClientIp(_tenantId: string, _trustedIp: string): string {
  throw new Error('not implemented');
}

/**
 * F-009. X-Forwarded-For IS NEVER READ, AT ANY POSITION, FOR ANY PURPOSE.
 * It is fully attacker-controlled, and the redirect path is deliberately exempt from
 * rate limiting (AC-86), so a visitor could otherwise choose their own ip_hash and
 * write unlimited rows attributing clicks to arbitrary visitors — permanently, into an
 * append-only store that is exported to the tenant under GDPR.
 *
 * REVISED 2026-08-11 (F-320, ADR-0040). This read was "prefer Fly-Client-IP, fall back to
 * the RIGHTMOST XFF entry after TRUSTED_PROXY_HOPS hops". ADR-0030 deleted the platform
 * that set AND STRIPPED Fly-Client-IP, so both branches were client-supplied: nothing
 * strips the header, and an XFF list with no proxy in front is a list the caller wrote.
 * TRUSTED_PROXY_HOPS is DELETED; its only correct value was ever 0.
 *
 *   trustedClientIp(headers) = readTrustedClientAddress(headers, process.env)
 *                              ?? UNKNOWN_IP_SENTINEL
 *
 * readTrustedClientAddress lives in apps/api/src/common/net/trusted-client-address.ts and
 * is NORMATIVE in design/contracts/trusted-client-address.md, which owns the declaration
 * format, the four read rules, the counter and the boot assertion. Not restated here.
 * That module has no design stub; its full source is fenced in the contract.
 *
 * THE ONE RULE THAT IS THIS FILE'S: trustedClientIp NEVER honours X-Shortkit-Client-IP,
 * with or without a matching X-Shortkit-Proxy-Auth. The redirect path is reached by custom
 * domains that CNAME straight to the API's origin and never traverse the BFF, so a
 * forwarded address there is one the visitor chose. DO NOT MERGE THIS WITH
 * resolveRateLimitPrincipal (F-031). They share the read and nothing else.
 *
 * ACCEPTED COST: where no header is declared, every visitor hashes the sentinel and
 * therefore to one ip_hash per tenant, so unique-visitor counts in that environment are
 * meaningless. No environment declares one today; production refuses to boot without one.
 */
export function trustedClientIp(_headers: Headers): string {
  throw new Error('not implemented');
}

export const UNKNOWN_IP_SENTINEL = 'unknown';

/** F-013. Applied at ENQUEUE, not in the flusher: truncating late leaves the full string buffered. */
export function truncateUserAgent(_ua: string | null): string | null {
  throw new Error('not implemented');
}
