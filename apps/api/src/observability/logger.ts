/**
 * Contract: docs/contracts/logging-and-headers.md
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
 * ============================================================================
 * EVERY KEY THAT MAY CARRY A VALUE ONTO A LOG LINE. NOTHING ELSE SURVIVES (ADR-0028).
 * ============================================================================
 *
 * This replaces `REDACT_PATHS`, a list of 25 paths to censor, and it inverts the polarity:
 * a field reaches a line only if it is NAMED here, and every other key is emitted as
 * `[redacted]`. The denylist failed three audit rounds the same way — it covered the
 * spellings someone had thought of. `err.body` (F-244), then `clientIp`,
 * `trustedClientIp`, `remoteAddress`, `ipAddress` (F-262), then `sessionToken`, `apiKey`,
 * `api_key`, `passwordHash` and a bare `authorization` or `cookie` (F-266). Appending each
 * round's newly-found names produces a longer list with the same property: the next name
 * nobody thought of is emitted in the clear.
 *
 * THE FAILURE MODE IS NOW A MISSING FIELD RATHER THAN A LEAKED ONE, and the missing field
 * NAMES ITSELF on the line: `"attemptCount":"[redacted]"`, never a dropped key. That
 * visibility is the whole mitigation for what this costs, so it is a rule and not an
 * accident — see `fieldsCensored`.
 *
 * APPEND-ONLY (`logging-and-headers.md`, "Versioning"), and a name may be appended only
 * after it has been checked against "What may never appear in a log line". If a field is a
 * raw IP, a token, a password, a digest, a request body, a concrete URL path or a foreign
 * `tenant_id`, the answer is not to name it here — it is that the field may not be logged.
 * REMOVING a name silently censors a field that was on the line yesterday, so it needs the
 * same reason in the commit message that adding one does.
 *
 * ONE NAME PER LINE, KEPT SORTED, with the owning file in a trailing comment. Every TASK
 * that logs a new field edits this one list, so wave-parallel TASKs collide here — and a
 * merge conflict on a one-name-per-line list resolves by keeping both.
 *
 * `err_name`, `err_message` and `err_stack` are `error-envelope.md`'s names, so renaming
 * any of them now CENSORS it as well as breaking every saved log query.
 */
export const LOGGABLE_FIELDS: ReadonlySet<string> = new Set([
  'attempt', // main.ts, boot retry
  'boot_precondition', // main.ts, F-245
  'code', // exception-filter.ts, a DomainError code (error-envelope.md)
  'duration_ms', // logging-and-headers.md, Required fields
  'err_message', // ErrorLogFields, spread into records by logError and main.ts
  'err_name', // ErrorLogFields
  'err_stack', // ErrorLogFields
  'msg', // pino's messageKey, when a call site supplies its own
  'request_id', // logging-and-headers.md, Required fields
  'retry_in_ms', // main.ts, boot retry
  'route', // logging-and-headers.md, Required fields. The PATTERN, never a path
  'status', // logging-and-headers.md, Required fields
  'template', // mail/senders/*.ts, a MailTemplate literal (mail-sender.md, "Signal")
  'tenant_id', // logging-and-headers.md, Required fields
]);

/**
 * What an unnamed key carries instead of its value. The name and the value both stay
 * verbatim through ADR-0028: log queries and the byte-level tests key on `[redacted]`, and
 * this is still redaction — only its polarity changed.
 */
export const REDACT_CENSOR = '[redacted]';

/**
 * What `msg` says when a call site logged an error and nothing else. It names the call
 * shape rather than the error, because naming the error is what leaks — and the fields the
 * `err` serialiser built are on the same record.
 */
const POSITIONAL_ERROR_MESSAGE = 'an error was logged with no context string';

