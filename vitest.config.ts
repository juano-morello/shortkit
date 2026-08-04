import { defineConfig } from 'vitest/config';

/**
 * ADR-0001: one runner for all three workspaces. Each project owns its own
 * config because the transform differs — swc for the API's decorator metadata,
 * the React plugin plus jsdom for the web app.
 *
 * This command stays free of Postgres and Redis so AC-1 holds from a clean
 * clone. Integration suites run under `pnpm test:integration`.
 */
export default defineConfig({
  test: {
    projects: ['apps/api', 'apps/web', 'packages/contracts'],
  },
});
