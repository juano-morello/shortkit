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
 * WHAT ACTUALLY STOPS THE RUN is `exitWithoutVerdict`, on EITHER of two independent
 * conditions. Neither alone is enough, which took three rounds to get right:
 *
 *   - **Signal evidence.** `spawnSync`'s own `signal`, or a signal named in pnpm's
 *     summary, or a child reported at 128+n. Whether `spawnSync` sees a signal depends on
 *     WHO was signalled: signal only node and `pnpm` traps it, waits for its children and
 *     exits with an ordinary status, leaving `signal === null`; signal the process GROUP —
 *     which is what Ctrl-C in a terminal does — and `spawnSync` reports
 *     `{ status: null, signal: 'SIGINT' }`. Both verified. Round 2's docblock asserted the
 *     first case as an absolute and was wrong about the second.
 *   - **No diagnostics on a non-zero exit.** A genuine regression always emits
 *     `error TSnnnn` — that is the check's premise — so a non-zero typecheck with none of
 *     them did not finish typechecking. See the invariant above `MUTATIONS`: this half is
 *     safe because of what is IN that table, not because of anything here.
 *
 * They are unioned, not nested. Round 2 nested the signal check inside the diagnostics
 * check, which left the window F-195's round-3 finding reproduced: mutation 1 breaks two
 * workspaces that finish at different times, so an interrupt landing between them leaves
 * diagnostics in the output, skips the guard, and reports the interrupt as
 * `FAIL: … mutation(s) did not break the build` — indistinguishable from an AC-14
 * regression, after running a second full typecheck the user had already tried to stop.
 *
 * AND THE RESTORE IS VERIFIED BEFORE EXIT 0: the file is read back and compared to the
 * bytes read at the start. "The finally ran" and "the file came back byte-identical" are
 * different claims, and only the second one matters.
 *
 * The synchronous fs API is kept because the restore now happens on paths that cannot
 * await — inside the `finally` reached from a signal-suppressed `spawnSync` return, inside
 * `exitWithoutVerdict` before its `process.exit`, and inside the listeners.
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
 *
 * ============================================================================
 * INVARIANT FOR ANYONE ADDING A THIRD MUTATION. READ THIS BEFORE YOU DO.
 * ============================================================================
 *
 * `exitWithoutVerdict` treats "non-zero exit, no compiler diagnostics anywhere" as an
 * aborted run rather than a finding. That is only safe because no mutation in THIS table
 * can produce that shape from a genuine regression:
 *
 *   - Mutation 1 breaks `apps/web` AND `apps/api` (`exception-filter.ts` reads
 *     `ERROR_CODE_STATUS.not_found` too). If the `apps/web` half ever stopped failing, the
 *     `apps/api` half still emits diagnostics, so `hasAnyDiagnostic` is true and the
 *     ordinary verdict path runs.
 *   - Mutation 2 has ONE consumer, and a genuine regression there means nothing broke at
 *     all — the typecheck exits 0. What protects that run is the `status !== 0` conjunct
 *     INSIDE the guard, which short-circuits before `hasAnyDiagnostic` is reached, plus a
 *     clean run carrying no signal evidence for the other half of the union to find. It is
 *     NOT the `if (status === 0)` branch below: that sits after the guard, not before it,
 *     and never gets the chance to matter here. Short-circuiting within one condition, not
 *     statement ordering — the distinction is the whole of why this is safe.
 *
 * THE SAFETY PROPERTY IS THEREFORE THE TABLE'S, NOT THE GUARD'S. A third mutation with a
 * single consumer whose regression surfaces as a NON-ZERO exit carrying no diagnostics —
 * a workspace whose `typecheck` script dies before `tsc` runs, say — would be swallowed by
 * the no-verdict path and reported as an interrupted run. If you add one, either check
 * that it cannot produce that shape, or give the guard a per-mutation expectation instead
 * of the global one.
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
const SIGNAL_BY_NAME = /Command failed with signal "(SIG\w+)"/;
const SIGNAL_BY_STATUS = /Exit status (1(?:2[89]|3\d|4[0-3]))\b/;

/**
 * 128+n back to a name, so `Exit status 137` can be told apart from `Exit status 130`.
 *
 * FIRST NAME WINS, and that is not incidental (F-209). `os.constants.signals` maps two
 * names onto some numbers — 6 is both SIGABRT and SIGIOT, 29 is both SIGIO and SIGPOLL —
 * and `Object.fromEntries` keeps the LAST, so the obvious one-liner resolves 134 to
 * "SIGIOT". A `tsc` that exhausts the V8 heap aborts with SIGABRT and pnpm reports
 * `Exit status 134`, so that one-liner told the operator their memory problem was
 * "terminated by SIGIOT", under a name almost nobody uses.
 */
const SIGNAL_NAMES = {};

for (const [name, number] of Object.entries(os.constants.signals)) {
  if (!(number in SIGNAL_NAMES)) {
    SIGNAL_NAMES[number] = name;
  }
}

