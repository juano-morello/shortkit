import { defineConfig } from 'tsup';

/**
 * ADR-0005: `@shortkit/contracts` ships TypeScript source and has no build step,
 * so the API cannot be emitted file-by-file — `tsc` would leave a
 * `require('@shortkit/contracts')` in the output pointing at a `.ts` entry that
 * Node cannot load. The bundler inlines the workspace source instead, and the
 * emitted bundle is plain JavaScript that only requires published packages.
 *
 * Types are not checked here. `pnpm typecheck` owns that.
 */
export default defineConfig({
  entry: ['src/main.ts'],
  outDir: 'dist',
  format: ['cjs'],
  platform: 'node',
  target: 'node24',
  sourcemap: true,
  clean: true,
  // Runtime dependencies stay external and resolve from node_modules. The
  // workspace package is the exception: it has no built artifact to require.
  noExternal: ['@shortkit/contracts'],
});
