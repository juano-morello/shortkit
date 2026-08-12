---
id: ADR-0008
slug: foundation
title: Two cache namespaces, whole-record values, and negative entries with a 60-second life
status: accepted
supersedes: null
date: 2026-08-04
---

## Context

GC-1 gives the cache-hit path a 25 ms p99 ceiling at 500 RPS and AC-49 forbids a
Postgres query on a hit. Everything the handler needs to produce a 302, decide the
validity window, render a branded 404, and record a click event has to be in the
cached value, or the hit becomes a miss for one of those purposes.

TASK-046 warns that a scan of unknown slugs must not degrade the hot path. Without
negative caching, every unknown slug is a Postgres query, so a scanner turns free
requests into database load on the same instance serving real redirects.

GC-3 makes Upstash pay-as-you-go, billed per command and per byte stored, so the key
count and value size are cost, not just memory.

SC-3 requires the invalidation test to pass with the TTL configured to one hour, which
means correctness may not depend on TTL at all.

## Decision

**Two namespaces, both versioned in the key.**

```
hst:v1:{hostname}          -> host record or MISS      TTL 300 s
rdr:v1:{hostname}:{slug}   -> link record or MISS      TTL 3600 s
```

`hostname` is lowercased and IDNA-normalised through `new URL()` before keying. `slug`
is used verbatim; it is case-sensitive by ADR-0007.

Bumping `v1` to `v2` is how a value-shape change is deployed. Old keys expire on their
own and no migration runs.

**The host record.**

```
{ v:1, dm: domainId, t: tenantId, w: workspaceId, b: { lg, bc, fb } | null }
```

`b` is the branding triple (logo URL, brand colour, fallback URL) so a branded 404
needs no second lookup. This is what ADR-0011's port populates.

**The link record.**

```
{ v:1, id, d: destinationUrl, dm: domainId, w: workspaceId, t: tenantId,
  ea: expiresAtEpochMs | null, aa: activatesAtEpochMs | null }
```

`t` is present so the click writer can open a tenant transaction without a lookup,
which is what keeps click emission inside GC-5 rather than becoming a third exclusion.
`ea` and `aa` are present so the validity window is evaluated on the hit, which is
ADR-0009.

**Negative entries are the single byte `\x00`.** Stored under the same key as a real
value, so a lookup is one `GET` in every case. A miss at `rdr:` lives 60 seconds; a
miss at `hst:` lives 300 seconds. A `GET` returning `\x00` renders the branded 404
with no Postgres query.

The 60-second `rdr:` miss TTL bounds a scanner's footprint. At a sustained 500 misses
per second the store holds at most 30,000 negative keys of roughly 40 bytes, so 1.2 MB
and no unbounded growth.

**Default TTL is 3600 seconds in every environment, including tests.** SC-3 asks for a
test that would still pass at one hour, so the shipped value is one hour and the test
runs against the production configuration. There is no separate test TTL to drift.

**Writes invalidate, including creation.** The `onLinkMutated` subscriber (TASK-031)
deletes `rdr:v1:{hostname}:{slug}` on create, update and delete, and on a slug change
deletes both the old and new keys. Deleting on create is what removes a negative entry
so a new link is visible in under 5 seconds rather than in up to 60. Branding writes
(TASK-045) delete `hst:v1:{hostname}` for every hostname on the workspace.

**Failed invalidation retries, then gives up loudly.** Two retries at 200 ms and
1000 ms. Still failing, the subscriber logs `cache_invalidation_failed` at error level
with the key and increments a counter. GC-2's 5-second budget then depends on the
retries succeeding; if Redis is reachable but refusing writes, staleness can exceed
5 seconds and the log line is the only signal. Stated rather than papered over.

**Reads are bounded and fail open.** Every Redis call carries a 50 ms timeout and
`enableOfflineQueue: false` (ADR-0012). A timeout or error falls through to Postgres.

## Alternatives considered

| Option | Pros | Cons | Why not |
|---|---|---|---|
| Store only the destination URL under `rdr:` | Smallest value, lowest cost | Expiry, tenant id and branding all become second lookups, so AC-44 costs a Postgres query on a hit and click emission needs the tenant id it does not have. The hit stops being a hit | Defeats AC-49 for three of the four things the handler needs |
| No negative caching; every miss goes to Postgres | Zero junk keys; no invalidation-on-create requirement | A scan of unknown slugs turns into sustained Postgres load on the instance serving real traffic. TASK-046 names this specifically | The failure mode it creates is the one TASK-046 asks to prevent |
| Bloom filter per hostname of existing slugs | Constant memory regardless of scan volume; no per-miss key | Deletions cannot be removed from a plain Bloom filter, so a deleted slug keeps reporting "maybe present" and every request for it hits Postgres forever. Rebuilding per hostname needs a job and a full scan | More machinery and a worse steady state than a 60-second negative entry |
| One namespace keyed by link id, with a second key mapping `(hostname, slug)` to id | Edits touch one record; no duplicate data across keys | Two round trips per resolution on the path GC-1 constrains | Doubles the hot path's Redis commands to save write-side effort on a path with no latency budget |
| MessagePack or a packed binary value instead of JSON | Smaller payload, faster parse | `JSON.parse` on a 200-byte object costs well under 0.1 ms against a 25 ms budget, and a binary format makes `redis-cli GET` unreadable during an incident | Optimises the wrong number and costs debuggability |

## Consequences

### Positive

- A cache hit is one `GET` and produces a 302, a branded 404, or a fallback 302 with
  no further I/O.
- A scan of unknown slugs costs one `GET` each after the first and never reaches
  Postgres, so it competes for Redis commands rather than for database connections.
- The shipped TTL is the tested TTL, so SC-3's "would still pass at one hour" is
  satisfied by running at one hour rather than by reasoning about it.
- The `v1` key prefix makes a value-shape change a deploy rather than a migration.

### Negative / accepted cost

- The tenant id, workspace id and branding are duplicated across every cached record
  on a domain. A branding change requires deleting every `hst:` key for that
  workspace's hostnames, and TASK-045 has to know to do it. Forgetting leaves a stale
  logo on the 404 for up to 300 seconds.
- Negative caching means a link created outside the API, by a migration or by direct
  SQL, stays invisible for up to 60 seconds. Nothing in `launch-core` does that, and
  anything that does later has to delete the key.
- The retry-then-log invalidation policy leaves a real hole: Redis reachable but
  failing writes produces staleness past GC-2's budget with only a log line. Closing
  it would mean failing the operator's write, which is worse.
- Two namespaces mean two invalidation rules, and the branding one is easy to miss
  because it lives in a different TASK from the link one.

### Follow-ups this creates

- TASK-030 owns the key builders, the value codecs, the TTLs, and `dbQueryCounter`.
- TASK-031 owns the `onLinkMutated` subscriber, including delete-on-create, and
  records the measured worst-case propagation delay.
- TASK-045 deletes `hst:` keys on a branding write.
- TASK-046 reads branding from the host record rather than issuing a query.
- Contract: `design/contracts/redirect-cache.md`.
