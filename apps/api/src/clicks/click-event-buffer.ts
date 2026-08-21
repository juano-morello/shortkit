/**
 * Contract: docs/contracts/click-events.md ("Buffering", "Invariants a caller may rely on"
 *           1, 2, 3, 4 and 8, "What the implementer must guarantee"),
 *           trusted-client-address.md (through `trusted-client-ip.ts`, never directly)
 * ADR: adr-0010-click-event-write-path.md (normative for every parameter below),
 *      adr-0011-branding-port.md (the inversion this is the other half of), adr-0028
 * Decision: D-2-10 (the redirect declares the port, this module binds it), D-2-03 (no
 *           retention and no rollup: this is the only writer, and it only appends)
 * Produced by: TASK-2-09 (item 2, wave 4).
 *
 * ============================================================================
 * THE VISITOR'S PATH ENDS AT `push`. EVERYTHING ELSE HAPPENS AFTER THE RESPONSE (GC-Q).
 * ============================================================================
 *
 * `enqueue` resolves the trusted address, hashes it, truncates the agent, draws a UUID v7
 * and appends to an array. No I/O, no promise, no throw, and the whole body sits inside one
 * guard, because the alternative to a caught failure here is a 302 that became something
 * else (AC-59). The redirect handler guards the call as well; two guards, because this one
 * belongs to the contract ("a guard-clause try around its body that increments a counter is
 * acceptable; anything that can reject is not") and that one belongs to the module that owes
 * the visitor a response.
 *
 * THE HASHING HAPPENS HERE AND NOT IN THE REDIRECT (GC-R, D-2-10). The port hands over the
 * request's HEADERS, so `CLICK_IP_HASH_KEY` and the raw address stay on this side: the
 * address exists in `trustedClientIp`'s return value, is consumed by one HMAC, and reaches
 * no field of the buffered event, no column, no log line and no error.
 *
 * TRUNCATION IS AT ENQUEUE AND NOT AT FLUSH, and `click-events.md` says so twice, because
 * truncating late leaves the full 16 KiB string in the buffer, which is the memory the cap
 * exists to bound (F-013: ~160 MiB of live heap on the machine that also serves every
 * redirect, and the OOM kill drops the buffer and breaks GC-8 for every concurrent visitor).
 *
 * ============================================================================
 * THE FLUSHER OPENS THE TRANSACTION; THE WRITER IS AN ORDINARY TENANT-SCOPED REPOSITORY.
 * ============================================================================
 *
 * One `withTenantTransaction` per tenant group, one multi-row INSERT inside it, because the
 * flag names ONE tenant. The split matters for more than tidiness: `ClickEventWriter` uses
 * the ambient `tenantDb()` like every other repository, so the isolation harness can call it
 * inside tenant A's transaction with tenant B's ids and get the POLICY's refusal (AC-2-40).
 * A writer that opened its own transaction would answer `TenantContextMismatchError`
 * instead, which proves the application checked rather than that the database did.
 *
 * CLICK EMISSION IS NOT A GC-5 EXCLUSION (`click-events.md` invariant 4, AC-2-35).
 * `tenantId` comes from the record the redirect already resolved, so the write needs no
 * lookup and `ISOLATION_EXCLUSIONS` stays at three.
 */
import { Inject, Injectable } from '@nestjs/common';
import { CLICK_USER_AGENT_MAX_LENGTH } from '@shortkit/contracts';

import { errorLogFields, logger } from '../observability/logger';
import type { RedirectClickInput, RedirectClickSink } from '../redirect/ports/click-sink.port';
import { withTenantTransaction } from '../tenancy/tenant-context';

import { CLICK_IP_HASH_KEY, clickIpHash } from './ip-hash';
import type { BufferedClickEvent, ClickEventBufferPort, ClickEventWriter } from './click-event.types';
import { ClickEventWriterRepository } from './click-event.writer';
import { trustedClientIp } from './trusted-client-ip';
import { uuidV7 } from './uuid-v7';

