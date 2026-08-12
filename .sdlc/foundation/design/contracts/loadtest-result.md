# Contract: load-test result and baseline format

- **Boundary:** the load harness to the CI gate and to the recorded latency commitment.
- **Normative form:** `infra/loadtest/types.ts`, not yet written. The design stub at `design/stubs/infra/loadtest/types.ts` stands in until TASK-035 lands the file and is retired then (ADR-0039). It is a design-gate scaffold, not a normative form.
- **Produced by:** TASK-035 (harness), TASK-036 (baseline).
- **Consumed by:** TASK-036, TASK-037.
- **ADRs:** ADR-0018, ADR-0010.

## Result file

Written by every run to `infra/loadtest/results/<ISO8601>.json`.

```ts
export interface LoadTestResult {
  measuredAt: string;          // ISO 8601
  target: string;              // base URL under test
  rate: number;                // requested RPS
  achievedRate: number;        // actual RPS over the measured window
  durationS: number;           // measured window, warm-up excluded
  warmupS: number;
  requests: number;            // total in the measured window; GC-3 cost accounting
  errors: number;              // non-2xx and non-302 responses
  /** Server-side, from the Server-Timing `app;dur` header. The gated numbers. */
  serverP50: number;
  serverP95: number;
  serverP99: number;
  /** Client-observed, including network and runner scheduling. Reported, never gated. */
  clientP50: number;
  clientP95: number;
  clientP99: number;
  cacheHitRatio: number;       // must be 1.0 for a cache-hit-path run
  emissionMode: 'deferred-batch' | 'in-request';
  environment: 'ci-containers' | 'deployed';
}
```

`serverP99` is the number SC-2 constrains: "p99 ≤ 25 ms **server-side**". It comes from
`Server-Timing: app;dur=<ms>`, measured with `process.hrtime.bigint()` around the
redirect handler (`redirect-resolution.md`). Gating on client-observed latency would
gate on runner scheduling and internet variance.

**The warm-up window is excluded from every figure.**

## Baseline file

`infra/loadtest/baseline.json`, committed. Two numbers, deliberately separated.

```ts
export interface LoadTestBaseline {
  measuredAt: string;
  machine: string;             // e.g. 'fly shared-cpu-1x, 512MB, iad'
  emissionMode: 'deferred-batch';

  /** SC-2's commitment. Measured at 500 RPS against the deployed API with real Upstash. */
  rate: 500;
  achievedRate: number;
  p50: number; p95: number; p99: number;
  targetP99: number;           // <= 25 (AC-62). Derived from p99, never chosen first.

  /** The PR gate's regression tripwire. NOT a latency commitment. */
  ciRate: 100;
  ciRunner: 'ubuntu-latest';
  ciMeasuredP99: number;
  ciP99BudgetMs: number;       // ciMeasuredP99 plus headroom
}
```

`targetP99 <= 25` is asserted by a test, so a baseline exceeding the ceiling fails
rather than being recorded (AC-62, GC-1).

## Harness

```
pnpm loadtest --rate <n> --duration <s> [--warmup <s>] [--target <url>]
```

k6, not a Node generator: the generator must not compete with the application for the
runner's CPUs. Output is the `LoadTestResult` JSON above.

## The two gates

| Job | Trigger | Rate | Infra | Gates on |
|---|---|---|---|---|
| `performance` | every pull request | 100 RPS, 30 s, 10 s warm-up, **three runs, median `serverP99`** | `postgres:17-alpine` and `redis:7-alpine` service containers | `median(serverP99) <= ciP99BudgetMs` |
| `performance-full` | `workflow_dispatch` and weekly `schedule` | 500 RPS, 60 s | deployed Fly machine, real Upstash | `serverP99 <= targetP99` |

Median-of-three is what makes AC-64 pass: one noisy neighbour cannot fail the build.

## Invariants a caller may rely on

1. `serverP99` excludes network time and load-generator scheduling.
2. `cacheHitRatio` is 1.0 for a cache-hit-path run. A run below it did not measure what
   GC-1 constrains and must be discarded.
3. `requests` lets a reader compute the Upstash command cost of a run (GC-3).
4. `targetP99` never exceeds 25.
5. The PR gate consumes zero Upstash commands and zero Neon compute beyond a container,
   so CI frequency does not affect the bill.

## Stated gap

The PR gate runs at 100 RPS with local Redis. A regression appearing only under
connection-pool or event-loop pressure at 500 RPS, or one caused by a change in Redis
round trips, passes the PR gate and is caught by the weekly full run. `ciP99BudgetMs`
is also tied to `ubuntu-latest`'s current hardware; GitHub changing the runner class
invalidates it silently.

## What the implementer must guarantee

- `docs/performance/redirect-baseline.md` states which number is the SC-2 commitment
  and which is the CI tripwire, in prose, so `ciP99BudgetMs` is never quoted as the
  latency commitment.
- TASK-036 measures the baseline against the **complete** redirect path, including
  click emission (TASK-034) and the degradation wrapper (TASK-032).
- If the measured `p99` exceeds 25 ms, that is an escalation. **Not** a raised
  `targetP99` (TASK-036's out-of-scope note).

## Versioning

Adding a field to `LoadTestResult` is additive. `LoadTestBaseline` is read by
TASK-037's gate script; renaming `targetP99` or `ciP99BudgetMs` breaks it.
