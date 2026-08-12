import { defineConfig } from 'tsup';

/**
 * ADR-0005: `@shortkit/contracts` ships TypeScript source and has no build step,
 * so the API cannot be emitted file-by-file — `tsc` would leave a
 * `require('@shortkit/contracts')` in the output pointing at a `.ts` entry that
 * Node cannot load. The bundler inlines the workspace source instead, and the
 * emitted bundle is plain JavaScript with no `.ts` require left in it.
 *
 * `noExternal` is transitive: the contracts package's own dependencies are
 * inlined with it, so `zod` is compiled into `dist/main.js` rather than
 * required from `node_modules`. Everything else stays external.
 *
 * REQUIRES `@swc/core`, which tsup declares as an OPTIONAL peer dependency and
 * uses to honour `emitDecoratorMetadata`. Without it tsup falls back to esbuild,
 * which emits no `design:paramtypes`, the build still exits 0, and Nest fails to
 * resolve constructor-injected providers at runtime. It is a direct devDependency
 * of this workspace for that reason and must not be removed as unused.
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