/** ADR-0010: "flush on whichever comes first: 100 buffered events or 1000 ms". */
export const CLICK_FLUSH_EVENT_TRIGGER = 100;
export const CLICK_FLUSH_INTERVAL_MS = 1000;

/** ADR-0010: "capacity 10,000 events or 4 MiB, whichever comes first". */
export const CLICK_BUFFER_MAX_EVENTS = 10_000;
export const CLICK_BUFFER_MAX_BYTES = 4 * 1024 * 1024;

/**
 * What one buffered event costs before its agent, estimated rather than measured per event:
 * the point of the byte budget is a BOUND, and computing one from `JSON.stringify` on the
 * hot path would cost more than the memory it accounts for.
 *
 * The arithmetic: four 36-character uuid strings and a 22-character hash at V8's one-byte
 * string overhead (~56 and ~40 bytes) is ~264; a `Date` is ~32; the object holding seven
 * properties plus its slot in the array is ~88. Rounded up to 384.
 *
 * IT HAS TO LEAVE BOTH BOUNDS REACHABLE, which is what ADR-0010's "whichever comes first"
 * means and what a too-generous estimate quietly destroys: at 512 the byte budget admits
 * 8192 events, the 10,000-row cap becomes unreachable, and one of the two documented bounds
 * is dead code. At 384, ten thousand agentless events are 3.84 MiB (the ROW cap bites) and
 * ten thousand full-width ones are 14 MiB (the BYTE cap bites, at ~2900 events). The buffer
 * spec asserts both directions.
 */
export const CLICK_EVENT_BASE_BYTES = 384;

/**
 * ============================================================================
 * THE STATEMENT IS CHUNKED, BECAUSE THE BUFFER'S OWN CAP EXCEEDS WHAT ONE INSERT CAN CARRY.
 * ============================================================================
 *
 * The extended query protocol carries the parameter count as an Int16, so 65,535 bind
 * parameters is the wire ceiling, and drizzle emits one per column: seven for this table.
 * MEASURED against Postgres 17 through the shipped writer: 9362 rows in one statement is
 * accepted, 9363 raises 08P01, and 10,000 raises 08P01. The row cap above is 10,000, and a
 * visitor sending no `User-Agent` is the cheapest row there is, so a single-tenant group
 * legitimately reaches a size the wire refuses. The retry re-sends identical rows, so
 * attempt two failed identically and the WHOLE group was dropped: a slow database filling
 * the buffer produced total loss where partial loss was available, on a surface that is
 * deliberately exempt from rate limiting (AC-2-19, AC-86).
 *
 * A THOUSAND ROWS PER STATEMENT, and the cap stays where the contract put it. 7000
 * parameters leaves 58,535 of headroom, so the next column added to `click_events` moves
 * the ceiling to 65,535 / 8 = 8191 rows per statement and this chunk is still far below it.
 * The chunking lives in the FLUSHER: `ClickEventWriter.append` stays "one multi-row INSERT"
 * as the contract types it, and one transaction still carries one tenant's whole group.
 */
export const CLICK_ROW_BIND_PARAMETERS = 7;
export const POSTGRES_MAX_BIND_PARAMETERS = 65_535;
export const CLICK_INSERT_CHUNK_ROWS = 1000;

/** ADR-0010's counter. There is no metrics facility, so it is a log `code` (ADR-0053's substitution). */
export const CLICK_DROPPED_COUNTER = 'click_events_dropped_total';

/** ADR-0010: "`SIGTERM` drains the buffer with a 5-second bound before the process exits". */
export const CLICK_DRAIN_BUDGET_MS = 5000;

@Injectable()
export class ClickEventBuffer implements RedirectClickSink, ClickEventBufferPort {
  private readonly events: BufferedClickEvent[] = [];

  private bufferedBytes = 0;

