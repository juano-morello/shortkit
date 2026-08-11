# Contract: click event emission, buffering, and the append-only surface

- **Boundary:** the redirect hot path to the click store; the tenant-facing read surface; the privileged eraser.
- **Normative form:** `apps/api/src/clicks/click-event.types.ts`, not yet written. The design stub at `design/stubs/apps/api/src/clicks/click-event.types.ts` stands in until TASK-033 lands the file and is retired then (ADR-0039). It is a design-gate scaffold, not a normative form.
- **Produced by:** TASK-033 (schema, writer, reader), TASK-034 (buffer, emission).
- **Consumed by:** TASK-029/030 (redirect path), TASK-053 (export), TASK-054 (eraser), TASK-056 (enumeration).
- **ADRs:** ADR-0010, ADR-0019, ADR-0040. Amendment A-2 governs the append-only scoping.
- **Depends on:** `design/contracts/trusted-client-address.md`, normative for the declared trusted header, the shared read and the boot assertion. This contract does not restate those rules (F-320).

## Schema

```sql
CREATE TABLE click_events (
  id          uuid        PRIMARY KEY,               -- UUID v7, generated at enqueue
  tenant_id   uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  link_id     uuid        NOT NULL REFERENCES links(id)   ON DELETE CASCADE,
  domain_id   uuid        NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
  occurred_at timestamptz NOT NULL,
  ip_hash     text        NOT NULL,
  user_agent  varchar(512)
);
CREATE INDEX click_events_link_occurred_idx ON click_events (link_id, occurred_at DESC);
-- plus the full template from rls-policy-template.md
```

`id` is client-generated (UUID v7) rather than a database default. That is what makes
the flush retry idempotent via `ON CONFLICT (id) DO NOTHING`, and it sorts by time.

**No row-level immutability trigger.** TASK-033 says so explicitly: it would block
`privilegedTenantEraser`. Append-only is enforced by the absence of methods, not by the
database.

## Client IP: the declared trusted value only

Revised 2026-08-04 (F-009). The rule was "the leftmost `X-Forwarded-For` entry", which
is **fully attacker-controlled**. On the one path deliberately exempt from rate limiting
(AC-86), any anonymous visitor could choose their own `ip_hash` and write unlimited rows
attributing clicks to arbitrary visitors, into an append-only store read by a later
analytics initiative and exported to the tenant under GDPR.

**Revised again 2026-08-11 (F-320).** The replacement rule read `Fly-Client-IP` first and
fell back to the rightmost `X-Forwarded-For` entry past `TRUSTED_PROXY_HOPS`. ADR-0030
deleted the platform that set and stripped `Fly-Client-IP`, so both branches were
client-supplied: nothing strips the header, and an XFF list with no proxy in front is a
list the caller wrote. The sentence "`Fly-Client-IP` is set by the platform and cannot be
spoofed by a client" was the premise discharging F-009 for `ip_hash`, and it was false.

```ts
function trustedClientIp(headers: Headers): string {
  return readTrustedClientAddress(headers, process.env) ?? UNKNOWN_IP_SENTINEL;
}
```

**`design/contracts/trusted-client-address.md` is normative** for
`TRUSTED_CLIENT_IP_HEADER`, the read's four rules, the boot assertion and the signal. This
contract restates none of them. What belongs here:

- `trustedClientIp` **never** honours `X-Shortkit-Client-IP`, with or without a matching
  `X-Shortkit-Proxy-Auth`. The redirect path is reached by custom domains that CNAME
  straight to the API's origin and never traverse the BFF, so a forwarded address there is
  a value the visitor chose. This is why `resolveRateLimitPrincipal` and this function stay
  separate (F-031); they share the read and nothing else.
- **`X-Forwarded-For` is never read, at any position.** Not leftmost, not rightmost, not
  after a hop count. `TRUSTED_PROXY_HOPS` is deleted; its only correct value was ever `0`.
- On `null` the sentinel is hashed, so a row still exists and carries no attacker-chosen
  value.

**Accepted cost, stated (F-320).** Where no header is declared, every visitor in that
environment hashes to `UNKNOWN_IP_SENTINEL` and therefore to one `ip_hash` per tenant.
Unique-visitor counts derived from that data are meaningless. No environment declares a
header today, and a production boot is refused without one. This is strictly better than
the previous behaviour, where the visitor chose the hash, and it is still a real loss of
signal in the only environment that runs.

## `ip_hash`

```ts
ip_hash = base64url(
  hmacSha256(key = CLICK_IP_HASH_KEY, message = `${tenantId}:${trustedClientIp}`)
).slice(0, 22)
```

`CLICK_IP_HASH_KEY` is a 32-byte secret from the environment. HMAC, not a bare hash: a
bare SHA-256 of an IPv4 address is reversible by exhausting the 4-billion space in
seconds. **The raw IP appears nowhere in the row, in any log line, or in the export**
(GC-9, AC-58).

**The message is salted with `tenant_id`** (F-009), so the same visitor produces
different hashes for different tenants. Without it, two operators comparing exports
could confirm the same person clicked links in both agencies.

**Stated rather than solved:** the key is per-deployment, not per-tenant. An operator
who holds their own export and somehow obtains `CLICK_IP_HASH_KEY` can confirm-by-guess
whether a specific IP appears in their own data. Rotating the key breaks continuity of
`ip_hash` across the rotation, so there is no scheduled rotation; the key rotates only on
suspected compromise, and the discontinuity is recorded in the analytics initiative that
reads the stream.

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
| capacity | 10,000 events **or 4 MiB, whichever is reached first** |
| `user_agent` | **truncated to 512 characters at enqueue**, before buffering |
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
7. **`ip_hash` is derived from a value the client cannot set.** A visitor cannot choose
   their own hash, and cannot make one visitor's clicks appear as another's.
   **Qualified 2026-08-11 (F-320):** where no trusted header is declared, every visitor
   hashes the sentinel, so the invariant holds in the negative sense that still matters
   (no attacker-chosen value reaches the column) and the positive sense (distinct visitors
   produce distinct hashes) is lost. The two senses were conflated in one sentence, and
   only one of them ever depended on the platform.
8. **Buffer memory is bounded by bytes, not only by row count.** A 16 KiB `User-Agent`
   at a few hundred RPS previously reached roughly 160 MiB of live heap on the single
   machine that also serves every redirect; the OOM kill dropped the buffer and broke
   GC-8 for every concurrent visitor. Truncation caps a buffered event at well under
   1 KiB, and the 4 MiB budget caps the buffer regardless.

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
- **Truncate `user_agent` in `enqueue`, not in the flusher.** Truncating late leaves the
  full string in the buffer, which is the memory this cap exists to bound.
- A test sends `X-Forwarded-For: 203.0.113.7` with no declared trusted header and asserts
  the resulting `ip_hash` equals the hash of `UNKNOWN_IP_SENTINEL` and not the hash of
  `203.0.113.7`. A second run declares `TRUSTED_CLIENT_IP_HEADER=x-test-client-ip`, sends
  the same `X-Forwarded-For` and no `x-test-client-ip`, and asserts the same thing.
- A test sends `X-Shortkit-Client-IP: 203.0.113.7` **with a valid `X-Shortkit-Proxy-Auth`**
  and asserts the `ip_hash` is the sentinel's. That is the one assertion separating this
  resolver from the rate limiter's.
- A test sends a 16 KiB `User-Agent` and asserts the stored value is 512 characters.

## Versioning

Adding a column is additive; the reader's contract type grows. Removing `ip_hash` or
adding a raw IP column is forbidden by GC-9.
