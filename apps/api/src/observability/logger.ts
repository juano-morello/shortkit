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
 *
 * AND `msg` IS BUILT FROM THE ARGUMENTS AS WELL AS FROM THE RECORD (F-260). That is a
 * mechanism none of the above stands in front of; `interpolationCovered` below the literal
 * owns it, and the hook's last line is where it is applied.
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

      method.apply(this, interpolationCovered(args) as Parameters<pino.LogFn>);
    },
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});

/**
 * ============================================================================
 * DOOR SIX: `msg` IS BUILT FROM THE CALL'S ARGUMENTS TOO (F-260, F-269).
 * ============================================================================
 *
 * `genLog`'s `LOG` (`tools.js:47-77`) calls `format(msg, formatParams, formatOpts)` —
 * `quick-format-unescaped` — BEFORE `write()` runs. `%o`, `%O` and `%j` expand an argument
 * through the stringifier and `%s` expands it through `String()`. Neither `formatters.log`,
 * nor `serializers.err`, nor either bindings wrapper is anywhere on that path: they act on
 * the RECORD or on BINDINGS, and this is neither. The hook above read `args[0]` and
 * `args[1]` only, so by the time a placeholder mattered `args[1]` was a string and every
 * branch of it declined.
 *
 * REPRODUCED against this module before the fix, on an error shaped as a library shapes
 * one: `logger.error('parse failed: %o', e)` put every own enumerable property of the
 * throwable into `msg` — the one top-level field no redact path may censor without
 * censoring every line's text. `%j` was identical, `%s` wrote `${name}: ${message}`, and
 * `logger.error({ request_id }, e)` — the `Error` in the MESSAGE position, one token from
 * the covered `logger.error(e, 'context')` — made `msg` a JSON OBJECT holding the same
 * payload.
 *
 * REDACTION IS NOT THE FALLBACK HERE, AND IT WAS CHECKED RATHER THAN ASSUMED.
 * `formatOpts.stringify` IS the redacting stringifier, so an interpolated object does get
 * the path list applied — it does not help for F-244's reason, that the payload is a STRING
 * and no path reaches inside one, and `%s` bypasses `stringify` altogether.
 *
 * WHAT THIS DOES: every position pino interpolates goes through the same policy the record
 * path uses, before pino formats anything.
 *
 *   - AN `Error` IN THE MESSAGE POSITION is moved onto the record under `err`, where
 *     `serializers.err` owns it, and the message becomes the fixed string the positional
 *     branch already uses. It cannot be reduced in place: `format` returns a non-string
 *     message unchanged, so `msg` would be an object rather than a line an aggregator can
 *     index.
 *   - AN `Error` IN A FORMAT-PARAMETER POSITION becomes `errorLogFields(…)`, so `%o` and
 *     `%j` interpolate the name and the frames and nothing else. `%s` on that object reads
 *     `[object Object]`: a placeholder is the wrong way to hand this logger an error, and
 *     `log.error({ err }, 'context')` is the shape that gives the operator the fields.
 *   - A CONTAINER in either position is scanned, so `logger.error('ctx %o', { err: e })` —
 *     the auditor's own reproduction — is covered as well.
 *
 * F-269 RIDES ON THIS RATHER THAN BEING CLOSED BY IT. `logger.error('parse failed', e)` —
 * a trailing argument no placeholder consumes — is still DROPPED by `quick-format`, which
 * is pino's documented behaviour and not something this module changes. What changed is
 * that the dropped argument and the interpolated one are now the same reduced value, so the
 * difference between `'parse failed'` and `'parse failed %o'` is a silent line versus a line
 * carrying a name and frames. It is no longer silence versus a credential.
 *
 * COST. The common shape — `log.error({ … }, 'context')` — reaches the loop with nothing to
 * iterate and allocates nothing; a call with format arguments allocates one array only if a
 * value actually changed. Measured with the rest of the module against GC-1's 25 ms.
 */
function interpolationCovered(args: readonly unknown[]): readonly unknown[] {
  const message = messageArgumentIndex(args);

  // The message position first: covering it rewrites the whole argument list.
  const covered = message === 1 && args[1] instanceof Error ? errorMovedOntoTheRecord(args) : args;

  let replaced: unknown[] | undefined;

  for (let index = message + 1; index < covered.length; index += 1) {
    const argument = covered[index];
    const safe = interpolationSafe(argument);

    if (safe !== argument) {
      replaced ??= [...covered];
      replaced[index] = safe;
    }
  }

  return replaced ?? covered;
}

