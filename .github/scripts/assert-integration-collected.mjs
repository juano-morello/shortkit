/**
 * `node .github/scripts/assert-integration-collected.mjs <vitest-json-report>`
 *
 * AC-114, F-064 obligation 2. Produced by: TASK-002.
 *
 * WHY THIS EXISTS. `pnpm test:integration` exiting 0 is not evidence that anything was
 * asserted. TASK-005 removed `passWithNoTests`, so vitest now fails a run that matches
 * no FILES, but a matched file containing no `test()` or `it()` still exits 0. The job
 * stands up a real `postgres:17-alpine`, runs zero assertions, and reports green, which
 * is the failure F-039 exists to prevent arriving one layer deeper: SC-1 would read as
 * proven by a suite that ran nothing.
 *
 * ============================================================================
 * COLLECTED IS NOT EXECUTED. GATE ON EXECUTED (F-187).
 * ============================================================================
 *
 * Round 1 of this script counted `testResults.length` and `numTotalTests` and required
 * both to be non-zero. That passes a suite in which every test is skipped, which is the
 * exact vacuous green it was written to stop. Confirmed in vitest 3.2.7's JSON reporter
 * source rather than inferred:
 *
 *   numTotalTests   = getTests(files).length          // skipped tests INCLUDED
 *   numPendingTests = ... t.mode === 'skip' ...       // where the skips are counted
 *   status: file.result?.state === 'fail' || hasFailedTests ? 'failed' : 'passed'
 *
 * One `testResults` entry per FILE, `passed` whenever nothing in it failed. So changing
 * `describe(` to `describe.skip(` while debugging, and forgetting to change it back,
 * yields `testResults.length === 1`, `numTotalTests === 21`, `numPassedTests === 0`,
 * `numPendingTests === 21`, and vitest exits 0. Round 1's two conditions were both false
 * and it printed OK. `describe.skip` bodies ARE collected; round 1's docblock claimed
 * this script caught them and named the one case it missed.
 *
 * So: at least one file, and at least one test that actually RAN: passed or failed,
 * not pending, not todo. The skipped and todo counts are printed rather than gated on,
 * because AC-114 asks for at least one test, not for the absence of skips, and a
 * conditional skip is a legitimate thing for a suite to contain.
 *
 * It deliberately does NOT assert anything about the pass/fail RATIO: the suite's own
 * exit code is the gate for that, and duplicating it here would mean two things to keep
 * in agreement. `numFailedTests` is counted as executed for exactly that reason: a test
 * that ran and failed still proves the harness reached the database.
 *
 * NOT TYPECHECKED: the root tsconfig's `include` is `["vitest.config.ts"]`, so nothing
 * under `.github/` is in any project's program. Plain ESM, Node runs it as written.
 */
/* global process, console */
import { readFile } from 'node:fs/promises';

const reportPath = process.argv[2];

if (reportPath === undefined || reportPath.trim() === '') {
  console.error(
    'FAIL: no report path given. Usage: node .github/scripts/assert-integration-collected.mjs <vitest-json-report>',
  );
  process.exit(1);
}

let report;

try {
  report = JSON.parse(await readFile(reportPath, 'utf8'));
} catch (error) {
  // A missing or unparseable report is itself the defect: the run that was supposed to
  // produce it either never started or was invoked without `--reporter=json`, and
  // treating that as "nothing to check" is the vacuous pass this script exists to stop.
  console.error(
    `FAIL: could not read the integration suite's JSON report at ${reportPath}: ${error.message}. ` +
      'The `Integration suite` step must run with `--reporter=json --outputFile.json=<this path>`.',
  );
  process.exit(1);
}

/** Any missing or non-numeric count reads as zero, so a malformed report fails rather than passes. */
function count(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

const files = Array.isArray(report.testResults) ? report.testResults.length : 0;
const collected = count(report.numTotalTests);
const passed = count(report.numPassedTests);
const failed = count(report.numFailedTests);
const pending = count(report.numPendingTests);
const todo = count(report.numTodoTests);

// Executed = it produced a result. Derived from the two states that mean the test body
// ran, not by subtracting the skip counts from the total: `numPendingTests` also counts
// `run` and `queued`, so the subtraction would quietly change meaning on a report written
// mid-run.
const executed = passed + failed;

if (files < 1 || executed < 1) {
  console.error(
    `FAIL: the integration suite collected ${String(collected)} test(s) across ${String(files)} ` +
      `file(s) and EXECUTED ${String(executed)} of them ` +
      `(${String(passed)} passed, ${String(failed)} failed, ${String(pending)} skipped, ${String(todo)} todo). ` +
      'AC-114 requires at least one file and at least one test that actually ran. A collected ' +
      'test is not an executed one: a fully `.skip`-ed suite still reports every test in ' +
      '`numTotalTests` and still exits 0 (F-187), so the job would stand up Postgres, assert ' +
      'nothing, and read as coverage it does not have. Check that the suite still matches ' +
      "`**/*.int-spec.ts` (apps/api/vitest.integration.config.ts), that the files it matched " +
      'still contain tests, and that no `.skip` or `.todo` was left behind from debugging.',
  );
  process.exit(1);
}

console.log(
  `OK: the integration suite executed ${String(executed)} test(s) ` +
    `(${String(passed)} passed, ${String(failed)} failed) across ${String(files)} file(s), ` +
    `out of ${String(collected)} collected: ${String(pending)} skipped, ${String(todo)} todo.`,
);
