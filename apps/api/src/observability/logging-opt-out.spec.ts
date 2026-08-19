import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * AC-116, THE ENUMERATION — F-247, F-268, F-278.
 *
 * AC-116: "Given the API source tree, when every module that emits a log line is
 * enumerated, then each one emits through the pino instance registered at the composition
 * root — no module constructs `Logger` from `@nestjs/common` or any other logger."
 *
 * Contract: `docs/contracts/logging-and-headers.md`, "Consumed by: every API TASK.
 * Nothing may opt out, with two named exceptions". ADR-0028. Enforces GC-9.
 *
 * ============================================================================
 * IT DERIVES THE SET. IT DOES NOT CHECK THREE PATHS.
 * ============================================================================
 *
 * The AC says "every module that emits a log line is ENUMERATED", and a test that named
 * `tenant-context.ts` and `client.ts` would go green on the day this TASK lands and stay
 * green when a fourth module copies the bypass — which is the exact failure mode
 * `logging-and-headers.md`'s "two named exceptions measured 2026-08-10" already has. The
 * contract's own exemption list is a list, and this file exists because a list is what
 * needed the AC.
 *
 * So the subject set is every `.ts` file under `apps/api/src` that is not a `.spec.ts`,
 * found by walking the directory. Nothing here carries a file name except the ONE
 * exemption below, and that exemption is a single path with a stated reason.
 *
 * Each file is parsed with the TypeScript compiler's own parser rather than grepped. Two
 * things that a grep gets wrong and this does not: `import type { Logger } from 'pino'` in
 * `exception-filter.ts` is a TYPE and reaches no runtime logger, and a mention of `Logger`
 * inside a comment or a string is not an import. `writing-good-tests.md` warns against
 * tests that grep source text; the answer here is not to assert on the text but to derive a
 * structural property of the module graph, and to prove on every run that the derivation
 * can tell a violating module from a clean one — see the controls in `beforeAll`.
 *
 * ============================================================================
 * WHAT THE TWO ASSERTIONS MEAN, AND WHERE THE BOUND IS
 * ============================================================================
 *
 * A module "obtains a logger of its own" when it imports a logger CONSTRUCTOR or FACTORY as
 * a value from anywhere other than `observability/logger`, or reaches `console`. That is
 * decidable per module and it is the property the class turns on: with no other logger
 * VALUE in scope, there is nothing else in that module for a log call to go through.
 *
 * A module "emits a log line" when it calls `<something>.<level>(…)` for one of pino's six
 * levels or Nest's two extra ones, or calls `console.*`. Every such module must import the
 * shared `logger` value.
 *
 * THE BOUND, STATED RATHER THAN IMPLIED. This is a per-module property, not a per-call one.
 * `exception-filter.ts` emits through a `log` PARAMETER, which its own
 * `logger.child({ request_id })` supplies; the analysis does not follow that dataflow and
 * does not need to, because the only logger value the module can reach is the shared one.
 * What it therefore cannot see: a logger handed in from another module at runtime, or one
 * resolved through Nest dependency injection. Neither shape exists in this tree, and the
 * lint rule in `logger-lint-rule.spec.ts` is the half that keeps the import door shut for
 * modules nobody has written yet.
 */

/** pino's six levels, plus the two `@nestjs/common`'s `Logger` adds. A call in any of these names is an emission. */
const LOG_LEVELS = new Set(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'log', 'verbose']);

/** The concrete loggers `@nestjs/common` exports. `LoggerService` is an interface and is type-only by nature. */
const NEST_LOGGER_EXPORTS = new Set(['Logger', 'ConsoleLogger']);

/**
 * THE ONE EXEMPTION, and it is the composition root's own module. `observability/logger.ts`
 * is the file that must construct the pino instance; every other module consumes it.
 * `eslint.config.mjs` exempts exactly this path for exactly this reason. A second entry
 * here is a finding, not a precedent.
 */
const COMPOSITION_ROOT = 'apps/api/src/observability/logger.ts';

/** Where the shared instance lives, as every consumer outside its directory spells it. */
const SHARED_LOGGER_MODULE = /(^|\/)observability\/logger$/;

/**
 * How a SIBLING spells it. `request-log.interceptor.ts` (TASK-016) lives beside `logger.ts`
 * and imports `./logger`; the pattern above requires the `observability/` segment and would
 * have read that emitter as one with no logger at all — the wrong verdict for the right
 * import. Accepted only from a module whose own path is under the observability directory,
 * so `./logger` in any other directory stays what it is: some other module.
 */