/**
 * Which argument pino will format into `msg`. `LOG` branches on `typeof o === 'object'` —
 * so `null` takes the record branch too — and shifts a leading `undefined` past. Everything
 * from this index onwards is interpolated; `args[0]` below it is the RECORD, which
 * `formatters.log` and `serializers.err` already own.
 */
function messageArgumentIndex(args: readonly unknown[]): number {
  return typeof args[0] === 'object' || args[0] === undefined ? 1 : 0;
}

/**
 * `log.error(record, error)`. The error is filed under `err`, where `serializers.err`
 * reduces it to the policy fields, and the message becomes the string a positional error
 * already gets.
 *
 * The caller's record is COPIED rather than mutated, and an `err` it already carried is
 * overwritten deliberately — the alternative is leaving the error in the message position,
 * which is the leak this exists to close. The copy is a spread, so it re-reads the record's
 * own keys; `readIndexedProperty` states what that does and does not guarantee.
 */
function errorMovedOntoTheRecord(args: readonly unknown[]): readonly unknown[] {
  const record = typeof args[0] === 'object' && args[0] !== null ? args[0] : {};

  return [{ ...record, [ERROR_KEY]: args[1] }, POSITIONAL_ERROR_MESSAGE, ...args.slice(2)];
}

/**
 * Where a scan of a FORMAT ARGUMENT starts, and the one difference between this path and
 * the record path. The depth-1 skip of the top-level `err` key exists only because
 * `serializers.err` runs after `formatters.log` and owns that key; nothing runs after
 * `format`, so the same exemption here would be a hole rather than a seam —
 * `logger.error('ctx %o', { err: e })` is the shape it leaks through. Starting at 2 turns
 * the exemption off, and the price is one level of reach.
 */
const FORMAT_ARGUMENT_SCAN_DEPTH = 2;

/** The policy applied to one value pino is about to interpolate. */
function interpolationSafe(value: unknown): unknown {
  if (value instanceof Error) {
    return errorLogFields(value, { includeMessage: false });
  }

  return isWalkable(value) ? errorsReplaced(value, FORMAT_ARGUMENT_SCAN_DEPTH) : value;
}

/**
 * ============================================================================
 * BINDINGS GO THROUGH THE SAME SCAN, BECAUSE PINO WILL NOT RUN IT (F-251, F-258).
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
 * `setBindings` IS THE SECOND DOOR ONTO `asChindings`, AND IT IS WRAPPED TOO (F-258). It
 * needs no child logger — `logger.setBindings({ error: e })` is one line from anywhere that
 * imports this module — and it appends to the SINGLETON's chindings permanently, so a
 * throwable bound there leaks on that line and on every line the process writes afterwards.
 * The two paths do differ, and the difference was measured rather than reasoned across:
 * `child()` swaps the bindings formatter for the identity function first and `setBindings`
 * (`proto.js:189-192`) does not. Neither touches `serializers[key]`, so the `err` seam above
 * holds on this path as well and both wrappers scan at the same depth.
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

type BindingsSetter = (this: pino.Logger, bindings: pino.Bindings) => void;

const inheritedChild: ChildFactory = logger.child;
const inheritedSetBindings: BindingsSetter = logger.setBindings;

const childWithErrorsReplaced: ChildFactory = function childWithErrorsReplaced(bindings, options) {
  return inheritedChild.call(this, bindingsScanned(bindings), childOptionsChecked(options));
};

const setBindingsWithErrorsReplaced: BindingsSetter = function setBindingsWithErrorsReplaced(
  bindings,
) {
  inheritedSetBindings.call(this, bindingsScanned(bindings));
};

/**
 * Depth 1, so the top-level `err` key stays exempt and `serializers.err` keeps it — the
 * partition below, on the bindings path. A falsy `bindings` is handed straight back so that
 * each method still answers for it the way pino does: `child` raises its own "missing
 * bindings for child Pino", `setBindings` no-ops.
 */
