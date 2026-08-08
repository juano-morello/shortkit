# TASK-003 — scoped re-review, fix round 2 (r3 audit)

- **Reviewer slot:** `sdlc-reviewer`
- **Scope:** the fix diff only — `89b5021..f47553a`, 6 commits, 7 files.
- **Date:** 2026-08-08
- **Verdict:** **changes-requested**
- **Findings this round:** 3 major, 2 minor. No blockers.
- **Per-finding verdicts:** F-248 **ADDRESSED**. F-249 **ADDRESSED**.
- **Tests not re-run** (orchestrator's run in this session stands: 79 passed / 6 failed, all
  six TASK-008 `not implemented` reds; typecheck, lint, build exit 0). Everything below comes
  from targeted probes I ran myself against the shipped module and against `node_modules`.

---

## 1. What I verified myself

Every claim in this section was executed, not read. Probes ran through `npx tsx` against
`apps/api/src/observability/logger.ts` — the shipped singleton, not a rebuilt equivalent —
with `NODE_ENV=test`, on pino 10.3.1 / Node 24.19.

### 1.1 The ordering correction — CONFIRMED, and the finding as filed was wrong

`node_modules/.pnpm/pino@10.3.1/node_modules/pino/lib/tools.js`, `_asJson`:

```js
  let value
  if (formatters.log) {
    obj = formatters.log(obj)          // line 160-162
  }
  const wildcardStringifier = stringifiers[wildcardFirstSym]
  let propStr = ''
  for (const key in obj) {
    value = obj[key]
    if (Object.prototype.hasOwnProperty.call(obj, key) && value !== undefined) {
      if (serializers[key]) {
        value = serializers[key](value)   // line 169
```

`formatters.log` runs **before** the per-key serialiser loop. F-248's `required_change` and
the test architect's §5 both stated the opposite. The implementer's correction is right and
it is load-bearing: I reproduced the counterfactual by handing the shipped logger a plain
object under `err` and got `{"err":{"err_name":"non-error throwable (object)"}}`, which is
exactly what the top-level `err` key would emit if `errorsReplaced` did not skip it. The
`depth === 1 && key === ERROR_KEY` skip is required, not stylistic.

Also note from the same loop: pino guards with `hasOwnProperty`, so the `for…in` never emits
an inherited key that `Object.keys` in the scan would have missed. There is no gap there.

### 1.2 The partition claim — holds inside the log-method record, fails outside it

Inside the object passed to a log method, I could not find a key that falls between the two
mechanisms or that both touch. Verified emitted bytes for each:

| shape | emitted | leak |
|---|---|---|
| `{ err: e }, 'ctx'` | `err_name` + `err_stack` | no |
| `{ error: e }, 'ctx'` | `err_name` + `err_stack` | no |
| `{ cause: e }, 'ctx'` | `err_name` + `err_stack` | no |
| `{ ctx: { err: e } }, 'ctx'` | `err_name` + `err_stack` at depth 2 | no |
| `{ errors: [e, e] }, 'ctx'` | array preserved, both replaced | no |
| `[e, e], 'ctx'` (top-level array) | both replaced | no |
| `{ err: { inner: e } }, 'ctx'` | `{"err_name":"non-error throwable (object)"}` | no |
| `{ deep: Object.create(null) with err }` | replaced | no |
| depth 4 | replaced | no |
| depth 5 | **`"body":"{\"password\":\"BODYMARK\""` verbatim** | yes, documented residual |
| `{ ctx: new SomeClass(e) }` | **`"body":"{\"password\":\"BODYMARK\""` verbatim** | yes, **undocumented** — finding 4 |
| `logger.error(e)` positional | hook rewrites, `msg` fixed string | no |
| `logger.error({ err: e })` **no context string** | **`"msg":"<e.message>"`** | yes — finding 2 |
| `logger.child({ error: e })` | **`"error":{"body":"{\"password\":\"BODYMARK\"",…}`** | yes — finding 3 |
| `logger.child({ ctx: { err: e } })` | **same, nested** | yes — finding 3 |
| `logger.child({ err: e })` | `err_name` + `err_stack` | no |

