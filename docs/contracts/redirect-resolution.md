# Contract: redirect resolution and the branded 404

- **Boundary:** the anonymous visitor's `GET /:slug`; the one deliberate GC-5 exception.
- **Normative form:** `apps/api/src/redirect/redirect.types.ts`, **written 2026-08-19 (TASK-2-06)**. The design stub the previous line pointed at is retired with it (ADR-0039); the shipped module is normative for the types, `redirect.service.ts` for the decision order, `db/redirect-read.ts` for the two statements, and `not-found-page.ts` for the page and its CSP.
- **Produced by:** TASK-029, delivered as TASK-2-06 (item 2, wave 3).
- **Consumed by:** TASK-2-07 (the cache in front of the same decision, shipped 2026-08-19; `redirect.service.ts` remains normative for the order and now carries the read-through), TASK-2-09 (the click sink), TASK-030, 032, 034, 043, 046. Audited by TASK-056.
- **ADRs:** ADR-0003, ADR-0006, ADR-0008, ADR-0009, ADR-0011, ADR-0018, ADR-0063.

## Normative types

```ts
export interface ResolvedHost {
  readonly domainId: string;
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly branding: RedirectBranding | null;
}

export interface ResolvedLink {
  readonly id: string;
  readonly destinationUrl: string;
  readonly domainId: string;
  readonly workspaceId: string;
  readonly tenantId: string;
  readonly expiresAt: Date | null;
  readonly activatesAt: Date | null;
}

export type RedirectDecision =
  | { kind: 'redirect'; status: 302; location: string; link: ResolvedLink }
  | { kind: 'fallback'; status: 302; location: string; host: ResolvedHost }
  | { kind: 'not-found'; status: 404; host: ResolvedHost | null };

export declare function resolveLink(hostname: string, slug: string): Promise<ResolvedLink | null>;
export declare function resolveHost(hostname: string): Promise<ResolvedHost | null>;
export declare function renderNotFound(host: ResolvedHost | null): { status: 404; body: string; contentType: 'text/html; charset=utf-8' };
export declare function isLinkActive(w: { expiresAt: Date | null; activatesAt: Date | null }, now: Date): boolean;
```

## Decision order

Normative. Each step names the ACs it satisfies.

