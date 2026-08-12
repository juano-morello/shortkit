# TASK-003 — sdlc-reviewer re-audit r5 (reaudit: raised-only)

Auditor: sdlc-reviewer
Date: 2026-08-10
Scope: the 11 findings this auditor raised (F-109, F-111, F-251, F-252, F-253, F-255, F-256,
F-264, F-270, F-271, F-272). Judged against CURRENT SOURCE at HEAD = e34e542, not against any
report or commit message.
Package read: `.sdlc/foundation/work/TASK-003-review-r5.diff`. All verdicts below are backed by
reading the working-tree files directly.

## Verdict table

| id | verdict | one-line reason |
|---|---|---|
| F-109 | RESOLVED | both "the stack returns when TASK-003 lands the pino error serialiser" sentences are gone; the decided policy is recorded in `exception-filter.ts:270-281` and `main.ts:246-277`, each pointing at `logger.ts` |
| F-111 | RESOLVED | the check ran and was measured before the serialiser was chosen (`logger.ts:688-702`); `error-envelope.md:237-285` now carries the measured answer, and `TASK-003.md:123-129` carries the check itself |
| F-251 | RESOLVED | `logger.child` and `logger.setBindings` are wrapped and scan bindings (`logger.ts:327-356`, `:438-450`); four emitted-byte tests cover the child path, one covers the grandchild |
| F-252 | RESOLVED | the hook's second branch fires on a record whose `err` key is present and whose `msg` is absent (`logger.ts:147-157`, `:475-484`); test at `logger.spec.ts:649-666`; contract invariant 6 states the coverage condition |
| F-253 | RESOLVED | the false invariant is gone: the contract now states the record-getter case as a residual with a four-row throw-site table (`logging-and-headers.md:588-643`) and invariant 7 carves it out explicitly (`:840-842`) |
| F-255 | RESOLVED | residual stated in both required places, under the same escalation rule: `logger.ts:510-515` and `:651-654`, `logging-and-headers.md:552-576` |
| F-256 | RESOLVED | a new emitter ordinal builds the chained error under `error` — a key the WALK owns — and the F-256 test reads that line (`logger.spec.ts:278-281`, `:584-598`); the serialiser-path line is kept as well |
| F-264 | RESOLVED | ordinal 27 builds a real grandchild and the test asserts both halves on one line (`logger.spec.ts:354-360`, `:893-916`); the `.call(logger, …)` mutation now reds it |
| F-270 | RESOLVED | the region is cut between two anchors and compared for EQUALITY, not substring (`logger-contract-drift.spec.ts:66-99`, `:257-280`) |
| F-271 | RESOLVED | the false sentence is corrected in place and the ruling is re-grounded on reach (`logging-and-headers.md:609-625`) |
| F-272 | RESOLVED | ADR-0022 corrects the wave sentence in place AND states the general supersession rule (`adr-0022:47-52`, `:70-73`) |

SURVIVES: none. WITHDRAWN: none. All 11 close.

New findings raised this pass: none at blocker or major. See Notes.

## Detail

