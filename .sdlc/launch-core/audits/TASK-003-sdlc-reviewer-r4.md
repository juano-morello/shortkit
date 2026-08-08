# TASK-003 — scoped re-review, fix round 3 (r4 audit)

- **Reviewer slot:** `sdlc-reviewer`
- **Scope:** the fix diff only — `0a52185..015bba2`, 8 commits, 8 files.
- **Date:** 2026-08-08
- **Verdict:** **changes-requested** — 4 minor, no blockers, no majors.
- **Per-finding verdicts:** F-250 **ADDRESSED**. F-251 **ADDRESSED**. F-252 **ADDRESSED**.
  F-253 **ADDRESSED as to the ruling, with one measurably-false sentence in its reasoning**
  (finding 1 below). F-255 **ADDRESSED**. F-256 **ADDRESSED**. F-258 **ADDRESSED**.
  F-259 **CONFIRMED OPEN** and reproduced.
- **Tests not re-run.** The orchestrator's run in this session stands (92 passed / 6 failed,
  the six being TASK-008's `not implemented` reds; logger spec 20/20; drift spec 4/4;
  typecheck, lint, build exit 0). Everything below is from targeted probes I ran myself
  against the shipped singleton and against `node_modules`, plus reading pino 10.3.1's source.

---

## 1. What I executed rather than read

All probes ran under Node 24.19 against `apps/api/src/observability/logger.ts` — the shipped
module, imported, not rebuilt — on pino 10.3.1.

### 1.1 The two `defineProperty` wrappers on the shared singleton

Every property the dispatch named, checked by execution or by reading pino's source:

| property | result |
|---|---|
| grandchild through the prototype chain | `logger.child({a:1}).child({error:e})` emits `"a":1` **and** `"error":{"err_name":"SyntaxError","err_stack":…}`. Covered, and correctly parented — the `a:1` binding survives, which is what `.call(this, …)` buys and what `.bind(logger)` would have destroyed. |
| receiver preservation on `setBindings` | `logger.child({b:2}).setBindings({error:e})` scrubs on the child's lines; the root's next line is clean. No cross-contamination. |
| `child()` with no bindings | still raises pino's own `missing bindings for child Pino`. |
| `child(bindings, options)` | `options` is forwarded positionally, so `options == null` still takes pino's fast path (`proto.js:96`) and a real `options` object still takes the slow one. Verified with `{ level: 'error' }`; the binding was scanned and the option honoured. |
| `setBindings(undefined)` | no-op. `bindingsScanned` hands falsy straight back and pino's `for…in` over `undefined` iterates nothing. |
| anything inside pino calling `.child(` or `.setBindings(` | **zero hits** across `lib/*.js` and `pino.js`. Nothing internal is displaced. |
| the shared depth-1 helper | both wrappers call `bindingsScanned`, one function, one literal `1`. The M17 drift the red step found is removed structurally, not documented. |
| own-property hygiene | `Object.keys(logger)` is unchanged (`levels, silent, onChild, trace…fatal`); the two wrappers are `enumerable: false` and do not appear. `bindings()` still round-trips. |

`formatters.bindings` really is unusable here, and I read it rather than took it: `child()`
called with no `options` replaces `instance[formattersSym]` with one built on
`resetChildingsFormatter` (`proto.js:84`, `:98-104`) **before** `asChindings`, and the slow
path does the same at `:141-147` unless a formatter is passed in the child's own `options`.
A root `formatters.bindings` runs on `base` at construction and never again. The implementer
contradicting F-251's stated mechanism is right, for the second round running.

### 1.2 The seam on the bindings paths

`asChindings` (`tools.js:238`) applies `instance[formattersSym].bindings` at `:247` and
`serializers[key]` at `:258` — the same order `_asJson` uses. Both wrappers scan at depth 1
and keep the top-level `err` exemption, which is the correct side of that seam: measured,
`logger.child({ err: e })` and `setBindings({ err: e })` both still emit `err_name:
"SyntaxError"` with frames. The depth-2 "fix" the dispatch names would trade the leak for the
error's name and every frame, and `logger.spec.ts` has a guard per path that fires on it.

### 1.3 F-252's widening — correct, and the guard on `msg` is required rather than defensive

I read `proto.js:224` verbatim:

```js
if (msg === undefined && _obj[messageKey] === undefined && _obj[errorKey]) {
  msg = _obj[errorKey].message
}
```

