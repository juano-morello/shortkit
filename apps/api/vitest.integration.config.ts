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
  },
  plugins: [swc.vite({ module: { type: 'es6' } })],
});
