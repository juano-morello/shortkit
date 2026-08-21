/**
 * Contract: docs/contracts/click-events.md. THIS FILE IS ITS NORMATIVE FORM as of this
 *           commit (the contract's "Normative form" line is amended to point here, and the
 *           design stub it named is retired under ADR-0039)
 * ADR: adr-0010-click-event-write-path.md, adr-0019 (tenant-scoped enumeration),
 *      adr-0039-stub-retirement.md
 * Produced by: TASK-2-09 (item 2, wave 4).
 *
 * ============================================================================
 * THE TWO, AND ONLY TWO, TENANT-FACING SURFACES ON `click_events` (AC-2-39, AC-60).
 * ============================================================================
 *
 * `ClickEventWriter` appends. `ClickEventReader` reads. NEITHER INTERFACE DECLARES AN UPDATE
 * OR A DELETE, and that absence is the append-only enforcement: `click-events.md` says so in
 * as many words, because a row-level immutability trigger would block
 * `privilegedTenantEraser`, the single non-tenant-facing mutation surface (Amendment A-2).
 * The enumeration test in `test/clicks/clicks-route.int-spec.ts` asserts the method sets are
 * exactly `append` and `query`, so a later `markBot()` or `redact()` is a red test rather
 * than a quiet widening.
 *
 * ============================================================================
 * TWO AMENDMENTS TO THE CONTRACT'S "Interfaces" BLOCK, BOTH RECORDED IN `click-events.md`.
 * ============================================================================
 *
 * 1. `ClickEventBuffer.enqueue` takes the REDIRECT'S input, the header bag, and not the
 *    already-hashed `ClickEventInput` the contract's block sketches. D-2-10 and
 *    `redirect/ports/click-sink.port.ts` fixed that direction after the contract was
 *    written: the trusted read and the HMAC belong on this side, where `CLICK_IP_HASH_KEY`
 *    lives, so that the redirect module never names an address (GC-R). `ClickEventInput` is
 *    what `enqueue` PRODUCES.
 * 2. `ClickEventWriter.append` takes a BATCH. The contract's own buffering table requires
 *    "one multi-row INSERT, grouped by `tenantId`", which a one-row `append` cannot express;
 *    the singular signature predates the flusher.
 */
import type { ClickEvent, Paginated } from '@shortkit/contracts';

import type { RedirectClickInput } from '../redirect/ports/click-sink.port';

/**
 * One click, as the flusher writes it. Every field is derived, none is transported: `ipHash`
 * is an HMAC (`ip-hash.ts`), `userAgent` is already truncated, and the raw address the hash
 * came from exists in no field here; GC-R's "transiently in the read's return value and
 * nowhere else" is a statement about this shape.
 */
export interface ClickEventInput {
  readonly linkId: string;
  readonly domainId: string;
  readonly tenantId: string;
  readonly occurredAt: Date;
  readonly ipHash: string;
  readonly userAgent: string | null;
}

/**
 * A buffered event: the input plus the id drawn at enqueue.
 *
 * `id` IS CLIENT-GENERATED AND THAT IS THE IDEMPOTENCE (ADR-0010). The column has no
 * database default, so a flush that failed and is retried re-sends the same ids and
 * `ON CONFLICT (id) DO NOTHING` writes nothing the first attempt already landed. UUID v7
 * also sorts by time, which gives the reader's `occurred_at DESC` ordering a tie-break that
 * agrees with it.
 */
export interface BufferedClickEvent extends ClickEventInput {
  readonly id: string;
}

/**
 * What the redirect calls, once per resolved redirect, before the response is written.
 *
 * `enqueue` IS SYNCHRONOUS, ALLOCATION-ONLY, RETURNS NO PROMISE AND CANNOT THROW
 * (`click-events.md`, "What the implementer must guarantee"; AC-2-35). A click that fails
 * must never turn a 302 into anything else, so the failure modes are a dropped event and a
 * counter, never a rejection the visitor's request could observe.
 */
export interface ClickEventBufferPort {
  enqueue(input: RedirectClickInput): void;
  /** The test hook and the SIGTERM drain. Flushes everything buffered. Never rejects. */
  flush(): Promise<void>;
  readonly size: number;
}

/** Append-only. One statement per tenant per flush, inside that tenant's transaction. */
export interface ClickEventWriter {
  append(events: readonly BufferedClickEvent[]): Promise<void>;
}

/**
 * The read the tenant-facing route answers from.
 *
 * `from` and `to` ARE REQUIRED `Date`s, as the contract types them: the route converts the
 * optional ISO bounds of `clickQueryContract` at the same boundary every other timestamp is
 * converted at, and chooses the defaults for an absent bound. `after` is the DECODED cursor
 * rather than the opaque string the contract sketches: decoding is where a malformed cursor
 * becomes a 400, and that belongs to the route, not to a repository.
 */
export interface ClickEventQuery {
  readonly linkId: string;
  readonly from: Date;
  readonly to: Date;
  readonly limit: number;
  readonly after: ClickCursor | null;
}

/** The keyset the read orders by: `(occurred_at DESC, id DESC)`, both columns, both ways. */
export interface ClickCursor {
  readonly occurredAt: Date;
  readonly id: string;
}

/**
 * `ipHash` IS NOT ON THE WIRE AND NEVER LEAVES THE DATABASE (D-2-19, GC-R). The reader's
 * `SELECT` names four columns and `ip_hash` is not among them, so the value does not enter
 * this process on the read path at all, a stronger placement than mapping it away later.
 */
export interface ClickEventReader {
  query(q: ClickEventQuery): Promise<Paginated<ClickEvent>>;
}
