# Contract: structured logging, redaction, CORS, and security headers

- **Boundary:** every log line the API emits; every response header it sets.
- **Normative form:** `apps/api/src/observability/logger.ts` and `apps/api/src/main.ts`. This contract's § "Logger" fence is the single normative statement of the logger's configuration and is compared to the shipped file by a drift test. The wave-1 stub at `design/stubs/apps/api/src/observability/logger.ts` is **superseded** (F-249) and its config is unsafe to copy; ADR-0022 no longer carries a copy at all (F-250).
- **Produced by:** TASK-003.
- **Consumed by:** every API TASK. Nothing may opt out.
- **ADRs:** ADR-0022. Enforces GC-9.

## Logger

Amended 2026-08-08 (F-242, F-244, F-248, F-249), again 2026-08-08 fix round 3 (F-250, F-251,
F-252, F-253, F-255, F-258), and again 2026-08-09 fix round 4 (F-259, F-260, F-263, F-265,
F-267, F-269). The block below matches the shipped
`apps/api/src/observability/logger.ts` on pino 10.3.1.

**This contract is the single normative source for the logger's configuration.** ADR-0022
used to fence a copy of it and no longer does (F-250); the wave-1 stub at
`design/stubs/apps/api/src/observability/logger.ts` is superseded and unsafe to copy
(F-249). One configuration living in three artifacts is what produced F-244, F-248, F-249
and F-250 in sequence.

**Four mechanisms in the literal, plus three things under it the literal cannot express, and
every one of them is load-bearing.**

| Mechanism | Covers | Section |
|---|---|---|
| `redact` | fields you can name, one wildcard level | "Why each mechanism is here" |
| `serializers.err` | the top-level `err` key, including a non-error under it | "Why each mechanism is here" |
| `hooks.logMethod` | every call shape that would put an error's message into `msg` — the record, and every argument position pino formats | "Why each mechanism is here", "Door six" |
| `formatters.log` | every other key of the record, to depth 4 | "The ordering" |
| the `logger.child` wrapper | bindings, on the other path a line is built by | "The two wrappers" |
| the `logger.setBindings` wrapper | the second entry to the same path | "The two wrappers" |
| `childOptionsChecked` | a child that tries to replace `redact`, `serializers` or `formatters` | "The two wrappers" |

Read the sections named before editing any of them. Removing one reopens a leak that already
shipped once, and `apps/api/src/observability/logger.spec.ts` fails on each.

### PENDING: redaction becomes a field allowlist (ADR-0028)

**Filed 2026-08-09, not yet implemented, and the fenced block below is deliberately
unchanged.** ADR-0028 replaces `REDACT_PATHS` and pino's `redact` option with
`LOGGABLE_FIELDS`: a field reaches a log line only if its key is named, and every other key
is emitted as `[redacted]`. It was written because the 25-path list has failed three audit
rounds the same way — it covers the spellings someone thought of (F-244's `err.body`,
F-262's `clientIp`/`trustedClientIp`/`remoteAddress`, F-266's `sessionToken`/`apiKey`/
bare `authorization`) — and appending the newly-found names buys a fourth round.

**Until ADR-0028 is approved and implemented, everything below this block describes what
ships, including the parts ADR-0028 measured false.** The fence is compared to
`apps/api/src/observability/logger.ts` by a drift test, so amending it ahead of the source
would turn a passing gate red for the length of the gap. The source, the fence and this
section change in one commit.

What changes when it lands, so a reader of the sections below knows which of them are
provisional:

- `REDACT_PATHS` and the `redact` option are removed. The 25 paths move into "What may never
  appear in a log line" as names that must never be added to `LOGGABLE_FIELDS`.
- "Which casing `REDACT_PATHS` is keyed to" and its `ip_hash` residual stop being
  load-bearing: an unnamed snake_case key is censored like every other unnamed key.
- The residuals under "The residuals" close. A container the scan cannot inspect — past the
  depth bound, a class instance, anything carrying `toJSON` (F-265) — is censored rather than
  passed through.
- **Invariant 1 becomes true** for a stronger reason than it states: a whole request object
  does not reach the line at all.
- **Invariant 5 narrows.** An `Error` at depth 1 still emits `err_name` and `err_stack` under
  any key spelling, because an `Error` value is reduced by policy before any key decision.
  An error nested under a key that is not named — `{ ctx: { err: e } }` — is censored with
  its container and lost, rather than reduced. Measured: `"ctx":"[redacted]"`.
- **F-263 becomes a precondition.** `logger.child(b, { formatters: { log: (o) => o } })`
  disables the scan for that child, and after `redact` is removed nothing sits behind it.
  The child-options rejection lands first or in the same commit.

### The block below is machine-checked against the shipped file

The fence is the **normative region**: `apps/api/src/observability/logger.ts` from its
`import` through the end of `isWalkable`, which is the whole logger configuration and the
scan. Everything after `isWalkable` in that file — `RequestLogFields`, `ErrorLogFields`,
`errorLogFields` and its helpers — belongs to `error-envelope.md` and is deliberately not
reproduced here.

The comparison, implemented by `apps/api/src/observability/logger-contract-drift.spec.ts`:
strip comments from both sides and collapse each run of whitespace **outside a string** to a
single space, then cut the region out of the source between two anchors and compare it to the
fence for **equality**. The anchors are the literal text `import pino from 'pino';` and
`export interface RequestLogFields`, the first declaration `error-envelope.md` owns rather
than this one. Whitespace inside a string is left alone, because the strings are the payload
here — redact paths, the censor, the fixed context message.

