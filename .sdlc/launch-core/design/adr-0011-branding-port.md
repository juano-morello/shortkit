---
id: ADR-0011
slug: launch-core
title: The redirect module declares the branding port; the workspace module implements it
status: accepted
supersedes: null
date: 2026-08-04
---

## Context

AC-55 asserts, in a test that inspects the application's module graph, that the
redirect module does not import the link-management, auth, workspace or member
modules. TASK-046 then has to render a workspace's logo, brand colour and fallback URL
on the branded 404, and calls for a "narrow read interface" without defining it.

The obvious shape puts a `BrandingService` in the workspace module and injects it into
the redirect module. That fails AC-55.

There is a second constraint that is easy to lose. `workspaces` is tenant-scoped with
RLS (TASK-045), so reading branding is a tenant-scoped read. GC-5 applies. The redirect
path knows the tenant by the time it needs branding, because hostname resolution
returned it, so this read has no reason to be an exception.

## Decision

**The consumer declares the port.** `apps/api/src/redirect/ports/branding.port.ts`
holds the interface and the injection token. Nothing in that file imports anything from
`apps/api/src/workspaces/`.

```ts
export const REDIRECT_BRANDING_PORT = Symbol('REDIRECT_BRANDING_PORT');

export interface RedirectBranding {
  readonly logoUrl: string | null;
  readonly brandColor: string | null;
  readonly fallbackUrl: string | null;
}

export interface RedirectBrandingPort {
  getForDomain(domainId: string, tenantId: string): Promise<RedirectBranding | null>;
}
```

**The workspace module provides the implementation** and exports a provider bound to
`REDIRECT_BRANDING_PORT`. `AppModule` imports both modules. The dependency arrow points
from workspaces to redirect, which is the direction AC-55 permits.

**The port takes `tenantId` and the implementation runs inside
`withTenantTransaction`.** The redirect path already holds the tenant id from the host
record (ADR-0008). Branding is therefore an ordinary tenant-scoped read under RLS, and
it is enumerated by the isolation suite like any other repository method. It is not a
third GC-5 exclusion.

**The dependency is optional.** The redirect module injects it with `@Optional()`. With
no provider bound, `renderNotFound` uses the default Shortkit 404, which is AC-77's
behaviour. The redirect module boots and is testable with no workspace module present.

**The port is called on a cache miss only.** Branding is carried in the `hst:v1:` host
record (ADR-0008), populated when the hostname is first resolved. A branded 404 on a
warm cache costs one Redis `GET` and no call through the port. TASK-045 deletes the
host keys when branding changes.

**AC-55's test checks both levels.** The module-graph assertion the AC names, plus a
static check that no file under `apps/api/src/redirect/` contains an import specifier
matching `../workspaces`, `../links`, `../auth` or `../members`. The module graph would
not catch a bare type import; the static check does.

## Alternatives considered

| Option | Pros | Cons | Why not |
|---|---|---|---|
| Put the interface in a shared `apps/api/src/shared/` module both sides import | Neutral location; no dependency inversion to explain | A shared module accumulates. The first thing in it is a branding type; the tenth is half the domain model, and the redirect module ends up transitively coupled to everything through the thing that was supposed to decouple it | Creates the coupling it was meant to prevent, slowly enough that nobody notices |
| Redirect module reads `workspaces` directly through its own repository | No port, no provider wiring, one fewer indirection | Puts a second reader on a table the workspace module owns, so a schema change there breaks the redirect path with nothing linking the two. It also means branding is read through the `app.redirect_context` escape, widening a policy this design keeps to two tables | Widens the GC-5 escape from two tables to three for no benefit |
| Event bus: workspaces publishes branding changes, redirect keeps a local copy | Zero call-time coupling; fastest read | An eventually-consistent replica of data that Redis already caches, with its own staleness and its own cold-start problem | Rebuilds the cache that already exists |
| Denormalise branding onto the `domains` row | Redirect reads what it already reads; no port at all | Branding belongs to the workspace and a workspace can own several domains, so every branding edit becomes a fan-out write, and the two copies drift when one write fails | Trades a clean read for a write-consistency problem |

## Consequences

### Positive

- AC-55 holds by construction. The redirect module's imports point at itself, at the
  cache, and at the database client, and nowhere else.
- Branding reads run under RLS in tenant context, so SC-1's exclusion list stays at
  two and the isolation suite covers the read like any other.
- With the port unbound the redirect module still serves 302s and default 404s, which
  makes it independently testable and makes TASK-029 shippable before TASK-045 exists.
- A warm cache serves a branded 404 without calling the port at all.

### Negative / accepted cost

- Someone reading `apps/api/src/workspaces/` finds a provider bound to a symbol
  declared in the redirect module, which reads backwards until you know why. It needs
  a comment naming AC-55.
- `@Optional()` means a wiring mistake in `AppModule` degrades silently to the default
  404 instead of failing at boot. A test asserts the token is bound in the production
  module graph, because nothing else would notice.
- Branding is now cached in two places conceptually: the `hst:` record and whatever the
  workspace module holds. The invalidation rule lives in TASK-045, one wave away from
  the code that depends on it.
- The static import check is a string match over file contents. It rejects a legitimate
  future import of an unrelated file that happens to sit under `../workspaces`.

### Follow-ups this creates

- TASK-029 creates `ports/branding.port.ts` and the `@Optional()` injection, and writes
  the default `renderNotFound`.
- TASK-045 provides the implementation, binds the token, and deletes `hst:` keys on a
  branding write.
- TASK-046 reads branding from the host record and calls the port only on a miss.
- Contract: `design/contracts/branding.md`.
