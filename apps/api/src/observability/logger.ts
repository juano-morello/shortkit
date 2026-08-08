/**
 * Contract: design/contracts/logging-and-headers.md
 * ADR: adr-0022-logging-cors-and-security-headers.md
 * Produced by: TASK-003
 * Consumed by: every API TASK. Nothing may opt out.
 *
 * Enforces GC-9: structured logs via pino, no PII in log bodies.
 *
 * ⚠ PATH NOTE. `logging-and-headers.md` names this file as its Normative form and names
 * TASK-003 as its producer, and `design/stubs/` carries a stub at this exact path — but
 * TASK-003's `paths` front-matter does not list it. It is written here anyway because the
 * F-090 and F-060 rulings put the pino swap in `main.ts` and `common/errors/**`, and those
 * two files cannot share a logger through either of them: `main.ts` imports `app.module.ts`
 * imports `exception-filter.ts`, so a logger defined in `main.ts` would close that cycle.
 * Reported in the TASK report rather than made silently.
 */
import pino from 'pino';

/**
 * APPEND-ONLY (`logging-and-headers.md`, "Versioning"). Removing a path needs a reason in
 * the commit message.
 *
 * NOTE THE LIMIT: these are pino redact paths and `*.token` matches ONE level, so
 * `payload.data.credentials.token` is not covered. A TASK introducing a nested secret adds
 * its path here in the same commit.
 *
 * The two `x-shortkit-*` entries ship here in wave 2, ahead of the headers themselves
 * (F-032): `x-shortkit-client-ip` carries a raw client IP on every browser-originated
 * request and `x-shortkit-proxy-auth` carries `BFF_PROXY_SECRET` verbatim, and the
 * `'*.secret'` wildcard matches a property one level deep — never a header key.
 */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["fly-client-ip"]',
  'req.headers["x-forwarded-for"]',
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

/**
 * The one logger in the API. Every line the process writes goes through it, which is what
 * makes the redact list above a mechanism rather than a convention.
 *
 * Its destination is pino's default, file descriptor 1, and that write is SYNCHRONOUS.
 * Verified 2026-08-08 on pino 10.3.1 and Node 24.19 through a pipe: a line written
 * immediately before `process.exit(1)` still arrives, and still arrives after 5000
 * preceding lines. `main.ts`'s boot-failure line depends on that — before this file
 * existed it hand-rolled a promise around `process.stderr.write` for exactly this reason.
 */
export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  redact: { paths: [...REDACT_PATHS], censor: REDACT_CENSOR },
  base: { service: 'shortkit-api', env: process.env.NODE_ENV },
  formatters: { level: (label) => ({ level: label }) },
  timestamp: pino.stdTimeFunctions.isoTime,
});