function bindingsScanned(bindings: pino.Bindings): pino.Bindings {
  return bindings ? errorsReplaced(bindings, 1) : bindings;
}

/**
 * ============================================================================
 * A CHILD'S `options` ARE AN OPT-OUT OF THIS WHOLE MODULE, SO THEY ARE REFUSED (F-263).
 * ============================================================================
 *
 * pino's `child(bindings, options)` does not merge these three with the instance's own; it
 * REPLACES them, and all three were reproduced against this singleton:
 *
 *   - `redact` — `proto.js:157-165`, comment "replace redact directly". One child-scoped
 *     path drops all 25 the root censors, on that child, with nothing in the output to say
 *     so. This is the plausible accident rather than the exotic one: a TASK that wants ONE
 *     extra path for its own subtree writes `child(b, { redact: ['*.myField'] })`.
 *   - `serializers` — `proto.js:115-134`. Merged PER KEY, parent first, so a child naming
 *     `err` displaces the serialiser that owns the top-level `err` key — the half of the
 *     partition the record scan deliberately skips. Nothing else covers that key.
 *   - `formatters` — `proto.js:136-143`, `log || formatters.log`. A child supplying
 *     `formatters.log` removes the scan itself, at every key and every depth.
 *
 * REFUSED RATHER THAN MERGED, and the choice is not a coin toss. Merging is only definable
 * for `redact`, and even there a child supplying its own `censor` or `remove: true` changes
 * what the merged list does to the paths it inherited; for `serializers.err` and
 * `formatters.log` a "merge" is a composition whose order is a second undocumented policy.
 * Every one of those outcomes is a control that is partly in force, which is the state this
 * module exists to make impossible — the file header says "Nothing may opt out", and until
 * now nothing enforced it. A throw is the only answer that cannot be half-applied, it fires
 * at the call site rather than in a log line nobody reads, and no call site in `apps/api`
 * passes any of the three (`exception-filter.ts:125` passes bindings and no options at all),
 * so nothing that runs today reaches it. ADR-0028 depends on this: once `redact` goes, a
 * child-supplied `formatters.log` would be the only thing between a record and the line.
 *
 * `level`, `msgPrefix`, `customLevels` and `bindings` are untouched — they change what a
 * child logs, not what this module withholds — and `setBindings` takes no options at all.
 */
const OPTIONS_A_CHILD_MAY_NOT_REPLACE = ['redact', 'serializers', 'formatters'] as const;

function childOptionsChecked(
  options?: pino.ChildLoggerOptions,
): pino.ChildLoggerOptions | undefined {
  // `options == null` is pino's own "no options at all" (`proto.js:96`), and `null` reaches
  // this from an untyped call site, so it is answered here rather than by `Object.hasOwn`
  // throwing something that names neither the option nor the reason.
  const supplied: unknown = options;

  if (typeof supplied !== 'object' || supplied === null) {
    return options;
  }

  // Presence, not truthiness: pino tests `hasOwnProperty` for `serializers` and
  // `formatters`, so `{ serializers: undefined }` already takes its replacing branch.
  const replaced = OPTIONS_A_CHILD_MAY_NOT_REPLACE.filter((option) =>
    Object.hasOwn(supplied, option),
  );

  if (replaced.length > 0) {
    throw new TypeError(
      `a child logger may not supply its own ${replaced.join(', ')}: pino replaces the ` +
        `logger's own rather than merging, so this child would lose the controls that keep ` +
        `an error's incidental fields, a credential and an IP off every line it writes. ` +
        `See design/contracts/logging-and-headers.md.`,
    );
  }

  return options;
}

// Installed as own properties, shadowing the ones on pino's prototype, with the descriptor a
// prototype method has. `defineProperty` rather than assignment because pino declares `child`
// generic over the custom levels a child may add and this wrapper is indifferent to them —
// assigning would take a double type assertion to say something neither honest nor checked.
// `setBindings` is installed the same way for one idiom rather than two.
//
// NEITHER IS WRITABLE OR CONFIGURABLE (F-267). The versioning rules call these two not
// removable by a TASK, and until now they were the least protected things in the file:
// `logger.child = pinoChild` replaced one permanently, on the singleton every later TASK
// imports, with nothing in the suite or the drift test able to see it. Under a non-writable
// descriptor that assignment is a `TypeError` — this module graph is ES modules, so it is
// strict everywhere. WHAT THIS DOES NOT DO, stated so the claim is not read as wider than it
// is: `Object.getPrototypeOf(logger).child.call(logger, …)` still reaches pino's unwrapped
// original, and no property descriptor can change that. That is hardening against the
// accident, not a boundary against a call site that means it.
Object.defineProperty(logger, 'child', {
  value: childWithErrorsReplaced,
  writable: false,
  enumerable: false,
  configurable: false,
});

