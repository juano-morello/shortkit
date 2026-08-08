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
 * NOTE THE LIMIT, IN BOTH DIRECTIONS. A pino wildcard path matches EXACTLY ONE level, so
 * `*.token` covers `req.token` and covers NEITHER `token` at the top level NOR
 * `payload.data.credentials.token` two levels down. That is why every `*.x` entry below is
 * paired with a bare `x`: F-244's minor half measured that a top-level `password` was not
 * censored at all. Depth beyond one is still uncovered — a TASK introducing a nested secret
 * adds its own path here in the same commit.
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
  // The top-level halves of the wildcards above (F-244). `*.password` does not match a
  // `password` key on the record itself, and the record itself is where a call site that
  // spreads a parsed body reaches first.
  'password',
  'token',
  'secret',
  'rawToken',
  'tokenDigest',
  'verificationToken',
  'ip',
  'ipHash',
] as const;

export const REDACT_CENSOR = '[redacted]';

/**
 * What `msg` says when a call site logged an error and nothing else. It names the call
 * shape rather than the error, because naming the error is what leaks — and the fields the
 * `err` serialiser built are on the same record.
 */
const POSITIONAL_ERROR_MESSAGE = 'an error was logged with no context string';

/**
 * The one logger in the API. Every line the process writes goes through it, which is what
 * makes the redact list above a mechanism rather than a convention.
 *
 * Its destination is pino's default, file descriptor 1, and that write is SYNCHRONOUS.
 * Verified 2026-08-08 on pino 10.3.1 and Node 24.19 through a pipe: a line written
 * immediately before `process.exit(1)` still arrives, and still arrives after 5000
 * preceding lines. `main.ts`'s boot-failure line depends on that — before this file
 * existed it hand-rolled a promise around `process.stderr.write` for exactly this reason.
 *
 * ============================================================================
 * THE `err` SERIALISER IS OVERRIDDEN, AND THAT IS A SECURITY CONTROL (F-244).
 * ============================================================================
 *
 * pino's default `err` serialiser copies EVERY OWN ENUMERABLE PROPERTY of the error onto
 * the record. body-parser attaches the verbatim request body to `err.body` on the 400 it
 * raises for malformed JSON, so `log.error({ err }, '…')` — one idiomatic line, in any
 * later TASK — wrote an unauthenticated POST's credentials in the clear. Reproduced on
 * this repository's own pino 10.3.1 before the override, and `REDACT_PATHS` did not reach
 * it: `err.body` is a string, and a path list cannot reach inside one.
 *
 * Routing the key through `errorLogFields` makes that misuse impossible UNDER THAT KEY
 * rather than enumerating the fields to censor: the record carries the three fields the
 * policy below builds and no fourth, whatever the error happens to hang off itself.
 * Appending `err.body` to `REDACT_PATHS` was the alternative and is weaker — it defends the
 * one property that has already been found, and the next library to decorate an error gets a
 * new name.
 *
 * `serializers` IS KEYED BY FIELD NAME, AND THAT WAS THE SAME WEAKNESS ONE LEVEL UP (F-248).
 * `{ error: e }` and `{ ctx: { err: e } }` reach pino's ordinary object path, where `message`
 * and `stack` do not survive — they are non-enumerable — but `body` does, because
 * body-parser ASSIGNED it. So F-244's exact payload came back under a key one character
 * away. `formatters.log` below closes every key at once; see it for what the two mechanisms
 * each own, and the `child` wrapper under this literal for the same closure on the OTHER
 * path a line is built by (F-251).
 *
 * `includeMessage: false` here and no way to pass `true`: an error reaching a log call
 * under the `err` key has no call-site reason attached to it, and the two places that DO
 * have one call `errorLogFields` directly.
 *
 * THE HOOK CLOSES THE SAME HOLE BY ITS OTHER DOOR. `log.error(err)` with no context
 * string routes the error through the serialiser above — and then pino copies
 * `err.message` into `msg`, which is a top-level key no redact path may censor without
 * censoring every log line's text. Measured on pino 10.3.1, and it is the field the policy
 * below withholds everywhere else. The hook rewrites that one call shape into the one the
 * serialiser fully covers. `log.error(err, 'context')` passes through untouched.
 *
 * BOTH CALL SHAPES, NOT ONLY THE POSITIONAL ONE (F-252). `write` (`proto.js:223`) fills
 * `msg` from `_obj[errorKey].message` for a RECORD too, so `log.error({ err })` with no
 * context string landed the same message in the same uncensorable field while the `err`
 * object itself came out clean — the hook fired only on a positional `Error` and this shape
 * walked past it. The second branch below supplies the context string pino would otherwise
 * take from the error, and hands the caller's own record through unchanged so its fields
 * survive.
 */