Comments are stripped on both sides, so the explanatory comments inside the fence are free
and may differ from the source's docblocks. Everything else fails: a reordered declaration, a
changed redact path, a different depth bound, a dropped wrapper.

**Equality between anchors rather than substring containment, and the difference matters
(F-270).** A substring is open at both ends, so dropping the last declaration from the fence
left a shorter needle that was still found, and adding a declaration to the source just after
the region left the same needle found in a longer haystack. Both stayed green when measured
on copies, and the end of the region is exactly where a new wrapper gets appended — which is
the shape F-251 and F-258 both had. **Anything a later round inserts before
`RequestLogFields` is inside the region by this contract's definition and belongs in the
fence.**

**When this block and the shipped file disagree, the shipped file wins and the divergence
is a finding.** A TASK that changes the logger updates this block in the same commit, and
the drift test is what stops it shipping without doing so.

```ts
import pino from 'pino';

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
  // The top-level halves of the wildcards above (F-244). A pino wildcard matches exactly
  // one level, so `*.password` does not reach a `password` key on the record itself, and
  // the record itself is where a call site that spreads a parsed body reaches first.
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

/** What `msg` says when a call site logged an error and nothing else. */
const POSITIONAL_ERROR_MESSAGE = 'an error was logged with no context string';

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

      // Both call shapes (F-252): a positional `Error`, and a record pino would take the
      // message out of. See "Why each mechanism is here".
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

      // Door six (F-260): pino also builds `msg` out of the ARGUMENTS, before `write()`.
      // See "Door six" below.
      method.apply(this, interpolationCovered(args) as Parameters<pino.LogFn>);
    },
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});

// The format path (F-260, F-269). `quick-format-unescaped` expands `%o`, `%j` and `%s`
// before `write()` runs, so no serialiser, formatter or wrapper is anywhere on it. The two
// argument roles get two different answers; see "Door six" for why.
function interpolationCovered(args: readonly unknown[]): readonly unknown[] {
  const message = messageArgumentIndex(args);

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

// `LOG` branches on `typeof o === 'object'`, so `null` takes the record branch too, and a
// leading `undefined` is shifted past. Everything from here on is interpolated.
function messageArgumentIndex(args: readonly unknown[]): number {
  return typeof args[0] === 'object' || args[0] === undefined ? 1 : 0;
}

// `log.error(record, error)`. The error is filed under `err`, where `serializers.err` owns
// it, and the message becomes the string a positional error already gets.
function errorMovedOntoTheRecord(args: readonly unknown[]): readonly unknown[] {
  const record = typeof args[0] === 'object' && args[0] !== null ? args[0] : {};

  return [{ ...record, [ERROR_KEY]: args[1] }, POSITIONAL_ERROR_MESSAGE, ...args.slice(2)];
}

// 2, not 1: the top-level `err` exemption exists only because `serializers.err` runs after
// `formatters.log`. Nothing runs after `format`, so here the exemption would be a hole.
// Load-bearing — see "Door six". Unifying this with the depth the wrappers use reopens
// `logger.error('ctx %o', { err: e })`.
const FORMAT_ARGUMENT_SCAN_DEPTH = 2;

function interpolationSafe(value: unknown): unknown {
  if (value instanceof Error) {
    return errorLogFields(value, { includeMessage: false });
  }

  return isWalkable(value) ? errorsReplaced(value, FORMAT_ARGUMENT_SCAN_DEPTH) : value;
}

// The bindings path (F-251, F-258). No pino option reaches it; see "The two wrappers".
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

// Depth 1, so the top-level `err` key stays exempt on this path too. A falsy `bindings` is
// handed straight back so each method still answers for it the way pino does.
function bindingsScanned(bindings: pino.Bindings): pino.Bindings {
  return bindings ? errorsReplaced(bindings, 1) : bindings;
}

// Child options REPLACE the root's rather than merging with them, so these three are
// refused (F-263). `level`, `msgPrefix` and `customLevels` still work. See "A child's
// options are an opt-out, so they are refused" under "The two wrappers".
const OPTIONS_A_CHILD_MAY_NOT_REPLACE = ['redact', 'serializers', 'formatters'] as const;

function childOptionsChecked(
  options?: pino.ChildLoggerOptions,
): pino.ChildLoggerOptions | undefined {
  const supplied: unknown = options;

  if (typeof supplied !== 'object' || supplied === null) {
    return options;
  }

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

// Not writable and not configurable (F-267), so `logger.child = pinoChild` is a TypeError
// rather than a silent replacement. pino's originals stay reachable through the prototype;
// see "Versioning" for what that does and does not buy.
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

/** The key pino files a positional `Error` under, and the one key `serializers.err` owns. */
const ERROR_KEY = 'err';

/** Where pino puts a log call's message. Its presence on a record stops `write` deriving one. */
const MESSAGE_KEY = 'msg';

/** pino `proto.js:223`: `msg === undefined && _obj[messageKey] === undefined && _obj[errorKey]`. */
function messageWouldBeTakenFromTheError(record: unknown): record is object {
  if (typeof record !== 'object' || record === null || record instanceof Error) {
    return false;
  }

  return (
    readIndexedProperty(record, MESSAGE_KEY) === undefined &&
    Boolean(readIndexedProperty(record, ERROR_KEY))
  );
}

/** How far into a log record the error scan looks. See "The residuals" below. */
const MAX_ERROR_SCAN_DEPTH = 4;

function errorsReplaced<T extends object>(container: T, depth: number): T {
  let replacement: T | undefined;

  for (const key of Object.keys(container)) {
    // The seam with `serializers.err`. See "The ordering" below: this skip is required,
    // not stylistic.
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

/**
 * A property whose getter threw. The scan leaves that key exactly as it found it — which
 * does not make the scan throw-free (F-259). See "A log call can still throw".
 */
const UNREADABLE_PROPERTY = Symbol('unreadable property');

function readIndexedProperty(container: object, key: string): unknown {
  try {
    return (container as Record<string, unknown>)[key];
  } catch {
    return UNREADABLE_PROPERTY;
  }
}

/** Plain records and arrays only. `Object.keys` on a `Buffer` is thousands of index strings. */
function isWalkable(value: unknown): value is object {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const prototype: unknown = Object.getPrototypeOf(value);

  return Array.isArray(value) || prototype === Object.prototype || prototype === null;
}
```

