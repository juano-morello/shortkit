/**
 * Contract: design/contracts/branding.md
 * ADR: adr-0011-branding-port.md
 * Produced by: TASK-029 (declaration), TASK-045 (implementation)
 *
 * THE CONSUMER DECLARES THE PORT. Nothing in this file imports from
 * apps/api/src/workspaces/. WorkspacesModule binds an implementation to
 * REDIRECT_BRANDING_PORT and exports it; AppModule imports both modules.
 * The dependency arrow runs workspaces -> redirect, which is the direction AC-55 allows.
 */

export const REDIRECT_BRANDING_PORT = Symbol('REDIRECT_BRANDING_PORT');

export interface RedirectBranding {
  readonly logoUrl: string | null;
  readonly brandColor: string | null;
  readonly fallbackUrl: string | null;
}

export interface RedirectBrandingPort {
  /**
   * `tenantId` is REQUIRED so the implementation runs inside withTenantTransaction
   * and the read happens under RLS. Branding is therefore NOT a GC-5 exclusion.
   * The redirect path already holds the tenant id from the cached host record.
   *
   * Called on a host-cache MISS only. On a warm cache, branding comes from
   * CachedHost.b (design/contracts/redirect-cache.md).
   */
  getForDomain(domainId: string, tenantId: string): Promise<RedirectBranding | null>;
}

/**
 * RedirectModule injects this with @Optional(). Unbound, renderNotFound falls back to
 * the default Shortkit 404 (AC-77) and the module boots standalone.
 *
 * A test MUST assert the token is bound in the production module graph: @Optional()
 * means a wiring mistake degrades silently instead of failing at boot.
 */
export type OptionalRedirectBrandingPort = RedirectBrandingPort | null;
