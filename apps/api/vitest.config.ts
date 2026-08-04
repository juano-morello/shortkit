import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// ADR-0001: swc, not esbuild. esbuild does not emit `emitDecoratorMetadata`
// and NestJS dependency injection reads it.
export default defineConfig({
  test: {
    name: 'api',
    environment: 'node',
    include: ['src/**/*.spec.ts'],
    setupFiles: ['./vitest.setup.ts'],
  },
  plugins: [swc.vite({ module: { type: 'es6' } })],
});
