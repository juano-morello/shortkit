# Security audit — TASK-007, fix round 1 (round 2)

> Returned inline by `sdlc-security-auditor` (no Write tool in its session) and persisted
> verbatim by the orchestrator on 2026-08-05. Scope: the fix diff `c53275b..8c8641e`.
> The auditor confirmed its probes stayed in the session scratchpad and nothing was written
> into the repo.

Reviewed `.superpowers/sdd/TASK-007/review-c53275b..8c8641e.diff` (20 files, 1243 insertions) against my round-1 audit, ADR-0026, the amended `error-envelope.md`, the amended `domain-provisioning.md`, TASK-003's widened paths, and F-086..F-105. I did not re-run the gates. Runtime facts below were verified against the installed zod 4.4.3 and Node 24.19 with self-contained probes in the session scratchpad (`p1.mjs`..`p6.mjs`); nothing was written into the repo and no exploit was run against the app.

```yaml
verdict: clear
findings:
  - id: SEC-9
    severity: minor
    kind: behavior
    file: apps/api/src/common/errors/error-envelope.ts
    line: 48
    summary: >-
      narrowEnvelope returns the caller's envelope object by reference when `details` is
      absent, so a top-level sibling key on a `toEnvelope()` override reaches the wire
      unnarrowed — the same leak ADR-0026 closes for `details`, one level up.
    failure_scenario: >-
      Every other path through narrowEnvelope reconstructs `{ code, message }` (or
      `{ code, message, details: parsed.data }`), so nothing but the three declared fields
      survives. The `details === undefined` early return is the exception: it hands back the
      object it was given. Branch 1 is the only branch whose body is not built by
      `errorResponse`, and ADR-0026 itself names the reachable producer — "a subclass in a
      feature directory can override `toEnvelope()`". TypeScript does not stop it: I
      typechecked `override toEnvelope(): ErrorEnvelope { return { ...row, code, message } }`
      under `--strict` and it compiles clean, because excess-property checking does not apply
      to properties arriving from a spread (the equivalent direct literal errors TS2353). So
      TASK-018's `last_owner_protected` or TASK-040's `hostname_already_claimed` written as
      `return { ...conflictingRow, code, message }` ships `tenantId`, `hostname` and
      `ownerEmail` to a caller of another tenant, with no drop and no warn line, while
      `errorEnvelopeContract.safeParse` in every downstream spec still passes (z.object
      strips on parse, and nothing parses the outgoing body). Needs a developer mistake to
      trigger — same reachability class as F-096, which is why this is minor and not major.
    required_change: >-
      `if (details === undefined) return { code, message };`. The reference body in
      error-envelope.md and ADR-0026's table row "any | absent | envelope unchanged" carry
      the same shape, so the contract half moves with it. Cheapest while the ADR is fresh;
      TASK-003 holds this file in wave 2.

  - id: SEC-10
    severity: minor
    kind: behavior
    file: apps/api/src/common/errors/exception-filter.ts
    line: 210
    summary: >-
      The framework-400 arm moved the raw request bytes out of the body and into the log,
      where neither REDACT_PATHS nor pino can reach them, and the same line lets an
      unauthenticated caller put a newline into a log record.
    failure_scenario: >-
      Confirmed the move is real: the body now carries only
      FRAMEWORK_BAD_REQUEST_FORM_MESSAGE, and `logError('framework exception with a 400
      status', exception)` writes `BadRequestException: Unexpected token '}',
      ..."ciOi","x":}" is not valid JSON`. That is the correct trade — a log sink is a
      narrower audience than the response body, and invariant 8 is now absolute. What it is
      not is a fix for GC-9. The bytes are the same bytes; they now sit at rest in the log
      store, and TASK-003's Produces block says to pass the message "through ADR-0022's
      serialisation", which will not help, because redaction is path-based and no path
      reaches inside a message string. An unauthenticated POST of
      `{"password":"hunter2","token":"eyJhbGciOi","x":}` puts a token fragment in the log
      exactly as it used to put it in the body. Second, smaller property: the quoted slice
      is raw input, so it can contain a literal newline. Verified on Node 24.19 — body
      `{"a":\nERROR [Aut...` yields a message containing a real line break, and Nest's
      text Logger writes it as two physical lines. The injected second line is bounded to
      roughly 15 characters before `"... is not valid JSON`, so it splits a line-oriented
      log without being able to forge a convincing one. Both properties disappear once the
      record is JSON-encoded by pino, except the credential fragment, which does not.
    required_change: >-
      Deferred, not this round. For this arm the message has no diagnostic value the client
      is allowed to see anyway — log `exception.name` plus the SyntaxError's position, or a
      hard-truncated message, and not the quoted slice. This belongs in TASK-003's decision,
      which already owns this file and the F-093 policy; record it there rather than
      reopening TASK-007.