export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  redact: { paths: [...REDACT_PATHS], censor: REDACT_CENSOR },
  base: { service: 'shortkit-api', env: process.env.NODE_ENV },
  formatters: {
    level: (label) => ({ level: label }),
    log: (record) => errorsReplaced(record, 1),
  },
  serializers: { err: (thrown: unknown) => errorLogFields(thrown, { includeMessage: false }) },
  hooks: {
    logMethod(args, method) {
      const [thrown, context] = args as [unknown, unknown];

      if (typeof context !== 'string') {
        if (thrown instanceof Error) {
          method.call(this, { [ERROR_KEY]: thrown }, POSITIONAL_ERROR_MESSAGE);
          return;
        }

        if (messageWouldBeTakenFromTheError(thrown)) {
          method.call(this, thrown, POSITIONAL_ERROR_MESSAGE);
          return;
        }
      }

      method.apply(this, args);
    },
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});

/**
 * ============================================================================
 * CHILD BINDINGS GO THROUGH THE SAME SCAN, BECAUSE PINO WILL NOT RUN IT (F-251).
 * ============================================================================
 *
 * `formatters.log` above is applied by `_asJson` to the record a log call passes. Child
 * bindings never reach it: they are serialised once, at `logger.child(…)`, by `asChindings`
 * (`tools.js:238`). So `logger.child({ error: e })` wrote F-244's payload — the verbatim
 * request body — under a key one character away from the one key that is covered, and
 * `exception-filter.ts:125` already builds a child logger per request, which is the call
 * site one edit away from it.
 *
 * WHY THE CONFIGURED WAY DOES NOT WORK, MEASURED ON pino 10.3.1. `formatters.bindings` is
 * the documented seam and it does not reach child bindings: `child(bindings)` called with no
 * `options` argument REPLACES the instance's bindings formatter with the identity function
 * `resetChildingsFormatter` before calling `asChindings` (`proto.js:84`, `:98-104`), so a
 * root `formatters.bindings` runs on `base` at construction and never again. Only a
 * formatter passed in a child's OWN `options` reaches its bindings — which is a rule every
 * call site has to remember, and this file exists so that none of them has to. Wrapping
 * `child` is therefore the only mechanism available; it changes no signature, returns pino's
 * own child instance, and children of children inherit this property through the prototype
 * chain `Object.create(this)` builds, so the scan applies at every level.
 *
 * DEPTH 1, KEEPING THE TOP-LEVEL `err` EXEMPTION, FOR THE SAME REASON THE RECORD PATH KEEPS
 * IT. `asChindings` applies the bindings formatter at `tools.js:247` and `serializers[key]`
 * at `:258` — the same order `_asJson` uses — so the partition below holds identically here:
 * a scan that replaced the top-level `err` in bindings would hand `serializers.err` an
 * ordinary object and `logger.child({ err: e })` would degrade to
 * `non-error throwable (object)` with no frames. `logger.spec.ts` fails on that.
 *
 * `setBindings` is the other door onto `asChindings` and is NOT wrapped: nothing in the API
 * calls it, and it is listed with the residuals on `MAX_ERROR_SCAN_DEPTH` below.
 *
 * COST, MEASURED the same way the scan below was — one million calls, pino 10.3.1, Node
 * 24.19, on the binding `exception-filter.ts` actually creates: 609 ns per child through
 * this wrapper against 581 ns through pino's own `child` reached past it. 28 ns on a
 * per-request path against GC-1's 25 ms budget.
 */