`errorLogFields` is specified in `error-envelope.md`, "What the 500 log line carries, and
who owns changing it". It returns `err_name`, an `err_stack` of frames with the
`${name}: ${message}` header stripped, and `err_message` only when the caller opts in.

### Why each mechanism is here

**`redact` covers fields you can name.** It is a path allowlist and it reaches exactly the
paths listed. Nothing else.

**`serializers.err` stops an error's own properties reaching the line (F-244).** pino's
default `err` serialiser copies every own enumerable property of the error onto the record.
body-parser 2.3.0 assigns the verbatim request body to `err.body` on the 400 it raises for
malformed JSON, so one idiomatic `log.error({ err }, '…')` wrote an unauthenticated POST's
credentials in the clear. Reproduced on pino 10.3.1 and re-measured 2026-08-08: a bare pino
emits `"body":"{\"password\":\"BODYMARK\""` under `err`. `REDACT_PATHS` did not reach it,
because `err.body` is a string and no path reaches inside a string. Routing the key through
`errorLogFields` makes the record carry the three fields the policy builds and no fourth,
whatever the error hangs off itself. Appending `err.body` to `REDACT_PATHS` was the
alternative and it defends one property that has already been found by name; the next
library to decorate an error picks a different name.

`serializers.err` also owns the non-error case under that key. `logger.error({ err: { body:
'…' } })` emits `{"err":{"err_name":"non-error throwable (object)"}}`. `errorsReplaced`
deliberately does not do that, because it replaces `Error` instances only.

**`hooks.logMethod` closes the same hole by its other door (F-244, F-252).** A log call with
no context string leaves pino to derive one, and where it derives it from is the error's
message. `msg` is a top-level key, and no redact path can censor it without censoring every
log line's text, so the message is the one field the policy withholds everywhere else.
Measured on pino 10.3.1: `bare.error(err)` emits `"msg":"boom DSNMARK"`.

**Both call shapes are covered, not only the positional one.** `write` (`proto.js:223`)
fills `msg` from `_obj[errorKey].message` for a record too, so `log.error({ err })` landed
the same message in the same uncensorable field while the `err` object itself came out
clean. The hook's second branch supplies the context string pino would otherwise take from
the error, and hands the caller's own record through unchanged so its fields survive.

The coverage condition on the record branch is **the record has an `err` key and no own
`msg`** — not that `err` holds an `Error`. That is deliberate and it is what pino reads:
`proto.js:223` does not check `instanceof`, so a decorated plain object under `err`, which
is the shape `catch (err)` binds and the shape `serializers.err` reduces to `err_name`,
puts its own `message` in `msg` by the same route. Testing for `Error` would be the
enumeration F-244 rejected, one throwable shape later. Measured against the shipped logger
2026-08-08:

| call | `msg` on the line |
|---|---|
| `logger.error(e)` | `an error was logged with no context string` |
| `logger.error({ err: e })` | `an error was logged with no context string` |
| `logger.error({ err: { message: 'postgres://user:pw@host/db' } })` | `an error was logged with no context string` |
| `logger.error({ err: e, msg: 'callers own msg' })` | `callers own msg`, written once |
| `logger.error({ err: null, k: 1 })` | no `msg` key at all |
| `logger.error(e, 'context')`, `logger.error({ err: e }, 'context')` | `context` |

A record that already carries its own `msg` is left alone: pino would use that one, and
supplying a second writes the key twice into the line. `log.error(err, 'context')` and every
first argument pino would not have taken a message from pass through untouched.

**`formatters.log` covers every other key, at depth (F-248).** A serialiser is keyed by
field name, so `serializers.err` covers exactly one key. That is the same enumeration
weakness F-244 rejected, one level up: `{ error: e }` is as idiomatic as `{ err: e }`,
`cause` is ES2022's own name for a chained error, and `{ ctx: { err: e } }` is the same key
one level down. All three reach pino's ordinary object path. `message` and `stack` are
non-enumerable and do not survive it, but body-parser **assigns** `body`, so it is own and
enumerable and travels under any key. All three leaked F-244's exact payload, reproduced
before the fix. Adding `serializers.error` and `serializers.cause` would be the enumeration
F-244 rejected and would not reach the nested shape at all.

Only `Error` instances are replaced. A plain object a call site chose to log is that call
site's decision; the hazard is what a library hangs off a throwable without the call site
knowing.

The scan descends into nothing it replaces, which is why `err.cause` stays shut. `cause` set
through the `Error` constructor is own but non-enumerable, so `Object.keys` never returns it
and nothing walked it before F-248's fix. `errorLogFields` is the boundary: it reads `name`,
`message` and `stack` and returns three fields, never a container to walk. A later edit that
"improves" the walk by following `cause` reopens the leak for chained errors, and
`logger.spec.ts` has a test that fails when it does.

