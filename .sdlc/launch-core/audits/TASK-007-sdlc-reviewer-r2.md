# TASK-007 scoped re-review — round 2 (fix diff `c53275b..8c8641e`)

> Returned inline by `sdlc-reviewer` (no Write tool) and persisted verbatim by the
> orchestrator on 2026-08-05. Scope: the fix diff only.

Reviewed the fix diff `c53275b..8c8641e` against the amended `error-envelope.md`, ADR-0026, ADR-0024's reversal block, the Global Constraints table, and my own round-1 report — reading each changed production file whole at HEAD (`fd950f9`), not as hunks. Gates not re-run, per dispatch. I re-verified the three empirical claims the F-086 amendment rests on against the installed zod 4.4.3 rather than accepting them (probe output in Notes).

```yaml
verdict: changes-requested
findings:
  - severity: major
    kind: contract
    file: .sdlc/launch-core/design/contracts/error-envelope.md
    line: 192
    summary: >-
      The F-093 fix removed the stack from the filter's log line, but the normative contract
      still states twice that it goes to the log — at :192 ("Its name, message and stack go to
      the log at `error`") and at :398, under "What the implementer must guarantee" ("...
      `INTERNAL_ERROR_MESSAGE` and the stack in the log only"). The architect amended this same
      file in this same round and did not touch either line.
    failure_scenario: >-
      Concrete and named. TASK-003's `paths` gained `apps/api/src/common/errors/**` in this diff
      (tasks/TASK-003.md:9, F-090 ruling) and its brief is explicitly "the pino swap in
      exception-filter.ts is now this TASK's". Its implementer writes the pino error serialiser,
      reads the normative contract for what the 500 line must carry, finds "name, message and
      stack" in the branch-4 paragraph and "the stack in the log only" in the guarantee list,
      and restores `exception.stack` — reintroducing exactly what F-093 removed, in the one file
      F-093 was filed about. No test can catch it (the suite asserts bodies, not log fields), and
      the only artifact recording the opposite is a code comment in the file being rewritten plus
      a ledger entry. This is the artifact-contradicts-artifact class the round existed to close:
      F-093 asked to "make the two files agree and record which way", and the way was recorded in
      the two least durable places while the normative source kept saying the reverse. ADR-0024's
      follow-up list ("TASK-003's logger gets ... message, stack") compounds it, though that one
      reads as a description of TASK-003's future line and is defensible as written.
    required_change: >-
      `error-envelope.md` must state what the filter actually does today and who owns the change:
      name and message reach the log, the stack does not, and TASK-003's pino error serialiser is
      the permanent answer. Both :192 and :398. If Juano's ruling is instead that TASK-003 should
      restore the stack, the contract should say that explicitly with the F-064/F-093 reasoning
      attached, so the next reader does not have to reconstruct which of two artifacts is current.
      Cheapest resolution is to bundle it with F-105, which is the same defect one file over.

  - severity: minor
    kind: behavior
    file: apps/api/src/common/errors/exception-filter.ts
    line: 111
    summary: >-
      The F-092 guard is asserted by no test, so a future edit deletes it with all 61 green — the
      implementer verified it with a throwaway probe and deleted the probe.
    failure_scenario: >-
      I confirmed the gap: nothing in `exception-filter.spec.ts` throws a value that makes
      `resolve` or the write step throw. Removing the `try`/`catch` from `catch()` and inlining
      `this.write(...)` leaves every test passing. The behaviour it protects is the one the
      finding called load-bearing — a marker-carrying object with no `toEnvelope` (SEC-8) and a
      header value Node rejects both escape into finalhandler, which writes `err.stack` into the
      body whenever NODE_ENV is not production. Same shape as F-088/F-089 and the same owner.
    required_change: >-
      Two tests over a real round trip, in the style the implementer's deleted probe already
      proved passes: a throw whose `headers` carry a CRLF value answers 500 `internal_error`
      with a valid envelope and no injected header; a marker-carrying object without
      `toEnvelope` answers the same. Deferred minor — it does not extend this loop.

  - severity: minor
    kind: behavior
    file: apps/api/src/common/errors/exception-filter.ts
    line: 210
    summary: >-
      The 400 arm now sends the framework's message to the log at `error` level, and that message
      is built from raw request bytes — the same unredactable-field argument the round used to
      remove the stack, applied in the opposite direction in the same commit.
    failure_scenario: >-
      `logError('framework exception with a 400 status', exception)` was added by this diff; the
      arm previously logged nothing. The message on that arm is Nest's
      `BadRequestException(err.message)` over Node's `JSON.parse` text, which the contract itself
      quotes as `Unexpected token '}', ..."ciOi","x":}" is not valid JSON` — the caller's own
      bearer-token fragment, now at `error` level on every malformed body. ADR-0022 redacts by
      path and no path reaches inside a message string, which is precisely why F-093 pulled the
      stack out one method below. GC-9 says no PII in log bodies; ADR-0026 decided the message
      "goes to the log" without weighing that clause, while its `details` rule three paragraphs
      away says "a log is not a safe place to put it (GC-9)". Secondary: `error` level for a
      client-caused 400 gives an unauthenticated caller a log-flood lever.
    required_change: >-
      Either the contract states that the framework-400 message in the log is an accepted GC-9
      exception with the reasoning, or the arm logs at `warn`/`debug` without the message body.
      Overlaps sdlc-security-auditor's territory; filed because it is a policy contradiction
      introduced by this diff, not because the class is new. Deferred minor.

  - severity: nit
    kind: implementation
    file: packages/contracts/src/errors.ts
    line: 185
    summary: >-
      The truncation notice is appended after the per-key cap has already been applied, so
      `_form` can end with MAX_MESSAGES_PER_FIELD + 1 messages.
    failure_scenario: >-
      Eleven root `.refine()` failures on one schema: the first ten fill `_form`, the eleventh
      sets `truncated` without pushing, then the tail block finds `_form` non-empty and pushes
      the notice — `_form` has 11 entries. The contract's wording is "at most 10 messages land
      under one key, and if anything was dropped VALIDATION_TRUNCATED_MESSAGE is appended under
      FORM_ERROR_KEY", which reads both ways. Bounded overflow of exactly one string; no harm,
      no amplification. Recorded so the next reader of the cap does not treat it as a hard bound.
    required_change: >-
      Nothing needed unless the bound is meant to be hard. If it is, the notice replaces the
      last message rather than extending past the cap, and the contract says which.

  - severity: nit
    kind: implementation
    file: apps/api/src/common/errors/exception-filter.ts
    line: 129
    summary: >-
      Headers written before the failure survive onto the last-resort 500, so a body can carry a
      `Retry-After` that belongs to a 429 that never happened.
    failure_scenario: >-
      A `DomainError` with `headers: { 'Retry-After': '30', 'X-Trace': 'bad\nvalue' }`. The loop
      sets `Retry-After`, `setHeader` throws ERR_INVALID_CHAR on the second, the guard answers
      500 `internal_error` — with `Retry-After: 30` still on the response. `headersSent` is false
      at that point so nothing is corrupt on the wire, and invariant 7 constrains 429s rather
      than forbidding the header elsewhere. Cosmetic.
    required_change: >-
      None required. If wanted, the guard could `removeHeader` what the loop set, which costs a
      fifth member on HttpResponseLike and is not obviously worth it.
```

## Verdicts you asked for

**F-086 — ADDRESSED, and the amendment was right.** I re-ran all three of its empirical claims against the installed zod 4.4.3 rather than taking the ledger's word:

- `z.record(z.string(), z.string()).safeParse(JSON.parse('{"__proto__": 2}'))` → **success, zero issues**; the same schema over `constructor`, `toString` and `hasOwnProperty` yields `[["constructor"]]`, `[["toString"]]`, `[["hasOwnProperty"]]`. So my `__proto__` clause was unreachable through a real record parse, and asserting it would have required a hand-rolled issue array. The amendment is correct to strike it.
- A raw `Map` under `fieldErrors`: `validationDetailsContract.safeParse` → `false`, and `JSON.stringify` → `{"fieldErrors":{}}`. The amendment is correct that "or a Map" without the drain is the phrasing that ships an empty body. My "drained at the end" wording is what the shipped code does.
- `Object.fromEntries([['__proto__', ['b']], ...])` keeps `__proto__` as an own, JSON-visible key with `Object.prototype` intact — the in-file comment's claim holds.

The fix itself is the corrected stub byte for byte (I diffed the stub's function body against `packages/contracts/src/errors.ts` — identical), so F-087's durability half holds too: the artifact that would restore the defect no longer carries it.

One consequence worth stating because it crosses two fixes and nobody asserted it: I checked that `narrowEnvelope` does **not** undo F-086. A `fieldErrors` object with own keys `constructor`, `toString`, `ok` parses successfully through `validationDetailsContract` and all three survive into `parsed.data`; the output object has a null prototype and `JSON.stringify` handles it (`{"fieldErrors":{"constructor":["a"],"toString":["c"],"ok":["d"]}}`). Only `__proto__` is dropped by zod's record, which ADR-0026 records as an accepted cost. So the tested surface of F-086 survives the new narrowing step, and the untested `__proto__` surface is documented as lost either way.

**F-092 — ADDRESSED.** `catch()` now wraps classify-headers-write, logs the secondary failure, ends the response when `headersSent` flipped, and otherwise answers 500 `internal_error` through `errorResponse` with no `details` — exactly the required change, and no fifth branch in the normative table. `write()` as a private method is a readability choice with no behaviour on it; fine. **One layer is the right call and I would not accept a second.** The last-resort body is two string literals through a function that reads one table entry, and `res.json` on it cannot realistically throw; a third nesting is depth with no failure behind it. Two sub-items, both filed above rather than against the depth judgement: no test asserts the guard, and the guard leaves partial headers in place.

One ordering detail the implementer did not mention and I would not file: `this.logError(...)` runs **before** the write in the catch block, so a throw inside `logError` (an `Error` subclass with a throwing `message` getter) loses the response entirely. That is a narrower path than the ones the guard was built for and reordering it costs nothing if it is ever touched.

**F-073 — closure holds.** Every body in the fixed file is still built by `errorResponse()`, including the new last-resort path at :129, and the new `narrowEnvelope` step reads no status table at all — it copies `code` and `message` through and never re-derives a status. The two `ERROR_CODE_STATUS` reads at :201 and :205 still compare an incoming framework status rather than derive one. No second lookup appeared.

**F-082 — closure holds, unchanged by this diff.** Nothing in the range touches the body-parser path or the branch-4 fall-through, and my round-1 mechanism (a `PayloadTooLargeError` is not an `HttpException`, so it lands in branch 4 and answers 500 with a valid envelope) is unaffected. The new `http-exception-unmapped-status` test does not exercise that path — it throws `new HttpException(msg, 413)` from a controller, which is branch 3's fallback arm, not the real 413 — but both arms answer 500 `internal_error` with a valid envelope, so the closure is untouched. See Notes for the test-comment nuance.

**F-093 — ADDRESSED in code, and it created the major above.** `logError` no longer passes `exception.stack`, matching `main.ts`'s F-064 policy, and the method's docblock records the reasoning and names TASK-003. That is the dispatched direction and I am not re-arguing it. The consequence — a 500 logs no stack until TASK-003 lands — is real, correctly disclosed in §3 of the impl report, and is the accepted cost of consistency. What is not acceptable is that the normative contract still instructs the opposite in two places; that is the finding, and it is about the artifact, not the direction.

**F-094 code half — ADDRESSED.** `FRAMEWORK_BAD_REQUEST_FORM_MESSAGE = 'The request could not be parsed.'` matches the contract's pinned value exactly, the `HttpException` message no longer reaches the body on any arm, and keeping the constant module-private is right for the reason given: the frozen spec hand-copies the literal, and exporting it would invite a test that asserts the code against itself.

**F-095 code half — ADDRESSED.** Caps and the truncation notice are the stub's and the contract's, and the two boundaries that matter are right: the over-cap flag is computed from `issues.length` *before* the slice, so an over-cap error is marked truncated even when every read issue lands under a distinct key; and `messages.length < MAX_MESSAGES_PER_FIELD` before the push makes exactly 10 not-truncated and 11 truncated. One nit above about `_form` reaching 11.

**F-096 — ADDRESSED**, and reviewed as new code rather than as a fix. `narrowEnvelope` implements the contract's four-row table exactly, and the load-bearing half — returning `parsed.data` rather than the input, so `z.object` strips a sibling key — is the part that is easy to get wrong and is correct here. Applying it once in `write()` rather than inside `toEnvelope()` is the right placement for the stated reason (a feature-directory subclass can override `toEnvelope`, and branches 2 to 4 never call it). Three things I checked specifically as new code, all clean: the drop-warn logs the code and never the value; `details === undefined` returns the envelope by identity, so the common path allocates nothing; and evaluation order in `response.status(outcome.status).json(this.narrow(outcome.body))` means a throw inside `narrow` leaves the status set but nothing sent, and the guard overwrites it. `narrowEnvelope` importing `validationDetailsContract` is a schema object, not zod — ADR-0025 holds.

**F-105 — CONFIRMED, not disputed.** `exception-filter.ts:23` still reads "Name, message and stack go to the log and stop there" while `logError` at :233 logs name and message only, with a docblock at :226 explaining why. It is a nit as filed, and I would resolve it in the same pass as the major above, since they are the same contradiction at two levels of the same decision.

## Verdicts on the three items the implementer flagged itself

1. **The exported cap constants are correct, not speculative surface.** `error-envelope.md:68-70` declares them `export declare const` in the Normative types section, which makes them contract surface; not exporting them would have been the divergence. The implementer's hedge ("the fix is three keywords") should be declined. Nothing importing them yet is expected — the frozen spec deliberately writes the literals so a missing export cannot fail the file at load, and `apps/web` rendering a `_form` list is a real future reader. They add no runtime surface: three declarations through the existing `export * from './errors'`, no subpath, `sideEffects: false` intact.
2. **One-layer guard: correct.** Reasoning above. The gap worth acting on is the missing test, not the missing layer.
3. **No stack on a 500 until TASK-003: correct as dispatched, wrongly recorded.** See F-093 and the major.

## Cannot verify from diff

- **The F-092 guard's runtime behaviour.** The evidence is a probe the implementer ran and deleted, so no artifact in the repo demonstrates that a throw inside the filter is caught before Nest's error layer or finalhandler sees it. The code is correct by inspection and I have no reason to doubt the probe output, but it is unverifiable from the diff and unasserted by the suite — which is the minor filed above.
- **Whether TASK-003 restores the stack.** The whole F-093/F-105/major cluster resolves only when TASK-003's pino serialiser lands; nothing in TASK-007's paths can settle GC-9's `request_id` requirement on the 500 line.
- **The `__proto__`-via-`superRefine` path.** A future contract can set `path: ['__proto__']` by hand in a refinement, which real zod does not produce today. `toValidationDetails` keeps it as an own key and `narrowEnvelope` then drops it. ADR-0026 records exactly this as an accepted cost, so it is not a finding — but it is the one shape where the two fixes in this round disagree, and it is unreachable to verify from any code that exists.
- **Gates, bundle assertions, zod absence from `apps/api`, no test file touched** — per dispatch, taken from the orchestrator's verification, not re-run.

## Notes

- **Probe evidence.** Run against `packages/contracts` with the workspace's zod 4.4.3, node 24.19, nothing written to the repo (probe files created and removed in the same command; `git status` clean afterwards):

  ```
  {"__proto__": 2}      -> ok(no issues)
  {"constructor": 2}    -> [["constructor"]]
  {"toString": 2}       -> [["toString"]]
  {"hasOwnProperty": 2} -> [["hasOwnProperty"]]
  raw Map parses? false      raw Map stringify: {"fieldErrors":{}}
  parsed keys after narrowing: [ 'constructor', 'toString', 'ok' ]   (proto: [Object: null prototype])
  ```

- **The 413 test's comment is slightly off.** `http-exception-unmapped-status` throws `new HttpException(msg, 413)`, which takes branch 3's fallback arm, while a real body-parser 413 is a `PayloadTooLargeError` and takes branch 4. The comment reads as though the test covers the real 413 path. Both answer 500 `internal_error` with a valid envelope, so nothing about F-082's closure changes; a reader tracing "what happens to a 413" from this test will land one branch off. Worth a sentence in the comment whenever that file is next open — not worth a round.
- **What this round closed that I want on the record.** The two `details` tests were red and shipped `33333333-3333-4333-8333-333333333333` to the client before the fix, and the framework-400 test was red and shipped `ciOi`. Both are now green with the value absent from the raw body. That is the strongest evidence in the diff, and it is the test architect's `raw` assertion that produces it — a fixed-string assertion alone would not have.
- **Scope classification of my new findings**, as asked: the contract-divergence major is **new breakage introduced by these commits** and joins the open list. The three minors/nits (no guard test, framework-400 message in the log, `_form` overflow, leftover headers) are **deferred ledger items** and should not extend the loop; the guard test in particular belongs with F-088/F-089/F-104 in the next test dispatch.
- **Conventions.** The new code reads like its neighbours: comment density matches `domain-error.ts`, `narrowEnvelope` sits beside `errorResponse` in the file that already owns envelope construction, and the filter's header block was updated for ADR-0026 (which is what makes the one stale sentence at :23 stand out).
- No emoji, no attribution trailer in any of the eleven commits; subjects carry the TASK id on branch `feat/launch-core` (GC-4, GC-10 hold).

| Finding | Verdict |
|---|---|
| F-073 | ADDRESSED — closure holds in the fixed code |
| F-082 | ADDRESSED — closure holds, untouched by this diff |
| F-086 | ADDRESSED — amendment was right, all three claims re-verified |
| F-092 | ADDRESSED — one layer is correct; guard is untested (new minor) |
| F-093 | ADDRESSED in code — contract left contradicting it (new major) |
| F-094 (code half) | ADDRESSED |
| F-095 (code half) | ADDRESSED — one nit on the `_form` overflow |
| F-096 | ADDRESSED — `narrowEnvelope` reviewed as new code, clean |
| F-105 | CONFIRMED — still stale, same class as the new major |

**Verdict: CHANGES-REQUESTED** — on one new major, `error-envelope.md:192` and `:398`, whose fix is two sentences in one file and should be bundled with F-105. Every dispatched finding was addressed and the code half of this round is sound.
