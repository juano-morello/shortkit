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
 * ============================================================================
 * IT EDITS A TRACKED FILE, SO THE RESTORE IS THE RISKIEST PART OF IT (F-189, F-195).
 * ============================================================================
 *
 * `packages/contracts/src/errors.ts` is mutated in place and put back. THE `finally` IS
 * WHAT RESTORES IT, on every path. Read that sentence rather than the three-point version
 * that used to stand here: round 1 of this docblock claimed the signal listeners below
 * restore synchronously and re-exit, and `sdlc-reviewer` disproved it by running a copy of
 * this script with the typecheck replaced by a sleep. The listeners never fire.
 *
 * WHY THEY NEVER FIRE. A `process.on('SIGINT')` listener is dispatched from the event
 * loop. This script has no `await` left after the F-189 conversion to synchronous fs,
 * `spawnSync` blocks the loop for the whole of each typecheck, and the script then falls
 * off its end or calls `process.exit()` — so the loop never turns and the queued listener
 * is never called. Reproduced both directions: the same script with one `await` after the
 * `spawnSync` exits 130 with the listener invoked; without it, the listener is never
 * invoked and the script runs to completion.
 *
 * WHY THE LISTENERS ARE STILL HERE, AND ARE STILL LOAD-BEARING. Registering a listener
 * replaces the default terminate-on-signal disposition. That is the whole of their job.
 * Verified: with no listener, SIGINT kills the process outright, the `finally` does NOT
 * run, and the file is left holding a probe identifier. With one registered, the process
 * survives the signal, the in-flight `spawnSync` returns, and the `finally` restores. They
 * suppress termination so that the `finally` gets to run — they do not restore anything
 * themselves, and they do not stop the run promptly.
 *
 * SIGHUP is in the list for the same reason and was missing (F-195). Closing the terminal
 * is the natural next move when Ctrl-C appears to do nothing, and an unhandled SIGHUP
 * terminates by default, skips the `finally`, and leaves the tree mutated — verified.
 *
 * WHAT ACTUALLY STOPS THE RUN is `exitWithoutVerdict`, and it keys off the ABSENCE OF
 * DIAGNOSTICS rather than off a signal. `spawnSync`'s `signal` is not enough on its own:
 * the direct child is `pnpm`, which traps SIGINT, waits for its children and exits with an
 * ordinary status, so an interrupted run leaves `signal === null` and a non-zero status —
 * the same shape a drift failure has. Verified by interrupting a real run. A genuine
 * regression always emits `error TSnnnn`, so a non-zero typecheck with none of them did
 * not finish, and this script says so instead of reporting `FAIL: … mutation(s) did not
 * break the build`, which is indistinguishable from an AC-14 regression and is what it
 * printed before.
 *
 * AND THE RESTORE IS VERIFIED BEFORE EXIT 0: the file is read back and compared to the
 * bytes read at the start. "The finally ran" and "the file came back byte-identical" are
 * different claims, and only the second one matters.
 *
 * The synchronous fs API is kept because the restore now happens on paths that cannot
 * await — inside the `finally` reached from a signal-suppressed `spawnSync` return, and
 * inside the listeners, which stay callable even though nothing currently calls them.
 *
 * NOT TYPECHECKED: the root tsconfig's `include` is `["vitest.config.ts"]`, so nothing
 * under `.github/` is in any project's program. Plain ESM, Node runs it as written.
 */
/* global process, console */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';

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

  return { status: result.status, signal: result.signal, output: `${result.stdout}\n${result.stderr}` };
}

/**
 * Does the output contain a compiler diagnostic — anywhere, for any workspace?
 *
 * This is the discriminator that matters (F-195). A genuine contract-drift regression
 * ALWAYS produces diagnostics: that is the entire premise of the check, and each mutation
 * is chosen so a consumer fails to compile. A typecheck that exits non-zero having emitted
 * none of them did not finish typechecking, and has no verdict in it either way.
 */
function hasAnyDiagnostic(output) {
  return /error TS\d+/.test(output);
}

/**
 * pnpm's own words when a child was signalled, which survive into its summary. Two shapes,
 * because pnpm reports a signalled grandchild differently from a signalled child:
 * `Command failed with signal "SIGINT"`, or the shell convention `Exit status 130`.
 */
const INTERRUPT_BY_NAME = /Command failed with signal "(SIG\w+)"/;
const INTERRUPT_BY_STATUS = /Exit status (1(?:2[89]|3\d|4[0-3]))\b/;