type ChildFactory = (
  this: pino.Logger,
  bindings: pino.Bindings,
  options?: pino.ChildLoggerOptions,
) => pino.Logger;

const inheritedChild: ChildFactory = logger.child;

const childWithErrorsReplaced: ChildFactory = function childWithErrorsReplaced(bindings, options) {
  // A missing `bindings` is pino's own error to raise, with pino's own message.
  return inheritedChild.call(this, bindings ? errorsReplaced(bindings, 1) : bindings, options);
};

// Installed as an own property, shadowing the one on pino's prototype, with the descriptor a
// prototype method has. `defineProperty` rather than assignment because pino declares `child`
// generic over the custom levels a child may add and this wrapper is indifferent to them —
// assigning would take a double type assertion to say something neither honest nor checked.
Object.defineProperty(logger, 'child', {
  value: childWithErrorsReplaced,
  writable: true,
  enumerable: false,
  configurable: true,
});

/**
 * The key pino files a positional `Error` under, and the one key `serializers.err` above
 * owns. Pino's `errorKey` option is left at its default; this is that default, named.
 */
const ERROR_KEY = 'err';

/**
 * Where pino puts a log call's message, and the key whose presence on a record stops
 * `write` reaching into `_obj[errorKey]` for one. Pino's `messageKey` option is left at its
 * default; this is that default, named.
 */
const MESSAGE_KEY = 'msg';

/**
 * Whether pino would build this log call's `msg` out of the error the record carries —
 * `proto.js:223`, `msg === undefined && _obj[messageKey] === undefined && _obj[errorKey]`.
 *
 * The condition is on the ERROR KEY'S PRESENCE, not on the value being an `Error`, because
 * that is what pino reads: a decorated plain object under `err` — the shape `catch (err)`
 * binds and the shape `serializers.err` reduces to `err_name` — puts its own `message` in
 * `msg` by the same route. A record that already carries its own `msg` is left alone; pino
 * would use that one, and supplying a second would write the key twice.
 */
function messageWouldBeTakenFromTheError(record: unknown): record is object {
  if (typeof record !== 'object' || record === null || record instanceof Error) {
    return false;
  }

  return (
    readIndexedProperty(record, MESSAGE_KEY) === undefined &&
    Boolean(readIndexedProperty(record, ERROR_KEY))
  );
}

/**
 * How far into a log record the scan below looks for an `Error`.
 *
 * Four. `{ ctx: { err: e } }` — F-248's third shape — puts the error at depth 2, so one
 * level is not enough, and an unbounded walk runs on every line the process writes. Four
 * covers every nesting a call site in this repository builds — every one is flat today, and
 * `req.headers.authorization` in `REDACT_PATHS` is the deepest shape named anywhere, at 3 —
 * with a level of slack, and it bounds the work whatever a call site hands the logger.
 *
 * MEASURED on this repository, pino 10.3.1 and Node 24.19, one million calls per figure,
 * against the shipped instance's own formatter: 40 ns on a flat request-log record, 95 ns on
 * one carrying `req.headers`, 115 ns on a record nested five deep, and 500 ns when the record
 * actually holds an error — where `errorLogFields`, not the walk, is the cost. The whole log
 * call is 5.8 µs to 9 µs on the same machine, so the scan is under 2% of a line the redirect
 * path already pays for, against GC-1's 25 ms budget. The bound also makes a self-referential
 * record terminate, which a walk without one would not.
 *
 * THE RESIDUALS, STATED RATHER THAN LEFT TO BE FOUND. Three shapes reach a line with a
 * library's assigned properties on them, and all three carry the same escalation rule: the
 * TASK that first builds one closes it here, in the same commit, rather than living with it.
 *
 *   1. AN ERROR AT DEPTH 5 OR DEEPER is not replaced — the bound above. Same limit
 *      `REDACT_PATHS` has for a nested secret, same answer: raise it.
 *   2. AN ERROR HELD INSIDE A CLASS INSTANCE is not replaced (F-255), because `isWalkable`
 *      declines to walk one — see it for why. `JSON.stringify` serialises a class instance's
 *      own enumerable properties happily, so `{ ctx: new Ctx(parseFailure) }` puts the raw
 *      body on the line even at depth 1. The answer for a TASK that needs it is to log the
 *      fields it wants rather than the instance, or to widen `isWalkable` deliberately and
 *      pay the `Buffer` cost it exists to avoid.
 *   3. `logger.setBindings(bindings)` IS NOT SCANNED. It is the other door onto
 *      `asChindings`; `logger.child` is wrapped above and this is not, because nothing in
 *      the API calls it and no test covers it. A TASK that reaches for it wraps it the same
 *      way `child` is wrapped, in the same commit.
 */
