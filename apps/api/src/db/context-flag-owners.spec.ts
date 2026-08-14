import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { CONTEXT_FLAG_OWNERS } from '../../test/isolation/coverage';

/**
 * STORY-001 — TASK-002. The wave-1-runnable half of clauses A1 and A4.
 *
 * Contract: `.sdlc/foundation/design/contracts/isolation-coverage.md:466-542` ("The grep
 * assertion"), a frozen contract. ADR-0045, ADR-0003.
 *
 * This control cites those clauses rather than restating them. It is the ONE executing
 * control wave 1 ships, it is `CONTEXT_FLAG_OWNERS`'s first consumer anywhere in the
 * repository, and F-025 — "an ADR cites four controls and none of them executes" — was
 * closed on the strength of it.
 *
 * ============================================================================
 * IT IS A TEXT SCAN AND IT MUST STAY ONE.
 * ============================================================================
 *
 * The contract says at `:527-532` that none of its four clauses parses TypeScript and none
 * distinguishes code from a comment, deliberately: a commented-out
 * `set_config('app.privileged_erase', ...)` is one uncomment away from being real, and A2
 * is built to fire on it. The permitted setter files carry their own flag name in their
 * header comments and match harmlessly, because those files are the permitted ones.
 *
 * `src/observability/logging-opt-out.spec.ts` scans the same tree with the TypeScript
 * compiler's parser, for a different assertion with different needs. IT IS NOT THE PATTERN
 * HERE, and an AST rewrite of this file has been ruled against twice.
 *
 * ============================================================================
 * WHAT IS ASSERTED, AND WHAT IS DELIBERATELY NOT
 * ============================================================================
 *
 * A4 in full: every `set_config(` first argument in the scan set is a quoted string literal
 * drawn from A4's permitted list. THE LIST IS INHERITED FROM THE CONTRACT, verbatim, and
 * this file writes no `app.`-prefix filter of its own — an independent filter is a second
 * permitted list that drifts from the contract's silently (F-044).
 *
 * A1 in the SUBSET direction only: every `{ flag, file }` pair discovered appears in
 * `CONTEXT_FLAG_OWNERS`. That is the direction carrying the security claim — it is what
 * catches a new, unregistered flag setter, and a second file setting an ALREADY-registered
 * flag, which a flag-only match sails past.
 *
 * A1's exactly-one direction is TASK-056's. `CONTEXT_FLAG_OWNERS` already names
 * `redirect-read.ts` (TASK-029) and `privileged-eraser.ts` (TASK-054), files deferred out
 * of this initiative, so an equality assertion would be RED ON THE DAY IT LANDS and the
 * cheap way to make a red build green is to delete the control — which re-opens F-025.
 * The contract says in as many words that "A1 is not runnable earlier" (F-039, F-044).
 */

/** isolation-coverage.md, "The scan set": `apps/api/src/**\/*.ts`, excluding `*.spec.ts`. */
const apiSource = fileURLToPath(new URL('../', import.meta.url));
const repositoryRoot = fileURLToPath(new URL('../../../../', import.meta.url));

/** isolation-coverage.md A1/A4: every call site, however the call is spelled. */
const SET_CONFIG_CALL = /set_config\s*\(/g;

/**
 * isolation-coverage.md A4's predicate, verbatim. An identifier, a `${...}` interpolation
 * or a concatenation fails it, which is what makes A1 sound: without A4,
 * `set_config(FLAG, ...)` defeats A1 with a one-line alias.
 *
 * The two non-`app` names are an ENUMERATION, not a pattern. A shape loose enough to admit
 * a legitimate GUC (`/^[a-z_]+$/`) also admits `role`, `session_authorization`,
 * `row_security` and `search_path`; grep cannot tell a resource bound from an identity
 * switch. Admitting a third name edits the contract and ADR-0003 in one commit.
 */
const PERMITTED_FIRST_ARGUMENT =
  /^(['"`])(statement_timeout|idle_in_transaction_session_timeout|app\.[^'"`]*)\1$/;

/** A first argument that named a flag, once the quotes are off. */
const QUOTED_APP_FLAG = /^(['"`])(app\.[^'"`]*)\1$/;

interface SetConfigCall {
  /** Repository-relative and forward-slashed, so a failure names a path a reader can open. */
  readonly file: string;
  /** isolation-coverage.md `:534-535`: the text between `set_config(` and the first comma. */
  readonly firstArgument: string;
}

function scanSet(): readonly string[] {
  return readdirSync(apiSource, { recursive: true, encoding: 'utf8' })
    .filter((entry) => entry.endsWith('.ts') && !entry.endsWith('.spec.ts'))
    .map((entry) => join(apiSource, entry));
}

/**
 * No flag name contains a comma, so no balanced-paren parse is needed — the contract says
 * so where it defines "first argument", and it is the reason this stays a text scan.
 */
function setConfigCalls(file: string, source: string): SetConfigCall[] {
  const calls: SetConfigCall[] = [];

  for (const match of source.matchAll(SET_CONFIG_CALL)) {
    const rest = source.slice(match.index + match[0].length);
    const comma = rest.indexOf(',');
    // No comma at all is not a call this scan can read, so it is reported as it stands and
    // fails A4 — which is the right answer for a computed or malformed first argument.
    const firstArgument = (comma === -1 ? rest.split('\n')[0] : rest.slice(0, comma)).trim();

    calls.push({ file, firstArgument });
  }

  return calls;
}

const calls: readonly SetConfigCall[] = scanSet().flatMap((path) =>
  setConfigCalls(relative(repositoryRoot, path).split(sep).join('/'), readFileSync(path, 'utf8')),
);

describe('context flag owners', () => {
  /**
   * THE PREMISE, NOT THE SUBJECT. Both assertions below are `toEqual([])`, which is
   * satisfied by a scan that read nothing at all — a walk over a moved directory, a filter
   * that dropped every file. That is the shape in which a control reports `pass` over a
   * source tree it never opened, and this repository has measured it once already
   * (`test/isolation/coverage.ts`, "AND WHAT PROVES THE HARNESS WOULD NOTICE").
   */
  it('the scan reaches the one flag setter that exists today', () => {
    expect(calls).toContainEqual({
      file: 'apps/api/src/tenancy/tenant-context.ts',
      firstArgument: "'app.tenant_id'",
    });
  });

  it('A4: every set_config first argument is a quoted literal on the permitted list', () => {
    const rejected = calls
      .filter((call) => !PERMITTED_FIRST_ARGUMENT.test(call.firstArgument))
      .map((call) => `${call.file}: ${call.firstArgument}`);

    expect(rejected).toEqual([]);
  });

  it('A1 (subset): every { flag, file } pair that sets a flag is registered in CONTEXT_FLAG_OWNERS', () => {
    const registered = new Set(
      CONTEXT_FLAG_OWNERS.map((owner) => `${owner.flag} <- ${owner.file}`),
    );

    const unregistered = calls
      .flatMap((call) => {
        const flag = QUOTED_APP_FLAG.exec(call.firstArgument)?.[2];

        return flag === undefined ? [] : [`${flag} <- ${call.file}`];
      })
      .filter((pair) => !registered.has(pair));

    // Matched on the PAIR and not on the flag alone: a second file setting an
    // already-registered flag is the case A1 exists to catch.
    expect([...new Set(unregistered)]).toEqual([]);
  });
});