/**
 * `spawnSync`'s `signal` is NOT sufficient on its own, and round 2 of this script briefly
 * claimed it was. Verified: `spawnSync` does report `{ status: null, signal: 'SIGINT' }`
 * when its direct child is killed — but the direct child here is `pnpm`, which TRAPS
 * SIGINT, waits for its own children and then exits with an ordinary status. Interrupting
 * a real run therefore leaves `result.signal === null` and `result.status` non-zero, which
 * is exactly the shape a drift failure has.
 *
 * So the run is treated as having no verdict when the typecheck produced no diagnostics at
 * all, whatever killed it. That covers the interrupt without depending on pnpm's signal
 * handling, and it cannot swallow a real finding: a mutation that genuinely fails to break
 * a consumer produces diagnostics from the OTHER workspaces it does break, so
 * `hasAnyDiagnostic` is true and the ordinary verdict path runs.
 *
 * It also catches a second thing worth catching: a typecheck broken for a non-tsc reason
 * (`next typegen` failing, a missing binary). That is not an AC-14 regression either, and
 * reporting it as one sends the reader after the wrong file. Either way the exit is
 * non-zero, so the gate stays red — only the explanation changes.
 */
function exitWithoutVerdict(signal, output) {
  restore();

  // Three ways to learn a signal, in descending order of directness: spawnSync saw the
  // child die from one; pnpm named it; pnpm reported a child's 128+n exit status.
  const byName = INTERRUPT_BY_NAME.exec(output)?.[1] ?? null;
  const byStatus = INTERRUPT_BY_STATUS.exec(output)?.[1] ?? null;

  const named = signal ?? byName ?? null;
  const number =
    named !== null && typeof os.constants.signals[named] === 'number'
      ? 128 + os.constants.signals[named]
      : byStatus !== null
        ? Number(byStatus)
        : null;

  const cause =
    named !== null
      ? `Interrupted (${named}).`
      : byStatus !== null
        ? `Interrupted — pnpm reported a child exiting ${byStatus}, which is 128 + a signal number.`
        : null;

  console.error(
    `\nNO VERDICT: \`pnpm -r --no-bail typecheck\` exited non-zero without emitting a single ` +
      'compiler diagnostic, so it did not finish typechecking and this run cannot say anything ' +
      'about AC-14 either way. This is NOT a contract-drift failure.\n' +
      (cause === null
        ? '  No signal was reported anywhere in the output. The likely causes are a typecheck ' +
          'broken for a non-tsc reason (`next typegen`, a missing binary) or an out-of-memory kill.\n'
        : `  ${cause} pnpm traps the signal and exits with an ordinary status, so this is ` +
          'detected from the absent diagnostics rather than from the exit code.\n') +
      `  ${CONTRACT_FILE} restored.`,
  );

  process.exit(number ?? 1);
}

const original = readFileSync(CONTRACT_FILE, 'utf8');
const failures = [];

function restore() {
  writeFileSync(CONTRACT_FILE, original);
}

// These do not fire while `spawnSync` holds the event loop, which is nearly the whole
// run — see the header. What registering them DOES do is replace the default
// terminate-on-signal disposition, so the process survives long enough for the `finally`
// below to restore the file. They are kept callable for the interval between mutations,
// where the loop does turn.
for (const [signal, code] of [
  ['SIGINT', 130],
  ['SIGTERM', 143],
  ['SIGHUP', 129],
]) {
  process.on(signal, () => {
    restore();
    console.error(`\n${signal} — ${CONTRACT_FILE} restored.`);
    process.exit(code);
  });
}

try {
  for (const mutation of MUTATIONS) {
    console.log(`\n--- ${mutation.name}`);
    console.log(`    expects a diagnostic under ${mutation.consumer}/ — ${mutation.why}`);

    writeFileSync(CONTRACT_FILE, applyReplacements(original, mutation.replacements));

    const { status, signal, output } = runTypecheck();

    // Before any verdict is recorded. A non-zero exit carrying no diagnostics is an
    // aborted typecheck, not a finding — see exitWithoutVerdict.
    if (status !== 0 && !hasAnyDiagnostic(output)) {
      exitWithoutVerdict(signal ?? null, output);
    }

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
  restore();
}

// "The finally ran" is not "the file came back". Nothing downstream reads this file after
// the script exits, so an incomplete restore would otherwise be invisible until it showed
// up in someone's `git status` — or, worse, in a commit.
const restored = readFileSync(CONTRACT_FILE, 'utf8');

if (restored !== original) {
  console.error(
    `\nFAIL: ${CONTRACT_FILE} was not restored to its original contents. This script mutates a ` +
      'tracked source file in place, so the working tree is now carrying a contract-drift probe ' +
      'identifier. Restore it with `git checkout -- ' +
      `${CONTRACT_FILE}\` before committing anything.`,
  );
  process.exit(1);
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
