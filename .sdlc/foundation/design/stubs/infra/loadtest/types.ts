/**
 * Contract: design/contracts/loadtest-result.md
 * ADR: adr-0018-ci-performance-gate.md, adr-0010
 * Produced by: TASK-035 (harness), TASK-036 (baseline)
 * Consumed by: TASK-037 (both gates)
 */

export interface LoadTestResult {
  measuredAt: string;
  target: string;
  rate: number;
  achievedRate: number;
  /** Measured window. The warm-up is EXCLUDED from every figure below. */
  durationS: number;
  warmupS: number;
  /** Total in the measured window. Lets a reader compute the Upstash cost (GC-3). */
  requests: number;
  errors: number;

  /**
   * Server-side, aggregated from the `Server-Timing: app;dur=<ms>` header measured
   * with process.hrtime.bigint() around the redirect handler.
   * THESE ARE THE GATED NUMBERS. SC-2 says "server-side".
   */
  serverP50: number;
  serverP95: number;
  serverP99: number;

  /** Client-observed, including network and runner scheduling. Reported, NEVER gated. */
  clientP50: number;
  clientP95: number;
  clientP99: number;

  /** Must be 1.0 for a cache-hit-path run. Below it, the run did not measure GC-1's path. */
  cacheHitRatio: number;
  emissionMode: 'deferred-batch' | 'in-request';
  environment: 'ci-containers' | 'deployed';
}

export interface LoadTestBaseline {
  measuredAt: string;
  machine: string;
  emissionMode: 'deferred-batch';

  /** SC-2's commitment. 500 RPS against the deployed API with real Upstash. */
  rate: 500;
  achievedRate: number;
  p50: number;
  p95: number;
  p99: number;
  /** <= 25 (AC-62, GC-1). Derived from the measured p99, never chosen first. */
  targetP99: number;

  /**
   * The PR gate's regression tripwire. NOT a latency commitment.
   * docs/performance/redirect-baseline.md must keep these apart in prose.
   */
  ciRate: 100;
  ciRunner: 'ubuntu-latest';
  ciMeasuredP99: number;
  /** ciMeasuredP99 plus headroom. */
  ciP99BudgetMs: number;
}

export const CI_GATE_RUNS = 3;
export const CI_GATE_DURATION_S = 30;
export const CI_GATE_WARMUP_S = 10;
export const FULL_RUN_DURATION_S = 60;

/**
 * Median of three, NOT the worst or the mean. One noisy neighbour cannot fail the
 * build, which is what makes AC-64 pass.
 */
export function medianServerP99(_runs: LoadTestResult[]): number {
  throw new Error('not implemented');
}

/** If the measured p99 exceeds 25 ms, that is an ESCALATION, not a raised target. */
export function assertTargetWithinCeiling(_baseline: LoadTestBaseline): void {
  throw new Error('not implemented');
}
