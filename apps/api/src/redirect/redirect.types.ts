/**
 * Contract: docs/contracts/redirect-resolution.md ("Normative types", "Decision order")
 * ADR: adr-0006-http-surface-partitioning.md, adr-0008-redirect-cache-shape.md,
 *      adr-0009-expiry-eviction.md, adr-0011-branding-port.md
 * Produced by: TASK-2-06
 *
 * ============================================================================
 * THIS FILE IS THE CONTRACT'S NORMATIVE FORM, AS OF THIS COMMIT.
 * ============================================================================
 *
 * `redirect-resolution.md` carried "Normative form: `apps/api/src/redirect/redirect.types.ts`,
 * not yet written", with a design stub standing in under ADR-0039. The file exists now and
 * the contract's line is amended to point here; the stub directory was already gone.
 *
 * The three shapes below are the contract's, character for character in their fields. What
 * a reader should notice is what is NOT here: no row type, no column names, no `slug`. The
 * decision is expressed over resolved values so the same function decides on a Postgres
 * read (this card) and on a cached record (TASK-2-07) without a second code path. ADR-0008
 * chose the cached value's fields to make exactly that possible, and ADR-0009 depends on
 * it, because `expiresAt` and `activatesAt` have to be present on a cache hit or the
 * validity window cannot be evaluated without falling through to Postgres.
 */
import type { RedirectBranding } from './ports/branding.port';

/**
 * A hostname that resolved to a domain in state `active`, and nothing else resolves
 * (F-003; `redirect-resolution.md` invariant 6). `branding` is null in item 2 for every
 * host: no branding column exists and no implementation is bound to the port.
 */
export interface ResolvedHost {
  readonly domainId: string;
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly branding: RedirectBranding | null;
}

/**
 * A link row on the resolved host's domain. `tenantId` is carried because the click writer
 * opens a tenant transaction from it with no second lookup, which is why ADR-0008 put `t` in
 * the cached record and the reason click emission is not a fourth GC-5 exclusion.
 */
export interface ResolvedLink {
  readonly id: string;
  readonly destinationUrl: string;
  readonly domainId: string;
  readonly workspaceId: string;
  readonly tenantId: string;
  readonly expiresAt: Date | null;
  readonly activatesAt: Date | null;
}

/**
 * The three outcomes, and there is no fourth. GC-O: every `GET /:slug` ends at a 302 or a
 * 404, including the ones that ended at an exception (the controller's catch renders
 * `not-found` with a null host).
 */
export type RedirectDecision =
  | { readonly kind: 'redirect'; readonly status: 302; readonly location: string; readonly link: ResolvedLink }
  | { readonly kind: 'fallback'; readonly status: 302; readonly location: string; readonly host: ResolvedHost }
  | { readonly kind: 'not-found'; readonly status: 404; readonly host: ResolvedHost | null };
