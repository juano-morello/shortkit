# Contract: redirect resolution and the branded 404

- **Boundary:** the anonymous visitor's `GET /:slug`; the one deliberate GC-5 exception.
- **Normative form:** `apps/api/src/redirect/redirect.types.ts`, not yet written. The design stub at `design/stubs/apps/api/src/redirect/redirect.types.ts` stands in until TASK-029 lands the file and is retired then (ADR-0039). It is a design-gate scaffold, not a normative form.
- **Produced by:** TASK-029.
- **Consumed by:** TASK-030, 032, 034, 043, 046. Audited by TASK-056.
- **ADRs:** ADR-0003, ADR-0006, ADR-0008, ADR-0009, ADR-0011, ADR-0018.

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

1. Normalise `hostname`: lowercase, IDNA via `new URL()`, strip port.
2. `resolveHost(hostname)`, **which resolves only a domain in state `active`**. Null
   yields the **default** 404 (no branding available).

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
| `Content-Security-Policy` | `default-src 'none'; img-src https:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'` | **404 only** |
| `X-Content-Type-Options` | `nosniff` | 404 |

The CSP is the second layer under F-006's escaping requirement in `branding.md`. It
allows no script from any source, so an injected `<script>` or event-handler attribute
that survives escaping still does not execute. `img-src https:` permits the tenant's
logo and nothing over plain HTTP.

`Server-Timing` is the number TASK-035 aggregates and TASK-037 gates on (ADR-0018).

## The GC-5 exception, narrowed

`resolveHost` and `resolveLink` are the only functions in the codebase that read
tenant-scoped tables outside tenant context. Both go through:

```ts
// apps/api/src/redirect/db/redirect-read.ts — the ONLY file setting app.redirect_context
export declare function withRedirectRead<T>(fn: (db: RedirectReadDb) => Promise<T>): Promise<T>;
```

which issues:

```sql
BEGIN;
SET TRANSACTION READ ONLY;
SELECT set_config('app.redirect_context', 'on', true);
-- exactly two query shapes are permitted here, verbatim:
--   SELECT ... FROM domains WHERE hostname = $1 AND state = 'active'
--   SELECT ... FROM links   WHERE domain_id = $1 AND slug = $2
COMMIT;
```

`AND state = 'active'` is part of the permitted query shape, not an optional filter
(F-003). `set_config` rather than `SET LOCAL` per F-007, though this flag takes a
constant.

**Justification, recorded for the security auditor.** Resolution runs before a tenant
is known, because the visitor is anonymous and the only inputs are a hostname and a
slug. There is no tenant to set. The exception is narrowed four ways: `FOR SELECT`
policies, on two tables only, inside a `READ ONLY` transaction, in one file whose
uniqueness is asserted by grep in the isolation suite.

Registered in `isolation-coverage.md` as exclusion 1 of 2.

## Module isolation (AC-55)

`apps/api/src/redirect/**` must not import from `../links`, `../auth`, `../workspaces`
or `../members`, at the NestJS module level or at the file level. Branding arrives
through `RedirectBrandingPort`, declared inside the redirect module (`branding.md`).

Asserted twice: a module-graph test on `RedirectModule.imports`, and a static scan of
import specifiers under `apps/api/src/redirect/**`.

`RedirectModule` also carries no `AuthGuard`, no `WorkspaceGuard`, no
`RateLimitGuard` (AC-86) and no `TenantTransactionInterceptor`. It is registered
outside the `/api` global prefix (ADR-0006).

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
6. **A hostname resolves only while its domain is `active`.** A `pending_verification`,
   `verification_failed`, `provisioning` or `certificate_failed` domain serves nothing,
   and a deleted domain stops serving immediately (AC-73). A tenant cannot cause
   Shortkit's own hostnames to resolve against their row, because those are rejected at
   `POST /api/domains` (`domain-provisioning.md`) and would never reach `active`.
7. The 404 page executes no script, on any input, because its CSP allows no script
   source.

## What the implementer must guarantee

- Every Redis call is bounded at 50 ms and falls through to Postgres on timeout or
  error (ADR-0012).
- `isLinkActive` is imported from TASK-027's module and never reimplemented.
- The default 404 renders with no database access at all, so it works when everything
  else is down.

## Versioning

`GET /:slug` is a public HTTP surface consumed by browsers. Its status codes and
`Location` semantics are frozen for the life of the product.