const MAX_ERROR_SCAN_DEPTH = 4;

/**
 * ============================================================================
 * EVERY `Error` IN THE RECORD GOES THROUGH THE SAME POLICY, UNDER EVERY KEY (F-248).
 * ============================================================================
 *
 * `serializers` is keyed by field name, so the override above covers `err` and nothing
 * else. That was F-244 one level up: `{ error: e }`, `{ cause: e }` and `{ ctx: { err: e } }`
 * all reach pino's ordinary object path, and what survives it is exactly what a library
 * ASSIGNED to the error — `message` and `stack` are non-enumerable, `body-parser`'s `body`
 * is not. All three leaked the verbatim request body; reproduced before this change.
 * Adding `serializers.error` and `serializers.cause` is the enumeration F-244 rejected, and
 * it would not reach the nested shape at all.
 *
 * WHAT EACH MECHANISM OWNS, AND WHY THE SPLIT. MEASURED, pino 10.3.1 `lib/tools.js`
 * `_asJson`: `formatters.log` runs BEFORE the per-key serialisers, on the same merged
 * record. So an error this function replaced at the top-level `err` key would then be
 * handed to `serializers.err` as an ordinary object and come out
 * `non-error throwable (object)`. The two therefore partition the record:
 *
 *   - `serializers.err` owns the top-level `err` key. It also covers a NON-error under that
 *     key, which this function deliberately does not.
 *   - this function owns every other key, at every depth up to `MAX_ERROR_SCAN_DEPTH` —
 *     including `err` nested below the root.
 *
 * There is no key between them.
 *
 * WHAT THE SUITE PINS, EXACTLY (F-254 — this paragraph used to claim more). MEASURED by
 * striking each half of the partition and running `logger.spec.ts`: dropping
 * `serializers.err` alone fails 12 tests, dropping the `depth === 1 && key === ERROR_KEY`
 * skip alone fails 6 — so neither half can be removed on its own. Removing BOTH TOGETHER,
 * which is the "these two mechanisms overlap, let me unify them" refactor and the one a
 * later reader is most likely to attempt, fails exactly ONE test: the non-`Error` under the
 * top-level `err` key. That single case is what makes this a partition rather than a
 * redundancy, and it is the only thing standing between that refactor and F-244's shape
 * coming back under `err`.
 *
 * ONLY `Error` INSTANCES ARE REPLACED. A plain object a call site chose to log is its own
 * decision and passes through — the hazard here is the properties a LIBRARY hangs off a
 * throwable without the call site knowing.
 *
 * IT DESCENDS INTO NOTHING IT REPLACES, WHICH IS WHY `err.cause` STAYS SHUT. A chained
 * error is reachable only through `cause`, which is own but non-enumerable when set through
 * the `Error` constructor, so nothing walked it before this change. `errorLogFields` is the
 * boundary: it reads `name`, `message` and `stack` and returns, so an error replaced here is
 * never a container to walk. Asserted in `logger.spec.ts`.
 *
 * The record is not mutated: a container is copied only if one of its values changed, so a
 * line with no error in it allocates nothing and the caller's object is never touched.
 */
