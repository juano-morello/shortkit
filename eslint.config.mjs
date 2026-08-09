import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      // Inert design artifacts. `design/stubs/**` holds sources at the paths they
      // will occupy; the TASK that materialises one lints it then.
      '.sdlc/**',
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/coverage/**',
      'apps/web/next-env.d.ts',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    // F-268. `logging-and-headers.md` says "never introduce a second pino instance" and
    // `observability/logger.ts` says "Consumed by: every API TASK. Nothing may opt out" —
    // and until this block existed, both were enforced by nothing. A module that calls
    // `pino()` for itself gets no redact list, pino's default `err` serialiser and none of
    // the mechanisms F-244, F-248, F-251, F-252, F-258, F-260 and F-263 installed, with
    // typecheck, lint, the suite and the drift test all green, because every one of them
    // looks only at the shared module. `console.*` is the same hole with no JSON at all:
    // an unstructured line, straight past GC-9, carrying whatever the call site had.
    //
    // The value import is restricted rather than banned outright, because the TYPE is used
    // legitimately — `exception-filter.ts` names `Logger` for the child it is handed — and
    // the shared module itself is the one file that must construct the instance.
    files: ['apps/api/src/**/*.ts'],
    ignores: ['apps/api/src/observability/logger.ts'],
    rules: {
      'no-console': 'error',
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'pino',
              allowTypeImports: true,
              message:
                'Import the shared logger from observability/logger instead. A second pino ' +
                'instance carries none of the redaction or error-field controls (GC-9).',
            },
          ],
        },
      ],
    },
  },
);
