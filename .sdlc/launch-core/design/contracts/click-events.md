# Contract: click event emission, buffering, and the append-only surface

- **Boundary:** the redirect hot path to the click store; the tenant-facing read surface; the privileged eraser.
- **Normative form:** `apps/api/src/clicks/click-event.types.ts` (stub: `design/stubs/apps/api/src/clicks/click-event.types.ts`).
- **Produced by:** TASK-033 (schema, writer, reader), TASK-034 (buffer, emission).
- **Consumed by:** TASK-029/030 (redirect path), TASK-053 (export), TASK-054 (eraser), TASK-056 (enumeration).
- **ADRs:** ADR-0010, ADR-0019. Amendment A-2 governs the append-only scoping.

## Schema

```sql
CREATE TABLE click_events (
  id          uuid        PRIMARY KEY,               -- UUID v7, generated at enqueue
  tenant_id   uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  link_id     uuid        NOT NULL REFERENCES links(id)   ON DELETE CASCADE,
  domain_id   uuid        NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
  occurred_at timestamptz NOT NULL,
  ip_hash     text        NOT NULL,
  user_agent  text
);
CREATE INDEX click_events_link_occurred_idx ON click_events (link_id, occurred_at DESC);
-- plus the full template from rls-policy-template.md
```

`id` is client-generated (UUID v7) rather than a database default. That is what makes
the flush retry idempotent via `ON CONFLICT (id) DO NOTHING`, and it sorts by time.

**No row-level immutability trigger.** TASK-033 says so explicitly: it would block
`privilegedTenantEraser`. Append-only is enforced by the absence of methods, not by the
database.

## `ip_hash`

```ts
ip_hash = base64url(hmacSha256(key = CLICK_IP_HASH_KEY, message = normalisedClientIp)).slice(0, 22)
```

`CLICK_IP_HASH_KEY` is a 32-byte secret from the environment. HMAC, not a bare hash: a
bare SHA-256 of an IPv4 address is reversible by exhausting the 4-billion space in
seconds. **The raw IP appears nowhere in the row, in any log line, or in the export**
(GC-9, AC-58). Normalisation takes the leftmost `X-Forwarded-For` entry, trimmed.

## Interfaces

```ts
export interface ClickEventInput {
  readonly linkId: string;
  readonly domainId: string;
  readonly tenantId: string;
  readonly occurredAt: Date;
  readonly ipHash: string;
  readonly userAgent: string | null;
}

export interface ClickEventBuffer {
  /** Synchronous, allocation-only. Never returns a promise. Never throws. */
  enqueue(input: ClickEventInput): void;
  /** Test hook and SIGTERM drain. Flushes everything buffered. */
  flush(): Promise<void>;
  readonly size: number;
}

/** The two, and only two, tenant-facing surfaces on click_events (AC-60). */
export interface ClickEventWriter { append(input: ClickEventInput): Promise<void>; }
export interface ClickEventReader {
  query(q: { linkId: string; from: Date; to: Date; limit?: number; cursor?: string }): Promise<Paginated<ClickEvent>>;
}
```

Neither interface exposes an update or a delete. AC-60 enumerates them and asserts it.

## Buffering (ADR-0010)

| Parameter | Value |
|---|---|
| flush trigger | 100 buffered events **or** 1000 ms, whichever first |
| capacity | 10,000 events |
| overflow | drop oldest, increment `click_events_dropped_total`, warn once per window |
| insert | one multi-row `INSERT`, grouped by `tenantId`, inside `withTenantTransaction` |
| conflict | `ON CONFLICT (id) DO NOTHING` |
| retry | once per batch; the conflict clause makes it idempotent |
| shutdown | `SIGTERM` drains with a 5 s bound |

## Invariants a caller may rely on

1. **Exactly one event per resolved redirect** (AC-56). `enqueue` is called from one
   place, once per `kind === 'redirect'` decision. Never on `fallback`, never on
   `not-found`, never on an inactive link.
2. A click-event failure never affects the visitor's response (AC-59). `enqueue` cannot
   throw, and the flush runs off the request path.
3. Emission adds no I/O to the redirect path, so GC-1 holds. `tenantId` comes from the
   cached link record (`redirect-cache.md`).
4. The write runs inside `withTenantTransaction`, under RLS. **Click emission is not a
   GC-5 exclusion.**
5. `query` returns events ordered consistently with `occurred_at` (AC-57).
6. No tenant-facing route or repository method updates or deletes a click event
   (AC-60). `privilegedTenantEraser` is the sole mutation surface and is excluded from
   that enumeration by AC-106.

## Accepted gap, stated

Events buffered in memory are lost if the process dies without `SIGTERM`: up to 1000 ms
or 100 events. SC-6 requires the stream to be populated and queryable, which this
satisfies. Recorded in `docs/performance/redirect-baseline.md` alongside the emission
mode.

## What the implementer must guarantee

- `enqueue` performs no I/O, creates no promise, and cannot throw. A guard-clause try
  around its body that increments a counter is acceptable; anything that can reject is
  not.
- The flusher groups by `tenantId` before opening a transaction. One transaction may
  carry rows for one tenant only.
- TASK-034 records `deferred-batch` as the emission mode for TASK-036's baseline.
- The AC-56 test awaits `flush()`. It does not sleep.

## Versioning

Adding a column is additive; the reader's contract type grows. Removing `ip_hash` or
adding a raw IP column is forbidden by GC-9.