### The ordering: `formatters.log` runs before the serialisers

`formatters.log` runs **before** the per-key serialisers, not after. Measured in the
installed pino 10.3.1, `lib/tools.js` `_asJson`: the `formatters.log(obj)` call sits at line
162 and the `serializers[key](value)` loop at 169. Both F-248 as filed and the test
architect's report said the opposite, and the correction is load-bearing.

That ordering is **why** `errorsReplaced` skips the top-level `err` key at depth 1. Had the
scan replaced that error too, `serializers.err` would receive a plain object and emit
`{"err":{"err_name":"non-error throwable (object)"}}`, losing the error's name and its
frames. Verified 2026-08-08 against the shipped logger by handing it a plain object under
`err`, which is that exact output.

So the two mechanisms **partition the record**:

| Owner | Covers |
|---|---|
| `serializers.err` | the top-level `err` key, including a non-error under it |
| `formatters.log` (`errorsReplaced`) | every other key, at every depth up to `MAX_ERROR_SCAN_DEPTH`, including `err` nested below the root |

There is no key between them. Drop the `depth === 1 && key === ERROR_KEY` skip and the
`err` key starts emitting `non-error throwable (object)`; drop `serializers.err` and the
non-error case under `err` stops being covered at all.

**What the suite pins, exactly (F-254).** Measured by striking each half and running
`logger.spec.ts` against the 18-test suite of 2026-08-08: dropping `serializers.err` alone
failed 12 tests, dropping the depth-1 `err` skip alone failed 6, and dropping **both
together** failed exactly one — the non-`Error` under the top-level `err` key. The counts
move as tests are added; the shape is what matters. That single case is what makes this a
partition rather than a redundancy, and it is the only thing standing between the "these two
overlap, let me unify them" refactor and F-244's shape coming back under `err`. A contract reader who wants to
know why one record needs two mechanisms needs that case.

### The two wrappers: `logger.child` and `logger.setBindings`

**This is the part of the normative form the `pino({…})` literal cannot express, and it is
the thing a future reader most needs from this section.** Re-deriving the logger from the
fenced literal alone, without the two `Object.defineProperty` installations under it,
reopens F-251 and F-258 with every gate green.

`formatters.log` is applied by `_asJson` to the record a log call passes. Child bindings
never reach it: they are serialised once, at `logger.child(…)` or `logger.setBindings(…)`,
by `asChindings` (`tools.js:238`). So `logger.child({ error: e })` wrote F-244's payload —
body-parser's verbatim request body — under a key one character away from the one key that
was covered, and `exception-filter.ts:125` already builds a child logger per request.

**`formatters.bindings` reaches neither path on pino 10.3.1.** Measured, not assumed. It is
the documented seam and it does not work: `child(bindings)` called with no `options`
argument replaces the instance's bindings formatter with the identity function
`resetChildingsFormatter` before calling `asChindings` (`proto.js:84`, `:98-104`), so a root
`formatters.bindings` runs on `base` at construction and never again. Only a formatter
passed in a child's own `options` reaches that child's bindings, which is a rule every call
site would have to remember. Wrapping the two methods is therefore the only mechanism
available. **An implementer who "simplifies" the wrappers into a `formatters.bindings`
entry reopens both findings and every gate stays green.**

**The seam is the same on both paths, and it was measured on each rather than inferred from
one.** `asChindings` applies the bindings formatter at `tools.js:247` and `serializers[key]`
at `:258`, the same order `_asJson` uses, so the partition above holds identically here and
both wrappers scan at **depth 1, keeping the top-level `err` exemption**. The two paths do
differ in one respect — `child()` swaps the bindings formatter for the identity function
first and `setBindings` (`proto.js:189-192`) does not — and they agree only on
`serializers[key]`, which is why the exemption had to be checked twice.

**Depth 2 is the plausible wrong fix on both paths.** A wrapper that scanned from depth 2
turns the leak assertions green while degrading `logger.child({ err: e })` and
`setBindings({ err: e })` to `{"err_name":"non-error throwable (object)"}` — the error's
name and every frame gone. `logger.spec.ts` fails on that for each path.

**`setBindings` was worth wrapping despite having no call site.** It needs no child logger,
`logger.setBindings({ error: e })` is one line from anywhere that imports the module, and it
appends to the **singleton's** chindings permanently (`proto.js:189-192`), so a throwable
bound there would have leaked on that line and on every line the process wrote afterwards.

Children of children are covered: `child` returns `Object.create(this)`, so a grandchild
inherits the own property from the root and `.call(this, …)` preserves the receiver, which
is what keeps a grandchild parented to its parent rather than to the root. A falsy
`bindings` is handed straight back, so `logger.child()` still raises pino's own "missing
bindings for child Pino" and `setBindings(undefined)` still no-ops.

Cost, measured on pino 10.3.1 and Node 24.19 against the binding `exception-filter.ts`
actually creates: 609 ns per child through the wrapper against 581 ns through pino's own
`child`. 28 ns on a per-request path against GC-1's 25 ms budget. The redirect hot path
imports nothing from this module and creates no child logger.

### The residuals

**Two shapes reach a line with a library's assigned properties still on them.** Both carry
the same escalation rule, and it is the rule that keeps this list short: **the TASK that
first builds one of these shapes closes it here, in the same commit, rather than living with
it.** A third residual was listed here and is closed — `setBindings` is wrapped (F-258).

**1. An error at depth 5 or deeper is not replaced.** The scan is bounded at 4. Every log
call site in `apps/api/src` builds a flat record today, and the deepest shape named anywhere
is `req.headers.authorization` at 3, so 4 is that plus one level of slack. The bound also
makes a self-referential record terminate. Verified 2026-08-08 against the shipped logger:

```
{"…","a":{"b":{"c":{"d":{"err":{"body":"{\"password\":\"BODYMARK\"","status":400}}}}},"msg":"depth 5 - beyond the bound"}
```

Same limit `REDACT_PATHS` has for a nested secret, same answer: raise
`MAX_ERROR_SCAN_DEPTH` in the same commit and say so.

**2. An error held inside a class instance is not replaced (F-255).** `isWalkable` declines
to walk one, because `Object.keys` on a `Buffer` is thousands of index strings, but
`JSON.stringify` writes a class instance's own enumerable properties out anyway — so the
payload reaches the line even at depth 1. Reproduced:
`logger.error({ ctx: new Ctx(parseFailure) }, '…')` emits
`"ctx":{"err":{"body":"{\"password\":\"BODYMARK\"}"}}`. The answer for a TASK that needs it
is to log the fields it wants rather than the instance, or to widen `isWalkable`
deliberately and pay the `Buffer` cost it exists to avoid.

**Cost of the scan, and the one figure not to repeat.** Measured against the shipped
instance's own formatter on pino 10.3.1 and Node 24.19, one million calls per figure: 40 ns
on a flat record, 95 ns on one carrying `req.headers`, 115 ns five deep, 500 ns when the
record holds an error, where `errorLogFields` rather than the walk is the cost. An
independent re-measurement got 54 ns and 135 ns for the first two, same order. The claim
that this is "under 2% of a log call" rests on a 5.8–9 µs whole-call baseline that nobody
has reproduced; a second measurement of the same baseline to `/dev/null` came out at 909 ns,
which makes it closer to 6%. **Use the absolute numbers, not the percentage.** 135 ns
against GC-1's 25 ms ceiling is six orders of magnitude of headroom either way.

### A log call can still throw, and the scan does not stop it (F-253)

**A log record whose own property has a throwing getter takes the log call with it: the call
throws and no line is emitted.** This is stated as a residual rather than claimed as an
invariant, and the decision is recorded here because the 2026-08-08 version of this contract
claimed the opposite and was measured false.

Measured 2026-08-08 against the shipped module. There are four throw sites, and the scan
covers none of them completely:

| shape | throws from | in bare pino too |
|---|---|---|
| hostile getter at depth 1, no error elsewhere in the record | `_asJson`, `tools.js:167`, pino's own `value = obj[key]` | yes |
| hostile getter at depth 1 **and** an error under another key | the scan's own copy, `{ ...container }` | no — the throw moves earlier, the outcome does not change |
| hostile getter at depth 2 or deeper | `@pinojs/redact`'s `cloneSelectively`, reached through a wildcard path | yes, with this redact list |
| hostile getter in `child()` or `setBindings()` bindings | `asChindings`, `tools.js:250` | yes |

`readIndexedProperty` catches its own read and skips the key, which leaves the key in the
record for pino to read again. That is what the source docblock means by "leaves pino's own
stringify to handle it exactly as it did before this function existed", and it is accurate.

**Why a sentinel was rejected. The ruling stands; one sentence of its reasoning was measured
false and is corrected here (F-271).** It used to say a sentinel would cover the first two
rows and not the last two. It would not split the table that way. `_asJson`, fast-redact's
`cloneSelectively` and `asChindings` all read the scan's **own output**, so a placeholder
written into the copy is what each of them sees, and rows 1, 3 and 4 are covered alike —
inside the scan's reach, and not outside it. The row a sentinel does not reach is **row 2**,
the scan's own `{ ...container }`, which re-invokes the getter before any sentinel can be
written; that one needs a key-by-key copy rather than a spread, and it is F-259.

What the ruling rests on is the reach, which is the same for all four rows: the scan is
bounded at depth 4 and declines to walk a class instance, so a sentinel buys a **bounded**
guarantee, and the two call sites that need it — the exception filter's `headersSent` arm,
outside the try/catch F-092 added, and `main.ts`'s last-chance boot handler — have no way to
check the bound before they call. A safety guarantee whose beneficiaries cannot tell whether
it applies is worse than a stated residual. It would also cost the copy: `{ ...container }`
re-invokes the getter, so the sentinel forces a key-by-key copy on the path every log line
carrying an error takes.

**ADR-0028 changes this ruling's premises and does not overturn it.** Under a field
allowlist the scan has no unreachable containers left to pass through: past the depth bound
and inside a class instance both become `[redacted]`, so "bounded at depth 4" stops being the
objection. Whether a sentinel plus a key-by-key copy is then worth its cost is a decision for
whoever owns F-253 and F-259 next. It is not made here.

**What is guaranteed, and it is the half these two call sites actually meet.** A hostile
**error** is survivable. An accessor that throws on `name`, `message` or `stack` is caught by
`errorLogFields`, under `err` and under every other key. Verified 2026-08-08: both
`logger.error({ err: hostile }, '…')` and `logger.error({ error: hostile }, '…')` emit a line
carrying `err_name` and do not rethrow. Those two arms log an unknown *throwable*, not an
unknown *record*.

**What a caller must therefore do.** A record built by spreading caller-controlled data —
a parsed body, a request object, anything a library handed over — may carry a hostile getter,
and a log call on it may throw. In a place with nowhere left to escape to, wrap the log call.
That is unbounded, local, and it is the pattern F-092 already established in the same file.

### Which casing `REDACT_PATHS` is keyed to

