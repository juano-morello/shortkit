# TASK-007 scoped re-review — round 3 (fix diff `8c8641e..7913b16`)

> Returned inline by `sdlc-reviewer` (no Write tool) and persisted verbatim by the
> orchestrator on 2026-08-05. Scope: fix round 2's diff only.

Read the whole diff, then read every amended artifact at HEAD in full rather than as hunks: `error-envelope.md`, `logging-and-headers.md`, `adr-0024`, `adr-0026`, `domain-provisioning.md`, `TASK-003.md`, the logger stub, `exception-filter.ts`, `error-envelope.ts`, `errors.ts`, `main.ts`, and the F-102/F-105/F-106/F-107/F-108 ledger entries. Gates not re-run, per dispatch.

## F-106 — ADDRESSED. I traced the delivery path and it closes.

I judged it against the failure it described, not the two lines. Four entry points, all now correct:

1. **`TASK-003.md`** (the file its implementer opens first) → its F-090 block cites `design/contracts/logging-and-headers.md` by name at :65 →
2. **`logging-and-headers.md:85-97`**, the new "The exception filter's error line" section, in the doc whose front matter reads "Produced by: TASK-003" → sends the reader to the named section →
3. **`error-envelope.md:234-274`**, which states what ships, why, the three facts, the owner, and the explicit negation.
4. Independently, **`exception-filter.ts:23`** — the file being rewritten — now names that section by title.

I looked for a fourth artifact pointing the wrong way and grepped `stack` across `design/`, `tasks/`, `apps/api/src/common/errors/` and `main.ts`. Every normative statement now reads name-and-message-not-stack; the two ADR-0024 sites carry amendment blocks, and the struck claim ("the redaction paths in `logging-and-headers.md` already cover the fields") was indeed wrong when written — `REDACT_PATHS` is 17 paths and wildcards over property names, none of which reach inside a string. There is **no exception-filter stub**, so the highest-risk artifact class in this workflow (a stub that gets transcribed) does not exist here. The specific failure F-106 named — implementer reads the normative contract, finds the stack required twice, restores `exception.stack` — is now unreachable from any design artifact.

Three residues remain, all minor, all filed below; none of them is the failure F-106 described.

## F-105 — ADDRESSED

`exception-filter.ts:23` matches `logError` at :234-241 and matches the contract's words, including the "TASK-003's pino error serialiser is the permanent answer" clause my required_change asked for.

## The judgement asked for: is the contract steering, or has it settled a live question?

**The section steers correctly and the restraint landed. It is neither too prescriptive nor too vague — but the contract is now the only artifact holding the question open, and three lower-level artifacts still close it.**

On the section itself, four properties make it actionable rather than vague:

- The current state is stated exactly, and it is exactly right: `${context}: ${name}: ${message}` matches `exception-filter.ts:236` character for character.
- All three "facts TASK-003 needs" are true and independently checkable. `err.stack` beginning `name: message` I accept as verified; the frames' contents claim is sound; the `REDACT_PATHS`-is-path-based claim I confirmed against the list.
- The **default is defined** (no stack) and the section explicitly forbids the passive restoration. So the failure mode of leaving a question open here is the safe branch, not the unsafe one.
- It names where the answer must be recorded ("its ADR or in this section"), which is what stops a decision from evaporating into a report.

On the restraint: stopping short of "truncate the message" is right, and for a reason stronger than the one the report gives. The precondition for any content-level remedy is that message and frames become *named fields*, which is what pino does and what does not exist yet. Prescribing truncation now would be a normative rule written against a shape nobody has built — and this round exists because a previous normative claim about pino's redaction was written without being checked. Declining to repeat that is the correct lesson. The section's net weight ("the reasoning holds" + "TASK-003 is free to reject it") is a recommendation with permission to decline, which is the right pressure for a handoff.

The asymmetry is the finding, not the section: while the contract carefully leaves the stack open, `exception-filter.ts:231`, `main.ts:62` and `TASK-003.md:71-75` all assert or require that the stack comes back. If TASK-003 treats this as settled, it will be those that settle it — the amendment fixed the artifact layer above them and left the layer below.