/**
 * The one logger in the API. Every line the process writes goes through it, which is what
 * makes the allowlist above a mechanism rather than a convention.
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
 * this repository's own pino 10.3.1 before the override, and the denylist did not reach
 * it: `err.body` is a string, and a path list cannot reach inside one.
 *
 * Routing the key through `errorLogFields` makes that misuse impossible UNDER THAT KEY
 * rather than enumerating the fields to censor: the record carries the three fields the
 * policy below builds and no fourth, whatever the error happens to hang off itself.
 * Appending `err.body` to a path list was the alternative and is weaker — it defends the
 * one property that has already been found, and the next library to decorate an error gets a
 * new name. ADR-0028 is that argument applied to the path list as a whole.
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
 *
 * THERE IS NO `redact` OPTION, AND ITS ABSENCE IS DELIBERATE (ADR-0028). Every one of the
 * 25 paths named a key that is not on `LOGGABLE_FIELDS`, so the list is subsumed by the
 * scan; keeping it would cost a measured 2.7 µs per line for no coverage the scan does not
 * already have, and would leave in the codebase the one mechanism whose "just append a
 * path" reflex produced F-261, F-262 and F-266. TWO CENSORING MECHANISMS WITH OPPOSITE
 * POLARITY IS ALSO A COMPREHENSION HAZARD: it is what let a reader of the six
 * `req.headers.*` paths conclude that logging a whole request was a covered act. The cost
 * accepted with it is real — `redact` was a second layer that would have survived a bug in
 * the scan, and after this there is exactly one mechanism between an unnamed field and the
 * line. That is why `childOptionsChecked` below is load-bearing rather than hardening.
 */
