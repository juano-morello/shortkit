import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

/**
 * The logger's configuration lives in two artifacts that cannot be derived from one another:
 * `apps/api/src/observability/logger.ts`, which runs, and the fenced block in
 * `design/contracts/logging-and-headers.md`, which is what every later TASK reads before it
 * writes a log call. Nothing has ever compared them.
 *
 * WHY THIS TEST EXISTS. That pair produced F-244, F-248, F-249 and F-250 in sequence — the
 * contract described a logger the process was not running, so the next TASK to trust it wrote
 * the leak back in. The contract now says "when this block and the shipped file disagree, the
 * shipped file wins and the divergence is a finding", and until this file existed nothing
 * enforced that sentence. It is a REGRESSION GUARD, green from the moment it was written: the
 * two artifacts agree today and this test is what keeps the next commit from parting them.
 *
 * WHAT IS COMPARED, AND WHY IT IS NOT A TEXT DIFF. `writing-good-tests.md` warns against
 * asserting that a document contains an exact line, because that proves only that the source
 * is the source. This is the one shape where the document IS the artifact under test: the
 * fence is a normative copy of executable configuration, and the property is that the copy is
 * still the original. So the comparison is on MEANING as far as a comment-stripping,
 * whitespace-collapsing normaliser can carry it — the fence may carry its own shorter
 * comments and its own line breaks and still pass, and cannot carry a different redact path,
 * a different depth bound, a reordered declaration or a dropped wrapper.
 *
 * CONTIGUITY IS THE POINT. The normalised fence must appear in the normalised source as ONE
 * unbroken run. A per-declaration "is each line present somewhere" check passes when a
 * declaration is dropped from between two that remain, and a dropped declaration is exactly
 * the shape F-251 and F-258 had: one wrapper missing, everything around it intact.
 *
 * THE NORMATIVE REGION is the fence's own claim: `logger.ts` from `import pino from 'pino';`
 * through the end of `isWalkable`. Everything after it — `errorLogFields` and its helpers —
 * belongs to `error-envelope.md` and the fence does not reproduce it.
 *
 * AND THE REGION IS ANCHORED AT BOTH ENDS (F-270). Contiguity alone is a SUBSTRING check,
 * and a substring is open at both ends: dropping the last declaration from the fence leaves
 * a shorter needle that is still found, and adding a declaration to the source just after
 * the region leaves the needle found in a longer haystack. Both stayed green, and both are
 * the edge where new declarations actually get added. So the region is CUT from the source
 * between two anchors and compared for EQUALITY. The end anchor is the first declaration
 * after the region — `export interface RequestLogFields` — because "the end of `isWalkable`"
 * is not something a text comparison can locate on its own, and anything inserted between
 * the two is inside the region by the contract's definition and must appear in the fence.
 */

const SOURCE_PATH = new URL('./logger.ts', import.meta.url);

/**
 * Four levels up from `apps/api/src/observability/`. The contract is committed, so this
 * resolves from a clean clone (ADR-0001); if it ever does not, the read throws with the path
 * in the message, which is the correct outcome — a missing contract is not a passing test.
 */
const CONTRACT_PATH = new URL(
  '../../../../.sdlc/foundation/design/contracts/logging-and-headers.md',
  import.meta.url,
);

/**
 * The fence the contract designates as machine-checked. Selected by content rather than by
 * position so that editing the prose around it cannot silently re-aim this test at a
 * different block.
 */
const FENCE_MARKER = 'export const REDACT_PATHS';

/**
 * The two ends of the normative region, in NORMALISED form, as they appear in the shipped
 * source. The region runs from the first up to — and not including — the second.
 *
 * `RequestLogFields` is the first declaration `error-envelope.md` owns rather than this
 * contract, so it is the boundary, and a declaration inserted before it is inside the
 * region and belongs in the fence.
 */
const REGION_START = "import pino from 'pino';";
const REGION_END = 'export interface RequestLogFields';

/**
 * The region, cut out of the normalised source. Throws rather than returning something
 * approximate: an anchor that has moved makes every comparison below meaningless, and a
 * silent `-1` would turn that into a passing test.
 */
