/**
 * Contract: docs/contracts/loadtest-result.md (this file is that contract's normative form)
 * ADR: adr-0018-ci-performance-gate.md (layer 0 measures the server, layer 1 gates on it,
 *      layer 3 keeps the two numbers apart), adr-0010-click-event-write-path.md
 *      (`emissionMode`), adr-0030-no-deploy-target.md (why `environment` has no
 *      `deployed` producer)
 * Produced by: TASK-2-11
 *
 * ============================================================================
 * TWO NUMBERS, AND NOTHING HERE LETS THEM BE CONFUSED.
 * ============================================================================
 *
 * `serverP99` comes from `Server-Timing: app;dur=<ms>`, which the redirect handler measures
 * with `process.hrtime.bigint()` around its own work. It excludes the network, the load
 * generator's scheduling and the runner's. It is the number SC-2 constrains and the only one
 * anything gates on.
 *
 * `clientP99` is what the generator observed on the wire. It moves with the machine, the
 * socket and the runner's CPU contention. It is reported because a large gap between the two
 * is itself a finding, and it is NEVER gated on.
 *
 * `docs/performance/redirect-baseline.md` says the same thing in prose, for the reader who
 * arrives at a figure rather than at a type.
 *
 * Nothing imports this file at runtime: the harness is `.mjs` and the k6 script is `.js`,
 * both of which run outside the TypeScript build. It is the shape those two agree on, in the
 * one place a reviewer can read it, and `tsc` reads it through no project. See the note in
 * `docs/contracts/loadtest-result.md`.
 */

/** Where the target under test was running. */
export type LoadTestEnvironment =
  /** GitHub Actions service containers, the API as a job process. The `performance` job. */
  | 'ci-containers'
  /**
   * `docker compose up` on a developer machine: the production image, a `postgres:17-alpine`
   * and a `redis:7-alpine`, all on loopback. Added by TASK-2-11 because ADR-0030 leaves no
   * deployed target, so this is the closest existing thing to one and pretending it was
   * `deployed` would be the confusion this file exists to prevent.
   */
  | 'local-compose'
  /**
   * A deployed instance with a managed cache. NO PRODUCER EXISTS (ADR-0030). Kept in the
   * union so the ADR that chooses a deploy target has a value to write rather than a type to
   * change.
   */
  | 'deployed';

/** Written by every run to `infra/loadtest/results/<timestamp>.json`. */
export interface LoadTestResult {
  measuredAt: string; // ISO 8601
  target: string; // base URL under test
  rate: number; // requested RPS
  achievedRate: number; // actual RPS over the measured window
  durationS: number; // measured window, warm-up excluded
  warmupS: number;
  requests: number; // total in the measured window; GC-3 cost accounting
  errors: number; // anything that was neither 2xx nor 302

  /** Server-side, from the Server-Timing `app;dur` header. The gated numbers. */
  serverP50: number;
  serverP95: number;
  serverP99: number;

  /** Client-observed, including network and runner scheduling. Reported, never gated. */
  clientP50: number;
  clientP95: number;
  clientP99: number;

  /**
   * Redis `keyspace_hits / (keyspace_hits + keyspace_misses)` across the whole k6 process,
   * warm-up included. The harness warms the cache BEFORE k6 starts, so this window is a
   * superset of the measured one and a 1.0 here is a stronger claim than a 1.0 over the
   * measured window alone. Below 1.0 the run did not measure the cache-hit path GC-1
   * constrains and `gate.mjs` discards it rather than reporting it as slow.
   */
  cacheHitRatio: number;

  emissionMode: 'deferred-batch' | 'in-request';
  environment: LoadTestEnvironment;

  /**
   * ADDITIVE (TASK-2-11), and it is what stops a quiet under-measurement. k6 drops an
   * iteration when the arrival rate outruns the VUs it was given; the dropped requests are
   * not in `requests`, so a run that generated half the load it was asked for would
   * otherwise report a healthy p99 for a load nobody applied. `gate.mjs` refuses a run whose
   * `achievedRate` fell more than 5% short of `rate`.
   */
  droppedIterations: number;

  /**
   * ADDITIVE (TASK-2-11). What produced the figures, so no number in this repository is
   * attributable to "some machine". Free text; `redirect-baseline.md` carries the long form.
   */
  machine: string;

  /**
   * ADDITIVE (TASK-2-11). The tree the target was built from: the commit, plus a digest of
   * the working tree when it was dirty. A baseline measured against an uncommitted tree is
   * still a measurement; one that does not say so is a claim about a commit it never ran.
   */
  build: {
    commit: string;
    /** `sha256(git status --porcelain + git diff)`, or `null` for a clean tree. */
    workingTreeDigest: string | null;
  };
}

/** `infra/loadtest/baseline.json`, committed. Two numbers, deliberately separated. */
export interface LoadTestBaseline {
  measuredAt: string;
  machine: string;
  emissionMode: 'deferred-batch';

  /**
   * ADDITIVE (TASK-2-11). The same shape `LoadTestResult.build` carries, plus a sentence of
   * evidence, because the run that produced a committed baseline is the one nobody can
   * re-run: the machine is somebody's laptop and the tree has moved on. A baseline that names
   * a machine but not a build is half attributed.
   */
  build: {
    commit: string;
    workingTreeDigest: string | null;
    evidence: string;
  };

  /**
   * SC-2's commitment. ADR-0018 layer 2 measures this at 500 RPS against a deployed API with
   * a managed cache; ADR-0030 leaves nothing to deploy to, so the figures below were measured
   * against the local compose stack instead and `environment` says so. The substitution is
   * recorded in `docs/performance/redirect-baseline.md`, not hidden in a number.
   */
  rate: 500;
  environment: LoadTestEnvironment;
  achievedRate: number;
  p50: number;
  p95: number;
  p99: number;
  /** <= 25 (AC-62). Derived from p99, never chosen first. */
  targetP99: number;
  /**
   * ADDITIVE (TASK-2-11). The arithmetic that produced `targetP99`, in one sentence, because
   * a bare number invites the next reader to round it up. A commitment whose derivation is
   * not written down is a number somebody will adjust.
   */
  targetP99Basis: string;

  /** The PR gate's regression tripwire. NOT a latency commitment. */
  ciRate: 100;
  ciRunner: 'ubuntu-latest';
  /**
   * The median `serverP99` of the three runs in the first green `performance` job, or `null`
   * until that job has run. `null` means `ciP99BudgetMs` below is provisional and derived
   * from a local measurement, which is a weaker thing and says so.
   */
  ciMeasuredP99: number | null;
  /** `ciMeasuredP99` plus headroom, and the headroom is stated in the baseline document. */
  ciP99BudgetMs: number;
  /**
   * ADDITIVE (TASK-2-11). The arithmetic behind `ciP99BudgetMs`, and while `ciMeasuredP99` is
   * `null` it also says the budget is provisional. A tripwire nobody can re-derive is a
   * number that gets raised whenever it goes red.
   */
  ciP99BudgetBasis: string;
}