Object.defineProperty(logger, 'setBindings', {
  value: setBindingsWithErrorsReplaced,
  writable: false,
  enumerable: false,
  configurable: false,
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
 * (A fourth was listed here and is now CLOSED: `setBindings` is wrapped, F-258.)
 *
 *   1. AN ERROR AT DEPTH 5 OR DEEPER is not replaced — the bound above. Same limit
 *      `REDACT_PATHS` has for a nested secret, same answer: raise it.
 *   2. AN ERROR HELD INSIDE A CLASS INSTANCE is not replaced (F-255), because `isWalkable`
 *      declines to walk one — see it for why. `JSON.stringify` serialises a class instance's
 *      own enumerable properties happily, so `{ ctx: new Ctx(parseFailure) }` puts the raw
 *      body on the line even at depth 1. The answer for a TASK that needs it is to log the
 *      fields it wants rather than the instance, or to widen `isWalkable` deliberately and
 *      pay the `Buffer` cost it exists to avoid.
 *   3. AN ERROR RETURNED BY A `toJSON` METHOD is not replaced (F-265), and this is NOT
 *      residual 2 with a different container. THIS SCAN INSPECTS PROPERTIES;
 *      `JSON.stringify` CONSULTS `toJSON` AND THEN NEVER LOOKS AT THEM. So
 *      `{ ctx: { toJSON: () => e } }` is a PLAIN object, `isWalkable` returns true, the walk
 *      goes through it, finds one key holding a function, replaces nothing — and the error
 *      appears at stringify time regardless. Reproduced both on the plain object and on a
 *      class with a `toJSON`. Residual 2's remedies do not describe it: widening
 *      `isWalkable` is irrelevant to the plain form, and for the class form it would remove
 *      the leak only by dropping `toJSON` from the copy, silently changing what the line
 *      looks like. The answer for a TASK that needs it is the same as residual 2's first
 *      one — log the fields, not the object that knows how to serialise itself.
 *
 * NOT A RESIDUAL, AND THE REASON IT IS WORTH SAYING SO: BOTH BINDINGS PATHS ARE COVERED.
 * `logger.child` and `logger.setBindings` are the two entries to `asChindings` and both are
 * wrapped above. A shape that leaks through a THIRD entry, should pino ever grow one, belongs
 * on this list — not in a comment saying the two known ones are handled.
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
 * (F-244's second minor). Reading one here must not throw, and must not change what pino
 * writes for that key either — so the scan skips it and leaves pino's own stringify to
 * handle it exactly as it did before this function existed.
 *
 * WHAT THIS GUARD IS AND IS NOT (F-259). It stops THIS READ from throwing. IT DOES NOT MAKE
 * THE SCAN THROW-FREE, and the docblock here used to imply that it did. When some OTHER key
 * in the same container changed, `errorsReplaced` builds the copy with `{ ...container }`,
 * which re-reads every enumerable key — the hostile one included — outside this `try`. So
 * does `errorMovedOntoTheRecord`'s spread of the caller's record. THE OBSERVABLE OUTCOME IS
 * UNCHANGED FROM BARE PINO, which reads every key in `_asJson` with no guard at all and
 * throws from there, so this is not a hazard the module added; a key-by-key copy would
 * remove one of the four throw sites and leave `_asJson`, fast-redact's `cloneSelectively`
 * and `asChindings` untouched (F-253).
 *
 * WHAT THAT MEANS FOR A CALL SITE, which is the reason the claim had to be corrected rather
 * than left: a place with nowhere left to escape to — the exception filter's `headersSent`
 * arm, `main.ts`'s boot handler, anything on a GC-8 path — still needs its own `try/catch`
 * around a log call whose record it did not build itself. This module does not supply that.
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
