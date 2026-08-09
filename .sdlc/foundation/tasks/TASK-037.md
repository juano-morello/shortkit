---
id: TASK-037
story: STORY-013
epic: EPIC-003
title: CI performance gate
status: deferred
owner_slot: sdlc-implementer-backend
depends_on: [TASK-036, TASK-002]
paths: [".github/workflows/**", "infra/loadtest/**"]
contracts: [design/contracts/loadtest-result.md]
test_files: []
acceptance: [AC-63, AC-64]
rework_count: 0
---

## Intent

Make the latency commitment enforced rather than recorded.

## Approach

**The CI gate at 500 RPS is an unresolved risk.** The refinement's stated likely resolution is a full-rate run on demand plus a lower-rate regression check in CI. Implement whichever Design chose.

**If Design cannot produce any CI gate, SC-2's wording is revisited at a gate — it is not quietly weakened.** AC-64 requires the gate to be non-flaky at its configured rate; **GC-3** — CI reruns must stay inside the $25/month ceiling.

## Out of scope for this TASK

**Raising the recorded target to make the gate pass.**

## Interfaces

**Consumes**

`baseline.json` and `targetP99` (TASK-036); `pnpm loadtest` (TASK-035); the `ci` workflow (TASK-002).

**Produces**

CI job `performance` failing when p99 exceeds `targetP99`; the documented on-demand full-rate invocation.
