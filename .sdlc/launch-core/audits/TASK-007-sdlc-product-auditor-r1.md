# TASK-007 Product Audit — AC-13, AC-14

> Returned inline by `sdlc-product-auditor` (it has no Write tool) and persisted
> verbatim by the orchestrator on 2026-08-05. Round 1. Review package:
> `.superpowers/sdd/TASK-007/review-453640c..4ea1067.diff`.

## Scope of what I verified

Read: `TASK-007.md`, `STORY-004.md`, `TASK-007-report.md`, `error-envelope.md`, `test-strategy.md`, `ADR-0024`/`ADR-0025`, `findings.yaml` (grepped, not fully — 2350+ lines), the full diff at `.superpowers/sdd/TASK-007/review-453640c..4ea1067.diff`, and the resulting source: `packages/contracts/src/errors.ts`, `packages/contracts/src/index.ts`, `apps/api/src/common/errors/{domain-error,exception-filter,error-envelope}.ts`, `apps/api/src/app.module.ts`, and all three spec files. Confirmed nothing has touched these files since `4ea1067` (`git log 4ea1067..HEAD` on those paths is empty). I did not re-run tests or the build, per instruction — the gate output in the report and `state.yaml`'s orchestrator-verification log entries are the evidence I relied on for "44/44 green."

## AC verification

```yaml
ac_verification:
  - id: AC-13
    status: partial
    evidence: >
      apps/api/src/common/errors/exception-filter.spec.ts (18 "it" defs, 22 assertions
      with it.each expansion) + apps/api/src/common/errors/domain-error.spec.ts (12
      tests), both booting real AppModule/HTTP or constructing real DomainError
      instances — not filter.catch() calls, not mocks. Tests genuinely assert AC-13's
      claim (envelope validity + stable code) for: unmapped throwable, 404
      HttpException, ZodError (single-field), DomainError (plain, with headers, with
      details, from a second module graph), and cause/secret exclusion.
    note: >
      Two branches the contract requires are shipped correctly by inspection but have
      zero test evidence, which per the audit standard ("code looks like it does that"
      is not verification) means AC-13 is not fully proven end to end. See findings
      F-AUD-1 and F-AUD-2 below.
  - id: AC-14
    status: untestable
    evidence: >
      test-strategy.md "Deliberately not automated" entry for AC-14; TASK-007-report.md
      §AC-14 judgement (not present, correctly out of TASK-007's coverage table).
      packages/contracts/src/index.ts:6-7 states "apps/web imports this source
      directly... that is what makes AC-14 true by construction."
    note: >
      Correctly not marked unmet — the documented reasoning (pnpm -r typecheck runs
      contracts first and would abort before apps/web compiles, so a naive exit-code
      check is weaker than the AC) is sound and I found no better alternative. But see
      F-AUD-3: this task changed the premise the reasoning rests on.
```

### AC-13 detail

Verified by direct inspection that the code satisfies what's tested, and that the tests assert what they claim (not proxies). Confirmed:

- `DomainError.status`/`toEnvelope()`/`isDomainError()` match ADR-0024's stub exactly (derived getter, never a constructor arg; marker read only after an indexability guard so `throw null` doesn't crash it — asserted by `domain-error.spec.ts::AC-13: rejects null rather than throwing on it`).
- `exception-filter.ts`'s branch order matches `error-envelope.md`'s table exactly (DomainError → ZodError → HttpException → anything else), headers written before body, `headersSent` short-circuits before body-writing.
- `errors.spec.ts` (9 tests, unchanged) never exercises `isZodError`/`toValidationDetails` directly — confirmed by reading the file; they're reached only transitively through the filter spec's single-issue zod fixture.

**Untested-but-shipped, found independently of what I was asked to check** (`apps/api/src/common/errors/exception-filter.ts:150-163`, `resolveHttpException`): the 400-`HttpException` sub-branch (`_form` field-error forwarding from `exception.message`) and the "any other status" 500-fallback sub-branch. `exception-filter.spec.ts`'s only `http-exception` probe throws `NotFoundException` (404). No probe throws a 400 or any other-status `HttpException`. Implementation reads correctly against the contract on inspection, but that's the "looks like it does that" standard the audit explicitly rejects as verification.

## Findings