  private droppedTotal = 0;

  /** Dropped since the last warn line, so the warning is once per window and not per event. */
  private droppedSinceWarn = 0;

  private window: NodeJS.Timeout | null = null;

  private immediate: NodeJS.Immediate | null = null;

  /** The chain that makes two concurrent `flush()` calls one drain after another. */
  private draining: Promise<void> = Promise.resolve();

  constructor(
    // `@Inject` on a class token: redundant for Nest, load-bearing for lint (the reason
    // `redirect.controller.ts` gives).
    @Inject(ClickEventWriterRepository) private readonly writer: ClickEventWriter,
    @Inject(CLICK_IP_HASH_KEY) private readonly key: Buffer,
  ) {}

  /** What `click-events.md`'s `ClickEventBuffer.size` names, and what the drain logs. */
  get size(): number {
    return this.events.length;
  }

  /**
   * The buffered events, for the one assertion that can only be made before a flush: that
   * `user_agent` was truncated AT ENQUEUE (`click-events.md`: truncating in the flusher
   * would leave the full string in exactly this array). A read of this object's own state,
   * with no way to mutate it.
   */
  get buffered(): readonly BufferedClickEvent[] {
    return this.events;
  }

  get bytes(): number {
    return this.bufferedBytes;
  }

  get dropped(): number {
    return this.droppedTotal;
  }

  /**
   * Called once per resolved redirect, before the response is written. Synchronous,
   * allocation-only, no promise, no throw.
   */
  enqueue(input: RedirectClickInput): void {
    try {
      const event: BufferedClickEvent = {
        id: uuidV7(),
        linkId: input.linkId,
        domainId: input.domainId,
        tenantId: input.tenantId,
        occurredAt: input.occurredAt,
        ipHash: clickIpHash(this.key, input.tenantId, trustedClientIp(input.headers)),
        userAgent: userAgentOf(input.headers),
      };

      this.events.push(event);
      this.bufferedBytes += sizeOf(event);
      this.evictWhileOverCapacity();

      if (this.events.length >= CLICK_FLUSH_EVENT_TRIGGER) {
        this.flushOnTheNextTurn();
      } else {
        this.openWindow();
      }
    } catch (error: unknown) {
      // The event is lost and the visitor is unaffected, which is the trade this whole
      // module is arranged around. `code` and the error fields only (GC-G).
      logger.warn(
        { code: 'click_enqueue_failed', ...errorLogFields(error, { includeMessage: false }) },
        'a click could not be buffered and was dropped; the redirect was served regardless',
      );
    }
  }

  /**
   * Flushes everything buffered. The test hook ADR-0010 requires (AC-2-33's test awaits this
   * and never sleeps) and the SIGTERM drain's entry point.
   *
   * NEVER REJECTS. A caller is a test, a timer or a shutdown, and none of them has anything
   * to do with a failed batch; the failure is logged where it happens.
   */
  flush(): Promise<void> {
    this.draining = this.draining.then(
      () => this.drain(),
      () => this.drain(),
    );

    return this.draining;
  }

  /**
   * One drain: take everything buffered, group it by tenant, and write each group inside its
   * own transaction. The buffer is emptied FIRST, so events arriving during the write land
   * in the next batch rather than in this one twice.
   */
  private async drain(): Promise<void> {
    if (this.events.length === 0) {
      return;
    }

    const batch = this.events.splice(0, this.events.length);
    this.bufferedBytes = 0;

    for (const [tenantId, events] of groupByTenant(batch)) {
      await this.writeGroup(tenantId, events);
    }
  }

