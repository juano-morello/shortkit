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

/** CLICK_IP_HASH_KEY is 32 bytes from the environment. The raw IP is stored nowhere (GC-9, AC-58). */
export function hashClientIp(_ip: string): string {
  throw new Error('not implemented');
}

/** Leftmost X-Forwarded-For entry, trimmed. */
export function normaliseClientIp(_forwardedFor: string | undefined): string {
  throw new Error('not implemented');
}
