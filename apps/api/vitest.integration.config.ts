import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

/**
 * ADR-0001: the integration suite runs against a live Postgres and is invoked by
 * `pnpm test:integration`, never by `pnpm test`. Keeping it on its own command is
 * what lets `pnpm test` pass from a clean clone with no Docker and no network.
 *
 * `passWithNoTests` holds because the suites arrive later: TASK-005 brings the
 * database and `docker-compose.test.yml`, TASK-056 brings the isolation suite.
 * Until then the command has to exit 0 rather than report a broken runner.
 */
export default defineConfig({
  test: {
    name: 'api-integration',
    environment: 'node',
    include: ['test/**/*.int-spec.ts'],
    setupFiles: ['./vitest.setup.ts'],
    passWithNoTests: true,
  },
  plugins: [swc.vite({ module: { type: 'es6' } })],
});