function normativeRegion(normalisedSource: string): string {
  const start = normalisedSource.indexOf(REGION_START);
  const end = normalisedSource.indexOf(REGION_END);

  if (start === -1 || end === -1 || end < start) {
    throw new Error(
      `the normative region's anchors are not both in the shipped source in order: ` +
        `'${REGION_START}' at ${String(start)}, '${REGION_END}' at ${String(end)}. ` +
        'One of them was renamed; re-anchor this test against the contract.',
    );
  }

  if (normalisedSource.indexOf(REGION_START, start + 1) !== -1) {
    throw new Error(`'${REGION_START}' occurs more than once, so the region's start is ambiguous.`);
  }

  return normalisedSource.slice(start, end).trim();
}

/**
 * A redact path with a DOUBLE quote inside a SINGLE-quoted string. It is here because it is
 * the input that separates a real strip from a plausible one: a stripper that does not
 * remember which quote opened the string leaves the string half way through, and from there
 * it reads code as text and text as code. The danger is not that it fails — it is that it
 * mangles BOTH artifacts the same way and the comparison passes on garbage.
 */
const NESTED_QUOTE_PATH = '\'req.headers["fly-client-ip"]\'';

/**
 * Comments removed, and every run of whitespace OUTSIDE a string collapsed to one space.
 *
 * Whitespace inside a string is left exactly as it is: the strings are the payload here —
 * redact paths, the censor, the fixed context message — and collapsing inside them would let
 * `'an  error'` satisfy `'an error'`. A comment collapses to a separator rather than to
 * nothing, so `a/* x *\/b` cannot pass for `ab`.
 *
 * KNOWN LIMIT: regular-expression literals are not tokenised. The normative region holds
 * none, and a regex carrying a quote or a `//` would corrupt the text AFTER it — which
 * removes matter from the comparison and turns this test RED, never green. The failure
 * direction is the safe one, and it is loud.
 */
export function normalised(text: string): string {
  let out = '';
  let index = 0;
  let mode: 'code' | 'line' | 'block' | 'string' = 'code';
  let quote = '';
  let separatorPending = false;

  const emit = (chunk: string): void => {
    if (separatorPending && out !== '') {
      out += ' ';
    }
    separatorPending = false;
    out += chunk;
  };

  while (index < text.length) {
    const char = text[index];
    const next = text[index + 1];

    if (mode === 'code') {
      if (char === '/' && next === '/') {
        mode = 'line';
        separatorPending = true;
        index += 2;
      } else if (char === '/' && next === '*') {
        mode = 'block';
        separatorPending = true;
        index += 2;
      } else if (char === "'" || char === '"' || char === '`') {
        emit(char);
        mode = 'string';
        quote = char;
        index += 1;
      } else if (/\s/.test(char)) {
        separatorPending = true;
        index += 1;
      } else {
        emit(char);
        index += 1;
      }
      continue;
    }

    if (mode === 'line') {
      if (char === '\n') {
        mode = 'code';
      }
      index += 1;
      continue;
    }

    if (mode === 'block') {
      if (char === '*' && next === '/') {
        mode = 'code';
        index += 2;
      } else {
        index += 1;
      }
      continue;
    }

    // Inside a string: copied verbatim, and only the quote that opened it closes it.
    if (char === '\\') {
      out += char + (next ?? '');
      index += 2;
      continue;
    }

    out += char;
    if (char === quote) {
      mode = 'code';
    }
    index += 1;
  }

  return out.trim();
}

/** Every ` ```ts ` block in the contract. */
function typescriptFences(document: string): readonly string[] {
  return [...document.matchAll(/```ts\n([\s\S]*?)\n```/g)].map((match) => match[1]);
}

/**
 * Where the fence stops being findable in the source, with both sides quoted around that
 * point. A drift failure that printed two 5 kB strings would be read by nobody; this is the
 * part of the report an author can act on. It is a DIAGNOSTIC ONLY — the assertion it
 * accompanies is the plain `includes`, so a bug in here cannot make a divergence pass.
 */
