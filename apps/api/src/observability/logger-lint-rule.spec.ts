import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ESLint } from 'eslint';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * AC-116, THE LINT HALF — F-268, F-278.
 *
 * AC-116: "… no module constructs `Logger` from `@nestjs/common` or any other logger — and
 * A LINT RULE FAILS THE BUILD IF ONE DOES."
 *
 * Contract: `docs/contracts/logging-and-headers.md`, "Consumed by: every API TASK.
 * Nothing may opt out". Amendment A-9 on STORY-002. Enforces GC-9.
 *
 * ============================================================================
 * WHY THIS HALF IS NOT OPTIONAL, AND WHAT IS ACTUALLY MISSING AT HEAD
 * ============================================================================
 *
 * Without the rule, TASK-060 fixes three lines and the class reopens on the fourth. That is
 * why AC-116 names the rule at all, and it is what the STORY's Amendment A-9 says in as
 * many words.
 *
 * The TASK card and A-9 both describe the rule as absent — "F-268's rule bans importing
 * `pino` and says nothing about Nest's `Logger`". MEASURED AT HEAD, THAT HAS MOVED: the
 * second config object in `eslint.config.mjs` does restrict `Logger` from `@nestjs/common`,
 * and it IGNORES `apps/api/src/db/client.ts` and `apps/api/src/tenancy/tenant-context.ts`
 * by name — ADR-0028's "named, bounded exemption". So the rule exists and the two modules
 * this TASK is fixing are the two the rule does not apply to. Measured with this suite's
 * own harness on 2026-08-11: the violating fixture reports one error at
 * `apps/api/src/links/link-repository.ts` and ZERO at either exempted path.
 *
 * That makes the lint work here removal rather than authorship, and it makes these the
 * three cases that are red:
 *
 *   1. the exemption for `tenancy/tenant-context.ts`
 *   2. the exemption for `db/client.ts`
 *   3. `ConsoleLogger`, the OTHER concrete logger `@nestjs/common` exports. The rule's
 *      `importNames` lists `Logger` alone, so `new ConsoleLogger('x').warn(…)` writes the
 *      same unstructured ANSI line past the same policy and lints clean at every path.
 *      AC-116's words are "`Logger` from `@nestjs/common` OR ANY OTHER LOGGER", and this is
 *      the nearest other logger there is — one token from the one that is banned.
 *
 * The case AC-116 states most directly — a module nobody has written yet importing
 * `Logger` — already passes at HEAD, so it is not a test of its own. It is the POSITIVE
 * CONTROL inside case 3: the same fixture path must report the `Logger` import, or the
 * `ConsoleLogger` result says nothing about the rule and everything about the path.
 *
 * ============================================================================
 * HOW A LINT RULE IS TESTED HERE, AND WHY THIS WAY
 * ============================================================================
 *
 * Through ESLint's own Node API — `lintText(text, { filePath })` — against the repository's
 * real `eslint.config.mjs`, resolved by ESLint from `cwd`. Three reasons, in order:
 *
 *   - IT IS THE SHIPPED CONFIG. A fixture config asserting that some rule works would test
 *     `typescript-eslint`, whose maintainers already do. What AC-116 asks is whether THIS
 *     repository's config fails on THIS repository's paths, and `files`/`ignores` matching
 *     is the entire question — case 1 and case 2 are nothing but an `ignores` entry.
 *   - `filePath` IS THE INPUT. Every red case here is about which path the rule applies to,
 *     and `lintText` is the only way to hold the source text fixed and vary the path. Two
 *     fixtures across three paths is six lint runs and no combinatorial fixture tree.
 *   - NO FIXTURE FILE ON DISK. A violating `.ts` file under `apps/api/src` would be linted
 *     by `pnpm lint`, type-checked by `pnpm typecheck`, and — worse — enumerated by
 *     `logging-opt-out.spec.ts`, which walks that directory. A file written in `beforeAll`
 *     and removed in `afterAll` is the same hazard with a race on top.
 *
 * WHAT THAT DOES AND DOES NOT PROVE. `errorCount > 0` is exactly the condition that makes
 * `eslint .` exit non-zero, which is what "fails the build" means; ESLint's CLI exits 1 when
 * any message has severity 2. It does not prove that CI runs `pnpm lint` — that is AC-5's,
 * and `ci.yml`'s `quality` job is where it is verified.
 *
 * The rule ID is deliberately NOT asserted. AC-116 requires the build to fail, not that it
 * fails through `no-restricted-imports`; an implementer who reaches for `no-restricted-syntax`
 * to catch `new Logger(…)` as well has satisfied the AC, and a test that pinned the rule
 * name would block that and pass a rule that had been downgraded to a warning.
 */

/** The bypass, as the two exempted modules write it today. */
const NEST_LOGGER_FIXTURE = [
  "import { Logger } from '@nestjs/common';",
  '',
  "const logger = new Logger('Subject');",
  '',
  'export function report(): void {',
  "  logger.warn('a line that reaches neither pino nor the field allowlist');",
  '}',
  '',
].join('\n');

/**
 * The same bypass through `@nestjs/common`'s other concrete logger. `ConsoleLogger` is what
 * `Logger` delegates to, so this writes the identical unstructured line.
 */
const NEST_CONSOLE_LOGGER_FIXTURE = [
  "import { ConsoleLogger } from '@nestjs/common';",
  '',
  "const logger = new ConsoleLogger('Subject');",
  '',
  'export function report(): void {',
  "  logger.warn('a line that reaches neither pino nor the field allowlist');",
  '}',
  '',
].join('\n');