const SIBLING_LOGGER_MODULE = /^\.\/logger$/;
const OBSERVABILITY_DIRECTORY = /(^|\/)observability\/[^/]+\.ts$/;

function namesTheSharedLogger(specifier: string, importerPath: string): boolean {
  return (
    SHARED_LOGGER_MODULE.test(specifier) ||
    (SIBLING_LOGGER_MODULE.test(specifier) && OBSERVABILITY_DIRECTORY.test(importerPath))
  );
}

/** The export a consumer needs. `errorLogFields` alone does not make a module an emitter. */
const SHARED_LOGGER_EXPORT = 'logger';

interface AnalysedModule {
  /** Repository-relative, forward-slashed, so a failure message is a path a reader can open. */
  readonly path: string;
  /** One entry per way this module can reach a logger that is not the registered instance. */
  readonly otherLoggerSources: readonly string[];
  /** Whether the module imports the shared `logger` value. */
  readonly importsSharedLogger: boolean;
  /** One entry per log call the module makes. */
  readonly emissions: readonly string[];
}

const repositoryRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const apiSource = fileURLToPath(new URL('../', import.meta.url));

let modules: readonly AnalysedModule[];

beforeAll(() => {
  modules = walk(apiSource).map((file) =>
    analyse(relative(repositoryRoot, file).split(sep).join('/'), readFileSync(file, 'utf8')),
  );

  // ==========================================================================
  // THE CONTROLS. Both assertions below are `toEqual([])`, which is satisfied by an
  // analysis that finds nothing — a walk that returned no files, a detector that never
  // fires. That is the shape in which a suite reports `pass` over a source tree it never
  // read, and this repository has measured it once already (`test/isolation/coverage.ts`,
  // "AND WHAT PROVES THE HARNESS WOULD NOTICE"). So the analyser is run, on every run,
  // over two modules written here: one that opts out the way the two known sites do, and
  // one that does it correctly. It has to tell them apart before anything below is read.
  // ==========================================================================
  const optsOut = analyse(
    'apps/api/src/links/link-repository.ts',
    [
      "import { Logger } from '@nestjs/common';",
      "const logger = new Logger('LinkRepository');",
      'export function discard(): void {',
      "  logger.warn('a fourth module, written after TASK-060 landed');",
      '}',
    ].join('\n'),
  );

  const complies = analyse(
    'apps/api/src/links/link-repository.ts',
    [
      "import type { Logger } from 'pino';",
      "import { logger } from '../observability/logger';",
      'export function discard(child: Logger): void {',
      "  child.warn({ request_id: 'r' }, 'the same module, done the sanctioned way');",
      "  logger.warn({ request_id: 'r' }, 'and through the shared instance directly');",
      '}',
    ].join('\n'),
  );

  const failures = [
    modules.length < 10 && `the walk found only ${String(modules.length)} modules under apps/api/src`,
    optsOut.otherLoggerSources.length === 0 &&
      'the analyser did not notice a module constructing its own Nest Logger',
    optsOut.emissions.length === 0 && 'the analyser did not notice that same module emitting',
    optsOut.importsSharedLogger && 'the analyser thinks that module imports the shared logger',
    complies.otherLoggerSources.length > 0 &&
      `the analyser reported a compliant module: ${complies.otherLoggerSources.join('; ')}`,
    complies.emissions.length === 0 && 'the analyser did not notice a compliant module emitting',
    !complies.importsSharedLogger &&
      'the analyser did not notice a compliant module importing the shared logger',
  ].filter((failure) => failure !== false);

  if (failures.length > 0) {
    throw new Error(
      `the enumeration cannot tell a violating module from a compliant one, so nothing ` +
        `below is measuring anything:\n  - ${failures.join('\n  - ')}`,
    );
  }
});

/** Every non-spec TypeScript module under `apps/api/src`, found by walking rather than by listing. */
function walk(directory: string): string[] {
  const found: string[] = [];

  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    const full = join(directory, entry.name);

    if (entry.isDirectory()) {
      found.push(...walk(full));
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts')) {
      found.push(full);
    }
  }

  return found;
}

interface ImportedName {
  readonly imported: string;
  readonly typeOnly: boolean;
}

