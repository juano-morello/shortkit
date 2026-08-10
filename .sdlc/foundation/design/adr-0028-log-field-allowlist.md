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
> caught the discrepancy and declined to reconcile it, which was correct — the card is the
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
field from any header, so contract invariant 1 — "Logging a whole request or response object
never emits a credential, an IP, or a cookie" — is measured false today.

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
  `Record<string, unknown>` defeat it — and a spread of caller-controlled data is the exact
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
it is **not** the normative artifact. `design/contracts/logging-and-headers.md` § "Logger"
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
Accepted. The reason given for it — that the bare spread would change what an operator reads
for `logger.info([e, e], '…')`, contract invariant 5's own shape — is **measured false**. Both
copy forms emit the same bytes: pino's `_asJson` writes own enumerable keys either way, so the
line is `"0":{"err_name":…},"1":{"err_name":…}` under both. Measured 2026-08-10 on pino 10.3.1
with the two formatters side by side.

The ternary is kept for two reasons that do hold. The function is declared
`<T extends object>(record: T, depth: number): T`, and spreading an array into an object
literal makes the `as T` a false statement about the value; a cast that lies is worth one
ternary to avoid. And it is the form the previous shipped scan had, so keeping it is the
existing pattern rather than a new one — this ADR gave no reason to change it, and changing it
was not among the things it decided. Nothing tests the shape, before or after, and that gap is
recorded in the contract rather than closed here.

**2. `interpolationSafe` became `valueCensored(value, 1)`, the constant moving 2 → 1.**
Accepted, and this ADR should have specified the format path rather than leaving it to be
inferred. A format argument arrives under no key, so the key rule cannot apply to it —
`logger.error('a %s', 'b')` has to interpolate `b`, and there is no field name to decide
about. Routing it through the value half of the policy is the only coherent answer.

The constant's meaning changed with it, and the load-bearing property survives. It used to be
the depth a *container* was walked from; it is now the depth the *argument itself* is scanned
at, and `valueCensored` walks a container it holds at `depth + 1` — so a container is still
walked from 2, where the top-level `err` exemption does not fire, and
`logger.error('ctx %o', { err: e })` stays closed. Defended by four tests in `logger.spec.ts`
(F-260's `%o`, `%j`, `%s`, and F-269's no-placeholder shape), all green.

Cost accepted: an interpolated container's reach is one level shallower than a record's, since
it starts at 2 rather than 1. Routing this through `fieldsCensored(value, 1)` instead would
restore that level and reopen the exemption as a hole, so the level is the price of the seam.

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
   positional message never reaches the allowlist and a record-supplied `msg` does — which is
   why `msg` is on the list. `service` and `env` are `base`, serialised at construction from
   module literals.

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
  `err_stack` under any spelling, but an error nested inside a container that is not named —
  `{ ctx: { err: e } }` — is now lost entirely rather than reduced to policy fields. Measured:
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
- The contract's fenced normative block, updated in the same commit as the source and not
  before. See Migration step 5.
- A lint rule banning a second pino instance and `console.*` (F-268) is worth more after this
  change than before, because a second instance now bypasses the only remaining mechanism.

## Migration

**Status 2026-08-10.** Steps 1 to 3 landed at `45cf578` (`sdlc-implementer-backend`). Steps 4
and 5 landed with the contract amendment that follows it (`sdlc-architect`); the drift test's
F-249 and F-270 are green against the shipped file. **Step 6 is outstanding and belongs to
`sdlc-test-architect`**, together with a second, unplanned edit in the same file: the guard
`the redact path with an inner double quote survives the strip on both artifacts` asserts that
`'req.headers["fly-client-ip"]'` is present in the **source**, and that string left with
`REDACT_PATHS`. It is red and it is anchored to something that no longer exists.

The 25 paths ship today. The order below is the order the work has to happen in, and step 1
is not optional.

1. **Land F-263 first or in the same commit.** Reject `redact`, `serializers` and
   `formatters` in the `child` wrapper's `options` argument. Until that exists, one
   documented pino call opts a subtree out of the only mechanism there is.
2. **Add `LOGGABLE_FIELDS` and the three scan functions; delete `REDACT_PATHS`,
   `REDACT_CENSOR`'s use in the `redact` option, and the `redact` option itself.** Keep the
   `REDACT_CENSOR` export.
3. **Sweep every log call site in `apps/api/src` and check its fields against the list.**
   There are six today: `main.ts:198`, `main.ts:269`, `exception-filter.ts:125` (the child
   binding), `:181`, `:195`, `:271`, plus `db/client.ts:93` and `tenant-context.ts:247`,
   which pass a string and no record. The thirteen names in the list were derived from
   exactly this sweep; if a field is missing the line degrades silently, so the sweep is the
   safety net, not a formality.
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
   and both anchors survive this change.

   **Step 5 could not wait for step 6, so it carried the marker across the gap.** The marker
   selects the fence by raw text, before the comment strip, so a fence with no
   `REDACT_PATHS` in it selects nothing and takes all three passing tests down with
   `expected [] to have length 1`. Step 5 therefore put the marker's text in the fence's first
   **comment**, which the normaliser strips before either comparison. Step 6 re-points the
   marker at code the fence actually carries, and that comment goes with it. The contract says
   so above its fence, because a selector that depends on a comment is what a later editor
   deletes as noise.

### What a TASK does to log a new field

Three steps, and it is deliberately three:

1. Write the log call.
2. Add the field name to `LOGGABLE_FIELDS` in `apps/api/src/observability/logger.ts`, one
   name per line, with a trailing comment naming the file that emits it.
3. Check it against "What may never appear in a log line". If the field is a raw IP, a token,
   a password, a digest, a request body, a concrete URL path or a foreign `tenant_id`, the
   answer is not to add it to the list — it is that the field may not be logged.

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

## What this ADR does not decide

- **Door six (F-260).** `msg` built from a log call's arguments. Not touched by any key-based
  scheme. It is a precondition of this decision being worth much, and it belongs to the hook,
  not to the allowlist.
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
