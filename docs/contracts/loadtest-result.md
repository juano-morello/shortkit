# Contract: load-test result and baseline format

- **Boundary:** the load harness to the CI gate and to the recorded latency commitment.
- **Normative form:** `infra/loadtest/types.ts`, written by TASK-2-11. The design stub is retired (ADR-0039). **Nothing imports it at runtime**: the harness is `.mjs` and the k6 script is `.js`, and no `tsconfig.json` in this repository includes `infra/`, so `pnpm typecheck` does not read it. It is the shape the three files agree on, in one reviewable place, and it is not a compiler-enforced one.
- **Produced by:** TASK-2-11 (harness, baseline and gate; it merges what the design split across TASK-035, TASK-036 and TASK-037).
- **Consumed by:** `infra/loadtest/gate.mjs`, the `performance` CI job, `docs/performance/redirect-baseline.md`.
- **ADRs:** ADR-0018, ADR-0010, ADR-0030 (why the `deployed` environment has no producer).

## Result file

Written by every run to `infra/loadtest/results/<ISO8601>.json`, with the colons replaced by
dashes (`2026-08-19T21-18-07.759Z.json`): the timestamp still sorts chronologically as a
string, which is how `gate.mjs` finds the newest runs, and the name stays checkoutable on a
filesystem that refuses colons. The directory is git-ignored except for that rule; the
committed record is `baseline.json` and `docs/performance/redirect-baseline.md`.

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
  environment: 'ci-containers' | 'local-compose' | 'deployed';

  // Added by TASK-2-11, additively. See infra/loadtest/types.ts for the long form.
  droppedIterations: number;   // k6 dropped these; they are NOT in `requests`
  machine: string;             // what produced the figure
  build: { commit: string; workingTreeDigest: string | null };
}
```

`'local-compose'` was added because ADR-0030 leaves `'deployed'` with no producer, and calling
a loopback compose stack `'deployed'` is exactly the confusion the two-number separation exists
to prevent. `run.mjs` refuses `--environment deployed` for that reason.

`cacheHitRatio` is measured from Redis `keyspace_hits` / `keyspace_misses` around the k6
process, because a hit and a miss are the same 302 to a client and `dbQueryCounter` is
process-global and exposed on no route. The harness warms the cache before it takes the first
reading, so the window is a superset of the measured one: 1.0 over the superset is a stronger
claim than 1.0 over the measured window alone. It also means the Redis instance must not be
shared with anything else for the duration of a run.

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
  machine: string;             // e.g. 'juano, i9-13950HX, 32 logical CPUs, 30 GiB'
  emissionMode: 'deferred-batch';

  /**
   * SC-2's commitment. The design said "measured at 500 RPS against the deployed API with
   * real Upstash"; ADR-0030 left no deployment, so it is measured at 500 RPS against the
   * local compose stack and `environment` says which.
   */
  rate: 500;
  environment: 'ci-containers' | 'local-compose' | 'deployed';
  achievedRate: number;
  p50: number; p95: number; p99: number;
  targetP99: number;           // <= 25 (AC-62). Derived from p99, never chosen first.
  targetP99Basis: string;      // the arithmetic, so it is not silently re-chosen

  /** The PR gate's regression tripwire. NOT a latency commitment. */
  ciRate: 100;
  ciRunner: 'ubuntu-latest';
  ciMeasuredP99: number | null; // null until the performance job has run once
  ciP99BudgetMs: number;        // ciMeasuredP99 plus headroom, or provisional while null
  ciP99BudgetBasis: string;
}
```

`targetP99 <= 25` is asserted by `infra/loadtest/gate.mjs` before it reads a single result, so
a baseline exceeding the ceiling fails the `performance` job on every pull request rather than
being recorded (AC-62, GC-1). It is asserted there rather than in a `*.spec.ts` because the
root vitest config runs `apps/api`, `apps/web` and `packages/contracts`, and `infra/` is in
none of them.

## Harness

```
pnpm loadtest --rate <n> --duration <s> [--warmup <s>] [--target <url>]
```

k6, not a Node generator: the generator must not compete with the application for the
runner's CPUs. Output is the `LoadTestResult` JSON above.

## The two gates

| Job | Trigger | Rate | Infra | Gates on |
|---|---|---|---|---|
| `performance` | every push and pull request | 100 RPS, 30 s, 10 s warm-up, **three runs, median `serverP99`** | `postgres:17-alpine` and `redis:7-alpine` service containers | `median(serverP99) <= ciP99BudgetMs` |
| `performance-full` | **NOT BUILT** | 500 RPS, 60 s | a deployed instance and a managed cache, neither of which exists | `serverP99 <= targetP99` |

Median-of-three is what makes AC-64 pass: one noisy neighbour cannot fail the build.

**`performance-full` has no producer and is not deferred work anybody is holding.** ADR-0030
chose no deploy target, so there is nothing to point it at; the ADR that supersedes ADR-0030 is
what builds it, re-runs the 500 RPS measurement against the deployment and re-derives
`targetP99`. Recorded at length in `docs/performance/redirect-baseline.md`, "The half that is
not built".

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
round trips, passes the PR gate. **The sentence used to end "and is caught by the weekly full
run". It is not: there is no weekly full run** (ADR-0030), so nothing catches that class at
all. `ciP99BudgetMs` is also tied to `ubuntu-latest`'s current hardware; GitHub changing the
runner class invalidates it silently.

## What the implementer must guarantee

- `docs/performance/redirect-baseline.md` states which number is the SC-2 commitment
  and which is the CI tripwire, in prose, so `ciP99BudgetMs` is never quoted as the
  latency commitment.
- TASK-036 measures the baseline against the **complete** redirect path, including
  click emission (TASK-034) and the degradation wrapper (TASK-032). Discharged by TASK-2-11:
  the figures were taken against a tree carrying TASK-2-09's click emission, and the result
  files record the commit and the working-tree digest that was live.
- If the measured `p99` exceeds 25 ms, that is an escalation. **Not** a raised
  `targetP99` (TASK-036's out-of-scope note).

## Versioning

Adding a field to `LoadTestResult` is additive. `LoadTestBaseline` is read by
`infra/loadtest/gate.mjs`; renaming `targetP99`, `ciRate` or `ciP99BudgetMs` breaks it.