```yaml
findings:
  - severity: major
    kind: test-coverage
    file: apps/api/src/common/errors/exception-filter.spec.ts
    summary: >
      Branch 3's 400 (`_form` forwarding) and "any other status" (500 fallback) arms
      of resolveHttpException have zero test coverage. Only the 404 sub-branch is
      exercised.
    failure_scenario: >
      A future edit to resolveHttpException — e.g. swapping exception.message for
      getResponse() incorrectly, or keying the field-error object wrong — regresses
      the 400 path silently. All 44 tests stay green. The first signal is a malformed
      request answering with an envelope validation clients can't render, discovered
      in production by whichever of the 14 downstream error-throwing TASKs hits it
      first.
    required_change: >
      Add a probe route throwing a 400 HttpException with a known message and a probe
      throwing an HttpException with an unmapped status (e.g. 403), and assert the
      _form key and the 500 fallback respectively. This is a test-file change, outside
      TASK-007's implementer authority (frozen tests) — route to Test-phase rework or
      record explicitly as an accepted residual gap in test-strategy.md, the way AC-14
      and AC-7 already are.

  - severity: major
    kind: test-coverage
    file: packages/contracts/src/errors.ts
    line: 108
    summary: >
      isZodError and toValidationDetails have no direct unit test. Both the empty-path
      -> FORM_ERROR_KEY rule and the first-path-segment-collapse rule (ADR-0025's two
      load-bearing design decisions) are unasserted by any test in the suite — the
      filter spec's zod fixture only produces a single, one-segment-path issue.
      Implementer disclosed this explicitly (report §5.4); confirmed independently by
      reading errors.spec.ts (9 tests, none touch these three exports).
    failure_scenario: >
      A wrong implementation of either rule — e.g. `_form` misspelled, or keying by
      the full joined path instead of the first segment — passes all 44 tests. A
      schema-level .refine() failure then either vanishes from the response body or
      renders as a garbled field name, on the validation path every TASK-007-consuming
      endpoint uses.
    required_change: >
      Add direct unit tests to packages/contracts/src/errors.spec.ts: one ZodError
      fixture with a root-level (.refine()) issue asserting FORM_ERROR_KEY, one with a
      two-segment path (e.g. branding.logoUrl) asserting collapse to the first
      segment. Same routing note as above — this is a test-file gap, not an
      implementation defect.

  - severity: major
    kind: design
    file: .sdlc/launch-core/design/test-strategy.md
    line: 172
    summary: >
      AC-14's recorded compensating mechanism (a future contract-drift CI check that
      renames an ERROR_CODES member paired with its ERROR_CODE_STATUS key, asserting
      apps/web is what fails) predates this task's addition of isZodError,
      toValidationDetails and FORM_ERROR_KEY to packages/contracts/src/errors.ts.
      Those three exports are consumed only by apps/api (verified: apps/web's only
      @shortkit/contracts import anywhere is `ERROR_CODE_STATUS` in
      apps/web/app/not-found.tsx). An incompatible change confined to those three
      exports fails apps/api's typecheck, not apps/web's — pnpm -r typecheck still
      exits non-zero, but not "because apps/web no longer compiles," which is AC-14's
      literal clause. The specific mutation the documented mechanism proposes (an
      ERROR_CODES rename) is unaffected and remains valid; the gap is that AC-14 as
      written covers "a contract is changed incompatibly," unqualified, and the
      recorded mechanism no longer covers the full surface of packages/contracts.
    failure_scenario: >
      Once TASK-002 builds the recommended contract-drift check using only the
      documented ERROR_CODES-rename mutation, it will report AC-14 as fully covered
      while a real class of incompatible changes (breaking the zod-recognition
      exports) goes undetected by any automated gate — caught only if it happens to
      also break something apps/web imports.
    required_change: >
      Before TASK-002 implements the contract-drift check, revisit test-strategy.md's
      AC-14 entry to either (a) scope AC-14 explicitly to the exports apps/web
      consumes, noting the API-only exports as a separate, currently-unenforced
      surface, or (b) widen the planned CI check's mutation set to include a rename of
      one of the three new exports and confirm whether that failure is acceptable to
      surface only via apps/api rather than apps/web. This is a design/test-strategy
      decision, not something TASK-007's implementer could resolve inside its own
      paths.

  - severity: minor
    kind: contract-gap
    file: .sdlc/launch-core/design/contracts/error-envelope.md
    line: 195
    summary: >
      The contract fixes code and status for the 404 and 400 framework-exception rows
      but is silent on the envelope's top-level message for either, despite
      errorEnvelopeContract requiring message non-empty. The implementer invented two
      fixed strings (NOT_FOUND_MESSAGE, VALIDATION_FAILED_MESSAGE), disclosed and
      reasoned in TASK-007-report.md §3.2. Invariant 3 ("callers must never branch on
      message") makes this functionally safe, but nothing pins the wording, so a
      second implementer facing the same gap could choose different text with no test
      catching the divergence.
    failure_scenario: >
      Low — no functional break given invariant 3. Worth recording only because 17
      TASKs consume this contract and inconsistent tone/wording across error paths is
      a product-polish cost with no test to catch it.
    required_change: >
      Optional: add the chosen strings (or an explicit "implementer's choice, not
      normative" note) to error-envelope.md so future contributors don't re-derive the
      same decision independently.
```

