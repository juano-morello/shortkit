# Contract: structured logging, redaction, CORS, and security headers

- **Boundary:** every log line the API emits; every response header it sets.
- **Normative form:** `apps/api/src/observability/logger.ts` and `apps/api/src/main.ts`. This contract's § "Logger" fence is the single normative statement of the logger's configuration and is compared to the shipped file by a drift test. The wave-1 stub at `design/stubs/apps/api/src/observability/logger.ts` is **superseded** (F-249) and its config is unsafe to copy; ADR-0022 no longer carries a copy at all (F-250). That stub is deleted when TASK-003 reaches `done` (ADR-0039). It survived the 2026-08-11 retirement sweep only because TASK-003 is in rework, and it is the strongest case in the repository for retiring a stub the day its file ships rather than the day its TASK closes.
- **Produced by:** TASK-003.
- **Consumed by:** every API TASK. **Nothing may opt out, and since 2026-08-11 that sentence is
  a mechanism rather than a convention** (TASK-060, AC-116, closing F-247 and F-278). The two
  named exceptions this line carried from 2026-08-10, `apps/api/src/db/client.ts` and
  `apps/api/src/tenancy/tenant-context.ts`, are **retired**: both modules import `logger` from
  `observability/logger` and neither imports `@nestjs/common` at all, so nothing is carved out
  of the claim. What enforces it, what it costs and what it still does not reach are stated
  once, in "What the implementer must guarantee" below. ADR-0041 rules how far "or any other
  logger" reaches; ADR-0042 rules where the enforced tree ends.
- **ADRs:** ADR-0022, and ADR-0028 which supersedes its redaction clause only — ADR-0022's
  CORS decision and header table stand. ADR-0041 rules how far "or any other logger" reaches;
  ADR-0042 rules which prohibition follows the source tree and which follows the package.
  Enforces GC-9.

## Logger

Amended 2026-08-08 (F-242, F-244, F-248, F-249), again 2026-08-08 fix round 3 (F-250, F-251,
F-252, F-253, F-255, F-258), again 2026-08-09 fix round 4 (F-259, F-260, F-263, F-265,
F-267, F-269), again 2026-08-10 for ADR-0028 (F-261, F-262, F-266) and F-243 clause 2, and
again 2026-08-10 fix round 5 (F-277 the message position, F-279 the child-options
predicates). The block below matches the shipped `apps/api/src/observability/logger.ts` on
pino 10.3.1 at commit `43e10e7`, verified by `logger-contract-drift.spec.ts` at 6 passed of 6
rather than by reading.

**Prose corrected 2026-08-10 after round 7, with no change to the fenced block and no change to
any shipped file (F-283 the `toJSON` class, F-281 the request/response sniff).** Two claims this
document made were measured false: that F-265's `toJSON` class was closed, and that pino's
request mapping is what keeps a whole request object off the line. Both are corrected where they
appeared — this section's ADR-0028 summary, "Door six", "The residuals", and invariants 1 and 2.
`logger-contract-drift.spec.ts` still passes 6 of 6, which is what says the fence was untouched.

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
| `hooks.logMethod` | every call shape that would put an error's message into `msg`, and every argument position pino formats, the message position included since `43e10e7` (F-277) | "Why each mechanism is here", "Door six" |
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
- **Two of the three residuals closed as a class. The third, F-265's `toJSON`, is narrowed
  rather than eliminated, and this bullet claimed otherwise until 2026-08-10 (F-283).** A
  container the scan cannot inspect *by walking* — past the depth bound, or with a prototype
  that is neither `Object.prototype` nor `null`, a class instance included — is censored
  rather than passed through. A plain object carrying an own **non-enumerable** `toJSON` is
  not that container: it has `Object.prototype`, so the scan walks it, and if its own
  enumerable keys are all named or absent then nothing is replaced, `fieldsCensored` returns
  it **by reference**, and pino's stringifier serialises it from `toJSON`'s return value,
  which no scan over keys ever saw. Measured at round 7 across thirteen routes: **two closed,
  both in the message position, by F-277's fix at `43e10e7`; nine still emit `toJSON`'s return
  value; two never reached the mechanism.** The nine are enumerated in "The residuals: two
  closed as a class, one narrowed" below. **F-265 stays open and narrowed** — ADR-0028, "What
  this ADR does not decide". Severity minor: the shape requires a container carrying a hidden
  `toJSON`, no library in this tree produces one, and no shipped call site reaches it. Do not
  read this contract as saying a hidden `toJSON` cannot fire.
- **Invariant 1 is true**, and the mechanism is this module's key rule rather than pino's
  request mapping — corrected 2026-08-10 (F-281). A request- or response-shaped record is
  re-shaped by pino into `{ req: … }` or `{ res: … }` before anything here runs, and the
  re-shaping censors nothing; `req` and `res` are not in `LOGGABLE_FIELDS`, so the whole thing
  is `[redacted]` and there is no header list to keep current. See "Door six" for what the
  re-shaping does and does not do.
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
- **A second pino instance anywhere is a hole with none of these mechanisms in it.** That was
  already true; the blast radius changed from "the 25 paths" to "every field on every line
  that instance writes". F-268 is closed and the import door is shut under `apps/api/src` by
  lint and by the enumeration spec; what those two reach and what they do not is in "What the
  implementer must guarantee".
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

  // Every non-null object in the message position, decided by TYPE and not by keys (F-277).
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

