---
id: TASK-035
story: STORY-013
epic: EPIC-003
title: Load-test harness for the cache-hit path
status: todo
owner_slot: sdlc-implementer-backend
depends_on: [TASK-030]
paths: ["infra/loadtest/**", "package.json"]
contracts: [design/contracts/loadtest-result.md]
test_files: []
acceptance: [AC-61]
rework_count: 0
---

## Intent

A repeatable measurement, before any number is committed to.

## Approach

**GC-1** — measures the cache-hit path at 500 RPS and reports server-side p50/p95/p99 plus achieved rate; output is machine-readable so TASK-037 can gate on it; **GC-3** — a 500 RPS run against Upstash has real cost, so the harness must report its request count and support a reduced rate for repeat runs; **the warm-up phase must be excluded from the measured window**.

## Out of scope for this TASK

Choosing the target (TASK-036), CI wiring (TASK-037), profiling or optimisation work.

## Interfaces

**Consumes**

Redirect endpoint and `redirectCache` (TASK-030).

**Produces**

`pnpm loadtest --rate <n> --duration <s>` → writes `infra/loadtest/results/<timestamp>.json` with `{ rate, achievedRate, p50, p95, p99, requests, errors }`.
