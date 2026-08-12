# Contract: redirect cache keys, values, TTLs, and invalidation

- **Boundary:** Redis, between the redirect read path and every writer that can invalidate it.
- **Normative form:** `apps/api/src/cache/redirect-cache.ts`, not yet written. The design stub at `design/stubs/apps/api/src/cache/redirect-cache.ts` stands in until TASK-030 lands the file and is retired then (ADR-0039). It is a design-gate scaffold, not a normative form.
- **Produced by:** TASK-030.
- **Consumed by:** TASK-027, 031, 032, 034, 045, 046, 051 (client reuse).
- **ADRs:** ADR-0008, ADR-0009, ADR-0012.

## Keys

**Every key begins `sk:{env}:`.** Added 2026-08-04 (F-015): GC-3 pushes toward one paid
Upstash instance, and the moment staging or a CI integration run shared it, a staging
`hst:v1:links.client.example` record carrying a staging `tenantId` and `domainId` would
be read by production and serve real visitors a redirect resolved against the wrong
tenant's data, or a MISS sentinel that 404s a live customer link for 300 seconds.
`domain:work` was a single ZSET shared across environments.

```
sk:{env}:hst:v1:{hostname}          host record or MISS sentinel   TTL 300 s
sk:{env}:rdr:v1:{hostname}:{slug}   link record or MISS sentinel   TTL 3600 s (clamped, below)
sk:{env}:rl:v1:{tenantId}:{window}  tenant write limiter (rate-limit.md)
sk:{env}:arl:v1:...                 pre-auth limiter (rate-limit.md)
sk:{env}:revoked:jti:{jti}          JWT revocation (auth-tokens.md)
sk:{env}:domain:work                ZSET, provisioning queue (domain-provisioning.md)
```

`{env}` comes from `REDIS_KEY_NAMESPACE`, which is **required**: the process refuses to
boot when it is unset rather than defaulting to something that might collide. Values in
use: `prod`, `staging`, `dev`, and `ci-{run_id}` so two concurrent CI jobs cannot
collide with each other either.

**CI and local development must not point at the production Upstash instance.** The
namespace bounds the damage if someone does; it does not make it safe. CI uses a
`redis:7-alpine` service container (ADR-0018) and local development uses Docker.

`{hostname}` is lowercased, IDNA-normalised, port-stripped, and is already stored in
that form (`domain-provisioning.md`), so the key and the row cannot disagree. `{slug}`
is verbatim and case-sensitive. The `v1` segment is the value-schema version: a shape
change bumps it and old keys expire on their own.

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
// A positive CachedHost is written ONLY for a domain in state 'active'.
// Any other state caches as MISS. See below.

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
| **domain leaves `active`** (state change, certificate revoked, hostname reassigned) | `hst:v1:{hostname}` | TASK-042 |

Invalidation runs from the `onLinkMutated` subscriber (`link-mutation-events.md`), in
`afterCommit`, never inside the mutation transaction.

## Only an `active` domain is cached

Moved here 2026-08-04. This rule was stated only in the `resolveHost` stub, and it
belongs in the contract.

**A positive `hst:` record is written only for a domain in state `active`
(`redirect-resolution.md`, F-003). Any other state caches as `MISS`.** Caching a
`pending_verification` domain would reopen F-003 through the cache: the `AND state =
'active'` predicate in the Postgres query would hold while the cache served an
unverified claim for up to 300 seconds.

The rule is enforceable in one place because **`resolveHost` is the only writer of
positive `hst:` records.** Nothing else may write one.

The state-change row above is the write-side half: a domain leaving `active` must drop
its host key rather than waiting out the 300-second TTL, or it keeps serving for up to
five minutes after its certificate is revoked or its hostname is reassigned.

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
6. **A cached host record always names a domain that was `active` when it was written**,
   and a domain leaving `active` drops its key rather than waiting out the TTL.

## What the implementer must guarantee

- `dbQueryCounter` increments on every Postgres query issued by the redirect path, and
  is readable by tests (AC-49, AC-54).
- `setLink` applies `linkTtlSeconds`. `setHost` uses the flat TTL.
- Values are written with `SET key value EX ttl`, one command.

## Versioning

Bump `v1` for any change to `CachedHost` or `CachedLink`. Deploying the bump is the
whole migration; old keys expire. Never reuse a version number.
