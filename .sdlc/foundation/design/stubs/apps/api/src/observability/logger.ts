/**
 * SUPERSEDED 2026-08-08 (F-249), and the gap widened at ADR-0028 on 2026-08-10. TASK-003 has
 * shipped `apps/api/src/observability/logger.ts`. READ THAT FILE, NOT THIS ONE. NOTHING IN
 * THIS FILE MAY BE COPIED FORWARD.
 *
 * This stub is kept as the wave-1 scaffold it was, and it is a record of a design this
 * project deliberately removed. It is wrong in four ways that matter:
 *
 *   1. IT REDACTS BY DENYLIST, AND THE PROJECT NO LONGER DOES. `REDACT_PATHS` below and
 *      pino's `redact` option are both gone from the shipped module (ADR-0028). A field
 *      reaches a log line only if its key is in `LOGGABLE_FIELDS`, and every other key is
 *      emitted as `[redacted]`. The denylist failed three audit rounds the same way: it
 *      covered the spellings someone had thought of (F-244, F-262, F-266). Copying the list
 *      below rebuilds the mechanism those findings closed — and rebuilds it at 17 paths,
 *      short even of the 25 that were shipping when it was retired.
 *   2. It exports `createLogger()` where the shipped module exports a `logger` singleton.
 *   3. It has none of the error mechanisms F-244, F-248, F-251, F-252 and F-258 forced:
 *      `serializers.err`, `hooks.logMethod`, `formatters.log`, and the wrappers on
 *      `logger.child` and `logger.setBindings`.
 *   4. It has no child-options refusal (F-263), which is load-bearing rather than hardening
 *      since ADR-0028: one `logger.child(b, { formatters })` call opts a whole subtree out
 *      of the only mechanism there is.
 *
 * Deriving a logger from this file reintroduces a credential leak.
 * `design/contracts/logging-and-headers.md` carries the current configuration and the
 * reasoning, and `logger-contract-drift.spec.ts` compares its fenced block against the
 * shipped file byte for byte. Nothing compares THIS file to anything: it is not built, not
 * typechecked and not tested, so its only failure mode is a human reading it as current.
 * That is why the warning is this long.
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
 * DEAD DECLARATION. NOT A LIST TO MAINTAIN, AND NOT A LIST TO COPY (ADR-0028).
 *
 * No `REDACT_PATHS` exists in `apps/api/src/observability/logger.ts` and no `redact` option
 * is passed to pino. Do not add a path here: nothing reads it, and a TASK that "keeps it up
 * to date" is maintaining a mechanism the project removed on purpose.
 *
 * WHY IT WAS REMOVED, since the shape is tempting: a path list censors the spellings someone
 * thought of. `err.body` leaked past it (F-244), then `clientIp`, `trustedClientIp`,
 * `remoteAddress`, `ipAddress` (F-262), then `sessionToken`, `apiKey`, `api_key`,
 * `passwordHash` and a bare `authorization` or `cookie` (F-266). Appending each round's
 * findings produced a longer list with the same property. `*.token` also matches ONE level,
 * so `payload.data.credentials.token` was never covered by the entry that looks like it
 * covers everything — which is the trap this list sets for the reader.
 *
 * WHAT SURVIVES OF IT. The paths live on as a PROHIBITION, not a mechanism:
 * `logging-and-headers.md`, "The never-allowlist: names that may never be added to
 * `LOGGABLE_FIELDS`". If you came here looking for what may not be logged, that section is
 * the current answer and it is longer than this array.
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
