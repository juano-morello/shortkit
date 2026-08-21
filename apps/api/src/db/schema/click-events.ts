/**
 * Contract: docs/contracts/click-events.md (normative for this schema), trusted-client-address.md,
 *           rls-policy-template.md, tenant-scoped-tables.md, isolation-coverage.md
 * ADR: adr-0010-click-event-write-path.md, adr-0003-rls-policy-template-and-roles.md,
 *      adr-0004-schema-layout-and-migrations.md, adr-0019-tenant-scoped-table-enumeration.md,
 *      adr-0049-context-flags-are-never-cast-directly.md
 * Produced by: TASK-2-02
 *
 * ============================================================================
 * THREE OBLIGATIONS, ONE MIGRATION, ONE COMMIT (GC-A, F-239).
 * ============================================================================
 *
 * 1. `tenant_id` through `TENANT_ID_COLUMN_SQL` (`db/rls.ts`), character for character.
 * 2. `tenantScopedPolicies('click_events')` hand-appended to migration `0005`.
 * 3. `ClickEventsTableAccess` in `test/isolation/registrations.ts`.
 *
 * AND NO FOURTH: `click_events` takes the template and NOTHING ELSE. It gets no
 * `redirect_read` policy: the redirect READS `domains` and `links` and only ever WRITES
 * here, off the request path, and `app.redirect_context` is `FOR SELECT` on two tables by
 * ADR-0003's approved set. The flush runs inside `withTenantTransaction`, grouped by
 * tenant, under the ordinary isolation policy: CLICK EMISSION IS NOT A GC-5 EXCLUSION
 * (`click-events.md` invariant 4, AC-2-35), and `ISOLATION_EXCLUSIONS` stays at three.
 *
 * ============================================================================
 * `id` HAS NO DATABASE DEFAULT, AND THAT IS THE IDEMPOTENCE (ADR-0010)
 * ============================================================================
 *
 * `uuid PRIMARY KEY` with no `defaultRandom()`. The id is UUID v7, generated CLIENT-SIDE at
 * `enqueue`, which buys two things a `gen_random_uuid()` default would destroy: the flush's
 * single retry is idempotent through `ON CONFLICT (id) DO NOTHING` (a re-sent batch writes
 * nothing the first attempt already landed), and the ids sort by time.
 *
 * `DO NOTHING`, NEVER `DO UPDATE` (F-341, GC-Q). `ON CONFLICT DO UPDATE` reaches the UPDATE
 * policy's `USING` clause on conflict, a statement shape the isolation harness does not
 * build, so the conflict clause here is the one chosen precisely to stay clear of it, the
 * same reasoning D-12 applied to the invitation accept path. A card that reaches for an
 * upsert on this table is a defect.
 *
 * NO ROW-LEVEL IMMUTABILITY TRIGGER, and `click-events.md` says so explicitly: it would
 * block `privilegedTenantEraser`, the single non-tenant-facing mutation surface on this
 * table (Amendment A-2). Append-only is enforced by the ABSENCE OF METHODS on
 * `ClickEventWriter`/`ClickEventReader` and asserted by the AC-2-39 enumeration, not by the
 * database. There is no trigger anywhere in this schema and this table is not the place to
 * start.
 *
 * ============================================================================
 * `ip_hash` IS THE ONLY FORM A VISITOR ADDRESS TAKES, ANYWHERE (GC-R, GC-9)
 * ============================================================================
 *
 * `text NOT NULL`: base64url of `HMAC(CLICK_IP_HASH_KEY, "<tenantId>:<trustedClientIp>")`
 * truncated to 22 characters. HMAC and not a bare hash, because a bare SHA-256 of an IPv4
 * address is reversible by exhausting four billion inputs in seconds, and SALTED WITH `tenant_id`
 * (F-009), so the same visitor produces different hashes for different tenants and two
 * operators comparing exports cannot confirm the same person clicked in both.
 *
 * THERE IS NO RAW IP COLUMN AND ADDING ONE IS FORBIDDEN BY GC-9. The raw address exists
 * transiently in `trustedClientIp`'s return value and nowhere else: not in a row, not in a
 * log line, not in an error, not on the wire. `ip_hash` itself never leaves the database:
 * `clickEventContract` is `{ id, linkId, occurredAt, userAgent }` (D-2-19).
 *
 * `user_agent varchar(512)` NULLABLE, and the 512 is a real bound rather than a hint: it is
 * TRUNCATED AT ENQUEUE, before buffering (`click-events.md`, invariant 8). A 16 KiB
 * `User-Agent` at a few hundred RPS reached roughly 160 MiB of live heap on the single
 * machine that also serves every redirect, and the OOM kill dropped the buffer and broke
 * GC-8 for every concurrent visitor. Truncating in the FLUSHER instead would leave the full
 * string in the buffer, which is the memory the cap exists to bound.
 *
 * `occurred_at` CARRIES NO DEFAULT either: the buffer records when the redirect was decided,
 * not when the batch reached Postgres, and those differ by up to the flush interval.
 *
 * ============================================================================
 * NO RETENTION, NO ROLLUP, NO SWEEPER (D-2-03, ruled 2026-08-19)
 * ============================================================================
 *
 * Append-only raw stream, growing without bound, on the only database there is. A row is
 * ~150 B and 500 RPS sustained is ~5.4 GB/day, nothing local traffic approaches, and the
 * arithmetic is recorded in `docs/performance/redirect-baseline.md` (TASK-2-11) rather than
 * left for someone to rediscover. A time-based sweeper would need a privileged cross-tenant
 * delete path, i.e. a fourth exclusion; GDPR erasure is item 4's and reaches these rows
 * through the `tenants(id)` cascade. Deleting a LINK cascades its click rows away today,
 * and that is the accepted cost stated in STORY-2-01.
 *
 * `click_events_link_occurred_idx (link_id, occurred_at DESC)` is the contract's index and
 * serves `GET /api/links/:linkId/clicks` (ordered `occurred_at DESC`, D-2-12) as well as
 * the cascade from `links`. `click_events_domain_id_idx` is the 0004 debt sweep's rule met
 * at creation (ledger 1b-W1-11): `domain_id` leads nothing else here, so the cascade from
 * `domains` would sequentially scan the largest table in the schema.
 */
import { index, pgTable, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';

import { domains } from './domains';
import { links } from './links';
import { tenants } from './tenants';

export const clickEvents = pgTable(
  'click_events',
  {
    /** UUID v7, generated at `enqueue`. No `defaultRandom()`, see the docblock. */
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    linkId: uuid('link_id')
      .notNull()
      .references(() => links.id, { onDelete: 'cascade' }),
    domainId: uuid('domain_id')
      .notNull()
      .references(() => domains.id, { onDelete: 'cascade' }),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    ipHash: text('ip_hash').notNull(),
    userAgent: varchar('user_agent', { length: 512 }),
  },
  (table) => [
    index('click_events_link_occurred_idx').on(table.linkId, table.occurredAt.desc()),
    index('click_events_domain_id_idx').on(table.domainId),
  ],
);
