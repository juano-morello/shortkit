---
id: ADR-0009
slug: launch-core
title: Evaluate the validity window on every read; bound the TTL as hygiene, not as correctness
status: accepted
supersedes: null
date: 2026-08-04
---

## Context

`refinement.md` names this open: how does an expired link leave the redirect cache,
when nothing writes at the moment it expires? The plan offers two candidates, bounding
the cache TTL by time-to-expiry or sweeping on read, and leaves the choice to Design.

AC-46 is the binding test. Setting an expiry in the past through the API must produce
a branded 404 more than 5 seconds later, and must still pass with the TTL configured
to one hour. Note what that case actually is: a write happened, so `onLinkMutated`
fires and invalidation alone would satisfy AC-46.

The case with no write is AC-44's steady state. A link created on Monday with an
expiry of Friday at 17:00 sits in the cache. At 17:00 nobody writes anything. AC-45
has the mirror problem at `activates_at`.

## Decision

**The cached record carries `ea` and `aa`, and every read evaluates
`isLinkActive(record, now)` before responding.** Cache hit or Postgres miss, the same
function decides. Inactive produces the branded 404 or the fallback 302, exactly as an
unknown slug does.

`isLinkActive` is TASK-027's single shared rule, and it is pure:

```ts
export function isLinkActive(w: { expiresAt: Date | null; activatesAt: Date | null }, now: Date): boolean {
  if (w.activatesAt !== null && now < w.activatesAt) return false;
  if (w.expiresAt   !== null && now >= w.expiresAt)  return false;
  return true;
}
```

Absence of both timestamps is active, which is AC-47. The comparison costs nanoseconds
against a 25 ms budget.

**The Redis TTL is additionally bounded:**

```
ttl = clamp(1, DEFAULT_TTL_S, min(DEFAULT_TTL_S, secondsUntil(expiresAt) ?? ∞,
                                                 secondsUntil(activatesAt) ?? ∞))
```

This is memory and cost hygiene. It keeps a record that can no longer serve a 302 from
occupying a key for another hour. It is not the correctness mechanism, and no test
depends on it.

**A cache hit on an inactive link does not fall through to Postgres.** The record is
present and complete; the answer is "not active". Falling through would let a
scheduled campaign's expiry turn into sustained database load at the moment it fires,
on every request for a link that just went cold.

**An expiry edit still invalidates.** TASK-031's subscriber deletes on any change to
`expires_at` or `activates_at`, which is what makes AC-46 pass in under 5 seconds
rather than depending on the bounded TTL. Both mechanisms cover it; invalidation is
the fast one.

**Clocks.** `now` comes from the API process, not from Redis and not from Postgres.
Fly machines run NTP. A skew of seconds shifts the boundary by seconds, which is
within what an operator setting an expiry to the minute expects.

## Alternatives considered

| Option | Pros | Cons | Why not |
|---|---|---|---|
| Bounded TTL alone, with no evaluation on read | Simplest hot path; the cache is always trustworthy | TTL granularity is one second and Redis expiry is lazy, so a link can serve a 302 after its expiry instant. It also makes correctness depend on the TTL, which SC-3's "would still pass at one hour" was written to forbid as a pattern | Correctness resting on cache eviction timing is exactly the anti-pattern the refinement calls out |
| Sweep on read: on a hit, check expiry, and if expired delete the key and query Postgres | Cache stays clean; the source of truth confirms | The Postgres query on expiry is pure waste, since the cached record already carries the answer. Under a burst of traffic to a link that just expired it converts cache hits into database queries at exactly the wrong moment | Adds load precisely when the link becomes worthless |
| A scheduled sweeper that deletes cache keys as links expire | Cache never holds an expired record | Needs a durable timer across restarts, a query for links expiring soon, and a cross-tenant read to find them, which would be a third GC-5 exclusion. All to avoid a comparison that costs nanoseconds | Enormous machinery for no measurable gain, and it costs an exclusion SC-1 counts |
| Redis keyspace expiry events driving a sweep | Redis does the timing | Upstash keyspace notifications are per-command cost and delivery is best-effort. Correctness would rest on an at-most-once notification | Weaker guarantee than the comparison it replaces |

## Consequences

### Positive

- Expiry is exact to the millisecond, on the hit path, with no I/O.
- No background job, no timer, no queue, and no additional GC-5 exclusion.
- AC-44, AC-45, AC-46 and AC-47 are all decided by one pure function that has a unit
  test per branch and is shared by the API and the redirect path, so they cannot
  diverge.
- The bounded TTL keeps dead records from accumulating, which matters under GC-3's
  per-byte billing.

### Negative / accepted cost

- Every cached record carries two extra fields, so every hit parses and compares them
  whether or not the link has a window. Most links have neither timestamp.
- The API process's clock is now load-bearing for a user-visible behaviour. A machine
  with badly skewed time serves expired links or refuses live ones, and nothing
  detects it.
- Two mechanisms cover the same property. Someone reading only the TTL bound may
  conclude expiry is TTL-driven and remove the read-time check as redundant. The
  comment in `isLinkActive`'s call site has to say which one is load-bearing.
- A link whose `activates_at` is a month away still gets cached on first request, with
  a TTL clamped to a minimum of 1 second, so a stream of requests to a not-yet-active
  link re-caches it constantly. Bounded by the negative-cache reasoning in ADR-0008
  and not worth extra machinery.

### Follow-ups this creates

- TASK-027 owns `isLinkActive` and the two columns, and adds `expiresAt`/`activatesAt`
  to `linkContract`.
- TASK-030 applies the TTL clamp in `redirectCache.set`.
- TASK-029 and TASK-030 call `isLinkActive` before responding on both the miss and hit
  paths.
- TASK-031 includes `expires_at` and `activates_at` in the fields that trigger
  invalidation.
