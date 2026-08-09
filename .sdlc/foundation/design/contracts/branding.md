# Contract: workspace branding, and the port into the redirect module

- **Boundary:** the branding HTTP surface; and the redirect module's read of branding without importing the workspace module (AC-55).
- **Normative form:** `packages/contracts/src/workspaces/branding.ts` and `apps/api/src/redirect/ports/branding.port.ts` (stub: `design/stubs/apps/api/src/redirect/ports/branding.port.ts`).
- **Produced by:** TASK-045 (schema, endpoints, port implementation), TASK-029 (port declaration).
- **Consumed by:** TASK-046 (branded 404), TASK-047 (settings UI).
- **ADRs:** ADR-0011, ADR-0008.

## HTTP contract

```ts
/**
 * Revised 2026-08-04 (F-006). `z.string().url()` accepts `javascript:` and `data:` and
 * stores the ORIGINAL string, so a logoUrl carrying a quote and a script tag survived
 * validation intact and executed for every anonymous visitor hitting an unknown slug.
 * A `javascript:` fallbackUrl became the verbatim Location of a 302.
 */
const httpsUrl = (max: number) =>
  z.string().max(max)
    .transform((v, ctx) => {
      let u: URL;
      try { u = new URL(v); } catch { ctx.addIssue({ code: 'custom', message: 'Must be a URL.' }); return z.NEVER; }
      if (u.protocol !== 'https:') { ctx.addIssue({ code: 'custom', message: 'Must be an https:// URL.' }); return z.NEVER; }
      return u.href;                 // STORE THE PARSED href, never the raw input
    });

export const brandingContract = z.object({
  logoUrl:     httpsUrl(2048).nullable(),
  brandColor:  z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable(),
  fallbackUrl: httpsUrl(2048).nullable(),
});
export type Branding = z.infer<typeof brandingContract>;

export const updateBrandingContract = brandingContract.partial();
```

Both URLs are constrained to `https:` and **stored as the parsed `href`**, not as the
submitted string. `brandColor` was already a closed regex.

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

## Output encoding is normative, not advisory

Added 2026-08-04 (F-006). `renderNotFound` builds an HTML string from tenant-controlled
input, so the escaping rule is part of this contract rather than a rendering suggestion.

1. **Every interpolated branding value is HTML-attribute-escaped** before it enters the
   string: `&` `<` `>` `"` `'` are replaced with their entity forms. This applies to
   `logoUrl` and `brandColor` without exception, including values that already passed
   zod, because validation constrains the scheme and not the content.
2. `brandColor` is interpolated only into a `style` attribute value, and only after the
   `^#[0-9a-fA-F]{6}$` regex has been re-checked at render time. A value failing it
   renders the default colour.
3. `logoUrl` is interpolated only into an `<img src>` with explicit `width` and
   `height`. Never into a `srcset`, a CSS `url()`, or an inline style.
4. The 404 response carries the CSP in `redirect-resolution.md`'s header table, which
   allows no script source at all. That is the second layer: an injected handler that
   somehow survived escaping still does not execute.

Three independent defences, because this page is served to anonymous visitors on a
tenant's own hostname and the input comes from that tenant's operator.

## Three layers, stated together

| Layer | Stops |
|---|---|
| `https:`-only zod with a parsed `href` | `javascript:` and `data:` in the 302 `Location`, and scheme-based script execution |
| HTML-attribute escaping in `renderNotFound` | attribute-breakout via `"` or `>` in a URL that is legitimately `https:` |
| `Content-Security-Policy: default-src 'none'` on the 404 | execution of anything the first two missed |

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
- **A test submits `https://x/a"><script>alert(1)</script>` as `logoUrl`, requests an
  unknown slug on that hostname, and asserts the rendered body contains no unescaped
  `<script` and that the CSP header is present.** The same test submits
  `javascript:alert(1)` as `fallbackUrl` and asserts a 400 with
  `details.fieldErrors.fallbackUrl`.
- Stored values are the parsed `href`. An implementer keeping the raw input reintroduces
  the whole finding.
- `<BrandPreview />` (TASK-047) renders the same escaped composition, so the preview
  cannot show something the served page will not.

## Versioning

Adding a branding field means adding it to `brandingContract`, to `CachedHost.b`, and
bumping the cache key version to `v2` (`redirect-cache.md`). All three, or the redirect
path reads a shape it does not understand.