  /**
   * One tenant, one transaction, statements of at most `CLICK_INSERT_CHUNK_ROWS` rows,
   * retried once. The retry re-sends the same ids and every statement is
   * `ON CONFLICT (id) DO NOTHING`, so a group that half-landed cannot double-write
   * (ADR-0010; never `DO UPDATE`, F-341), whether it half-landed inside a chunk or between
   * two of them.
   *
   * THE CHUNK IS NOT AN OPTIMISATION, it is what keeps a legal buffer sendable: see
   * `CLICK_INSERT_CHUNK_ROWS`. Every chunk is inside ONE transaction, so a group is still
   * all-or-nothing per attempt and the tenant flag is set once.
   *
   * A second failure drops the group. The alternative, putting it back in the buffer,
   * turns a link deleted between the redirect and the flush (a permanent 23503 on that
   * batch) into a batch that fails forever and evicts every live event behind it.
   */
  private async writeGroup(tenantId: string, events: readonly BufferedClickEvent[]): Promise<void> {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        await withTenantTransaction(tenantId, async () => {
          for (let start = 0; start < events.length; start += CLICK_INSERT_CHUNK_ROWS) {
            await this.writer.append(events.slice(start, start + CLICK_INSERT_CHUNK_ROWS));
          }
        });

        return;
      } catch (error: unknown) {
        if (attempt === 2) {
          logger.error(
            {
              code: 'click_flush_failed',
              attempts: attempt,
              ...errorLogFields(error, { includeMessage: false }),
            },
            `${String(events.length)} buffered click events could not be written and were dropped`,
          );
        }
      }
    }
  }

  /**
   * The 100-event trigger, taken on the NEXT turn of the loop rather than inside `enqueue`:
   * `void this.flush()` there would create a promise on the visitor's path, which is the one
   * thing ADR-0010 forbids by name. `unref()` so a buffered event never holds the process
   * open on its own.
   */
  private flushOnTheNextTurn(): void {
    if (this.immediate !== null) {
      return;
    }

    this.immediate = setImmediate(() => {
      this.immediate = null;
      void this.flush();
    });
    this.immediate.unref();
  }

  /** The 1000 ms trigger, opened by the first event of a window and closed by the flush. */
  private openWindow(): void {
    if (this.window !== null) {
      return;
    }

    this.window = setTimeout(() => {
      this.window = null;
      void this.flush();
    }, CLICK_FLUSH_INTERVAL_MS);
    this.window.unref();
  }

  /**
   * Drop-oldest on either bound (ADR-0010). Blocking the redirect to protect the buffer
   * would trade a visitor's 302 for an analytics row, and dropping the NEWEST would make the
   * stream stop at the moment of overload rather than thin out across it.
   */
  private evictWhileOverCapacity(): void {
    while (
      this.events.length > CLICK_BUFFER_MAX_EVENTS ||
      (this.bufferedBytes > CLICK_BUFFER_MAX_BYTES && this.events.length > 0)
    ) {
      const oldest = this.events.shift();

      if (oldest === undefined) {
        break;
      }

      this.bufferedBytes -= sizeOf(oldest);
      this.droppedTotal += 1;
      this.droppedSinceWarn += 1;
    }

    this.warnOncePerWindow();
  }

  /**
   * One line per flush window, carrying `code` and nothing else (GC-G: item 2 appends
   * `link_id` and `attempts` to `LOGGABLE_FIELDS`, and a count belongs in the message). The
   * count itself is in the text; the counter name is the `code`, which is how every other
   * counter in this repository is carried while there is no metrics facility.
   */
  private warnOncePerWindow(): void {
    if (this.droppedSinceWarn === 0 || this.warnedInThisWindow) {
      return;
    }

    this.warnedInThisWindow = true;
    const dropped = this.droppedSinceWarn;
    this.droppedSinceWarn = 0;

    logger.warn(
      { code: CLICK_DROPPED_COUNTER },
      `${String(dropped)} buffered click events were dropped: the buffer reached its capacity ` +
        `(${String(CLICK_BUFFER_MAX_EVENTS)} events or ${String(CLICK_BUFFER_MAX_BYTES)} bytes) ` +
        'and the oldest were evicted. Redirects were served throughout (ADR-0010).',
    );

    // Reset with the window, so sustained overload warns once a second rather than once.
    setTimeout(() => {
      this.warnedInThisWindow = false;
    }, CLICK_FLUSH_INTERVAL_MS).unref();
  }

  private warnedInThisWindow = false;
}

