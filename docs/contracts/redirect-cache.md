# Contract: redirect cache keys, values, TTLs, and invalidation

- **Boundary:** Redis, between the redirect read path and every writer that can invalidate it.
- **Normative form:** `apps/api/src/cache/redirect-cache.ts`. Shipped 2026-08-19 by TASK-2-03 (item 2, wave 1), which is the card TASK-030 became; the design stub is retired with it (ADR-0039). The client and the boot binding live beside it in `apps/api/src/cache/redis-client.ts`, and the token consumers inject is `REDIRECT_CACHE`, bound in `apps/api/src/cache/cache.module.ts`.
- **Produced by:** TASK-030 (delivered as TASK-2-03).
- **Consumed by:** TASK-027, 031, 032, 034, 045, 046, 051 (client reuse); in item 2's numbering, TASK-2-06 and TASK-2-07 (the redirect read path; the read-through shipped 2026-08-19, see "The read-through" below) and TASK-2-08 (invalidation).
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

**Amended 2026-08-19 (TASK-2-03).** "Required" is required *when `REDIS_URL` is set*, and
the two refusals are separate: a `REDIS_URL` that is not a `redis://` or `rediss://` URL
refuses **unconditionally**, whatever else is declared (ADR-0040's shape, the one
`MAIL_TRANSPORT` follows), and `REDIS_KEY_NAMESPACE` is demanded only once a URL has been
declared. `REDIS_URL` unset is not a refusal at all — it binds `UnavailableRedirectCache`
and writes one warn line (D-2-09, below). The namespace may not contain a **colon or
whitespace**: it is the second key segment, so a colon in it redraws the key structure.
Neither refusal quotes any part of either value (ADR-0029 — a Redis URL carries a
password).

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

### Amended 2026-08-19 (TASK-2-03): what the three values cover, exactly

The interface above has three return values and four things can happen, so the shipped
mapping is written down rather than inferred.

**An ABSENT key returns `'unavailable'`.** `'miss'` is the SENTINEL and nothing else,
because `'miss'` answers the request with a 404 and zero Postgres queries — so a key that
was simply never written must not produce it, or an empty cache would 404 every link in
the database. Absence therefore joins the failures under the value whose contract is
already "the caller must query Postgres", which is the correct action for both.

The cost, stated: **`'unavailable'` is not on its own evidence of an outage.** A cold key
returns it too. Nothing may log a degradation line keyed on this value — that would be one
line per request on a cold cache. `cacheAvailable()` (status-based, no command) is the
health signal.

A value that does not decode — a bumped `v`, a truncated write, a key some other process
wrote — also returns `'unavailable'`. The alternatives are both worse: `'miss'` would 404
a live link, and a half-built record would 302 somewhere nobody chose.

**Reads never throw and writes never throw; DELETIONS DO.** `getHost`/`getLink` answer
`'unavailable'` on a rejection, a synchronous throw, a timeout or a disconnected client, and
`setHost`/`setLink` swallow the same failures — a cache fill that did not happen costs one
Postgres query on the next request, and the visitor's response is already decided (GC-O).
`delHost`/`delLink` **reject** when the deletion did not happen, because their caller is the
invalidation subscriber below, which owns the retry and the log line; swallowing there would
leave it nothing to retry and nothing to report, and staleness past GC-2 with no signal at
all. Deletions never run on the visitor's path. The rejection carries **no key, no hostname
and no slug** (GC-G).

`UnavailableRedirectCache` — the binding when `REDIS_URL` is unset — is the one exception to
that asymmetry: its deletions RESOLVE, because with no cache there is no stale key and the
invalidation has genuinely succeeded.

## Invalidation

Normative. Missing a row here produces stale redirects.

| Event | Keys deleted | Owner |
|---|---|---|
| link created | `rdr:v1:{host}:{slug}` (removes the negative entry; without this a new link is invisible for up to 60 s) | TASK-031 (delivered as TASK-2-08) |
| destination changed | `rdr:v1:{host}:{slug}` | TASK-031 (delivered as TASK-2-08) |
| slug changed | both old and new `rdr:` keys | TASK-031 (delivered as TASK-2-08) |
| `expires_at` or `activates_at` changed | `rdr:v1:{host}:{slug}` | TASK-031 (delivered as TASK-2-08) |
| link deleted | `rdr:v1:{host}:{slug}` | TASK-031 (delivered as TASK-2-08) |
| branding changed | `hst:v1:{h}` for **every** hostname on the workspace | TASK-045 |
| domain deleted | `hst:v1:{hostname}` | TASK-040 |
| **domain leaves `active`** (state change, certificate revoked, hostname reassigned) | `hst:v1:{hostname}` | TASK-042 |

Invalidation runs from the `onLinkMutated` subscriber (`link-mutation-events.md`), in
`afterCommit`, never inside the mutation transaction.