/**
 * Signals a human sends to stop a run. SIGKILL and SIGABRT are deliberately NOT among
 * them — see `MEMORY_SIGNALS`. Either way the run has no verdict, but the message has to
 * point at the right thing.
 */
const INTERRUPT_SIGNALS = new Set(['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT']);

/**
 * The two that mean "this machine ran out of memory", which is a capacity problem needing
 * a different first move from "someone pressed Ctrl-C" — and the case least likely to
 * reproduce anywhere but the runner it happened on.
 */
const MEMORY_SIGNALS = new Set(['SIGKILL', 'SIGABRT']);

/**
 * Everything the run says about having been signalled, from three sources in descending
 * directness: `spawnSync` saw its own child die from one; pnpm named it; pnpm reported a
 * child at 128+n. Returns null when there is no such evidence at all.
 *
 * `spawnSync` REPORTS AN EMPTY STRING, NOT NULL, when the child died from a signal Node
 * cannot name — every number 32-64 on Linux (F-204). Empty string is not nullish, so
 * `signal ?? …` treats it as a name, `os.constants.signals['']` is undefined, and the
 * arithmetic below fell through to `Number(null)`, which is **0**. That made the no-verdict
 * path call `process.exit(0)` and the CI step go green on a run that had just printed
 * NO VERDICT. It is handled explicitly here and clamped again at the exit.
 */
function signalEvidence(signal, output) {
  const namedBySpawn = typeof signal === 'string' && signal !== '' ? signal : null;
  const unnamedBySpawn = signal === '';

  const byStatus = SIGNAL_BY_STATUS.exec(output)?.[1] ?? null;
  const name =
    namedBySpawn ??
    SIGNAL_BY_NAME.exec(output)?.[1] ??
    (byStatus === null ? null : (SIGNAL_NAMES[Number(byStatus) - 128] ?? null));

  if (name === null && byStatus === null && !unnamedBySpawn) {
    return null;
  }

  const number = name === null ? undefined : os.constants.signals[name];
  const candidate =
    typeof number === 'number' ? 128 + number : byStatus !== null ? Number(byStatus) : 1;

  return {
    name,
    // Never 0, whatever the inputs were. This value is the process's exit code on a path
    // that has just declared it has no verdict, and the CI step carries no
    // `continue-on-error`, so a 0 here is a green gate over an unfinished typecheck.
    exitCode: Number.isInteger(candidate) && candidate > 0 ? candidate : 1,
    interrupt: name !== null && INTERRUPT_SIGNALS.has(name),
    memory: name !== null && MEMORY_SIGNALS.has(name),
  };
}

/**
 * Reports that this run cannot rule on AC-14, and exits NON-ZERO.
 *
 * Reached from the union at the call site — either condition alone, never nested. Read
 * that condition rather than this docblock for the logic; what follows is why the two
 * halves exist and what each is worth.
 *
 * **Signal evidence.** Whether `spawnSync` sees a signal depends on WHO was signalled.
 * Signal only node and `pnpm` traps it, waits for its children and exits with an ordinary
 * status, so `result.signal` is null and `result.status` is non-zero — the same shape a
 * drift failure has. Signal the process GROUP, which is what Ctrl-C does, and `spawnSync`
 * reports the signal directly. Both verified. Neither `signal === null` nor
 * `signal !== null` is an absolute here, which is why this half cannot be the only test.
 *
 * **No diagnostics on a non-zero exit.** A genuine regression always emits `error TSnnnn`,
 * so a non-zero typecheck with none of them did not finish. This half also catches a
 * typecheck broken for a non-tsc reason — `next typegen` failing, a missing binary after a
 * dependency bump — which is not an AC-14 regression either, and reporting it as one sends
 * the reader after the wrong file.
 *
 * **Why neither is enough alone.** Round 2 nested the signal check inside the diagnostics
 * check and left a window (F-199): mutation 1 breaks two workspaces that finish at
 * different times, so an interrupt landing between them leaves diagnostics in the output,
 * the diagnostics test is false, and the interrupt is reported as an AC-14 regression.
 * **Do not simplify this back to a single condition.** The invariant above `MUTATIONS`
 * covers what the diagnostics half is safe against and why that safety is the table's
 * rather than this function's.
 *
 * **This function must never exit 0** (F-204). It has just told the operator the run has
 * no verdict, and the CI step carries no `continue-on-error`, so a 0 is a green gate over
 * an unfinished typecheck.
 */
