---
id: ADR-0028
slug: foundation
title: A log field reaches the line only if it is named
status: accepted
supersedes: ADR-0022 (its redaction clause only; CORS and the header table stand)
date: 2026-08-09
accepted_at: 2026-08-09
---

> **Ledger correction, 2026-08-10.** This card read `status: proposed` until now, while
> `state.yaml`'s design gate recorded Juano reapproving it on 2026-08-09 and the implement
> log narrated it as partly implemented (F-260 and F-263 closed against it). The vault mirror
> caught the discrepancy and declined to reconcile it, which was correct: the card is the
> source of truth, so the card is what had to change. Same class as the drift the 2026-08-09
> re-scope found in `state.yaml`: a status field with no writer after the event that should
> have set it.

## Context

GC-9 says no PII in log bodies. The mechanism named for it is `REDACT_PATHS`, a list of 25
key paths whose values pino censors. The list has now failed three separate audit rounds,
each time the same way: it covers the spellings someone thought of.

Round 4 measured three more, two reproduced by the orchestrator:

```
{"clientIp":"203.0.113.9","ip":"[redacted]"}
```

One line, one spelling censored, the neighbour in the clear (F-262). The spelling this
system will actually hold is the uncensored one: the accessor already named in
`design/stubs/apps/api/src/auth/resolve-rate-limit-principal.ts:28` is `trustedClientIp()`,
and the header it reads is `x-shortkit-client-ip`. Nothing on the list matches either.