0. **Reject a path segment that cannot be a slug, before any cache read and any query.**
   Added 2026-08-19 (TASK-2-06; D-2-13 introduced the step as a cost bound and this is the
   whole of it). A segment longer than `SLUG_MAX_LENGTH` or failing `SLUG_PATTERN` renders
   the **default** 404 with zero Redis calls and zero Postgres queries.

   **It is a security bound and not only a scanner-cost one, and the reason is two shipped
   facts meeting.** `linkKey()` builds `sk:{namespace}:rdr:v1:{hostname}:{slug}` from the
   slug WITHOUT normalising it (deliberately, with a comment in `redirect-cache.ts` saying
   it must not start), and redirect traffic is never rate limited at any rate (AC-2-19,
   AC-86; `RateLimitGuard` skips the route by path and needs no edit). An unvalidated path
   segment therefore turns one anonymous request into one new key in a shared Redis
   namespace, each holding a MISS sentinel for its 60 seconds, at whatever rate a stranger
   can open sockets. Validating first bounds the key namespace to the strings a link could
   actually own.

   `validateSlug` is deliberately NOT used: it additionally rejects the reserved list, and
   a reserved slug is one no link can hold, so the extra work buys a 404 that was coming
   anyway. `SLUG_PATTERN` and the length bound are imported from `@shortkit/contracts`,
   which GC-N permits (it bans the management API's modules, not the shared package).

   The order is therefore fixed: **shape, then hostname, then cache, then Postgres.**
1. Normalise `hostname`: lowercase, IDNA via `new URL()`, strip port. A `Host` header that
   is not a hostname at all makes `new URL()` throw; the throw is caught and answered with
   the default 404, since the header is attacker-controlled and its malformedness is not a
   failure of resolution (TASK-2-06).
2. `resolveHost(hostname)`, **which resolves only a domain in state `active`**. Null
   yields the **default** 404 (no branding available).

   **Read through the cache as of 2026-08-19 (TASK-2-07).** `getHost` first: a record is the
   host, the MISS sentinel is the default 404 with **no query and no second cache call** (the
   link key is not even looked up), and `'unavailable'` (a cold key, a failure, an outage)
   goes to Postgres. What comes back is written to `hst:` either way, the record for a domain
   that resolved and the sentinel for one that did not, which is where "`resolveHost` is the
   only writer of a positive `hst:` record" is enforced: the statement carries
   `AND state = 'active'`, so a host it returns is an active one and every other state caches
   as MISS (F-003 through the cache).

   Revised 2026-08-04 (F-003). Without the state predicate, any signed-up user could
   `POST /api/domains {hostname: "<fly-app>.fly.dev"}`, land a row in
   `pending_verification`, and the redirect path would resolve every unmatched path on
   Shortkit's own host against their domain row: attacker-controlled 302s and
   attacker-supplied branding served from the platform origin. It also gave
   dangling-DNS takeover, because a deleted domain whose CNAME still pointed at Fly
   could be re-claimed by the next attacker and served immediately. `active` means DNS
   ownership was proved and a certificate issued, which is the only state in which
   serving someone's traffic is justified. The seeded system default domain
   (`is_system_default`) is created directly in `active`.
3. `resolveLink(hostname, slug)`. Null yields step 6 (AC-50, AC-53).

   **The same read-through, with two rules the host key does not need** (TASK-2-07). A cached
   record is served only if its `dm` is the domain step 2 resolved: the `rdr:` key is keyed on
   the hostname, and a hostname that changed hands between two domain rows while its link key
   survived would otherwise serve the previous owner's destination (invariant 5, from the
   cache side). And the **host is always resolved first**, because a `rdr:` key says nothing
   about the state of the domain behind it and **nothing deletes a host key today**: the
   shipped subscriber deletes `rdr:` keys only, and the `hst:` rows of the invalidation table
   belong to later cards, so the 300 s host TTL is the only bound on a stale host record.
   Resolving the host first keeps that bound at 300 s rather than the link key's 3600.

   **What each state costs, and the bound.** Both keys cached: zero statements. Host cached,
   link cold: `resolveLinkOnDomain(domainId, slug)`, statement 2 on its own. Host cold, link
   negative: `resolveHost`, statement 1 on its own. Host cold, link record:
   `resolveHostKeepingLinkOn(hostname, slug, keptDomainId)`, which issues statement 1 and then
   statement 2 **in the same transaction** only when the record names another domain, so
   validating a record never opens a second transaction. Neither cached: **one**
   `resolveByHostAndSlug`, the four statements the resolve cost before the cache existed.
   None of these introduces a new statement shape. A miss may cost the cold resolve and no
   more, so the two cache reads both happen before either Postgres read is chosen, and every
   branch opens at most one transaction; anything else pays the two-statement preamble twice.
4. `isLinkActive(link, now)` false yields step 6 (AC-44, AC-45, AC-46). ADR-0009: the
   validity window is evaluated on every read, cache hit included, and an inactive link
   on a cache hit does **not** fall through to Postgres.
5. Otherwise `{ kind: 'redirect', status: 302, location: link.destinationUrl }`. The
   `Location` header is the destination byte for byte, with no rewriting, no tracking
   parameters, and no normalisation (AC-48).
6. Not found: `host.branding.fallbackUrl` set yields
   `{ kind: 'fallback', status: 302, location: fallbackUrl }` (AC-76, Amendment A-4);
   unset yields `renderNotFound(host)` at status 404 (AC-75, AC-77).
7. Emit the click event on `kind === 'redirect'` only, via
   `clickEventBuffer.enqueue()` before writing the response (`click-events.md`). Never
   on `fallback` or `not-found`.