No `instanceof`. So narrowing the hook to `err instanceof Error` would have left
`logger.error({ err: { message: 'postgres://user:pw@host/db' } })` putting that string into
`msg` — the shape `catch (err)` binds and the shape F-254's own test exists for. **The
widening is the right call and the reasoning given for it is the reasoning pino's source
supports.**

The `msg`-already-present half is load-bearing too, and I checked why: `_asJson`'s key loop
writes the record's own `msg` into `propStr` (`tools.js:165-199`) and then appends
`messageKey` again from the `msg` argument at `:202-226`. Supplying a second message would
emit the key twice on the line. Measured: `logger.error({ err: e, msg: 'callers own msg' })`
emits exactly one `msg`, the caller's. The six-row table in the contract reproduces.

I looked for the leak direction — a shape where pino derives `msg` from the error but the
predicate says no — and could not construct one. Non-objects and `null` never reach pino's
derivation branch; `record instanceof Error` is already returned by branch 1; a falsy `err`
is falsy for pino too; a throwing `msg` or `err` getter makes the log call throw rather than
leak, which is F-253's stated residual and not a new hole.

### 1.4 F-253's four throw sites — all four reproduced, and invariant 7 is true

Reproduced against the shipped module, top stack frame under the getter recorded:

| shape | throws from | matches the contract's table |
|---|---|---|
| hostile getter at depth 1, no error elsewhere | `Pino._asJson`, `tools.js:167` | yes |
| hostile getter at depth 1 beside an error | `errorsReplaced`, `logger.ts:398` | yes |
| hostile getter at depth 2 | `cloneSelectively`, `@pinojs/redact/index.js:408` | yes |
| hostile getter in `child()` or `setBindings()` bindings | `asChindings`, `tools.js:250` | yes |

And the half the contract now claims **is** true: a `class Hostile extends Error` whose
`name`, `message` and `stack` all throw is survivable under `err`, under `error`, positionally,
and in child bindings — four calls, four lines emitted, nothing rethrown. Invariant 7 as
rewritten is accurate, and the r3 major it replaces is properly closed.

### 1.5 The drift test — I contest nothing in its self-assessment

Its author says it catches F-249 and not F-250, F-252 or F-253. I agree on all four, and the
reasons given are the right ones: F-250 lived in a third artifact this test does not read;
when F-252 was live the two artifacts agreed with each other and were both wrong, which no
artifact-to-artifact comparison can see; an invariant is prose outside the fence. It does not
over-claim. It also does not under-claim materially — it does forward-guard the F-251/F-258
shape, and it says so.

I re-ran its comparison out of process, with its own normaliser, against copies of both
artifacts. Baseline matches at **index 0** of the normalised source, fence 4107 chars of
5942. Dropping the `setBindings` wrapper from a copy of the source goes **red**. Rejecting
the architect's whitespace-collapsing stripper was right: the fence's payload is string
literals, and a normaliser that collapses inside them cannot tell `'an error'` from
`'an  error'`.

Two mutations it does **not** catch are in finding 2.

---

## 2. Findings

