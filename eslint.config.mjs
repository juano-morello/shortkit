import js from '@eslint/js';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
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
  {
    // ========================================================================
    // REACT HOOK RULES COVER EVERY apps/web MODULE, NOT ONLY THE .tsx ONES.
    // ========================================================================
    //
    // The preset is the plugin's flat `recommended` (`configs.flat.recommended`); the
    // spread keeps its rules and this block's `files` does the scoping the preset leaves
    // to the consumer. Scoped to `{ts,tsx}` rather than `tsx` because hooks are not a JSX
    // feature: `use-session.ts` is a plain .ts module and every rule here must hold in it.
    // Scoped to `apps/web` because React exists only there — the api and contracts trees
    // must lint identically with or without this block.
    //
    // `exhaustive-deps` is raised from the preset's `warn` to `error`: this repo gates on
    // lint, and a warning is a line in a log nobody is required to read. A deliberate
    // dependency omission is restructured (value into the effect, or `useCallback`) rather
    // than disabled; where a documented pattern needs an extra dep the rule cannot see
    // (the focus effects keyed by `attempt`), the dep is listed, not the rule switched off.
    files: ['apps/web/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.flat.recommended.rules,
      'react-hooks/exhaustive-deps': 'error',
    },
  },
  {
    // ========================================================================
    // ACCESSIBILITY RULES FOR THE MARKUP: jsx-a11y ON THE .tsx FILES.
    // ========================================================================
    //
    // The plugin's flat `recommended` (`flatConfigs.recommended`), scoped to the files
    // that contain JSX — `apps/web/**/*.tsx`, there are no .jsx files — so a .ts module
    // or anything under apps/api and packages/contracts never pays for JSX analysis.
    // The preset's `languageOptions` only turns on `ecmaFeatures.jsx`, which the
    // typescript-eslint parser already does for .tsx, so only its rules are taken.
    files: ['apps/web/**/*.tsx'],
    plugins: { 'jsx-a11y': jsxA11y },
    rules: {
      ...jsxA11y.flatConfigs.recommended.rules,
    },
  },
  {
    // ========================================================================
    // packages/contracts MAY IMPORT `zod` AND NOTHING ELSE (ADR-0005, TASK-001, F-086).
    // ========================================================================
    //
    // `apps/web` imports this package's source directly, with no build step
    // (`transpilePackages: ['@shortkit/contracts']`). A Node-only import (`node:*`), a
    // Nest/Express import (`@nestjs/*`), or a server-only driver (`drizzle-orm`, `pg`)
    // here breaks the Next.js build rather than this package's own; a `react` import
    // here would be the reverse mistake, coupling a shared contract to one consumer.
    //
    // A gitignore-style `group` cannot express this: the `ignore` package this rule is
    // built on strips a leading `./`/`../` before matching, so a negation pattern meant
    // to re-permit relative imports (`!./**`) also re-permits every bare package name —
    // proven against `ignore@7.0.6` directly before writing this as a `regex` instead.
    // The regex bans anything that is neither `zod` nor a relative specifier, which is
    // the shape `arrayOfStringsOrObjectPatterns` calls out as the alternative to `group`.
    //
    // Spec files and `vitest.config.ts` are excluded: they import `vitest`, which never
    // ships in what `apps/web` bundles (`transpilePackages` reaches the source `index.ts`
    // re-exports, not `*.spec.ts`), so the rule this ADR states has nothing to say about
    // them.
    //
    // This block does not share its `files` glob with any other rules object in this
    // file, unlike the pre-TASK-060 configuration `eslint.config.mjs:74-77` describes,
    // where a second object matching the same glob silently replaced the first's
    // `no-restricted-imports` options and left it reading as enforced when it was not.
    files: ['packages/contracts/**/*.ts'],
    ignores: ['packages/contracts/**/*.spec.ts', 'packages/contracts/vitest.config.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: '^(?!\\.{1,2}/)(?!zod$).+$',
              caseSensitive: true,
              message:
                'packages/contracts may import zod and its own relative modules only ' +
                '(ADR-0005). apps/web imports this source directly with no build step, so ' +
                'a Node-only or framework import here breaks that build rather than this ' +
                "package's own.",
            },
          ],
        },
      ],
    },
  },
);
