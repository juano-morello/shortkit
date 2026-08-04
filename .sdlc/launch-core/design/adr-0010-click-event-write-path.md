---
id: ADR-0010
slug: launch-core
title: Buffer click events in memory and flush them in per-tenant batches after the response
status: accepted
supersedes: null
date: 2026-08-04
---

## Context

TASK-034 needs exactly one click event per resolved redirect, emitted without blocking
the 302 and without pushing the cache-hit path past GC-1's 25 ms ceiling. AC-59
requires a failed write to still return the correct 302 and to be logged.

The arithmetic decides most of this. The API runs on Fly and Postgres runs on Neon, so
a single round trip costs somewhere between 5 and 30 ms depending on region pairing.
A synchronous insert would consume the entire 25 ms budget on its own, before the
Redis lookup. Awaiting the write is not a slower option, it is an infeasible one.

At 500 RPS, one insert per redirect is 500 transactions per second against a Neon free
tier compute. That is the load-test rate SC-2 measures at, so an unbatched design also
makes the benchmark measure Neon's write throughput rather than the redirect path.

`click_events` carries `tenant_id` and RLS (TASK-033), so the write happens inside a
tenant transaction. ADR-0008 puts `tenantId` in the cached link record precisely so
this stays true without a lookup.

## Decision

**`ClickEventBuffer.enqueue(event)` is synchronous, allocation-only, and returns
void.** It appends to an array and returns. The handler calls it once, after the
destination is resolved and before writing the response. No promise is created on the
request path.

**Flush on whichever comes first: 100 buffered events or 1000 ms.** The flusher groups
the batch by `tenantId` and, per group, opens `withTenantTransaction(tenantId, ...)`
and issues one multi-row `INSERT`. Grouping is required because the transaction sets
one tenant id.

**Every event carries a UUID v7 `id` generated at enqueue time, and the insert is
`ON CONFLICT (id) DO NOTHING`.** A flush that fails is retried once; the conflict
clause makes that retry idempotent, so a partial failure cannot double-write. This is
what "no double-emission on retry" means concretely. UUID v7 also sorts by time, which
gives AC-57's ordering an index that matches the query.

**Capacity 10,000 events.** On overflow the oldest are dropped, a warning is logged
once per flush window, and `click_events_dropped_total` increments. Blocking the
redirect to protect the buffer would trade a visitor's 302 for an analytics row.

**`SIGTERM` drains the buffer** with a 5-second bound before the process exits. Fly
sends `SIGTERM` before stopping a machine, so a normal deploy loses nothing.

**`flush()` is exported for tests.** AC-56's test enqueues one redirect, awaits
`flush()`, then asserts exactly one row. Without the hook the test would sleep, and a
sleeping test at 1000 ms is a flaky test.

**The emission mode is recorded as `deferred-batch` in `docs/performance/redirect-baseline.md`,**
because TASK-036's baseline has to state which mode it measured.

## Alternatives considered

| Option | Pros | Cons | Why not |
|---|---|---|---|
| `await` the insert before responding | Strongest durability; exactly-once trivially; no buffer to reason about | One Neon round trip is 5 to 30 ms, so the cache-hit p99 exceeds 25 ms before the cache lookup is counted. It also makes visitor-facing latency depend on database health, which contradicts SC-7's posture | Infeasible against GC-1, not merely slower |
| Fire-and-forget promise per redirect, no buffer | Three lines; no capacity management; no flush timer | 500 concurrent inserts per second, each holding a pooled connection for a tenant transaction. The pool becomes the bottleneck and an unhandled rejection storm is the failure mode under load | Same durability as buffering with far worse behaviour under the load SC-2 measures |
| Push to a Redis stream, consume in-process | Survives process death; natural backpressure; replayable | Doubles Upstash commands on the hot path, which GC-3 prices directly, and adds a consumer with its own failure modes. Redis loss then loses click events, and SC-7 already commits to redirects surviving Redis loss | Buys durability against process death by taking on a dependency the path is designed to work without |
| Write to a local append-only file, ship it separately | Durable on the machine; no database load on the hot path | Fly machine filesystems are ephemeral, so a machine replacement loses the file. A shipper is a second process, which GC-7 forbids | The durability is illusory on this platform |
| Sample or aggregate at write time | Constant write volume regardless of traffic | AC-56 requires exactly one event per redirect. SC-6 is about the raw stream | Contradicts an approved AC |

## Consequences

### Positive

- The redirect handler's added cost for click emission is an object allocation and an
  array push, so GC-1 is unaffected and TASK-036 can measure the complete path
  honestly.
- One `INSERT` per tenant per second instead of 500 per second, which keeps the
  load test measuring the redirect path rather than Neon's write ceiling.
- The write stays inside `withTenantTransaction`, so click emission is not a GC-5
  exclusion and SC-1's exclusion count stays at two.
- Flush retry is idempotent by construction rather than by careful ordering.

### Negative / accepted cost

- **Up to 1000 ms or 100 events are lost if the process dies without `SIGTERM`.** An
  OOM kill, a hardware failure or a `SIGKILL` drops them. SC-6 requires the stream to
  be populated and queryable, not that every individual click is durable, so this is
  within the criterion as written. It is still a real gap and it belongs in the
  performance record, not only in this ADR.
- Under sustained overload the buffer drops events silently apart from a counter and a
  log line. A dashboard reading this stream later will show a dip with no marker in
  the data itself.
- Events appear in the database up to a second after the redirect. Any test asserting
  on the row has to call `flush()`, and any future real-time view has to tolerate the
  delay.
- The flusher is a second place that opens tenant transactions outside a request, so
  it needs its own error handling and its own structured-log context. A failure there
  is invisible to the visitor by design.

### Follow-ups this creates

- TASK-033 makes `click_events.id` a UUID primary key and adds the index supporting
  `(link_id, occurred_at)` for AC-57.
- TASK-034 owns the buffer, the flusher, the `SIGTERM` hook, the `flush()` test hook,
  and the `click_events_dropped_total` counter.
- TASK-036 records `deferred-batch` and the loss window in the baseline document.
- A durable ingestion path belongs to the analytics initiative that reads this stream,
  not here.