**The property names as they appear on the JavaScript record, which for domain values is
camelCase.** `ipHash` and `*.ipHash` are in the list because `ClickEventInput.ipHash` in
`click-events.md` is the TypeScript field a call site holds. `ip_hash` is the Postgres column
name in the same contract's DDL, and "What may never appear in a log line" below states the
prohibition in that snake_case form because that is the field's name in the database.

The two spellings are not interchangeable to fast-redact. Verified 2026-08-08 against the
shipped logger: `{ ipHash: 'CAMEL', ip_hash: 'SNAKE' }` emits
`"ipHash":"[redacted]","ip_hash":"SNAKE"`.

The logger's own structured fields are snake_case (`request_id`, `tenant_id`, `duration_ms`,
`err_name`), and that is not a contradiction. The logger builds those itself and never has to
censor them. The redact list only has to match names that arrive from elsewhere.

**The residual, named.** A record built from a raw driver row carries Postgres column names
verbatim, so a `db.execute` result logged whole would put `ip_hash` on the line uncensored.
No shipped code does that today; `ipHash` is the only spelling that exists in TypeScript. A
TASK that logs a raw row adds `ip_hash` and `*.ip_hash` in the same commit.

## Required fields

| Field | On | Source |
|---|---|---|
| `request_id` | every line inside a request | `x-request-id` header, or a generated uuid |
| `tenant_id` | every line inside a tenant transaction | `currentTenantId()` |
| `route` | request completion | the matched route pattern, not the raw path |
| `status`, `duration_ms` | request completion | |

`route` is the pattern (`/api/links/:id`), never the concrete path. A concrete path
carries a slug or an id, and the redirect path's concrete paths are the entire click
stream in plain text.

## What may never appear in a log line

Normative. GC-9.

- A raw IP address, in any field, from any header.
- A JWT, a session token, a capability token, an invitation token, a verification token,
  or any digest of one.
- A password, in any form.
- `ip_hash`. It is pseudonymous per tenant and a log aggregator is a weaker boundary than
  the database. The redact list carries this one as `ipHash` and `*.ipHash`, which is the
  TypeScript spelling a call site holds; see "Which casing `REDACT_PATHS` is keyed to".
- A request or response body, unless an explicit reviewed call logs named fields from it.
- A `tenant_id` other than the one the request is scoped to.
- An error's `message`, unless the call site opts in with a stated reason. Added
  2026-08-08 (F-090, F-108). The policy and its two opt-in call sites are in
  `error-envelope.md`, "What the 500 log line carries, and who owns changing it".
- Any property a library assigned to an error. `body-parser` puts the raw request body on
  `err.body`; `pg` puts colliding column values on `detail`.

**The spellings a prohibited value actually arrives under, and what happens to them
(F-261, F-262, F-266).** Measured 2026-08-08 against the shipped logger: `clientIp`,
`trustedClientIp`, `remoteAddress`, `ipAddress`, `remotePort`, `url`, `sessionToken`,
`accessToken`, `refreshToken`, `apiKey`, `api_key`, `passwordHash`, and a bare
`authorization` or `cookie` outside `req.headers`, are all emitted **verbatim** today.
`trustedClientIp` is the accessor already named in
`design/stubs/apps/api/src/auth/resolve-rate-limit-principal.ts:28`, so the spelling this
system will hold is one of the uncensored ones. Under ADR-0028 these are censored because
they are not named, along with every spelling nobody has thought of, and this paragraph
becomes the **never-allowlist list**: names that may not be added to `LOGGABLE_FIELDS`,
whatever a call site wants them for. Until then, no call site may log any of them.

The redact list is one of six mechanisms, and it is the one that only covers fields you
can name. **It is an allowlist of paths and it does not reach arbitrary nesting**:
`*.token` matches exactly one level, so it covers `req.token` and covers neither `token` at
the top level nor `payload.data.credentials.token` two levels down. That is why every
`*.x` entry is paired with a bare `x`. A TASK introducing a nested secret adds a path in
the same commit.

The other five cover what a path list cannot: `serializers.err`, `hooks.logMethod` and
`formatters.log` keep an error's own properties and its message off the line under every
key, whatever they are named, and the `logger.child` and `logger.setBindings` wrappers do
the same on the bindings path. See "Why each mechanism is here" and "The two wrappers".

**The two `x-shortkit-*` entries are in the list now, ahead of the headers existing**
(F-032). `x-shortkit-client-ip` carries a raw client IP on every browser-originated API
request (GC-9 forbids a raw IP in any field from any header), and
`x-shortkit-proxy-auth` carries `BFF_PROXY_SECRET` verbatim — a leaked log line would
let anyone forge `X-Shortkit-Client-IP` against Fly directly and defeat every IP-keyed
auth bucket. The `'*.secret'` wildcard matches a property one level deep and **does not
reach a header key**. **TASK-003 owns these entries** and ships them with the rest of the
list. TASK-003 and TASK-009 are both in wave 2 and run concurrently (`TASK-003.md`,
corrected 2026-08-06), so the entries land before or beside the headers rather than eight
waves ahead of them as this paragraph used to say; redacting a not-yet-sent header is free,
and appending later would have no owner. The
`BFF_PROXY_SECRET` value is never logged on the Vercel side either
(`web-api-client.md`).

### The exception filter's error line

Added 2026-08-05 (F-106). Resolved 2026-08-08 (F-242, TASK-003 fix round 1).
`apps/api/src/common/errors/exception-filter.ts` is the only place in the API that writes
an arbitrary error into a log line, and TASK-003 owns that file as of the F-090 ruling.