/**
 * THE CONTROL, and every case below runs it at its own path. Without it, an `errorCount` of
 * 1 proves only that SOMETHING at that path is a lint error — an unused import, a formatting
 * rule, a config object that matched by accident. With it, the difference between the two
 * runs is the logger import and nothing else.
 */
const SHARED_LOGGER_FIXTURE = [
  "import { logger } from '../observability/logger';",
  '',
  'export function report(): void {',
  "  logger.warn({ request_id: 'r' }, 'a line through the registered instance');",
  '}',
  '',
].join('\n');

/** The path a fourth module would take. It does not exist and is never written; `lintText` needs no file. */
const A_MODULE_NOBODY_HAS_WRITTEN = 'apps/api/src/links/link-repository.ts';

/** `logging-and-headers.md`'s two "named exceptions measured 2026-08-10", which AC-116 retires. */
const NAMED_EXEMPTIONS = {
  tenantContext: 'apps/api/src/tenancy/tenant-context.ts',
  databaseClient: 'apps/api/src/db/client.ts',
};

const repositoryRoot = fileURLToPath(new URL('../../../../', import.meta.url));

let eslint: ESLint;

beforeAll(() => {
  // `cwd` is the repository root so ESLint resolves the shipped `eslint.config.mjs` the way
  // `pnpm lint` does from there, and so the config's `apps/api/src/**` patterns mean what
  // they mean on a CLI run. The suite runs with `cwd` at `apps/api`.
  eslint = new ESLint({ cwd: repositoryRoot });
});

/** How many error-severity messages the shipped config reports for `text` at `path`. Severity 2 is what exits `eslint` non-zero. */
async function errorsAt(path: string, text: string): Promise<readonly string[]> {
  const [result] = await eslint.lintText(text, {
    filePath: join(repositoryRoot, path),
    warnIgnored: false,
  });

  return result.messages
    .filter((message) => message.severity === 2)
    .map((message) => `${String(message.ruleId)}: ${message.message}`);
}

describe('the lint rule that keeps a module from constructing its own logger', () => {
  it('AC-116 (F-278): lint fails on the Nest Logger import at apps/api/src/tenancy/tenant-context.ts', async () => {
    // Site 1 and site 2's path. `eslint.config.mjs` names it in the second config object's
    // `ignores`, so the cheapest opt-out from the whole logging policy lints clean at the
    // one path in this repository where a raw `error.message` is currently reaching a log
    // line. Fixing the module without retiring the exemption leaves the door open for the
    // next edit to that file.
    await expectTheRuleToBeInForceAt(NAMED_EXEMPTIONS.tenantContext);
  });

  it('AC-116 (F-278): lint fails on the Nest Logger import at apps/api/src/db/client.ts', async () => {
    // Site 3's path, asserted SEPARATELY. Conflating the benign site with the leaking one
    // is what made F-243 clause 3 read as "two stale logger comments" for six days, and the
    // exemptions are two independent entries that can be retired one at a time.
    await expectTheRuleToBeInForceAt(NAMED_EXEMPTIONS.databaseClient);
  });

  it('AC-116 (F-268): lint fails on ConsoleLogger, the other logger @nestjs/common exports', async () => {
    // "…or any other logger". `importNames: ['Logger']` is an enumeration of one, and this
    // is the same enumeration weakness ADR-0028 rejected for the redact list: it covers the
    // spelling someone thought of. `ConsoleLogger` is exported from the same module, is
    // what `Logger` delegates to, and writes the identical unstructured ANSI line.
    //
    // The `Logger` run at the same path is THE POSITIVE CONTROL. It passes at HEAD, and it
    // is here rather than in a test of its own so that a `ConsoleLogger` result can be read:
    // if both came back clean, the rule is not reaching this path at all and the case above
    // is about `files`, not about `importNames`.
    await expectTheBuildToFailOn(
      A_MODULE_NOBODY_HAS_WRITTEN,
      NEST_LOGGER_FIXTURE,
      "Logger from '@nestjs/common'",
    );
    await expectTheBuildToFailOn(
      A_MODULE_NOBODY_HAS_WRITTEN,
      NEST_CONSOLE_LOGGER_FIXTURE,
      "ConsoleLogger from '@nestjs/common'",
    );
    await expectTheSharedLoggerToLintCleanAt(A_MODULE_NOBODY_HAS_WRITTEN);
  });
});

/**
 * The rule is in force at `path` when the bypass is an error there and the sanctioned import
 * is not. Both halves, because either alone is satisfiable by an accident: a path that
 * errors on everything, or a path the config never matched.
 */
async function expectTheRuleToBeInForceAt(path: string): Promise<void> {
  await expectTheBuildToFailOn(path, NEST_LOGGER_FIXTURE, "Logger from '@nestjs/common'");
  await expectTheSharedLoggerToLintCleanAt(path);
}

async function expectTheBuildToFailOn(
  path: string,
  fixture: string,
  what: string,
): Promise<void> {
  const errors = await errorsAt(path, fixture);

  expect(
    errors.length,
    `the shipped eslint.config.mjs reports no error for a module importing ${what} at ` +
      `${path}, so \`eslint .\` exits 0 on the cheapest opt-out from the entire logging ` +
      `policy. What it did report: ${JSON.stringify(errors)}`,
  ).toBeGreaterThan(0);
}

async function expectTheSharedLoggerToLintCleanAt(path: string): Promise<void> {
  const errors = await errorsAt(path, SHARED_LOGGER_FIXTURE);

  expect(
    errors,
    `the control: a module using the shared logger must lint clean at ${path}, or an ` +
      'error above is attributable to the path rather than to the logger import',
  ).toEqual([]);
}
