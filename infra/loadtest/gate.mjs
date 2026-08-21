/**
 * The verdict. `node infra/loadtest/gate.mjs --results-dir <dir> [--runs 3]
 * [--assert-agreement]`
 *
 * Contract: docs/contracts/loadtest-result.md, infra/loadtest/types.ts
 * ADR: adr-0018-ci-performance-gate.md (layer 1: median of three, gated on the SERVER
 *      number, against `ciP99BudgetMs`)
 * Produced by: TASK-2-11
 *
 * ============================================================================
 * WHAT IT GATES ON, AND THE THREE THINGS IT REFUSES TO GATE ON.
 * ============================================================================
 *
 * It gates on `median(serverP99) <= baseline.ciP99BudgetMs`. Median of three, so one noisy
 * neighbour on a shared runner cannot fail a build, which is the whole reason ADR-0018's
 * gate is trustworthy, and what AC-64 tests.
 *
 * It never gates on `clientP99`: that number carries the runner's scheduler and the socket,
 * and gating on it would fail builds for the machine's mood.
 *
 * It never gates on `targetP99` either. `targetP99` is SC-2's commitment, measured at 500 RPS;
 * this job runs at 100 RPS against a container. Comparing a 100 RPS number to the 500 RPS
 * commitment would be reading the tripwire as the promise, which is the confusion
 * `redirect-baseline.md` exists to prevent.
 *
 * ============================================================================
 * A RUN THAT DID NOT MEASURE THE RIGHT THING IS DISCARDED, NOT PASSED.
 * ============================================================================
 *
 * Four validity conditions, each of which makes the percentiles describe something other
 * than the cache-hit redirect path under the requested load:
 *
 *   - `errors` above zero: some responses were not redirects, so the trend mixes them in.
 *   - `cacheHitRatio` below 1.0: a Postgres read landed inside the window
 *     (`loadtest-result.md` invariant 2 says such a run "must be discarded").
 *   - `achievedRate` more than 5% below `rate`: the load was not applied, and a p99 for a
 *     load nobody applied is the most flattering wrong number this harness could report.
 *   - a `rate` other than the one the budget was calibrated at.
 *
 * All four exit 2 (invalid), distinct from exit 1 (measured, and over budget). Nothing here
 * "passes with a warning": the point of the gate is that there is no such state.
 *
 * ============================================================================
 * NEVER WEAKEN THIS SCRIPT TO MAKE A RUN PASS.
 * ============================================================================
 *
 * If the gate goes red, the answers are: fix the regression, or re-calibrate
 * `ciP99BudgetMs` DELIBERATELY with the new figure and the reason recorded in
 * `docs/performance/redirect-baseline.md`, or de-gate the job through the recipe in
 * `.github/workflows/ci.yml`. Loosening a comparison here, dropping a validity check, or
 * taking the best of three instead of the median removes the signal while leaving the green
 * check, which is worse than having no gate at all.
 */
/* global process, console */
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, readdirSync } from 'node:fs';
import { parseArgs } from 'node:util';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_BASELINE = join(HERE, 'baseline.json');
const DEFAULT_RESULTS_DIR = join(HERE, 'results');

/** How far short of the requested rate a run may land before it is not a measurement. */
const RATE_TOLERANCE = 0.95;

const { values } = parseArgs({
  options: {
    baseline: { type: 'string', default: DEFAULT_BASELINE },
    'results-dir': { type: 'string', default: DEFAULT_RESULTS_DIR },
    runs: { type: 'string', default: '3' },
    /**
     * AC-64: three consecutive runs against an unchanged build produce the SAME verdict.
     * Off by default, because median-of-three exists precisely so that one disagreeing run
     * does not fail a build (ADR-0018). It is the calibration check a human runs locally
     * after changing the budget or the runner, and it is what the harness's own verification
     * asserts by exit code.
     */
    'assert-agreement': { type: 'boolean', default: false },
  },
  allowPositionals: false,
});

const baseline = JSON.parse(readFileSync(resolve(values.baseline), 'utf8'));

/**
 * AC-62 / GC-1: `targetP99` may not exceed 25 ms, "asserted by a test, so a baseline
 * exceeding the ceiling fails rather than being recorded" (`loadtest-result.md`).
 *
 * It lives here rather than in a `*.spec.ts` because the root vitest config runs three
 * projects (`apps/api`, `apps/web`, `packages/contracts`) and `infra/` is in none of them.
 * This script runs on every pull request through the `performance` job, so the assertion is
 * made at least as often as a unit test would make it, against the file that would carry the
 * violation.
 */
if (!(baseline.targetP99 <= 25)) {
  invalid(
    `baseline.targetP99 is ${String(baseline.targetP99)} ms, above AC-62's 25 ms ceiling. A ` +
      'baseline over the ceiling is refused rather than recorded: raising the target is not ' +
      'how a slow measurement is answered (loadtest-result.md, "What the implementer must ' +
      'guarantee").',
  );
}