function divergence(source: string, fence: string): string {
  let matched = 0;

  while (matched < fence.length && source.includes(fence.slice(0, matched + 1))) {
    matched += 1;
  }

  const before = fence.slice(Math.max(0, matched - 200), matched);
  const at = source.indexOf(before);

  return [
    `the contract's logger fence stops matching the shipped source at fence character ${String(matched)} of ${String(fence.length)}.`,
    `contract: …${fence.slice(Math.max(0, matched - 200), matched + 200)}`,
    `shipped : …${at === -1 ? '(the preceding 200 characters are not in the source either)' : source.slice(at, at + 400)}`,
  ].join('\n');
}

const contract = readFileSync(CONTRACT_PATH, 'utf8');
const source = readFileSync(SOURCE_PATH, 'utf8');
const loggerFences = typescriptFences(contract).filter((fence) => fence.includes(FENCE_MARKER));

describe("the contract's logger block against the shipped logger", () => {
  it('the contract carries exactly one fenced logger configuration, so the check below cannot address the wrong one', () => {
    // Without this, a second fence carrying `export const REDACT_PATHS` would leave the test
    // below silently checking whichever came first and the other one unchecked.
    //
    // NOT NAMED FOR F-250, DELIBERATELY. F-250 was the same configuration surviving in a
    // THIRD ARTIFACT — ADR-0022 — and this test reads only the contract, so it would not have
    // caught it. It catches F-250's shape inside the one file it reads. See the report.
    expect(loggerFences).toHaveLength(1);
  });

  it('F-249: the contract’s logger block is a contiguous region of the shipped logger', () => {
    // Green today. It goes red when either side moves alone: a redact path added to the file
    // and not to the contract, a wrapper dropped from the file, a depth bound changed in the
    // contract, a declaration removed from between two that stay.
    const normalisedSource = normalised(source);
    const normalisedFence = normalised(loggerFences[0]);

    expect(
      normalisedSource.includes(normalisedFence),
      divergence(normalisedSource, normalisedFence),
    ).toBe(true);
  });

  it('F-270: the fence covers the whole normative region and nothing outside it', () => {
    // The test above is a SUBSTRING check and a substring is open at both ends. Measured on
    // copies by `sdlc-reviewer`: dropping the trailing declaration from the FENCE leaves a
    // shorter needle that is still found, and adding a declaration to the SOURCE after the
    // region leaves the same needle found in a longer haystack. Both stayed green, and the
    // end of the region is exactly where a new wrapper gets appended — which is the shape
    // F-251 and F-258 both had.
    //
    // So the region is cut between its two anchors and compared for equality. The comparison
    // is asserted as a BOOLEAN, like the one above and for the same reason: `toBe` on two
    // multi-kilobyte strings prints both of them in full, and the divergence report is the
    // part an author can act on.
    const normalisedSource = normalised(source);
    const normalisedFence = normalised(loggerFences[0]);
    const region = normativeRegion(normalisedSource);

    const report = [
      `the contract's fence and the shipped logger's normative region are not the same text ` +
        `(fence ${String(normalisedFence.length)} characters, region ${String(region.length)}).`,
      divergence(region, normalisedFence),
    ].join('\n');

    expect(region === normalisedFence, report).toBe(true);
  });

  it('the redact path with an inner double quote survives the strip on both artifacts', () => {
    // The liar direction, checked on the REAL artifacts: a stripper that mangles this path
    // mangles it identically on both sides, and the comparison above then passes while
    // whole spans of both artifacts go unchecked. If this path is intact after the strip, the
    // strip did not leave the string.
    expect(normalised(source)).toContain(NESTED_QUOTE_PATH);
    expect(normalised(loggerFences[0])).toContain(NESTED_QUOTE_PATH);
  });

  it('the strip keeps a `//` that is inside a string and drops one that is not', () => {
    // The same hazard on an input the artifacts do not currently contain, so the guard above
    // cannot quietly stop meaning anything the day a path changes. Expected value written by
    // hand rather than produced by the normaliser.
    const input = [
      'const paths = [\'req.headers["fly-client-ip"]\', \'https://example.test/a\']; // dropped',
      'const depth = 4; /* dropped */',
    ].join('\n');

    expect(normalised(input)).toBe(
      'const paths = [\'req.headers["fly-client-ip"]\', \'https://example.test/a\']; const depth = 4;',
    );
  });
});
