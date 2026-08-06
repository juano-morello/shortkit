/**
 * `node .github/scripts/assert-contract-drift.mjs`
 *
 * AC-14. Specified in design/test-strategy.md ("AC-14 as a vitest test", revised by
 * F-091). Produced by: TASK-002.
 *
 * WHY THIS IS A CI STEP AND NOT A VITEST TEST. AC-14 asserts that an incompatible change
 * to `packages/contracts` breaks a consumer's typecheck. That is a property of the build,
 * not of any importable value, and the obvious in-process version is weaker than the AC:
 * `pnpm -r typecheck` compiles `packages/contracts` first, so a mutation that breaks
 * contracts internally exits non-zero without a consumer ever compiling, and the check
 * would report AC-14 covered on evidence that never reached `apps/web`.
 *
 * TWO MUTATIONS, ONE PER CONSUMER WORKSPACE (F-091). One mutation is not enough. TASK-007
 * added `isZodError`, `toValidationDetails` and `FORM_ERROR_KEY`, and only `apps/api`
 * consumes them; `apps/web`'s only `@shortkit/contracts` import anywhere is
 * `ERROR_CODE_STATUS`. So a breaking change confined to the API-only exports fails
 * `apps/api` and never reaches `apps/web`, and a check built on the `ERROR_CODES` rename
 * alone would leave that whole class of change enforced by nothing.
 *
 * Both mutations keep `packages/contracts` INTERNALLY CONSISTENT on purpose — that is
 * what stops the recursive typecheck from aborting on contracts itself and never
 * compiling a dependent.
 *
 * WHY `--no-bail`. `pnpm -r` stops at the first failing workspace by default, and the
 * `ERROR_CODES` mutation breaks `apps/api` as well as `apps/web`. Without `--no-bail`
 * the run can end before `apps/web` is ever compiled, and the assertion below would fail
 * on a correct repository.
 *
 * WHAT IS ASSERTED. Per mutation: a non-zero exit, AND at least one line that is a
 * compiler diagnostic attributed to the consumer workspace. pnpm prefixes every line of
 * a recursive run with the workspace directory, so `apps/web typecheck: app/not-found.tsx(5,44): error TS2339: ...`
 * is one line naming both. Matching that shape rather than the bare workspace name is
 * deliberate: `Failed in ... at /path/to/apps/web` also contains the directory but says
 * only that the workspace failed, not that a diagnostic named a path inside it.
 *
 * The source file is restored in a `finally`, so a crash mid-run leaves the tree clean.
 *
 * NOT TYPECHECKED: the root tsconfig's `include` is `["vitest.config.ts"]`, so nothing
 * under `.github/` is in any project's program. Plain ESM, Node runs it as written.
 */
/* global process, console */
import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';

const CONTRACT_FILE = 'packages/contracts/src/errors.ts';

/**
 * `replacements` are applied to `CONTRACT_FILE` in order, and each one's expected
 * occurrence count is asserted before the edit lands. A mutation that silently matched
 * nothing would make the typecheck below pass and be reported as AC-14 failing, sending
 * whoever reads it after the wrong thing entirely.
 */
const MUTATIONS = [
  {
    name: 'rename an ERROR_CODES member and its ERROR_CODE_STATUS key together',
    consumer: 'apps/web',
    why: "apps/web's only @shortkit/contracts import is ERROR_CODE_STATUS (app/not-found.tsx).",
    replacements: [
      { from: "  'not_found',\n", to: "  'not_found_contract_drift_probe',\n", count: 1 },
      { from: '  not_found: 404,\n', to: '  not_found_contract_drift_probe: 404,\n', count: 1 },
    ],
  },
  {
    name: 'rename FORM_ERROR_KEY and every use of it inside errors.ts together',
    consumer: 'apps/api',
    why: 'FORM_ERROR_KEY is consumed only by apps/api (src/common/errors/exception-filter.ts).',
    replacements: [
      { from: 'FORM_ERROR_KEY', to: 'FORM_ERROR_KEY_CONTRACT_DRIFT_PROBE', count: 5 },
    ],
  },
];

function diagnosticPattern(workspace) {
  // `<workspace> typecheck: <relative/path.ts>(line,col): error TSnnnn:`
  return new RegExp(`^${workspace} typecheck: \\S+\\(\\d+,\\d+\\): error TS\\d+`, 'm');
}

function applyReplacements(source, replacements) {
  let mutated = source;

  for (const { from, to, count } of replacements) {
    const actual = mutated.split(from).length - 1;

    if (actual !== count) {
      throw new Error(
        `expected ${String(count)} occurrence(s) of ${JSON.stringify(from)} in ${CONTRACT_FILE}, found ${String(actual)}. ` +
          'The mutation this check depends on no longer applies — update .github/scripts/assert-contract-drift.mjs ' +
          'and design/test-strategy.md together.',
      );
    }

    mutated = mutated.split(from).join(to);
  }

  return mutated;
}

function runTypecheck() {
  const result = spawnSync('pnpm', ['-r', '--no-bail', 'typecheck'], {
    encoding: 'utf8',
    // Both streams matter: pnpm writes the recursive-run summary to stderr and the
    // per-workspace diagnostic lines to stdout.
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (result.error !== undefined) {
    throw new Error(`could not run \`pnpm -r --no-bail typecheck\`: ${result.error.message}`);
  }

  return { status: result.status, output: `${result.stdout}\n${result.stderr}` };
}

const original = await readFile(CONTRACT_FILE, 'utf8');
const failures = [];

try {
  for (const mutation of MUTATIONS) {
    console.log(`\n--- ${mutation.name}`);
    console.log(`    expects a diagnostic under ${mutation.consumer}/ — ${mutation.why}`);

    await writeFile(CONTRACT_FILE, applyReplacements(original, mutation.replacements));

    const { status, output } = runTypecheck();

    if (status === 0) {
      failures.push(
        `${mutation.name}: \`pnpm -r --no-bail typecheck\` exited 0. An incompatible change to ` +
          `${CONTRACT_FILE} compiled cleanly, so nothing in the build enforces the contract.`,
      );
      continue;
    }

    if (!diagnosticPattern(mutation.consumer).test(output)) {
      failures.push(
        `${mutation.name}: the typecheck failed, but no diagnostic was attributed to ` +
          `${mutation.consumer}. ${mutation.why} A failure somewhere else is not the ` +
          'property this asserts — it can be produced by a workspace that happens to break ' +
          'first. Full output:\n' +
          output,
      );
      continue;
    }

    console.log(`    OK: ${mutation.consumer} reported a compiler diagnostic.`);
  }
} finally {
  await writeFile(CONTRACT_FILE, original);
}

if (failures.length > 0) {
  console.error(
    `\nFAIL: ${String(failures.length)} contract-drift mutation(s) did not break the build the ` +
      'way AC-14 requires:\n\n' +
      failures.map((line) => `  - ${line}`).join('\n\n'),
  );
  process.exit(1);
}

console.log(
  `\nOK: ${String(MUTATIONS.length)} contract-drift mutation(s), each breaking the typecheck of ` +
    'the workspace that consumes the mutated export.',
);