const runs = Number(values.runs);

if (!Number.isInteger(runs) || runs < 1 || runs % 2 === 0) {
  invalid(`--runs must be an odd positive integer so a median exists without a tie-break; got ${String(values.runs)}`);
}

const results = newestResults(resolve(values['results-dir']), runs);

for (const [path, result] of results) {
  assertUsable(path, result);
}

const serverP99s = results.map(([, result]) => result.serverP99);
const median = [...serverP99s].sort((a, b) => a - b)[(serverP99s.length - 1) / 2];
const budget = baseline.ciP99BudgetMs;

console.log(`baseline ${values.baseline}`);
console.log(`ciP99BudgetMs ${String(budget)} ms   (a regression tripwire, NOT the latency commitment)`);
console.log(`targetP99     ${String(baseline.targetP99)} ms   (SC-2's commitment, measured at ${String(baseline.rate)} RPS; not gated here)`);
console.log('');

for (const [path, result] of results) {
  const verdict = result.serverP99 <= budget ? 'within' : 'OVER';

  console.log(
    `${path}\n  server p50 ${fmt(result.serverP50)}  p95 ${fmt(result.serverP95)}  ` +
      `p99 ${fmt(result.serverP99)} ms  [${verdict} budget]   client p99 ${fmt(result.clientP99)} ms (never gated)`,
  );
}

console.log('');
console.log(`median server p99 across ${String(results.length)} run(s): ${fmt(median)} ms`);

const verdicts = serverP99s.map((p99) => p99 <= budget);
const agreed = verdicts.every((verdict) => verdict === verdicts[0]);

console.log(`per-run verdicts agree (AC-64): ${agreed ? 'yes' : 'NO'}`);

if (values['assert-agreement'] && !agreed) {
  console.error(
    '::error::the runs disagreed on the verdict against an unchanged build (AC-64). The budget ' +
      'is too close to the measured p99, or the machine was not quiet. Re-calibrate ' +
      'ciP99BudgetMs with the headroom recorded in docs/performance/redirect-baseline.md; do ' +
      'not widen it silently to make this pass.',
  );
  process.exit(1);
}

if (median > budget) {
  console.error(
    `::error::median server p99 ${fmt(median)} ms exceeds ciP99BudgetMs ${String(budget)} ms. ` +
      'This is a performance regression on the redirect path, or a deliberate change that ' +
      'needs the budget re-calibrated and recorded. Do not weaken infra/loadtest/gate.mjs.',
  );
  process.exit(1);
}

console.log(`PASS: ${fmt(median)} ms <= ${String(budget)} ms`);

/* ========================================================================== *
 * READING THE RUNS
 * ========================================================================== */

function newestResults(dir, count) {
  let names;

  try {
    names = readdirSync(dir);
  } catch (error) {
    invalid(`could not read ${dir}: ${error.message}`);
  }

  /** ISO 8601 sorts chronologically as a string, which is why the file is named that way. */
  const chosen = names
    .filter((name) => name.endsWith('.json') && !name.startsWith('.'))
    .sort()
    .slice(-count);

  if (chosen.length !== count) {
    invalid(
      `expected ${String(count)} result file(s) in ${dir}, found ${String(chosen.length)}. ` +
        'Run `pnpm loadtest` that many times first; a gate with fewer runs than it claims is ' +
        'the failure mode this repository already has a finding for.',
    );
  }

  return chosen.map((name) => [join(dir, name), JSON.parse(readFileSync(join(dir, name), 'utf8'))]);
}

function assertUsable(path, result) {
  if (result.rate !== baseline.ciRate) {
    invalid(
      `${path} was measured at ${String(result.rate)} RPS and the budget is calibrated at ` +
        `${String(baseline.ciRate)} RPS. Different loads are different measurements.`,
    );
  }

  if (result.requests === 0) {
    invalid(`${path} recorded no requests`);
  }

  if (result.errors !== 0) {
    invalid(`${path} recorded ${String(result.errors)} error(s); the percentiles mix in responses that were not redirects`);
  }

  if (result.cacheHitRatio < 1) {
    invalid(
      `${path} has cacheHitRatio ${String(result.cacheHitRatio)}; it did not measure the ` +
        'cache-hit path (loadtest-result.md invariant 2)',
    );
  }

  if (result.achievedRate < result.rate * RATE_TOLERANCE) {
    invalid(
      `${path} achieved ${fmt(result.achievedRate)} RPS of ${String(result.rate)} requested ` +
        `(${String(result.droppedIterations)} dropped iteration(s)); the load was not applied`,
    );
  }
}

function fmt(value) {
  return value.toFixed(3);
}

/** Exit 2: nothing was measured. Distinct from exit 1, which is a measurement over budget. */
function invalid(message) {
  console.error(`::error::${message}`);
  process.exit(2);
}