So the partition table in the contract is accurate **for the record handed to a log method**.
It is not accurate for the two other doors onto the same line: child bindings (a different
pino code path — `asChindings`, which applies `formatters.bindings`, not `formatters.log`),
and `msg`, which `proto.js write()` derives from `_obj[errorKey].message` before `_asJson`
runs at all. Findings 2 and 3.

### 1.3 Non-mutation, hostile input, termination

- **Non-mutation: confirmed.** After `logger.error({ ctx: { err: e }, password: 'PLAINTEXT' })`
  the caller's object still satisfies `caller.ctx.err === e` and `caller.password === 'PLAINTEXT'`.
  Asserted from inside the same process, on a second log line.
- **Self-referential record: confirmed terminates.** `cyc.self = cyc` logs and does not hang.
  Worth noting for a later reader: copy-on-change expands the cycle to `MAX_ERROR_SCAN_DEPTH`
  copies in the output before `[Circular]` appears, so a cyclic record with an error in it
  writes a visibly larger line than it did before. Bounded, not a defect.
- **`err.cause` is not walked: confirmed on all three paths** — `{ err: chained }`,
  `{ error: chained }` and `{ ctx: { err: chained } }` all emit only `err_name` + `err_stack`
  and neither the inner body nor the inner message.
- **A record property whose getter throws: NOT survivable.** `readIndexedProperty` catches, so
  the scan itself does not throw — but it *skips* the key and leaves it in place, and pino's
  own `_asJson` then does `value = obj[key]` at `lib/tools.js:167` and throws out of the log
  call. Reproduced: the call emitted **no line** and the exception escaped. A bare pino with no
  formatter does the same, so this is pre-existing pino behaviour and **not introduced by this
  diff** — but the contract's brand-new invariant 6 asserts the opposite. Finding 1.

### 1.4 The depth bound of 4

The argument is sound as far as it goes and I confirmed its premises: every log call site in
`apps/api/src` builds a flat record (`exception-filter.ts:265-275` spreads `errorLogFields` at
the root; `main.ts:198`/`:269` flat; `db/client.ts:93` and `tenancy/tenant-context.ts:247` are
message strings), and `req.headers.authorization` at 3 is the deepest shape named anywhere.

I re-measured the cost independently rather than taking the report's table: **54 ns** for the
formatter alone on a flat 5-key record, **135 ns** on a nested one, 200 000 iterations each.
Same order of magnitude as the implementer's 40 ns / 95 ns. My whole-bare-call baseline to
`/dev/null` came out at **909 ns**, not the 5.8–9 µs the report used, so the "under 2% of a
line" figure is optimistic — it is closer to 6% of a call by my measurement. It does not
matter: 135 ns against GC-1's 25 ms ceiling is six orders of magnitude of headroom either way.
The percentage claim is the only number I would not repeat as written.

The residual is recorded in three places a later reader will hit: the `MAX_ERROR_SCAN_DEPTH`
docblock in the source, the contract's "The residual: depth 5" section with the emitted line,
and the Versioning section's rule that raising the bound is additive. That is adequate.

### 1.5 The second new test — legitimate, but it does not guard what it says it guards

`F-248: an error reached only through 'err.cause' is still not walked into` is not a test that
cannot fail: swapping `serializers.err` for `pino.stdSerializers.errWithCause`, or making
`errorLogFields` emit `cause`, turns it red. Green-before-and-after is fine for a regression
guard on a property that already held.

But its stated purpose is wrong. The comment says it is "asserted so a walk added for the
shapes above cannot start". The line it inspects is `logger.error({ err: chained }, …)` — a
**top-level `err`**, which `errorsReplaced` skips by construction and `serializers.err` handles.
`errorsReplaced` never sees it. A regression that makes the *walk* follow `cause` would leave
this test green. Finding 5.

### 1.6 F-249's contract edit — the literal is exact

I compared the contract's normative `logger` block against the shipped file mechanically:

- `REDACT_PATHS`: 25 entries on both sides, identical set, no transcription drift.
- the `pino({…})` literal: **byte-identical**.
- `errorsReplaced`, `readIndexedProperty`, `isWalkable`: **byte-identical** modulo one added
  explanatory comment on the depth-1 skip.

