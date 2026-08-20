import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

/**
 * ADR-0001: the integration suite runs against a live Postgres and is invoked by
 * `pnpm test:integration`, never by `pnpm test`. Keeping it on its own command is
 * what lets `pnpm test` pass from a clean clone with no Docker and no network.
 *
 * `passWithNoTests` was set by TASK-001 so the command would exit 0 before any
 * suite existed, and removed by TASK-005 (F-064) with the first real `.int-spec.ts`.
 * A run that matches nothing is now a failure: while the flag stood, an integration
 * run matching no files was indistinguishable from one that passed.
 */
const INTEGRATION_SPEC = '**/*.int-spec.ts';

const NAMED_LIKE_AN_INTEGRATION_SPEC = /\.int[-.]spec\.ts$/;
const MATCHED_BY_INCLUDE = /\.int-spec\.ts$/;

/**
 * A suite filed under a name the glob misses would otherwise report nothing at
 * all. A file named like an integration spec but outside the pattern fails the
 * command loudly instead of disappearing from it.
 */
function assertEveryIntegrationSpecRuns(): void {
  const workspace = fileURLToPath(new URL('.', import.meta.url));

  const unmatched = readdirSync(workspace, { recursive: true, encoding: 'utf8' }).filter(
    (entry) =>
      !entry.startsWith('node_modules') &&
      !entry.startsWith('dist') &&
      NAMED_LIKE_AN_INTEGRATION_SPEC.test(entry) &&
      !MATCHED_BY_INCLUDE.test(entry),
  );

  if (unmatched.length > 0) {
    throw new Error(
      `these look like integration suites but '${INTEGRATION_SPEC}' does not match them, so they would never run: ${unmatched.join(', ')}. Rename them to *.int-spec.ts.`,
    );
  }
}

assertEveryIntegrationSpecRuns();

export default defineConfig({
  test: {
    name: 'api-integration',
    environment: 'node',
    include: [INTEGRATION_SPEC],
    setupFiles: ['./vitest.setup.ts'],
    /**
     * ONE FILE AT A TIME (F-134). vitest runs the tests inside a file in sequence
     * but runs FILES in parallel, and every integration suite here shares one
     * database and one fixture that drops and recreates its tables per test. A
     * second `.int-spec.ts` therefore fails with `relation "rls_fixture_rows" does
     * not exist` when another file's setup drops the table mid-query: hit while
     * placing this round's tests, not predicted. TASK-006 and TASK-056 both add
     * files here within two waves.
     *
     * Serialising rather than giving each file its own table name, for two reasons.
     * Per-file tables would keep the wall clock but make each suite assert against
     * a table shaped like the real ones rather than the one the other suites use,
     * and the races that remain (a shared `tenants` root, a shared role, the
     * connection pool's `max` divided across workers) are not solved by renaming a
     * table. And the cost is small and bounded: these suites are dominated by round
     * trips to one Postgres, which is itself the serialisation point.
     */
    fileParallelism: false,
  },
  plugins: [swc.vite({ module: { type: 'es6' } })],
});