### F-109 — RESOLVED
`grep -rn "stack returns\|pino error serialiser" --include=*.ts` returns hits only inside
`.sdlc/foundation/audits/TASK-007-*`; neither source file carries the sentence any more.
- `apps/api/src/common/errors/exception-filter.ts:270-281` — `logError`'s docblock now states the
  landed policy ("`includeMessage` is `isDomainError(...)` and nothing else … the frames go on the
  line either way — that is TASK-003's answer to `error-envelope.md` § 'What the 500 log line
  carries'").
- `apps/api/src/main.ts:246-277` — the `bootstrap().catch` comment states `includeMessage: true`
  with the reason, and points at `observability/logger.ts` for the full policy.
The lost-decision risk the finding described cannot occur: the decision is made, recorded in the
normative section (`error-envelope.md:237-285`) and repeated at both call sites with a pointer.

### F-111 — RESOLVED
`apps/api/src/observability/logger.ts:688-702` records the check being RUN before the serialiser
was chosen: `pino.stdSerializers.err` emits the raw `e.stack` whose first line is
`${name}: ${message}`, "which is exactly what F-111 said to check for", and the module therefore
never uses that serialiser. `stackFrames` (`:793-809`) strips the header twice — by prefix and by
shape — so the reinstatement path the finding named is closed rather than avoided by accident.
The contract half is also done: `error-envelope.md:253-285` replaced the old recommendation with
the measured outcome, including the F-242 correction that `REDACT_PATHS` *can* reach
`err.message`/`err.stack` once serialised. `TASK-003.md:123-129` carries the check as a check.

### F-251 — RESOLVED
- `apps/api/src/observability/logger.ts:335-346` — `inheritedChild`/`inheritedSetBindings` are
  captured from the prototype before installation (line 335/336, installation at 438/445), so the
  wrappers cannot recurse.
- `:354-356` — `bindingsScanned` runs `errorsReplaced(bindings, 1)`, keeping the top-level `err`
  exemption so `serializers.err` still owns that key on the bindings path; a falsy `bindings` is
  handed back so pino's own errors still fire.
- `:438-450` — both installed non-writable, non-configurable.
- Contract invariant 5 (`logging-and-headers.md:820-826`) now says the guarantee "holds whether the
  error arrived in the log record or in logger bindings, through either `logger.child(bindings)` or
  `logger.setBindings(bindings)`", and § "The two wrappers" (`:498-548`) states that replacing them
  with a `formatters.bindings` entry is a removal.
- Emitted-byte tests exist where the finding said the suite had none: `logger.spec.ts:600-616`,
  `:618-630`, `:632-647` (the seam), `:893-916` (grandchild), plus the `setBindings` pair.

### F-252 — RESOLVED
`logger.ts:147-157`: when the second argument is not a string, the hook now takes a second branch
for the record form. `messageWouldBeTakenFromTheError` (`:475-484`) tests exactly what pino tests at
`proto.js:223` — `msg` absent and `err` key present — not `instanceof Error`, so a decorated plain
object under `err` is covered too. The caller's record is handed through unchanged, so its fields
survive; `logger.spec.ts:649-666` asserts both the absent message marker and the surviving
`request_id`. The contract states the same condition and the measured `msg` table at
`logging-and-headers.md:417-442`, and invariant 6 (`:827-833`) writes the requirement into the
caller-facing list. The implementer-guarantee list also now carries "Always pass a fixed context
string" (`:863-866`), which was the second half of the required change.

### F-253 — RESOLVED
The invariant no longer claims it. `logging-and-headers.md:588-607` is a new section titled "A log
call can still throw, and the scan does not stop it (F-253)" whose first sentence is the measured
outcome — the call throws, no line is emitted — with a four-row table naming each throw site
(`_asJson tools.js:167`, the scan's own `{ ...container }`, `cloneSelectively`, `asChindings`) and
whether bare pino behaves the same. Invariant 7 (`:834-842`) keeps only the guarantee that is
actually met — a hostile *error* is survivable — and carves out the hostile record property
explicitly. The implementer-guarantee list adds "Wrap the log call where there is nowhere left to
escape to" (`:875-879`), naming the two call sites the finding named. The source docblock
(`logger.ts:617-643`) says the same thing and no longer implies the scan is throw-free, so contract
and source agree, which was the condition attached to the finding.

### F-255 — RESOLVED
Both places, same escalation rule.
- `logger.ts:510-515` — residual 2 in the `MAX_ERROR_SCAN_DEPTH` list, with the reproduction shape
  and the two remedies.
- `logger.ts:651-654` — `isWalkable`'s own docblock states the consequence, not only the cost
  reason.
- `logging-and-headers.md:552-555` (the shared escalation rule) and `:569-576` (residual 2, with the
  emitted bytes), and invariant 5 is explicitly bounded by it (`:826`).

### F-256 — RESOLVED
The emitter gained ordinal 15 (`logger.spec.ts:278-281`):
`logger.error({ error: chained }, '…')` — the chained error under a key `errorsReplaced` owns. The
F-256 test (`:584-598`) reads that line and asserts both the absence of the raw-body and
error-message markers and that the emitted field set is exactly the policy fields. The old
serialiser-path line is kept as ordinal 9 with its comment corrected to say what it does and does
not lock (`:565-582`), which is what the finding asked for.

### F-264 — RESOLVED
`logger.spec.ts:357-360` builds a real grandchild:
`logger.child({request_id: MARKER}).child({error: parseFailure}).error(…)`.
The test at `:893-916` asserts on the one emitted line both (a) `record.request_id ===
GRANDCHILD_PARENT_BINDING_MARKER` — which is the half the `.call(this, …)` → `.call(logger, …)`
mutation breaks — and (b) that the grandchild's own bindings were scanned (`err_name` present, no
field outside the policy set, neither marker in the raw bytes). Both silent-loss modes the finding
named are now observable.

### F-270 — RESOLVED
`logger-contract-drift.spec.ts:74-75` declares both anchors (`import pino from 'pino';` and
`export interface RequestLogFields`); `normativeRegion` (`:82-99`) cuts between them and throws
rather than returning an approximation when an anchor is missing, out of order, or ambiguous. The
new test at `:257-280` asserts `region === normalisedFence`, so a declaration dropped from the
fence's tail and a declaration added to the source after the region both fail. The original
contiguity test is kept (`:244-255`), which is correct — equality alone would not explain WHERE
they parted, and the divergence reporter is attached to both.

### F-271 — RESOLVED
`logging-and-headers.md:609-616` corrects the sentence in place, names the correction as F-271, and
states the true partition: `_asJson`, `cloneSelectively` and `asChindings` all read the scan's own
output, so rows 1, 3 and 4 would be covered by a sentinel and the row it does not reach is row 2,
the scan's own spread — which is routed to F-259. `:618-625` re-grounds the ruling on reach (the
depth bound and the class-instance skip) plus the copy cost, which is the "other grounds" the
finding said the ruling stood on.