## Response headers

| Header | Value | On |
|---|---|---|
| `Location` | the destination or fallback URL, verbatim | 302 |
| `Cache-Control` | `private, no-store` | every response |
| `Server-Timing` | `app;dur=<ms>` from `process.hrtime.bigint()` around the handler | every response |
| `Referrer-Policy` | `unsafe-url` | 302 |
| `Content-Security-Policy` | `default-src 'none'; img-src https:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'` | **404 only** |
| `X-Content-Type-Options` | `nosniff` | 404 |

**`frame-ancestors 'none'` was added 2026-08-19 (D-2-14), closing the half of F-280 that
was left open on 2026-08-10.** A per-response CSP REPLACES helmet's, and `frame-ancestors`
does not fall back to `default-src`, so the directive list without it left this one
response, the one that renders tenant-controlled branding, with no framing policy at all
and a browser falling back to `X-Frame-Options`: the weaker of the two mechanisms and the
one `logging-and-headers.md` deliberately stopped relying on. `main.ts`'s helmet docblock
states the requirement on this row in as many words, and
`test/redirect/redirect.int-spec.ts` asserts the served header names the directive. The
row is quoted in `logging-and-headers.md`'s exception table, which is corrected from here.

The CSP is the second layer under F-006's escaping requirement in `branding.md`. It
allows no script from any source, so an injected `<script>` or event-handler attribute
that survives escaping still does not execute. `img-src https:` permits the tenant's
logo and nothing over plain HTTP.

**`Location` is written with `setHeader`, never with Express's `res.redirect`.** Added
2026-08-19 (TASK-2-06). `res.redirect` puts the value through `res.location`, which runs
`encodeUrl`: a stored destination carrying `|`, a space or an already-percent-encoded
sequence comes back a different string, and "byte for byte" is an assertion in the
integration suite rather than a figure of speech.

**And byte-for-byte fidelity is only as strong as every writer of `destination_url`, present
and future.** The resolver validates nothing at read time, which is the point: a resolver
that sanitised the value would be a second, quieter definition of what a destination is. So
the guarantee that the stored value is a legal header value rests entirely on
`destinationUrlContract` running on every write path, and there is **no database-level
constraint behind it** (`links.destination_url` is plain `text`, deliberately, so the regex
is not duplicated in two places). A bulk import, a backfill, a support script or a psql
session that writes this column without the contract can store one the route cannot send.
The failure is safe and is measured: Node refuses a header value carrying a raw CR or LF
with `ERR_INVALID_CHAR`, the controller's catch turns that into the mandated default 404,
and nothing splits (`test/redirect/redirect.int-spec.ts` plants both shapes by SQL). Safe is
not the same as intended, and the author of the next write path is the person this paragraph
is addressed to.

`Server-Timing` is the number TASK-035 aggregates and TASK-037 gates on (ADR-0018).

## The GC-5 exception, narrowed

`resolveHost` and `resolveLink` are the only functions in the codebase that read
tenant-scoped tables outside tenant context. Both go through:

```ts
// apps/api/src/redirect/db/redirect-read.ts — the ONLY file setting app.redirect_context
export declare function withRedirectRead<T>(fn: (db: RedirectReadDb) => Promise<T>): Promise<T>;
```

which issues, as shipped on 2026-08-19:

```sql
BEGIN;
SET TRANSACTION READ ONLY;
SELECT set_config('app.redirect_context', 'on', true);
-- exactly two query shapes are permitted here, verbatim, and they are module constants
-- so the comparison is a string equality in a test rather than a reading exercise:
SELECT id, tenant_id, workspace_id FROM domains WHERE hostname = $1 AND state = 'active';
SELECT id, tenant_id, workspace_id, domain_id, destination_url, expires_at, activates_at
  FROM links WHERE domain_id = $1 AND slug = $2;
COMMIT;
```

