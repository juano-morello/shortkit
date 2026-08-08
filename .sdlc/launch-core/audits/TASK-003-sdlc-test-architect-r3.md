# TASK-003 — verdict on the F-248 tests (round 3)

- **Owner slot:** `sdlc-test-architect`
- **Round:** 3 (verdict-only, following `TASK-003-fix-r2-report.md`)
- **Date:** 2026-08-08
- **Mode:** judgement. **No production code written, no test added, nothing fixed.**
- **Verdict on F-248: ADDRESSED.** The two new tests defend the property, on emitted bytes,
  and both are mutation-proven to fail for the right reason.
- **Two gaps found**, neither of which invalidates the verdict. One is major (§4.4), one is
  minor (§6).

```
sha256 apps/api/src/observability/logger.ts
  BEFORE: e2d6f71d3ca6886f38a2adfcc5b1b2ec7d328c290c6c9d0c17d5c907669cb7ad
  AFTER : e2d6f71d3ca6886f38a2adfcc5b1b2ec7d328c290c6c9d0c17d5c907669cb7ad
```

`logger.spec.ts` sha256 `bf0f8122b32126f80b106b82af44d80d48e249ea144138713773329e1504354c`,
unchanged. `git status --short` empty at start and at end. Ten mutations were applied and
reverted; the harness restores from a pristine copy on every exit path and prints the hash
after each run, and every one printed `MATCHES`.

Baseline before any mutation: `npx vitest run apps/api/src/observability/logger.spec.ts` →
**11 passed**. Full unit suite at the end → **79 passed, 6 failed**, the six being TASK-008's
`apps/web/src/lib/api/client.spec.ts` `not implemented` reds. No status changed.

---

## 1. Do the new tests assert on emitted bytes, or on configuration?

**On bytes. PASS.**

Both new tests read only `lines[ordinal].raw` and `lines[ordinal].record`, and `lines` is
built in `beforeAll` from the stdout of a spawned Node process that imports the shipped
module by its real path (`new URL('./logger.ts', import.meta.url)`). Nothing in the file
reads `logger.options`, `logger.symbols`, `serializers`, `formatters` or any other
configuration surface — I grepped the spec for all of them and there is no such read.

The standard set in round 2 therefore holds unchanged. This is not merely an inspection
result: it is corroborated by the mutations. M6, M7 and M8 are all *configuration* edits, and
every one of them surfaced as an assertion failure printing the leaked bytes — e.g. M6:

```
AssertionError: expected '{"level":"error","time":"2026-08-08T2…' not to contain 'hunter2-raw-request-body-marker'
Received: "{"level":"error",…,"error":{"body":"{\"email\":\"a@b.test\",\"password\":
          \"hunter2-raw-request-body-marker\"","status":400,…},"msg":"the same error under the error key"}"
```

A configuration-reading test would have failed with a shape mismatch and no payload. This one
prints F-244's credential verbatim, which is the failure report an operator can act on.

Neither test is vacuous. `beforeAll` throws if the emitter exits non-zero, writes to stderr,
or produces a line count other than `EXPECTED_LINE_COUNT` (now 10, derived from `LINE` rather
than hardcoded). If the F-248 keys were absent from a record, `read(...)` returns `undefined`
and `fields.err_name` throws — a failure, not a silent pass.

---

## 2. The mutations

Harness: `scratchpad/mutate.py`. Each entry edits `logger.ts` by exact-anchor replacement,
runs the spec file alone, then restores from `logger.ts.pristine` in a `finally` and compares
sha256. Anchor-not-found aborts without running, so no mutation can silently no-op.

| # | Mutation to `logger.ts` | Result | Tests red |
| --- | --- | --- | --- |
| M6 | `formatters.log` line deleted | 1 failed, 10 passed | F-248 shapes only |
| M7 | `serializers: { err: … }` deleted | **9 failed**, 2 passed | 7 frozen + both new |
| M8 | the `depth === 1 && key === ERROR_KEY` skip deleted | 4 failed, 7 passed | frozen 4, 6, 8 + F-248 cause |
| M9 | `errorLogFields` emits `err_cause: thrown.cause` raw | 1 failed, 10 passed | F-248 cause only |
| M9b | `errorLogFields` emits `err_cause: String(thrown.cause)` | 1 failed, 10 passed | F-248 cause only |
| M9c | `errorLogFields` emits `err_cause` through the same policy | **0 failed** | — (correct, §3) |
| M10-depth3 | `MAX_ERROR_SCAN_DEPTH` 4 → 3 | **0 failed** | — (gap, §6) |
| M10-depth2 | `MAX_ERROR_SCAN_DEPTH` 4 → 2 | **0 failed** | — (gap, §6) |
| M10-depth1 | `MAX_ERROR_SCAN_DEPTH` 4 → 1 | 1 failed, 10 passed | F-248 shapes only |
| M10-depth99 | `MAX_ERROR_SCAN_DEPTH` 4 → 99 | 0 failed | — (correct, §6) |
| M12 | M7 **and** M8 together — the rejected alternative design | **0 failed** | — (**gap, §4.4**) |

