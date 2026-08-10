# Contract: structured logging, redaction, CORS, and security headers

- **Boundary:** every log line the API emits; every response header it sets.
- **Normative form:** `apps/api/src/observability/logger.ts` and `apps/api/src/main.ts`. This contract's § "Logger" fence is the single normative statement of the logger's configuration and is compared to the shipped file by a drift test. The wave-1 stub at `design/stubs/apps/api/src/observability/logger.ts` is **superseded** (F-249) and its config is unsafe to copy; ADR-0022 no longer carries a copy at all (F-250).
- **Produced by:** TASK-003.
- **Consumed by:** every API TASK. Nothing may opt out.
- **ADRs:** ADR-0022, and ADR-0028 which supersedes its redaction clause only — ADR-0022's
  CORS decision and header table stand. Enforces GC-9.

## Logger

Amended 2026-08-08 (F-242, F-244, F-248, F-249), again 2026-08-08 fix round 3 (F-250, F-251,
F-252, F-253, F-255, F-258), again 2026-08-09 fix round 4 (F-259, F-260, F-263, F-265,
F-267, F-269), and again 2026-08-10 for ADR-0028 (F-261, F-262, F-266) and F-243 clause 2.
The block below matches the shipped `apps/api/src/observability/logger.ts` on pino 10.3.1 at
commit `45cf578`.

**This contract is the single normative source for the logger's configuration.** ADR-0022
used to fence a copy of it and no longer does (F-250); the wave-1 stub at
`design/stubs/apps/api/src/observability/logger.ts` is superseded and unsafe to copy
(F-249). One configuration living in three artifacts is what produced F-244, F-248, F-249
and F-250 in sequence.

**Three mechanisms in the literal, plus three things under it the literal cannot express, and
every one of them is load-bearing.**

| Mechanism | Covers | Section |
|---|---|---|
| `serializers.err` | the top-level `err` key, including a non-error under it | "Why each mechanism is here" |
| `hooks.logMethod` | every call shape that would put an error's message into `msg` — the record, and every argument position pino formats | "Why each mechanism is here", "Door six" |
| `formatters.log` | every other key of the record, to depth 4: an `Error` under any key, and every key `LOGGABLE_FIELDS` does not name | "A field reaches a line only if it is named", "The ordering" |
| the `logger.child` wrapper | bindings, on the other path a line is built by | "The two wrappers" |
| the `logger.setBindings` wrapper | the second entry to the same path | "The two wrappers" |
| `childOptionsChecked` | a child that tries to replace `redact`, `serializers` or `formatters`. **Load-bearing, not hardening, since ADR-0028** | "The two wrappers", "One mechanism between an unnamed field and the line" |

`LOGGABLE_FIELDS` is not a seventh row. It is the list the third row and the two wrappers
consult, and it has no effect anywhere else.

There is no `redact` row any more. pino's `redact` option and the 25-path `REDACT_PATHS` list
are removed (ADR-0028); the paths survive as a prohibition in "What may never appear in a log
line" and as nothing else.

Read the sections named before editing any of them. Removing one reopens a leak that already
shipped once, and `apps/api/src/observability/logger.spec.ts` fails on each.

### A field reaches a line only if it is named (ADR-0028)

**Landed 2026-08-10 at commit `45cf578`. The fenced block below is the shipped
configuration.** A field reaches a log line only if its key is in `LOGGABLE_FIELDS`. Every
other key is emitted with the value `[redacted]`, and the key stays on the line so the
operator sees which field exists and what it is called.

ADR-0028 replaced the 25-path denylist because it failed three audit rounds the same way: it
covered the spellings someone had thought of. `err.body` (F-244), then `clientIp`,
`trustedClientIp`, `remoteAddress`, `ipAddress` (F-262), then `sessionToken`, `apiKey`,
`api_key`, `passwordHash` and a bare `authorization` or `cookie` (F-266). The failure mode is
now a **missing field** rather than a leaked one, and the missing field names itself.

What that changed in the sections below, so a reader who remembers the old text knows which
claims moved:

- `REDACT_PATHS` and the `redact` option are gone. The 25 paths are now the never-allowlist
  list in "What may never appear in a log line": names that may not be added to
  `LOGGABLE_FIELDS`, whatever a call site wants them for.
- Casing stopped being load-bearing. `ipHash` and `ip_hash` are both censored, because
  neither is named. The old "Which casing `REDACT_PATHS` is keyed to" section and its
  `ip_hash` residual are removed rather than kept as history.
- The three residuals closed as a class. A container the scan cannot inspect — past the depth
  bound, a class instance, anything carrying `toJSON` (F-265) — is censored rather than passed
  through.
- **Invariant 1 is true**, for a stronger reason than it used to claim: a whole request object
  does not reach the line at all, so there is no header list to keep current.
- **Invariant 5 narrowed.** An `Error` at depth 1 still emits `err_name` and `err_stack` under
  any key spelling, because an `Error` value is reduced by policy before any key decision. An
  error nested under a key that is not named — `{ ctx: { err: e } }` — is censored with its
  container and lost, rather than reduced. Measured: `"ctx":"[redacted]"`. That is a
  diagnostic loss, priced and accepted in the ADR. Pass the error at the top level.
- The cost the ADR accepted: **a field a TASK forgets to name ships as `[redacted]`, and the
  discovery moment is usually an incident.** Nothing in the build catches it for a field that
  does not exist yet. Typecheck, lint and the suite are all green on a log line whose every
  field is censored.