export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: { service: 'shortkit-api', env: process.env.NODE_ENV },
  formatters: {
    level: (label) => ({ level: label }),
    log: (record) => fieldsCensored(record, 1),
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
 * NOTHING SITS BEHIND THIS, AND SINCE ADR-0028 THAT IS LITERAL. `formatOpts.stringify` used
 * to be the REDACTING stringifier, so an interpolated object got the path list applied —
 * which did not help for F-244's reason, that the payload is a STRING and no path reaches
 * inside one, and `%s` bypassed `stringify` altogether. With `redact` gone the only policy
 * on this path is the one below.
 *
 * WHAT THIS DOES: every argument position pino reads goes through a policy before pino
 * formats anything, and ONE POSITION GETS ONE POLICY (ADR-0028, "The argument list: one
 * policy per position"). The order below is the order the ADR's table states it.
 *
 *   - A NON-NULL OBJECT IN THE MESSAGE POSITION is moved onto the record under `err`,
 *     WHATEVER ITS TYPE — an `Error`, a plain container, an array, a class instance — where
 *     `serializers.err` owns it, and the message becomes the fixed string the positional
 *     branch already uses. It is decided by its TYPE and not by its keys, so nothing of it
 *     reaches the line but `err_name` and, for a real `Error`, the frames. F-277: reducing
 *     it in place instead was rejected, because `format` returns a non-string message
 *     unchanged — `msg` would be an object rather than a line an aggregator can index — and
 *     because a container handed to pino's stringifier is emitted through a `toJSON` the
 *     scan cannot see. The caller loses the payload: pass `{ err }` with a fixed context
 *     string, or name the fields worth having and put them on the record.
 *   - ANYTHING ELSE IN THE MESSAGE POSITION — a string, a number, `null`, a function —
 *     reaches `msg` verbatim. A string is free text and no censoring scheme reaches inside
 *     one; `null` carries nothing onto a line, and describing an absence as a throwable is
 *     worse than leaving it.
 *   - AN `Error` IN A FORMAT-PARAMETER POSITION becomes `errorLogFields(…)`, so `%o` and
 *     `%j` interpolate the name and the frames and nothing else. `%s` on that object reads
 *     `[object Object]`: a placeholder is the wrong way to hand this logger an error, and
 *     `log.error({ err }, 'context')` is the shape that gives the operator the fields.
 *   - A CONTAINER IN A FORMAT-PARAMETER POSITION is scanned, so `logger.error('ctx %o',
 *     { err: e })` — the auditor's own reproduction — is covered as well.
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
  //
  // `messageArgumentIndex` returns 0 only when `args[0]` is neither an object nor `undefined`,
  // so the message argument can be a container only at index 1. `null` is excluded: it carries
  // nothing onto a line, and describing an absence as a throwable is worse than leaving it.
  const covered =
    message === 1 && typeof args[1] === 'object' && args[1] !== null
      ? errorMovedOntoTheRecord(args)
      : args;

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
 * `log.error(record, error)`. The value in the message position is filed under `err`, where
 * `serializers.err` reduces it to the policy fields — the three fields for an `Error`,
 * `err_name` alone for anything else — and the message becomes the string a positional error
 * already gets. Its caller decides WHICH values come here (F-277: every non-null object,
 * not only an `Error`); this function is the same move for all of them.
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
 * the record path.
 *
 * A format argument ARRIVES UNDER NO KEY, so it goes through `valueCensored` — the value
 * half of the policy — rather than through the key rule: `logger.error('a %s', 'b')` has to
 * interpolate `b`, and there is no field name to decide about. A CONTAINER it holds is then
 * walked by `fieldsCensored` at `depth + 1`, so its own keys are decided normally.
 *
 * ONE, AND THE `+ 1` IS THE LOAD-BEARING PART. The depth-1 skip of the top-level `err` key
 * exists only because `serializers.err` runs after `formatters.log` and owns that key;
 * nothing runs after `format`, so the same exemption here would be a hole rather than a
 * seam — `logger.error('ctx %o', { err: e })` is the shape it leaks through. An
 * interpolated container is therefore walked from 2, where the exemption does not apply,
 * and the price is one level of reach.
 */
const FORMAT_ARGUMENT_SCAN_DEPTH = 1;

/** The policy applied to one value pino is about to interpolate. */
function interpolationSafe(value: unknown): unknown {
  return valueCensored(value, FORMAT_ARGUMENT_SCAN_DEPTH);
}

/**
 * ============================================================================
 * BINDINGS GO THROUGH THE SAME SCAN, BECAUSE PINO WILL NOT RUN IT (F-251, F-258).
 * ============================================================================
 *
 * "THE SAME SCAN" IS WIDER SINCE ADR-0028 AND THE MECHANISM IS UNCHANGED. These two
 * wrappers are one of the two places a line is built, so they are one of the two places the
 * field allowlist is enforced; a key that is not named is censored in bindings exactly as it
 * is in a record, and an `Error` under any key is still reduced to the policy fields.
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

const childWithFieldsCensored: ChildFactory = function childWithFieldsCensored(bindings, options) {
  return inheritedChild.call(this, bindingsScanned(bindings), childOptionsChecked(options));
};

const setBindingsWithFieldsCensored: BindingsSetter = function setBindingsWithFieldsCensored(
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
  return bindings ? fieldsCensored(bindings, 1) : bindings;
}

/**
 * ============================================================================
 * A CHILD'S `options` ARE AN OPT-OUT OF THIS WHOLE MODULE, SO THEY ARE REFUSED (F-263).
 * ============================================================================
 *
 * pino's `child(bindings, options)` does not merge these three with the instance's own; it
 * REPLACES them, and all three were reproduced against this singleton:
 *
 *   - `redact` — `proto.js:157-165`, comment "replace redact directly". This root no longer
 *     sets one (ADR-0028), so a child supplying `redact` removes nothing today — it is
 *     refused anyway, because a censoring option the root does not hold is a second policy
 *     with the opposite polarity to this module's, applied to one subtree, and the
 *     comprehension hazard that produced F-261, F-262 and F-266 is exactly that.
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
 * so nothing that runs today reaches it. ADR-0028 MADE THIS LOAD-BEARING RATHER THAN
 * HARDENING, and its Migration says so: `redact` is gone, so a child-supplied
 * `formatters.log` is now the ONLY thing that would stand between a record and the line.
 * There is nothing behind this refusal.
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

  const replaced = OPTIONS_A_CHILD_MAY_NOT_REPLACE.filter((option) =>
    pinoWouldReplace(supplied, option),
  );

  if (replaced.length > 0) {
    throw new TypeError(
      `a child logger may not supply its own ${replaced.join(', ')}: pino replaces the ` +
        `logger's own rather than merging, so this child would lose the controls that keep ` +
        `an error's incidental fields, a credential and an IP off every line it writes. ` +
        `See docs/contracts/logging-and-headers.md.`,
    );
  }

  return options;
}

/**
 * WHETHER PINO WOULD REPLACE THIS OPTION, READ THE WAY PINO READS IT (F-279). One predicate
 * for all three was one predicate too few: `Object.hasOwn` matches pino for two of them and
 * for neither of the two shapes below.
 *
 *   - `redact` — `proto.js:161`, `typeof options.redact === 'object' && options.redact !== null`
 *     (its `Array.isArray` arm is subsumed: an array is a non-null object). That is an
 *     ORDINARY PROPERTY READ, so it WALKS THE PROTOTYPE CHAIN. Measured: a child whose
 *     options carry `redact` on their prototype was accepted here and installed by pino, and
 *     the line then lost a named field entirely — invariant 8 false for that subtree, under a
 *     censoring policy with the opposite polarity to this module's.
 *   - `serializers` (`proto.js:115`) and `formatters` (`:136`) — pino calls
 *     `options.hasOwnProperty(…)` AS A METHOD ON THE OPTIONS OBJECT, so an options object
 *     that answers for itself takes pino's replacing branch while `Object.hasOwn` correctly
 *     says no. Measured: a lying `hasOwnProperty` installed a child `formatters.log` and
 *     removed the scan at every key and every depth — a `password` and a raw `ip` verbatim.
 *
 * THE UNION OF BOTH READS, NOT PINO'S ALONE, and deliberately: `Object.hasOwn` keeps
 * `{ serializers: undefined }` and `{ redact: undefined }` refused, and refusing an option
 * pino would not have replaced costs a child logger nobody builds, while missing one costs
 * the only mechanism left between an unnamed field and the line. The read is guarded because
 * a getter here is free to throw and this runs before pino has touched the object; a throw
 * would answer neither `true` nor `false`, and pino's own read is where that hazard belongs.
 */
function pinoWouldReplace(supplied: object, option: string): boolean {
  if (Object.hasOwn(supplied, option)) {
    return true;
  }

  if (option === 'redact') {
    const value = readIndexedProperty(supplied, option);

    return typeof value === 'object' && value !== null;
  }

  return suppliedClaimsOwnProperty(supplied, option);
}

/** `options.hasOwnProperty(option)`, called the way pino calls it and unable to throw. */
function suppliedClaimsOwnProperty(supplied: object, option: string): boolean {
  try {
    const claim = (supplied as { hasOwnProperty?: (key: string) => unknown }).hasOwnProperty;

    return typeof claim === 'function' && Boolean(claim.call(supplied, option));
  } catch {
    return false;
  }
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
  value: childWithFieldsCensored,
  writable: false,
  enumerable: false,
  configurable: false,
});

Object.defineProperty(logger, 'setBindings', {
  value: setBindingsWithFieldsCensored,
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
 * How far in the scan looks. A CONTAINER AT OR BELOW THIS DEPTH IS CENSORED, NOT WALKED —
 * which is the inversion ADR-0028 turns on, and the reason the depth bound stopped being a
 * residual. It used to mean "past here, pass it through"; it now means "past here, redact".
 *
 * Four. `{ ctx: { err: e } }` — F-248's third shape — puts a value at depth 2, so one level
 * is not enough, and an unbounded walk runs on every line the process writes. Four covers
 * every nesting a call site in this repository builds — every one is flat today — with a
 * level of slack, and it bounds the work whatever a call site hands the logger. The bound
 * also makes a self-referential record terminate, which a walk without one would not.
 *
 * WHAT DEEPENING IT COSTS AND BUYS is now the opposite of what it was. Raising it does not
 * close a leak; it lets a DEEPER NAMED FIELD keep its value. Lowering it censors more.
 * Either way it is additive to safety, so the versioning rule that made lowering a removal
 * has inverted with it — see `logging-and-headers.md`, "Versioning".
 *
 * MEASURED, pino 10.3.1 and Node 24.19, against a prototype of this configuration and
 * against the one that shipped before it, one million calls per figure: the allowlist scan
 * costs 45 ns on a flat request-log record against the denylist scan's 31 ns, because it
 * does a `Set` lookup per key — and 31 ns against 78 ns on a record carrying `req.headers`,
 * 26 ns against 66 ns on a record nested five deep, because a denied key is censored without
 * walking what is under it. The whole log call fell from 4295 ns to 1706 ns on a flat record,
 * because removing `redact` refunds more than this spends. Re-measured on this commit; see
 * the round's report. Against GC-1's 25 ms ceiling one line is 0.007%.
 *
 * TWO OF THE THREE RESIDUALS THIS USED TO CARRY ARE CLOSED. An error at depth 5 (residual 1)
 * and an error inside a class instance (F-255, residual 2) both reached a line carrying
 * whatever a library had assigned, because "the scan cannot inspect this" meant "emit it
 * whole". It now means `[redacted]`. What replaces them is not a leak but a DIAGNOSTIC LOSS,
 * and it is stated as a cost rather than as a residual: an `Error` nested inside a container
 * that is not a named field — `{ ctx: { err: e } }` — is censored WITH its container instead
 * of being reduced to `err_name` and `err_stack`. The remedy is the one the contract already
 * prescribes: pass the error at the top level.
 *
 * THE THIRD RESIDUAL IS NOT CLOSED, and neither the depth bound nor the inversion reaches it.
 * F-265 — a value emitted from an own non-enumerable `toJSON` — arrives on a container this
 * scan CAN inspect, so it is walked rather than censored; see `valueCensored` below for the
 * mechanism. MEASURED at round 7 across thirteen routes: two are closed, both of them message
 * position, and NINE STILL EMIT `toJSON`'s RETURN VALUE — a named key at depth 2 and at depth
 * 3, child bindings, grandchild bindings, `setBindings`, `%o`, `%j`, `%O`, and an array
 * element under a named key. Open and narrowed, and carried as such in ADR-0028 under "What
 * this ADR does not decide".
 */
const MAX_SCAN_DEPTH = 4;

/**
 * ============================================================================
 * A FIELD REACHES A LOG LINE ONLY IF ITS KEY IS NAMED (ADR-0028), AND EVERY `Error`
 * REACHES IT ONLY AS THE POLICY FIELDS (F-248).
 * ============================================================================
 *
 * Two rules, in this order, and the ORDER IS THE POINT:
 *
 *   1. AN `Error` VALUE IS REDUCED BY `errorLogFields` WHATEVER ITS KEY, and the key check
 *      never runs on it. `serializers` is keyed by field name, so the override in the
 *      literal above covers `err` and nothing else — that was F-244 one level up:
 *      `{ error: e }`, `{ cause: e }` and `{ ctx: { err: e } }` all reach pino's ordinary
 *      object path, where `message` and `stack` do not survive (non-enumerable) but
 *      body-parser's ASSIGNED `body` does. An error is a VALUE WITH A POLICY, not a field
 *      with a name, and that is the one guarantee that has survived every round.
 *   2. EVERY OTHER KEY SURVIVES ONLY IF `LOGGABLE_FIELDS` NAMES IT. Anything else is
 *      `REDACT_CENSOR`, whatever it holds and however deep it goes.
 *
 * THE KEY STAYS ON THE LINE. `"attemptCount":"[redacted]"`, never a dropped key: the
 * operator sees which field exists, what it is called, and that one line in
 * `LOGGABLE_FIELDS` is what it needs. That is the whole mitigation for what ADR-0028 costs.
 *
 * `undefined` IS LEFT ALONE, because `JSON.stringify` drops a key whose value is
 * `undefined` — censoring it would ADD a field where none appeared and send an operator
 * looking for a value that was never there.
 *
 * A PROPERTY WHOSE GETTER THROWS IS CENSORED, NOT SKIPPED. Skipping left the key in the
 * record for pino to read again, so a getter that threw once and returned a credential on
 * the second read put it on the line — under an allowlist that would be a counterexample to
 * the whole guarantee. What this does NOT fix: the `{ ...record }` copy re-invokes the
 * getter and the log call still throws with no line emitted (F-253, F-259).
 *
 * WHAT EACH MECHANISM OWNS, AND WHY THE SPLIT. MEASURED, pino 10.3.1 `lib/tools.js`
 * `_asJson`: `formatters.log` runs BEFORE the per-key serialisers, on the same merged
 * record. So an error this function replaced at the top-level `err` key would then be
 * handed to `serializers.err` as an ordinary object and come out
 * `non-error throwable (object)`. The two therefore partition the record:
 *
 *   - `serializers.err` owns the top-level `err` key. It also covers a NON-error under that
 *     key, which this function deliberately does not — and its output is three named fields
 *     by construction, so the allowlist neither sees it nor needs to.
 *   - this function owns every other key, at every depth up to `MAX_SCAN_DEPTH` — including
 *     `err` nested below the root.
 *
 * There is no key between them.
 *
 * WHAT THE SUITE PINS, EXACTLY (F-254 — this paragraph used to claim more). MEASURED by
 * striking each half of the partition and running `logger.spec.ts`: neither half can be
 * removed on its own. Removing BOTH TOGETHER, which is the "these two mechanisms overlap,
 * let me unify them" refactor and the one a later reader is most likely to attempt, fails
 * exactly ONE test: the non-`Error` under the top-level `err` key. That single case is what
 * makes this a partition rather than a redundancy, and it is the only thing standing between
 * that refactor and F-244's shape coming back under `err`. (The counts move as tests are
 * added; the shape is what matters.)
 *
 * IT DESCENDS INTO NOTHING IT REPLACES, WHICH IS WHY `err.cause` STAYS SHUT. A chained
 * error is reachable only through `cause`, which is own but non-enumerable when set through
 * the `Error` constructor, so nothing walked it before this change. `errorLogFields` is the
 * boundary: it reads `name`, `message` and `stack` and returns, so an error replaced here is
 * never a container to walk. Asserted in `logger.spec.ts`.
 *
 * The record is not mutated: a container is copied only if one of its values changed, so a
 * line whose fields are all named and all primitive allocates nothing and the caller's
 * object is never touched.
 *
 * ONE DEVIATION FROM ADR-0028's NORMATIVE FENCE, AND IT IS ONE TERNARY. The ADR's copy is
 * `{ ...record }`; this one keeps the array branch `errorsReplaced` had, and the reason is
 * TYPE SOUNDNESS RATHER THAN EMITTED BYTES (F-275). The signature is
 * `<T extends object>(record: T): T`, and spreading an array into an object literal produces
 * an object keyed `"0"`, `"1"` — which is exactly what the return type asserts it is not, so
 * the `as T` beside it would be a lie. WHAT AN OPERATOR READS IS IDENTICAL EITHER WAY,
 * MEASURED ON BOTH FORMS: `_asJson` writes own enumerable keys, and an array's are its
 * indices. Contract invariant 5 names `[e, e]` as a covered shape and it stays covered under
 * either copy. An array reached through a NAMED KEY does not come here at all —
 * `valueCensored` routes it to `elementsCensored`, where an index is correctly not treated
 * as a field name.
 */
function fieldsCensored<T extends object>(record: T, depth: number): T {
  let replacement: T | undefined;

  for (const key of Object.keys(record)) {
    // The seam with `serializers.err`. Required, not stylistic: see the partition above.
    if (depth === 1 && key === ERROR_KEY) {
      continue;
    }

    const value = readIndexedProperty(record, key);

    if (value === undefined) {
      continue;
    }

    const replaced =
      value === UNREADABLE_PROPERTY
        ? REDACT_CENSOR
        : value instanceof Error
          ? errorLogFields(value, { includeMessage: false })
          : LOGGABLE_FIELDS.has(key)
            ? valueCensored(value, depth)
            : REDACT_CENSOR;

    if (replaced !== value) {
      replacement ??= (Array.isArray(record) ? [...record] : { ...record }) as T;
      (replacement as Record<string, unknown>)[key] = replaced;
    }
  }

  return replacement ?? record;
}

/**
 * The policy for a value whose key has already been allowed, or that arrived under no key at
 * all — an array element, or a format argument.
 *
 * A CONTAINER THIS CANNOT INSPECT IS CENSORED, NOT PASSED THROUGH. A class instance, a
 * `Buffer`, anything at or past `MAX_SCAN_DEPTH`: `[redacted]`. That is the inversion, and it
 * is what closes residuals 1 and 2.
 *
 * IT DOES NOT CLOSE F-265's `toJSON` MECHANISM, and the reason is that the mechanism arrives
 * on a container this CAN inspect. A plain object carrying an own non-enumerable `toJSON` has
 * `Object.prototype`, so it is walked; if its own enumerable keys are all named or absent,
 * nothing is replaced, `fieldsCensored` returns it BY REFERENCE, and `JSON.stringify` then
 * serialises it from `toJSON`'s return value — which no scan over keys ever saw. MEASURED at
 * round 7 across thirteen routes: nine still emit that return value (a named key at depth 2
 * and at depth 3, child bindings, grandchild bindings, `setBindings`, `%o`, `%j`, `%O`, and an
 * array element under a named key), and the two message-position routes are closed by F-277's
 * fix. F-265 stays OPEN AND NARROWED — ADR-0028, "What this ADR does not decide".
 *
 * A class instance is declined for the reason it always was — `Object.keys` on a `Buffer` is
 * thousands of index strings — and the answer for a TASK that needs one logged is unchanged:
 * log the fields it wants, not the object.
 */
function valueCensored(value: unknown, depth: number): unknown {
  if (value instanceof Error) {
    return errorLogFields(value, { includeMessage: false });
  }

  if (typeof value !== 'object' || value === null) {
    return value;
  }

  if (depth >= MAX_SCAN_DEPTH) {
    return REDACT_CENSOR;
  }

  if (Array.isArray(value)) {
    return elementsCensored(value, depth + 1);
  }

  const prototype: unknown = Object.getPrototypeOf(value);

  return prototype === Object.prototype || prototype === null
    ? fieldsCensored(value, depth + 1)
    : REDACT_CENSOR;
}

/**
 * An array's elements, each through `valueCensored` and NONE through the key rule: AN ARRAY
 * INDEX IS NOT A FIELD NAME. A scan that ran the key check on `'0'` and `'1'` would censor
 * every element of every array — no allowlist will ever name an index — and turn a named
 * field holding a list into `["[redacted]","[redacted]"]` with the whole suite green.
 *
 * An OBJECT inside an array is walked by `fieldsCensored`, so its own keys are decided
 * normally. Measured: `{ request_id: 'r-1', route: ['a', { password: 'P' }] }` emits
 * `"route":["a",{"password":"[redacted]"}]`.
 */
function elementsCensored(elements: readonly unknown[], depth: number): readonly unknown[] {
  let replacement: unknown[] | undefined;

  for (let index = 0; index < elements.length; index += 1) {
    const value = readIndexedProperty(elements, String(index));
    const replaced = value === UNREADABLE_PROPERTY ? REDACT_CENSOR : valueCensored(value, depth);

    if (replaced !== value) {
      replacement ??= [...elements];
      replacement[index] = replaced;
    }
  }

  return replacement ?? elements;
}

/** A property whose getter threw. Censored rather than skipped; see `fieldsCensored`. */
const UNREADABLE_PROPERTY = Symbol('unreadable property');

/**
 * A log record's own values are free to be hostile getters, the same way an error's are
 * (F-244's second minor). Reading one here must not throw.
 *
 * WHAT THIS GUARD IS AND IS NOT (F-259). It stops THIS READ from throwing. IT DOES NOT MAKE
 * THE SCAN THROW-FREE. When some OTHER key in the same container changed, `fieldsCensored`
 * builds the copy with `{ ...record }`, which re-reads every enumerable key — the hostile
 * one included — outside this `try`. So does `errorMovedOntoTheRecord`'s spread of the
 * caller's record. THE OBSERVABLE OUTCOME IS UNCHANGED FROM BARE PINO, which reads every key
 * in `_asJson` with no guard at all and throws from there, so this is not a hazard the
 * module added; a key-by-key copy would remove one of the throw sites and leave `_asJson`
 * and `asChindings` untouched (F-253).
 *
 * WHAT IT DOES BUY, AND THIS CHANGED WITH ADR-0028: the key whose read threw is now emitted
 * as `[redacted]` rather than left for pino to read a second time. A getter that throws once
 * and answers with a credential on the next read used to put it on the line.
 *
 * WHAT THAT MEANS FOR A CALL SITE: a place with nowhere left to escape to — the exception
 * filter's `headersSent` arm, `main.ts`'s boot handler, anything on a GC-8 path — still
 * needs its own `try/catch` around a log call whose record it did not build itself. This
 * module does not supply that.
 */
function readIndexedProperty(container: object, key: string): unknown {
  try {
    return (container as Record<string, unknown>)[key];
  } catch {
    return UNREADABLE_PROPERTY;
  }
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
 *   - A PATH LIST DID reach `err.message` and `err.stack` once an error had been serialised
 *     into an object; `logging-and-headers.md` said it could not, and that was wrong in one
 *     direction. What no censoring scheme can do — the denylist that shipped until ADR-0028
 *     or the allowlist that replaced it — is reach INSIDE either string, so the choice is
 *     per-field and all-or-nothing. That is why the answer is which fields to build.
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
