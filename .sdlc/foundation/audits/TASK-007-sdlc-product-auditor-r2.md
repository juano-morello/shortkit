# TASK-007 fix round 2 — product audit (scoped re-review)

> Returned inline by `sdlc-product-auditor` and persisted verbatim by the orchestrator on
> 2026-08-05. Scope: the fix diff `c53275b..8c8641e`. Dispatched after the other two
> round-2 audits — an orchestrator omission, disclosed in the dispatch.

Reviewed: fix diff `c53275b..8c8641e` (stat + full diff), round-1 audit, both round-2 audits already returned, `STORY-004.md`, `error-envelope.md`, `adr-0026-what-the-filter-may-put-in-a-body.md`, the amended `test-strategy.md` AC-14 entry, `TASK-007.md`, relevant `findings.yaml` entries (F-088, F-089, F-091, F-095, F-096), and the new test files (`errors.spec.ts`, `exception-filter.spec.ts`) and production files (`error-envelope.ts`, `exception-filter.ts`). Gates not re-run, per instruction.

## F-088 / F-089 / F-091 — ADDRESSED/NOT ADDRESSED

| Finding | Verdict | Evidence |
|---|---|---|
| F-088 | **ADDRESSED** | `packages/contracts/src/errors.spec.ts` adds 6 direct tests on `isZodError`/`toValidationDetails`, including the two load-bearing rules I named: `'lands an issue with an empty path under the _form key'` and `'collapses two issues under one parent to a single first-segment key'`, plus an extra test keeping a `constructor`-named field (guards F-086's fix) and one asserting message order under a collapsed key. |
| F-089 | **ADDRESSED, exceeds the ask** | `exception-filter.spec.ts` adds four new tests (one existing test was amended, not counted twice): `'answers 400 validation_failed for a framework exception carrying a 400'`, `'answers 500 internal_error for a framework exception with an unmapped status'` (the two I asked for), plus `'keeps the request bytes ... out of the response body'` and `'keeps an unmapped framework exception's message out of the response body'` (extra, tracing to F-094/ADR-0026). Both real probes go through real HTTP against a booted `AppModule`, matching the discipline of the rest of the file. |
| F-091 | **ADDRESSED** | `test-strategy.md`'s AC-14 entry now carries a "Revised 2026-08-05 (F-091)" block with the two-mutation table I asked for, and takes option (a) explicitly: "AC-14's literal clause covers only the first row... If TASK-002 ships only the first row, the API-only exports are an unenforced surface and this entry is the record that they are." That is the exact form of closure my finding asked for — an explicit, reasoned scope call rather than a silent gap. |

## AC-13 / AC-14 re-judgement

**AC-13 — now MET.** All branches the contract mandates have direct test evidence via real HTTP probes: DomainError (plain/headers/details/second-module-graph), ZodError (with the two ADR-0025 rules now directly unit-tested), HttpException-404, HttpException-400 (both the code and the fixed-message body), HttpException-any-other-status (413 fallback), and branch-4 unmapped-throwable. The two gaps I filed in round 1 — zero coverage on the 400 and any-other-status sub-branches, and zero direct coverage on `isZodError`/`toValidationDetails` — are both closed. I found no remaining untested branch in the four-branch table.

**AC-14 — still `untestable`, correctly, and the reasoning is now sound end to end.** AC-14 was never testable as a vitest assertion (it's a build property), and remains so; nothing in this diff changes that classification. What changed is that the recorded compensating mechanism now honestly states its own limit instead of silently covering less than it claimed. I have no better alternative to offer either.

## The two flagged items

**1. Exported, unimported cap constants — reviewer is right.** `error-envelope.md`'s "Normative types" section declares `MAX_VALIDATION_ISSUES`, `MAX_MESSAGES_PER_FIELD`, `VALIDATION_TRUNCATED_MESSAGE` as `export declare const`, on the same footing as `ERROR_CODE_STATUS` and `FORM_ERROR_KEY` above them. This contract is the normative artifact 17 downstream TASKs read to know what they may import; not exporting a value the contract lists as exported would be the implementer silently narrowing the contract's surface, which is a worse failure mode than an unused export sitting idle until a consumer needs it (e.g., `apps/web` wanting `VALIDATION_TRUNCATED_MESSAGE` to render truncation distinctly from a real field error). This is contract fidelity, not speculative surface.

**2. `narrowEnvelope` — legitimate TASK-007 scope, not a TASK nobody minted.** Three things line up: (a) it lives in `apps/api/src/common/errors/error-envelope.ts`, inside TASK-007's own declared `paths` (`apps/api/src/common/errors/**`); (b) TASK-007's `Produces` clause is literally "the API-side exception filter that serialises thrown errors into `ErrorEnvelope`," which is exactly what this function does; (c) it was routed through the process correctly — filed as `F-096` by `sdlc-security-auditor` in round 1, ruled on by `owner_slot: sdlc-architect` who wrote `ADR-0026` reversing the specific ADR-0024 consequence, then implemented by TASK-007's own assigned implementer. TASK-007 has not shipped yet; fixing a security gap in its own unshipped file via an amended ADR is the fix-round mechanism working as designed, not scope quietly growing past the STORY. I checked whether it reaches outside TASK-007's boundary (e.g., forcing a change to `apps/web` or another TASK's files) — it does not; `apps/web`'s only contract import is `ERROR_CODE_STATUS`, untouched.

Net: I re-ran my own "shipped but not asked for" check specifically willing to reach the opposite conclusion from round 1, and still find none. The caps, `narrowEnvelope`, and the eleven new tests all trace to filed findings (F-095, F-096) resolved through the design channel, inside TASK-007's own paths, and none of them touch a file, a public API, or a behavior outside what TASK-007 already owned.

## Out-of-scope items that got built

None. The doc-only changes to `test/support/psql.ts` and `rls-fixture.ts` are comment/ownership-attribution corrections (confirmed by diff — no executable line changed), and the touches to `TASK-002.md`, `TASK-003.md`, `refinement.md`, `plan.md`, `state.yaml` are ledger/routing bookkeeping for other findings (F-090, F-099, F-100), not production scope for TASK-007.

## What I am not re-litigating

The reviewer's new major (`error-envelope.md:192`/`:398` still says the stack goes to the log after F-093 removed it) and the security auditor's SEC-9/SEC-10 minors are real and already correctly filed by the auditors whose territory they are — log-line contract text and the `details === undefined` reference-return edge case, respectively. Neither affects AC-13 as written (both are about the log or a currently-unreachable subclass override, not about the response body validating against the contract today), so they don't change my AC judgement, but they remain open items on the ledger.

## Verdict

**APPROVED** (product-auditor scope: AC-13/AC-14 and scope-growth check). All three of my round-1 findings are addressed, AC-13 is now fully evidenced and I judge it met, AC-14's classification is unchanged and its documented mechanism is now honest about its own limit, and the round's scope growth (cap constants, `narrowEnvelope`, truncation notice) traces cleanly to filed findings resolved inside TASK-007's own paths — I do not find it has quietly become a larger TASK than STORY-004 describes. This does not override the reviewer's open major on the stale contract text, which stands on its own track.
