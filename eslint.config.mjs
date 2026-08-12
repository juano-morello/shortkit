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
    // ========================================================================
    // ONE MODULE, ONE LOGGER: THE SHARED PINO INSTANCE (F-268, F-278, AC-116).
    // ========================================================================
    //
    // `logging-and-headers.md` says "never introduce a second pino instance" and
    // "Consumed by: every API TASK. Nothing may opt out". This block is what makes the
    // second sentence a mechanism rather than a convention. There are three ways out of
    // the shared instance and all three are errors here:
    //
    //   - `pino()` FOR YOURSELF. A second instance gets pino's default `err` serialiser,
    //     no `LOGGABLE_FIELDS`, and none of the mechanisms F-244, F-248, F-251, F-252,
    //     F-258, F-260, F-263 and F-277 installed — with typecheck, lint, the suite and
    //     the drift test all green, because every one of them looks only at the shared
    //     module. The value import is restricted rather than banned outright, because the
    //     TYPE is used legitimately: `exception-filter.ts` names `Logger` from `pino` for
    //     the child it is handed.
    //   - `console.*`. The same hole with no JSON at all: an unstructured line, straight
    //     past GC-9, carrying whatever the call site had.
    //   - `Logger` OR `ConsoleLogger` FROM `@nestjs/common`. The cheapest of the three.
    //     `new Logger('x').warn(…)` writes an ANSI-coloured, locale-clocked line to the
    //     same descriptors the JSON goes to, reaching neither pino, nor the field
    //     allowlist, nor any of the seven doors. `ConsoleLogger` is what `Logger`
    //     delegates to and writes the identical line, so listing `Logger` alone is the
    //     enumeration weakness ADR-0028 rejected for the redact list, one package export
    //     over. AC-116's words are "`Logger` from `@nestjs/common` OR ANY OTHER LOGGER";
    //     both concrete ones are named. `LoggerService` is an interface and reaches no
    //     runtime logger.
    //
    // `importNames` rather than the whole module: `@nestjs/common` supplies `Module`,
    // `Controller`, `Catch` and the rest across the API.
    //
    // ========================================================================
    // THE TWO NAMED EXEMPTIONS ARE RETIRED (TASK-060, AC-116).
    // ========================================================================
    //
    // Until 2026-08-11 the `@nestjs/common` restriction lived in a SECOND config object
    // whose `ignores` named `apps/api/src/db/client.ts` and
    // `apps/api/src/tenancy/tenant-context.ts` — ADR-0028 Migration step 3's "named,
    // bounded exemption", and the two paths `logging-and-headers.md` listed as exceptions
    // to "nothing may opt out". Both modules now emit through the shared instance, so both
    // entries are gone and the claim is true with nothing carved out of it.
    //
    // The split into two config objects existed ONLY to hold those two entries: putting
    // them in this block's `ignores` would have switched off `no-console` and the `pino`
    // restriction for those files too, which is more than the exemption was for. With no
    // exemption left, the two objects matched exactly the same files and configured the
    // same rule — and ESLint REPLACES a rule's options rather than merging them, so the
    // earlier object's `no-restricted-imports` was dead configuration that read as though
    // it were in force. They are merged into this one for that reason, and the `pino`
    // entry no longer has to be duplicated to survive.
    //
    // A `new Logger(…)` anywhere under `apps/api/src` is a finding, not a precedent.
    //
    // ========================================================================
    // THE ONE EXEMPTION, AND WHY BOOTSTRAP DOES NOT GET ONE.
    // ========================================================================
    //
    // `observability/logger.ts` is exempt because it is the file that must construct the
    // pino instance; every other module consumes it. That is the whole list.
    //
    // `main.ts` DOES NOT NEED AN ESCAPE HATCH AND IS NOT GIVEN ONE, and this was checked
    // rather than assumed: it imports `errorLogFields` and `logger` from
    // `./observability/logger` and emits its boot lines through the shared instance, which
    // is available from module evaluation because the instance is built at import of a
    // module that depends on nothing but `pino`. There is no window in which `main.ts` has
    // something to say and no logger to say it through, so a "pre-pino bootstrap" hatch
    // would exempt a path that does not exist and would be inherited by whatever is
    // written in that file next. Nest's OWN bootstrap lines are a different question — a
    // `LoggerService` over the shared singleton, ADR-0028 "What this ADR does not decide" —
    // and it is answered by `app.useLogger(…)` in a later ADR, not by an `ignores` entry
    // here: nothing under `apps/api/src` has to import Nest's `Logger` to make that change.
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
            {
              name: '@nestjs/common',
              importNames: ['Logger', 'ConsoleLogger'],
              message:
                'Import the shared logger from observability/logger instead. Nest’s Logger ' +
                'and ConsoleLogger write unstructured lines that carry none of the field ' +
                'allowlist or error-field controls (GC-9, ADR-0028).',
            },
          ],
        },
      ],
    },
  },
);
