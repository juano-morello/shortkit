/**
 * `node .github/scripts/assert-integration-collected.mjs <vitest-json-report>`
 *
 * AC-114, F-064 obligation 2. Produced by: TASK-002.
 *
 * WHY THIS EXISTS. `pnpm test:integration` exiting 0 is not evidence that anything was
 * asserted. TASK-005 removed `passWithNoTests`, so vitest now fails a run that matches
 * no FILES — but a matched file containing no `test()` or `it()` still exits 0, and so
 * does a file whose suites are all `describe.skip`-shaped at collection time. Either way
 * the job stands up a real `postgres:17-alpine`, runs zero assertions, and reports
 * green, which is the failure F-039 exists to prevent arriving one layer deeper: SC-1
 * would read as proven by a suite that ran nothing.
 *
 * So the workflow asks vitest for a JSON report alongside the human-readable one and
 * this script reads two numbers out of it: how many files were collected, and how many
 * tests. Both must be at least one.
 *
 * It deliberately does NOT assert anything about pass/fail counts — the suite's own exit
 * code is the gate for that, and duplicating it here would mean two things to keep in
 * agreement.
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

const files = Array.isArray(report.testResults) ? report.testResults.length : 0;
const tests = typeof report.numTotalTests === 'number' ? report.numTotalTests : 0;

if (files < 1 || tests < 1) {
  console.error(
    `FAIL: the integration suite collected ${String(files)} file(s) and ${String(tests)} test(s). ` +
      'AC-114 requires at least one of each. A run that stands up Postgres and asserts nothing ' +
      'exits 0 and reads as coverage it does not have — check that the suite still matches ' +
      "`**/*.int-spec.ts` (apps/api/vitest.integration.config.ts) and that the files it matched " +
      'still contain tests.',
  );
  process.exit(1);
}

console.log(
  `OK: the integration suite collected ${String(tests)} test(s) across ${String(files)} file(s).`,
);