**The five `rdr:` rows are shipped by `apps/api/src/links/cache-invalidation.subscriber.ts`,
2026-08-19 (TASK-2-08).** It is registered by `LinksModule` under the name `cacheInvalidator`
and holds the injected `REDIRECT_CACHE`, so the binding it deletes through is whichever one
boot chose. **Registration is once per PROCESS, not once per Nest application context.** A
production process builds one context and an integration suite may build several
(`test/invitations/invitations-mail.int-spec.ts` builds two to compare mail transports); the
registry admits one subscriber per name and refuses the second, so the first context registers
and each later one hands the registration its own cache. That keeps one deletion per key,
which is the property the registry's refusal exists to protect.

The key set it computes is the **deduplicated union of the two snapshot images'
`(hostname, slug)` pairs**, which is the table above with no per-action branching: `created`
has no before image, `deleted` has no after image, and an `updated` produces one key or two
according to whether the pair moved. A **no-op PATCH still deletes its key**: the audit
writer is the subscriber that skips one, and this one does not.

### Invalidation ships before the read-through fill, and the order is not an accident

Stated 2026-08-19 (TASK-2-08), because nothing recorded it and the waves alone do not carry
an invariant. The subscriber lands in wave 3; `resolveLink`'s read-through fill (TASK-2-07)
lands in wave 4. **A positive `rdr:` record may not exist before the thing that deletes it
does.** With `LINK_TTL_S` at 3600 in every environment, a cache filled first would serve a
pre-edit record for up to an hour on every edit made in the interval, and invariant 1 would be
false for a whole wave with the suite green. The intermediate state this order produces is the
harmless one: an invalidator with nothing yet to invalidate deletes keys that are not there,
which Redis answers `0` to and this subscriber treats as success. A deletion rejects only
when it did not HAPPEN, never because the key was already gone.

The same ordering rule applies to any later cache: the writer that deletes a namespace's keys
ships no later than the reader that fills them.

### The read-through, shipped 2026-08-19 (TASK-2-07)

`apps/api/src/redirect/redirect.service.ts` is the only reader. Steps 2 and 3 of
`redirect-resolution.md` each consult their key first and fall through to Postgres on
`'unavailable'`; the write-back is `setHost` (the record for a domain that resolved, the
sentinel for one that did not) and `setLink` (the record, or the sentinel for a slug that
matched nothing). Nothing else writes a positive `hst:` record, and no key is written at
`rdr:` for a hostname that resolved to nothing, since the host key answers the next request
before the link key is read.

**Both keys are read before either Postgres read is chosen**, and that is what makes the
per-state cost the following rather than something larger. Measured in STATEMENTS by
`dbQueryCounter` (`test/redirect/redirect-cache.int-spec.ts`), which counts the two-statement
preamble as well:

| Cache state | Statements | Read issued |
|---|---|---|
| both records | **0** | none: invariant 4, expiry and the click ids included |
| host record, link sentinel | 0 | none |
| host sentinel | 0 | none, and the link key is not read at all |
| host record, link cold | 3 | `resolveLinkOnDomain`, on the CACHED domain id |
| host cold, link sentinel | 3 | `resolveHost` |
| host cold, link record | 3 | `resolveHostKeepingLinkOn`: statement 2 is skipped while the record names the domain that resolved |
| host cold, link record naming another domain | 4 | the same call, both statements, ONE transaction |
| both cold | **4** | one `resolveByHostAndSlug`, the cold resolve's own cost, unchanged |
| Redis unavailable | 4 every request | as above; write-backs are no-ops until it returns |

Every branch opens **at most one transaction**. That is the same rule as reading both keys
first: a validation that resolved the host and then read the link through a second call would
pay the two-statement preamble twice.

A cached link record is served only when its `dm` is the domain the host resolved to, so a
hostname that changed hands cannot serve the previous owner's link out of a surviving key.
A record whose `ea` or `aa` could not be read is not cached at all: it would fail this
module's own decoder and hold a key that reads `'unavailable'` for an hour.