### One mechanism between an unnamed field and the line

**Read this before removing anything named above.** Until ADR-0028 the record path had two
censoring layers: pino's `redact` over 25 paths, and the error scan. `redact` is gone, so a
bug in `fieldsCensored`, or a call site that gets past it, has nothing behind it. ADR-0028
priced that and accepted it — two censoring mechanisms with opposite polarity is the
comprehension hazard that let a reader of the six `req.headers.*` paths conclude that logging
a whole request was a covered act — but the consequences are structural and they are these:

- **`childOptionsChecked` is load-bearing rather than defence in depth.**
  `logger.child(b, { formatters: { log: (o) => o } })` replaces the scan for that child, and
  pino replaces rather than merges. Before ADR-0028, `redact` still censored 25 paths behind
  such a child. Now nothing does. The refusal is what makes this contract's "Nothing may opt
  out" true, and it is one `if` away from not being.
- **A second pino instance anywhere is a hole with no mechanism at all** (F-268, unowned).
  That was already true; the blast radius changed from "the 25 paths" to "every field on
  every line that instance writes".
- **`Object.getPrototypeOf(logger).child.call(logger, …)` still reaches pino's unwrapped
  `child`.** The non-writable descriptors are hardening against the accident, not a boundary
  against a call site that means it, and no property descriptor can make them one.

What would force a second layer back: a defect in `fieldsCensored` that reaches a line. That
is a finding and an ADR amendment, not a patch.

### The block below is machine-checked against the shipped file

The fence is the **normative region**: `apps/api/src/observability/logger.ts` from its
`import` through the end of `readIndexedProperty`, which is the whole logger configuration
and the scan. Everything after it in that file — `RequestLogFields`, `ErrorLogFields`,
`errorLogFields` and its helpers — belongs to `error-envelope.md` and is deliberately not
reproduced here. (`isWalkable` used to be the last declaration in the region. ADR-0028
removed it: its prototype test is inlined in `valueCensored`, which censors what it cannot
inspect instead of passing it through.)

The comparison, implemented by `apps/api/src/observability/logger-contract-drift.spec.ts`:
strip comments from both sides and collapse each run of whitespace **outside a string** to a
single space, then cut the region out of the source between two anchors and compare it to the
fence for **equality**. The anchors are the literal text `import pino from 'pino';` and
`export interface RequestLogFields`, the first declaration `error-envelope.md` owns rather
than this one. Whitespace inside a string is left alone, because the strings are the payload
here — the censor, the fixed context message, the child-options refusal.

Comments are stripped on both sides, so the explanatory comments inside the fence are free
and may differ from the source's docblocks. Everything else fails: a reordered declaration, a
changed field name, a different depth bound, a dropped wrapper.

**The fence is selected by content, and the selector reads the fence's RAW text.** The drift
spec picks this block out of the document with `FENCE_MARKER` at
`logger-contract-drift.spec.ts:72`, the literal `export const LOGGABLE_FIELDS`, matched
against every fenced `ts` block in this file **before comments are stripped**. Three things
follow, and the ADR-0028 migration paid for each of them:

- **Renaming a declaration inside the fence blinds the selector.** A marker no fence carries
  selects nothing, the fence-count test fails with `expected [] to have length 1`, and F-249
  and F-270 go down with it reporting a stale string as a fence-shape problem. Re-point
  `FENCE_MARKER` in the same commit that renames the declaration.
- **A comment satisfies the marker, because the strip runs after the selection** (F-276).
  ADR-0028 used that on purpose: while the source had moved to `LOGGABLE_FIELDS` and the spec still
  read the old declaration name, the fence carried that name in its first comment so the
  three tests stayed green across the gap. The scaffold is gone and the marker now names code
  the fence actually carries. Do not build another selector that depends on a comment: it
  reads as noise to the next editor, who deletes it.
- **Searching this document for the marker does not tell you what the selector sees.** The
  spec reads fenced `ts` blocks only, and this file's prose names the same identifiers. A
  grep that finds the literal in a sentence proves nothing. Run
  `npx vitest run src/observability/logger-contract-drift.spec.ts` and expect 6 passed.

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

/**
 * Every key that may carry a value onto a log line. Nothing else survives: an unnamed key is
 * emitted as `[redacted]`, and the key stays on the line. One name per line, sorted, with the
 * owning file in a trailing comment, so a wave-parallel merge conflict resolves by keeping
 * both. Append-only, and only after checking "What may never appear in a log line".
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
  'tenant_id', // logging-and-headers.md, Required fields
]);

/** What an unnamed key carries instead of its value. Name and value both verbatim. */
export const REDACT_CENSOR = '[redacted]';

/** What `msg` says when a call site logged an error and nothing else. */
const POSITIONAL_ERROR_MESSAGE = 'an error was logged with no context string';

// There is no `redact` option, and its absence is deliberate (ADR-0028). See "One mechanism
// between an unnamed field and the line" for what that costs.
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

// A format argument arrives under NO key, so it goes through the VALUE half of the policy
// and never through the key rule. 1, and the `+ 1` inside `valueCensored` is the
// load-bearing part: a container it holds is walked from 2, where the top-level `err`
// exemption does not fire. That exemption exists only because `serializers.err` runs after
// `formatters.log`, and nothing runs after `format`. Route this through `fieldsCensored` at
// depth 1 instead and `logger.error('ctx %o', { err: e })` reopens.
const FORMAT_ARGUMENT_SCAN_DEPTH = 1;

