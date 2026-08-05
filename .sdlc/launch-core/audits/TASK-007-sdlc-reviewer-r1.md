# TASK-007 review — round 1

> Returned inline by `sdlc-reviewer` (it has no Write tool and its instructions forbid
> writing report files) and persisted verbatim by the orchestrator on 2026-08-05.
> Review package: `.superpowers/sdd/TASK-007/review-453640c..4ea1067.diff`.

Reviewed the full diff `453640c..4ea1067` against `error-envelope.md`, ADR-0024, ADR-0025, the Global Constraints table, and the two frozen specs, reading each changed file whole rather than as a hunk. Gates not re-run, per dispatch.

Weighting note: I applied the fourteen-TASK inheritance multiplier the dispatch asked for. It moved exactly one finding up (F1: from "hardening on an unreachable-today path" to `major`) and moved nothing down.

```yaml
verdict: changes-requested
findings:
  - severity: major
    kind: behavior
    file: packages/contracts/src/errors.ts
    line: 130
    summary: >-
      toValidationDetails accumulates into a `{}` literal and reads `fieldErrors[key] ?? []`,
      so any zod issue whose first path segment names an Object.prototype member
      (`constructor`, `toString`, `valueOf`, `hasOwnProperty`, `__proto__`) reads an inherited
      value instead of undefined and throws TypeError inside the exception filter.
    failure_scenario: >-
      Reproduced against the installed zod 4.4.3, not reasoned about:
      `z.record(z.string(), z.string()).safeParse(JSON.parse('{"constructor": 2}'))` yields an
      issue with `path: ["constructor"]`. Feeding that ZodError to the shipped
      toValidationDetails body gives `TypeError: messages.push is not a function`
      (`fieldErrors['constructor']` resolves to the Object constructor, which has no `push`).
      The throw happens inside `ApiExceptionFilter.catch`, which has no guard, so it escapes the
      filter: Express 5 forwards the rejected handler promise to Nest's error layer
      (`routes-resolver.registerExceptionHandler`), which re-enters the same filter with the
      TypeError and answers 500 `internal_error`. A request that must answer 400
      `validation_failed` with field errors answers 500 with none, and the form shows nothing.
      Where the escape reaches `finalhandler` (2.1.1) instead, the body is HTML carrying
      `err.stack` whenever NODE_ENV is not `production` — an invariant-1 violation and a stack in
      a response body. Not reachable from any schema in the repo today (every current request
      shape is a one-level `z.object`); it becomes reachable the first time a contract declares
      `z.record` over caller-supplied keys, and this function is inherited unmodified by the
      `validation_failed` path of every consuming TASK.
    required_change: >-
      Key accumulation must not consult the prototype chain — a null-prototype accumulator
      (`Object.create(null)`), `Object.hasOwn` before the read, or a `Map` drained at the end.
      Two extra properties must hold afterwards: the returned object still passes
      `validationDetailsContract` and still serialises through `res.json`, and a first path
      segment of `__proto__` produces an own, JSON-visible key rather than silently setting a
      prototype. The identical code exists in the approved design stub
      (.sdlc/launch-core/design/stubs/packages/contracts/src/errors.ts) — the implementer copied
      it faithfully, so the stub carries the same defect and needs the same correction, or the
      next reader restores it.

  - severity: minor
    kind: implementation
    file: packages/contracts/src/errors.ts
    line: 102
    summary: >-
      isZodError and toValidationDetails have no direct test; both normative rules they exist to
      carry (empty path -> `_form`, collapse to the first path segment) are unasserted anywhere.
    failure_scenario: >-
      The only coverage is transitive, through the filter spec's `zod` probe, which produces a
      single issue with a one-segment path (`['message']`). Deleting the `issue.path.length === 0`
      branch, or keying by `issue.path.join('.')` instead of `path[0]`, passes all 44 tests. The
      finding above is the concrete cost of the gap: a demonstrable crash in an untested function.
      ADR-0025 rests its whole placement argument on these two rules living beside the shape they
      produce, and nothing checks that they still do.
    required_change: >-
      Direct unit tests in packages/contracts/src/errors.spec.ts over a real ZodError:
      a root `.refine()` failure lands under FORM_ERROR_KEY; two issues on `a.b` and `a.c` collapse
      to one `a` key with two messages in issue order; a prototype-named first segment survives
      (guards the fix above); isZodError accepts a real ZodError and rejects a plain object
      carrying `{ name: 'ZodError', issues: [] }`.

  - severity: minor
    kind: scope
    file: apps/api/src/common/errors/exception-filter.ts
    line: 79
    summary: >-
      The comment defers the pino swap to TASK-003, whose paths do not include
      `apps/api/src/common/errors/**`, so no TASK can currently perform the swap.
    failure_scenario: >-
      TASK-003's paths are `["fly.toml", "Dockerfile", "infra/**", "apps/api/src/health/**",
      "apps/api/src/app.module.ts", "apps/api/src/main.ts"]`. `exception-filter.ts` is in no
      TASK's paths but TASK-007's, and TASK-007 closes here. ADR-0024's follow-up list says
      "TASK-003's logger gets the 500 branch's log line: request_id, error name, message, stack",
      and error-envelope.md invariant 9 makes finding that request_id the entire debugging story
      for a 500. Left as is, either TASK-003's implementer commits an out-of-path edit or the API
      ships 500s with no request_id and no structured line (GC-9), with nothing tracking it.
      This is the same class as F-060, which Juano fixed by widening TASK-003's paths to include
      main.ts; it is a new instance at a new file, not a re-file.
    required_change: >-
      Either widen TASK-003's paths to `apps/api/src/common/errors/exception-filter.ts` (or
      `common/errors/**`), or name the TASK that will own the swap in the comment. The routing is
      the orchestrator's/Juano's, not the implementer's. The choice of Nest's Logger for now is
      correct given TASK-007's paths — the defect is the dangling hand-off, not the logger.

  - severity: minor
    kind: implementation
    file: apps/api/src/common/errors/exception-filter.ts
    line: 83
    summary: >-
      `catch()` has no last-resort guard, so anything thrown while resolving or writing the
      response escapes the one place that is supposed to answer for every throwable.
    failure_scenario: >-
      Three live paths, all in code fourteen TASKs will write: (a) the crash in the first finding;
      (b) `details` is typed `unknown` and forwarded verbatim (ADR-0024 says so explicitly), so a
      DomainError carrying a BigInt or a circular reference makes `res.json` throw
      ("Do not know how to serialize a BigInt"); (c) a `headers` value that Node rejects makes
      `setHeader` throw ERR_INVALID_CHAR — after the loop has already written the earlier headers,
      leaving a half-headered response. In each case the filter throws instead of answering, and
      the client gets whichever of Nest's error layer or finalhandler catches it — a 500 with the
      wrong code, or HTML with a stack outside production.
    required_change: >-
      A failure inside the filter must still produce the envelope. Wrap the resolve-and-write in a
      last-resort path that logs the secondary failure and, if `headersSent` is still false,
      answers 500 `internal_error` with INTERNAL_ERROR_MESSAGE and no details. Not a new branch in
      the normative table — the table describes classification, this is the write step.

  - severity: minor
    kind: implementation
    file: .sdlc/launch-core/work/TASK-007-report.md
    line: 1
    summary: >-
      F-082 assigns TASK-007's implementer the job of establishing whether a body-parser 413
      reaches the filter and recording the answer; the report does not address it.
    failure_scenario: >-
      F-082 is open with owner_slot sdlc-implementer-backend and required_change "TASK-007's
      implementer should establish whether a body-parser 413 reaches the filter and record the
      answer. If it does not, invariant 1 needs an explicit stated exception rather than a silent
      one." Nothing in the report mentions 413, body-parser, or middleware errors. Left open, the
      question resurfaces at TASK-051 or the first route with a size limit, with nobody positioned
      to answer it any better.
    required_change: >-
      Record the answer against F-082. I established it while reviewing (evidence in Notes below):
      body-parser errors DO reach this filter, and the 413 answers 500 with a valid envelope, so
      invariant 1 needs no exception. This costs a ledger edit, not code.
```

## Verdicts on the five items the implementer disclosed

1. **Untested contract-mandated code** — all five are fine and none should be struck.
   - `headersSent` branch: mandated by error-envelope.md:210-212, and correct. `response.end()` on an already-finished response is a no-op in Node (`OutgoingMessage.end` returns early on `finished`), so the double-end case is safe.
   - Non-integer status guard: mandated at :207-209, and `Number.isInteger(undefined) === false` makes it do what the contract asks. It correctly drops `headers` on that path.
   - Branch 3's "any other status" arm: mandated by the `any other` row and load-bearing, not speculative — I confirmed a body-parser 413 lands exactly there.
   - `logError` + `Logger`: fine as code; the hand-off is the third finding.
   - `HttpResponseLike`: justified and correctly narrow. All four members exist on Express 5's response, `getResponse<T>()` is an unchecked cast either way, and it keeps `apps/api` free of an undeclared `@types/express`. Same discipline ADR-0025 applies to zod. Under-rated in one direction only: it also silently locks the filter to a `setHeader`/`status`/`json` adapter, which is fine while platform-express is the only adapter (GC-7).
2. **Nest `Logger` rather than pino** — deferring is right; the *dangling hand-off* is the finding (third above). The implementer had no path to `apps/api/package.json` and TASK-003 owns the logger; inventing a pino dependency here would have been the worse call. Slightly under-rated: §5.1 states the consequence but does not observe that TASK-003 cannot reach this file, which is what turns a note into a finding.
3. **The two invented `message` strings** — fine, and the reasoning is right for a reason the report understates. Nest's not-found handler throws ``new NotFoundException(`Cannot ${method} ${url}`)`` (verified in `routes-resolver.registerNotFoundHandler`), so the framework text would have reflected the request URL into a JSON body on every unmatched route. Invariant 3 makes the exact wording non-load-bearing. No change wanted.
4. **§3.3, `exception.message` for a framework 400** — fine. `HttpException.initMessage()` derives it from `getResponse()`, so this is the exception's own response, not an arbitrary `Error.message`; re-deriving it by hand would duplicate framework logic. One under-rated edge, nit-level: when the response object's `message` is an *array* (the shape Nest's own ValidationPipe produces), `initMessage` falls back to the humanised class name, so `_form` gets `"Bad Request Exception"` and the per-field messages are lost. No TASK owns a Nest ValidationPipe (ADR-0025 leaves it open), and ADR-0024 routes application code to `DomainError`, so this is not worth code today — worth knowing when the pipe question is answered.
5. **No direct test for `isZodError`/`toValidationDetails`** — honestly disclosed and **under-rated**. The report calls it a coverage gap that "belongs to whoever owns test coverage"; it is also the reason a demonstrable crash shipped. Filed twice above: the defect (major) and the gap (minor).

## Answers to the four specific questions

- **Branch order.** Matches the normative table exactly: `isDomainError` → `isZodError` → `instanceof HttpException` → else, with branch 3's sub-table 404/400/any-other in the right order and the right codes. A `DomainError` that is also an `HttpException` cannot arise from the shipped class (`extends Error`), and if a downstream TASK ever wrote one, branch 1 is tested first, so it still takes the domain branch. No fifth branch, and no branch picks a status: branch 1 goes through `DomainError.status`, branches 2-4 through `errorResponse()`, both of which read `ERROR_CODE_STATUS`. This also satisfies the open F-073, which asked that the filter route through `errorResponse()` rather than re-declaring the lookup.
- **`isDomainError` robustness.** Sound. `typeof value === 'object' && value !== null` short-circuits before the symbol read, so `null`, `undefined`, strings, numbers and symbols all return false without throwing (`throw null` is covered by a frozen test). The `Symbol.for` registry is shared across realms within an agent, so a `vm` context or a second bundle in the same process matches; a `worker_thread` is a separate agent, but no object crosses that boundary un-serialised anyway, so the case is vacuous. Two knowingly-accepted gaps, neither a finding: a *callable* carrying the marker is rejected (`typeof` is `'function'`), which no error is; and the guard proves only the marker, so a foreign object carrying `Symbol.for('shortkit.domainError')` without `toEnvelope` would throw at the call — that is inherent to ADR-0024's trait check and is covered by the last-resort-guard finding rather than by narrowing the guard.
- **`sideEffects: false`.** Nothing added in this diff runs at import time. The three additions are two function declarations and a string constant; no top-level call, no mutation, no registration. `packages/contracts/src/index.ts` was correctly left untouched (`export * from './errors'` already carried them), so no subpath was added and ADR-0005's single entry point holds.
- **Leak of an unmapped throwable's message/stack/cause.** No, on the intended paths. Branch 4 and branch 3's fall-through both return `errorResponse('internal_error', INTERNAL_ERROR_MESSAGE)` with no details, and `logError` is the only consumer of name/message/stack. `cause` is never read by the filter, and `toEnvelope()` cannot emit it. The one place original text reaches a body is branch 3's 400 `_form`, which the contract mandates verbatim and which carries the caller's own input (a body-parser `SyntaxError` message quoting a fragment of the request the caller sent). The real leak is indirect and is finding 4: an error escaping `catch()` lands on `finalhandler`, which writes `err.stack` into the body whenever `NODE_ENV !== 'production'`.

## Cannot verify from diff

- **AC-14** ("a contract change breaks `apps/web` typecheck") is a property of `packages/contracts` distribution and `apps/web`'s tsconfig paths, neither touched here. The report's claim that `index.ts` needed no change is verifiable and true; the AC itself is not exercised by this diff.
- **`slug.md`**, listed among TASK-007's contracts, is satisfied by `packages/contracts/src/slug.ts`, which landed in `09cb39a` — before this review range. Nothing in the range touches it, so its compliance is outside this review.
- **GC-9's pino requirement and the `request_id` on the 500 log line** cannot be satisfied within TASK-007's paths and cannot be verified until TASK-003 lands; the third finding is about the routing hole, not the deferral.
- **GC-8** ("no unresolvable request returns 5xx to a visitor") is untestable today. `setErrorHandler`/`setNotFoundHandler` mount without the global prefix (`express-adapter.js:82-87` ignores the `prefix` argument), so this filter answers a JSON envelope for non-`/api` paths too. That is harmless while no visitor surface exists, and `redirect-resolution.md:139-140` puts the branded-404 catch in the redirect controller rather than the filter — so the design already anticipates it. The interaction becomes real at TASK-030 and belongs to that TASK's review, not this one.

## Notes

- **F-082's answer, established while reviewing.** Body-parser errors *do* reach this filter. `@nestjs/core/router/routes-resolver.js:84-106` registers an Express error layer through `RouterProxy.createExceptionLayerProxy`, built from the same global filter set as route handlers, and `mapExternalException` maps a `SyntaxError` (malformed JSON) to `BadRequestException(err.message)`. So a malformed JSON body takes branch 3's 400 arm with the parser's message under `_form`, exactly as the contract's row describes — that arm is load-bearing, not speculative. A 413 is `PayloadTooLargeError`: not a `SyntaxError`, and `isHttpFastifyError` requires `name === 'FastifyError'`, so it falls through unmapped and lands in branch 4 as a 500 `internal_error` with a valid envelope. **Invariant 1 therefore needs no stated exception for 413**, and error-envelope.md:198-203 ("A 413 answers 500 today") is accurate as written. This is what the fifth finding asks to be recorded.
- The `state.yaml` hunk in the review package belongs to the orchestrator's own commit `c336b6d`, not the implementer's. Commits satisfy GC-10 (`feat(errors): … [TASK-007]`, branch `feat/launch-core`) and GC-4 (no attribution trailer, author Juano).
- `app.module.ts` is minimal and additive: one import pair and one provider, `imports: []` and the existing doc comment untouched. Wave-1 parallel safety holds — no other wave-1 TASK lists that file.
- A `DomainError` constructed with an empty message would produce a body failing `errorEnvelopeContract.message.min(1)` and break invariant 1. The contract places that promise on the throw site, not the filter, and no realistic call site does it, so I am not filing it — but it is the one shape the filter forwards without validating, and it is worth a sentence in whatever guidance the fourteen consuming TASKs read.
- Conventions match the neighbours throughout: header comment naming contract/ADR/producer/consumers, the same comment density as `domain-error.ts` and `main.ts`, `errorResponse()` reused rather than re-derived. The class name `ApiExceptionFilter` is unconstrained by any test or ADR, as the report says; nothing here needs it to be anything else.

**Verdict: CHANGES-REQUESTED**
