---
id: ADR-0018
slug: launch-core
title: Server-measured latency, a 100 RPS median-of-three gate on every PR, and a 500 RPS run on demand
status: accepted
supersedes: null
date: 2026-08-04
---

## Context

`refinement.md` records the risk plainly: shared CI runners are noisy and rate-limited,
a benchmark that fails at random is worse than no benchmark, and SC-2 assumes a CI gate
exists. If Design cannot produce one, SC-2's wording gets revisited at a gate rather
than quietly weakened. AC-64 makes the flakiness requirement testable: three
consecutive runs against an unchanged build must produce the same verdict.

Three things make 500 RPS in CI unreliable, and they are different problems.

The load generator competes with the application for the runner's four vCPUs. A
Node-based generator loses that fight; a Go or Rust one mostly does not.

Client-observed latency on a shared runner includes scheduler jitter and, if the target
is deployed, internet variance. SC-2 asks for **server-side** p99. Measuring
client-side and calling it server-side is the error that makes the number both noisy
and wrong.

At 500 RPS for 60 seconds, each run costs about 30,000 Upstash commands plus Neon
compute. Per push, per branch, that is real money against GC-3's $25 ceiling.

## Decision

**A CI gate exists.** Three layers, and the artifact says which number means what.

**Layer 0: the server measures itself.** The redirect handler wraps its work in
`process.hrtime.bigint()` and emits `Server-Timing: app;dur=<ms>` on every response.
The load harness aggregates that header into its p50, p95 and p99. Client-side timing
is reported separately as `clientP99` and is never gated on. This removes runner
scheduler noise and network variance from the gated number, which is both more correct
against SC-2's wording and dramatically less flaky.

**Layer 1: the PR gate.** Job `performance` on every pull request.

- k6 as the generator, an `ubuntu-latest` runner, the API and a `redis:7-alpine` and
  `postgres:17-alpine` as service containers. Local Redis, not Upstash: the gate
  measures application overhead on the cache-hit path, and Upstash's round trip is
  network variance plus per-command cost.
- 100 RPS, 30 seconds measured, after a 10 second warm-up that is excluded.
- **Three runs, gate on the median p99.** One outlier cannot fail the build. This is
  what makes AC-64 pass, and it is the single most important choice here.
- Fails when the median `serverP99` exceeds `ciP99BudgetMs` from `baseline.json`.
- Total runtime about 2 minutes and 20 seconds. Zero Upstash commands. Zero marginal
  cost beyond runner minutes, which are free for a public repository.

**Layer 2: the SC-2 run.** Job `performance-full`, on `workflow_dispatch` and on a
weekly `schedule`.

- 500 RPS, 60 seconds measured, against the deployed Fly machine with the real Upstash
  cache. This is the configuration SC-2's sentence describes.
- Fails when `serverP99` exceeds `targetP99` from `baseline.json`, which
  AC-62 caps at 25.
- Roughly 30,000 Upstash commands per run. Weekly plus occasional manual runs is a few
  cents a month.

**Layer 3: the artifact separates the numbers.** `infra/loadtest/baseline.json` carries
both, and `docs/performance/redirect-baseline.md` says which is which in prose, so
nobody reads the CI number as the latency commitment.

```json
{
  "measuredAt": "...", "machine": "...", "emissionMode": "deferred-batch",
  "rate": 500, "achievedRate": 0, "p50": 0, "p95": 0, "p99": 0,
  "targetP99": 0,
  "ciRate": 100, "ciP99BudgetMs": 0, "ciRunner": "ubuntu-latest"
}
```

`ciP99BudgetMs` is measured on the same runner class during TASK-036 and set with
headroom above the observed median. It is a regression tripwire, not a latency promise.