function errorsReplaced<T extends object>(container: T, depth: number): T {
  let replacement: T | undefined;

  for (const key of Object.keys(container)) {
    if (depth === 1 && key === ERROR_KEY) {
      continue;
    }

    const value = readIndexedProperty(container, key);

    if (value === UNREADABLE_PROPERTY) {
      continue;
    }

    const replaced =
      value instanceof Error
        ? errorLogFields(value, { includeMessage: false })
        : depth < MAX_ERROR_SCAN_DEPTH && isWalkable(value)
          ? errorsReplaced(value, depth + 1)
          : value;

    if (replaced !== value) {
      replacement ??= (Array.isArray(container) ? [...container] : { ...container }) as T;
      (replacement as Record<string, unknown>)[key] = replaced;
    }
  }

  return replacement ?? container;
}

/** A property whose getter threw. The scan leaves that key exactly as it found it. */
const UNREADABLE_PROPERTY = Symbol('unreadable property');

/**
 * A log record's own values are free to be hostile getters, the same way an error's are
 * (F-244's second minor). Reading one must not throw out of the log call, and must not
 * change what pino writes for that key either — so the scan skips it and leaves pino's own
 * stringify to handle it exactly as it did before this function existed.
 */
function readIndexedProperty(container: object, key: string): unknown {
  try {
    return (container as Record<string, unknown>)[key];
  } catch {
    return UNREADABLE_PROPERTY;
  }
}

/**
 * Plain records and arrays only — the shapes a log call site builds by hand. A class
 * instance is not walked: `Object.keys` on a `Buffer` is thousands of index strings, and an
 * `Error` subclass is already caught by the `instanceof` above.
 *
 * THE CONSEQUENCE, WHICH IS A RESIDUAL AND NOT ONLY A COST DECISION (F-255): an `Error` a
 * class instance holds is never replaced, and `JSON.stringify` writes that instance's own
 * enumerable properties out, so the raw request body reaches the line through it. Stated
 * with the other two on `MAX_ERROR_SCAN_DEPTH`, under the same escalation rule.
 */
function isWalkable(value: unknown): value is object {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const prototype: unknown = Object.getPrototypeOf(value);

  return Array.isArray(value) || prototype === Object.prototype || prototype === null;
}

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
    const name = readStringProperty(thrown, 'name');
    const message = readStringProperty(thrown, 'message');
    const frames = stackFrames(thrown, name, message);

    return {
      err_name: name ?? UNREADABLE,
      ...(options.includeMessage && message !== undefined ? { err_message: message } : {}),
      ...(frames === undefined ? {} : { err_stack: frames }),
    };
  }

  return {
    err_name: `non-error throwable (${typeof thrown})`,
    ...(options.includeMessage ? { err_message: describeNonError(thrown) } : {}),
  };
}

/** What is reported for a field whose accessor threw or gave a non-string. */
const UNREADABLE = 'unreadable';

/**
 * `name`, `message` and `stack` are ordinary properties and an error is free to define any
 * of them as a THROWING GETTER (F-244's second minor). This function is called from the
 * exception filter's `headersSent` arm, which sits OUTSIDE the try/catch F-092 added, and
 * from `main.ts`'s last-chance boot handler — two places with nowhere left to escape to.
 * Its sibling `describeNonError` already guarded `String()` for exactly this hazard; these
 * three reads did not.
 */
function readStringProperty(
  error: Error,
  property: 'name' | 'message' | 'stack',
): string | undefined {
  try {
    const value: unknown = error[property];

    return typeof value === 'string' ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The frames, with the `${name}: ${message}` header removed twice over: by prefix, and
 * then by keeping only lines that look like frames. Both halves are needed. The prefix
 * strip alone leaves the tail of a multi-line message behind, and the shape filter alone
 * would keep a message line that happens to begin with `    at `.
 *
 * `name` and `message` are passed in already read rather than read again here: the header
 * has to be built from the same values the caller reported, and a getter is free to answer
 * differently on a second call.
 */
function stackFrames(
  error: Error,
  name: string | undefined,
  message: string | undefined,
): string | undefined {
  const stack = readStringProperty(error, 'stack');

  if (stack === undefined) {
    return undefined;
  }

  const header = `${name ?? UNREADABLE}: ${message ?? ''}`;
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
