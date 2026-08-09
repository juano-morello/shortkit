/**
 * Lets a plain `node` child process import this workspace's TypeScript, decorators and all.
 *
 * ⚠ THIS FILE IS sdlc-test-architect'S, like the rest of `apps/api/test/support/**`.
 *
 * ## Why it exists
 *
 * A suite that asserts on the BYTES the shared logger writes has to read file descriptor 1,
 * and the only way to read another process's fd 1 is to be its parent — so those suites
 * spawn a child and capture its stdout (`src/observability/logger.spec.ts` is the first).
 * A child that has to boot Nest imports `@Module` and `@Catch`, and neither of Node's own
 * TypeScript modes will load them: `--experimental-strip-types` and
 * `--experimental-transform-types` both fail with `Invalid or unexpected token` on the
 * decorator, measured on Node 24.19. `apps/api` compiles with `emitDecoratorMetadata`
 * (ADR-0001) and that is what swc is here for in the first place.
 *
 * `test/support/api-server.ts` solves the same problem by running `tsup` and spawning
 * `dist/main.js`. That is right for a suite about the composition root — it boots the API
 * the way the platform does — and wrong for one that needs no database: `main.ts` refuses to
 * start until it has connected to Postgres and checked the runtime role (F-116, F-245), so
 * it can only run behind `docker-compose.test.yml`. A child that builds the app from
 * `AppModule` opens no socket but its own, which is what keeps the suite in `pnpm test`.
 *
 * ## What it does not do
 *
 * No type checking — `pnpm typecheck` owns that — and no source maps, so a stack trace out
 * of the child names transformed line numbers. It transforms `.ts` on load and resolves the
 * extensionless relative specifiers TypeScript source is written with; nothing else.
 *
 * The transform mirrors `vitest.config.ts`'s `unplugin-swc` settings, because the child has
 * to load the same sources the in-process suites do.
 */
import { existsSync, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
// `URL` is imported rather than taken from the global scope so that this file lints under
// `js.configs.recommended`, which declares no environment for a bare `.mjs`.
import { fileURLToPath, URL } from 'node:url';

import { transformSync } from '@swc/core';

registerHooks({
  /**
   * TypeScript source imports `./exception-filter`, and Node resolves that to a file that
   * does not exist. Only relative and absolute specifiers are retried, and only after
   * Node's own resolution has already failed, so nothing here can shadow a real module.
   */
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (failure) {
      const relative = specifier.startsWith('.') || specifier.startsWith('/');

      if (context.parentURL === undefined || !relative) {
        throw failure;
      }

      for (const suffix of ['.ts', '/index.ts']) {
        const candidate = new URL(specifier + suffix, context.parentURL);

        if (existsSync(fileURLToPath(candidate))) {
          return { url: candidate.href, format: 'module', shortCircuit: true };
        }
      }

      throw failure;
    }
  },

  load(url, context, nextLoad) {
    if (!url.startsWith('file:') || !url.endsWith('.ts')) {
      return nextLoad(url, context);
    }

    const filename = fileURLToPath(url);
    const { code } = transformSync(readFileSync(filename, 'utf8'), {
      filename,
      jsc: {
        parser: { syntax: 'typescript', decorators: true },
        transform: { legacyDecorator: true, decoratorMetadata: true },
        target: 'es2022',
      },
      module: { type: 'es6' },
      sourceMaps: false,
    });

    return { format: 'module', shortCircuit: true, source: code };
  },
});