The `error-envelope.md` corrections also match shipped code: `exception-filter.ts:125` builds
the child logger with `request_id`, and `logError` at `:265-275` spreads
`errorLogFields(exception, { includeMessage: isDomainError(exception) })` — so "`err_name` and
`err_stack`, on a child logger carrying `request_id`, `err_message` only for a `DomainError`"
is exactly what ships. F-242's re-measured correction is right; I did not re-run the
`redact: { paths: ['err.message','err.stack'] }` measurement, but the mechanism is not in doubt.

### 1.7 The contract / stub / ADR triangle

Three artifacts carry a logger configuration. Contract: current and exact. Stub: banner added,
marked superseded and unsafe to copy, and the contract header no longer points at it as
normative. ADR-0022: still fences the pre-F-244 `redact` block with no serialisers, no hook and
no formatter — grep confirms zero occurrences of `serializers` in it, and the file exists at the
path F-250 now names (`f47553a` repointed it correctly).

**I agree the triangle is consistent apart from F-250.** The architect was right to decline to
amend an accepted ADR inside an F-249 dispatch, and right to flag it. Not fixing it here.

---

## 2. Findings

```yaml
verdict: changes-requested
findings:
  - severity: major
    kind: contract
    file: .sdlc/launch-core/design/contracts/logging-and-headers.md
    line: 405
    summary: >-
      New invariant 6 asserts that a record property whose getter throws is survivable and the
      log call "emits a line and does not rethrow". Measured false: the log call throws.
    failure_scenario: >-
      const rec = { ok: 1 }; Object.defineProperty(rec, 'boom', { enumerable: true,
      get() { throw new Error('hostile getter'); } }); logger.error(rec, 'ctx').
      errorsReplaced's readIndexedProperty catches and SKIPS the key, leaving it in the record;
      pino's _asJson then reads obj[key] at lib/tools.js:167 and the getter throws from there.
      Reproduced against the shipped module: no line was emitted and the exception escaped the
      log call. The invariant names the two places it matters — the exception filter's
      headersSent arm (outside the try/catch F-092 added) and main.ts's last-chance boot handler
      — so a later TASK that trusts it there converts a logged failure into an unhandled one.
      A bare pino behaves the same way, so the code is not a regression from this round; the
      claim is new in this diff.
    required_change: >-
      Either the invariant stops claiming it (state it as a residual, the way depth 5 is stated),
      or readIndexedProperty stops skipping and instead writes a sentinel into the copy so the
      key pino later reads is safe. Whichever, the contract and the source docblock must agree —
      the docblock currently says the scan "leaves pino's own stringify to handle it exactly as
      it did before this function existed", which is accurate and is what makes the invariant false.

  - severity: major
    kind: contract
    file: .sdlc/launch-core/design/contracts/logging-and-headers.md
    line: 401
    summary: >-
      New invariant 5 says the coverage "holds for { err: e }". Without a context string,
      logger.error({ err: e }) puts the error's message into msg.
    failure_scenario: >-
      pino proto.js write() line 223: `if (msg === undefined && _obj[messageKey] === undefined &&
      _obj[errorKey]) { msg = _obj[errorKey].message }`. hooks.logMethod only fires when the
      FIRST argument is an Error instance, so `{ err: e }` passes straight through. Reproduced
      against the shipped module: logger.error({ err: new Error('DSNMARK postgres://user:pw@host/db') })
      emits a clean err object and `"msg":"DSNMARK postgres://user:pw@host/db"`. msg is the one
      top-level field no redact path can censor without censoring every line — the exact reason
      hooks.logMethod exists for the positional form. On the F-108 framework-400 arm that message
      quotes raw request bytes, so this is the same GC-9 exposure F-244 was filed for, by a third
      door. No current call site omits the context string; the contract now tells later TASKs the
      shape is covered.
    required_change: >-
      The hook's condition must cover a record whose errorKey holds an Error and whose second
      argument is not a string, or the invariant must carve the case out explicitly and the
      "What the implementer must guarantee" list must require a fixed context string on every
      error log call. The architect's own §5 constraint text for TASK-009 already says
      `logger.error({ err }, 'fixed context string')` — the contract body does not.

  - severity: major
    kind: behavior
    file: apps/api/src/observability/logger.ts
    line: 126
    summary: >-
      formatters.log does not run on child-logger bindings, so an Error in a child binding under
      any key other than `err` still writes body-parser's raw request body verbatim.
    failure_scenario: >-
      pino builds child bindings through asChindings (lib/tools.js), which applies
      formatters.BINDINGS and serializers[key] — never formatters.log. Reproduced against the
      shipped module: logger.child({ error: parseFailure }).error('…') emits
      "error":{"body":"{\"password\":\"BODYMARK\"","status":400,"type":"entity.parse.failed"},
      and logger.child({ ctx: { err: parseFailure } }).error('…') emits the same payload nested.
      That is F-248's exact leak, unclosed, through a pino API this repository already uses —
      exception-filter.ts:125 creates a child logger per request. Only logger.child({ err: e })
      is covered, and only because asChindings consults serializers[key].
      Contract invariant 5 ("under any key, at any depth up to 4") does not carve child bindings
      out, and neither the partition table nor the "There is no key between them" sentence
      mentions them.
    required_change: >-
      Either the same scan runs on bindings (formatters.bindings, which pino applies at child
      creation), or the residual is named as loudly as the depth-5 one is — in the source
      docblock, in the contract's partition section, and in invariant 5 — with the rule that a
      TASK must not put a throwable into child bindings. A test on emitted bytes for the child
      path either way, since the suite currently has none.

  - severity: minor
    kind: implementation
    file: apps/api/src/observability/logger.ts
    line: 268
    summary: >-
      isWalkable excludes class instances, so an Error held inside one is never replaced — a
      residual of the same class as depth 5, but recorded nowhere.
    failure_scenario: >-
      class Ctx { constructor(e) { this.err = e } }; logger.error({ ctx: new Ctx(parseFailure) }, '…')
      emits "ctx":{"err":{"body":"{\"password\":\"BODYMARK\"",…}}. Reproduced against the shipped
      module. JSON.stringify serialises a class instance's own enumerable properties happily, so
      the value reaches the line even though the scan declined to walk it. The docblock explains
      why class instances are skipped (Buffer index strings) but never states the consequence,
      while the strictly-less-likely depth-5 residual is stated in the source, the contract and
      the Versioning rules.
    required_change: >-
      State the residual beside the depth-5 one, in the same two places, with the same escalation
      rule. No behaviour change required if the trade-off is deliberate.

  - severity: minor
    kind: implementation
    file: apps/api/src/observability/logger.spec.ts
    line: 389
    summary: >-
      The err.cause regression guard exercises the serializer path, not the walk it says it
      guards, so a walk that starts following cause would leave it green.
    failure_scenario: >-
      The test reads the line emitted by logger.error({ err: chained }, '…'). A top-level `err`
      is skipped by errorsReplaced (depth === 1 && key === ERROR_KEY) and handled by
      serializers.err, so errorsReplaced never receives the chained error. The comment says the
      test exists "so a walk added for the shapes above cannot start" — a mutation that makes
      errorsReplaced descend into a replaced Error's cause would not touch this line. The
      neighbouring test that DOES exercise the walk uses parseFailure, which has no cause, and
      asserts Object.keys equality that a `cause: undefined` would not trip.
      It is not a test that cannot fail — swapping in pino.stdSerializers.errWithCause reddens it
      — so this is mis-aimed coverage, not a vacuous test.
    required_change: >-
      The guard must inspect a line built through the walk: the chained error under a non-`err`
      key, or nested under ctx. Keeping the existing line as well is fine; it locks
      errorLogFields' non-descent, which is also worth locking.
```