No mutation produced a load error, a transpile error, a missing fixture or a harness abort.
Every red above is an assertion failure with the offending value printed in it.

**M6 — the fix mechanism is load-bearing and its removal is caught.** Deleting
`formatters.log` restores F-248 exactly: the F-248 shapes test goes red, alone, with the raw
request body in the received line under the `error` key. The nine frozen tests all stay green,
which is the correct partition behaviour — they address the top-level `err` key, which the
formatter does not own.

**M7 — `serializers.err` is load-bearing and its removal is caught.** Nine of eleven go red.
The two survivors are correct: the top-level-secrets test exercises `REDACT_PATHS`, an
untouched mechanism, and the F-248 shapes test exercises the formatter, also untouched.

**M8 — the seam is defended, and it fails exactly as the implementer predicted.** Removing
the skip lets the formatter replace the top-level `err`, `serializers.err` then receives a
plain object, and four tests go red with

```
expected 'non-error throwable (object)' to be 'SyntaxError'
```

The implementer's §1.2 named frozen tests 4 and 6 as the ones that would break. Measured, it
is those two plus frozen test 8 and the new cause test — a superset, so the claim holds and
was conservative.

---

## 3. Is the `err.cause` test a real guard, or a test that cannot fail?

**A real guard. It fails under three independent mutations, and one of them reframes the
test's value upward from what the implementer claimed.**

The implementer defended it as a regression guard on a property that already held, which
would fail "if a later edit improves the walk by following `cause`". M9 is precisely that
edit — `errorLogFields` gains a `cause` field — and it isolates the test perfectly:

```
M9:  Tests  1 failed | 10 passed (11)
  × F-248: an error reached only through `err.cause` is still not walked into
    → expected '…' not to contain 'hunter2-raw-request-body-marker'
```

M9b, the same edit via `String(thrown.cause)` rather than the raw object, also isolates it,
red on the message marker instead. So the test is the **only** thing in the suite standing
between a plausible "improve the error serialiser" edit and F-244's payload returning through
a chained error. That settles the question the dispatch asked: it is not a test that cannot
fail.

**M7 is the more interesting result, and it corrects the implementer's own framing.** The
implementer wrote that the property "already held" because `cause` is non-enumerable and
nothing walked it. That reasoning is incomplete. Delete `serializers.err` and pino's *default*
`err` serialiser takes the key — and pino-std-serializers **does follow `cause`**, appending
the chained error to the stack:

```
"err":{"type":"Error","message":"a wrapper around the parse failure: Unexpected token } in JSON
at position 41, sk_live-inside-the-message-marker","stack":"Error: a wrapper around the parse
failure\n    at …\ncaused by: SyntaxError: Unexpected token } in JSON at position 41,
sk_live-inside-the-message-marker\n    at …"}
```