**The line is on pino now, and the stack-versus-message question is decided.**
`errorLogFields` builds `err_name` always, `err_stack` as frames only, and `err_message`
only where the call site opts in. `error-envelope.md`, "What the 500 log line carries, and
who owns changing it", is normative for that policy and names the two call sites that pass
`includeMessage: true`.

**One sentence that stood here was measured false and is removed.** It said `REDACT_PATHS`
"cannot help either way: it matches paths, and neither a message nor a stack has one." Once
a serialiser turns an error into an object, `err.message` and `err.stack` are ordinary
paths and pino censors them. Verified 2026-08-08 on pino 10.3.1: with
`redact: { paths: ['err.message', 'err.stack'] }`, a serialised error emits
`{"err":{"type":"SyntaxError","message":"[redacted]","stack":"[redacted]",…}}`.

The true constraint is narrower, and it is the one the policy rests on. **Redaction cannot
reach inside a string.** A path censors a field whole or leaves it whole, so a message that
carries a Postgres DSN goes to the log intact or not at all. That is why the answer is which
fields `errorLogFields` builds rather than which paths to censor, and it is also why the
stack is emitted as frames with the `${name}: ${message}` header stripped at construction:
`err.stack` opens with a `${name}: ${message}` line, and no path can remove the first line
of a string.

## CORS

**Disabled. `app.enableCors()` is never called.**

The browser never reaches the API cross-origin: ADR-0014 routes every browser request
through the Next.js BFF, same-origin with the page. The redirect path is reached by
navigation rather than by `fetch`, so it needs no CORS header either.

A future cross-origin consumer, such as the MCP server, gets its own ADR. It does not
inherit a permissive default set here. **A frontend TASK meeting a cross-origin error
escalates rather than enabling CORS**: the error means something is bypassing the BFF,
which is the actual defect.

## Security headers

`helmet()` with defaults, plus HSTS, registered in `main.ts` before the global prefix.

| Header | Value | Scope |
|---|---|---|
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains` | every response |
| `X-Content-Type-Options` | `nosniff` | every response |
| `X-Frame-Options` | `DENY` | every response |
| `Referrer-Policy` | `no-referrer` | every response except the redirect 302 |
| `Content-Security-Policy` | helmet default | API responses |

`preload` is **not** set on HSTS: submission is close to irreversible and the apex domain
is unregistered.

### Two deliberate exceptions on the redirect path

Both already normative in `redirect-resolution.md`. They override the defaults above.

| Response | Header | Value | Why |
|---|---|---|---|
| redirect 302 | `Referrer-Policy` | `unsafe-url` | passing the short URL to the destination is the point of an attribution referrer, and the link is public |
| branded 404 | `Content-Security-Policy` | `default-src 'none'; img-src https:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'` | tighter than helmet's default; the page interpolates tenant-controlled branding (F-006) |

## Invariants a caller may rely on

1. Logging a whole request or response object never emits a credential, an IP, or a
   cookie. The redaction is at the logger, so no call site has to remember.
   **Not true today (F-261).** Measured 2026-08-08 against the shipped logger:
   `logger.info(req, '…')` emits `"remoteAddress":"203.0.113.7"`, `"remotePort":54321` and
   the concrete `"url":"/l/abc?token=SEKRIT"` in the clear. The six `req.headers.*` paths
   are censored, which is what makes this dangerous rather than obvious — the list reads as
   though logging a whole request were a covered act. A raw client IP in any field is GC-9's
   first prohibition, and the concrete path is what "Required fields" forbids two sections
   above. Until ADR-0028 lands, **a caller may not rely on this invariant**: log named
   fields, never a request or response object. ADR-0028 makes it true by censoring the whole
   object, since `req` is not a named field.
2. Every line inside a request carries `request_id`; every line inside a tenant
   transaction carries `tenant_id`.
3. The API sends no `Access-Control-Allow-Origin` header, for any origin, on any route.
4. HSTS, `nosniff` and `DENY` are present on every API response including errors.
   **Not true today.** `helmet` is not registered. F-243 clause 2 is open and escalated:
   this contract assigned helmet and HSTS to TASK-003 with no AC, no test and no finding
   tracking them. Nothing in launch-core owns it until that routes.
5. Logging an `Error` under any key, at any depth up to 4, emits `err_name`, an
   `err_stack` of frames, and nothing else. Not `message`, not `body`, not `detail`, not
   any property a library assigned. Holds for `{ err: e }`, `{ error: e }`, `{ cause: e }`,
   `{ ctx: { err: e } }`, `[e, e]`, `log.error(e)` and `log.error(e, 'context')`, and it
   holds whether the error arrived in the log record or in **logger bindings**, through
   either `logger.child(bindings)` or `logger.setBindings(bindings)`. Bounded by the two
   residuals above: depth 5, and an error held inside a class instance.
6. **An error's message never lands in `msg`.** A log call with no context string gets the
   fixed string `an error was logged with no context string`, for the positional
   `log.error(e)` and for a record `log.error({ err })` alike; the record's own fields
   survive, and a record that supplies its own `msg` keeps it. The coverage condition is
   *the record has an `err` key and no own `msg`*, not that `err` holds an `Error`. What
   this invariant does **not** cover is a message a call site interpolated into the context
   string itself, which no mechanism here can reach.
7. **A hostile error does not take the process with it.** An accessor that throws on
   `name`, `message` or `stack` is survivable under `err` and under every other key: the log
   call emits a line carrying `err_name` and does not rethrow. This is what the exception
   filter's `headersSent` arm and `main.ts`'s last-chance boot handler need, and it is the
   shape they meet, since both log an unknown throwable.

   **A record property whose getter throws is not covered by this invariant.** The log call
   throws and no line is emitted. See "A log call can still throw" above for the four
   measured throw sites and for what a caller with nowhere to escape to must do instead.