---

## 3. Per-finding verdicts

### F-248 — **ADDRESSED**

The remedy the finding asked for is what shipped, by a mechanism the finding described
backwards, and the implementer caught and corrected the premise rather than following it.
Evidence I checked personally:

- `formatters.log` before serializers, read out of the installed `lib/tools.js`.
- The counterfactual: a plain object under `err` emits `non-error throwable (object)`, which is
  what the top-level key would emit without the depth-1 skip.
- All three shapes F-248 named (`{ error: e }`, `{ cause: e }`, `{ ctx: { err: e } }`) plus a
  top-level array, an array at depth, a null-prototype container and depth 4 emit `err_name` +
  `err_stack` and nothing else, with `BODYMARK` and the message marker absent from the raw bytes.
- Non-mutation, cycle termination and `err.cause`-stays-shut all confirmed by execution.
- `serializers.error` / `serializers.cause` correctly not added.

The residuals I found (findings 2, 3, 4) are shapes F-248 did not name and the fix did not
claim in code — they are in scope only because the contract written after it claims them.

### F-249 — **ADDRESSED**

The contract's normative literal is now byte-identical to the shipped `pino({…})` call and to
the three helper functions, with an identical 25-path redact list; the four mechanisms each
carry their reasoning and their rejected alternative; the ordering, the partition table, the
depth-5 residual with its emitted line and the camelCase/snake_case question are all recorded;
the wave-1 stub is marked superseded at both ends; and `error-envelope.md`'s three false
clauses are corrected to what `exception-filter.ts` actually does. The architect read and ran
the code rather than transcribing the reports, and that is visible in the result — it caught
the ordering error the reports carried.

