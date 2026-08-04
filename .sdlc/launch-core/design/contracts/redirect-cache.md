# Contract: redirect cache keys, values, TTLs, and invalidation

- **Boundary:** Redis, between the redirect read path and every writer that can invalidate it.
- **Normative form:** `apps/api/src/cache/redirect-cache.ts` (stub: `design/stubs/apps/api/src/cache/redirect-cache.ts`).
- **Produced by:** TASK-030.
- **Consumed by:** TASK-027, 031, 032, 034, 045, 046, 051 (client reuse).
- **ADRs:** ADR-0008, ADR-0009, ADR-0012.

## Keys

```
hst:v1:{hostname}          host record or MISS sentinel   TTL 300 s
rdr:v1:{hostname}:{slug}   link record or MISS sentinel   TTL 3600 s (clamped, below)
rl:v1:{tenantId}:{window}  rate limiter (rate-limit.md)
revoked:jti:{jti}          JWT revocation (auth-tokens.md)
domain:work                ZSET, provisioning queue (domain-provisioning.md)
```

`{hostname}` is lowercased, IDNA-normalised, port-stripped. `{slug}` is verbatim and
case-sensitive. The `v1` segment is the value-schema version: a shape change bumps it
and old keys expire on their own.

## Values

Both records are JSON. Field names are short because they are stored per key and billed
per byte (GC-3).

```ts
export interface CachedHost {
  v: 1;
  dm: string;   // domainId
  t:  string;   // tenantId
  w:  string;   // workspaceId
  b:  { lg: string | null; bc: string | null; fb: string | null } | null; // branding
}

export interface CachedLink {
  v: 1;
  id: string;
  d:  string;          // destinationUrl
  dm: string;          // domainId
  w:  string;          // workspaceId
  t:  string;          // tenantId  <- lets the click writer open a tenant transaction (GC-5)
  ea: number | null;   // expiresAt   epoch ms
  aa: number | null;   // activatesAt epoch ms
}

export const MISS_SENTINEL = '\u0000';
```

A `GET` returning `MISS_SENTINEL` is a cached negative and produces the not-found path
with no Postgres query.

## TTLs

```ts
export const HOST_TTL_S = 300;
export const HOST_MISS_TTL_S = 300;
export const LINK_TTL_S = 3600;      // production value, used in tests too (SC-3)
export const LINK_MISS_TTL_S = 60;

export function linkTtlSeconds(link: CachedLink, now: number): number {
  const bounds = [LINK_TTL_S];
  if (link.ea !== null) bounds.push(Math.ceil((link.ea - now) / 1000));
  if (link.aa !== null && link.aa > now) bounds.push(Math.ceil((link.aa - now) / 1000));
  return Math.max(1, Math.min(...bounds));
}
```

`LINK_TTL_S` is 3600 in **every** environment. SC-3 requires a test that would pass
with the TTL at one hour, so the shipped value is one hour and there is no test-only
TTL to drift from production. The clamp is memory hygiene, **not** the correctness
mechanism for expiry; ADR-0009 puts that in `isLinkActive` on every read.

## Interface

```ts
export interface RedirectCache {
  getHost(hostname: string): Promise<CachedHost | 'miss' | 'unavailable'>;
  setHost(hostname: string, value: CachedHost | 'miss'): Promise<void>;
  delHost(hostname: string): Promise<void>;

  getLink(hostname: string, slug: string): Promise<CachedLink | 'miss' | 'unavailable'>;
  setLink(hostname: string, slug: string, value: CachedLink | 'miss'): Promise<void>;
  delLink(hostname: string, slug: string): Promise<void>;
}
```

`'unavailable'` is distinct from `'miss'`. `'miss'` is a cached negative and answers the
request. `'unavailable'` means Redis failed and the caller must query Postgres. Collapsing
the two would return a 404 during a Redis outage and break AC-52.

## Invalidation

Normative. Missing a row here produces stale redirects.

| Event | Keys deleted | Owner |
|---|---|---|
| link created | `rdr:v1:{host}:{slug}` (removes the negative entry; without this a new link is invisible for up to 60 s) | TASK-031 |
| destination changed | `rdr:v1:{host}:{slug}` | TASK-031 |
| slug changed | both old and new `rdr:` keys | TASK-031 |
| `expires_at` or `activates_at` changed | `rdr:v1:{host}:{slug}` | TASK-031 |
| link deleted | `rdr:v1:{host}:{slug}` | TASK-031 |
| branding changed | `hst:v1:{h}` for **every** hostname on the workspace | TASK-045 |
| domain deleted | `hst:v1:{hostname}` | TASK-040 |

Invalidation runs from the `onLinkMutated` subscriber (`link-mutation-events.md`), in
`afterCommit`, never inside the mutation transaction.

**On failure:** retry at 200 ms and 1000 ms. Still failing, log
`cache_invalidation_failed` at error with `{ key, linkId, attempts }` and increment
`cache_invalidation_failures_total`. Staleness can then exceed GC-2's 5 seconds; the
log line is the only signal. Recorded as an accepted gap in ADR-0008.

## Invariants a caller may rely on

1. A destination edit is visible on the redirect path within 5 seconds of commit
   (GC-2, AC-51), by deletion rather than by expiry, with the TTL at 3600 s.
2. `'unavailable'` never causes a 404. It causes a Postgres read (AC-52, AC-53).
3. Every read is bounded at 50 ms (ADR-0012).
4. A cache hit performs zero Postgres queries (AC-49), including for expiry evaluation,
   branding, and the tenant id needed for click emission.
5. Negative entries at `rdr:` live 60 s, so a scan of unknown slugs holds at most
   `missRate * 60` keys.

## What the implementer must guarantee

- `dbQueryCounter` increments on every Postgres query issued by the redirect path, and
  is readable by tests (AC-49, AC-54).
- `setLink` applies `linkTtlSeconds`. `setHost` uses the flat TTL.
- Values are written with `SET key value EX ttl`, one command.

## Versioning

Bump `v1` for any change to `CachedHost` or `CachedLink`. Deploying the bump is the
whole migration; old keys expire. Never reuse a version number.