A request-shaped record emits `remoteAddress`, `remotePort` and the concrete `url`
(`/l/abc?token=SEKRIT`) verbatim (F-261). GC-9's first prohibition is a raw client IP in any
field from any header, so contract invariant 1 ("Logging a whole request or response object
never emits a credential, an IP, or a cookie") is measured false today.

`sessionToken`, `apiKey`, `api_key`, `passwordHash` and a bare `authorization` or `cookie`
outside `req.headers` are uncensored (F-266). `token` and `*.token` match a key spelled
exactly `token`.

**The pattern matters more than the three instances.** The logger has five mechanisms.
Four are value-shaped: `serializers.err`, `hooks.logMethod`, `formatters.log` and the two
bindings wrappers all ask *is this value an Error* and reduce it to a fixed policy shape,
whatever key it arrived under. Each closed its class on the first attempt and has stayed
closed through four audits. The fifth is key-shaped, and it has now leaked under three
different classes of name: `err.body` (F-244, closed by moving to a value-shaped mechanism),
IP spellings (F-262), and credential spellings (F-266). Appending the newly-found names
produces a list of 40 paths with the same property as the list of 25: the next name nobody
thought of is emitted in the clear.

The test this decision has to pass is not "are `clientIp` and `remoteAddress` covered". It
is **does a field nobody has thought of yet leak by default.**

**ADR-0022 already considered a field allowlist and rejected it.** Reopening it needs an
answer to the rejection, not a restatement of the proposal. The rejection said: *"Every log
call becomes a schema change, which people route around by stringifying an object into the
message field, defeating it entirely."* That objection is not hypothetical any more. F-260
(door six) measured the route-around as a live mechanism: `logger.error('parse failed: %o',
e)` puts an error's every own property into `msg`, and `msg` is the one field no key-based
scheme can censor without censoring every log line's text. So the escape hatch ADR-0022
predicted exists today, is reachable by the idiom pino's own README teaches, and is open
under the current denylist too.

Terminology, because it hid the gap. ADR-0022's decision reads "redaction is an allowlist of
paths". Those are paths *to censor*: an allowlist of things to remove, which is a **denylist
of keys**. This ADR uses denylist for what ships today and allowlist for keys that may
survive.

## Alternatives considered

### 1. Append the missing spellings to `REDACT_PATHS`

What F-261, F-262 and F-266 each ask for: add `clientIp`, `trustedClientIp`, `remoteAddress`,
`ipAddress`, `remotePort`, `url`, `sessionToken`, `accessToken`, `refreshToken`, `apiKey`,
`api_key`, `passwordHash`, `authorization`, `cookie`, and the `*.` half of each.

- **Pros.** Zero migration. No new mechanism, no behaviour change for any existing line, no
  operator surprise. Append-only, so it cannot break a line that works today. Two hours of
  work and the three findings close.
- **Cons.** It is the third round of the same fix. Every one of those names was found by
  someone reading code and guessing; the list's coverage is bounded by the imagination of
  whoever last audited it. It fails the class test outright: `principalKey`, `subjectIp`,
  `bearer`, `authToken`, `x_api_key` and every field a TASK invents next quarter are emitted
  in the clear, silently, with every gate green.
- **Why it lost.** F-244 already rejected this shape of fix for `err.body` and the module's
  four other mechanisms are the result. Applying the rejected pattern to the one place it
  survived, for the third time, buys a fourth audit round.

### 2. Allowlist the keys (chosen)

- **Pros.** Decides the class. The failure mode inverts from *a credential on the line* to
  *a diagnostic field missing from the line*, and the missing field is visible on the line as
  `"attemptCount":"[redacted]"` rather than silently absent. Measured to close residual 1
  (depth 5), residual 2 (an error inside a class instance) and F-265 (`toJSON`) as well as
  the three findings, because a container the scan cannot inspect is censored instead of
  passed through. Measured 2.6 µs per line cheaper than what ships today.
- **Cons.** Every new log field is a deliberate act, which is the point and also the friction.
  A field a TASK forgets to name ships as `[redacted]` and is discovered when someone reads
  the line, usually during an incident (GC-8's territory). It does not reach `msg` or
  `err_stack`, which are free text. It raises the pressure on `msg` as the escape hatch,
  which is exactly ADR-0022's objection.
- **Why it won.** It is the only option on this list whose failure mode is a missing field
  rather than a leaked one, and the three costs are each answerable: the friction is one line
  in one file rather than a schema migration, the missing field names itself on the line, and
  the `msg` hatch is already open and already owned by F-260.

### 3. Allowlist at the type level only

Export a `LoggableRecord` type and require every log call's first argument to satisfy it, so
an unnamed field is a compile error.

- **Pros.** The friction lands at the moment the developer writes the field, not at the
  moment an operator reads the line. No runtime cost at all. Nothing is ever missing from a
  line that typechecks.
- **Cons.** Types are erased, so it is not a mechanism, it is a convention with tooling.
  `logger.info(parsedBody, '…')`, a spread of anything typed `any` or `unknown`, and any
  `Record<string, unknown>` defeat it, and a spread of caller-controlled data is the exact
  shape every leak in this TASK has taken. It also means shadowing pino's six level methods
  and their overloads to change one parameter type.
- **Why it lost as the sole mechanism.** It cannot answer the class test: a field nobody
  named still reaches the line whenever the record is not a literal. Kept as a possible
  companion to option 2, deferred below.

### 4. Detect by value shape rather than by key

Regex every string value for an IPv4/IPv6 literal, a JWT, a `Bearer` prefix, high entropy.

- **Pros.** The only option here that reaches `msg` and `err_stack`, which are free text and
  which no key-based scheme touches. It catches a raw IP under a key nobody predicted,
  including inside an interpolated message.
- **Cons.** Unpredictable output: an operator cannot reason about when a field will be
  mangled, and a version string, a UUID or a duration can match. It has no answer for a
  password, which is an arbitrary string with no shape. Cost is per byte of every value on
  every line rather than per key. And a partial match forces a decision about censoring part
  of a string, which is precisely what the module has said three times it will not do.
- **Why it lost.** False confidence on the class it cannot cover (credentials) in exchange
  for coverage of one class it can (IP literals). The right mechanism for `msg` is F-260's
  hook fix, which removes the error from the arguments before pino formats them, not a
  content scanner behind it.

### 5. No free record at all: a fixed schema per log call

Every log call takes a typed struct, with no `Record<string, unknown>` anywhere.

- **Pros.** The strongest guarantee available. Nothing unnamed can be constructed.
- **Cons.** Ad-hoc diagnostic context becomes impossible without a schema change plus a
  release, which is what pushes people to `msg`. Large migration for every call site.
- **Why it lost.** Option 2 is this with a one-line escape hatch, and the one line is what
  keeps people out of `msg`.

## Decision

**A field reaches a log line only if its key is named in `LOGGABLE_FIELDS`. Every other key
is emitted with the value `[redacted]`. `REDACT_PATHS` and pino's `redact` option are
removed.**

### Where it is enforced

The same two places the error scan already runs, which are the only two paths that build a
line: `formatters.log` for a log call's record, and the `logger.child` / `logger.setBindings`
wrappers for bindings. `formatters.bindings` does not reach child bindings on pino 10.3.1;
that is measured in the contract's "The two wrappers" and is unchanged by this ADR.

One function replaces `errorsReplaced`. The shape below is what this decision proposed, and
it is **not** the normative artifact. `docs/contracts/logging-and-headers.md` § "Logger"
holds the normative fence, it is machine-compared to the shipped file, and it wins wherever
the two differ. F-250's lesson is that a configuration living in more than one artifact goes
stale in one of them; this block is kept because the alternatives above argue against it, and
it is annotated rather than synced. **Two places where the shipped source deviates from it,
both ruled on under "Deviations from this shape, ruled 2026-08-10" below.**

```ts
/** Every key that may carry a value onto a log line. Nothing else survives. */
export const LOGGABLE_FIELDS: ReadonlySet<string> = new Set([
  'attempt',            // main.ts, boot retry
  'boot_precondition',  // main.ts, F-245
  'code',               // exception-filter.ts, a DomainError code (error-envelope.md)
  'duration_ms',        // logging-and-headers.md, Required fields
  'err_message',        // ErrorLogFields, spread into records by logError and main.ts
  'err_name',           // ErrorLogFields
  'err_stack',          // ErrorLogFields
  'msg',                // pino's messageKey, when a call site supplies its own
  'request_id',         // logging-and-headers.md, Required fields
  'retry_in_ms',        // main.ts, boot retry
  'route',              // logging-and-headers.md, Required fields. The PATTERN, never a path
  'status',             // logging-and-headers.md, Required fields
  'tenant_id',          // logging-and-headers.md, Required fields
]);

/** How far in the scan looks. A container at or below this depth is censored, not walked. */
const MAX_SCAN_DEPTH = 4;

function fieldsCensored<T extends object>(record: T, depth: number): T {
  let replacement: T | undefined;

  for (const key of Object.keys(record)) {
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
      replacement ??= { ...record };
      (replacement as Record<string, unknown>)[key] = replaced;
    }
  }

  return replacement ?? record;
}

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
```

`elementsCensored` walks an array's elements through `valueCensored` and applies no key
decision, because an array index is not a field name. An object *inside* an array is walked
by `fieldsCensored`, so its keys are decided normally. Measured:
`{ request_id: 'r-1', route: ['a', { password: 'P' }] }` emits
`"route":["a",{"password":"[redacted]"}]`.

### Deviations from this shape, ruled 2026-08-10

The implementer disclosed two departures from the fence above rather than absorbing them.
Both are **accepted into the contract**; the shipped source stands and neither is a finding.

**1. `fieldsCensored`'s copy keeps `Array.isArray(record) ? [...record] : { ...record }`.**
Accepted. The reason given for it (that the bare spread would change what an operator reads
for `logger.info([e, e], '…')`, contract invariant 5's own shape) is **measured false**. Both
copy forms emit the same bytes: pino's `_asJson` writes own enumerable keys either way, so the
line is `"0":{"err_name":…},"1":{"err_name":…}` under both. Measured 2026-08-10 on pino 10.3.1
with the two formatters side by side.

The ternary is kept for two reasons that do hold. The function is declared
`<T extends object>(record: T, depth: number): T`, and spreading an array into an object
literal makes the `as T` a false statement about the value; a cast that lies is worth one
ternary to avoid. And it is the form the previous shipped scan had, so keeping it is the
existing pattern rather than a new one: this ADR gave no reason to change it, and changing it
was not among the things it decided. Nothing tests the shape, before or after, and that gap is
recorded in the contract rather than closed here.

**2. `interpolationSafe` became `valueCensored(value, 1)`, the constant moving 2 → 1.**
Accepted, and this ADR should have specified the format path rather than leaving it to be
inferred. A format argument arrives under no key, so the key rule cannot apply to it:
`logger.error('a %s', 'b')` has to interpolate `b`, and there is no field name to decide
about. Routing it through the value half of the policy is the only coherent answer.

The constant's meaning changed with it, and the load-bearing property survives. It used to be
the depth a *container* was walked from; it is now the depth the *argument itself* is scanned
at, and `valueCensored` walks a container it holds at `depth + 1`, so a container is still
walked from 2, where the top-level `err` exemption does not fire, and
`logger.error('ctx %o', { err: e })` stays closed. Defended by four tests in `logger.spec.ts`
(F-260's `%o`, `%j`, `%s`, and F-269's no-placeholder shape), all green.

Cost accepted: an interpolated container's reach is one level shallower than a record's, since
it starts at 2 rather than 1. Routing this through `fieldsCensored(value, 1)` instead would
restore that level and reopen the exemption as a hole, so the level is the price of the seam.

### The argument list: one policy per position, ruled 2026-08-10 (F-277)

**Everything above this line is about a RECORD's keys. This ADR never specified the argument
list at all**, which is how `interpolationCovered` shipped with the message position uncovered
and passed review twice. Both auditors found the hole independently in round 6, and it is a
regression: the deleted 25-path list built a wildcard stringifier and pino applies it to the
`msg` value too (`tools.js:205`), so eight names were censored inside `msg` by accident of the
denylist's shape and nothing censors them now.

pino's argument list has three positions, and each gets a different answer for a different
reason. The table is normative. `messageArgumentIndex` returns 1 when `args[0]` is an object
(`null` included) or `undefined`, and 0 otherwise, so a record exists only at index 0 and the
message argument is a container only at index 1.

| position | decided by | mechanism | result |
|---|---|---|---|
| the record, `args[0]` | its KEYS | `formatters.log` → `fieldsCensored(record, 1)`, with `err` exempt at depth 1 and owned by `serializers.err` | a named key keeps its value to `MAX_SCAN_DEPTH`; every other key is `[redacted]` and stays on the line |
| the message argument, when it is a non-null object | its TYPE, not its keys | `hooks.logMethod` → `errorMovedOntoTheRecord` | moved onto the record under `err`; `msg` becomes `an error was logged with no context string` |
| the message argument, when it is anything else | nothing | none | verbatim. A string is free text and no censoring scheme reaches inside one |
| every argument after the message | its VALUE | `hooks.logMethod` → `interpolationSafe`, which is `valueCensored(value, 1)` | an `Error` becomes `errorLogFields`; a container is walked from depth 2; a class instance, a `Buffer` or anything past the bound is `[redacted]`; a primitive is verbatim |

**Decision. A container in the message position is moved onto the record under `err`, whatever
its type. The `instanceof Error` test is deleted, not widened with a second branch.** One
position, one policy, and the implementer's change is a smaller module rather than a larger
one:

```ts
// `messageArgumentIndex` returns 0 only when `args[0]` is neither an object nor `undefined`,
// so the message argument can be a container only at index 1. `null` is excluded: it carries
// nothing onto a line, and describing an absence as a throwable is worse than leaving it.
const covered =
  message === 1 && typeof args[1] === 'object' && args[1] !== null
    ? errorMovedOntoTheRecord(args)
    : args;
```

`errorMovedOntoTheRecord` is unchanged. What the line then carries, measured 2026-08-10
against the shipped singleton by handing the same containers to `logger.error({ request_id,
err: container }, '…')`, which is the shape the fix produces:

| the call | the line, after the fix |
|---|---|
| `logger.error({ request_id }, nonErrorThrowable)` | `"request_id":"r-1","err":{"err_name":"non-error throwable (object)"},"msg":"an error was logged with no context string"` |
| `logger.error({ request_id }, ['first', { password }])` | the same, `err_name` only |
| `logger.error({ request_id }, new Held(secret))` | the same |
| `logger.error(undefined, { password })` | the same, with no `request_id` |
| `logger.error({ request_id }, { password }, 'tail')` | the same; the trailing argument is still dropped by `quick-format` (F-269) |
| `logger.error({ request_id }, null)` | unchanged: `"msg":null` |
| `logger.error({ request_id }, 42)` | unchanged: `"msg":42` |
| `logger.error({ request_id }, someFunction)` | unchanged: no `msg` key at all. `JSON.stringify` discards a function whatever properties it carries |

#### The alternative, and why it lost

**Reduce the message argument in place, through the `valueCensored(value, 1)` the format
arguments already get.** `msg` would then hold a censored copy of the container the caller
wrote: `"msg":{"clientIp":"[redacted]","headers":"[redacted]"}`.

- **Pros.** It preserves the shape the call site wrote, and the operator keeps the key names,
  which is this ADR's own mitigation for a censored field. It is the smallest possible edit,
  reusing a mechanism one line below that was measured sound. It discards no payload that the
  key rule would have kept. It satisfies every assertion the round-5 red step wrote.
- **Cons, each measured or already ruled on.**
  1. It keeps the `instanceof Error` split, so one argument position carries two policies
     selected by a type test. That is the enumeration shape F-244, F-262 and F-266 each
     punished, applied to a position rather than to a key.
  2. `msg` becomes an object whenever a caller passes a container, so the one field an
     aggregator indexes as text is polymorphic at runtime. `logger.ts:212-216` rejected exactly
     that reasoning for an `Error` in this position, and `logger.spec.ts:495` pins it: "`msg`
     is a string an aggregator can index, not an object".
  3. It hands a partly scanned caller container to pino's stringifier. `fieldsCensored` returns
     the container BY REFERENCE when nothing in it changed, so an own non-enumerable `toJSON`
     fires on the way out. Measured at HEAD, on the mechanism this alternative would reuse:
     `logger.error('fmt %o', containerWithHiddenToJSON)` emits
     `"msg":"fmt {\"password\":\"TJ-SECRET\"}"`, while the same object under `err` emits
     `{"err_name":"non-error throwable (object)"}`. Taking this alternative would close a
     blocker by routing the message position into an open minor (round 6, security auditor
     finding 2, the residual half of F-265; unowned, and the Consequences table below still
     reads as though `toJSON` closed as a class, which the same finding disputes).
  4. The allowlist's names would act as pass-throughs inside a value that arrived under no key.
     `logger.error({ request_id }, { route: '/l/abc?token=SEKRIT' })` would emit the token,
     because `route` is named and the message argument is not a record.
- **Why it lost.** Three of its four costs are things this module has already ruled on in the
  opposite direction, and the fourth is a live measured leak.

**Dropping the message argument** was the second alternative and lost to silence.
`logger.error({ request_id }, e)` would emit a record, a fixed string, and no trace that a
throwable was logged. The test architect measured this as mutation A, and the guard
`F-277: covering the message position does not cost the line its record or its message` exists
to red it.

**Refusing a non-string message argument at the type level** is alternative 3 of this ADR by
another name. `e` is `any` in a `.catch` callback, which is the shape the finding reproduces,
so the types are erased exactly where the leak is. Still worth having as a companion, still
deferred.

#### Consequences of this ruling

Positive:

- One rule for the position, reached by deleting a type test rather than adding a branch.
- `msg` is a string on every call shape the module accepts, so `logger.ts`'s claim and
  `logger.spec.ts:495` become properties of the position rather than of the `Error` case.
- `logger.ts:221-222`, "A CONTAINER in either position is scanned", stops being a claim the
  file contradicts. **Corrected 2026-08-10 after the fix shipped: it is deleted rather than
  made true.** A container in the message position is not scanned, it is moved onto the record
  and reduced to `err_name`; a container in a format parameter is the one that is scanned. The
  two positions are both covered and neither covers the other, so a sentence that answers for
  "either position" is wrong whichever answer it gives. The contract's "Door six" states the
  four positions separately, which is the shape this bullet should have asked for.
- The regression is not merely repaired. The denylist censored eight names inside `msg` and
  passed everything else; this discards the container whole.
- Contract invariant 1 becomes true on the message position for the same reason it is true on
  the record path: the object does not reach the line.

Negative, and the cost accepted:

- **The payload is discarded, not censored.** `err_name: 'non-error throwable (object)'` is a
  constant. The operator learns that a non-`Error` was logged and nothing about what it was,
  where the rejected alternative would at least have left the key names. This is already the
  contract's answer for `logger.error({ err: {…} })`, so it adds no new shape to the output
  vocabulary, and the remedy is the one already prescribed: pass `{ err }` with a fixed context
  string, or name the fields worth having.
- **A real `Error` on the record is displaced in one shape.**
  `logger.error({ request_id, msg: 'x', err: realError }, container)` reaches
  `interpolationCovered`, because the record's own `msg` makes the hook's second branch
  decline, and `errorMovedOntoTheRecord` overwrites `err`. The real error's name and frames are
  lost. Today that shape leaks the container instead. It is contrived, no call site produces
  it, and it is stated rather than special-cased: a branch for it would reintroduce the split
  this ruling removes.

  **Emitted rather than reasoned, 2026-08-10, after the fix shipped.** Both halves reproduce,
  and one of them is worse than this bullet predicted: that call emits `msg` TWICE,
  `"msg":"callers own msg","msg":"an error was logged with no context string"`, because the
  record keeps its own `msg` and pino is handed the fixed string as well. A parser that keeps
  the last key reads the fixed string and the call site's own message is shadowed. **This is
  not new with F-277** (the same shape with an `Error` in the message position took the same
  branch before, measured on the shipped singleton), but F-277 widens it from `Error` to every
  non-null object. Not a leak: both values are `msg`, which is on the allowlist and free text
  either way. Closing it means teaching `errorMovedOntoTheRecord` about a record-supplied `msg`,
  which is a second policy on the position, so it is accepted rather than fixed here.

- **A container in the message position is DROPPED, not moved, when the record already carries
  an `err`.** `logger.error({ err: realError }, container)` never reaches
  `interpolationCovered`: `messageWouldBeTakenFromTheError` fires first, and it calls `method`
  with the record and the fixed string, so the second argument goes nowhere. **Disclosed by the
  implementer from the branch conditions and verified by emitting, 2026-08-10:** the line
  carries the real error's `err_name` and `err_stack` and no trace of the container. This is
  the safe direction of the two (no leak, and the real error survives where the shape above
  loses it), and the cost is that a caller who passes a container there gets no signal that it
  was discarded. No call site produces this shape.

- **One more shape where both the container and the error vanish, and pino rather than this
  module is what does it.** `logger.error(requestLike, container)` spreads a request-shaped
  record and adds `err`, and pino's `LOG` (`tools.js:47-56`) then replaces the whole record
  with `{ req: … }` because it reads `method`, `headers` and `socket` on it. Measured: the line
  is `"req":"[redacted]","msg":"an error was logged with no context string"`. Covered, and
  undiagnosable. It is the same sniff that makes `logger.info(req, '…')` emit
  `"req":"[redacted]"`, which is the row this ADR's Consequences table has always quoted
  without naming the mechanism.
- **Two calls one token apart now emit the same line.** `logger.error({ request_id }, e)` and
  `logger.error({ request_id }, someDto)` are indistinguishable. That is what one policy per
  position means, and it will read as a bug the first time somebody logs a DTO there on
  purpose.
- **F-269's silence widens by one shape.** `logger.error({ request_id }, dto, 'tail')` emits
  the record and the fixed message; the trailing argument was already dropped and the message
  argument now carries nothing either.
- Follow-up work: `logger.ts:221-222` and the docblock above it, the contract's new "Door six"
  section, invariant 1, invariant 5's narrowing note and invariant 6. Named in Migration below.

### The rules, stated so an implementer does not have to infer them

1. **An `Error` value is reduced to `errorLogFields` whatever its key**, and the key check
   never runs on it. This preserves the one guarantee that has survived every round:
   an error is a value with a policy, not a field with a name. `{ error: e }`, `{ cause: e }`
   and `[e, e]` still emit `err_name` and `err_stack`.
2. **The top-level `err` key stays exempt at depth 1** and belongs to `serializers.err`,
   which runs after `formatters.log` and emits exactly `err_name`, optional `err_message` and
   optional `err_stack`. The allowlist does not see that output and does not need to: it is
   three named fields by construction. The partition in the contract is unchanged.
3. **A container the scan cannot inspect is censored, not passed through.** A class
   instance, a `Buffer`, a function, and anything at or past `MAX_SCAN_DEPTH` become
   `[redacted]`. This is the inversion that closes residuals 1 and 2 and F-265's `toJSON`
   mechanism: today "cannot inspect" means "emit whole".
4. **A property whose getter throws is censored, not skipped.** Today `readIndexedProperty`
   skips the key and leaves it for pino to read again, which means a getter that throws once
   and returns a credential on the second read puts it on the line. Under an allowlist that
   would be a counterexample to the whole guarantee. Note what this does *not* fix: the
   `{ ...record }` copy re-invokes the getter and the log call still throws with no line
   emitted (F-253, F-259). Safe, unavailable, and unchanged by this ADR.
5. **`undefined` is left alone.** `JSON.stringify` drops a key whose value is `undefined`,
   so censoring it would add a field where none appeared.
6. **The key stays on the line.** `"attemptCount":"[redacted]"`, not a dropped key. The
   operator sees which field exists and is unnamed, which is the whole mitigation for the
   cost this decision accepts.
7. **`msg`, `level`, `time`, `pid`, `hostname`, `service` and `env` are outside the scan.**
   Measured on pino 10.3.1: `formatters.log` receives only the log call's own record, so a
   positional message never reaches the allowlist and a record-supplied `msg` does, which is
   why `msg` is on the list. `service` and `env` are `base`, serialised at construction from
   module literals. **What covers a positional message is not this rule but the argument-list
   table above** (F-277): the key rule never sees it, and the message argument is covered by
   type instead.

### `redact` is removed, not kept alongside

Every one of the 25 paths names a key that will not be on the allowlist, so the list is
subsumed. Keeping it costs a measured 2.7 µs per line (below) for no coverage the scan does
not already have, and it keeps in the codebase the one mechanism whose "just append a path"
reflex produced F-261, F-262 and F-266. Two censoring mechanisms with opposite polarity is
also the comprehension hazard that let a reader of the six `req.headers.*` paths conclude
that logging a whole request was a covered act.

The accepted cost is real: `redact` was a second layer that would survive a bug in the scan,
and after this change there is exactly one mechanism between an unnamed field and the line.
See the F-263 coupling in Consequences.

**The 25 paths do not disappear from the design. They become a never-allowlist list** in the
contract's "What may never appear in a log line": names that must never be added to
`LOGGABLE_FIELDS`, with the newly-found spellings from F-261, F-262 and F-266 added to them.
That list is documentation of intent, not a mechanism, and it says so.

### `REDACT_CENSOR` keeps its name and its value

`[redacted]` stays verbatim. Log queries and the existing byte-level tests key on it, and it
is still redaction.

## Consequences

### Positive

- A field nobody has thought of does not reach the line. That is the class, decided once.
- F-261, F-262 and F-266 close together, and so do three residuals nobody filed this round
  as a class: depth 5 and beyond, an error inside a class instance (F-255's residual 2), and
  `toJSON` (F-265). Measured, all four shapes, against a prototype of the configuration
  above:

  | shape | today | under this ADR |
  |---|---|---|
  | `{ clientIp, trustedClientIp, remoteAddress, ipAddress }` | all four verbatim | all four `[redacted]` |
  | `logger.info(req, '…')` | `remoteAddress`, `remotePort`, `url` verbatim | `"req":"[redacted]"` |
  | `{ sessionToken, apiKey, api_key, passwordHash, authorization, cookie }` | all verbatim | all `[redacted]` |
  | `{ ctx: { toJSON: () => parseFailure } }` | the raw request body | `"ctx":"[redacted]"` |
  | `{ ctx: new Ctx(parseFailure) }` | the raw request body | `"ctx":"[redacted]"` |
  | `{ a: { b: { c: { d: { err: parseFailure } } } } }` | the raw request body | `"a":"[redacted]"` |

- Contract invariant 1 becomes true, and for a stronger reason than it claimed: a whole
  request object does not reach the line at all, so there is no header list to keep current.
- Each log line gets cheaper. See Performance.
- The contract gets shorter. "Which casing `REDACT_PATHS` is keyed to", the `ip_hash`
  snake_case residual and the wildcard-depth explanation all stop being load-bearing, because
  a snake_case key nobody named is censored like every other unnamed key.

### Negative, and the cost accepted

- **A field a TASK forgets to name ships as `[redacted]`, and the discovery moment is
  usually an incident.** This is GC-8's territory and it is the real price. Nothing in the
  build catches it: typecheck, lint and the suite are all green on a log line whose fields
  are all censored. The mitigations are that the key stays on the line so the operator knows
  exactly which field is missing and what it is called, and that the fix is one line in one
  file that any TASK can land. They do not remove the cost.
- **Invariant 5 narrows.** An `Error` under a key at depth 1 still emits `err_name` and
  `err_stack` under any spelling, but an error nested inside a container that is not named
  (`{ ctx: { err: e } }`) is now lost entirely rather than reduced to policy fields. Measured:
  `"ctx":"[redacted]"`. That shape is F-248's third case and it is a real diagnostic loss.
  The remedy is the shape the contract already prescribes: pass the error at the top level.
- **The escape hatch is `msg`, and this decision pushes traffic toward it.** ADR-0022's
  objection stands. `msg` is free text by construction, `err_stack` is free text, and no
  key-based scheme reaches inside either. This ADR does not close door six; F-260 does, and
  **F-260 must land, because after this change `msg` is the only uncensored surface left and
  therefore the only one worth attacking.**
- **F-263 becomes load-bearing rather than hardening.** `logger.child(bindings, { formatters:
  { log: (o) => o } })` disables the scan for that child. Today `redact` still censors 25
  paths behind it; after this change nothing does. **The allowlist may not ship without the
  child-options rejection.** Same for `{ serializers: … }`. This ADR makes F-263 a
  precondition of its own implementation, not a parallel fix.

  **And a load-bearing refusal has to read the options the way pino reads them (F-279, landed
  `43e10e7`).** One `Object.hasOwn` for all three was one predicate too few: pino reads
  `redact` as an ordinary property, so a `redact` on the options' PROTOTYPE was accepted here
  and installed there, and it reads `serializers` and `formatters` through
  `options.hasOwnProperty(…)` called as a method, so an options object that answers for itself
  took pino's replacing branch. Both measured against bare pino. `pinoWouldReplace` now takes
  the union of pino's read and `Object.hasOwn` per option; the guarantee and its asymmetry are
  in the contract under "A child's options are an opt-out, so they are refused".
- **`LOGGABLE_FIELDS` is a shared line every TASK edits**, so wave-parallel TASKs will
  collide on it in a way they do not collide today. One name per line, kept sorted, with the
  owning file in a trailing comment, so a merge conflict resolves by keeping both.
- **The allowlist couples `logger.ts` to `error-envelope.md`'s field names.** Renaming
  `err_name`, `err_message` or `err_stack` already broke every saved log query; now it also
  silently censors them. The contract's versioning rule for those three names has to say so.
- **Two more spellings of the same value now behave differently in a way the operator sees.**
  `route` is on the list and `url` is not, so a TASK that means the route pattern and writes
  `url` gets `[redacted]`. That is the intended behaviour and it will read as a bug the first
  time somebody meets it.

### Follow-up work this creates

- The implementation change in `apps/api/src/observability/logger.ts`, after this ADR is
  approved. Named below, not made here.
- `logger.spec.ts` changes: the redaction tests assert specific paths and become allowlist
  tests. `logger-contract-drift.spec.ts` anchors on the literal string
  `export const REDACT_PATHS`, which stops existing (F-270's owner is already in that file).
  **Done at `2423a63`.** The allowlist tests live in `logger-field-allowlist.spec.ts` and the
  drift spec's marker is `export const LOGGABLE_FIELDS`.
- The contract's fenced normative block, updated in the same commit as the source and not
  before. See Migration step 5.
- A lint rule banning a second pino instance and `console.*` (F-268) is worth more after this
  change than before, because a second instance now bypasses the only remaining mechanism.
  **Shipped.** F-268 closed at round 5; TASK-060 widened it to Nest's `Logger` and
  `ConsoleLogger` and removed the last two exemptions.

## Migration

**Status 2026-08-10: all seven steps have landed.** The 25 paths no longer ship, and the
message position carries the policy in the argument-list ruling above. Step 7 was opened by
F-277 after step 2 shipped and closed at `43e10e7`, with its fence half in the re-sync that
followed.

**Amended 2026-08-11 (F-360), and step 3 is where to look.** Its F-278 correction described
two modules that wrote through Nest's `Logger`. TASK-060 converted both, deleted the two
`ignores` entries that exempted them, and widened the lint rule to `ConsoleLogger`, so the
ruling in step 3 is discharged and one of its two implementation details is superseded rather
than merely satisfied. Step 3 also gains one open item: **`sqlstate` is ruled onto
`LOGGABLE_FIELDS` and the append has not been made**, because the fence and the call site have
to move in the same commit.

| step | landed at | by |
|---|---|---|
| 1, the child-options rejection (F-263) | `45cf578` | `sdlc-implementer-backend` |
| 2, `LOGGABLE_FIELDS` and the scan; `REDACT_PATHS` and the `redact` option deleted | `45cf578` | `sdlc-implementer-backend` |
| 3, the call-site sweep | `45cf578`, re-verified 2026-08-10, **corrected 2026-08-10 for F-278** | `sdlc-implementer-backend`, then the orchestrator and `sdlc-architect` |
| 4, the 25 paths moved to the never-allowlist | `b42d9a2` | `sdlc-architect` |
| 5, the contract's fenced block | `b42d9a2` | `sdlc-architect` |
| 6, the drift spec's fence marker | `2423a63` | `sdlc-test-architect` |
| 7, the message position (F-277), and the contract's "Door six" | `43e10e7` for the source, the fence re-sync for the contract | `sdlc-implementer-backend`, then `sdlc-architect` for the fence |

**Step 7 repeats step 5's sequencing and its lesson.** The source moves first; the contract's
fenced block moves as close behind it as the ownership rules allow, because the drift test
compares the two. The contract's PROSE moved first: "Door six" and the position table were
written before the source changed, invariant 1 said what was true then and what the ruling
would make true, and each carried the date. A reader between the two commits got a document
that was accurate about being mid-migration rather than one describing a module that did not
exist yet.

**What the sequencing actually cost, recorded because the plan said one line and the bill was
three.** The fence was one commit behind the source across three code changes, not one: the
`:239` predicate, the two new `pinoWouldReplace` / `suppliedClaimsOwnProperty` helpers that
F-279 landed in the same commit, and the call to them inside `childOptionsChecked`. The
divergence report names only the first, because it reports the FIRST character where the two
part company and stops there. **Diff the whole normative region against the fence before
editing it; do not patch the line the failure names.** `logger-contract-drift.spec.ts` went
4 passed of 6 at `43e10e7` and 6 of 6 after the re-sync.

Step 6 carried a second, unplanned edit in the same file. The guard
`the redact path with an inner double quote survives the strip on both artifacts` asserted
that `'req.headers["fly-client-ip"]'` was present in the **source**, and that string left with
`REDACT_PATHS`. It is re-anchored on the child-options refusal message, which holds the same
hazard (a single quote inside a template literal), and a second hand-written case was added
because the existing one was measured not to catch a quote-blind stripper.

The order below is the order the work happened in, and step 1 was not optional.

1. **Land F-263 first or in the same commit.** Reject `redact`, `serializers` and
   `formatters` in the `child` wrapper's `options` argument. Until that exists, one
   documented pino call opts a subtree out of the only mechanism there is.
2. **Add `LOGGABLE_FIELDS` and the three scan functions; delete `REDACT_PATHS`,
   `REDACT_CENSOR`'s use in the `redact` option, and the `redact` option itself.** Keep the
   `REDACT_CENSOR` export.
3. **Sweep every log call site in `apps/api/src` and check its fields against the list.**
   The thirteen names in the list were derived from exactly this sweep; if a field is missing
   the line degrades silently, so the sweep is the safety net, not a formality.

   **Run, and re-verified against the shipped list on 2026-08-10. Nothing degrades on the
   shared logger.** Every field any pino call site can put on a line today is named:

   - `main.ts:199` emits `boot_precondition`, `attempt`, `retry_in_ms` and the spread of
     `errorLogFields`; `main.ts:309` emits `boot_precondition` and the same spread. All named.
     (**The second figure read `:293` until 2026-08-11**, and it had already been copied
     forward into a report that called itself measured. `main.ts` has exactly two emissions and
     they are at `:199` and `:309`.)
   - `exception-filter.ts:125` binds `request_id` on the child. Named. `:181` and `:195` each
     emit `code`. Named. `logError` spreads `errorLogFields` plus a caller-supplied `fields`
     record, and exactly one caller passes one: `:265` passes `{ status }`. Named.
   - `ErrorLogFields` is `err_name`, `err_message`, `err_stack`. All three named, and the
     contract's versioning rule now says renaming one censors it.
   - `RequestLogFields` is `request_id`, `route`, `status`, `duration_ms`, `tenant_id`. All
     five named ahead of the request-log middleware a later TASK adds, so that TASK adds no
     name to the list.
   - `code` is on the list and has two emitters, `exception-filter.ts:181` and `:195`. An
     earlier version of this step said it had none, which was wrong and is corrected here.

   **CORRECTED 2026-08-10 (F-278). The sweep enumerated eight sites and two of them are not
   on this logger at all.** The claim it made about them ("pass a string and no record, so
   the key rule does not reach them, `msg` covers what they emit") reads as though they were
   shared-logger call sites whose fields happen to be safe. They are a second log surface
   with none of the six mechanisms:

   | site | what it wrote through, as measured 2026-08-10 | reached the allowlist? |
   |---|---|---|
   | `main.ts:199`, `:309` | the shared pino singleton | yes |
   | `exception-filter.ts:125`, `:181`, `:195`, `:265` | the shared pino singleton, through a per-request child | yes |
   | `db/client.ts:93` | `new Logger('Database')` from `@nestjs/common`, declared at `db/client.ts:55` | **no**, until 2026-08-11 |
   | `tenant-context.ts:247` | `new Logger('TenantTransaction')` from `@nestjs/common`, declared at `tenant-context.ts:136` | **no**, until 2026-08-11 |

   Verified by reading the two files: neither imported `observability/logger`, and
   `grep -rn "new Logger(" apps packages` returned exactly those two declarations. Their output
   was unstructured, ANSI-coloured, carried no `service`, `env`, `request_id` or pino
   timestamp, and went to the same stdout the JSON goes to. So the contract's boundary
   sentence, "Consumed by: every API TASK. Nothing may opt out", was measurably false, and
   F-274 was filed against `tenant-context.ts:247` on the premise that its `msg` reached pino,
   which it never did.

   > **DISCHARGED 2026-08-11 by TASK-060 (AC-116, F-360). The table above is history, and the
   > two bottom rows describe files that no longer look like that.** Both modules import
   > `logger` from `observability/logger`, neither imports `@nestjs/common`, both `ignores`
   > entries are deleted, and the lint rule now fails a build on `Logger` **and**
   > `ConsoleLogger`. The current state and the residual holes live in
   > `docs/contracts/logging-and-headers.md`, "What enforces 'nothing may opt out', and what
   > it does not reach", and are not restated here. What the rows are kept for is the ruling's
   > premise: the exemption was bounded on the grounds that each site passed a fixed string and
   > no record, and that bound is what made "exempt for now" cheaper than "convert inside
   > another TASK's files".

   **Ruling as made on 2026-08-10, and spent on 2026-08-11: the two Nest loggers are exempted,
   named, and bounded. They are not converted by TASK-003 and they are not tolerated
   silently.**

   - Both files are outside TASK-003's `paths`, and routing rule 0 forbids reaching into
     them. This ADR can correct its own false claim; it cannot edit another TASK's files.
   - The mechanism that would actually close the class is not a per-file edit. It is
     `app.useLogger(adapter)` in `main.ts`, a Nest `LoggerService` over the shared pino
     singleton, which redirects every `new Logger(…)` in the process and Nest's own bootstrap
     lines with it. That is one decision covering three findings, and it needs its own ADR: it
     has to answer what a Nest log call's `context` and `stack` arguments become (both would
     need names on `LOGGABLE_FIELDS`), what happens to the lines Nest writes before
     `useLogger` runs, and whether a message string these call sites build by interpolation is
     acceptable as `msg` when the contract tells every other call site not to build one.
     Deciding that here would decide it for files this TASK may not touch.
   - **What the exemption was bounded by, so it could not grow quietly.** Exactly two
     declarations, both in the table above, each with exactly one call site, each passing a
     string and no record. `db/client.ts:93` wrote
     `${where} failed and was discarded: ${error.name} (sqlstate …)`, which carried a class
     name and a SQLSTATE. `tenant-context.ts:247` wrote
     `afterCommit hook failed: ${error.name}: ${error.message}`, which interpolated an
     arbitrary error's MESSAGE and was the one that had to move first. Neither carried a raw
     IP, a token, a credential or a request body. Both moved on 2026-08-11, and the bound is
     the reason there was time to move them deliberately.

   **Amendment 2026-08-11: `sqlstate` joins `LOGGABLE_FIELDS`, and the append has not been made
   yet (F-360).** Converting `db/client.ts` left the SQLSTATE where the Nest line had it, inside
   the message string: `` `${where} failed and was discarded (sqlstate ${…})` ``. The
   implementer rejected reusing the allowlisted `code`, correctly. `code` is documented on the
   list as a DomainError code with two live emitters, and putting a five-character Postgres
   status under the same name collides two vocabularies in the one field an operator filters
   on. That reasoning stands and is not reopened here.

   The ruling is that the field gets its own name rather than staying in `msg`:

   - **`sqlstate` is appended to `LOGGABLE_FIELDS`**, sorted between `route` and `status`,
     trailing comment `// db/client.ts, a Postgres SQLSTATE`. It clears the never-allowlist: a
     SQLSTATE is five characters from a closed vocabulary published by Postgres, it is not
     derived from row data, and it is the field the contract's own "Driver errors inside `fn`"
     rule already names as readable.
   - **The call site moves the value onto the record**: `{ err: error, sqlstate: … }` with a
     fixed context string, and the SQLSTATE leaves the interpolated message.
   - **`where` does not get a name and stays interpolated.** `where` is the name of a
     `pg.DatabaseError` field the contract forbids logging by that exact name. A `where` key on
     a log line would read to an operator as the forbidden field, whatever this module means by
     it. The value here is one of two module literals, so the message string is the right place
     for it, and a rename of the parameter is the implementer's call, not a list entry.
   - **One commit, three files, and it cannot be staged**: `observability/logger.ts`, the fence
     in `logging-and-headers.md`, and `db/client.ts`. `logger-contract-drift.spec.ts` compares
     the fence to the shipped region for equality, so any two of the three alone turn it red.
     That is why TASK-060 declined to reach for it and disclosed instead, which was the right
     call.

   **The cost accepted.** Until that commit lands the SQLSTATE is free text in `msg`, which is
   an uncensored surface an operator cannot filter on, and the contract carries a bullet
   explaining why one interpolated message is deliberate. The append is also permanent: the
   list is append-only, so a name added for one call site is carried forever, and this one is
   a Postgres concept named on a list that is otherwise the API's own vocabulary.

   **Requirement on F-268's lint rule, stated here because `eslint.config.mjs` is not this
   ADR's file. LANDED 2026-08-11, and one of its two details is superseded.** The rule
   restricted importing `pino` and said nothing about Nest's `Logger`, so the cheapest way to
   opt out of the whole policy passed lint. It has been extended with a `no-restricted-imports`
   entry for `apps/api/src/**/*.ts`:
   `{ name: '@nestjs/common', importNames: ['Logger', 'ConsoleLogger'], message: … }`.

   - **Superseded: "it goes in a separate config object whose `ignores` lists the two files".**
     That instruction existed only to hold the exemption, and the exemption is gone. With
     nothing to carve out, the two config objects matched the same files and configured the
     same rule, and ESLint replaces a rule's options rather than merging them, so the earlier
     object's `no-restricted-imports` was dead configuration that read as though it were in
     force. TASK-060 merged them into one block with a single `ignores` entry,
     `apps/api/src/observability/logger.ts`. **Do not reintroduce the second object.** The
     reasoning it encoded, that adding a path to `ignores` switches off `no-console` and the
     `pino` restriction along with the Nest one, is still true and is the reason no future
     exemption is spelled that way either.
   - **Stands: `importNames` rather than the whole module.** `@nestjs/common` supplies
     `Module`, `Catch`, `Controller` and the rest across the API. `exception-filter.ts:51`
     imports a `Logger` type from `pino`, not from `@nestjs/common`, so the restriction does
     not collide with it, and `allowTypeImports` keeps the `pino` entry off it too.
   - **`ConsoleLogger` was added beyond what this ADR asked for, and it belongs.** It is what
     `Logger` delegates to, it writes the identical line, and AC-116's words are "or any other
     logger". A rule naming `Logger` alone is the enumeration weakness this ADR rejected for
     the redact list, one package export over. ADR-0041 rules how much further that argument
     goes.

   "Nothing may opt out" now holds by mechanism on every path under `apps/api/src`, with the
   residuals named in the contract rather than here.
4. **Move the 25 paths into "What may never appear in a log line" as the never-allowlist
   list**, adding the spellings F-261, F-262 and F-266 found. Nothing is deleted from the
   design; it changes from a mechanism to a prohibition.
5. **Update the contract's fenced block in the same commit as the source, never before.**
   The drift test compares the fence to the shipped file, so amending the contract ahead of
   the implementation turns a passing gate red for the length of the gap. This ADR therefore
   ships with the contract's *prose* amended and its fence untouched.
6. **Update the drift spec's fence marker**, the literal `export const REDACT_PATHS` at
   `logger-contract-drift.spec.ts:64`, to `export const LOGGABLE_FIELDS`. F-270's fix anchors
   the normative region on `import pino from 'pino';` and `export interface RequestLogFields`,
   and both anchors survive this change. **Landed at `2423a63`**, marker now at `:72`, with
   the scaffold comment removed from the contract's fence in the same commit.

   **Step 5 could not wait for step 6, so it carried the marker across the gap.** The marker
   selects the fence by raw text, before the comment strip, so a fence with no
   `REDACT_PATHS` in it selects nothing and takes all three passing tests down with
   `expected [] to have length 1`. Step 5 therefore put the marker's text in the fence's first
   **comment**, which the normaliser strips before either comparison. Step 6 re-pointed the
   marker at code the fence carries and deleted that comment.

   **What the gap cost, recorded because the shape recurs (F-276).** The first attempt at step 6
   removed the scaffold comment and read the contract's prose as evidence the marker was
   still needed: a sentence outside the fence carried the same literal, and the selector reads
   fenced `ts` blocks only. Grep is not the check here; running the spec is. The contract's
   section "The block below is machine-checked against the shipped file" now states that, and
   states that renaming a fenced declaration re-points the marker in the same commit.

7. **Cover the message position, and say so in the three places that describe it.** Landed. In
   order:

   1. `logger.ts:239`: replace the `instanceof Error` test with the container test in "The
      argument list" above. `errorMovedOntoTheRecord` does not change.
   2. `logger.ts:212-222`, the "Door six" docblock: the three bullets describe an `Error` in
      the message position, an `Error` in a format parameter, and "A CONTAINER in either
      position is scanned". The first two collapse into one bullet about the position, and the
      third stops being a claim the file contradicts. State what each position gets, in the
      order the table above states it.
   3. The contract's fenced block, as close behind step 7.1 as the ownership rules allow.
      Owned by `sdlc-architect`, not by the implementer, and it is what turns
      `logger-contract-drift.spec.ts` green again after 7.1 turns two of its six red.

   The red step measured that sequencing rather than predicting it: under a candidate fix at
   `:239`, `F-249` and `F-270` went red and returned to green on revert. Two red drift tests
   between 7.1 and 7.3 are the expected state and not a finding.

   **Landed.** 7.1 and 7.2 at `43e10e7`, alongside F-279's `pinoWouldReplace` and F-280's CSP
   override. 7.2's third bullet was DELETED rather than restated, which is the correct outcome
   and not what this step asked for; see the Consequences correction above. 7.3 carried three
   code changes into the fence, not one; see the sequencing note under the step table.

### What a TASK does to log a new field

Three steps, and it is deliberately three:

1. Write the log call.
2. Add the field name to `LOGGABLE_FIELDS` in `apps/api/src/observability/logger.ts`, one
   name per line, with a trailing comment naming the file that emits it.
3. Check it against "What may never appear in a log line". If the field is a raw IP, a token,
   a password, a digest, a request body, a concrete URL path or a foreign `tenant_id`, the
   answer is not to add it to the list: it is that the field may not be logged.

A field that skips step 2 emits `"<field>":"[redacted]"`. That is the designed failure and
it is visible in the line the TASK's own dev run prints.

## Performance

Measured 2026-08-09, pino 10.3.1, Node 24.19, on this repository's own `node_modules`, one
million calls per figure, median of seven runs, against a prototype of the configuration
above and against the shipped configuration copied verbatim. Method stated so it can be
re-run: both loggers built with the same `base`, `serializers`, `hooks` and `timestamp`, both
writing to `pino.destination({ dest: '/dev/null', sync: true })`, differing only in
`redact` + scan.

**The scan alone**, which is the figure the contract already carries for the denylist scan:

| record | denylist scan (shipped) | allowlist scan |
|---|---|---|
| flat request-log record | 30.9 ns | 45.4 ns |
| record carrying `req.headers` | 78.2 ns | 31.1 ns |
| record nested five deep | 66.3 ns | 25.7 ns |
| record holding an error | 559.6 ns | 547.4 ns |

The allowlist costs 15 ns more on a flat record of four named fields, because it does a `Set`
lookup per key that the denylist scan does not. It costs less on everything nested, because a
denied key is censored without walking what is under it.

**The whole log call**, which is the number that matters:

| record | shipped (`redact` 25 paths + denylist scan) | this ADR (allowlist scan, no `redact`) |
|---|---|---|
| flat request-log record | 4295 ns | 1706 ns |
| record carrying `req.headers` | 6723 ns | 1601 ns |
| record holding an error | 5687 ns | 2723 ns |

Bare pino with no mechanisms at all is 1600 ns on the same record and the same destination.

The difference is `redact`, isolated by measuring each mechanism alone: the 25-path list
costs 2822 ns per line on a flat record and 5072 ns on a record carrying `req.headers`, while
the allowlist scan costs 255 ns and roughly nothing respectively. Removing `redact` refunds
more than the allowlist spends, and this ADR makes each log line about **2.6 µs cheaper**
than what ships today.

**Against GC-1** (`p99 ≤ 25 ms server-side on the cache-hit path at 500 RPS`, a ceiling):
one line at 1.7 µs is 0.007% of the ceiling; ten lines per request is 0.07%. The redirect hot
path imports nothing from this module and writes no line today, so the cost lands on the
request-log middleware a later TASK adds, and it lands lower than it would have.

**What the numbers do not say.** The destination is a synchronous `/dev/null`, single
process, no contention; the shipped logger writes to fd 1. Both configurations were measured
the same way, so the *difference* is sound and the *absolutes* are a floor. The 5.8–9 µs
whole-call baseline quoted in earlier rounds is not reproduced here and should not be used;
these figures replace it.

### Re-measured after the change shipped

The figures above are a prototype's. These are the shipped singleton at `45cf578` against the
singleton it replaced (`git show 45cf578^:apps/api/src/observability/logger.ts`, `redact` plus
25 paths plus the denylist scan), both imported into one process with a bare pino built on the
same `base` and `timestamp`, all three writing to fd 1 with the process's stdout redirected to
`/dev/null`. Five runs of 200 000 calls per figure, median, Node 24.19, pino 10.3.1,
2026-08-10. Measured by `sdlc-implementer-backend` and not independently re-run here.

| record | bare pino | before ADR-0028 | shipped |
|---|---|---|---|
| flat request-log record | 2355 ns | 5164 ns | **2507 ns** |
| record carrying `req.headers` | 2406 ns | 6991 ns | **2254 ns** |
| record nested five deep | 2389 ns | 4388 ns | **2269 ns** |
| record holding an error | 2528 ns | 6260 ns | **3857 ns** |

**The prediction held in direction and in magnitude.** This ADR predicted about 2.6 µs off
each line; the flat record fell 5164 → 2507 ns, a saving of 2.66 µs, and the `req.headers`
record fell 6991 → 2254 ns, a saving of 4.74 µs. A `req.headers` record now costs *less* than
bare pino's own path, because a denied key is censored without walking under it. The error
record's 1.3 µs over bare pino is `errorLogFields` building frames, not the scan.

The absolutes differ from the table above (bare pino at 2355 ns here against 1600 ns there):
different machine, and a shell redirect of fd 1 rather than `pino.destination({ sync: true })`.
Use the absolutes from this table, and against GC-1's 25 ms ceiling one line is 0.010%.

### Re-measured after the message position closed

Same method as the table above, at `43e10e7` against `43e10e7^`: both singletons imported into
one process with a bare pino built on the same `base` and `timestamp`, all three writing to
fd 1 with stdout redirected to `/dev/null`, five runs of 200 000 calls per figure, median,
20 000 warm-up calls per shape per instance, Node 24.19, pino 10.3.1, `NODE_ENV=test`,
`LOG_LEVEL=info`, 2026-08-10. Measured by `sdlc-implementer-backend` and not independently
re-run here.

| record | bare pino | `43e10e7^` | `43e10e7` | delta |
|---|---|---|---|---|
| flat request-log record | 2359 ns | 2460 ns | 2443 ns | −17 ns |
| record carrying `req.headers` | 2464 ns | 2275 ns | 2266 ns | −9 ns |
| record nested five deep | 2405 ns | 2314 ns | 2314 ns | 0 ns |
| record holding an error | 2917 ns | 2920 ns | 2944 ns | +24 ns |
| **container in the message position** | 2438 ns | 2526 ns | **2706 ns** | **+180 ns** |

**The one real cost is the shape the fix covers: +180 ns on `logger.error(record, container)`,
which is 0.011% of GC-1's 25 ms ceiling for one line.** It buys the record spread and
`serializers.err` in place of a container stringified into `msg`. The first four rows are
inside run-to-run noise, which is what the change predicts: the predicate trades one
`instanceof` for a `typeof` and a `!== null`, and `pinoWouldReplace` runs only when a child is
built with options, which no call site does.

Read the DELTAS, not the absolutes. Both singletons were measured in the same process here, so
the deltas are sound; the absolutes sit about 60 ns above the previous table's on the same
machine under different session load, and that session-to-session spread is larger than four of
the five deltas.

**So the allowlist is both safer and faster than the 25-path denylist**, and the cost this ADR
accepted was never throughput. It was the missing field, and it still is. What stands between
an unnamed field and a log line is now exactly one mechanism, by design; see
`logging-and-headers.md`, "One mechanism between an unnamed field and the line", for what that
makes load-bearing.

## What this ADR does not decide

- **Door six (F-260).** `msg` built from a log call's arguments. Not touched by any key-based
  scheme. It is a precondition of this decision being worth much, and it belongs to the hook,
  not to the allowlist. **Amended 2026-08-10:** the argument list is decided now, in "The
  argument list: one policy per position", because F-277 measured that leaving it undecided is
  what let the message position ship uncovered. What is still not decided is a `msg` string a
  call site built itself, which no mechanism here reaches.
- **The `toJSON` residual.** A plain object with no own enumerable keys and an own
  non-enumerable `toJSON` is returned by reference from `fieldsCensored` and then serialised
  from `toJSON`'s return value. Measured under a named key and through a format argument
  (round 6, security auditor finding 2). The Consequences table above says the `toJSON` shape
  is `[redacted]`, which holds for the shape it names, whose key is unnamed, and not for the
  mechanism. Unowned. The message-position ruling above avoids it rather than closing it.
- **A Nest `LoggerService` over the shared singleton.** Named in Migration step 3,
  deliberately not decided here. **Its trigger changed on 2026-08-11 and it is now the only
  reason left to build one.** F-278's class is closed for the API's own modules by lint and by
  the enumeration, so this is no longer the mechanism that closes it; what it would still buy
  is Nest's OWN bootstrap and framework lines, which no rule in `apps/api/src` can reach
  because the framework constructs those loggers inside `node_modules`. What would force it: a
  requirement that every line on the process's stdout be NDJSON, which is a log-shipper
  requirement and there is no deploy target (ADR-0030). It still has to answer what a Nest log
  call's `context` and `stack` arguments become, both of which would need names on
  `LOGGABLE_FIELDS`.
- **F-253's sentinel ruling.** The allowlist changes that ruling's premises: the guarantee
  would no longer be bounded by `isWalkable` or by depth, because both now censor instead of
  passing through. Whether that makes a sentinel plus a key-by-key copy worth its cost is a
  decision for whoever owns F-253 and F-259 next. Flagged, not made here.
- **The type-level companion (alternative 3).** A `LoggableRecord` type over the log methods
  would move the friction from incident time to compile time for records that are literals.
  Worth doing if the missing-field cost above turns out to bite in practice. What would force
  it: two or more fields shipping censored by accident.
- **The `helmet`/HSTS half of ADR-0022.** Untouched, still unowned, still F-243 clause 2.
- **`ip_hash` and the snake_case residual.** Subsumed rather than decided: an unnamed
  snake_case key is censored like every other unnamed key.