The verdict is ADDRESSED with the qualification that the two new invariants it added (5 and 6)
overclaim: findings 1 and 2 above. That is a new divergence introduced by this diff, in the
opposite direction from F-249's original one — the document is now ahead of the code rather
than behind it — and it is the reason the round is changes-requested rather than clear.

---

## Cannot verify from diff

- **The 5.8–9 µs whole-log-call baseline** the "under 2%" figure divides by. My own baseline to
  `/dev/null` was 909 ns. The difference is probably destination and configuration, but I could
  not reproduce their denominator, so I can neither confirm nor refute the percentage. The
  absolute scan cost I did reproduce, and it is negligible against GC-1 either way.
- **body-parser 2.3.0 assigning the verbatim body to `err.body`.** Reproduced with a hand-built
  error, as both the implementer and the architect did. Nobody in this chain has run it through
  body-parser itself.
- **F-243 clause 2 (helmet / HSTS), now marked "not true today" against invariant 4.** Outside
  this diff's code and unowned; I confirmed the marking exists but not the routing.
- **Whether any TASK other than TASK-009 re-derives a logger from ADR-0022.** F-250's blast
  radius spans TASK cards this diff does not touch.
- **`apps/api/src/tenancy/tenant-context.ts:247`.** The interpolated `error.message` is real — I
  read the line — but it is outside this diff and outside TASK-003's paths. The contract now
  names it, which is the right holding pattern. No finding filed here; it belongs to whoever
  owns that file.

---

## Notes

- **GC-9 lens.** The three leak paths I found (findings 2, 3, 4) are all the same payload —
  body-parser's verbatim request body, or an error message that on the F-108 arm quotes raw
  request bytes. None of them is reachable from a call site that exists today. All three become
  reachable the moment a later TASK writes an idiomatic line, which is precisely the failure mode
  F-244 and F-248 were both filed for, and precisely what the contract is supposed to prevent by
  telling that TASK the truth.
- **GC-1 lens.** No concern. 54–135 ns of formatter against a 25 ms p99 ceiling.
- **GC-4.** No AI attribution in any of the six commit subjects or bodies in this range.
- **GC-11.** The code in this diff came from `sdlc-implementer-backend` and the `design/**` edits
  from `sdlc-architect`, per the reports and the commit trailers. Nothing suggests a main-loop edit.
- **What I liked, and would not want lost in a rework round.** The implementer contradicting the
  finding's stated mechanism and proving it out of `node_modules` is the behaviour that makes this
  process worth its cost — the fix the finding asked for literally would have reddened two frozen
  tests. Same for the architect running the module instead of trusting three reports that agreed
  with each other and were wrong.
- **A note on the pattern F-250 names.** One configuration living in three artifacts is what
  produced F-244, F-248, F-249 and F-250 in sequence. The contract now says "when this block and
  the shipped file disagree, the shipped file wins and the divergence is a finding", and nothing
  enforces it. Findings 1 and 2 in this report are that divergence reappearing within a single
  round of the sentence being written. A test that compares the contract's fenced block to the
  shipped literal is mechanical, and it is the only thing in this chain that would have caught it.