`AND state = 'active'` is part of the permitted query shape, not an optional filter
(F-003). `set_config` rather than `SET LOCAL` per F-007, though this flag takes a
constant.

**One transaction covers both statements, and the resolved host comes back even when the
link does not** (TASK-2-06). Step 6 needs the host to reach branding (a branded 404 and a
fallback 302 both belong to the host rather than to the link), so returning only the link
would force a second lookup for the commonest 404 there is. `resolveHost` is the same first
statement on its own, for the state TASK-2-07 makes ordinary: the link key cached and the
host key expired, which the two TTLs (3600 and 300) guarantee will happen.
`resolveLinkOnDomain` (TASK-2-07) is the second statement on its own, for the other ordinary
state: the host record cached and the link key deleted by an edit or run out as a negative.
`resolveHostKeepingLinkOn` (TASK-2-07) is statement 1 followed by statement 2 in the SAME
transaction, and only when the resolved domain is not the one a cached record names: the
state where the host key is cold and a record has to be validated, which would otherwise cost
two transactions and two preambles. All three reuse the module constants, so the permitted
shapes stay two and
`redirect-isolation.spec.ts`'s literal comparison is untouched; the escape's justification is
unchanged and no exclusion was added.

**`domain_id` in the second statement comes from the first statement's result and never
from the request**, which is what makes invariant 5 true by construction. Since 2026-08-19
the database agrees from the other side too: `links` carries `(domain_id,
domain_tenant_id)` as a composite key into `domains (id, tenant_id)` plus a CHECK narrowing
the owner to the row's own tenant or the platform (ADR-0063). The write side is measured in
`test/db/migration-0005.int-spec.ts`, the read side in `test/redirect/redirect.int-spec.ts`
with a second active domain planted, because the property is unobservable in item 2's
shipped configuration, where only one domain exists, and item 3 is where it starts to
matter.

**No drizzle, at any depth, under `apps/api/src/redirect/**`** (the recorded no-ORM
constraint). `databaseTransaction` still hands over drizzle's transaction handle, since it
is the only way to reach the runtime pool and this module is row 2 of `tenant-context.md`'s
sanctioned consumer table. But the two statements go through the session's own
prepared-query path: a `{ sql, params }` pair, `$1` and `$2` bound by the driver, no
visitor-supplied byte concatenated into SQL text. `redirect-isolation.spec.ts` asserts the
absence of any drizzle import specifier by grep, and asserts the set of SELECT literals
under the module equals the two shapes above plus the preamble's `set_config`.

**Justification, recorded for the security auditor.** Resolution runs before a tenant
is known, because the visitor is anonymous and the only inputs are a hostname and a
slug. There is no tenant to set. The exception is narrowed four ways: `FOR SELECT`
policies, on two tables only, inside a `READ ONLY` transaction, in one file whose
uniqueness is asserted by grep in the isolation suite.

Registered in `isolation-coverage.md` as exclusion 1 of ~~2~~ **3** (amended 2026-08-12,
ADR-0045). TASK-2-06 consumes the pre-paid entry
`repo:RedirectReadRepository.resolveByHostAndSlug` and adds none: the class and method name
are the `SurfaceId`, so renaming either breaks the exclusion loudly.

## Module isolation (AC-55)

