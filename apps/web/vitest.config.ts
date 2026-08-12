import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// ADR-0001: jsdom plus the React plugin. Async React Server Components cannot be
// rendered here; their data functions get unit tests instead.
export default defineConfig({
  test: {
    name: 'web',
    environment: 'jsdom',
    include: ['app/**/*.spec.{ts,tsx}', 'src/**/*.spec.{ts,tsx}'],
    setupFiles: ['./vitest.setup.ts'],
  },
  plugins: [react()],
});
