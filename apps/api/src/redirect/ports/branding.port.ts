/**
 * Contract: docs/contracts/branding.md ("The port"), redirect-resolution.md (step 6)
 * ADR: adr-0011-branding-port.md (normative), adr-0008-redirect-cache-shape.md
 * Produced by: TASK-2-06 (the declaration). Bound by item 3, which owns the columns,
 *              the endpoints and the implementation.
 *
 * ============================================================================
 * THE CONSUMER DECLARES THE PORT. THAT IS THE WHOLE POINT (ADR-0011, AC-2-20).
 * ============================================================================
 *
 * Branding belongs to the workspace module and the redirect module may not import it
 * (GC-N). The dependency arrow is therefore inverted: this file, inside the redirect
 * module, declares the interface and the token; the workspace module binds an
 * implementation to the token and `AppModule` imports both. Nothing here reaches outside
 * this directory, which is what the static import scan in `redirect-isolation.spec.ts`
 * asserts.
 *
 * `tenantId` IS A REQUIRED PARAMETER AND NOT A CONVENIENCE. It is what lets the
 * implementation run inside `withTenantTransaction`, under RLS, so reading branding is an
 * ordinary tenant-scoped read enumerated by the isolation suite like any other, and not a
 * fourth GC-5 exclusion. The redirect path already holds the tenant id by the time it needs
 * branding, because hostname resolution returned it.
 *
 * ============================================================================
 * UNBOUND IN ITEM 2, AND THAT DEGRADES SILENTLY BY DESIGN, WITH ONE OWED TEST.
 * ============================================================================
 *
 * `RedirectService` injects this with `@Optional()`, so with nothing bound every 404 is the
 * default Shortkit page (AC-77) and the module boots and is testable standalone. ADR-0011
 * names the cost in as many words: a wiring mistake in `AppModule` then degrades to the
 * default page instead of failing at boot. The ADR's answer is a test asserting the token
 * IS bound in the production module graph, and that test belongs to the card that binds it,
 * because a test asserting a binding that item 2 deliberately does not make would be red on
 * arrival. Until then the absence is the designed state, not an oversight.
 */

/** The Nest token the workspace module binds in item 3. */
export const REDIRECT_BRANDING_PORT = Symbol('REDIRECT_BRANDING_PORT');

/**
 * The branding triple, as `CachedHost.b` carries it (ADR-0008) and as `brandingContract`
 * validates it. Both URLs are stored as the parsed `href` and constrained to `https:`
 * (F-006); this module re-escapes them anyway at render time, because validation constrains
 * the scheme and not the content (`branding.md`, "Output encoding is normative").
 */
export interface RedirectBranding {
  readonly logoUrl: string | null;
  readonly brandColor: string | null;
  readonly fallbackUrl: string | null;
}

export interface RedirectBrandingPort {
  getForDomain(domainId: string, tenantId: string): Promise<RedirectBranding | null>;
}
