---
id: TASK-036
story: STORY-013
epic: EPIC-003
title: Baseline measurement and recorded latency target
status: todo
owner_slot: sdlc-implementer-backend
depends_on: [TASK-035, TASK-032, TASK-034]
paths: ["docs/performance/**", "infra/loadtest/baseline.json"]
contracts: []
test_files: []
acceptance: [AC-62]
rework_count: 0
---

## Intent

Turn SC-2's mechanism into a committed number.

## Approach

**GC-1** — the recorded p99 target **may not exceed 25 ms**, and it is derived from the measured baseline rather than chosen first.

**The baseline must be measured against the complete redirect path**, including click emission (TASK-034) and the degradation wrapper (TASK-032). Measuring an incomplete path produces a number the shipped system cannot meet. The record states the date, the machine, the rate, and the figures. Prose is human-facing (GC-12).

**Early-warning mitigation worth taking:** take a throwaway measurement right after TASK-030 so a bad number surfaces early; TASK-036 remains the binding one.

## Out of scope for this TASK

The CI gate (TASK-037). **Optimisation to reach a target — if the baseline exceeds 25 ms that is an escalation, not a quiet target relaxation.**

## Interfaces

**Consumes**

`pnpm loadtest` and its result format (TASK-035); the complete redirect path (TASK-032, TASK-034).

**Produces**

`infra/loadtest/baseline.json` — `{ measuredAt, rate, p50, p95, p99, targetP99 }` with `targetP99 <= 25`; `docs/performance/redirect-baseline.md` — the recorded-target artifact SC-2 requires.
