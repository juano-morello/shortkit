/**
 * SUPERSEDED 2026-08-08 (F-249). TASK-003 has shipped
 * `apps/api/src/observability/logger.ts`. READ THAT FILE, NOT THIS ONE.
 *
 * This stub is kept as the wave-1 scaffold it was. It is now wrong in three ways that
 * matter: its REDACT_PATHS has 17 entries against the shipped 25, it exports
 * `createLogger()` where the shipped module exports a `logger` singleton, and it has none
 * of the five error mechanisms F-244, F-248, F-251, F-252 and F-258 forced —
 * `serializers.err`, `hooks.logMethod`, `formatters.log`, and the wrappers on
 * `logger.child` and `logger.setBindings`. Deriving a logger from this file reintroduces a
 * credential leak. `design/contracts/logging-and-headers.md` carries the current
 * configuration and the reasoning, and a drift test compares its fenced block against the
 * shipped file.
 *
 * Contract: design/contracts/logging-and-headers.md
 * ADR: adr-0022-logging-cors-and-security-headers.md
 * Produced by: TASK-003
 * Consumed by: every API TASK. Nothing may opt out.
 *
 * Enforces GC-9: "structured logs via pino; no PII in log bodies; click events store
 * ip_hash, never raw IP."
 *
 * F-017: nothing in the design covered the logger, so the first implementer to log a
 * request object would have logged Authorization and Cookie with no artifact
 * contradicting them.
 */
import type pino from 'pino';

/**
 * APPEND-ONLY. Removing a path needs a reason in the commit message.
 *
 * NOTE THE LIMIT: these are pino redact paths, and `*.token` matches ONE level.
 * `payload.data.credentials.token` is NOT covered. A TASK introducing a nested secret
 * adds its path here in the same commit.
 */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["fly-client-ip"]',
  'req.headers["x-forwarded-for"]',
  /**
   * F-032. Set by the BFF from wave 9 (TASK-012); in the list from wave 1 (TASK-003).
   * The first is a raw client IP (GC-9); the second is BFF_PROXY_SECRET VERBATIM —
   * a leaked log line lets anyone forge X-Shortkit-Client-IP against Fly and defeat
   * every IP-keyed auth bucket. '*.secret' matches a property, NOT a header key.
   */
  'req.headers["x-shortkit-client-ip"]',
  'req.headers["x-shortkit-proxy-auth"]',
  'res.headers["set-cookie"]',
  '*.password',
  '*.token',
  '*.secret',
  '*.rawToken',
  '*.tokenDigest',
  '*.verificationToken',
  '*.ip',
  '*.ipHash',
  'req.body.password',
  'req.body.confirmation',
] as const;

export const REDACT_CENSOR = '[redacted]';

export function createLogger(): pino.Logger {
  throw new Error('not implemented');
}

/**
 * `route` is the matched PATTERN (/api/links/:id), never the concrete path.
 * A concrete path carries a slug or an id, and the redirect path's concrete paths are
 * the entire click stream in plain text.
 */
export interface RequestLogFields {
  request_id: string;
  route: string;
  status: number;
  duration_ms: number;
  /** Present on every line emitted inside a tenant transaction. */
  tenant_id?: string;
}

/**
 * ============================================================================
 * CORS IS DISABLED. app.enableCors() IS NEVER CALLED.
 * ============================================================================
 *
 * The browser never reaches the API cross-origin: ADR-0014 routes every browser request
 * through the Next.js BFF, same-origin with the page. The redirect path is reached by
 * navigation, not fetch.
 *
 * A frontend TASK meeting a cross-origin error ESCALATES rather than enabling CORS —
 * the error means something is bypassing the BFF, which is the actual defect.
 * A future MCP server gets its own ADR and does not inherit a default set here.
 */
export const CORS_ENABLED = false;

/**
 * helmet() defaults plus HSTS, registered in main.ts before the global prefix.
 * `preload` is NOT set: submission is close to irreversible and the apex domain is
 * unregistered.
 *
 * Two deliberate exceptions on the redirect path override these, both normative in
 * redirect-resolution.md:
 *   302 -> Referrer-Policy: unsafe-url        (attribution referrer; the link is public)
 *   404 -> a tighter hand-written CSP          (tenant-controlled branding, F-006)
 */
export const HSTS_MAX_AGE_S = 31_536_000;