```yaml
verdict: clear
findings:
  - severity: minor
    kind: contract
    file: apps/api/src/common/errors/exception-filter.ts
    line: 231
    summary: >-
      The `logError` docblock states "the stack returns when TASK-003 lands the pino error
      serialiser", and `main.ts:62` says the same — both assert the outcome the amended
      contract deliberately leaves to TASK-003 to decide.
    failure_scenario: >-
      TASK-003's implementer rewrites `logError`. The docblock sitting on the method it is
      editing tells it the stack returns; `error-envelope.md`'s new section tells it the
      decision is its own, records the auditor's argument for the inverse, and says "what this
      section does not say is that the stack goes to the log". The nearest artifact wins, so
      the frames go back with no reason recorded, and the live question the round existed to
      hand over is answered by a leftover sentence. The outcome is inside what the contract
      permits — this is a lost decision, not a wrong behaviour, which is why it is minor.
      Neither line was touched by this diff; both predate it.
    required_change: >-
      Both comments say what the contract says: TASK-003 owns the answer and either outcome is
      open, with the pointer to the named section. `main.ts` is TASK-003's path too, so the
      pair can move in the same commit that moves the line onto pino.

  - severity: minor
    kind: contract
    file: .sdlc/foundation/tasks/TASK-003.md
    line: 72
    summary: >-
      The F-090 block's "Add to Produces" clause requires the log line to carry "the message and
      stack passed through ADR-0022's serialisation", which prescribes the stack as a
      deliverable, and :79 states as present fact that "exception-filter.ts logs exception.stack
      in full", which stopped being true at F-093.
    failure_scenario: >-
      A Produces clause is what the product auditor checks the TASK against. If TASK-003 takes
      the contract's invitation and decides against logging frames, it fails its own Produces
      clause; if it follows Produces, it has answered the question without reading the section
      that frames it. The stale :79 claim compounds it by describing a repo state that no longer
      exists — though the next sentence ("TASK-007's implementer is making the filter match
      main.ts in the interim") partly self-corrects, which is why this is minor and not major.
      F-108's own ledger entry independently observes that this Produces clause "cannot help"
      for the message. The architect saw this file and ruled no TASK edit was needed, disclosing
      the one line it chose not to add.
    required_change: >-
      The Produces clause states the deliverable as "the log line on pino carrying `request_id`,
      with the stack/message policy decided and recorded", not as a fixed field list; :79 reads
      in the past tense; and the block names `error-envelope.md`'s "What the 500 log line
      carries, and who owns changing it" — the one line the architect identified and left.

  - severity: minor
    kind: contract
    file: .sdlc/foundation/design/contracts/error-envelope.md
    line: 253
    summary: >-
      The one implementation fact that decides whether TASK-003's chosen policy is achievable —
      what `pino.stdSerializers.err` actually emits — exists only in the design report, which is
      not an artifact any implementer reads.
    failure_scenario: >-
      TASK-003's implementer accepts the auditor's recommendation recorded in the section, writes
      "frames in their own field, message treated as the risky one" into its ADR, and reaches for
      `serializers: { err: pino.stdSerializers.err }`. If that serialiser emits the full `err.stack`
      — whose first line is `name: message` — the untruncated message is back on the record inside
      the stack field, and possibly twice, while the ADR records the opposite decision. The
      architect identified exactly this and could not verify it because pino is not installed,
      so it left it out of the contract entirely.
    required_change: >-
      A fourth bullet in the three-facts list phrased as a question rather than a claim: verify
      what the chosen serialiser emits before choosing, because a serialiser that emits the whole
      stack does not give you "frames without message". A question needs no verification to be
      written down and cannot become the next struck claim.
```

## On the three items you flagged

**`_form` overflow decline — accepted, and the decline is better than the change.** I re-derived the bounds against `packages/contracts/src/errors.ts:168-196`: messages read ≤ `MAX_VALIDATION_ISSUES` = 100, per-key push guarded by `messages.length < MAX_MESSAGES_PER_FIELD`, notice appended after, so `_form` reaches exactly 11 and the whole response ceils at 101 — the two numbers the amended docblock states are both correct. The reasoning holds on its merits: the cap exists to bound *caller-derived* text, the notice is a package literal, and dropping a real error to make room for a notice about dropped errors is a worse artifact. The wording change from "10 messages" to "10 **issue** messages" is what actually resolves the ambiguity I filed, and it does it in one word. No contest.

**F-097 residual — taken correctly, and it does not pre-empt F-102.** I read F-102 before judging. F-102 escalates whether AC-68 is amended to require DNS-proof-before-409. The new paragraph at `domain-provisioning.md:199-216` accepts a residual *under the current rule*, states what would force the re-check, and closes by saying the residual disappears **if** F-102 reopens AC-68 — conditional, and it neither asserts AC-68 stands nor implements the ordering. That is the shape that leaves Juano's call intact. The supporting facts check out: `certificate_failed` is not a 409 state (`error-envelope.md` invariant 10 lists `verified`, `provisioning`, `active`), and the 15-minute bound is invariant 1. The honest weakening is the right call and it is in the contract text itself ("the one case where the bound is not hard is a `fly_quota:` backoff"), not only in the report — `domain-provisioning.md:274-276` confirms the backoff holds a row in `provisioning`, so the sentence is accurate rather than defensive.