```

## The five questions

**1. Does `narrowEnvelope` stop what F-096 described?** For `details`, yes, on all three counts I was asked to check.

- The `validation_failed` arm returns `parsed.data`, not the input (`error-envelope.ts:56`).
- A sibling beside `fieldErrors` cannot survive: `validationDetailsContract` is a `z.object`, which strips on parse in zod 4.4.3. Verified — `{ fieldErrors: {...}, conflictingRow: { tenant, secret } }` parses successfully and the output has `Object.keys === ['fieldErrors']`. Also verified the parse output is a **fresh** object, not an alias of the input, so no later mutation of the input reaches the written body. `exception-filter.spec.ts` covers both this and the unnamed-code drop with a route that attaches `{ conflictingRow: { tenantId: OTHER_TENANT_ID } }` to a 409.
- The drop logs `code` only: `dropped details from a ${body.code} envelope: no shape is named for it`. No value, no key names, no size. `body.code` is developer-supplied, never caller-supplied. Correct per ADR-0026.

The residual is SEC-9: the checkpoint narrows `details`, not the envelope, so the filter header's claim that "the only values that reach a client are strings written in this file and shapes validated against a schema" is currently one line stronger than the code. One further note, not a finding: `safeParse` propagates a throwing getter on `details` (verified — it throws rather than returning `success: false`), which lands in F-092's `catch` and answers 500. That is the right outcome and the guard is why it is not a finding.

**2. Are the caps a real bound, and does the notice leak?** The amplification is genuinely killed for the case F-095 described, and the notice leaks nothing.

- Measured with the shipped algorithm: `z.array(z.string())` against 50,000 bad elements produced 50,000 issues and a **564-byte** response. Before the cap that was the 2-3 MB body I costed in round 1. Ceiling is 101 messages regardless of input.
- `VALIDATION_TRUNCATED_MESSAGE` is a fixed constant. No count, no key names, no schema shape. Nothing to leak.
- Residual, nit-level, worth one sentence somewhere: the caps count **issues and messages, not bytes**, and `unrecognized_keys` is the one built-in message whose length is O(input). Measured: a 127 KB strict-object body of unknown keys is one issue and a 135 KB response — ratio 1.06, so no amplification, but no hard byte ceiling either, and the response echoes the submitted key names verbatim. Contrived schemas can push above 1x (two `strictObject`s intersected report the same key list twice). Not worth a change now; worth knowing before someone claims the error body has a size bound.
- Also outside the cap's reach: `toValidationDetails` is the only capped producer. A throw site that hand-builds `fieldErrors` and attaches it as `details` passes `narrowEnvelope` at any size, because the schema has no length constraint. Nobody does that today.

**3. Did the raw bytes move to the log, and is the log an acceptable destination?** They moved — confirmed in code and by the test `keeps the request bytes a framework 400 quotes out of the response body`, which asserts the token fragment is absent from the raw response. Acceptable as a **strict improvement** over reflecting them into a JSON body, and not acceptable as a resting place. See SEC-10: GC-9's enforcement mechanism is path-based redaction, a message string has no path, and pino will not change that. The exposure was reduced in audience, not removed. TASK-003 should be told that the remedy for this arm is not to serialise the message better but to stop logging it.

**4. F-093's cost — net improvement or forensics regression?** Regression, and I would push back — on the permanent form, not on this round.

The interim is right for the reason SEC-2 asked for: the finding was that two files in one repo stated opposite policies, and they now agree. But look at what the omission actually buys. `err.stack`'s first line **is** `name: message`, and `logError` still writes `name: message` in full. The frames are the only thing dropped, and frames carry file paths and function names of our own source — no user data, no PII, no DSN. So the change removed the entire forensic value of a 500 (which call site threw, through which layers) and left the one field that genuinely sits outside redaction. Today a production 500 logs `unhandled: TypeError: x is not a function` with no `request_id` (until TASK-003) and no frames — that is not a debuggable record, and invariant 9 stays false.

Recommendation for TASK-003's ruling, phrased as the inverse of the current reasoning: log the **frames** (through pino's error serialiser, which puts them in a named field), and treat the **message** as the risky field — truncate it, or put it somewhere `REDACT_PATHS` can name. F-105 already tracks the header comment that still promises the stack.

**5. Is the prototype hazard gone or moved?** Gone. Verified end to end on Node 24.19 / zod 4.4.3 with a Map containing `__proto__`, `constructor` and an ordinary key:

- `Object.fromEntries` produces own properties for all three (`Object.getOwnPropertyNames` → `['__proto__','constructor','ok']`), the result's prototype is still `Object.prototype`, `JSON.stringify` emits all three, and `Object.prototype` is unpolluted. CreateDataProperty, as ADR-0025 claims.
- The object then passes `validationDetailsContract`; the record parse **drops** `__proto__` from its output and keeps `constructor`. It does not set the output's prototype and does not throw. Result: a field literally named `__proto__` loses its errors and nothing else happens — exactly the accepted cost ADR-0026 writes down.
- No pollution sink anywhere in the chain: the accumulator is a Map, the drain is CreateDataProperty, the re-parse builds a fresh object, and `res.json` is `JSON.stringify`. The hazard did not move.

On the phrasing point you raised: **the reviewer's form was the correct one and my parenthetical was imprecise.** "`Object.create(null)` (or a Map)" reads as if returning the Map were equivalent. It is not, and I verified both halves of the reviewer's claim: `validationDetailsContract.safeParse({ fieldErrors: new Map(...) })` fails with `Invalid input: expected record, received Map`, and `JSON.stringify` of it gives `{"fieldErrors":{}}`. Pre-ADR-0026 that would have shipped an empty `fieldErrors` silently; post-ADR-0026 it fails the narrow and drops `details` entirely — a 400 with no field errors at all, still silent to the caller. "A Map drained at the end" is the precise form and the ADR states why. (`Object.create(null)` does parse fine — verified — so it was a viable fix; the ADR rejects it on reader-expectation grounds, which is a taste call I have no quarrel with.)

**6. Is F-097's narrower rule sufficient?** For Juano's decision: **yes, on the merits, with one residual worth pinning.**

The architect's core argument holds and is stronger than my round-1 framing. Every state that returns 409 (`verified`, `provisioning`, `active`) requires a public `CNAME` from the hostname's own zone to `<FLY_APP_NAME>.fly.dev`, and `active` additionally lands in a CT log. An attacker asking "does shortkit serve acme.com" gets the same answer from one DNS query — unauthenticated, unrated, faster than signing up. The 409 confers no capability. Forbidding it on `pending_verification` and `verification_failed` closes the half that *was* a real oracle, and the coexistence rule is what makes it enforceable. Invariant 10's "one bit and nothing else" is now backed at the filter by ADR-0026 rather than by throw-site discipline, which is a stronger position than the one I asked for. I checked the cited enumeration bound and it exists: `rate-limit.md` has a tenant-keyed authenticated write bucket covering every `/api` write, not just `/api/auth/*`.

The residual, which the contract does not currently state: the DNS equivalence is evaluated at verification time, not at 409 time. A row that reached `verified` or `provisioning` and whose CNAME was later removed keeps answering 409 after the public evidence is gone, so the endpoint outlives the fact it claims to be echoing. `active` is durably public via CT, so this only bites the middle two states. One sentence in `domain-provisioning.md` accepting it (or a re-check on conflict) closes it. That does not change my answer on the rule itself. The AC-68 escalation is not mine to settle and I am not re-litigating it.

## Round-1 findings

| Round-1 | Ledger | Status | Note |
|---|---|---|---|
| SEC-1 | F-090 | **ADDRESSED** | TASK-003 `paths` now include `apps/api/src/common/errors/**`; the Produces block names the pino swap with `request_id` and ADR-0022 serialisation, and hands TASK-003 the F-093 policy decision as well. The hole is closed: a TASK that runs in wave 2 can now write the file. **The code needs nothing today** — the filter's `:96` comment is now addressed to an owner that exists, and F-105 already tracks the stale header. The one thing the widening does not fix is that ADR-0022 serialisation cannot redact inside a message string; that is SEC-10, and it is TASK-003's to decide, not TASK-007's to rework. |
| SEC-2 | F-093 | **ADDRESSED** | The two files agree. See question 4 — I would push back on the permanent form, not on the interim. |
| SEC-3 | F-086 / F-087 | **ADDRESSED** | Map drained through `Object.fromEntries`; verified prototype-safe end to end. Direct unit test exists (`constructor` key). Design stub body is now byte-identical to the shipped function, so F-087 is durably closed. Gap, informational: no test uses a literal `__proto__` key — the interesting one, since its behaviour differs (kept by the flatten, dropped by the narrow). ADR-0026 documents it. |
| SEC-4 | F-094 | **ADDRESSED** | Contract amended, code follows it, and the amendment records why the pass-through was wrong. Resolving it as a contract change rather than a code-only fix was correct. |
| SEC-5 | F-095 | **ADDRESSED** | Caps implemented as asked and stated in `error-envelope.md`. 50k issues → 564 bytes. Byte-ceiling residual noted in question 2, nit. |
| SEC-6 | F-096 | **ADDRESSED** | `narrowEnvelope` exists, is applied once to every body, uses parse output, drops on unnamed codes, logs code only. ADR-0026 reverses ADR-0024's accepted cost explicitly and states what it does *not* cover (`message`). SEC-9 is the adjacent variant it does not reach. |
| SEC-7 | F-097 / F-102 | **ADDRESSED** (escalation open) | Invariant 10 plus the `domain-provisioning.md` rule. Declining my remedy on AC-68 grounds was correct; the narrower rule is sufficient — see question 6, with one residual to pin. |
| SEC-8 | F-092 | **ADDRESSED** | The `catch` guard in `catch()` covers the class. It does not add the `typeof toEnvelope === 'function'` probe I suggested, which is fine: the guard converts the mistake into a logged 500 with a valid envelope, which was the whole point, and it also catches the `res.json`/`setHeader` cases. |

## Notes

- **In-scope, checked, clean.** No new endpoint, guard, decorator or authorization decision. No SQL, command, path or template construction — the two `test/support` files changed are comment-only (F-100 rewording; verified the diff touches no executable line). No secret, env read, cookie, CORS header, redirect or HTML anywhere in the diff. No web-surface change at all. Branch order, the `Number.isInteger` status guard, the `headersSent` path and header writing are unchanged from round 1, where I cleared them.
- **Dependency claim confirmed independently.** `git diff --stat c53275b..8c8641e -- '**/package.json' package.json pnpm-lock.yaml pnpm-workspace.yaml` is empty. `zod` appears in no `apps/api` manifest and in no `apps/api/src` import — the only matches under `apps/api/src` are the words "zod" in comments and route names. Nothing added, nothing bumped, no CVE surface.
- **Cosmetic, no security content, not filed:** when the per-key cap trips on `_form` itself, the truncation notice is appended past the cap, so `_form` can hold 11 messages instead of 10.