function interpolationSafe(value: unknown): unknown {
  return valueCensored(value, FORMAT_ARGUMENT_SCAN_DEPTH);
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

const childWithFieldsCensored: ChildFactory = function childWithFieldsCensored(bindings, options) {
  return inheritedChild.call(this, bindingsScanned(bindings), childOptionsChecked(options));
};

const setBindingsWithFieldsCensored: BindingsSetter = function setBindingsWithFieldsCensored(
  bindings,
) {
  inheritedSetBindings.call(this, bindingsScanned(bindings));
};

// Depth 1, so the top-level `err` key stays exempt on this path too. A falsy `bindings` is
// handed straight back so each method still answers for it the way pino does.
function bindingsScanned(bindings: pino.Bindings): pino.Bindings {
  return bindings ? fieldsCensored(bindings, 1) : bindings;
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

/**
 * How far in the scan looks. A container at or below this depth is CENSORED, not walked —
 * the inversion ADR-0028 turns on. Raising it lets a deeper NAMED field keep its value;
 * lowering it censors more. Either way it is additive to safety now. See "Versioning".
 */
const MAX_SCAN_DEPTH = 4;

// An `Error` value is reduced whatever its key, and the key check never runs on it. Every
// other key survives only if `LOGGABLE_FIELDS` names it. The key stays on the line either
// way. `undefined` is left alone, because `JSON.stringify` drops it and censoring would add
// a field where none appeared.
function fieldsCensored<T extends object>(record: T, depth: number): T {
  let replacement: T | undefined;

  for (const key of Object.keys(record)) {
    // The seam with `serializers.err`. See "The ordering" below: this skip is required,
    // not stylistic.
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
      // The array branch keeps `fieldsCensored<T>(…): T` honest for an array passed AS the
      // record. It changes no emitted byte — measured, both forms — so it is a type
      // guarantee, not a behavioural one. See "An array as the whole record".
      replacement ??= (Array.isArray(record) ? [...record] : { ...record }) as T;
      (replacement as Record<string, unknown>)[key] = replaced;
    }
  }

  return replacement ?? record;
}

// The policy for a value whose key has already been allowed, or that arrived under no key at
// all — an array element, or a format argument. A container this cannot inspect is CENSORED,
// not passed through: a class instance, a `Buffer`, anything at or past `MAX_SCAN_DEPTH`.
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

// An array's elements, each through `valueCensored` and NONE through the key rule: an array
// index is not a field name. An OBJECT inside an array is walked by `fieldsCensored`, so its
// own keys are decided normally.
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

/**
 * A property whose getter threw. Censored rather than skipped (ADR-0028 rule 4): skipping
 * left the key for pino to read a second time, and a getter that answers with a credential on
 * that read put it on the line. It does not make the scan throw-free (F-259). See "A log call
 * can still throw".
 */
const UNREADABLE_PROPERTY = Symbol('unreadable property');

function readIndexedProperty(container: object, key: string): unknown {
  try {
    return (container as Record<string, unknown>)[key];
  } catch {
    return UNREADABLE_PROPERTY;
  }
}
```

`errorLogFields` is specified in `error-envelope.md`, "What the 500 log line carries, and
who owns changing it". It returns `err_name`, an `err_stack` of frames with the
`${name}: ${message}` header stripped, and `err_message` only when the caller opts in.

### Why each mechanism is here

**`LOGGABLE_FIELDS` decides which keys may carry a value.** Thirteen names, and every other
key is `[redacted]` whatever it holds. It is consulted by `formatters.log` and by both
bindings wrappers, and by nothing else. There is no `redact` option to describe here any
more; what used to cover "fields you can name" now covers every field nobody named.

**`serializers.err` stops an error's own properties reaching the line (F-244).** pino's
default `err` serialiser copies every own enumerable property of the error onto the record.
body-parser 2.3.0 assigns the verbatim request body to `err.body` on the 400 it raises for
malformed JSON, so one idiomatic `log.error({ err }, '…')` wrote an unauthenticated POST's
credentials in the clear. Reproduced on pino 10.3.1 and re-measured 2026-08-08: a bare pino
emits `"body":"{\"password\":\"BODYMARK\""` under `err`. The path list did not reach it,
because `err.body` is a string and no path reaches inside a string. Routing the key through
`errorLogFields` makes the record carry the three fields the policy builds and no fourth,
whatever the error hangs off itself. Appending `err.body` to the path list was the
alternative and it defends one property that has already been found by name; the next
library to decorate an error picks a different name. ADR-0028 is that argument applied to
the path list as a whole.

`serializers.err` also owns the non-error case under that key. `logger.error({ err: { body:
'…' } })` emits `{"err":{"err_name":"non-error throwable (object)"}}`. `fieldsCensored`
deliberately does not do that, because it reduces `Error` instances only — a non-`Error`
under a key that is not named is censored rather than described.

**`hooks.logMethod` closes the same hole by its other door (F-244, F-252).** A log call with
no context string leaves pino to derive one, and where it derives it from is the error's
message. `msg` is a top-level key and free text by construction — no key-based scheme can
censor it without censoring every log line's text, which is why `msg` is on
`LOGGABLE_FIELDS` — so the message is the one field the policy withholds everywhere else.
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

**Two rules, in this order, and the order is the point.** An `Error` value is reduced by
`errorLogFields` whatever its key, and the key check never runs on it — an error is a value
with a policy, not a field with a name. Every other key survives only if `LOGGABLE_FIELDS`
names it. So a plain object a call site chose to log is no longer that call site's decision:
it reaches the line if its key is named, is walked one level deeper if it is a plain record,
and is `[redacted]` otherwise.

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

That ordering is **why** `fieldsCensored` skips the top-level `err` key at depth 1. Had the
scan replaced that error too, `serializers.err` would receive a plain object and emit
`{"err":{"err_name":"non-error throwable (object)"}}`, losing the error's name and its
frames. Verified 2026-08-08 against the shipped logger by handing it a plain object under
`err`, which is that exact output.

So the two mechanisms **partition the record**:

| Owner | Covers |
|---|---|
| `serializers.err` | the top-level `err` key, including a non-error under it |
| `formatters.log` (`fieldsCensored`) | every other key, at every depth up to `MAX_SCAN_DEPTH`, including `err` nested below the root |

`serializers.err`'s output is three named fields by construction, so the allowlist neither
sees it nor needs to. That is why the partition survives ADR-0028 unchanged.

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

**Both wrappers enforce the field allowlist, not only the error policy (ADR-0028).** They are
one of the two places a line is built, so they are one of the two places the allowlist runs:
a key that is not named is censored in bindings exactly as it is in a record.
`exception-filter.ts:125` binds `request_id`, which is on the list.

#### A child's options are an opt-out, so they are refused (F-263)

`child(bindings, options)` does not merge `redact`, `serializers` and `formatters` with the
instance's own. It **replaces** them, all three reproduced against this singleton:
`redact` at `proto.js:157-165`, `serializers` merged per key at `:115-134` so a child naming
`err` displaces the serialiser that owns the top-level `err` key, and `formatters` at
`:136-143` where `log || formatters.log` removes the scan itself at every key and every
depth. `childOptionsChecked` throws a `TypeError` naming the options and the reason.

**Refused rather than merged**, because merging is only definable for `redact`, and even
there a child's own `censor` or `remove: true` changes what the merged list does to the paths
it inherited. For `serializers.err` and `formatters.log` a merge is a composition whose order
is a second undocumented policy. Every one of those outcomes is a control that is partly in
force, which is the state this module exists to make impossible.

`level`, `msgPrefix`, `customLevels` and `bindings` are untouched: they change what a child
logs, not what this module withholds. `setBindings` takes no options at all.

**This is load-bearing since ADR-0028, not hardening.** See "One mechanism between an unnamed
field and the line".

Cost, measured on pino 10.3.1 and Node 24.19 against the binding `exception-filter.ts`
actually creates: 609 ns per child through the wrapper against 581 ns through pino's own
`child`. 28 ns on a per-request path against GC-1's 25 ms budget. The redirect hot path
imports nothing from this module and creates no child logger.

### The residuals closed, and the diagnostic loss that replaced them

**All three residuals this section used to carry are closed, and they closed as a class
rather than one at a time (ADR-0028).** An error at depth 5, an error inside a class instance
(F-255) and an error returned by a `toJSON` (F-265) each reached a line carrying whatever a
library had assigned, because "the scan cannot inspect this" meant "emit it whole". It now
means `[redacted]`. Measured against the shipped logger:

| shape | before ADR-0028 | now |
|---|---|---|
| `{ a: { b: { c: { d: { err: parseFailure } } } } }` | the raw request body | `"a":"[redacted]"` |
| `{ ctx: new Ctx(parseFailure) }` | the raw request body | `"ctx":"[redacted]"` |
| `{ ctx: { toJSON: () => parseFailure } }` | the raw request body | `"ctx":"[redacted]"` |
| `logger.info(req, '…')` | `remoteAddress`, `remotePort`, the concrete `url` | `"req":"[redacted]"` |

**What replaced them is a diagnostic loss, and it is a cost rather than a residual.** An
`Error` nested inside a container that is not a named field — `{ ctx: { err: e } }`, F-248's
third shape — is censored **with** its container instead of being reduced to `err_name` and
`err_stack`. The remedy is the one this contract already prescribes: pass the error at the
top level, where it is reduced under any key spelling.

`MAX_SCAN_DEPTH` is still 4 and its meaning inverted with the polarity. It no longer bounds
what is *covered*; it bounds what is *walked*, and a container past it is censored. Raising it
lets a deeper **named** field keep its value and closes no leak. The bound also still makes a
self-referential record terminate.

#### An array as the whole record

`fieldsCensored`'s copy is `Array.isArray(record) ? [...record] : { ...record }` rather than
the bare spread ADR-0028's fence wrote. **Measured: the two forms emit identical bytes.**
pino's `_asJson` writes own enumerable keys either way, so `logger.info([e, e], '…')` emits
`"0":{"err_name":…},"1":{"err_name":…}` under both. The ternary is kept for the type: the
function is declared `<T extends object>(record: T, depth: number): T`, and spreading an array
into an object literal makes the `as T` a false statement about the value. It is also the form
the previous shipped scan had, so keeping it is the existing pattern rather than a new one.

Note what an array as the whole record now means under the key rule: the indices `'0'`, `'1'`
are not in `LOGGABLE_FIELDS`, so `logger.info(['a', 'b'], '…')` emits
`"0":"[redacted]","1":"[redacted]"`. Only the `Error` branch, which runs before the key check,
keeps invariant 5's `[e, e]` working. An array under a **named key** is a different path
entirely: `valueCensored` routes it to `elementsCensored`, where an index is correctly not
treated as a field name.

**Cost of the scan.** Measured 2026-08-10 against the shipped singleton and the one that
shipped before it, pino 10.3.1, Node 24.19, five runs of 200 000 calls, median, both writing
to fd 1 redirected to `/dev/null`:

| record | bare pino | before ADR-0028 | shipped |
|---|---|---|---|
| flat request-log record | 2355 ns | 5164 ns | 2507 ns |
| record carrying `req.headers` | 2406 ns | 6991 ns | 2254 ns |
| record nested five deep | 2389 ns | 4388 ns | 2269 ns |
| record holding an error | 2528 ns | 6260 ns | 3857 ns |

Removing `redact` refunds more than the allowlist spends: 2.66 µs per flat line, 4.74 µs on a
record carrying `req.headers`. The error record's 1.3 µs over bare pino is `errorLogFields`
building frames, not the walk. **Use the absolute numbers, not a percentage of a whole-call
baseline** — the 5.8–9 µs baseline earlier rounds quoted has never been reproduced. Against
GC-1's 25 ms ceiling one line is 0.010%.

### A log call can still throw, and the scan does not stop it (F-253)

**A log record whose own property has a throwing getter takes the log call with it: the call
throws and no line is emitted.** This is stated as a residual rather than claimed as an
invariant, and the decision is recorded here because the 2026-08-08 version of this contract
claimed the opposite and was measured false.

**ADR-0028 collapsed four throw sites into one, and the caller sees no difference.**
Re-measured 2026-08-10 against the shipped module by hanging a throwing getter off a record
and reading the stack. Every shape now throws from the same line, `logger.ts:650` — the scan's
own copy, `{ ...record }`:

| shape | throws from, before ADR-0028 | throws from, now |
|---|---|---|
| hostile getter at depth 1, nothing else in the record | `_asJson`, `tools.js:167` | `fieldsCensored`'s copy |
| hostile getter at depth 1 **and** another key that changed | `fieldsCensored`'s copy | `fieldsCensored`'s copy |
| hostile getter at depth 2 or deeper | `@pinojs/redact`'s `cloneSelectively` | `fieldsCensored`'s copy, reached through `valueCensored` |
| hostile getter in `child()` or `setBindings()` bindings | `asChindings`, `tools.js:250` | `fieldsCensored`'s copy, reached through `bindingsScanned` |

**Why it collapsed.** `readIndexedProperty` used to catch its own read and `continue`, leaving
the key for pino to read again. Under ADR-0028 rule 4 the unreadable key is censored instead,
and censoring it **is** a change — so that one key triggers the copy, and the copy re-invokes
the getter. The throw is now unconditional rather than depending on some other key having
changed. **The observable outcome is identical in all four rows and identical to bare pino:
the log call throws and no line is emitted.**

**Why a sentinel was rejected. The ruling stands, and ADR-0028 sharpened rather than
overturned it (F-271).** The old reasoning turned on reach: the scan was bounded at depth 4
and declined to walk a class instance, so a sentinel bought a bounded guarantee, and the two
call sites that need it — the exception filter's `headersSent` arm, outside the try/catch
F-092 added, and `main.ts`'s last-chance boot handler — had no way to check the bound before
calling. That objection is now weaker: past the depth bound and inside a class instance both
become `[redacted]`, so there are no unreachable containers left.

What replaced it is stronger. **A sentinel alone is now worth exactly nothing**, because the
copy that throws happens before any sentinel could be written, on every record that carries a
hostile getter rather than on some of them. F-259's key-by-key copy is therefore a
precondition of a sentinel being worth anything at all, not a companion to it. Whether the
pair is worth its cost — a key-by-key copy on the path every log line takes — is a decision
for whoever owns F-253 and F-259 next. It is not made here.

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

### Casing stopped being load-bearing (ADR-0028)

This section used to explain which spelling `REDACT_PATHS` was keyed to, because `ipHash` was
censored and `ip_hash` was not: `{ ipHash: 'CAMEL', ip_hash: 'SNAKE' }` emitted
`"ipHash":"[redacted]","ip_hash":"SNAKE"`. **Both are censored now**, and so is every other
spelling, because neither is in `LOGGABLE_FIELDS`. The residual it named — a raw driver row
logged whole, carrying Postgres column names verbatim — closed with it.

The one place casing still matters is the allowlist itself. `LOGGABLE_FIELDS` holds the
logger's own snake_case field names (`request_id`, `tenant_id`, `duration_ms`, `err_name`),
which the logger builds itself. A name is matched exactly: adding `requestId` would not cover
`request_id`, and adding either does not cover the other.

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
- `ip_hash`, under either spelling. It is pseudonymous per tenant and a log aggregator is a
  weaker boundary than the database. `ipHash` is the TypeScript spelling a call site holds and
  `ip_hash` is the Postgres column; neither may be named.
- A request or response body, unless an explicit reviewed call logs named fields from it.
- A `tenant_id` other than the one the request is scoped to.
- An error's `message`, unless the call site opts in with a stated reason. Added
  2026-08-08 (F-090, F-108). The policy and its two opt-in call sites are in
  `error-envelope.md`, "What the 500 log line carries, and who owns changing it".
- Any property a library assigned to an error. `body-parser` puts the raw request body on
  `err.body`; `pg` puts colliding column values on `detail`.

### The never-allowlist: names that may never be added to `LOGGABLE_FIELDS`

Normative. **This is a prohibition, not a mechanism.** Nothing in the build enforces it —
these names are censored today only because they are not on the allowlist, which is the same
reason every other unnamed name is censored. What this list does is answer the question a
TASK asks at step 3 of "What a TASK does to log a new field": *may I name this one?* For
everything below the answer is **no, and the field may not be logged at all**, whatever a
call site wants it for.

Adding one of these to `LOGGABLE_FIELDS` is a leak, not a schema change. It needs a finding
and an ADR, and the answer will be to log something else.

| Class | Names |
|---|---|
| Client IP and network peer (GC-9's first prohibition) | `ip`, `ipAddress`, `clientIp`, `trustedClientIp`, `remoteAddress`, `remotePort`, `x-forwarded-for`, `x-shortkit-client-ip`, `fly-client-ip` |
| Credentials and tokens | `authorization`, `cookie`, `set-cookie`, `token`, `rawToken`, `tokenDigest`, `verificationToken`, `sessionToken`, `accessToken`, `refreshToken`, `apiKey`, `api_key`, `secret`, `x-shortkit-proxy-auth` |
| Passwords | `password`, `passwordHash`, `confirmation` |
| Pseudonymous identifiers | `ipHash`, `ip_hash` |
| Whole objects and concrete paths | `req`, `res`, `body`, `url` |

**Where these came from, and why the list is a prohibition rather than a longer allowlist.**
Twenty-five of them were `REDACT_PATHS`, the path list pino's `redact` option censored until
ADR-0028. Preserved verbatim, because deleting them would delete the design:

```text
req.headers.authorization        *.ip                    secret
req.headers.cookie               *.ipHash                rawToken
req.headers["fly-client-ip"]     req.body.password       tokenDigest
req.headers["x-forwarded-for"]   req.body.confirmation   verificationToken
req.headers["x-shortkit-client-ip"]  password            ip
req.headers["x-shortkit-proxy-auth"] token               ipHash
res.headers["set-cookie"]        *.password              *.token
*.secret                         *.rawToken              *.tokenDigest
*.verificationToken
```

The rest were measured 2026-08-08 as emitted **verbatim** by that list: `clientIp`,
`trustedClientIp`, `remoteAddress`, `ipAddress`, `remotePort`, `url`, `sessionToken`,
`accessToken`, `refreshToken`, `apiKey`, `api_key`, `passwordHash`, and a bare
`authorization` or `cookie` outside `req.headers` (F-261, F-262, F-266). `trustedClientIp` is
the accessor already named in
`design/stubs/apps/api/src/auth/resolve-rate-limit-principal.ts:28`, so the spelling this
system will actually hold was one of the uncensored ones. That is the whole argument for
ADR-0028 in one line: the denylist covered the spellings someone had thought of, and the
spelling that shipped was not among them.

**The wildcard and depth rules are gone with the mechanism.** `*.token` used to match exactly
one level, which is why every `*.x` was paired with a bare `x`. Nesting no longer changes the
answer: an unnamed key is censored at every depth, and a container the scan cannot inspect is
censored whole. The list above is therefore keyed on **names**, not paths, and a name is
prohibited wherever it appears.

**The two `x-shortkit-*` names are here ahead of the headers existing** (F-032).
`x-shortkit-client-ip` carries a raw client IP on every browser-originated API request, and
`x-shortkit-proxy-auth` carries `BFF_PROXY_SECRET` verbatim — a leaked log line would let
anyone forge `X-Shortkit-Client-IP` against Fly directly and defeat every IP-keyed auth
bucket. The `BFF_PROXY_SECRET` value is never logged on the Vercel side either
(`web-api-client.md`).

**What still covers what a name list cannot.** `serializers.err`, `hooks.logMethod` and
`formatters.log` keep an error's own properties and its message off the line under every key,
whatever it is named, and the `logger.child` and `logger.setBindings` wrappers do the same on
the bindings path. See "Why each mechanism is here" and "The two wrappers". The one surface no
mechanism reaches is `msg` and `err_stack`, which are free text by construction — see the last
bullet of "What the implementer must guarantee".

### The exception filter's error line

Added 2026-08-05 (F-106). Resolved 2026-08-08 (F-242, TASK-003 fix round 1).
`apps/api/src/common/errors/exception-filter.ts` is the only place in the API that writes
an arbitrary error into a log line, and TASK-003 owns that file as of the F-090 ruling.

**The line is on pino now, and the stack-versus-message question is decided.**
`errorLogFields` builds `err_name` always, `err_stack` as frames only, and `err_message`
only where the call site opts in. `error-envelope.md`, "What the 500 log line carries, and
who owns changing it", is normative for that policy and names the two call sites that pass
`includeMessage: true`.

**The constraint the policy rests on, stated once. No censoring scheme can reach inside a
string** — not the path denylist that shipped until ADR-0028, and not the field allowlist that
replaced it. A field is censored whole or emitted whole, so a message carrying a Postgres DSN
goes to the log intact or not at all. That is why the answer is which fields `errorLogFields`
builds rather than which fields to censor, and it is also why the stack is emitted as frames
with the `${name}: ${message}` header stripped at construction: `err.stack` opens with a
`${name}: ${message}` line, and nothing can remove the first line of a string after the fact.

An earlier version of this section claimed a path list "cannot help either way: it matches
paths, and neither a message nor a stack has one." That was measured false in one direction
and the correction is kept for the reader who remembers it — once a serialiser turned an error
into an object, `err.message` and `err.stack` were ordinary paths and pino censored them.
Moot since ADR-0028; `err_message` and `err_stack` are on the allowlist, and what protects the
message is that `errorLogFields` does not build it unless the call site opts in.

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

**Registered 2026-08-10 at commit `45cf578`** (F-243 clause 2), as
`app.use(helmet({ frameguard: { action: 'deny' } }))` on the app in `main.ts`, immediately
after `NestFactory.create` and **before** `setGlobalPrefix`. On the app rather than inside a
module, so it covers the branded 404 `ApiExceptionFilter` builds and anything mounted outside
the Nest module graph (ADR-0013) — module middleware covers the routed responses and misses
the error ones, which is the half that goes wrong quietly.

| Header | Value | Scope |
|---|---|---|
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains` | every response |
| `X-Content-Type-Options` | `nosniff` | every response |
| `X-Frame-Options` | `DENY` | every response |
| `Referrer-Policy` | `no-referrer` | every response except the redirect 302 |
| `Content-Security-Policy` | helmet default | API responses |

**`frameguard: { action: 'deny' }` is the one option overridden.** helmet's default is
`SAMEORIGIN`; the table above says `DENY` and the table wins. Everything else is helmet's own
default. `helmet@8.3.0` is exact-pinned in `apps/api/package.json` under the ADR-0018
precedent that pins `pino@10.3.1`.

`preload` is **not** set on HSTS: submission is close to irreversible and the apex domain
is unregistered.

`X-Powered-By: Express` is removed as a side effect of helmet's defaults. The table does not
name it and nothing asserts it.

**Asserted against `node dist/main.js` on loopback**, seven integration tests in
`security-headers.int-spec.ts`, covering the routed `/health` 200 and the branded 404. Not
asserted against the deployed image: HSTS is only meaningful over TLS, which loopback is not.

### Two deliberate exceptions on the redirect path

Both already normative in `redirect-resolution.md`. They override the defaults above.

| Response | Header | Value | Why |
|---|---|---|---|
| redirect 302 | `Referrer-Policy` | `unsafe-url` | passing the short URL to the destination is the point of an attribution referrer, and the link is public |
| branded 404 | `Content-Security-Policy` | `default-src 'none'; img-src https:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'` | tighter than helmet's default; the page interpolates tenant-controlled branding (F-006) |

## Invariants a caller may rely on

1. Logging a whole request or response object never emits a credential, an IP, or a
   cookie. **True since ADR-0028 (F-261 closed), and for a stronger reason than this
   invariant used to claim:** the object does not reach the line at all. `req` is not a named
   field, so `logger.info(req, '…')` emits `"req":"[redacted]"`. There is no header list to
   keep current. It was false until 2026-08-10, when the same call emitted
   `"remoteAddress":"203.0.113.7"`, `"remotePort":54321` and the concrete
   `"url":"/l/abc?token=SEKRIT"` in the clear while the six `req.headers.*` paths were
   censored — which is what made it dangerous rather than obvious.

   **This invariant is not permission to log a request object.** It tells you nothing;
   `request_id`, `route`, `status` and `duration_ms` are what the call site wanted.
2. Every line inside a request carries `request_id`; every line inside a tenant
   transaction carries `tenant_id`.
3. The API sends no `Access-Control-Allow-Origin` header, for any origin, on any route.
4. HSTS, `nosniff` and `DENY` are present on every API response including errors.
   **True since 2026-08-10** (F-243 clause 2 closed), asserted by seven integration tests
   against `node dist/main.js` on loopback. Not asserted against the deployed image.
5. **An `Error` reaches the line only as `err_name` and an `err_stack` of frames.** Not
   `message`, not `body`, not `detail`, not any property a library assigned. Holds under any
   key spelling and at any depth the scan reaches — `{ err: e }`, `{ error: e }`,
   `{ cause: e }`, `[e, e]`, `log.error(e)`, `log.error(e, 'context')` — and it holds whether
   the error arrived in the log record or in **logger bindings**, through either
   `logger.child(bindings)` or `logger.setBindings(bindings)`.

   **Narrowed by ADR-0028, and the narrowing is a diagnostic loss rather than a leak.** An
   error nested inside a container whose key is **not** on `LOGGABLE_FIELDS` is censored with
   its container and lost, not reduced: `{ ctx: { err: e } }` emits `"ctx":"[redacted]"`.
   Depth 5 and an error inside a class instance behave the same way. What a caller may rely
   on is that no such shape ever emits the error's properties. What it may not rely on is
   seeing the error at all. **Pass the error at the top level.**
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
   throws and no line is emitted, now from one site rather than four. See "A log call can
   still throw" above for what a caller with nowhere to escape to must do instead.
8. **A field that is not named in `LOGGABLE_FIELDS` does not reach the line, and its key
   does.** `"attemptCount":"[redacted]"`, never a dropped key, so the operator can see which
   field exists and what it is called. The corollary a caller must plan for: **a field you
   forgot to name is censored, silently, with every gate green.**

## What the implementer must guarantee

- **A test asserts redaction works**: build a log line from a request carrying
  `Authorization: Bearer x.y.z` and `Cookie: sk_at=...`, and assert the serialised output
  contains neither value and contains `[redacted]`.
- A test asserts no response carries `Access-Control-Allow-Origin`.
- **Logging a new field is three steps, and the third is the one people skip.** Write the log
  call; add the name to `LOGGABLE_FIELDS` in the same commit, one name per line, sorted, with
  the owning file in a trailing comment; then check it against "What may never appear in a log
  line" and the never-allowlist. If the field is a raw IP, a token, a password, a digest, a
  request body, a concrete URL path or a foreign `tenant_id`, the answer is not to name it —
  it is that the field may not be logged. A field that skips step 2 emits
  `"<field>":"[redacted]"`, which is the designed failure and is visible in the TASK's own dev
  run.
- **Never log a request or response object.** Log named fields from it. `logger.info(req, …)`
  emits `"req":"[redacted]"` and tells you nothing; `request_id`, `route`, `status` and
  `duration_ms` are what the call site wanted.
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
- **Never introduce a second pino instance, and the cost of doing it went up with ADR-0028.**
  The allowlist, the three literal mechanisms and the two bindings wrappers are all
  configuration on one logger, so a second instance built anywhere is a hole with none of
  them — and since `redact` was removed there is no residual censoring behind it, so the hole
  is every field on every line that instance writes. Import `logger` from
  `apps/api/src/observability/logger.ts`, and do not re-derive it from ADR-0022, which
  records the decision and deliberately carries no literal (F-250). F-268 proposes a lint rule
  for this and is unowned.
- **Never pass `redact`, `serializers` or `formatters` to `logger.child`.** It throws a
  `TypeError` naming the option and the reason. pino replaces these rather than merging them,
  so a child that supplied `formatters.log` would run with no scan at all.
- **Wrap the log call where there is nowhere left to escape to.** A record spread from
  caller-controlled data may carry a property whose getter throws, and that throws out of the
  log call with no line emitted. See "A log call can still throw" (F-253). The exception
  filter's `headersSent` arm and `main.ts`'s last-chance boot handler are the two places
  where that converts a logged failure into an unhandled one.
- **Never interpolate an error's message into a log message string.**
  `` logger.error(`failed: ${e.message}`) `` puts the message into `msg`, which no
  serialiser, formatter or wrapper reaches. Pass `{ err: e }` and a fixed context string
  instead. `apps/api/src/tenancy/tenant-context.ts:247` does the interpolated form today; it
  is F-274, reported and not fixed. **This bullet got sharper with ADR-0028: `msg` and
  `err_stack` are the only uncensored surfaces left, so they are the only ones worth
  attacking.** The arguments path is covered — `hooks.logMethod` reduces every value pino
  would interpolate before `format` runs (F-260) — but a string a call site built itself is
  reachable by nothing here.
- Never log `error.request` or `error.config` from an HTTP client. Both carry headers.
- **Never log a database error's `detail`, `hint`, `where`, `internalQuery` or `query`.**
  Added 2026-08-05 (F-120). A `pg.DatabaseError` populates `detail` on a unique violation
  with the colliding column values verbatim (`Key (slug)=(abc) already exists`), and
  `where` and `internalQuery` carry query text from a trigger or function body. No censoring
  scheme reaches inside a string, so censoring is not a fallback here. The readable fields on
  a caught database error are the SQLSTATE and the constraint name, both through the
  accessors in `tenant-context.md`, "Driver errors inside `fn`".

## Versioning

`LOGGABLE_FIELDS` is **append-only**, and a name may be appended only after it has been
checked against "What may never appear in a log line" and the never-allowlist. Removing a
name silently censors a field that was on the line yesterday, so a removal needs a reason in
the commit message the same way adding a redact path used to. One name per line, sorted, with
the owning file in a trailing comment.

`REDACT_PATHS` was append-only under the same rule until ADR-0028 removed it entirely. That
ADR is the reason in the commit message. Changing the header table still requires amending
ADR-0022.

**The allowlist couples this file to `error-envelope.md`'s field names.** `err_name`,
`err_message` and `err_stack` are on the list, so renaming any of them now censors it as well
as breaking every saved log query. That rename needs both contracts amended.

`serializers.err`, `hooks.logMethod`, `formatters.log`, the two bindings wrappers and
`childOptionsChecked` are not removable by a TASK. Each closes a leak that shipped once, each
is defended by tests in `logger.spec.ts`, and a change to any of them needs a finding and an
ADR amendment before the code moves. Replacing either wrapper with a `formatters.bindings`
entry is a removal, not a refactor — see "The two wrappers".

**`MAX_SCAN_DEPTH`'s versioning rule inverted with the polarity.** It used to be that raising
it was additive and lowering it was a removal, because past the bound a value was passed
through. Past the bound a container is now censored, so **lowering** it is additive to safety
and **raising** it widens what may reach a line. Either direction is now a deliberate change
to what the allowlist lets through, and it belongs in a commit that says so.

`ErrorLogFields` grows by adding an optional field. Renaming `err_name`, `err_message` or
`err_stack` breaks every saved log query, so it needs the same amendment.

**Where the logger's configuration lives.** This contract, and nowhere else. ADR-0022 fenced
a copy of the `pino({…})` call until 2026-08-08; that copy went stale the day F-244 landed
and is now removed rather than synced (F-250), because three copies in three artifacts is
what produced F-244, F-248, F-249 and F-250 in sequence. ADR-0022 still owns the CORS
decision and the header table, and changing either requires amending it. Its redaction clause
is **superseded by ADR-0028** — censoring is now a field allowlist, not a path denylist — and
that is the only clause ADR-0028 touches. The wave-1 stub at
`design/stubs/apps/api/src/observability/logger.ts` is superseded and carries a banner
saying so. **A fourth artifact carrying this configuration is a finding, not a convenience.**