`CachedHost.b` is the branding ANSWER on a hit, not a hint (ADR-0011's "on a cache miss
only"), so a cache hit renders its 404 from `b` and never asks `REDIRECT_BRANDING_PORT`. The
card that binds the port owes the other half: `resolveHost` must fill the branding before the
record is written, or a branded host caches as unbranded for the host TTL.

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
`cache_invalidation_failed` at error and increment `cache_invalidation_failures_total`.
Staleness can then exceed GC-2's 5 seconds; the log line is the only signal. Recorded as an
accepted gap in ADR-0008.

**Amended 2026-08-19 (D-2-15, TASK-2-03).** The line carries `code:
'cache_invalidation_failed'`, `link_id` and `attempts` — **not the key**, not the hostname,
not the slug. The key embeds the slug, and GC-G's posture is that an identifier
reconstructible from an id stays off the line; `LOGGABLE_FIELDS` gains `link_id` and
`attempts` and nothing else (TASK-2-08 owns that edit). `cache_invalidation_failures_total`
stays a `code` occurrence on that line: no metrics facility exists in `apps/api/src`, the
same substitution ADR-0053 records for `auth_revocation_degraded_total`.

**Shipped 2026-08-19 (TASK-2-08), with three details the sentence above leaves open.**
`attempts` is the number of deletion rounds made, so a line that reports the exhausted
schedule reports `attempts: 3` (the first try, then 200 ms, then 1000 ms). The line is written
**once per mutation**, not once per key: two lines carrying one link id and no key would be
indistinguishable from each other. And a round retries **only the keys that failed**, so a
slug change whose new key was deleted on the first attempt does not delete it again. The
subscriber then RETHROWS, which is how `runAfterCommitSubscribers` comes to add its own
`link_mutation_subscriber_failed` line (with no error message on it) and to run the
subscribers registered after this one; the operator's write is already committed and already
answered, and `LOGGABLE_FIELDS` names `link_id` and `attempts` as of the same commit.

### The stale set race, and the delayed second deletion (2026-08-19, TASK-2-07 review)

**The race.** A redirect request that read the pre-edit row from Postgres, before the editor's
commit, can write that record into Redis **after** the deletion above has run. Nothing on the
read path corrects it, so the pre-edit or pre-deletion record then serves with a fresh TTL:
up to `LINK_TTL_S` for a link with no window, on the surface that is never rate limited, and
invisible to the operator who made the edit. Someone who wants a takedown to keep serving can
raise the odds by flooding requests at the moment of the edit.

**The mitigation.** The subscriber deletes the same key set a second time,
`INVALIDATION_SECOND_PASS_DELAY_MS` (1000 ms) after a deletion that succeeded, unconditionally
rather than only on failure. It is scheduled and not awaited, so the mutation the operator is
waiting on is not extended, and its timer is `unref`ed. A second-pass failure writes one line
in the same shape (`code: 'cache_invalidation_failed'`, `link_id`, `attempts: 1`) and stops.
Nothing is scheduled when the first pass exhausted its retries: that path has already
reported. The read path pays nothing for any of this, which is why the mitigation is here and
not in front of the fill.

**The residual, which this does NOT close.** A fill that lands after the SECOND deletion still
wins, and is then bounded only by the TTL, exactly as the retry-exhaustion case above is. What
narrows is the window: from "any request in flight across the commit" to "a request whose
Postgres read predates the commit and whose cache write lands more than a second after it".
Both halves are measured in `cache-invalidation.subscriber.spec.ts` and, against a live Redis,
in `test/links/cache-invalidation.int-spec.ts`: a fill between the two deletions is swept, and
a fill after them is not.

## Invariants a caller may rely on

1. A destination edit is visible on the redirect path within 5 seconds of commit
   (GC-2, AC-51), by deletion rather than by expiry, with the TTL at 3600 s. Two recorded
   residuals sit under this: a deletion that failed its whole retry schedule (logged), and a
   fill that lands after the delayed second deletion (silent, bounded by the TTL). Both are
   above, under "Invalidation".
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

## The binding (added 2026-08-19, D-2-09, TASK-2-03)

`REDIS_URL` **set** → one `ioredis` client on ADR-0012's six options, `REDIS_KEY_NAMESPACE`
required, `RedisRedirectCache` bound to `REDIRECT_CACHE`.

`REDIS_URL` **unset** → no client, `UnavailableRedirectCache` bound (every read
`'unavailable'`, every write and deletion a resolved no-op), and **one** warn line at boot
carrying `boot_precondition: 'redirect_cache'` and no other field. Every redirect then
resolves from Postgres and every response is correct, which is exactly why nothing else
would notice — the line is the only local evidence a deployment that forgot the variable
gets. This is the `MAIL_TRANSPORT` posture: absence lands on the thing that can do no harm,
loudly, and never on `NODE_ENV` (GC-B).

**Reachability is deliberately not a boot precondition.** The client connects when the
module graph is built; an unreachable instance degrades every read to `'unavailable'`.
Refusing to boot on it would convert ADR-0012's degraded path into an outage.

Shipped surface: `assertRedisConfigured(env)` (called unconditionally from
`assertBootPreconditions()`), `RedisBindingError` (`binding: 'redirect_cache'`, mapped in
`bootstrap().catch`), `cacheAvailable()`, `simulateRedisUnavailable()` /
`restoreRedisAvailability()`, `closeRedisClient()`, `dbQueryCounter`. The raw client is
module-private: `cache.module.ts` is its only caller, asserted by a scan in
`redis-client.spec.ts`, so the limiters and the revocation store cannot acquire a second
failure posture by import (D-2-01 deferred their rebind; see ADR-0053's 2026-08-19 note).

## Versioning

Bump `v1` for any change to `CachedHost` or `CachedLink`. Deploying the bump is the
whole migration; old keys expire. Never reuse a version number.