## Dependencies reviewed

None. The diff adds and bumps no dependency and does not touch a manifest or the lockfile.

**Files referenced** (absolute): `/home/juano/Workspaces/JustJuanoDev/apps/api/src/common/errors/error-envelope.ts`, `/home/juano/Workspaces/JustJuanoDev/apps/api/src/common/errors/exception-filter.ts`, `/home/juano/Workspaces/JustJuanoDev/apps/api/src/common/errors/domain-error.ts`, `/home/juano/Workspaces/JustJuanoDev/apps/api/src/common/errors/exception-filter.spec.ts`, `/home/juano/Workspaces/JustJuanoDev/packages/contracts/src/errors.ts`, `/home/juano/Workspaces/JustJuanoDev/packages/contracts/src/errors.spec.ts`, `/home/juano/Workspaces/JustJuanoDev/.sdlc/foundation/design/adr-0026-what-the-filter-may-put-in-a-body.md`, `/home/juano/Workspaces/JustJuanoDev/.sdlc/foundation/design/contracts/error-envelope.md`, `/home/juano/Workspaces/JustJuanoDev/.sdlc/foundation/design/contracts/domain-provisioning.md`, `/home/juano/Workspaces/JustJuanoDev/.sdlc/foundation/design/contracts/rate-limit.md`, `/home/juano/Workspaces/JustJuanoDev/.sdlc/foundation/design/stubs/packages/contracts/src/errors.ts`, `/home/juano/Workspaces/JustJuanoDev/.sdlc/foundation/tasks/TASK-003.md`.

**CLEAR** — every round-1 finding is addressed, and the two new items (SEC-9, SEC-10) are minors that per the round's rules should be filed and deferred rather than extend the loop. No `owner_slot` assigned on either.