**Leaving `pino.stdSerializers.err` out of the contract — right on substance, wrong on placement.** Writing an unverified implementation claim into a normative contract is precisely how ADR-0024 acquired "the redaction paths already cover the fields", which this same commit had to strike as wrong-when-written. Not repeating that is correct. But the consequence is that the fact TASK-003 most needs lives in `work/TASK-007-fix-r2-design-report.md`, and F-108's own entry names this failure class ("Recorded in TASK-003 so it reaches an implementer rather than living only in a report, which is the F-064 failure this initiative has filed three times"). The resolution costs nothing, because an instruction to verify is not itself a claim. Filed as the third minor above.

## Cannot verify from diff

- **Whether TASK-003's implementer is actually handed `logging-and-headers.md`.** The architect's delivery argument rests on it being "the document its implementer opens first". `TASK-003.md`'s front matter has `contracts: []` — empty — so if the implement-phase dispatch is built from that field, the contract arrives only because the ⚠ block cites it in prose at :65 and because the doc's own front matter says "Produced by: TASK-003". Both are strong, and `exception-filter.ts:23` is a second independent route into the same section. I cannot verify how the orchestrator composes that dispatch. Pre-existing, not introduced here.
- **`pino.stdSerializers.err`'s shape.** Same reason as the architect: pino is not installed and I did not install it. My finding does not depend on the answer, only on the question being unrecorded.
- **Whether TASK-003 restores the stack.** Unresolvable inside TASK-007; the F-093/F-105/F-106/F-108 cluster closes when the pino serialiser lands.
- **Gates, and that both code lines match their normative sources** — taken from the orchestrator's verification, not re-run, per dispatch.

## Notes

- **The dispatch did not include the Global Constraints verbatim**, though my spec lists them as an input. I read GC-9 from `plan.md:32` myself ("structured logs via pino; no PII in log bodies; click events store `ip_hash`, never raw IP") and used it as the lens. Nothing in this diff regresses against it: the message was always on the log line, F-093 changed only the frames, and the one new exposure (framework-400 raw bytes) is already ledgered as F-108 against TASK-003.
- **F-107's code half is correct and total.** `errorEnvelopeContract` has exactly three keys (`packages/contracts/src/errors.ts:41-45`), so the rebuild-from-`{code, message}` allowlist is complete rather than lossy today, and ADR-0026 now records the cost that lands on whoever adds a fourth. The drop-warn at `exception-filter.ts:155` compares presence, not identity, so removing the identity return does not disturb it. `DomainError.toEnvelope()` already builds a 3-key literal, so no existing path loses anything.
- **Two contracts now document their own invariants being false in the interim** — `error-envelope.md` invariant 9's `request_id` sentence and `logging-and-headers.md` invariant 2. Both say so explicitly with the TASK that repairs them. That is the honest form and I would not change it; recording it so a later auditor does not read either invariant as met today.
- **The logger stub (`design/stubs/apps/api/src/observability/logger.ts`) is silent on error serialisation.** It is the artifact TASK-003 transcribes most literally, and it is the one place a pointer would be impossible to miss. Not a finding — the contract that owns it now carries the section, and adding to the stub is a strengthening rather than a correction.
- **The architect's self-diagnosis is the durable part of this round.** "Additive amendment blocks make it easy to believe a document is current because the new text is" is the mechanism behind F-106, and a grep for the behaviour just changed is the thirty-second check that catches it. That belongs in the retro, not in a finding.

| Finding | Verdict |
|---|---|
| F-106 (major, contract — mine) | **ADDRESSED** — five sites corrected, delivery path traced end to end, no fourth artifact points the wrong way |
| F-105 (nit, implementation) | **ADDRESSED** — `exception-filter.ts:23` matches `logError` and the contract |
| F-107 contract half (design) | **ADDRESSED** — three sites, not the two asked for; the extra one was the authoritative bullet |
| F-107 code half | **ADDRESSED** — `{ code, message }` rebuild; allowlist is total against a 3-key envelope |
| F-097 residual (optional, taken) | **ADDRESSED** — accepted with reasoning, does not pre-empt F-102 |
| `_form` overflow nit (optional, declined) | **ACCEPTED as declined** — reasoning holds, wording fix resolves the ambiguity I filed |
| New: stack-returns comments (`exception-filter.ts:231`, `main.ts:62`) | minor, deferred |
| New: `TASK-003.md` Produces clause + stale :79 | minor, deferred |
| New: `pino.stdSerializers.err` fact lives only in the report | minor, deferred |

**Verdict: APPROVED.** Both dispatched findings are addressed, the amendment is substantively right where it went beyond the finding, and the contract steers TASK-003 toward a decision rather than making it for them. Three deferred minors, none of which extends this loop; the second is worth handing to whoever composes TASK-003's dispatch, since that is the artifact the reader reaches first.