function exitWithoutVerdict(evidence, output) {
  restore();

  const memoryAdvice =
    ' On a CI runner this is nearly always a memory problem rather than anything to do with ' +
    'this check — look at what the runner had available, not at the contract. It will not ' +
    'reproduce locally.';

  const cause =
    evidence === null
      ? 'No signal was reported anywhere in the output, and the typecheck emitted no compiler ' +
        'diagnostics, so it did not finish. The likely cause is a typecheck broken for a ' +
        'non-tsc reason — `next typegen` failing, or a missing binary after a dependency bump.'
      : evidence.name === 'SIGKILL'
        ? `A child was KILLED (SIGKILL), which is the kernel out-of-memory killer.${memoryAdvice}`
        : evidence.name === 'SIGABRT'
          ? `A child ABORTED (SIGABRT). For \`tsc\` that is usually V8 exhausting its heap.${memoryAdvice}`
          : evidence.interrupt
            ? `Interrupted (${evidence.name}).`
            : evidence.name === null
              ? 'A child was terminated by a signal Node could not name — every signal number ' +
                '32-64 on Linux reports this way. Not an ordinary typecheck failure.'
              : `A child was terminated by ${evidence.name}, which is not an ordinary typecheck ` +
                'failure.';

  console.error(
    '\nNO VERDICT: this run of `pnpm -r --no-bail typecheck` cannot say anything about AC-14 ' +
      'either way. This is NOT a contract-drift failure.\n' +
      `  ${cause}\n` +
      `  ${CONTRACT_FILE} restored.\n\n` +
      // The step captures both streams, so pnpm's output reaches nobody unless it is
      // printed here. Without it the message above is the operator's entire evidence for a
      // failure that, in the memory cases, does not reproduce anywhere else. The sibling
      // failure path below prints the same thing for the same reason.
      `Full output:\n${output}`,
  );

  // Clamped a second time, at the one place it decides the gate. `signalEvidence` already
  // guarantees a positive `exitCode`; this repeats it because the cost of the two being out
  // of step is a green CI step over a run that just said it has no verdict (F-204).
  const code = evidence?.exitCode ?? 1;

  process.exit(Number.isInteger(code) && code > 0 ? code : 1);
}

const original = readFileSync(CONTRACT_FILE, 'utf8');
const failures = [];

function restore() {
  writeFileSync(CONTRACT_FILE, original);
}

// ============================================================================
// NOTHING IN THIS SCRIPT EVER DISPATCHES THESE. THE BODIES ARE DEAD CODE.
// ============================================================================
//
// Registering a listener replaces the default terminate-on-signal disposition. THAT IS
// THEIR ENTIRE JOB, and it is the whole reason they are here: verified that with no
// listener a signal kills the process outright, the `finally` never runs, and the file is
// left holding a probe identifier.
//
// The bodies never execute. The try/for below is fully synchronous, and Node unrefs the
// signal handle, so when the module body ends the loop is not alive and `uv_run` returns
// without draining the pending callback. Verified on Node v24.19.0 three ways, including
// with stdout on a pipe (the CI shape) in case async writes kept the loop alive: the
// listener never ran. A positive control with a single `setTimeout` after the body — a
// ref'd handle this script does not have — did run it.
//
// So the signal is SWALLOWED SILENTLY: a run interrupted after its last `spawnSync`
// returns still exits 0. Three earlier versions of this comment described a mechanism this
// script does not have, the last of them claiming the opposite of the truth ("the signal is
// not swallowed"). Anything that adds an `await` or a timer down there changes this, and
// then the codes below start mattering.
//
// An interrupt that actually STOPS a run is `exitWithoutVerdict`'s `128 + signo`, never
// this. The exit codes are identical, so an exit 130 is not evidence a listener ran.
//
// SIGQUIT is in the list because this diff's own `INTERRUPT_SIGNALS` calls it one of the
// signals a human sends to stop a run, and it was missing here (F-205). Ctrl-\ is the same
// class of move as closing the terminal: what someone tries when Ctrl-C appears to do
// nothing, which is exactly what this script does. Verified that an unhandled SIGQUIT
// ("Quit (core dumped)") skips the `finally` and leaves the tree mutated.
for (const [signal, code] of [
  ['SIGINT', 130],
  ['SIGTERM', 143],
  ['SIGHUP', 129],
  ['SIGQUIT', 131],
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

    // TWO INDEPENDENT NO-VERDICT CONDITIONS, UNIONED — not one nested inside the other.
    //
    // Round 2 gated everything on the absence of diagnostics, and that left a window
    // (F-195, round 3): mutation 1 breaks TWO workspaces, and `apps/web`'s typecheck is
    // `next typegen && tsc` against `apps/api`'s plain `tsc`, so they finish at different
    // times by construction. An interrupt arriving after the first has emitted leaves
    // diagnostics in the output, so the absent-diagnostics test was false, and the run was
    // reported as an AC-14 regression — after running a second full typecheck. The signal
    // was right there in `result.signal` and in pnpm's summary, but both were only read
    // INSIDE exitWithoutVerdict, which that test had already excluded.
    //
    // So: signal evidence means no verdict however many diagnostics were emitted, and
    // absent diagnostics on a non-zero exit means no verdict however the run ended.
    const evidence = signalEvidence(signal, output);

    if (evidence !== null || (status !== 0 && !hasAnyDiagnostic(output))) {
      exitWithoutVerdict(evidence, output);
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