## What the implementer must guarantee

- **A test asserts redaction works**: build a log line from a request carrying
  `Authorization: Bearer x.y.z` and `Cookie: sk_at=...`, and assert the serialised output
  contains neither value and contains `[redacted]`.
- A test asserts no response carries `Access-Control-Allow-Origin`.
- Adding a field that could carry a secret means adding its path to `REDACT_PATHS` in the
  same commit. **Reversed by ADR-0028**: adding *any* field means naming it in
  `LOGGABLE_FIELDS` in the same commit, and a field that could carry a secret may not be
  named at all. A field that skips that step emits `"<field>":"[redacted]"`.
- **Never log a request or response object.** Log named fields from it. `logger.info(req, …)`
  emits the raw client IP and the concrete path today (invariant 1), and under ADR-0028 it
  emits `"req":"[redacted]"` and tells you nothing. Neither outcome is what the call site
  wanted; `request_id`, `route`, `status` and `duration_ms` are.
- **Assert the bytes, not the configuration.** `apps/api/src/observability/logger.spec.ts`
  spawns a Node process, imports the shipped singleton, emits one line per call shape and
  reads stdout. A test that inspected `logger.options.serializers` passes against a config
  that emits the wrong bytes, which is how F-244 and F-248 both reached the branch. Twenty
  tests defend this today, each proven by a mutation that fails exactly it.
- **Always pass a fixed context string**: `logger.error({ err }, 'what was being done')`.
  The hook supplies one when a call omits it, so an omission is not a leak — but the string
  it supplies names the call shape and not the failure, which costs the operator the only
  human-written field on the line.
- **Never pass `includeMessage: true` without a reason at the call site.** Two call sites
  do, both named in `error-envelope.md`. A third needs the same treatment there.
- Never introduce a second pino instance. The redaction, the three literal error mechanisms
  and the
  two bindings wrappers are all configuration on one logger, so a second instance built
  anywhere is a hole with none of them. Import `logger` from
  `apps/api/src/observability/logger.ts`, and do not re-derive it from ADR-0022, which
  records the decision and deliberately carries no literal (F-250).
- **Wrap the log call where there is nowhere left to escape to.** A record spread from
  caller-controlled data may carry a property whose getter throws, and that throws out of the
  log call with no line emitted. See "A log call can still throw" (F-253). The exception
  filter's `headersSent` arm and `main.ts`'s last-chance boot handler are the two places
  where that converts a logged failure into an unhandled one.
- **Never interpolate an error's message into a log message string.**
  `` logger.error(`failed: ${e.message}`) `` puts the message into `msg`, which no
  serialiser, formatter or redact path reaches. Pass `{ err: e }` and a fixed context
  string instead. `apps/api/src/tenancy/tenant-context.ts:247` does the interpolated form
  today and is reported but not fixed.
- Never log `error.request` or `error.config` from an HTTP client. Both carry headers.
- **Never log a database error's `detail`, `hint`, `where`, `internalQuery` or `query`.**
  Added 2026-08-05 (F-120). A `pg.DatabaseError` populates `detail` on a unique violation
  with the colliding column values verbatim (`Key (slug)=(abc) already exists`), and
  `where` and `internalQuery` carry query text from a trigger or function body.
  `REDACT_PATHS` is a path list and cannot reach inside those strings, so redaction is
  not a fallback here. The readable fields on a caught database error are the SQLSTATE
  and the constraint name, both through the accessors in `tenant-context.md`, "Driver
  errors inside `fn`".

## Versioning

`REDACT_PATHS` is append-only. Removing a path needs a reason in the commit message.
Changing the header table requires amending ADR-0022.

**ADR-0028 removes `REDACT_PATHS` entirely, and that ADR is the reason in the commit
message.** Its replacement, `LOGGABLE_FIELDS`, is append-only under the same rule with one
addition: a name may be appended only after it has been checked against "What may never
appear in a log line", and removing a name silently censors a field that was on the line
yesterday, so it needs the same reason. `err_name`, `err_message` and `err_stack` are on
that list, so renaming any of them now censors it as well as breaking every saved log query.

`serializers.err`, `hooks.logMethod`, `formatters.log` and the two bindings wrappers are
not removable by a TASK. Each closes a leak that shipped once, each is defended by tests in
`logger.spec.ts`, and a change to any of them needs a finding and an ADR amendment before
the code moves. Raising `MAX_ERROR_SCAN_DEPTH` is additive and needs neither; lowering it
is a removal. Replacing either wrapper with a `formatters.bindings` entry is a removal, not
a refactor — see "The two wrappers".

`ErrorLogFields` grows by adding an optional field. Renaming `err_name`, `err_message` or
`err_stack` breaks every saved log query, so it needs the same amendment.

**Where the logger's configuration lives.** This contract, and nowhere else. ADR-0022 fenced
a copy of the `pino({…})` call until 2026-08-08; that copy went stale the day F-244 landed
and is now removed rather than synced (F-250), because three copies in three artifacts is
what produced F-244, F-248, F-249 and F-250 in sequence. ADR-0022 still owns the *decision*
— redaction by allowlist, applied at the logger, append-only, and which classes of value are
on the list — and changing the header table still requires amending it. The wave-1 stub at
`design/stubs/apps/api/src/observability/logger.ts` is superseded and carries a banner
saying so. **A fourth artifact carrying this configuration is a finding, not a convenience.**
