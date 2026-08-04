# Contract: workspace branding, and the port into the redirect module

- **Boundary:** the branding HTTP surface; and the redirect module's read of branding without importing the workspace module (AC-55).
- **Normative form:** `packages/contracts/src/workspaces/branding.ts` and `apps/api/src/redirect/ports/branding.port.ts` (stub: `design/stubs/apps/api/src/redirect/ports/branding.port.ts`).
- **Produced by:** TASK-045 (schema, endpoints, port implementation), TASK-029 (port declaration).
- **Consumed by:** TASK-046 (branded 404), TASK-047 (settings UI).
- **ADRs:** ADR-0011, ADR-0008.

## HTTP contract

```ts
export const brandingContract = z.object({
  logoUrl:    z.string().url().max(2048).nullable(),
  brandColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable(),
  fallbackUrl: z.string().url().max(2048).nullable(),
});
export type Branding = z.infer<typeof brandingContract>;

export const updateBrandingContract = brandingContract.partial();
```

| Method | Path | Role | Response |
|---|---|---|---|
| `GET` | `/api/workspaces/:id/branding` | `viewer` | `Branding` |
| `PATCH` | `/api/workspaces/:id/branding` | `workspace_admin` | `Branding` |

`brandColor` is a six-digit hex string with a leading `#`. Three-digit shorthand,
named colours and `rgb()` are rejected. An invalid value returns 400
`validation_failed` with `details.fieldErrors.brandColor`, and **the stored branding is
unchanged** (AC-78): validation runs before the update statement.

All three fields are nullable and independently optional. Absence of branding is valid
and is not an error (AC-77).

`logoUrl` is a URL, not an upload. `launch-core` stores no binary and adds no object
storage, which keeps GC-3 intact. The settings UI accepts a URL.

## Columns

```sql
ALTER TABLE workspaces
  ADD COLUMN logo_url     text,
  ADD COLUMN brand_color  text,
  ADD COLUMN fallback_url text;
```

`workspaces` is already tenant-scoped with the full RLS template.

## The port

Declared **inside the redirect module**. Nothing in this file imports from
`apps/api/src/workspaces/`.

```ts
// apps/api/src/redirect/ports/branding.port.ts
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

`WorkspacesModule` binds an implementation to `REDIRECT_BRANDING_PORT` and exports it.
`AppModule` imports both modules. The dependency arrow runs workspaces to redirect,
which is the direction AC-55 permits.

`RedirectModule` injects it with `@Optional()`. Unbound, `renderNotFound` uses the
default Shortkit 404 (AC-77) and the module boots standalone.

**`tenantId` is a required parameter** so the implementation runs inside
`withTenantTransaction` and the read is under RLS. Branding is therefore not a GC-5
exclusion. The redirect path already holds the tenant id from the cached host record.

## Call frequency

The port is called on a **host cache miss only**. Branding is carried in
`CachedHost.b` (`redirect-cache.md`), so a branded 404 on a warm cache costs one Redis
`GET`. TASK-045 deletes `hst:v1:{hostname}` for every hostname on the workspace when
branding changes.

## Rendering rules

| Condition | Response |
|---|---|
| `fallbackUrl` set | **302** to `fallbackUrl` (AC-76, Amendment A-4) |
| `fallbackUrl` null, branding present | **404**, page rendering `logoUrl` and `brandColor` (AC-75) |
| no branding, or port unbound | **404**, default Shortkit page (AC-77) |
| host unresolved | **404**, default Shortkit page |

Status is 404 whenever a page renders. It never becomes 200 (GC-8).

## Invariants a caller may rely on

1. `apps/api/src/redirect/**` contains no import specifier matching `../workspaces`,
   `../links`, `../auth` or `../members`. Asserted by a module-graph test and a static
   import scan (AC-55).
2. Branding reads run under RLS in tenant context and are enumerated by TASK-056 like
   any repository method.
3. The default 404 renders with no database access, so it works when everything except
   the process is down.
4. `<BrandPreview />` (TASK-047) renders the same composition the served 404 uses, so
   the operator's preview matches production.

## What the implementer must guarantee

- TASK-045 binds the token and deletes the host cache keys on write. Forgetting the
  delete leaves a stale logo for up to 300 seconds.
- A test asserts `REDIRECT_BRANDING_PORT` is bound in the production module graph.
  `@Optional()` means a wiring mistake degrades silently otherwise.
- `logoUrl` is rendered in an `<img>` with an explicit size and no script execution
  path. It is attacker-controlled input from the tenant's own operator.

## Versioning

Adding a branding field means adding it to `brandingContract`, to `CachedHost.b`, and
bumping the cache key version to `v2` (`redirect-cache.md`). All three, or the redirect
path reads a shape it does not understand.
