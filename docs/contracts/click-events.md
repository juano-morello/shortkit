# Contract: click event emission, buffering, and the append-only surface

- **Boundary:** the redirect hot path to the click store; the tenant-facing read surface; the privileged eraser.
- **Normative form:** `apps/api/src/clicks/click-event.types.ts`, WRITTEN (TASK-2-09, item 2 wave 4). The design stub it stood in for is retired (ADR-0039); that file is the normative form now, and this contract is amended to match it where the two disagreed; see "Interfaces". `trustedClientIp` lives beside it in `apps/api/src/clicks/trusted-client-ip.ts`; `trusted-client-address.md`'s "two callers" table still names the older path.
- **Produced by:** TASK-2-02 (schema, policies, registration), TASK-2-09 (buffer, hashing, writer, reader, the read route, the boot assertion, the SIGTERM drain). The older numbering, TASK-033/034, is the same work under the pre-item-2 plan.
- **Consumed by:** TASK-2-06 (the port the redirect declares), TASK-2-07 (the cached record the input is built from), TASK-2-10 (isolation and log scans), TASK-2-11 (the emission mode in the baseline), item 4 (export, eraser).
- **ADRs:** ADR-0010, ADR-0019, ADR-0040. Amendment A-2 governs the append-only scoping.
- **Depends on:** `docs/contracts/trusted-client-address.md`, normative for the declared trusted header, the shared read and the boot assertion. This contract does not restate those rules (F-320).

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

### `link_id` and `domain_id` stay single-column keys, and this is the argument for it

Decided by TASK-2-09, 2026-08-19, answering the question ADR-0063 left open when it withdrew
the equivalent argument for `links`: "the card that builds the click write path owns the
decision to key it as a pair or to write down why it need not."

**The shape a pair would take, so the option is on the record rather than hand-waved.**
`(link_id, tenant_id) REFERENCES links (id, tenant_id)` needs no new column (a click row's
tenant IS its link's tenant, unlike `links.domain_id`, whose target is the platform tenant's
row), but it does need `UNIQUE (id, tenant_id)` on `links`, which migration `0005` does not
create. `domain_id` would need the full `links` treatment: a `domain_tenant_id` column, a
composite key into `domains (id, tenant_id)`, and a check narrowing the pair to the row's own
tenant or the platform default.

**Why the argument that failed for `links` is not the argument here.** The withdrawn one was
"nothing can construct such a row", a statement about the application, and the database is
what a schema is supposed to rely on. It failed because a mis-keyed `links` row is *readable
and serving*: the redirect's own two permitted queries served tenant A's destination under
tenant B's hostname, and `links_domain_id_slug_unique` is an index, so A could take a slug on
B's domain and hold it forever. Neither consequence has a counterpart on this table, and both
absences are properties of the schema and the policies rather than of the code:

- **No cross-tenant read path touches it.** `app.redirect_context` is `FOR SELECT` on
  `domains` and `links` only (ADR-0003's approved set); `click_events` carries the template
  and nothing else, so every read is filtered by `tenant_id`. A row whose `tenant_id` is A and
  whose `link_id` is B's is invisible to B (the policy) and unreachable by A (the route
  resolves `:linkId` through `LinkRepository` first and answers 404 for a link A does not
  own). It is a row nobody can read.
- **No index spans tenants.** There is no unique constraint at all beyond the primary key on
  a UUID v7 the writer draws, so there is no namespace to squat and no contention to create.
- **`tenant_id` itself cannot lie.** Every insert runs inside `withTenantTransaction` under
  `click_events_tenant_isolation`'s `WITH CHECK`, so the owner column is the database's answer
  and not the writer's claim. What a pair would add is agreement between that column and the
  link's, not the column's own truthfulness.

So the worst a mis-keyed row can do is be counted in the writing tenant's own data. That is a
data-quality defect, not an isolation one, and it is the whole of the residual.

**The residual, stated.** Item 4's export reads by `tenant_id`; a row of this kind would carry
a `link_id` into the exporting tenant's file that belongs to another tenant's link. The value
is a random uuid the exporting tenant's own process wrote, so it discloses nothing that tenant
did not already hold, but an export is where "a row nobody can read" stops being true, and
that is why the conditions below are written as conditions that reopen this and not as a
footnote.

**What reopens this, and any one of them is enough.** A writer of `click_events` that takes a
caller-supplied `link_id` (an import, a backfill, a replay); item 3's first tenant-owned
domain reaching `active`, which is when `domain_id` starts naming more than one row and the
`links` argument transfers wholesale; item 4's export or an analytics reader that joins these
rows across tenants; or any policy widening that lets a second context flag read this table.
The pair form above is the answer in each case, and it is a migration, not a redesign.

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
// apps/api/src/clicks/trusted-client-ip.ts. `env` is a parameter with a default rather than
// a read in the body, so a spec can drive the declared-header cases without mutating the
// process; shipped code calls it as `trustedClientIp(headers)`.
export const UNKNOWN_IP_SENTINEL = 'unknown-client-address';

