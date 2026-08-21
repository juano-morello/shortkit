/**
 * Contract: docs/contracts/click-events.md ("Interfaces", invariants 5 and 6),
 *           tenant-context.md, isolation-coverage.md, error-envelope.md (shared pagination)
 * ADR: adr-0010-click-event-write-path.md, adr-0002, adr-0003, adr-0020
 * Decision: D-2-12 (`GET /api/links/:linkId/clicks`, `occurred_at DESC`), D-2-19
 *           (`clickEventContract` carries no `ipHash`)
 * Produced by: TASK-2-09 (item 2, wave 4).
 * Consumed by: `clicks.service.ts`; TASK-2-10 (isolation subject).
 *
 * ============================================================================
 * `ip_hash` IS NOT IN THE `SELECT`, AND THAT IS WHERE GC-R IS ENFORCED ON THE READ PATH.
 * ============================================================================
 *
 * The column exists (it is what makes a visitor countable without being identifiable), and
 * it never leaves the database: not in a response, not in a log line, not in an error
 * (D-2-19). Naming four columns rather than selecting the row and mapping the field away is
 * the stronger placement: the value does not enter this process at all, so no later edit to
 * a mapper, a spread or a serialiser can carry it onto the wire.
 *
 * READ-ONLY, AND THAT IS THE APPEND-ONLY GUARANTEE (AC-2-39, AC-60). One method, `query`.
 * No update, no delete, and the enumeration test asserts the method set rather than trusting
 * a reading of this file.
 *
 * EVERY STATEMENT IS OWNER-QUALIFIED even though the policy already scopes it (F-302: an
 * owner-qualified read proves more than one relying on the policy alone), and it runs inside
 * the request's tenant transaction like every other repository here.
 */
import { Injectable } from '@nestjs/common';
import { and, desc, eq, gte, lte, sql } from 'drizzle-orm';
import type { ClickEvent, Paginated } from '@shortkit/contracts';

import { clickEvents } from '../db/schema';
import { TenantScopedRepository, currentTenantId, tenantDb } from '../tenancy/tenant-context';

import { encodeClickCursor } from './click-cursor';
import type { ClickEventQuery, ClickEventReader } from './click-event.types';

/** The same shape `assertUuid` accepts; a non-uuid names no link this tenant owns. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@TenantScopedRepository()
@Injectable()
export class ClickEventReaderRepository implements ClickEventReader {
  /**
   * One page of a link's clicks, newest first, bounded by `[from, to]` inclusive.
   *
   * ONE MORE ROW THAN ASKED FOR is read, which is how `hasMore` is known without a second
   * statement counting a table that only grows (D-2-03: no retention, no rollup).
   */
  async query(q: ClickEventQuery): Promise<Paginated<ClickEvent>> {
    if (!UUID.test(q.linkId)) {
      return { items: [], nextCursor: null, hasMore: false };
    }

    const owned = and(
      eq(clickEvents.tenantId, currentTenantId()),
      eq(clickEvents.linkId, q.linkId),
      gte(clickEvents.occurredAt, q.from),
      lte(clickEvents.occurredAt, q.to),
    );

    const rows = await tenantDb()
      .select({
        id: clickEvents.id,
        linkId: clickEvents.linkId,
        occurredAt: clickEvents.occurredAt,
        userAgent: clickEvents.userAgent,
      })
      .from(clickEvents)
      .where(
        q.after === null
          ? owned
          : and(
              owned,
              sql`(${clickEvents.occurredAt}, ${clickEvents.id}) < (${q.after.occurredAt.toISOString()}::timestamptz, ${q.after.id}::uuid)`,
            ),
      )
      .orderBy(desc(clickEvents.occurredAt), desc(clickEvents.id))
      .limit(q.limit + 1);

    const hasMore = rows.length > q.limit;
    const items = hasMore ? rows.slice(0, q.limit) : rows;
    const last = items[items.length - 1];

    return {
      items: items.map((row) => ({
        id: row.id,
        linkId: row.linkId,
        occurredAt: row.occurredAt.toISOString(),
        userAgent: row.userAgent,
      })),
      nextCursor:
        hasMore && last !== undefined
          ? encodeClickCursor({ occurredAt: last.occurredAt, id: last.id })
          : null,
      hasMore,
    };
  }
}