**How this reads against SC-2, stated so the gate can rule on it.** SC-2 says a
baseline is measured, a target is recorded, and "a load test in CI fails when the
target regresses", and separately that the target may not exceed p99 ≤ 25 ms at
500 RPS. This design measures the target at 500 RPS, records it, and runs a CI load
test that fails on regression. It does not run the CI test at 500 RPS. That reading is
consistent with SC-2's wording, and it is an interpretation rather than a fact.
**Juano should confirm it at the Design gate.** No wording has been changed.

## Alternatives considered

| Option | Pros | Cons | Why not |
|---|---|---|---|
| 500 RPS on every PR against service containers | Literally matches the rate in SC-2's sentence | The generator and the application share four vCPUs, so p99 measures contention rather than the code. Expect swings well beyond the 25 ms budget, and AC-64's three-runs-agree requirement fails | Produces a gate that fails at random, which the refinement calls worse than no gate |
| 500 RPS on every PR against the deployed Fly machine | Real infrastructure; real cache | Every PR runs load against production, and every PR costs 30,000 Upstash commands. Concurrent PRs interfere with each other's measurements | Cost and interference, and it makes CI able to degrade the live service |
| Single run rather than median-of-three | Three times faster | One noisy neighbour on the runner fails the build. AC-64 is precisely a test for this | The 90 seconds saved is the whole reason the gate can be trusted |
| No gate; measure on demand only | Zero flakiness by construction | SC-2 requires enforcement, not a recorded number. A regression would ship and be found by whoever noticed | Fails SC-2 and is the outcome the refinement said to escalate rather than accept |
| Relative gate: fail if p99 rises more than 20% over the previous run on `main` | Adapts to runner drift | Needs stored history and lets slow drift accumulate: twelve 15% regressions each pass individually | An absolute budget with headroom is simpler and catches drift |
| Autocannon or a Node-based generator | Same language as the project | Competes with the application for the event loop and the same CPUs; its own p99 includes its own scheduling | Measures the generator |

## Consequences

### Positive

- A gate exists on every pull request, so SC-2's enforcement half is real rather than
  aspirational.
- Gating on `Server-Timing` removes runner and network jitter from the number, which
  is both more faithful to SC-2's "server-side" and the main reason the gate is stable.
- Median-of-three makes a single noisy neighbour a non-event, which is what AC-64
  tests.
- The PR gate costs no Upstash commands and no Neon compute beyond a container, so
  GC-3 is unaffected by CI frequency.

### Negative / accepted cost

- **The PR gate runs at 100 RPS, not 500.** A regression that only appears under
  connection-pool or event-loop pressure at 500 RPS passes CI and is caught weekly.
  That is a real detection gap, and it is the cost of a gate that does not lie.
- The PR gate uses local Redis, so a regression caused by Upstash round trips or by a
  change in Redis command count per request is invisible to it. The weekly full run is
  the only thing that sees it.
- `ciP99BudgetMs` is tied to `ubuntu-latest`'s current hardware. GitHub changing the
  runner class silently invalidates the budget, and the symptom is a build that starts
  failing with no code change.
- `Server-Timing` on every redirect response adds a header to the hot path and exposes
  internal timing to anyone who clicks a link. Negligible in bytes, and it is
  information disclosure that a reviewer should be told about deliberately.
- Two numbers in one artifact invites confusion. The document has to work hard to keep
  `ciP99BudgetMs` from being quoted as the latency commitment.
- Roughly 2 minutes 20 seconds added to every pull request.

### Follow-ups this creates

- TASK-029 and TASK-030 emit the `Server-Timing` header.
- TASK-035 owns the k6 script, `--rate` and `--duration`, the excluded warm-up, the
  reported request count, and both `serverP99` and `clientP99` in its output.
- TASK-036 measures both `targetP99` (500 RPS, deployed) and `ciP99BudgetMs` (100 RPS,
  `ubuntu-latest`), and writes a document that keeps them apart.
- TASK-037 owns both jobs, the median-of-three logic, and the documented on-demand
  invocation.
- **Gate item for Juano:** confirm the reading of SC-2 recorded above.
- Contract: `design/contracts/loadtest-result.md`.