export function trustedClientIp(headers: TrustedAddressHeaders, env = process.env): string {
  return readTrustedClientAddress(headers, env) ?? UNKNOWN_IP_SENTINEL;
}
```

The sentinel is deliberately not an address: `readTrustedClientAddress` returns only values
`isIP()` accepts, so no visitor can ever hash to the same message as an unresolved one.

**`docs/contracts/trusted-client-address.md` is normative** for
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

The normative form is `apps/api/src/clicks/click-event.types.ts`. Two shapes changed when it
was written, both recorded here rather than left as a drift:

1. **`enqueue` takes the redirect's input, which is the HEADER BAG, not an already-hashed
   `ClickEventInput`.** D-2-10 and `apps/api/src/redirect/ports/click-sink.port.ts` settled
   that direction after this contract was drafted: the trusted read and the HMAC belong on
   the clicks side, where `CLICK_IP_HASH_KEY` lives, so the redirect module never names an
   address (GC-R). `ClickEventInput` is what `enqueue` *produces*.
2. **`ClickEventWriter.append` takes a BATCH.** The buffering table below requires "one
   multi-row `INSERT`, grouped by `tenantId`", which a one-row `append` cannot express. The
   singular signature predates the flusher.

```ts
/** What the redirect hands over (`redirect/ports/click-sink.port.ts`). */
export interface RedirectClickInput {
  readonly linkId: string;
  readonly domainId: string;
  readonly tenantId: string;
  readonly occurredAt: Date;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
}

/** What `enqueue` derives from it, and what a row holds. */
export interface ClickEventInput {
  readonly linkId: string;
  readonly domainId: string;
  readonly tenantId: string;
  readonly occurredAt: Date;
  readonly ipHash: string;
  readonly userAgent: string | null;
}

/** Plus the UUID v7 drawn at enqueue, which is what makes the retry idempotent. */
export interface BufferedClickEvent extends ClickEventInput { readonly id: string; }

export interface ClickEventBufferPort {
  /** Synchronous, allocation-only. Never returns a promise. Never throws. */
  enqueue(input: RedirectClickInput): void;
  /** Test hook and SIGTERM drain. Flushes everything buffered. Never rejects. */
  flush(): Promise<void>;
  readonly size: number;
}

