import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * The `pino` restriction itself, named because it has to appear in BOTH blocks below.
 * ESLint REPLACES a rule's options rather than merging them when a later config object
 * configures the same rule, so a second block that listed only `@nestjs/common` would switch
 * this one off for every file it matched — which is the failure the second block exists to
 * prevent, arriving by the other door.
 */
const noSecondPinoInstance = {
  name: 'pino',
  allowTypeImports: true,
  message:
    'Import the shared logger from observability/logger instead. A second pino ' +
    'instance carries none of the redaction or error-field controls (GC-9).',
};

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
      '@typescript-eslint/no-restricted-imports': ['error', { paths: [noSecondPinoInstance] }],
    },
  },
  {
    // F-278, and it is a SECOND CONFIG OBJECT on purpose. Nest's own `Logger` is the cheapest
    // way out of everything the block above installs: `new Logger('x').warn(…)` writes an
    // unstructured, ANSI-coloured line to the same stdout the JSON goes to, reaching neither
    // pino, nor `LOGGABLE_FIELDS`, nor any of the seven doors — and the `pino` restriction
    // says nothing about it, so the bypass lints clean.
    //
    // `db/client.ts` and `tenancy/tenant-context.ts` are ADR-0028's named, bounded exemption:
    // one `new Logger(…)` each, one call site each, each passing a string and no record, and
    // converting them is `app.useLogger(…)`'s job in a later ADR rather than a per-file edit.
    // They are ignored HERE rather than added to the block above, because that block's
    // `ignores` would switch off `no-console` and the `pino` restriction for them as well,
    // which is more than the exemption is for. A THIRD `new Logger(…)` is a finding, not a
    // precedent. `observability/logger.ts` is ignored for the reason the block above ignores
    // it: it is the one file that must construct the pino instance.
    //
    // THE `pino` ENTRY IS REPEATED HERE AND THAT IS LOAD-BEARING — see `noSecondPinoInstance`.
    // Two config objects configuring one rule do not merge; the later one wins outright.
    //
    // `importNames` rather than the whole module: `@nestjs/common` supplies `Module`,
    // `Controller`, `Catch` and the rest across the API, and the `Logger` TYPE
    // `exception-filter.ts` names comes from `pino`, so there is no collision.
    files: ['apps/api/src/**/*.ts'],
    ignores: [
      'apps/api/src/observability/logger.ts',
      'apps/api/src/db/client.ts',
      'apps/api/src/tenancy/tenant-context.ts',
    ],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          paths: [
            noSecondPinoInstance,
            {
              name: '@nestjs/common',
              importNames: ['Logger'],
              message:
                'Import the shared logger from observability/logger instead. Nest’s Logger ' +
                'writes unstructured lines that carry none of the field allowlist or ' +
                'error-field controls (GC-9, ADR-0028).',
            },
          ],
        },
      ],
    },
  },
);