```yaml
verdict: changes-requested
findings:
  - severity: minor
    kind: contract
    file: .sdlc/launch-core/design/contracts/logging-and-headers.md
    line: 511
    summary: >-
      The "Why a sentinel was rejected" paragraph says a sentinel "would cover the first two
      rows and not the last two, [because] fast-redact's clone and asChindings run over
      containers the scan does not reach". Measured false: both of those read the scan's own
      output, so within MAX_ERROR_SCAN_DEPTH a sentinel would cover all four rows.
    failure_scenario: >-
      Verified against the shipped module. (a) `_asJson` assigns `obj = formatters.log(obj)`
      at tools.js:160-162 and only then runs the per-key stringifiers, so the redact library
      sees the scan's output - `logger.error({ req: { ok: 1, boom: '[unreadable]' } }, 'ctx')`
      emits a line, while the same shape with a throwing `boom` getter throws from
      cloneSelectively. (b) `bindingsScanned` is the only object either wrapper hands pino, so
      `asChindings` reads the scan's output too - `logger.child({ ok: 1, boom: '[unreadable]' })`
      emits a line while the throwing form throws from asChindings. (c) The scan already owns
      the depth-2 container: `logger.error({ req: hostileObj }, 'ctx')` where hostileObj also
      holds an Error throws from `errorsReplaced` at logger.ts:398, not from the redact clone,
      because the spread copies that container. A sentinel written into the copy would
      therefore prevent rows 3 and 4 up to the bound, not only rows 1 and 2.
      The RULING - residual, no sentinel - is unaffected and I agree with it: the paragraph's
      SECOND argument is sound and sufficient, that a guarantee bounded at depth 4 is worse
      than a stated residual because the exception filter's headersSent arm and main.ts's boot
      handler cannot check the bound before they call. The cost argument (the spread re-invokes
      the getter, so a sentinel forces a key-by-key copy on every error line) is also correct.
      What is wrong is the coverage count a later TASK would use to decide whether revisiting
      the sentinel is worth it, in a section written this round to replace a claim that was
      measured false.
    required_change: >-
      The sentence must state what holds: a sentinel would cover every one of the four rows
      INSIDE MAX_ERROR_SCAN_DEPTH and inside containers isWalkable accepts, and none outside
      it - which is the bounded-guarantee argument the next paragraph already makes, and is
      the reason to decline it. Delete the "two of four" count or correct it.

  - severity: minor
    kind: implementation
    file: apps/api/src/observability/logger-contract-drift.spec.ts
    line: 67
    summary: >-
      The drift check is a plain substring test with no anchor at either end of the normative
      region, so the contract fence may silently be a truncated copy and the source may gain
      an undocumented declaration at the region's tail, both green.
    failure_scenario: >-
      Reproduced on copies of both artifacts, outside the repository, with the spec's own
      normaliser. (a) Deleting the whole trailing `isWalkable` function from the contract fence
      leaves the fence a contiguous substring of the source: GREEN, and the contract now
      under-specifies the normative form it claims to be the single source of. (b) Inserting
      `Object.defineProperty(logger, 'flush', { value: () => undefined });` into the source
      immediately before `export interface RequestLogFields` - i.e. at the end of the region
      the contract designates - is GREEN, and that is the F-251/F-258 shape in the direction
      that produced F-249: a mechanism in the code that no artifact records. Interior changes
      are caught, which I confirmed: dropping the setBindings wrapper from the source goes RED.
      The contract states the stronger property than the test enforces - "Anything else - a
      reordered declaration, a changed redact path, a dropped wrapper, a different depth bound
      - fails" - and a declaration ADDED at the tail does not fail.
    required_change: >-
      The region must be anchored at both ends, so that "the fence is the region" is checked
      rather than "the fence occurs somewhere in the file". The head is free today - the fence
      already matches at index 0 of the normalised source, so asserting that is one character
      of change. The tail needs an explicit end marker (the normalised source, sliced at the
      designated terminator, EQUALS the normalised fence). Whatever the mechanism, the
      contract sentence and the test must claim the same thing.

  - severity: minor
    kind: behavior
    file: apps/api/src/observability/logger.spec.ts
    line: 187
    summary: >-
      Nothing in the suite builds a grandchild, so the receiver preservation the contract now
      states as an invariant is unpinned and a plausible refactor breaks it silently.
    failure_scenario: >-
      The contract's "The two wrappers" section states "children of children are covered:
      `child` returns `Object.create(this)`, so a grandchild inherits the own property from the
      root and `.call(this, …)` preserves the receiver, which is what keeps a grandchild
      parented to its parent rather than to the root". The three F-251 lines in the emitter
      (ordinals 10-12) all call `logger.child(…)` on the ROOT. Replacing
      `inheritedChild.call(this, …)` with `inheritedChild.call(logger, …)` - the "this is
      always the singleton anyway" simplification, and the one the implementer itself asked to
      have looked at in its report section 8 - leaves all 20 tests green while
      `logger.child({ request_id }).child({ ctx })` loses `request_id` from every line the
      grandchild writes. That is the field `error-envelope.md` requires on the exception
      filter's error line, and the filter is the one call site that builds children today.
      The leak assertions would not notice, because the scan still runs.
    required_change: >-
      One line in the emitter that builds a child of a child and asserts BOTH bindings survive
      on its output, and the error under a non-`err` key in the grandchild's bindings is still
      reduced. It pins the receiver, which is the only part of the wrapper mechanism no
      existing test touches.

  - severity: minor
    kind: contract
    file: .sdlc/launch-core/design/adr-0022-logging-cors-and-security-headers.md
    line: 78
    summary: >-
      ADR-0022 still says TASK-003 ships the two `x-shortkit-*` redact entries "in wave 1,
      before TASK-009 and TASK-012 introduce the headers". TASK-003 is wave 2 and concurrent
      with TASK-009, and the contract's twin sentence was corrected in this same commit.
    failure_scenario: >-
      `.sdlc/launch-core/tasks/TASK-003.md:55` says "CORRECTED 2026-08-06: TASK-009 is in WAVE
      2, not wave 3 - you are concurrent, not sequenced", and eb9abe9 rewrote the contract's
      version of this paragraph to say exactly that ("TASK-003 and TASK-009 are both in wave 2
      and run concurrently … rather than eight waves ahead of them as this paragraph used to
      say"). The ADR paragraph beside the F-250 amendment was left at the old claim, so the
      round that removed one stale copy from this file left another one in it, three
      paragraphs further down. A reader resolving sequencing from the ADR gets the wrong
      answer, and the "wins any disagreement" rule the amendment installs does not help here
      because the contract's corrected sentence is about the redact list, not about waves.
    required_change: >-
      Either correct the sentence to wave 2 / concurrent, or date-stamp it as the 2026-08-04
      belief the way the F-250 amendment date-stamps the literal it removed. One or the other;
      an undated false claim in an accepted ADR is what F-250 was filed for.
```

