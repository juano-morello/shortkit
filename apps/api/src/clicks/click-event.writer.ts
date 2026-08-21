/**
 * Contract: docs/contracts/click-events.md ("Interfaces", "Buffering", invariants 4 and 6),
 *           tenant-context.md (invariant 4), isolation-coverage.md
 * ADR: adr-0010-click-event-write-path.md, adr-0002-tenant-context-binding.md,
 *      adr-0003-rls-policy-template-and-roles.md, adr-0020-isolation-suite-enumeration.md
 * Produced by: TASK-2-09 (item 2, wave 4).
 * Consumed by: `click-event-buffer.ts`'s flusher; TASK-2-10 (isolation subject).
 *
 * THE ONLY WRITE THIS REPOSITORY OFFERS IS AN APPEND (AC-2-39, AC-60). No update, no delete,
 * no upsert. `privilegedTenantEraser` is the single non-tenant-facing mutation surface on
 * this table (Amendment A-2), and it is item 4's; append-only here is enforced by the ABSENCE
 * OF METHODS, which the enumeration test asserts, and not by a trigger. A row-level
 * immutability trigger would block that eraser (`click-events.md` says so explicitly).
 *
 * `ON CONFLICT (id) DO NOTHING`, NEVER `DO UPDATE` (F-341, GC-Q). Two reasons, both
 * load-bearing: the ids are client-generated, so a retried batch re-sends them and the
 * conflict clause is what makes the retry idempotent (ADR-0010); and `DO UPDATE` reaches the
 * UPDATE policy's `USING` clause on conflict, a statement shape the isolation harness does
 * not build. A card reaching for an upsert on this table is a defect.
 *
 * IT OPENS NO TRANSACTION. The flusher opens one `withTenantTransaction` per tenant group
 * and calls this inside it, so this class uses the ambient `tenantDb()` like every other
 * repository, which is what lets the isolation harness call `append` inside tenant A's
 * transaction with tenant B's rows and receive the POLICY's refusal (`WITH CHECK` on
 * `click_events_tenant_isolation`) rather than an application error. There is deliberately
 * no application check that the rows' `tenantId` matches the flag: the database is the
 * check, and a repository that pre-empted it would prove less.
 */
import { Injectable } from '@nestjs/common';

import { clickEvents } from '../db/schema';
import { TenantScopedRepository, tenantDb } from '../tenancy/tenant-context';

import type { BufferedClickEvent, ClickEventWriter } from './click-event.types';

@TenantScopedRepository()
@Injectable()
export class ClickEventWriterRepository implements ClickEventWriter {
  /**
   * One multi-row INSERT for one tenant's group (`click-events.md`: "one multi-row `INSERT`,
   * grouped by `tenantId`, inside `withTenantTransaction`"). Owner-qualified columns only;
   * every value comes from the buffer, and `occurred_at` is when the redirect was DECIDED,
   * not when the batch reached Postgres, and the column carries no default for that reason.
   */
  async append(events: readonly BufferedClickEvent[]): Promise<void> {
    if (events.length === 0) {
      return;
    }

    await tenantDb()
      .insert(clickEvents)
      .values(
        events.map((event) => ({
          id: event.id,
          tenantId: event.tenantId,
          linkId: event.linkId,
          domainId: event.domainId,
          occurredAt: event.occurredAt,
          ipHash: event.ipHash,
          userAgent: event.userAgent,
        })),
      )
      .onConflictDoNothing({ target: clickEvents.id });
  }
}