## Also report — the five disclosed items

Checked each against `error-envelope.md`'s actual text, not the implementer's characterization of it.

1. **`headersSent` branch** — contract-mandated. `error-envelope.md`, "Two more cases the filter has to answer": "A response already started... If the headers are sent, the filter logs and ends the response." Matches almost verbatim (`exception-filter.ts` lines near the top of `catch()`).
2. **Non-integer `status` guard** — contract-mandated. Same section, "A code with no status... Answer 500 internal_error and log the code. Never answer with undefined as a status." Implemented exactly.
3. **Branch-3 "any other status" arm** — contract-mandated by the status table's "any other | internal_error | 500" row. Correctly implemented, but see the coverage-gap finding above — mandated *and* untested are not mutually exclusive.
4. **Log helper (`logError()`)** — the *behavior* (name/message/stack to log, `request_id` deferred to TASK-003) is contract-mandated; the specific private-method shape is an implementation choice, not itself dictated. Acceptable.
5. **Local `HttpResponseLike` interface** — acceptable, not contract-mandated as a specific artifact. `apps/api` has no `@types/express` (verified: no `express`/`@types/express` in `apps/api/package.json`'s dependency tree per the report), so a narrow structural interface naming only the four members used is a defensible boundary choice consistent with the same discipline ADR-0025 applies to zod. Not scope creep.

None of the five are scope nobody asked for. Items 1–3 are near-verbatim contract text; items 4–5 are reasonable, minimal implementation choices in service of contract-mandated behavior.

## Shipped but not asked for

None found. Diff is confined to `packages/contracts/src/errors.ts` (3 exports, exactly what F-071/ADR-0025 specify), `apps/api/src/common/errors/domain-error.ts` (fills the three frozen stubs, no more), `apps/api/src/common/errors/exception-filter.ts` (new file, matches the four-branch contract exactly), and `apps/api/src/app.module.ts` (single additive `APP_FILTER` provider, explicitly authorized by the F-070 amendment in `TASK-007.md`). No test file touched. No `package.json` touched — correctly, per F-071's ruling that zod never enters `apps/api`.

## Out-of-scope items that got built

None. TASK-007's own "Out of scope" clause (filter wiring *beyond* the shared envelope) is correctly read per the dated F-070 correction already in the TASK file — registering `APP_FILTER` is in scope and required for AC-13 to be observable at all, which I confirmed by reading the frozen spec: it boots real `AppModule` over HTTP specifically so a never-registered filter cannot pass.

## Verdict

**CHANGES-REQUESTED**

Not because the shipped code is wrong — on inspection, every branch matches `error-envelope.md` and both ADRs precisely, and the implementer's own disclosures are honest and accurate. The reason is that AC-13 and AC-14 both carry real, currently-unclosed verification gaps that are bigger than "nice to have": two `error-envelope.md`-mandated HTTP branches (400 and "any other status" under branch 3) have no test evidence at all, ADR-0025's two load-bearing parsing rules (`_form`, first-segment collapse) have no test evidence at all, and AC-14's documented compensating mechanism has a scope hole this diff itself created and that no design artifact has yet revisited. All three are process/test-phase gaps rather than implementer defects — I'd expect the disposition to be closing them in a Test-phase rework pass or explicitly recording them as accepted risk in `test-strategy.md` (the precedent the initiative already uses for AC-14, AC-7, AC-5) rather than reworking TASK-007's production code.