function importedNames(clause: ts.ImportClause | undefined): ImportedName[] {
  if (clause === undefined) {
    return [];
  }

  const names: ImportedName[] = [];

  if (clause.name !== undefined) {
    names.push({ imported: 'default', typeOnly: clause.isTypeOnly });
  }

  const bindings = clause.namedBindings;

  if (bindings !== undefined && ts.isNamespaceImport(bindings)) {
    names.push({ imported: '*', typeOnly: clause.isTypeOnly });
  }

  if (bindings !== undefined && ts.isNamedImports(bindings)) {
    for (const element of bindings.elements) {
      names.push({
        imported: (element.propertyName ?? element.name).text,
        typeOnly: clause.isTypeOnly || element.isTypeOnly,
      });
    }
  }

  return names;
}

function analyse(path: string, text: string): AnalysedModule {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const otherLoggerSources: string[] = [];
  const emissions: string[] = [];
  let importsSharedLogger = false;

  const at = (node: ts.Node): string =>
    `line ${String(ts.getLineAndCharacterOfPosition(source, node.getStart(source)).line + 1)}`;

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const specifier = node.moduleSpecifier.text;
      const names = importedNames(node.importClause);

      if (namesTheSharedLogger(specifier, path)) {
        importsSharedLogger ||= names.some(
          (name) => !name.typeOnly && name.imported === SHARED_LOGGER_EXPORT,
        );
      } else if (specifier === '@nestjs/common') {
        for (const name of names) {
          if (!name.typeOnly && NEST_LOGGER_EXPORTS.has(name.imported)) {
            otherLoggerSources.push(
              `imports ${name.imported} as a value from '@nestjs/common' (${at(node)})`,
            );
          }
        }
      } else if (specifier === 'pino' || specifier.startsWith('pino/')) {
        for (const name of names) {
          if (!name.typeOnly) {
            otherLoggerSources.push(
              `imports ${name.imported} as a value from '${specifier}' (${at(node)})`,
            );
          }
        }
      }
    }

    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const loaded = node.arguments[0];

      if (
        (callee.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(callee) && callee.text === 'require')) &&
        loaded !== undefined &&
        ts.isStringLiteral(loaded) &&
        (loaded.text === 'pino' || loaded.text === '@nestjs/common')
      ) {
        otherLoggerSources.push(`loads '${loaded.text}' at runtime (${at(node)})`);
      }

      if (ts.isPropertyAccessExpression(callee) && LOG_LEVELS.has(callee.name.text)) {
        emissions.push(`${callee.getText(source)}() (${at(node)})`);
      }
    }

    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'console'
    ) {
      otherLoggerSources.push(`reaches console.${node.name.text} (${at(node)})`);
      emissions.push(`console.${node.name.text}() (${at(node)})`);
    }

    ts.forEachChild(node, visit);
  };

  visit(source);

  return { path, otherLoggerSources, importsSharedLogger, emissions };
}

describe('every module in the API source tree that can reach a logger', () => {
  it('AC-116 (F-278): no module obtains a logger of its own — the registered instance is the only one in the tree', () => {
    // The class F-278 established, asserted over the DERIVED set rather than over the two
    // paths `logging-and-headers.md` currently names as exceptions. `toEqual([])` so the
    // failure names each module and says how it got its logger.
    const violations = modules
      .filter((module) => module.path !== COMPOSITION_ROOT)
      .flatMap((module) =>
        module.otherLoggerSources.map((source) => `${module.path}: ${source}`),
      );

    expect(violations).toEqual([]);
  });

  it('AC-116 (F-247, F-278): every module that emits a log line imports the shared logger', () => {
    // The other half, and it is not implied by the first: a module could stop importing
    // Nest's `Logger` and still emit through something else it was handed. This is the
    // clause the AC states — enumerate the emitters, and require each to have the
    // composition root's instance and nothing else.
    const emitters = modules.filter(
      (module) => module.path !== COMPOSITION_ROOT && module.emissions.length > 0,
    );

    const orphans = emitters
      .filter((module) => !module.importsSharedLogger)
      .map(
        (module) =>
          `${module.path}: emits ${module.emissions.join(', ')} without importing ` +
          `\`${SHARED_LOGGER_EXPORT}\` from observability/logger`,
      );

    expect(orphans).toEqual([]);
  });
});