### F-272 — RESOLVED
Both remedies, not one: `adr-0022:47-52` states the general rule ("Wave claims in this ADR's body
are superseded by the TASK cards"), and the body sentence itself is corrected at `:70-73` to
"TASK-003 and TASK-009 are both in wave 2 and run concurrently (`TASK-003.md`, corrected
2026-08-06)". No occurrence of "wave 1" remains in the file.

## Cannot verify from diff

1. **The review package is incomplete.** `TASK-003-review-r5.diff`'s stat lists 18 files;
   `git diff --stat af4e5bb..HEAD -- . ':!.sdlc'` lists 24. Missing from the package: `fly.toml`,
   `Dockerfile`, `.dockerignore`, `infra/deploy.sh`, `eslint.config.mjs`, `pnpm-lock.yaml`. None of
   my 11 findings touches them, so no verdict above depends on this, but a reviewer working from
   the package alone could not check the deploy surface at all. I verified the one cross-file
   numeric coupling that mattered from the working tree instead: `main.ts:28`'s
   `DATABASE_REACHABLE_BUDGET_MS = 20_000` against `fly.toml:94`'s `grace_period = '30s'` — the
   stated relationship holds, and `fly.toml:20-49` settles F-119 by removing `release_command`.
2. **`pnpm test` baseline not re-run.** Per dispatch. I did run the three observability spec files
   directly, because commits `e34e542` and `0cb275e` land AFTER the round-4 implementer report and
   `0cb275e` edits the very contract file `logger-contract-drift.spec.ts` reads: 42 tests pass
   (`logger-contract-drift` 5, `logger` 28, `framework-400-request-body` 9). The drift equality
   assertion added for F-270 is green against the amended contract.
3. **ADR-0028's effect on any of these verdicts.** ADR-0028 replaces `REDACT_PATHS` with
   `LOGGABLE_FIELDS` and is treated as accepted per dispatch, but no code implements it yet
   (`logger.ts:35-64` still ships the path list). Every verdict above is against the shipped
   allowlist-of-paths mechanism. Whether F-253/F-259's sentinel ruling should be revisited under
   ADR-0028 is explicitly left open by the contract (`:627-631`) and is not mine to close.

## Notes

- **The contract's residual list is one short of the source's.** `logger.ts:516-526` states THREE
  residuals — depth 5, class instance, and an error returned by a `toJSON` method (F-265) —
  while `logging-and-headers.md:552` says "**Two shapes**" and invariant 5 (`:826`) says "Bounded by
  the two residuals above". A later TASK reading the normative contract rather than the source
  would believe `{ ctx: { toJSON: () => e } }` is covered by invariant 5; it is not, and the source
  says so. This is the contract half of the already-filed F-265 (minor, open, owner
  sdlc-implementer-backend), whose `required_change` is "state it as a third residual" — the source
  half is done, the contract half is not. Not re-filed as new; flagged so the orchestrator can
  decide whether F-265 closes on the source alone.
- **"Nothing may opt out" is still false in two modules outside this diff.**
  `apps/api/src/db/client.ts:54` and `apps/api/src/tenancy/tenant-context.ts:135` both still carry
  `// TASK-003 replaces this with the pino logger.` over `new Logger(...)`, and
  `tenant-context.ts:247` interpolates `${error.name}: ${error.message}` into a log message — the
  exact shape `logging-and-headers.md:880-884` forbids, and which that contract already names as
  "reported but not fixed". Neither file is in TASK-003's `paths` and neither is in this diff. Both
  are already routed (findings.yaml around line 8226 routes the tenant-context line to TASK-011).
  Recorded here only because they bear on whether TASK-003 can be certified against the contract
  sentence it produced.
- Quality of the fix round, for the record: every one of the eleven was closed by a change that
  also made the closure observable — a test on emitted bytes, an equality assertion, or a contract
  sentence that states the residual instead of denying it. F-253 and F-271 in particular were
  closed by weakening a false claim rather than by widening the code to match it, which is the
  right direction and is rarer than it should be.