`apps/api/src/redirect/**` must not import from `../links`, `../auth`, `../workspaces`,
`../members` or `../invitations` (GC-N's five), at the NestJS module level or at the file
level. Branding arrives through `RedirectBrandingPort`, and the click buffer through
`REDIRECT_CLICK_SINK`, both declared inside the redirect module (`branding.md`, D-2-10).

Asserted twice: a module-graph test on `RedirectModule.imports` (**exactly `[CacheModule]`**
as of TASK-2-07, empty before it) and a static scan of import specifiers under
`apps/api/src/redirect/**`. `CacheModule` is not one of GC-N's five and is not a port
either: the cache is infrastructure reached through the `REDIRECT_CACHE` token, it knows
nothing about links, hosts or branding, and the binding it hands over is whichever one boot
chose (D-2-09).

`RedirectModule` also carries no `AuthGuard`, no `WorkspaceGuard`, no
`RateLimitGuard` (AC-86) and no `TenantTransactionInterceptor`. It is registered
outside the `/api` global prefix (ADR-0006).

**The prefix exclusion is `{ path: '\\:slug', method: RequestMethod.GET }`, with the colon
escaped, and the escape is load-bearing.** Measured on the shipped module graph
(TASK-2-06), correcting D-2-13's `':slug'`: Nest matches an exclusion against a route's
DECLARED path rather than against a request URL
(`RoutePathFactory.isExcludedFromGlobalPrefix`) and compiles it with `pathToRegexp`, so the
unescaped parameter pattern matches the declared path of EVERY one-segment GET route in the
application: `GET /api/links`, `GET /api/workspaces` and `GET /api/invitations` all lose
the prefix and move to the root. The escaped form compiles to the literal `/:slug`, which
is the one declared path this controller has. `app.module.spec.ts` pins both directions,
including the broken one, and `main.ts` imports the constant from `redirect.module.ts`
rather than spelling the path a second time.

## Invariants a caller may rely on

1. No request to `GET /:slug` returns 5xx (GC-8, AC-53). Every failure path ends at a
   302 or a 404. The controller wraps its body in a catch that renders the default 404
   and logs.
2. A cache hit performs zero Postgres queries, asserted by `dbQueryCounter` (AC-49).
3. With Redis unavailable, resolution still succeeds from Postgres (AC-52) and recovers
   without a restart (AC-54).
4. A slug existing on host H2 but not H1 returns 404 on H1 (AC-50). Uniqueness is
   `(domain_id, slug)`, never global (GC-6).
5. `resolveLink` never returns a link whose `domain_id` does not belong to `hostname`.
   True by construction, since the second statement is keyed on the first statement's
   result, and true at the write as well since 2026-08-19, because `links_domain_tenant_fk` and
   `links_domain_owner_check` leave no row that could be returned (ADR-0063). Measured from
   the read side with a second active domain planted, so that item 3's tenant-owned domains
   arrive against a test that is older than the code that could break it.
6. **A hostname resolves only while its domain is `active`.** A `pending_verification`,
   `verification_failed`, `provisioning` or `certificate_failed` domain serves nothing,
   and a deleted domain stops serving immediately (AC-73). A tenant cannot cause
   Shortkit's own hostnames to resolve against their row, because those are rejected at
   `POST /api/domains` (`domain-provisioning.md`) and would never reach `active`.
7. The 404 page executes no script, on any input, because its CSP allows no script
   source, and it cannot be framed, because that CSP names `frame-ancestors 'none'`
   itself rather than inheriting helmet's (D-2-14).
8. **A path segment that is not a possible slug reaches no store at all** (step 0). Added
   2026-08-19. Neither Redis nor Postgres is touched, so an unrate-limited stranger cannot
   mint cache keys or database round trips from a path they chose.

## What the implementer must guarantee

- Every Redis call is bounded at 50 ms and falls through to Postgres on timeout or
  error (ADR-0012).
- `isLinkActive` is imported from TASK-027's module and never reimplemented.
- The default 404 renders with no database access at all, so it works when everything
  else is down. Asserted with every pooled connection held open by someone else, which is
  also how the F-152 arm of invariant 1 is exercised: acquisition times out, the error
  carries no SQLSTATE, and the visitor still gets a page.
- The validity window and the shape check both come from `@shortkit/contracts`, and the
  hostname normaliser from `db/platform.ts`, the same function the seed writes the stored
  hostname with, so a request and a row cannot disagree about what a hostname is.

## Versioning

`GET /:slug` is a public HTTP surface consumed by browsers. Its status codes and
`Location` semantics are frozen for the life of the product.