So the property does not hold by accident of non-enumerability. It holds **because** the
custom serialiser replaced an upstream default that walks `cause`. The test is therefore a
characterization test on surprising upstream behaviour — exactly the case `writing-good-tests.md`
says earns one ("when upstream behavior genuinely surprised you, write one narrow
characterization test naming the assumption"). It is worth more than the implementer claimed
for it, and its comment currently understates the mechanism.

**M9c is the boundary, and its greenness is correct, not a gap.** A `cause` walk that routes
the chained error through the same policy (`errorLogFields(thrown.cause, options)`) leaves all
eleven green. That is right: such a walk emits `err_name` and `err_stack` for the cause and
leaks nothing. The test guards the *leak*, not the *structure* — it does not fire on a design
change that preserves the property. That is the asymmetry `writing-good-tests.md` demands, and
this test has it.

---

## 4. Coverage of the claimed partition

### 4.1 Removing `formatters.log` breaks something — YES (M6, uniquely the F-248 shapes test)
### 4.2 Removing `serializers.err` breaks something else — YES (M7, nine tests)
### 4.3 Moving the seam breaks something — YES (M8, four tests)

The two halves are each independently pinned, and the seam between them is pinned too. On the
dispatch's literal question, the partition is covered.

### 4.4 GAP (major): striking BOTH halves at once passes all eleven tests

The implementer's §1.2 states the alternative it rejected: *"dropping `serializers.err` and
doing everything in the formatter — rejected because it loses the non-error-under-`err`
coverage that exists today."* That is a design decision with a stated safety reason, and
**nothing in the suite defends it.**

M12 applies exactly that alternative (delete `serializers.err`, delete the depth-1 `err`
skip). Result: **11 passed, 0 failed.** Every gate green.

And it is not a harmless refactor. Under M12 the arm the implementer said would be lost is
lost, verbatim:

```
logger.error({ err: { body: 'nonerror-BODYMARK', password: 'p' } }, '…')

  shipped : {"err":{"err_name":"non-error throwable (object)"},"msg":"…"}
  under M12: {"err":{"body":"nonerror-BODYMARK","password":"[redacted]"},"msg":"…"}
```

The `body` leaks in full. `password` happens to be censored only because `*.password` is in
`REDACT_PATHS` — a named-field defence, which is the exact mechanism F-244 rejected as
insufficient. A non-`Error` under `err` is not exotic: `catch (err) { logger.error({ err }, …) }`
is the single most idiomatic shape in the codebase, `err` is `unknown` in a catch clause, and
a library throwing a plain object with a `body` on it is precisely F-244's own scenario minus
the `Error` prototype.

**Why this matters more than the sum of M6 and M7.** Collapsing two mechanisms that "do the
same thing" into one is the most likely refactor a future reviewer proposes, and it is the one
the implementer explicitly asked reviewers to try to break ("look hardest at the partition in
§1.2"). The suite catches each half being deleted in isolation — which nobody would do — and
sleeps through the coherent-looking simplification that actually ships.

**What is missing:** one emitter line and one assertion. There is no `logger.error({ err: <non-Error> })`
call anywhere in `emitterSource`, so the arm has no coverage at all. The needed test is
"F-248: a non-Error under the top-level `err` key is still reduced to policy fields", asserting
the raw line does not contain the marker and `err.err_name` is `'non-error throwable (object)'`.
It would be green today and red under M12.

**Severity: major.** Not a defect in shipped code — the shipped behaviour is correct — but an
undefended load-bearing property that both `logger.ts`'s docblock and F-248's ruling assert as
the reason the current design was chosen over the alternative. `logger.ts:195-197` claims
"there is no key between them. Removing either half reopens F-244 or F-248, and
`logger.spec.ts` fails on each." That is true for *either*, and false for *both*.

**I did not write this test.** The dispatch was verdict-only and instructed me not to add
tests without a follow-up. `logger.spec.ts` is a file I own, so I can add it on request.

---

## 5. Were the nine frozen tests edited, renamed or weakened?

**No. Verified against git rather than accepted.**

`git diff 89b5021 f47553a -- apps/api/src/observability/logger.spec.ts` contains **zero
deletion lines**. It is purely additive, in exactly three places, and matches the
implementer's claim to the line:

- four ordinals appended to `LINE` (`frameworkErrorUnderErrorKey: 6` … `errorChainedThroughCause: 9`);
  ordinals `0`–`5` are context lines in the hunk, unmodified;
- four `logger.error(…)` calls appended to the end of `emitterSource`, after the ordinal-5
  hostile-accessor block;
- two `it` blocks appended after the existing nine, inside the same `describe`.

No frozen test name, body, marker constant, helper or assertion was touched. `EXPECTED_LINE_COUNT`
is derived from `Object.keys(LINE).length`, so it tracked the addition without an edit. Because
ordinals 0–5 are unchanged, every frozen test still addresses the line it addressed before —
which is the property the ordinal-not-`msg` addressing scheme was chosen for.

Corroborated behaviourally: M7 reproduces round 2's M1 result on the frozen set (the same
seven frozen tests red, the top-level-secrets test green), which it could not do if the frozen
tests had been weakened.

---

## 6. The depth-5 residual — recommendation

**Measured first.** Against the shipped module:

```
{…,"a":{"b":{"c":{"err":{"err_name":"SyntaxError","err_stack":"    at …"}}}},"msg":"depth 4"}
{…,"a":{"b":{"c":{"d":{"err":{"body":"body-BODYMARK"}}}}},"msg":"depth 5"}
```

Depth 4 is replaced; depth 5 leaks. The residual is real and correctly documented.

**The bound is not pinned where the source says it is.** M10 shows `MAX_ERROR_SCAN_DEPTH` can
be changed from 4 to **3 or 2 with every test green**, and to 99 with every test green. Only
1 goes red. The deepest error the emitter builds is `{ ctx: { err: e } }` at depth 2, so the
suite defends "at least 2" while `logger.ts:155-174` documents and argues for 4.

**Recommendation: add one test, and only the positive half.**

- **Add:** an error at **depth 4 is still replaced**. This is the floor of the guarantee the
  module documents. It goes red if someone silently narrows the bound to 2 or 3 — a real
  reduction in a security control, shipped green today — and stays green if someone widens it.
- **Do not add:** any test asserting that depth 5 **leaks**. That is a change detector pointed
  in the worst possible direction. It encodes the absence of protection as a requirement, so it
  fires red on a security *improvement* (raising the bound) and catches no bug ever. By
  `writing-good-tests.md` — "if only intentional decisions can fail a test… it fires on redesign
  and sleeps through bugs" — and by its warning sign "asserts a removed symbol stays removed",
  that test is exactly the shape to refuse.

This asymmetry is the whole answer to the dispatch's either/or: pinning the bound as a *floor*
is behaviour, pinning it as an *exact value* (or pinning the residual) is a change detector.
`expect(MAX_ERROR_SCAN_DEPTH).toBe(4)` is likewise refused.

Cost: one line in `emitterSource`, one `LINE` ordinal, one `it` block. It is green today.

**Severity: minor.** The documented guarantee exceeds the tested guarantee by two levels, but
no current call site builds a record deeper than flat, so nothing ships broken.

---

## 7. Verdict

**F-248: ADDRESSED.**

Grounded in the mutations, not in the code reading:

- The defect is reproduced by the suite. M6 removes the fix and the F-248 shapes test goes red
  alone, printing `hunter2-raw-request-body-marker` under the `error` key — F-248's failure
  scenario verbatim.
- The fix is covered on emitted bytes at all three shapes the finding named (`{ error: e }`,
  `{ cause: e }`, `{ ctx: { err: e } }`), each asserted both for absence of the leak in the raw
  line and for retained diagnostic value (`err_name` present, no field outside the three the
  policy builds) — so a "fix" that logged nothing would not satisfy it.
- The `err.cause` test is a genuine guard, red under three separate realistic mutations and
  correctly green under a policy-preserving one.
- The nine frozen tests are provably untouched.

Two gaps remain, neither of which is F-248 returning:

| Gap | Severity | Owner |
| --- | --- | --- |
| The rejected alternative design (drop `serializers.err` + drop the seam) passes all 11 tests and leaks a non-`Error` under `err` verbatim | major | `sdlc-test-architect` — one test in `logger.spec.ts` |
| The depth bound is documented as 4 and defended only at 2; lowering it to 2 or 3 is silent | minor | `sdlc-test-architect` — one test in `logger.spec.ts` |

Both are additions to a file I own and both are green-today tests, so neither needs an
implementer. Awaiting routing.

---

## 8. What I did not do

- **No test was written, changed, weakened or deleted this round.** `logger.spec.ts` is
  byte-identical to HEAD (`bf0f8122…`).
- **No production code was written.** `logger.ts` is byte-identical to HEAD (`e2d6f71d…`),
  verified after all ten mutations.
- **Nothing was committed or staged.** `git status --short` is empty.
- **`pnpm test:integration`, `typecheck`, `lint` and `build` were not run.** This round changed
  no file, so re-running them would measure the implementer's round, not mine. The full unit
  suite was run once to confirm the tree is where the implementer left it: 79 passed, 6 failed,
  the six being TASK-008's pre-existing `not implemented` reds.
- **`tenant-context.ts:247`** (the implementer's §6 note, `error.message` interpolated into a
  log message string) was not assessed. It is outside F-248 and needs a finding of its own; I
  am not raising it here because I have not measured it.
