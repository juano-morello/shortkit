---
id: STORY-013
epic: EPIC-003
title: The redirect latency commitment
status: deferred
tasks: [TASK-035, TASK-036, TASK-037]
depends_on: [STORY-011, STORY-012, STORY-002]
---

## User story

As Juano, I need a measured baseline, a recorded target, and a CI gate that catches regressions, so SC-2 is enforced rather than claimed.

## Acceptance criteria

- [ ] AC-61: **(SC-2)** Given the load-test harness, when it is run against the cache-hit path at 500 RPS, then it emits p50, p95 and p99 server-side latency and the achieved request rate, in a machine-readable file.
- [ ] AC-62: **(SC-2)** Given the baseline run has completed, when the committed target artifact is read, then it records the baseline figures, the chosen target, and the date measured — and the recorded p99 target is **≤ 25 ms**.
- [ ] AC-63: **(SC-2)** Given the recorded target, when the performance gate runs against a build whose p99 exceeds the recorded target, then the gate exits non-zero; and when p99 is within target, it exits 0.
- [ ] AC-64: Given the performance gate runs in CI, when three consecutive runs execute against an unchanged build, then all three produce the same pass verdict (the gate is not flaky at its configured rate).

Each AC is objectively verifiable. `sdlc-test-architect` turns these into tests
and `sdlc-product-auditor` verifies against them verbatim.

## Definition of Ready

**CONDITIONAL PASS.** AC-63/AC-64 assume a CI gate exists at a rate that is not flaky on shared runners. `refinement.md` flags this as unresolved. **Both branches must be held:** (a) a full-rate CI gate, or (b) an on-demand full-rate run plus a reduced-rate CI regression check. **If Design can produce neither, SC-2's wording is revisited at a gate — it is not weakened quietly.**

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