---

## 3. Per-finding verdicts

### F-251 — **ADDRESSED**

Closed by wrapping `logger.child`, not by `formatters.bindings`, and I confirmed the
mechanism the finding named provably cannot reach child bindings on pino 10.3.1
(`proto.js:98-104` and `:141-147`). Grandchildren, receiver, `options`, falsy bindings, own-
property hygiene and the depth-1 seam all verified by execution (§1.1, §1.2). The finding's
`required_change` also asked for "a test on emitted bytes for the child path either way" —
three landed, including the seam guard for the depth-2 wrong fix.

### F-252 — **ADDRESSED, and the widening is right**

The predicate mirrors `proto.js:224` exactly, including the `messageKey` clause, and I read
that line rather than taking it. Testing `err instanceof Error` would have left the decorated
plain object under `err` leaking its `message` into `msg` — the enumeration shape F-244
rejected. **The widening is narrower in effect than the finding's literal text would have
been, not broader**, and it is the version pino's own behaviour requires. The
`msg`-already-present carve-out is required to avoid writing the key twice, which I confirmed
from `_asJson`'s two write sites. No leak direction exists (§1.3).

### F-253 — **ADDRESSED as to the ruling; one sentence of its reasoning is false**

Residual rather than invariant is the right outcome, and the rewrite of invariants 6 and 7
now states what I measure. The four throw sites are real and correctly attributed (§1.4). The
"a sentinel covers two of four" justification does not survive measurement — finding 1. It
does not change the ruling, which stands on the bounded-guarantee argument beside it.

### F-255 — **ADDRESSED**

Stated as residual 2 on `MAX_ERROR_SCAN_DEPTH`, in `isWalkable`'s own docblock next to the
reason it existed without a consequence, and in the contract's "The residuals" with the
emitted line and the same escalation rule as depth 5. That is what the finding asked for and
it asked for no behaviour change.

### F-256 — **ADDRESSED**

Ordinal 15 (`logger.error({ error: chained }, …)`) is built through the walk, which is the
mechanism the finding said ordinal 9 never reaches, and it asserts `Object.keys` equality
against the policy fields so a `cause` appearing at all reddens it. Ordinal 9 is kept and its
comment now says correctly what it locks — `errorLogFields`' non-descent, which the test
architect's own mutation showed is worth locking because `pino-std-serializers` does follow
`cause`. Both auditors' results are recorded rather than one overwriting the other.

### F-258 — **ADDRESSED**

Wrapped identically, and the depth-1 scan hoisted into `bindingsScanned` so the two paths
cannot drift — which is the M17 failure mode removed structurally rather than commented. The
seam on this path was verified by running the module rather than reasoned across from `child`,
and the two paths genuinely do differ in how they treat the bindings formatter, so that care
was warranted. `setBindings` mutating the singleton's chindings permanently
(`proto.js:189-192`) makes it the more exposed door of the two, not the lesser.

### F-250 — **ADDRESSED**

ADR-0022's fenced literal is gone rather than synced, replaced by a dated amendment that names
`logging-and-headers.md` as the single normative source and says it wins any disagreement.
`grep` finds no `pino({` in the ADR. The stub keeps its superseded banner and now names five
mechanisms. One stale sentence survives elsewhere in the ADR — finding 4.

### F-259 — **CONFIRMED OPEN, unfixed, and reproduced**

`logger.error(hostileRecordWithAnErrorUnderAnotherKey, 'ctx')` throws with
`at errorsReplaced (apps/api/src/observability/logger.ts:398)` as the frame directly under the
getter — the spread re-invoking it outside the guard, exactly as filed. `readIndexedProperty`'s
docblock still says the scan "leaves pino's own stringify to handle it exactly as it did
before this function existed", which is true of the observable outcome and false of the throw
site. Correctly scoped as a wrong claim rather than a regression; the contract's F-253 table
already records this as row 2 and does not repeat the docblock's error.