/**
 * `user-agent`, truncated at enqueue. `Object.hasOwn` rather than a bare index, so a header
 * bag carrying `__proto__` or `constructor` reads as absent instead of reaching the
 * prototype: the rule `readTrustedClientAddress` applies to its own lookup, applied here
 * for the same reason.
 *
 * A repeated header (Node presents an array) is `null` rather than a join: there is one
 * agent per request, and a client sending two is telling us nothing we should store.
 *
 * `slice` COUNTS UTF-16 CODE UNITS AND THE COLUMN COUNTS CHARACTERS, so 512 units is at most
 * 512 characters and the value can never be refused by `varchar(512)`. A split surrogate
 * pair leaves a lone surrogate, which the driver encodes as U+FFFD rather than failing.
 *
 * ============================================================================
 * AND THE SLICE IS COPIED FLAT, WHICH IS THE HALF THAT ACTUALLY BOUNDS THE MEMORY.
 * ============================================================================
 *
 * V8 answers `slice` on a flat parent with a SlicedString: a pointer, an offset and a
 * length, holding the WHOLE PARENT alive for as long as the slice is reachable (13
 * characters is the threshold below which it copies instead). So a truncated agent kept the
 * 16 KiB header string it came from, and invariant 8's "well under 1 KiB per buffered
 * event" was a number an anonymous client chose the wrong side of. MEASURED on this
 * repository's Node: 20,000 slices of 512 characters out of 16 KiB parents retained
 * 313.6 MiB, against 10.3 MiB for flat copies of the same values; over real HTTP the live
 * heap at the accounted 4 MiB cap was 49 MiB.
 *
 * The `utf16le` round trip through a Buffer is the copy: it produces a new sequential
 * string with no parent, it is exact for lone surrogates (a `utf8` round trip would rewrite
 * them as U+FFFD), and it costs 0.37 microseconds on a 512-character value, which is the
 * same order as the HMAC this function sits beside. It also makes `sizeOf` below EXACT
 * rather than optimistic, which is what the byte budget was always accounted as.
 */
export function userAgentOf(headers: RedirectClickInput['headers']): string | null {
  const value = Object.hasOwn(headers, 'user-agent') ? headers['user-agent'] : undefined;

  if (typeof value !== 'string' || value === '') {
    return null;
  }

  if (value.length <= CLICK_USER_AGENT_MAX_LENGTH) {
    // Nothing to truncate, so nothing is retained beyond the value itself. Node built this
    // string from the request's header block and it holds no parent.
    return value;
  }

  return Buffer.from(value.slice(0, CLICK_USER_AGENT_MAX_LENGTH), 'utf16le').toString('utf16le');
}

/** The bound the byte budget is computed against. See `CLICK_EVENT_BASE_BYTES`. */
function sizeOf(event: BufferedClickEvent): number {
  return CLICK_EVENT_BASE_BYTES + (event.userAgent === null ? 0 : event.userAgent.length * 2);
}

/**
 * Grouping is REQUIRED, not an optimisation: `withTenantTransaction` sets one
 * `app.tenant_id`, and a row for another tenant inside it is refused by the policy's
 * `WITH CHECK`, correctly, and after taking the whole batch down with it.
 */
function groupByTenant(
  batch: readonly BufferedClickEvent[],
): Map<string, BufferedClickEvent[]> {
  const groups = new Map<string, BufferedClickEvent[]>();

  for (const event of batch) {
    const group = groups.get(event.tenantId);

    if (group === undefined) {
      groups.set(event.tenantId, [event]);
    } else {
      group.push(event);
    }
  }

  return groups;
}