/** The two, and only two, tenant-facing surfaces on click_events (AC-60, AC-2-39). */
export interface ClickEventWriter { append(events: readonly BufferedClickEvent[]): Promise<void>; }
export interface ClickEventReader {
  query(q: {
    linkId: string;
    from: Date;
    to: Date;
    limit: number;
    after: { occurredAt: Date; id: string } | null;
  }): Promise<Paginated<ClickEvent>>;
}
```

Neither interface exposes an update or a delete. AC-60 / AC-2-39 enumerate them and assert
it, over the method sets of the shipped classes rather than over these declarations.

`after` is the DECODED cursor rather than the opaque string: decoding is where a cursor this
endpoint did not issue becomes a 400, and that decision belongs to the route. `from` and `to`
stay required `Date`s, so the route converts the optional ISO bounds of `clickQueryContract`
at the boundary every other timestamp is converted at; an absent `from` defaults to the epoch
and an absent `to` to the moment of the request.

**The writer runs inside a transaction the FLUSHER opened**, and uses the ambient `tenantDb()`
like every other repository. That split is what lets the isolation harness call `append`
inside tenant A's transaction with tenant B's rows and get the POLICY's refusal; a writer that
opened its own `withTenantTransaction` would answer with an application error instead, which
proves less.

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

**The emission mode is `deferred-batch`**, and that is the string
`docs/performance/redirect-baseline.md` records (TASK-2-11): the redirect's added cost is an
object allocation, one HMAC over a short message and an array push, and the write happens on
a timer off the request path. The loss window the baseline states beside it is the one under
"Accepted gap": up to 1000 ms or 100 events on a process that dies without `SIGTERM`, and
nothing on an ordinary restart, because `main.ts` drains on the signal.

**As shipped** (`apps/api/src/clicks/click-event-buffer.ts`): the 100-event trigger is taken
on the next turn of the event loop (`setImmediate`), never inside `enqueue`, because
`void this.flush()` there would create a promise on the visitor's path, the one thing
ADR-0010 forbids by name; both timers are `unref()`ed, so a buffered event never holds the
process open; the byte budget is charged per event as a fixed base of 384 bytes plus the
agent's length, an estimate chosen to leave BOTH bounds reachable (a more generous one makes
the 10,000-row cap unreachable and turns a documented bound into dead code); and the drop
counter is the log `code` `click_events_dropped_total`, once per flush window, carrying no
field but `code` (GC-G).

A batch that fails twice is DROPPED, not re-buffered. A link deleted between the redirect and
the flush is a permanent 23503 for that batch, and re-buffering it would evict live events
behind a batch that can never land.

**One tenant's group is written in statements of at most 1000 rows, inside one transaction**
(added 2026-08-19, TASK-2-09, measured). The extended query protocol carries the parameter
count as an Int16, so 65,535 bind parameters is the wire ceiling and drizzle emits one per
column: seven for this table. Measured against Postgres 17: 9362 rows in one statement is
accepted, 9363 raises 08P01 (`bind message has N parameter formats but 0 parameters`), and
10,000 raises it too. The buffer's own cap is 10,000 rows and a visitor sending no
`User-Agent` is the cheapest row there is, so a single-tenant group legitimately reached a
size the wire refuses; the retry re-sent the identical rows and failed identically, so the
WHOLE group was dropped with one `click_flush_failed` line. That converted a slow database
into total loss exactly when the buffer was largest, on a surface deliberately exempt from
rate limiting (AC-2-19, AC-86).

The chunk is 1000 rows, which is 7000 parameters and 58,535 of headroom. **Anyone adding a
column to `click_events` moves the ceiling**: at eight columns it is 65,535 / 8 = 8191 rows
per statement, still far above the chunk, and the buffer spec asserts the two inequalities
that keep this true rather than leaving them as prose. The chunking is the FLUSHER's, so
`ClickEventWriter.append` stays "one multi-row INSERT" as the interface types it, and one
transaction still carries one tenant's whole group.

**A supplied timestamp is bounded before it becomes a query parameter.**
`z.string().datetime()` admits `0000-01-01T00:00:00.000Z` and `new Date()` admits an
extended year; neither is a `timestamptz`, and both raised 22008 from inside the reader's
query, which is a 500 on a value any viewer could send. The accepted window is
`[1970-01-01T00:00:00.000Z, 9999-12-31T23:59:59.999Z]` (`apps/api/src/clicks/click-instant.ts`),
applied at BOTH entry points, `from`/`to` and the decoded cursor, and anything outside it is
400 `validation_failed` keyed on the field that carried it.

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

   **The truncation is COPIED FLAT, and that is what makes the sentence above true**
   (added 2026-08-19, TASK-2-09, measured). V8 answers `slice` on a flat parent with a
   SlicedString: a pointer, an offset and a length, holding the whole parent alive for as
   long as the slice is reachable. A truncated agent therefore kept the 16 KiB header it
   came from, so a buffered event cost roughly twelve times what the byte budget accounted
   for, and the number an anonymous client got to choose. Measured with a forced collection:
   20,000 truncated agents out of 16 KiB parents retained 313.6 MiB as slices and 10.3 MiB
   as flat copies; over real HTTP the live heap at the accounted 4 MiB cap was 49 MiB.
   `enqueue` copies through a `utf16le` Buffer round trip, which is exact for lone
   surrogates where a `utf8` one would rewrite them, and costs 0.37 microseconds on a
   512-character value. The bound is not the F-013 failure returning (49 MiB is far from an
   OOM), and the invariant is now a statement about memory rather than about characters.

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
- A test sends a 16 KiB `User-Agent` and asserts the stored value is 512 characters. It is a
  BUFFER test, not an HTTP one: Node bounds the whole header block at 16 KiB, so a request
  carrying an agent that size is answered 431 and never reaches a handler. The over-the-wire
  test uses 4 KiB and asserts the same 512 in the column.
- **The binding is made globally visible, and a test asserts the INJECTION POINT rather than
  the container.** `RedirectController` injects `REDIRECT_CLICK_SINK` with `@Optional()`, and
  Nest resolves a provider from the consumer's module scope, so a token bound in
  `ClicksModule` and merely exported reaches nothing, because the redirect module may not
  import it (GC-N). Measured: every redirect answered 302, the controller held `null`, no
  click row was ever written, and `app.get(REDIRECT_CLICK_SINK, { strict: false })` resolved
  the buffer, because a non-strict `get` searches the whole container. `ClicksModule` is
  therefore `@Global()`, and the module-graph test reads what the controller received.
  **Item 3 inherits this for `REDIRECT_BRANDING_PORT`.**
- `CLICK_IP_HASH_KEY` is required at boot (D-2-17), which every process that boots the API in
  a test now depends on: CI's integration job sets it at the job level, and a suite that spawns
  the API passes it explicitly rather than relying on the runner's environment.

## Versioning

Adding a column is additive; the reader's contract type grows. Removing `ip_hash` or
adding a raw IP column is forbidden by GC-9.