/**
 * `route` is the matched PATTERN (`/api/links/:id`), never the concrete path. A concrete
 * path carries a slug or an id, and the redirect path's concrete paths are the entire
 * click stream in plain text.
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
 * THE STACK-VERSUS-MESSAGE POLICY (F-090, F-093, F-108, F-111). TASK-003 owns it.
 * ============================================================================
 *
 * `error-envelope.md` § "What the 500 log line carries, and who owns changing it" left
 * this to TASK-003 and recorded `sdlc-security-auditor`'s recommendation: log the frames
 * and treat the message as the risky field. **Adopted, with one exception, and the F-111
 * check ran first.**
 *
 * MEASURED, not assumed — pino 10.3.1, pino-std-serializers 7, Node 24.19, 2026-08-08:
 *
 *   - `pino.stdSerializers.err(e)` emits `{ type, message, stack }` where `stack` is the
 *     RAW `e.stack`, whose first line is `${e.name}: ${e.message}`. Serialising an error
 *     the standard way therefore reinstates the message inside `stack`, which is exactly
 *     what F-111 said to check for. **This module never uses that serialiser, and never
 *     puts an `Error` under an `err` key or in a positional argument** — pino also copies
 *     `err.message` into `msg` when an Error is passed positionally.
 *   - `REDACT_PATHS` DOES reach `err.message` and `err.stack` once an error has been
 *     serialised into an object; `logging-and-headers.md` says it cannot, and that is
 *     wrong in one direction. What redaction cannot do is reach INSIDE either string, so
 *     the choice is per-field and all-or-nothing. That is why the answer is which fields
 *     to build, not which paths to censor.
 *
 * THE POLICY:
 *
 *   - **`err_stack` carries frames only.** The `${name}: ${message}` header is stripped by
 *     prefix and then by shape, so a message containing a literal newline (F-108: the
 *     framework-400 message quotes raw request bytes) cannot leave a remnant behind. The
 *     frames name files and functions in our own source and in `node_modules` — no request
 *     data, no PII, no credential.
 *   - **`err_message` is withheld by default.** It is the field that carries a URL-style
 *     Postgres DSN on a connection failure, an internal host on a Redis timeout, and a
 *     fragment of an unauthenticated request body on the framework-400 arm.
 *   - **Truncation was rejected as the remedy for F-108.** A cap does not remove a
 *     credential that sits at the START of the quoted slice, so it buys a shorter line and
 *     no reduction in exposure.
 *   - **`includeMessage` is opt-in, at two call sites with stated reasons.** A `DomainError`
 *     asserts by construction that its message is safe to show a stranger
 *     (`error-envelope.md`), so it is a fortiori safe to log. And `main.ts`'s boot failures
 *     run before any request exists, where the message IS the diagnosis — "GIT_COMMIT_SHA
 *     is not set", "DATABASE_URL connects as postgres, which is exempt from row-level
 *     security". Withholding it there turns a self-explaining refusal into a puzzle.
 *     Accepted cost: a `pg` connect failure at boot puts the database host and port on the
 *     line. That is infrastructure, not a click stream, and the operator needs it.
 */
export interface ErrorLogFields {
  readonly err_name: string;
  readonly err_message?: string;
  readonly err_stack?: string;
}

export interface ErrorLogOptions {
  /** See the policy above. Default-deny; every `true` needs a reason at the call site. */
  readonly includeMessage: boolean;
}

/** A stack line, as V8 writes them. Anything else is not a frame. */
const STACK_FRAME = /^\s+at /;

export function errorLogFields(thrown: unknown, options: ErrorLogOptions): ErrorLogFields {
  if (thrown instanceof Error) {
    const frames = stackFrames(thrown);

    return {
      err_name: thrown.name,
      ...(options.includeMessage ? { err_message: thrown.message } : {}),
      ...(frames === undefined ? {} : { err_stack: frames }),
    };
  }

  return {
    err_name: `non-error throwable (${typeof thrown})`,
    ...(options.includeMessage ? { err_message: describeNonError(thrown) } : {}),
  };
}

/**
 * The frames, with the `${name}: ${message}` header removed twice over: by prefix, and
 * then by keeping only lines that look like frames. Both halves are needed. The prefix
 * strip alone leaves the tail of a multi-line message behind, and the shape filter alone
 * would keep a message line that happens to begin with `    at `.
 */
function stackFrames(error: Error): string | undefined {
  const { stack } = error;

  if (typeof stack !== 'string') {
    return undefined;
  }

  const header = `${error.name}: ${error.message}`;
  const body = stack.startsWith(header) ? stack.slice(header.length) : stack;
  const frames = body.split('\n').filter((line) => STACK_FRAME.test(line));

  return frames.length === 0 ? undefined : frames.join('\n');
}

/**
 * `String(value)` throws for a symbol and for anything with a hostile `toString`, and this
 * runs inside the filter that answers for every throwable — so a throw here would escape
 * the one component with nowhere left to escape to.
 */
function describeNonError(thrown: unknown): string {
  try {
    return String(thrown);
  } catch {
    return 'unprintable';
  }
}
