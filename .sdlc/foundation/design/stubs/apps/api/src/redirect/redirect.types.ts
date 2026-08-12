/**
 * Contract: design/contracts/redirect-resolution.md
 * ADR: adr-0006, adr-0008, adr-0009, adr-0011, adr-0018
 * Produced by: TASK-029
 *
 * AC-55: apps/api/src/redirect/** must not import from ../links, ../auth,
 * ../workspaces or ../members, at the module level or the file level.
 * Branding arrives through ./ports/branding.port.
 */
import type { RedirectBranding } from './ports/branding.port';

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

export interface NotFoundRender {
  readonly status: 404;
  readonly body: string;
  readonly contentType: 'text/html; charset=utf-8';
}

/** Lowercase, IDNA via `new URL()`, strip port. */
export function normaliseHostname(_hostname: string): string {
  throw new Error('not implemented');
}

/**
 * Resolves ONLY a domain in state 'active' (F-003). A host record is cached only for a
 * domain in that state; anything else caches as a MISS sentinel.
 */
export function resolveHost(_hostname: string): Promise<ResolvedHost | null> {
  throw new Error('not implemented');
}

export function resolveLink(_hostname: string, _slug: string): Promise<ResolvedLink | null> {
  throw new Error('not implemented');
}

/** Renders with NO database access, so it works when everything else is down. */
export function renderNotFound(_host: ResolvedHost | null): NotFoundRender {
  throw new Error('not implemented');
}

/**
 * TASK-027 owns the implementation. Imported here, never reimplemented:
 * the API and the redirect path must not diverge.
 * Absence of both timestamps means active (AC-47).
 */
export function isLinkActive(
  _window: { expiresAt: Date | null; activatesAt: Date | null },
  _now: Date,
): boolean {
  throw new Error('not implemented');
}
