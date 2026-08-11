---
id: STORY-004
epic: EPIC-001
title: Shared contracts and a uniform error surface
status: done
tasks: [TASK-007, TASK-008]
depends_on: [STORY-001]
---

## User story

As Juano, I need one place that defines request/response shapes and error codes, so the web app and API cannot drift.

## Acceptance criteria

- [ ] AC-13: Given an API endpoint that rejects a request, when the response is returned, then its body validates against the shared error contract and carries a stable machine-readable `code` field.
- [ ] AC-14: Given a contract is changed incompatibly in `packages/contracts`, when `pnpm typecheck` runs at the root, then it exits non-zero because `apps/web` no longer compiles.
- [ ] AC-15: Given the web API client receives a response, when the response body does not validate against the declared contract, then the client raises a distinguishable contract-violation error rather than returning malformed data.

Each AC is objectively verifiable. `sdlc-test-architect` turns these into tests
and `sdlc-product-auditor` verifies against them verbatim.

## Definition of Ready

**PASS.**

- [x] ACs are testable and unambiguous
- [x] Dependencies identified
- [ ] Contracts it consumes exist in `design/contracts/` — Design has not run yet
- [x] No blocking open questions

## Definition of Done
- [ ] All ACs green as automated tests
- [ ] All auditors clear of blocker/major
- [ ] Docs updated (README / API / ADR consequences)
- [ ] Observability in place per config
- [ ] Traceable: commits reference TASK ids

## Verification at Ship — 2026-08-11 (F-397)

**No STORY in this initiative recorded its Definition of Done until Ship.** Twenty acceptance
criteria and twenty DoD items across four cards, every one still `- [ ]` while ten TASKs were
`done`. The evidence existed in `state.yaml`, the acceptance report and the integration report; it
was absent from the cards a reader opens. Found by the Ship traceability pass, not by any of the
six audits that ran today.

**Checkboxes are deliberately left unticked and this block records the state instead.** A tick is a
claim with no room for a caveat, and three of this initiative's criteria are not the kind of thing a
tick can honestly carry — one is untestable by construction, one was met by an artifact that no
longer exists, and one has never been observed in the environment it gates. Evidence below, per
criterion, with what is *not* proven stated beside what is.

See `.sdlc/foundation/ship/acceptance-report.md` for the per-criterion verdict and
`ship/integration-report.md` for the evidence. **SC-1 is `untestable`, not "partly met"** — it
quantifies over "every repository method and every authenticated endpoint" and both sets are empty,
so a verbatim reading is vacuously true, which is the shape the harness's own F-295 rule refuses.

**DoD.** Auditors clear of blocker/major: **yes**. Docs updated: **yes**. Observability per config:
**yes**. Traceable: **yes for feature commits**, with five source-touching orphans named in F-398.
