# Security audit — TASK-007 (round 1)

> Returned inline by `sdlc-security-auditor` (no Write tool available in its session) and
> persisted verbatim by the orchestrator on 2026-08-05. Review package:
> `.superpowers/sdd/TASK-007/review-453640c..4ea1067.diff`. The auditor confirmed it wrote
> nothing into the repo; its probes stayed in the session scratchpad. Orchestrator verified
> the working tree was clean afterwards.

Reviewed: `.superpowers/sdd/TASK-007/review-453640c..4ea1067.diff` (5 files, 248 insertions), against `error-envelope.md`, ADR-0024, ADR-0025, the `## Global Constraints` table in `plan.md`, and all 85 entries in `findings.yaml`. I read the code, not the tests' output; I did not re-run any gate. Where I state a runtime fact I verified it against the installed dependency (zod 4.4.3, express 5.2.1 / router 2.2.0, body-parser 2.3.0, finalhandler 2.1.1, `@nestjs/core` 11.1.28, Node 24.19), by reading source or by running a self-contained probe in the scratchpad — never against the repo's app.

```yaml
verdict: changes-requested
findings:
  - id: SEC-1
    severity: major
    kind: scope
    file: apps/api/src/common/errors/exception-filter.ts
    line: 79
    summary: >-
      The GC-9 deferral is parked on TASK-003, whose paths cannot reach this file, so the
      one log line carrying raw error text has no owner able to move it behind pino's
      redaction.
    failure_scenario: >-
      The comment at :79-81 reads "TASK-003 replaces this with the pino logger, which adds
      request_id to these lines." TASK-003's paths are
      ["fly.toml","Dockerfile","infra/**","apps/api/src/health/**","apps/api/src/app.module.ts","apps/api/src/main.ts"]
      (verified in .sdlc/launch-core/tasks/TASK-003.md:9) and contain no entry reaching
      apps/api/src/common/errors/**. TASK-003's implementer will meet this file as out-of-path
      and leave it, exactly as F-060's implementer met main.ts. The result is not cosmetic:
      logging-and-headers.md makes REDACT_PATHS the sole mechanism enforcing GC-9, and this
      filter is the only place in the API that writes an arbitrary error's message and stack.
      It stays outside that mechanism for as long as nobody owns the file, and error-envelope.md
      invariant 9 ("debugging one means finding its request_id in the logs") stays false for
      every 500 the product returns. This is the eighth instance of the
      artifact-assigns-work-a-TASK-cannot-do class the ledger tracks (F-060 is the closest
      precedent and was ruled by widening paths rather than by moving the work).
    required_change: >-
      Juano's call, per routing rule 0 — both candidate homes are approved artifacts. Either add
      apps/api/src/common/errors/** to TASK-003's paths and name the swap in TASK-003's Produces
      block, or name the TASK that does own it. A code comment is not an owner. Whichever way it
      lands, the obligation must be recorded somewhere a later implementer reads, not only here.

  - id: SEC-2
    severity: minor
    kind: behavior
    file: apps/api/src/common/errors/exception-filter.ts
    line: 168
    summary: >-
      Branch 4 logs the raw error message and full stack through an unredacted logger, which
      is the exact thing F-064's ruling removed from main.ts eight commits ago.
    failure_scenario: >-
      main.ts:59-62 carries the ruling in prose: "The stack is deliberately not logged: ADR-0022
      redacts by path at the logger, and no path reaches into a stack, so it would be the one
      field on the boot line outside the redaction pipeline." This filter does the opposite for
      every unmapped throwable, and the two files now disagree in the same repo. The exposure is
      real but modest and is to the log sink, not to a client: a pg/Redis connection failure puts
      an internal host and, for a URL-style DSN, credentials into `message` (the frozen spec's own
      fixture, `postgres://shortkit:hunter2@db.internal:5432`, is the repo's canonical example of
      the class); a SyntaxError from a handler that parses a body by hand puts a fragment of the
      request body into `message`, which logging-and-headers.md lists under "what may never appear
      in a log line". Path-based redaction cannot reach inside a message string, so REDACT_PATHS
      will not cover any of it even after TASK-003 lands.
    required_change: >-
      Make the two files agree, and record which way. Either main.ts regains the stack, or this
      filter logs `name: message` truncated plus a summary until TASK-003 lands an error
      serialiser that runs the stack through ADR-0022. Do not silently keep both.

  - id: SEC-3
    severity: minor
    kind: behavior
    file: packages/contracts/src/errors.ts
    line: 129
    summary: >-
      toValidationDetails accumulates into a plain object literal keyed by an attacker-influenced
      string, so an issue path beginning with an Object.prototype key throws inside the filter.
    failure_scenario: >-
      Verified by executing the function body verbatim: for key `constructor`, `toString`,
      `valueOf`, `hasOwnProperty` or `__proto__`, `fieldErrors[key] ?? []` returns the inherited
      value rather than undefined and `messages.push(...)` throws
      "TypeError: messages.push is not a function". `issue.path[0]` is attacker-controlled the
      moment any request schema puts a user key in the first segment — a top-level
      `z.record(z.string(), ...)`, or `z.object({}).catchall(...)`, or a superRefine that sets its
      own path. (Nested records are safe today: I confirmed a record under a named field yields
      path ["meta","constructor"], so path[0] is the field name.) Consequence, traced end to end:
      the throw escapes `catch()`, express 5's router forwards the rejected promise to `next(err)`
      (router 2.2.0 lib/layer.js:124), Nest's own error layer re-enters this filter with the
      TypeError, and the caller receives 500 internal_error instead of 400 validation_failed while
      the log records a spurious unhandled 500. No process crash and no data leak — but an
      unauthenticated caller turns a validation error into a 500 with a three-character key, on
      the shared path all fourteen downstream TASKs use.
    required_change: >-
      Build the accumulator with `Object.create(null)` (or a Map) and read with `Object.hasOwn`.
      Add a direct unit test for the prototype-key input; §5.4 of the implementer's report already
      records that these two functions have no direct test at all.

  - id: SEC-4
    severity: minor
    kind: behavior
    file: apps/api/src/common/errors/exception-filter.ts
    line: 152
    summary: >-
      Branch 3's 400 arm copies an HttpException's message into the body verbatim, and for the
      framework's own 400 that message contains a fragment of the raw request body.
    failure_scenario: >-
      Nest 11 maps a body-parser SyntaxError to `new BadRequestException(err.message)`
      (@nestjs/core/router/routes-resolver.js:98, mapExternalException), and Node's JSON.parse
      message embeds a slice of the input. Measured on Node 24.19:
      `JSON.parse('{"password":"hunter2","token":"eyJhbGciOi","x":}')` produces
      `Unexpected token '}', ..."ciOi","x":}" is not valid JSON`. So an unauthenticated POST with
      a malformed JSON body has ~15-30 raw bytes of that body reflected into
      `details.fieldErrors._form`. The reflected bytes are the sender's own, so no privilege
      boundary is crossed, but error-envelope.md invariant 8 says flatly that no error body
      contains a password or a token, and this path can put a fragment of one there whenever the
      syntax error sits next to a credential field. The same arm receives Express's URIError for a
      bad percent-encoding, which names the offending path segment. It is also inconsistent with
      the 404 arm three lines up, where the implementer introduced NOT_FOUND_MESSAGE for precisely
      this reason ("the framework's own text ... is the request method and path echoed back").
    required_change: >-
      Give the framework-400 arm the same treatment as the 404 arm — a fixed `_form` message, or a
      hard truncation with the raw fragment dropped. This contradicts error-envelope.md:192-196,
      which mandates the pass-through, so it needs a contract amendment rather than a lone code
      edit; route the contract half accordingly.

  - id: SEC-5
    severity: minor
    kind: behavior
    file: packages/contracts/src/errors.ts
    line: 125
    summary: >-
      toValidationDetails caps neither the number of issues nor the number of messages per key, so
      a small body produces a large response built inside the exception filter.
    failure_scenario: >-
      zod reports one issue per failing array element. Against a future `z.array(z.string())` body,
      a 100 KB request (Express's default JSON limit) of `[1,1,1,...]` is roughly 50k elements, so
      roughly 50k messages of ~46 bytes each, i.e. a 2-3 MB response from a 100 KB request — about
      30x amplification, unauthenticated, plus the whole structure held in memory during the throw
      path. Separately, a `z.strictObject` body of unknown keys returns every one of them in a
      single `unrecognized_keys` message (verified: the message is `Unrecognized keys: "<key>", ...`
      with the submitted names verbatim), so the request echoes back at roughly 1:1. No route parses
      a body today, which is what keeps this minor; TASK-007 is the moment the cap is cheap.
    required_change: >-
      Cap the issue count and the per-key message count in toValidationDetails (e.g. first N per
      key, first M overall, with a truncation marker), and state the cap in error-envelope.md
      beside the ValidationDetails shape.

  - id: SEC-6
    severity: minor
    kind: design
    file: apps/api/src/common/errors/exception-filter.ts
    line: 108
    summary: >-
      `details` is forwarded verbatim for every code, and this filter is the last checkpoint before
      the wire; nothing validates it against the shape the contract names.
    failure_scenario: >-
      ADR-0024 recorded this as an accepted cost ("details is typed unknown ... The filter forwards
      it verbatim. Only review catches that"), written before the filter existed. It now imports from
      the package that declares validationDetailsContract, so the check costs one line. Without it:
      TASK-018 or TASK-040 attaches a conflicting record to `details` on a 409 to make the client's
      job easier — the obvious shape for `hostname_already_claimed` or `last_owner_protected` is the
      row that conflicted — and another workspace's fields ship to the caller. Nothing catches it:
      errorEnvelopeContract types `details` as `z.unknown().optional()`, so every envelope assertion
      in every downstream spec still passes, and the fourteen throwing TASKs each write their own
      throw site with no reviewer between it and the browser.
    required_change: >-
      In the filter: when code is `validation_failed`, parse `details` with validationDetailsContract
      and drop it if it does not match; for any code error-envelope.md names no shape for, drop
      `details` and log that it was dropped. Contesting an ADR-0024 consequence, so it needs a
      ruling rather than a quiet fix.

  - id: SEC-7
    severity: minor
    kind: design
    file: packages/contracts/src/errors.ts
    line: 72
    summary: >-
      The 409 uniqueness codes are cross-tenant existence oracles, and invariants 5 and 6 cover
      access but say nothing about uniqueness conflicts.
    failure_scenario: >-
      Invariant 5 ("cross-tenant access always returns 404, never 403") makes the product's central
      property true for reads. It does not reach writes that collide on a globally unique value.
      `hostname_already_claimed` is the sharp one: any user who can sign up for a free workspace can
      POST candidate hostnames at TASK-040's endpoint and learn, one 409 at a time, which custom
      domains other tenants have claimed — the tenant-enumeration primitive SC-1 and GC-5 exist to
      prevent, reached without touching another tenant's records. `slug_taken` is the same shape
      bounded by (domain_id, slug) per GC-6, so it only discloses within a domain the caller already
      reaches. TASK-007 ships the registry; TASK-040 ships the throw site, which is why this is
      design and not a defect in this diff.
    required_change: >-
      State in error-envelope.md (or domains.md) what a uniqueness conflict may disclose, before
      TASK-040 is dispatched. The usual answer is to answer 409 only after the caller has proved
      control of the hostname via DNS, and to answer the pre-proof case identically whether or not
      the hostname is claimed.

  - id: SEC-8
    severity: nit
    kind: behavior
    file: apps/api/src/common/errors/exception-filter.ts
    line: 108
    summary: >-
      Branch 1 trusts a marker-carrying object completely — `status`, `toEnvelope()` and `headers`
      are all read off it with only the integer check as a guard.
    failure_scenario: >-
      Not an attack path (see Notes on Symbol.for), but a plain-object literal carrying the marker,
      copy-pasted by a downstream TASK, has no `toEnvelope` and throws inside `catch()`; the caller
      gets 500 instead of the intended code and the log names a TypeError rather than the mistake.
      Same re-entrancy as SEC-3.
    required_change: >-
      Optional hardening: verify `typeof exception.toEnvelope === 'function'` before branch 1
      commits, and fall through to 500 with a log naming the code otherwise.
```

## Notes

**The four questions I was asked, answered directly.**

1. **Information disclosure — the branches are clean.** I traced all four. Branch 4 constructs its body from `errorResponse('internal_error', INTERNAL_ERROR_MESSAGE)` with no third argument, so no `details` key exists at all; nothing of the original throwable is stringified into a body anywhere. The filter never walks `cause`, never touches `exception.stack` outside `logError`, and never serialises the exception object. `errorResponse` is the only body constructor and takes only a code, a literal message and an optional details. The single body-side leak I found is SEC-4, and it comes from the framework's message, not from a stringified error. On the log side, everything reaching it is in SEC-1 and SEC-2.

2. **The zod branch does not echo submitted values.** I read the installed zod 4.4.3's `v4/locales/en.js` line by line and ran the common failures. No built-in message interpolates `issue.input`: `invalid_type` reports the *type* received, never the value ("Invalid input: expected number, received string"); `too_small`/`too_big` report the limit; `invalid_value` reports the *expected* values. A `z.string().min(8)` failure on a password field yields "Too small: expected string to have >=8 characters" — the password does not appear. The one exception is `unrecognized_keys`, which lists submitted *key names* verbatim (I confirmed `<img src=x>` survives into the message, path `[]`, so it lands under `_form`); that is the sender's own input reflected into an `application/json` body, and React escapes it, so it is a note for whoever first renders `_form` rather than a finding. The residual risk is downstream: a custom `.refine(..., { message })` that interpolates the parsed value would reflect it, and nothing in the contract forbids that. Worth one sentence in error-envelope.md.

3. **`Symbol.for` spoofing is not exploitable here, and I do not think it can become so.** `isDomainError` is a duck check on `[Symbol.for('shortkit.domainError')] === true`, so any object carrying that key chooses its own status, body and headers. To reach branch 1 an attacker needs a *thrown value* with a symbol-keyed property. Symbol keys cannot be produced by `JSON.parse` (it creates string-keyed properties only), and the repo deserialises nothing else — no YAML, no `structuredClone` (which drops symbols), no `eval`. Every remaining producer is in-process code, and in-process code can already `throw new DomainError(...)` directly, so the marker grants it nothing. The one class of adversary it does help is a malicious transitive dependency choosing its own response — strictly less than what such a dependency already has. Theoretical; ADR-0024's reasoning stands. SEC-8 is the practical residue: the trust is total, and the realistic trigger is a mistake, not an attacker.

4. **Headers cannot be split.** `HttpResponseLike.setHeader` is Node's `ServerResponse.setHeader`, which validates both token and value; I confirmed a CRLF value raises `ERR_INVALID_CHAR` (TypeError) rather than emitting the bytes. So no response splitting and no injected cacheable header. A CRLF value instead throws inside `catch()`, which lands in the same re-entrancy as SEC-3 — the caller gets 500 rather than the intended status. Nothing puts a message or `details` into a header: branch 1 reads only `exception.headers`, and the non-integer-status guard returns an `errorResponse` with no `headers` field, so a bad status also discards the headers that came with it. Correct.

**GC-9 ruling (item 6).** Splitting it in two. *Using Nest's `Logger` rather than pino is an acceptable deferral* — `apps/api/package.json` is genuinely outside this TASK's paths, ADR-0025 deliberately kept it out under F-075's rule, and `main.ts:57` set the same precedent under a ruling. I would not ask for pino here. *The deferral's ownership is not acceptable* and that is SEC-1: the successor named in the comment cannot write the file. The missing `request_id` on a 500 rides on the same fix — it is a forensics gap rather than a vulnerability, but invariant 9 is false until it lands and that should be stated somewhere other than a report §5.1.

**F-082, open and assigned to this TASK's implementer, was not addressed.** The report never mentions the 413 question. I established the answer while tracing branch 3, so it need not cost another round: Nest 11 *does* register an Express error-layer middleware (`routes-resolver.js:84 registerExceptionHandler`) that routes middleware errors through the global filter chain, and APP_FILTER-registered filters are in that chain. So a body-parser 413 reaches this filter as an `http-errors` PayloadTooLargeError — not an `HttpException` — and comes out of branch 4 as a 500 with a valid envelope. Invariant 1 holds; no `finalhandler` HTML page and no stack trace escapes (which is what I was checking for — `finalhandler@2.1.1:157-162` returns `err.stack` in the response body whenever `NODE_ENV !== 'production'`, and no artifact in this repo yet guarantees `NODE_ENV=production`, so that fallback path is worth keeping out of reach). Someone should write this into F-082's ruling; I am reporting it, not recording it.

**Not findings, checked and cleared.** No SQL, command, path or template construction anywhere in the diff. No secret, credential or env read. No new endpoint, so no authn/authz surface — the filter runs after guards and changes no authorization decision. No CORS header, no cookie, no `Set-Cookie`, no redirect, no HTML. `ERROR_CODE_STATUS[this.code]` with a prototype-chain key (`toString`, `__proto__`) returns a non-integer and is correctly caught by the `Number.isInteger` guard at :112. `@Catch()` global registration means a visitor to an unmatched non-`/api` route receives a JSON envelope rather than the branded 404 GC-8 requires — that is the redirect surface's TASK to override and is not a security defect. Error responses carry no `Cache-Control: no-store`, and 404/410 are heuristically cacheable per RFC 9111; the bodies for both are content-free today, so there is nothing to leak through a shared cache, but the header is worth adding when the first tenant-specific message lands on one of those codes.

## Dependencies reviewed

The diff adds and bumps nothing. `git diff --name-status 453640c..HEAD` returns five files, none of them a manifest or a lockfile; `git diff 453640c..HEAD -- '**/package.json' 'package.json' 'pnpm-lock.yaml'` is empty. `zod` is declared in exactly one manifest, `packages/contracts/package.json:15`, pinned exactly at `4.4.3` per ADR-0018; `apps/api/package.json` still declares no zod and the filter imports none, value or type, as ADR-0025 requires. `packages/contracts/src/index.ts` was not touched — the three new symbols reach `@shortkit/contracts` through the pre-existing `export * from './errors'`, so the single-entry-point rule (ADR-0005, F-045) holds and no `"./*"` subpath was introduced. The runtime code added to `packages/contracts` is two pure functions and a string constant with no import-time side effects, so `sideEffects: false` still holds and the browser bundle can still drop them; nothing enforces that assertion, which ADR-0005 already records.

**Files referenced in this audit** (all absolute):

- `/home/juano/Workspaces/JustJuanoDev/apps/api/src/common/errors/exception-filter.ts`
- `/home/juano/Workspaces/JustJuanoDev/apps/api/src/common/errors/domain-error.ts`
- `/home/juano/Workspaces/JustJuanoDev/apps/api/src/common/errors/error-envelope.ts`
- `/home/juano/Workspaces/JustJuanoDev/packages/contracts/src/errors.ts`
- `/home/juano/Workspaces/JustJuanoDev/apps/api/src/app.module.ts`
- `/home/juano/Workspaces/JustJuanoDev/apps/api/src/main.ts` (F-064 precedent cited in SEC-2)
- `/home/juano/Workspaces/JustJuanoDev/.sdlc/launch-core/tasks/TASK-003.md` (paths, SEC-1)
- `/home/juano/Workspaces/JustJuanoDev/.sdlc/launch-core/design/contracts/logging-and-headers.md`

I have no Write tool available in this session and did not create the audit file. Persist this return to `/home/juano/Workspaces/JustJuanoDev/.sdlc/launch-core/audits/TASK-007-sdlc-security-auditor-r1.md`. Probe scripts I ran are in the session scratchpad (`probe.mjs`, `probe2.mjs`, `probe3.mjs`, `probe4.mjs`); nothing was written into the repo and no owner_slot is assigned on any finding.

**Verdict: CHANGES-REQUESTED** — on SEC-1 alone, which is an ownership ruling rather than a code change. SEC-3 and SEC-4 are the only findings asking for edits to this diff's code; both are small and neither touches the filter's branch structure.