// `LOG` branches on `typeof o === 'object'`, so `null` takes the record branch too, and a
// leading `undefined` is shifted past. Everything from here on is interpolated.
function messageArgumentIndex(args: readonly unknown[]): number {
  return typeof args[0] === 'object' || args[0] === undefined ? 1 : 0;
}

// `log.error(record, value)`. The value in the message position is filed under `err`, where
// `serializers.err` owns it, and the message becomes the string a positional error already
// gets. Its CALLER decides which values arrive here (F-277: every non-null object, not only
// an `Error`); this is the same move for all of them.
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
    pinoWouldReplace(supplied, option),
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

// One predicate PER OPTION, because pino reads the three differently (F-279): `redact` is an
// ordinary property read (`proto.js:161`), so it walks the prototype chain, while
// `serializers` (`:115`) and `formatters` (`:136`) go through `options.hasOwnProperty(…)`
// called as a method on the options object. The union with `Object.hasOwn` is deliberate; see
// "A child's options are an opt-out, so they are refused".
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

// `options.hasOwnProperty(option)`, called the way pino calls it and unable to throw.
function suppliedClaimsOwnProperty(supplied: object, option: string): boolean {
  try {
    const claim = (supplied as { hasOwnProperty?: (key: string) => unknown }).hasOwnProperty;

    return typeof claim === 'function' && Boolean(claim.call(supplied, option));
  } catch {
    return false;
  }
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

### Door six: the argument list, and what each position gets

**Normative. Written 2026-08-10 (F-277); three references pointed at this section and it did
not exist.** The mechanism table's `hooks.logMethod` row and two comments inside the fence
deferred their rationale to it, which is the rationale the message-position leak turned on.

`_asJson` builds a line out of the RECORD, and `asChindings` out of BINDINGS. Neither of them
builds `msg`. `genLog`'s `LOG` (`tools.js:47-77`) calls
`format(msg, formatParams, formatOpts)` — `quick-format-unescaped` — before `write()` runs, so
no serialiser, formatter or bindings wrapper is anywhere on that path. **The argument list is
the third place a line is built, and the only mechanism on it is `hooks.logMethod`.**

pino's argument list has three positions. `messageArgumentIndex` returns 1 when `args[0]` is an
object (`null` included) or `undefined`, and 0 otherwise, so a record exists only at index 0
and the message argument can be a container only at index 1.

| position | decided by | mechanism | result |
|---|---|---|---|
| the record, `args[0]` | its KEYS | `formatters.log` → `fieldsCensored(record, 1)`, `err` exempt at depth 1 and owned by `serializers.err` | a named key keeps its value to `MAX_SCAN_DEPTH`; every other key is `[redacted]`, key intact |
| the message argument, when it is a non-null object | its TYPE, not its keys | `hooks.logMethod` → `errorMovedOntoTheRecord` | moved onto the record under `err`; `msg` becomes `an error was logged with no context string` |
| the message argument, when it is anything else | nothing | none | verbatim. A string is free text and no censoring scheme reaches inside one |
| every argument after the message | its VALUE | `hooks.logMethod` → `interpolationSafe`, which is `valueCensored(value, 1)` | an `Error` becomes `errorLogFields`; a container is walked from depth 2; a class instance, a `Buffer` or anything past the bound is `[redacted]`; a primitive is verbatim |

**The key rule does not run on the message argument or on a format argument, and that is not
an omission.** Both arrive under no key, so there is no field name to decide about:
`logger.error('a %s', 'b')` has to interpolate `b`. The record path decides by key, the
argument list decides by type and by value.

**One thing pino does to the RECORD before any of this, and row 1 does not say it.** `LOG`
(`tools.js:47-55`) sniffs the record's shape through **two doors**, not one:
`o.method && o.headers && o.socket` (`tools.js:51-52`) replaces the whole record with
`mapHttpRequest(o)`, which is `{ req: … }`, and the `else if` at `tools.js:53-54`,
`typeof o.setHeader === 'function'`, replaces it with `mapHttpResponse(o)`, which is
`{ res: … }`. Every other own key of the caller's object is discarded at that point, before
`formatters.log` sees anything.

**The re-shaping censors nothing, and this paragraph said otherwise until 2026-08-10 (F-281).**
Read in pino-std-serializers 7.1.0: `reqSerializer` (`lib/req.js:66-93`) builds
`Object.create(pinoReqProto)` and assigns `id`, `method`, `url`, `headers`, `remoteAddress`,
`remotePort` — plus `query` and `params` when the request carries them — as own enumerable
properties, and hangs the **original request object** off a non-enumerable `raw`. `resSerializer`
(`lib/res.js:35-42`) is the same shape and carries `res.getHeaders()`, which is where a
`Set-Cookie` lives. Measured 2026-08-10 by calling `mapHttpRequest` directly: the returned `req`
carries `headers.authorization`, `headers.cookie` and `remoteAddress` verbatim, and `req.raw`
is the request object itself. It is a re-shaper. Nothing in it is a redaction.

**What censors is this module's own key rule.** The replaced record is `{ req: … }` or
`{ res: … }`, `formatters.log` runs on it inside `_asJson`, and neither `req` nor `res` is in
`LOGGABLE_FIELDS`. Measured 2026-08-10 on the shipped singleton: `logger.info(requestLike, '…')`
emits `"req":"[redacted]"` and `logger.info(responseLike, '…')` emits `"res":"[redacted]"`.
**The coverage does not depend on the replacement at all**, in two independent ways:

- **Bindings skip the sniff and are covered anyway.** `asChindings` never calls `LOG`, so a
  request-shaped object in `logger.child(bindings)` is not re-shaped. Measured:
  `"method":"[redacted]","url":"[redacted]","headers":"[redacted]","socket":"[redacted]"` —
  each key censored on its own, because none of them is named.
- **Naming `req` would not open it.** `reqSerializer`'s output has prototype `pinoReqProto`,
  which is neither `Object.prototype` nor `null`, so `valueCensored` censors it as a non-plain
  container even if a future TASK adds `req` to `LOGGABLE_FIELDS`. Measured: the prototype
  identity check is false for both `mapHttpRequest` and `mapHttpResponse` output. Adding `req`
  or `res` to the allowlist stays forbidden — both are on "The never-allowlist" — but the
  reason a hypothetical slip would not leak is the prototype rule, not the mapping.

That is why the invariant-1 row reads `"req":"[redacted]"` for a whole request object rather
than a censored key per field, and it means **a request-shaped record loses its named fields
too**. Measured:
`logger.info({ request_id, route, method, headers, socket }, '…')` emits
`"req":"[redacted]"` and nothing else, so `request_id` and `route` are gone, while the same
record without `headers` and `socket` keeps both and censors `method`. Invariant 2 does not
hold for a record that trips either door. The consequence is an observability defect — a
correlation id vanishing from an audit line — and not a leak. The remedy is the one this
contract prescribes twice: log named fields, never a request or response object.

**Why the message position is moved rather than reduced in place.** `format` returns a
non-string message unchanged, so a reduced container would leave `msg` an object rather than a
line an aggregator can index; a container handed to pino's stringifier can still fire an own
non-enumerable `toJSON` that the scan returned by reference; and one policy per position beats
two policies chosen by `instanceof`. The alternatives and their costs are in ADR-0028, "The
argument list: one policy per position".

**Format arguments start one level shallower than a record, and the level is the price of the
seam.** `valueCensored(value, 1)` walks a container it holds at `depth + 1`, so the container
is walked from 2, where the top-level `err` exemption does not fire. That exemption exists only
because `serializers.err` runs after `formatters.log`, and nothing runs after `format`. Route a
format argument through `fieldsCensored(value, 1)` instead and `logger.error('ctx %o',
{ err: e })` reopens.

**"Scanned" is the wrong word for two of the four rows, and the file used to say it.**
`logger.ts:212-222` claimed "A CONTAINER in either position is scanned" until `43e10e7`, and
that sentence was false in both directions: a container in the MESSAGE position is not
scanned at all, it is moved onto the record under `err` and reduced to `err_name` by
`serializers.err`; a container in a FORMAT-PARAMETER position is the one that is scanned, by
`valueCensored` from depth 2. Both are covered. They are covered by different mechanisms with
different outputs, and a reader who carries one answer across to the other position gets the
wrong one. The sentence is deleted rather than restated as a claim about "either position".

**Status, 2026-08-10, after `43e10e7`. All four rows ship.** Row 2 was open until then:
`logger.ts:239` tested `args[1] instanceof Error`, so a non-`Error` container in the message
position reached `msg` verbatim, measured as
`"msg":{"statusCode":401,"clientIp":"203.0.113.9","headers":{"authorization":"Bearer …"},
"body":"{\"password\":\"…\"}"}`. That was also a regression, because pino applied the deleted
`redact` list's wildcard stringifier to the `msg` value too (`tools.js:205`), so `*.password`,
`*.token`, `*.secret`, `*.rawToken`, `*.tokenDigest`, `*.verificationToken`, `*.ip` and
`*.ipHash` were censored inside `msg` until ADR-0028 removed the list. Re-measured against the
shipped singleton 2026-08-10, one process, `NODE_ENV=test`:

| call | the line |
|---|---|
| `logger.error({ request_id }, container)` | `"request_id":"r-2","err":{"err_name":"non-error throwable (object)"},"msg":"an error was logged with no context string"` |
| `logger.error({ request_id }, { method, headers, socket, url })` | the same, `err_name` only |
| `logger.error({ request_id }, { toJSON: () => ({ password }) })` | the same. The message position never reaches a stringifier, so the `toJSON` mechanism ADR-0028 leaves open elsewhere does not fire here |
| `logger.error({ request_id }, ['first', { password }])` | the same |
| `logger.error(undefined, requestLike)` | the same, with no `request_id` |
| `logger.error({ request_id }, null)` | `"msg":null`, unchanged |
| `logger.error({ request_id }, 42)` | `"msg":42`, unchanged |
| `logger.error({ request_id }, () => …)` | no `msg` key at all, unchanged |
| `logger.error({ request_id }, 'a plain string')` | `"msg":"a plain string"`, unchanged |

**The hook's ERROR-MESSAGE branch runs before the message-position rule, and it wins.**
`messageWouldBeTakenFromTheError` fires whenever the record carries a truthy `err` and no own
`msg`, and it calls `method` with the record and the fixed string, so **any second argument is
dropped there rather than moved**. Measured: `logger.error({ err: realError }, container)`
emits the real error's `err_name` and `err_stack` and no trace of the container. No leak, and
a diagnostic loss on a shape with no call site. Priced in ADR-0028's accepted costs.

**A record that supplies its own `msg` and a container in the message position writes `msg`
twice.** `errorMovedOntoTheRecord` keeps the record's `msg` and hands pino the fixed string as
well, so the line carries `"msg":"callers own msg","msg":"an error was logged with no context
string"`. Measured on the shipped singleton with an `Error` in that position, which is the
branch that behaved this way before `43e10e7` too, so F-277 widened the shape rather than
introducing it. A JSON parser that keeps the last key reads the fixed string. Not a leak: both
values are `msg`, which is on the allowlist and free text either way.

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

**What the check tests changed 2026-08-10 (F-279), and the guarantee is now stated per option
rather than uniformly.** `Object.hasOwn` for all three was one predicate too few, because pino
does not read the three the same way. `pinoWouldReplace` matches pino option by option, and
takes the UNION of pino's read with `Object.hasOwn`:

| option | how pino reads it | what `pinoWouldReplace` answers `true` on |
|---|---|---|
| `redact` | `proto.js:161`, an ordinary property read: `typeof options.redact === 'object' && options.redact !== null`. It walks the PROTOTYPE CHAIN, and its `Array.isArray` arm is subsumed because an array is a non-null object | an own `redact` of any value, or an INHERITED `redact` holding a non-null object. The read goes through `readIndexedProperty`, so a getter that throws answers `false` here and the hazard lands in pino's own read |
| `serializers` | `proto.js:115`, `options.hasOwnProperty('serializers')` called AS A METHOD on the options object | an own `serializers` of any value, or an options object whose own `hasOwnProperty` claims one |
| `formatters` | `proto.js:136`, the same method call | the same, for `formatters` |

**The union, not pino's read alone, and deliberately.** `Object.hasOwn` keeps
`{ serializers: undefined }` and `{ redact: undefined }` refused, which is the
presence-not-truthiness behaviour F-263's tests pin, and it still refuses an
`Object.create(null)` options object carrying an own `serializers`, which pino would throw on
rather than merge. Refusing an option pino would not have replaced costs a child logger nobody
builds. Missing one costs the only mechanism between an unnamed field and the line.

**What a caller may rely on:** a child logger that reaches pino with any of the three in force
is not reachable through `logger.child`. What a caller may NOT rely on: a symmetry between the
three. `Object.create({ redact: [...] })` is refused and `Object.create({ serializers: {...} })`
is accepted, because pino would install the first and not the second. Measured on the shipped
singleton 2026-08-10: prototypic `redact` throws, a lying `hasOwnProperty` throws naming
`serializers, formatters`, `{ serializers: undefined }` throws, and `{ level: 'warn' }` builds
a child.

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

### The residuals: two closed as a class, one narrowed

**Corrected 2026-08-10 (F-283). This section claimed all three closed. Two did. F-265's
`toJSON` class is narrowed by two routes of thirteen and nine remain open.**

**Two of the three residuals closed as a class rather than one at a time (ADR-0028).** An error
at depth 5 and an error inside a class instance (F-255) each reached a line carrying whatever a
library had assigned, because "the scan cannot inspect this" meant "emit it whole". It now means
`[redacted]`. Measured against the shipped logger:

| shape | before ADR-0028 | now |
|---|---|---|
| `{ a: { b: { c: { d: { err: parseFailure } } } } }` | the raw request body | `"a":"[redacted]"` |
| `{ ctx: new Ctx(parseFailure) }` | the raw request body | `"ctx":"[redacted]"` |
| `{ ctx: { toJSON: () => parseFailure } }` | the raw request body | `"ctx":"[redacted]"` |
| `logger.info(req, '…')` | `remoteAddress`, `remotePort`, the concrete `url` | `"req":"[redacted]"` |

**The third row above is censored by the KEY rule, not by anything that reaches `toJSON`.**
`ctx` is not in `LOGGABLE_FIELDS`, so its value is replaced without being walked. Change the
key to a named one and the mechanism fires. That distinction is what this section used to
lose, and it is the whole of F-283.

**What replaced the two that closed is a diagnostic loss, and it is a cost rather than a
residual.** An `Error` nested inside a container that is not a named field —
`{ ctx: { err: e } }`, F-248's third shape — is censored **with** its container instead of being
reduced to `err_name` and `err_stack`. The remedy is the one this contract already prescribes:
pass the error at the top level, where it is reduced under any key spelling.

`MAX_SCAN_DEPTH` is still 4 and its meaning inverted with the polarity. It no longer bounds
what is *covered*; it bounds what is *walked*, and a container past it is censored. Raising it
lets a deeper **named** field keep its value and closes no leak. The bound also still makes a
self-referential record terminate.

#### F-265's `toJSON` class: open, narrowed, minor

**The mechanism.** A plain object carrying an own **non-enumerable** `toJSON` has
`Object.prototype`, so `valueCensored` walks it rather than censoring it. If its own enumerable
keys are all named or absent, `fieldsCensored` replaces nothing and returns **the same object by
reference**. `JSON.stringify` inside pino then serialises it from `toJSON`'s return value — a
value no scan over keys ever saw. A scan over keys cannot see it, which is why no widening of
`LOGGABLE_FIELDS` or of `MAX_SCAN_DEPTH` addresses it.

**Thirteen routes measured at round 7, `toJSON` returning `{ password: <marker> }`. Two closed,
nine open, two never reach the mechanism.** A later TASK may rely on the closed rows and may
**not** rely on the open ones.

| route | emitted | status |
|---|---|---|
| under a named key at depth 2 | `"route":{"password":"<marker>"}` | **OPEN** |
| under a named key at depth 3 | `"route":{"route":{"password":"<marker>"}}` | **OPEN** |
| child bindings, `logger.child(b)` | `"route":{"password":"<marker>"}` | **OPEN** |
| grandchild bindings | `"route":{"password":"<marker>"}` | **OPEN** |
| `logger.setBindings(b)` | `"route":{"password":"<marker>"}` | **OPEN** |
| format argument `%o` | `"msg":"fmt {\"password\":\"<marker>\"}"` | **OPEN** |
| format argument `%j` | `"msg":"fmt {\"password\":\"<marker>\"}"` | **OPEN** |
| format argument `%O` | the object inside `msg` | **OPEN** |
| an array element under a named key | `"route":[{"password":"<marker>"}]` | **OPEN** |
| the message position, with a record | `"err":{"err_name":"non-error throwable (object)"}` | closed by F-277's fix at `43e10e7` |
| the message position, no record | the same | closed by F-277's fix at `43e10e7` |
| as the whole record | `"request_id":"ok"` only. `_asJson` walks own keys, so a record-level `toJSON` never fires | never reached the mechanism |
| under the top-level `err` key | `"err":{"err_name":"non-error throwable (object)"}` | never reached the mechanism |

**F-277's fix removed one route to a stringifier and that is exactly what it removed.** The
class is **narrowed rather than eliminated**. Severity **minor**, unowned, disclosed in
ADR-0028's "What this ADR does not decide": reaching it requires handing this logger a container
that carries a hidden `toJSON`, no library in this tree produces one, and no shipped call site
does it. It is not a reason to skip the allowlist and it is not a reason to treat a
library-supplied container as safe under a named key.

**What a caller may rely on, stated as a boundary.** Under a **named** key, a value this module
returns by reference is serialised by pino, not by this module, and pino honours `toJSON`. So:
put fields under named keys, not containers you did not build. `err` is exempt from this — it is
reduced by `errorLogFields` to three fields and never handed on whole.

**What would close it and why it is not done here:** a key-by-key rebuild of every walked
container instead of the copy-on-change `{ ...record }`, which pays a copy on every log line to
cover a shape with no call site, plus F-253's throwing-getter interaction. That is an ADR
amendment on the F-265 owner, not a patch.

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

**What the message-position fix added on top, measured the same way at `43e10e7`:**
`logger.error(record, container)` went 2526 → 2706 ns, and every other shape stayed inside
run-to-run noise. One such line is 0.011% of GC-1's ceiling. The full table is in ADR-0028,
"Re-measured after the message position closed".

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
| `Content-Security-Policy` | helmet default, with `frame-ancestors 'none'` | API responses |

**Two options are overridden, and the second is why the first works.**
`frameguard: { action: 'deny' }` replaces helmet's `SAMEORIGIN`, because the table says
`DENY`. `contentSecurityPolicy: { useDefaults: true, directives: { 'frame-ancestors':
["'none'"] } }` replaces helmet's default `frame-ancestors 'self'`. Everything else is
helmet's own default. `helmet@8.3.0` is exact-pinned in `apps/api/package.json` under the
ADR-0018 precedent that pins `pino@10.3.1`.

**Why the CSP directive is not decoration (F-280, decided 2026-08-10, ADR-0022 amended).**
CSP Level 2 requires a browser that supports `frame-ancestors` to ignore `X-Frame-Options`,
so until this override the one header the implementer deliberately set was the one every
browser discarded, and the effective framing policy was `'self'`. Measured on
`node dist/main.js`: both `GET /health` and the branded 404 carried `X-Frame-Options: DENY`
beside a CSP saying `frame-ancestors 'self'`. **The two headers now agree, and the CSP is the
one that is enforced.** The rejected alternative was to keep `'self'` and re-label
`X-Frame-Options` as legacy in this table; ADR-0022 records why it lost.

**`frame-ancestors` does not fall back to `default-src`.** A response that replaces this CSP
with its own — the branded 404 below is the one that does — carries no framing policy at all
unless its own directive list names `frame-ancestors`. That is a requirement on
`redirect-resolution.md`, not on this file.

`preload` is **not** set on HSTS: submission is close to irreversible and the apex domain
is unregistered.

`X-Powered-By: Express` is removed as a side effect of helmet's defaults. The table does not
name it and nothing asserts it.

**Asserted against `node dist/main.js` on loopback**, eight integration tests in
`security-headers.int-spec.ts`, covering the routed `/health` 200 and the branded 404. The
eighth is F-280's and went green with the CSP override at `43e10e7`. Not asserted against the
deployed image: HSTS is only meaningful over TLS, which loopback is not.

### Two deliberate exceptions on the redirect path

Both already normative in `redirect-resolution.md`. They override the defaults above.

| Response | Header | Value | Why |
|---|---|---|---|
| redirect 302 | `Referrer-Policy` | `unsafe-url` | passing the short URL to the destination is the point of an attribution referrer, and the link is public |
| branded 404 | `Content-Security-Policy` | `default-src 'none'; img-src https:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'` | tighter than helmet's default; the page interpolates tenant-controlled branding (F-006) |

**Open against `redirect-resolution.md`, raised 2026-08-10 and not decided here (F-280).**
That directive list names no `frame-ancestors`, and `frame-ancestors` is not covered by
`default-src`. A response that replaces helmet's CSP with this one therefore replaces
`frame-ancestors 'none'` with nothing and falls back to `X-Frame-Options`, which is the
weaker of the two mechanisms and the one this contract has stopped relying on. The directive
belongs in that list. `redirect-resolution.md` is normative for that response and this row
quotes it, so the fix is made there and copied here, not the other way round.

## Invariants a caller may rely on

1. Logging a whole request or response object never emits a credential, an IP, or a
   cookie. **True in every argument position since `43e10e7` (F-261 and F-277 closed), and
   for a stronger reason than this invariant used to claim:** the object does not reach the
   line at all. There is no header list to keep current.

   **What holds it, corrected 2026-08-10 (F-281): this module's key rule, in every position.**
   In the record position pino re-shapes a request- or response-shaped record into `{ req: … }`
   or `{ res: … }` first (`tools.js:51-52` and `tools.js:53-54`), and **that re-shaping censors
   nothing** — `reqSerializer` carries `headers`, `remoteAddress` and the raw request straight
   through. The value is `[redacted]` because `req` and `res` are not in `LOGGABLE_FIELDS`, and
   it would equally be `[redacted]` had pino left the record alone, key by key. The proof is the
   bindings path, which never runs that sniff: a request-shaped object passed as the whole
   bindings emits `"method":"[redacted]","url":"[redacted]","headers":"[redacted]",
   "socket":"[redacted]"`, one censored key at a time. Do not read this invariant as a property
   of pino's request mapping. See "Door six".

   **The qualification F-277 put here is discharged at `43e10e7`. The invariant holds in
   every position a caller can put an object in, and each position holds it by a different
   mechanism.** Re-measured against the shipped singleton 2026-08-10, one process, with a
   request-like object carrying `headers.authorization`, `headers.cookie`, a concrete
   `url` with a query token, `socket.remoteAddress` and a body string:

   | where the object is | what the line carries |
   |---|---|
   | the record, `logger.info(req, '…')` | `"req":"[redacted]"` |
   | under a key, `logger.info({ request_id, req }, '…')` | `"request_id":"r-8","req":"[redacted]"` |
   | bindings, `logger.child({ request_id, req })` | `"request_id":"r-12","req":"[redacted]"` |
   | the message position, `logger.error({ request_id }, req)` | `"request_id":"r-1","err":{"err_name":"non-error throwable (object)"},"msg":"an error was logged with no context string"` |
   | the message position with no record, `logger.error(undefined, req)` | the same, with no `request_id` |
   | a format parameter, `logger.info('ctx %o', req)` | `"msg":"ctx '[redacted]'"` |

   It was false for the message position between `45cf578` and `43e10e7`, and false for the
   record position before `45cf578`, when `logger.info(req, '…')` emitted
   `"remoteAddress":"203.0.113.7"`, `"remotePort":54321` and the concrete
   `"url":"/l/abc?token=SEKRIT"` in the clear while the six `req.headers.*` paths were
   censored, which is what made it dangerous rather than obvious.

   **What the invariant does not promise is that the object is described.** In the message
   position it is discarded whole, and `err_name: 'non-error throwable (object)'` is a
   constant. In the record position a request-shaped object is replaced by pino before the
   scan runs and takes the record's other fields with it; see "Door six".

   **This invariant is not permission to log a request object.** It tells you nothing;
   `request_id`, `route`, `status` and `duration_ms` are what the call site wanted.
2. Every line inside a request carries `request_id`; every line inside a tenant
   transaction carries `tenant_id`.

   **One measured exception, 2026-08-10, and it is the call sites' to avoid rather than the
   logger's to fix.** A record pino reads as an HTTP request (`tools.js:51-52`) or as a
   response (`tools.js:53-54`, `typeof o.setHeader === 'function'` — two doors, not one) is
   replaced whole before any mechanism here runs; see "Door six". So
   `logger.info({ request_id, route, method, headers, socket }, '…')` emits `"req":"[redacted]"`
   and neither named field, and a record carrying a `setHeader` method emits `"res":"[redacted]"`
   the same way. Log named fields, never a request or response object, and this cannot arise.
3. The API sends no `Access-Control-Allow-Origin` header, for any origin, on any route.
4. HSTS, `nosniff` and `DENY` are present on every API response including errors.
   **True since 2026-08-10** (F-243 clause 2 closed), asserted by eight integration tests
   against `node dist/main.js` on loopback. Not asserted against the deployed image.

   **What `DENY` buys, corrected 2026-08-10 (F-280).** `X-Frame-Options: DENY` is on the
   response and a CSP-aware browser ignores it whenever the CSP names `frame-ancestors`. The
   header a browser acts on is the CSP, which is why `frame-ancestors 'none'` is now set
   beside the `DENY`. A caller relying on "this response cannot be framed" is relying on the
   two agreeing, and the eighth integration test is what keeps them agreeing.
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

   **Extended by ADR-0028 Migration step 7 (F-277), shipped at `43e10e7`.** A non-null object
   in the message position is moved onto the record under `err` whatever its type, so
   `logger.error({ request_id }, anyContainer)` emits
   `"err":{"err_name":"non-error throwable (object)"}` and the same fixed string. The caller's
   record survives. `null`, a number and a string in that position are unchanged, and a
   function still produces no `msg` key at all. Measured against the shipped singleton
   2026-08-10. **What a caller gives up is the payload**: `non-error throwable (object)` is a
   constant, so the line says a non-`Error` was logged and nothing about what it held. Pass
   `{ err }` with a fixed context string, or name the fields worth having.

   **Two shapes where the record's own `err` and the message argument collide, both measured
   and neither a leak.** If the record carries a truthy `err` and no own `msg`, the hook's
   error-message branch fires first and the message argument is DROPPED rather than moved:
   `logger.error({ err: realError }, container)` emits the real error's `err_name` and
   `err_stack` and nothing of the container. If the record carries its own `msg`, the message
   argument is moved, it overwrites `err`, and the line carries `msg` TWICE. Both are
   contrived, neither has a call site, and both are priced in ADR-0028's accepted costs.
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

   **Scope, stated 2026-08-10 because F-277 turned on it.** This invariant is about the two
   places a key exists: the log call's RECORD and BINDINGS. A value in the message position or
   in a format parameter arrives under no key, so the key rule is not what covers it; "Door
   six" says what does, position by position.

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
  them, and since `redact` was removed there is no residual censoring behind it: the hole is
  every field on every line that instance writes. Import `logger` from
  `apps/api/src/observability/logger.ts`, and do not re-derive it from ADR-0022, which
  records the decision and deliberately carries no literal (F-250).
- **Never construct `new Logger(…)` or `new ConsoleLogger(…)` from `@nestjs/common`, and since
  2026-08-11 the build fails if you do.** Nest's `Logger` writes an unstructured,
  ANSI-coloured, locale-clocked line to the same descriptor the JSON goes to, with none of the
  six mechanisms, no `service`, no `env`, no `request_id` and no ISO timestamp, and a shipper
  parsing NDJSON drops it or files it as a parse error. **No module in the tree does this.**
  The two files that did until 2026-08-11, `db/client.ts` and `tenant-context.ts`, now emit
  through the shared instance, and the `ignores` entries that exempted them are gone
  (TASK-060, AC-116). A new one is a finding, not a precedent.
- **Never call `console.*` from `apps/api/src`.** Same hole with no JSON at all. Where that
  prohibition stops, and why `apps/api/scripts` and `apps/api/test` are outside it on purpose,
  is ADR-0042.
- **Never pass `redact`, `serializers` or `formatters` to `logger.child`.** It throws a
  `TypeError` naming the option and the reason. pino replaces these rather than merging them,
  so a child that supplied `formatters.log` would run with no scan at all. The check reads the
  options the way pino reads them, option by option (F-279), so an inherited `redact` and an
  options object with a lying `hasOwnProperty` are both refused. It is not a guarantee that
  every possible spelling of "this object has one of the three" is refused; it is a guarantee
  that every spelling pino would ACT on is.
- **Wrap the log call where there is nowhere left to escape to.** A record spread from
  caller-controlled data may carry a property whose getter throws, and that throws out of the
  log call with no line emitted. See "A log call can still throw" (F-253). The exception
  filter's `headersSent` arm and `main.ts`'s last-chance boot handler are the two places
  where that converts a logged failure into an unhandled one.
- **Never interpolate an error's message into a log message string.**
  `` logger.error(`failed: ${e.message}`) `` puts the message into `msg`, which no
  serialiser, formatter or wrapper reaches. Pass `{ err: e }` and a fixed context string
  instead. **This bullet got sharper with ADR-0028: `msg` and `err_stack` are the only
  uncensored surfaces left, so they are the only ones worth attacking.** The arguments path is
  covered for format parameters — `hooks.logMethod` reduces every value pino would interpolate
  before `format` runs (F-260) — the message position is covered since `43e10e7` (F-277), and a
  string a call site built itself is reachable by nothing here.

  **No call site interpolates an error's message today (TASK-060, 2026-08-11).**
  `tenancy/tenant-context.ts` did until then, at the line F-274 was filed against and F-278
  showed never reached pino at all; it now calls
  `logger.error({ err: error }, 'afterCommit hook failed')`. **One interpolated message
  survives and it is deliberate**: `db/client.ts` builds
  `` `${where} failed and was discarded (sqlstate ${postgresErrorCode(error) ?? 'none'})` ``.
  Neither value is caller-controlled or driver-controlled: that `where` is the function's own
  parameter naming which connection died, **not** the `pg.DatabaseError` field of the same name
  that the last bullet in this section forbids, and it holds one of two module literals; a
  SQLSTATE is five characters from a closed vocabulary. It is a stopgap and not a pattern to
  copy, because a value that sits in `msg` is a value no operator can filter on. ADR-0028's
  amendment of 2026-08-11 rules that `sqlstate` joins `LOGGABLE_FIELDS` and that this call site
  moves the value onto the record; until that one commit lands, the line above is what ships.
- Never log `error.request` or `error.config` from an HTTP client. Both carry headers.
- **Never log a database error's `detail`, `hint`, `where`, `internalQuery` or `query`.**
  Added 2026-08-05 (F-120). A `pg.DatabaseError` populates `detail` on a unique violation
  with the colliding column values verbatim (`Key (slug)=(abc) already exists`), and
  `where` and `internalQuery` carry query text from a trigger or function body. No censoring
  scheme reaches inside a string, so censoring is not a fallback here. The readable fields on
  a caught database error are the SQLSTATE and the constraint name, both through the
  accessors in `tenant-context.md`, "Driver errors inside `fn`".

### What enforces "nothing may opt out", and what it does not reach

Stated here once, because this is the section the Consumed-by line and both ADRs point at.
The rule's own rationale, argument by argument, is the comment block at
`eslint.config.mjs:26-97` and is not repeated here.

Three mechanisms ship, all measured at TASK-060 rather than read off a report:

1. **Lint, one config object over `apps/api/src/**/*.ts`**, `ignores` exactly
   `apps/api/src/observability/logger.ts` because that is the file that must construct the
   instance. `no-console: 'error'`, plus `@typescript-eslint/no-restricted-imports` on `pino`
   with `allowTypeImports: true` and on `@nestjs/common` with
   `importNames: ['Logger', 'ConsoleLogger']`. Severity `error`, and
   `.github/workflows/ci.yml:143` runs `pnpm lint` in the `quality` job, so a violation fails a
   build rather than printing a message.
2. **The enumeration, `observability/logging-opt-out.spec.ts`.** It **derives** its subject set
   by walking `apps/api/src` for every non-`.spec.ts` `.ts` file, parses each with the
   TypeScript compiler rather than grepping it, and asserts that no module but the composition
   root reaches a logger value that is not the shared one, and that every module which emits
   imports `logger`. On every run it re-runs its own analyser over a violating and a compliant
   synthetic module and throws before any assertion is read if it cannot tell them apart. A
   module added tomorrow is in the subject set the moment the file exists.
3. **The rule's own test, `observability/logger-lint-rule.spec.ts`**, which runs ESLint
   in-process over violating fixtures, so deleting the rule turns a test red.

Four things they do not reach. Each is recorded here rather than left to be rediscovered:

- **Subpath specifiers.** `import { Logger } from '@nestjs/common/services'` lints clean and
  the enumeration misses it: both match the package specifier exactly, while the same spec
  handles `pino` and `pino/` as a family. `@nestjs/common` ships no `exports` field, so the
  subpath resolves and yields the real class, measured by emission. F-369, open. ADR-0041 says
  what the fix must be.
- **A logging package nobody enumerated.** `winston` or `bunyan` passes both halves, and passes
  the enumeration's second assertion too if the module also imports the shared logger. F-371,
  ruled by ADR-0041: the durable gate is the API package's dependency list, not a longer name
  list at the import site.
- **Anything outside `apps/api/src`.** Both halves are bounded to that tree. ADR-0042 rules the
  bound and says which prohibition follows the package and which follows the source tree.
- **A logger handed in at runtime**, as a parameter or through Nest DI. The analysis is a
  per-module property, not a per-call one. `exception-filter.ts` emits through a `log`
  parameter that its own `logger.child({ request_id })` supplies, which is the shape it cannot
  follow and does not need to, because the only logger value that module can reach is the
  shared one.

## Versioning

`LOGGABLE_FIELDS` is **append-only**, and a name may be appended only after it has been
checked against "What may never appear in a log line" and the never-allowlist. Removing a
name silently censors a field that was on the line yesterday, so a removal needs a reason in
the commit message the same way adding a redact path used to. One name per line, sorted, with
the owning file in a trailing comment.

**An append is one commit across three files, and it cannot be staged.** The name goes into
`observability/logger.ts`, into the fence above, and into the call site that needs it, all at
once: `logger-contract-drift.spec.ts` compares the fence to the shipped region for equality,
so touching either side alone turns it red. That coupling is why an allowlist name is an
architect edit and an implementer edit in the same commit. **One append is ruled and not yet
made**: `sqlstate`, ADR-0028's amendment of 2026-08-11, moving `db/client.ts`'s SQLSTATE out of
the message string and onto the record.

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