---

## Cannot verify from diff

- **The 609 ns / 581 ns and 1136 ns / 1143 ns wrapper costs.** I did not re-run the
  benchmarks. The shape is not in doubt — the scan on a one-key flat binding is the 40 ns
  already measured, and the exception filter is the only creator of children — and GC-1's
  25 ms ceiling is six orders of magnitude away either way.
- **The mutation counts in the F-254 docblock** (12 / 6 / 1). I did not re-run the three
  mutations; the docblock now says the counts move as tests are added and that the shape is
  what matters, which is the right hedge.
- **body-parser 2.3.0 assigning the verbatim body to `err.body`.** Still nobody in this chain
  has run body-parser itself; every reproduction including mine uses a hand-built error.
  Carried forward from r3 unchanged.
- **F-243 clause 2 (helmet / HSTS).** Still marked "Not true today" against invariant 4 and
  still unowned. Outside this diff.
- **Whether `.sdlc/` is present in every environment `pnpm test` runs in.** The new drift spec
  reads `../../../../.sdlc/launch-core/design/contracts/logging-and-headers.md` from
  `apps/api/src/observability/`. It resolves in this working tree and the contract is
  committed, so a clean clone is fine (ADR-0001). A CI job or container that checks out only
  `apps/**` would fail collection on the whole file. I have no visibility into the CI
  checkout shape from this diff.
- **TASK-003's `paths` front-matter still does not list `apps/api/src/observability/**`**, so
  the new spec file is outside the declared paths the same way `logger.ts` already was. The
  reason is documented in `logger.ts`'s header note and was accepted in an earlier round; the
  new file inherits it silently. Orchestrator's call, not mine.

---

## Notes

- **GC-9 lens.** Three doors onto the same payload closed this round (`child`, `setBindings`,
  `msg` on a record). I went looking for a fourth and did not find one: no pino-internal call
  reaches `asChindings` except through those two methods, and no record shape derives `msg`
  from `err` past the new predicate. The residuals that remain — depth 5, class instances —
  are stated in the source, in the contract and under one escalation rule.
- **GC-1 lens.** No concern. The redirect hot path imports nothing from this module; the
  exception filter's per-request child now scans one flat key.
- **GC-4.** No AI attribution in any of the eight commit subjects, bodies or trailers.
- **GC-11.** Code from `sdlc-implementer-backend`, tests from `sdlc-test-architect`,
  `design/**` from `sdlc-architect`, per the reports and the commit sequence. Nothing suggests
  a main-loop edit; the spec file is byte-identical to its red commit in both green steps.
- **One behaviour change worth recording that is not a finding.** The hook's proxy for pino's
  `msg === undefined` is `typeof context !== 'string'`, so a second argument that is neither a
  string nor `undefined` is discarded and replaced by the fixed context string —
  `logger.error({ err: e }, 42)` emits `"msg":"an error was logged with no context string"`
  where bare pino emits `"msg":42`. This was already true of the positional branch before this
  diff; the second branch extends it to records. Also `logger.error({ err: 'ECONNRESET' })` now
  gets the fixed string where pino emitted no `msg` at all, because a truthy non-object under
  `err` satisfies the predicate but has no `.message`. Both are harmless — the line already
  reads as an error, since `serializers.err` has reduced the value to
  `non-error throwable (string)` — and neither is worth narrowing the predicate for. Recorded
  so the next reader of the six-row table knows the two rows it does not have.
- **What I would not want lost in a rework round.** The implementer disclosing `setBindings`
  against its own just-shipped fix rather than staying quiet, and refusing to write the wrapper
  until a red existed, is the same discipline that saved round 2. The test architect refusing
  the architect's reference stripper after finding it gives a false green on whitespace inside
  string literals — the payload class the redact paths themselves live in — caught a defect in
  the tool that was about to be used as evidence. And hoisting the depth into `bindingsScanned`
  turned a documented trap into an unrepresentable one.
- **The pattern this TASK keeps producing.** Four rounds running, the defect has been a
  document making an absolute claim the code does not support: F-249's stale literal, F-254's
  partition claim, r3's invariant 6, F-259's docblock, and now finding 1. The drift test closes
  the artifact-to-artifact half of that and, as its author says plainly, closes nothing about
  whether either artifact is true. The emitted-bytes suite is still the only thing that checks
  the second half, and prose invariants are outside both.
