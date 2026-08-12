/**
 * `pnpm --filter @shortkit/web assert:no-secrets`
 *
 * Contract: TASK-004.md (F-078's AC-113, F-084's split, and the round 1-6 fixes:
 * F-154/F-155/F-156/F-160/F-161/F-163/F-164/F-165/F-167/F-171/F-172/F-173/F-175), ADR-0014,
 * design/contracts/web-api-client.md
 * Produced by: TASK-004
 *
 * WHY THIS EXISTS. `BFF_PROXY_SECRET` is a required, server-only Vercel project variable
 * (ADR-0014), never carrying the `NEXT_PUBLIC_` prefix that would inline it into client
 * JavaScript — but that rule lives in an ADR and a TASK card, not in anything a typecheck or
 * a happy-path test reads. A future edit that moves the read behind a `NEXT_PUBLIC_*` alias,
 * or into a client component that reads it directly, ships a working build and a green
 * typecheck while publishing the secret to every browser. It is what the API's constant-time
 * match trusts before honouring a forwarded client address; published, it lets anyone forge
 * `x-shortkit-client-ip` and collapse every IP-keyed rate-limit bucket into one shared by the
 * whole product (web-api-client.md, ADR-0014 Consequences). This script is the only thing
 * that looks.
 *
 * It searches for the value, not the variable name — the `NEXT_PUBLIC_` inlining this guards
 * against substitutes the literal value at build time and leaves no trace of the variable
 * name behind.
 *
 * TWO ROOTS, NOT ONE (F-155, round 1, blocker — reproduced by the auditor building this exact
 * app and curling the result). `.next/static/**` is only where webpack/turbopack-inlined
 * `NEXT_PUBLIC_*` references land. A server component reading `process.env.BFF_PROXY_SECRET`
 * and passing it as a prop to a `'use client'` component — the single most common Next.js
 * server-data leak — puts the value in prerendered HTML and RSC flight payloads under
 * `.next/server/app/**` instead, which an unauthenticated `curl` of the page returns just as
 * directly. Both roots are scanned, every file in each, not a fixed extension list, because a
 * leak takes whatever shape the framework's internal file naming happens to produce next.
 * Neither root may be silently skipped when absent, and — as of round 2 (F-163) — neither may
 * silently count as covered when present but empty. See `SCAN_ROOTS` and its handling below.
 *
 * WHY THE LEAK SCAN STAYS BOUND TO THOSE TWO ROOTS (F-172, round 4 — corrects a false reason
 * given for the same correct conclusion in round 3). It is NOT because widening would false-
 * positive on a legitimate server-side read of `BFF_PROXY_SECRET` — verified by building, that
 * risk does not exist: only `NEXT_PUBLIC_`-prefixed variables get build-time literal
 * substitution, so a plain `process.env.BFF_PROXY_SECRET` read compiles to a runtime property
 * access (`"string"==typeof process.env.BFF_PROXY_SECRET`) and the secret's bytes never reach
 * `.next` at all unless the value is actually rendered, serialised, hardcoded, or aliased
 * through a `NEXT_PUBLIC_*`/`next.config` `env:` entry — every one of which is already a defect.
 * The real reason to keep the scan narrow is precision of meaning: `.next/static` and
 * `.next/server/app` are exactly the artifacts an unauthenticated request can retrieve, so a red
 * there means "this secret is reachable by anyone right now" — a claim the failure message below
 * states outright. Widening to all of `.next` would only ever catch a secret baked in somewhere
 * *not* browser-reachable (one client import away from becoming reachable, but not reachable
 * yet), which is real hardening but a different, weaker claim ("this was baked in somewhere")
 * that the current failure message does not make and is not written to make.
 *
 * KNOWN CEILING, NOT FIXED HERE (F-157, routed to TASK-012/ADR-0014, not this TASK — do not
 * attempt from this file). Per-request dynamic server rendering (any route that reads
 * `cookies()`, which is every authenticated dashboard route under ADR-0014) produces no
 * on-disk `.next` artifact at all, so this scan cannot see it in principle. This script covers
 * build-time inlining and prerendered output only.
 *
 * ONE LEAK TARGET, DELIBERATELY (F-154, round 1, escalated to and ruled by Juano — see
 * `LEAK_TARGET_VAR` below for why `API_BASE_URL` is not checked).
 *
 * POSITIVE CONTROL — BUILD-DERIVED, NOT SOURCE-DERIVED (F-156 round 1, F-161 round 2, F-167
 * round 3, F-171 round 4). The script reads its search values from its own environment at check
 * time; nothing by itself proves that environment matches the one the build actually ran with.
 * `vercel.json`'s `buildCommand` closes that gap structurally for the deploy path by chaining
 * this script onto the build that just ran, in the same process environment. The positive
 * control closes it for any other invocation (e.g. a future CI step that builds and checks
 * separately).
 *
 * Rounds 1-3 inferred whether the control should be active from SOURCE TEXT (first "always",
 * then "if some source file mentions the variable"), while the control's evidence always came
 * from BUILD OUTPUT. Those two things agree only when the reference is actually reachable from
 * an entrypoint turbopack compiles — and disagree, reproducibly, whenever it is not: a server-
 * only reference not rendered anywhere (round 3), a spec file Next never compiles (round 3), and
 * — the one three rounds of narrowing the SOURCE side never closed, because it is not a source-
 * side problem — a real, correct module under `apps/web/src/lib/api/**` that no page imports yet
 * (round 4, reproduced on TASK-008's literal shape: TASK-008.md declares exactly that path,
 * lists this variable as consumed, and puts every screen that would import it out of scope).
 * Round 4 removes the source scan entirely and derives activation from the same ground truth the
 * control's evidence always came from — see `POSITIVE_CONTROL_VAR`'s handling in `main()` below
 * for the three-way discriminator this replaces it with.
 *
 * Run after `pnpm --filter @shortkit/web build`, with `BFF_PROXY_SECRET` always set, and
 * `NEXT_PUBLIC_API_BASE_URL` set once some compiled module actually reads it (see `main()` — an
 * unset value only matters once the build shows a reference exists to compare it against).
 * `vercel.json`'s `buildCommand` does this for the deploy that matters; TASK-002's CI workflow
 * (`.github/**`, outside this TASK's paths, F-084's split) is a second, earlier invocation of the
 * same command.
 *
 * NOT TYPECHECKED, by construction rather than by an added exclusion: `apps/web/tsconfig.json`'s
 * `include` list only matches TypeScript globs (`.ts`, `.tsx`, plus a few named files); this file's
 * `.mjs` extension already falls outside that glob, so no tsconfig edit was needed to keep
 * it out (contrast `apps/api/scripts/check-policies.mts`, F-133/F-135, which needed an
 * explicit exclusion because `.mts` files are picked up by a broader include). Node runs
 * this by stripping nothing at all — it's plain ESM — so ordinary Node module syntax only.
 *
 * `root eslint.config.mjs` (outside this TASK's paths) declares no Node globals for plain
 * `.mjs` files — only the `.mts` precedent gets one, indirectly, through typescript-eslint's
 * bundled override of core `no-undef`. The directive below scopes the two Node globals this
 * file needs to itself rather than touching that config.
 */
/* global process, console */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * The `BFF_PROXY_SECRET` leak scan's roots — and only the leak scan's. `.next/static/**` alone
 * misses prerendered HTML and RSC flight payloads. Both roots are walked in full — no extension
 * filter — because the leak this guards against can surface as `.html`, `.rsc`, `.segment.rsc`,
 * a `.meta`/`.segments` file, or something a future Next version names differently; scanning
 * every file is the only form of this that doesn't need updating when the internal naming does.
 *
 * Deliberately NOT widened to `.next/server/chunks` or the rest of `.next` (F-172 explains why,
 * above the file header's "WHY THE LEAK SCAN STAYS BOUND" section — not a false-positive risk,
 * a precision-of-meaning choice). The positive control's separate, wider scan lives at
 * `POSITIVE_CONTROL_SCAN_ROOT` below.
 */
const SCAN_ROOTS = [
  { name: '.next/static', dir: path.join(process.cwd(), '.next', 'static') },
  { name: '.next/server/app', dir: path.join(process.cwd(), '.next', 'server', 'app') },
];

/**
 * The positive control's scan root — never the leak scan's. Proving build/check environment
 * agreement does not require the value to be browser-reachable: a server component or route
 * handler that reads `process.env.NEXT_PUBLIC_API_BASE_URL` without rendering it is still real
 * evidence the build saw the variable, and turbopack places that compiled code under
 * `.next/server/chunks`, outside both of `SCAN_ROOTS` (F-167). `.next/cache` is excluded — it is
 * turbopack's incremental build cache, never part of what Vercel serves or what "the build ran
 * with real values" means, and can hold tens of megabytes of binary blobs a text search gains
 * nothing from reading. Verified across three builds (round 3) that nothing survives there that
 * doesn't also survive in the non-cache tree, so excluding it costs no real coverage.
 */
const POSITIVE_CONTROL_SCAN_ROOT = { name: '.next', dir: path.join(process.cwd(), '.next') };
const POSITIVE_CONTROL_SCAN_EXCLUDED_DIRS = new Set(['cache']);

/**
 * The one value this script treats as a leak. `BFF_PROXY_SECRET` has no legitimate public
 * counterpart anywhere in this build — if its value appears in any build artifact, that is a
 * leak, full stop.
 *
 * `API_BASE_URL` was checked here in round 1 and is deliberately NOT checked as of round 2
 * (F-154, escalated to and ruled by Juano — the reviewer proved the original check false-
 * positives on every correct build). `API_BASE_URL` is not confidential: it is the public Fly
 * hostname, committed in cleartext in `.env.example`, discoverable from any redirect response,
 * and — by ADR-0006 and ADR-0014's design, not by accident — given the identical value to
 * `NEXT_PUBLIC_API_BASE_URL`. Checking it bought no confidentiality and cost the guard's
 * credibility: the moment client code reads `NEXT_PUBLIC_API_BASE_URL` (TASK-008, that
 * variable's entire purpose), every correct build fails this check forever, and the
 * predictable repair is to loosen the guard — which loosens the `BFF_PROXY_SECRET` path with
 * it. Do not re-add `API_BASE_URL` here without reopening that ruling.
 */
const LEAK_TARGET_VAR = 'BFF_PROXY_SECRET';

/**
 * F-156's positive control target. `NEXT_PUBLIC_API_BASE_URL` is genuinely public (see
 * `LEAK_TARGET_VAR` above), so its value being present in the output is not itself a finding —
 * it is proof the build ran with the same environment this check is reading, which the check
 * otherwise has no way to confirm.
 *
 * F-171 (round 4): activation is derived from the build, not inferred from source text. See the
 * three-way discriminator in `main()` — the name search there (matching
 * `POSITIVE_CONTROL_REFERENCE` below, not this bare variable name) is the mechanism that makes it
 * possible: a compiled *read* of this variable always leaves the reference somewhere under
 * `.next` (emitted literally when the build's own environment lacked a value to substitute;
 * surviving in the compiled SSR chunk's `.js.map` `sourcesContent` when a value WAS substituted,
 * because source maps embed the original source Next compiled from), while a reference that
 * exists in source but was never reached by an entrypoint — the shape three rounds of narrowing
 * the source scan could not close, because it isn't a source-side problem — leaves neither the
 * reference nor the value anywhere.
 *
 * CAVEAT TO RECORD: the "compiled with a real value substituted" branch of this discriminator
 * relies on the reference surviving in server source maps, which Next 16 emits by default
 * (`productionBrowserSourceMaps` governs only client maps and is unrelated). If server source
 * maps are ever disabled, that branch degrades from a comparison ("value present in the build →
 * pass") to a reference-only signal, which this script already treats as sufficient evidence of
 * activation — the FAIL branch (reference present, value absent) still requires a real mismatch
 * to fire, so a disabled source map cannot cause a false FAIL, only a less certain PASS.
 */
const POSITIVE_CONTROL_VAR = 'NEXT_PUBLIC_API_BASE_URL';

/**
 * F-175 (round 6): the discriminator above matches this full expression, not the bare variable
 * name. Round 4 matched `POSITIVE_CONTROL_VAR` bare, which activates on any compiled module that
 * merely *mentions* the name — a code comment, or a user-facing string like "Set
 * NEXT_PUBLIC_API_BASE_URL and redeploy" (the exact shape of an error surface under TASK-008's
 * declared `apps/web/src/components/errors/**`) — without the build ever having read it. That
 * mention still lands in a compiled chunk (a comment can survive in a source map; a string
 * literal is compiled verbatim), the value is absent because nothing read it, and round 4's
 * bare-name match reported that as a mismatch. Matching the full read expression instead is
 * exactly F-167's constraint 2, correct there for the source scan and dropped when round 4
 * replaced the source scan with this build-output scan — restored here rather than reinvented.
 *
 * RESIDUAL, NOT A MISS: a destructured read — `const { NEXT_PUBLIC_API_BASE_URL } = process.env`
 * — would not match this pattern either. That is correct, not a gap to close: turbopack does not
 * perform `NEXT_PUBLIC_` substitution on a destructured `process.env` access any more than it
 * substitutes one written as `process.env['NEXT_PUBLIC_API_BASE_URL']`, so no value is ever
 * inlined for either shape and the build-derived NOTICE (no evidence either way) is the accurate
 * outcome for both, not a false inactive. Do not "fix" this by loosening the pattern back toward
 * the bare name.
 */
const POSITIVE_CONTROL_REFERENCE = `process.env.${POSITIVE_CONTROL_VAR}`;

/**
 * F-160/F-164/F-165: `BFF_PROXY_SECRET`'s required shape, enforced here and stated in
 * `.env.example` in the same unit (characters) so the documented format, the enforced check
 * and the recommended generator agree.
 *
 * MIN_SECRET_LENGTH — a secret this short makes the search meaningless: either it matches
 * incidentally across large parts of the build output, or it is a placeholder that was never
 * going to be inlined anywhere.
 *
 * BASE64URL_PATTERN — F-164's cheaper fix in place of chasing escaping variants. A raw
 * substring search misses a value rendered in an escaped form (HTML entities, unicode escapes,
 * JSON quoting), and round 1's `JSON.stringify`-based extra pass only covered one of those
 * forms. Constraining the secret's charset to base64url removes the problem at its root: no
 * character in that alphabet is ever escaped by HTML entity encoding, `\uXXXX` unicode
 * escaping, or JSON string escaping, so a raw `.includes()` cannot be fooled by an escaped
 * rendering — there is no escaped rendering to be fooled by.
 */
const MIN_SECRET_LENGTH = 32;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * Reads a required value from the environment. Mirrors the convention in
 * `apps/api/scripts/check-policies.mts`'s `connectionString()`: throw with a message naming
 * what's missing and why the check needs it, rather than let an unset variable silently make
 * the search find nothing. A check that cannot run because its input is missing must fail
 * loudly — a vacuous pass here is the same shape of silent-green defect this script exists to
 * prevent.
 */
function readRequiredValue(name, { minLength, requireBase64Url } = {}) {
  const value = process.env[name];

  if (value === undefined || value.trim() === '') {
    throw new Error(
      `${name} is not set. This check searches the built output for this variable's value; ` +
        'without a real value there is nothing to search for, and the check would pass ' +
        'without having checked anything.',
    );
  }

  if (minLength !== undefined && value.length < minLength) {
    throw new Error(
      `${name} is ${String(value.length)} character(s), below the ${String(minLength)}-` +
        'character minimum this check requires (F-160). A short or placeholder value either ' +
        'matches incidentally across large parts of the build output or was never going to be ' +
        'inlined anywhere — see apps/web/.env.example for the required format.',
    );
  }

  if (requireBase64Url === true && !BASE64URL_PATTERN.test(value)) {
    throw new Error(
      `${name} contains a character outside the base64url alphabet (A-Z, a-z, 0-9, "-", "_", ` +
        'no padding). This check\'s escaped-form coverage (F-164) depends on the value never ' +
        'needing HTML-entity, unicode-escape or JSON-quote escaping in the first place — see ' +
        'apps/web/.env.example for a generator that produces a conforming value.',
    );
  }

  return value;
}

/**
 * `excludedDirNames` defaults to empty, which preserves `SCAN_ROOTS`' round-1/2 behaviour
 * exactly — every file, no exclusion. The one caller that passes a non-empty set is the
 * positive control's wider `.next` scan, which excludes `cache` (see
 * `POSITIVE_CONTROL_SCAN_EXCLUDED_DIRS` above).
 */
async function collectFiles(dir, excludedDirNames = new Set()) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const full = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      if (excludedDirNames.has(entry.name)) {
        continue;
      }

      files.push(...(await collectFiles(full, excludedDirNames)));
    } else if (entry.isFile()) {
      files.push(full);
    }
  }

  return files;
}

/**
 * F-160: plain substring matching misses an escaped rendering of the value. `JSON.stringify`
 * covers quote/backslash/control-character escaping, which is what round 2's reproduction
 * showed standalone `.rsc` files use. It does not cover HTML-entity or unicode-escape
 * renderings (F-164) — `BASE64URL_PATTERN` above is what actually closes that gap for
 * `BFF_PROXY_SECRET`. This function stays in place because `POSITIVE_CONTROL_VAR`'s value is a
 * URL, not a charset-gated secret, and the cheap extra pass still costs nothing.
 */
function matchesValue(contents, value) {
  if (contents.includes(value)) {
    return true;
  }

  const jsonEscaped = JSON.stringify(value).slice(1, -1);
  return jsonEscaped !== value && contents.includes(jsonEscaped);
}

async function main() {
  let secret;

  try {
    secret = {
      name: LEAK_TARGET_VAR,
      value: readRequiredValue(LEAK_TARGET_VAR, {
        minLength: MIN_SECRET_LENGTH,
        requireBase64Url: true,
      }),
    };
  } catch (error) {
    console.error(`FAIL: ${error.message}`);
    process.exitCode = 1;
    return;
  }

  // --- BFF_PROXY_SECRET leak scan: SCAN_ROOTS only, never widened (F-172).
  const filesByRoot = [];

  for (const root of SCAN_ROOTS) {
    let files;

    try {
      files = await collectFiles(root.dir);
    } catch (error) {
      if (error.code === 'ENOENT') {
        console.error(
          `FAIL: ${root.dir} does not exist. Run \`pnpm --filter @shortkit/web build\` ` +
            `first — this check inspects the built output under ${root.name}, not source, ` +
            'and has nothing to inspect before a build exists. A missing root is not skipped: ' +
            'F-155 was exactly a scan that silently covered too little.',
        );
        process.exitCode = 1;
        return;
      }

      throw error;
    }

    // F-163: a root that exists but is empty is the same vacuous pass as a missing root, one
    // level over — a Next.js layout change could relocate prerendered output while still
    // creating this directory, silently dropping coverage to a green log.
    if (files.length === 0) {
      console.error(
        `FAIL: ${root.dir} exists but contains no files. This check does not count an empty ` +
          `root as covered (F-163) — confirm \`pnpm --filter @shortkit/web build\` actually ` +
          `produced output under ${root.name} before trusting a pass here.`,
      );
      process.exitCode = 1;
      return;
    }

    filesByRoot.push({ root: root.name, files });
  }

  const leaks = [];
  let totalFiles = 0;

  for (const { root, files } of filesByRoot) {
    totalFiles += files.length;

    for (const file of files) {
      const contents = await readFile(file, 'utf8');

      if (matchesValue(contents, secret.value)) {
        leaks.push({ root, file, name: secret.name });
      }
    }
  }

  if (leaks.length > 0) {
    console.error(
      'FAIL: a server-only value was found in the built output:\n' +
        leaks
          .map(
            ({ root, file, name }) =>
              `  - ${name} in ${root} (${path.relative(process.cwd(), file)})`,
          )
          .join('\n') +
        '\n\nA value reaches .next/static/** by being read through a NEXT_PUBLIC_-prefixed ' +
        "variable in client code, and reaches .next/server/app/** by being passed — directly " +
        "or as a prop to a 'use client' component — into anything Next prerenders or " +
        `serialises as an RSC flight payload. ${secret.name} must never be reachable by either ` +
        'path (ADR-0014). This scan is deliberately narrow — see the file header for why ' +
        'widening it would weaken, not strengthen, what a red here means (F-172).',
    );
    process.exitCode = 1;
    return;
  }

  // --- Positive control: F-171's build-derived, three-way discriminator. Entirely separate
  // scan from the leak scan above (never widens it), and runs regardless of anything found in
  // source — there is no source scan left to run. `.next` is guaranteed to exist here — the
  // leak scan above already confirmed both of its subdirectories (SCAN_ROOTS) exist and are
  // non-empty.
  const perRootSummary = filesByRoot
    .map(({ root, files }) => `${root} (${String(files.length)})`)
    .join(', ');

  const rawPositiveControlValue = process.env[POSITIVE_CONTROL_VAR];
  const hasPositiveControlValue =
    rawPositiveControlValue !== undefined && rawPositiveControlValue.trim() !== '';

  const controlFiles = await collectFiles(
    POSITIVE_CONTROL_SCAN_ROOT.dir,
    POSITIVE_CONTROL_SCAN_EXCLUDED_DIRS,
  );

  let nameFound = false;
  let valueFound = false;

  for (const file of controlFiles) {
    const contents = await readFile(file, 'utf8');

    if (!nameFound && contents.includes(POSITIVE_CONTROL_REFERENCE)) {
      nameFound = true;
    }

    if (
      hasPositiveControlValue &&
      !valueFound &&
      matchesValue(contents, rawPositiveControlValue)
    ) {
      valueFound = true;
    }

    // Nothing more to learn once the name is confirmed and either the value is too (both
    // maxed out) or there is no value to compare against in the first place (valueFound can
    // never become true without one).
    if (nameFound && (valueFound || !hasPositiveControlValue)) {
      break;
    }
  }

  if (valueFound) {
    console.log(
      `OK: checked ${String(totalFiles)} file(s) across ${perRootSummary} for ${secret.name}, ` +
        `no leaked value found; positive control confirmed (${POSITIVE_CONTROL_VAR}'s value is ` +
        `present somewhere under ${POSITIVE_CONTROL_SCAN_ROOT.name}, excluding cache/).`,
    );
    return;
  }

  if (!nameFound) {
    console.log(
      `OK: checked ${String(totalFiles)} file(s) across ${perRootSummary} for ${secret.name}, ` +
        `no leaked value found. NOTICE: no compiled read of ${POSITIVE_CONTROL_VAR} (matching ` +
        `\`${POSITIVE_CONTROL_REFERENCE}\`) and no value for it were found anywhere under ` +
        `${POSITIVE_CONTROL_SCAN_ROOT.name} (excluding cache/). No compiled read means this run ` +
        'has no evidence either way, not evidence of a mismatch (F-171) — the positive control ' +
        'is inactive, and this run does NOT prove build/check environment agreement. It ' +
        'activates automatically the first time a module reachable from an entrypoint reads ' +
        `${POSITIVE_CONTROL_VAR} (TASK-008).`,
    );
    return;
  }

  // nameFound && !valueFound: a compiled read exists but its value is missing from the scan.
  // Requiring the value now (rather than up front) is what keeps this branch from firing before
  // the build has even shown the read exists — see the file header's F-171 section.
  let positiveControlValue;

  try {
    positiveControlValue = readRequiredValue(POSITIVE_CONTROL_VAR);
  } catch (error) {
    console.error(
      `FAIL: ${error.message} A compiled read of ${POSITIVE_CONTROL_VAR} was found under ` +
        `${POSITIVE_CONTROL_SCAN_ROOT.name}, so this check needs a real value to compare ` +
        'against it.',
    );
    process.exitCode = 1;
    return;
  }

  console.error(
    `FAIL: a compiled read of ${POSITIVE_CONTROL_VAR} was found under ` +
      `${POSITIVE_CONTROL_SCAN_ROOT.name} (excluding cache/), but this check's value ` +
      `(${String(positiveControlValue.length)} character(s)) is not present anywhere in that ` +
      "scan. This is the positive control (F-156/F-161/F-167/F-171/F-175): its match is what " +
      "proves the build actually ran with this check's environment. The build ran without a " +
      `real value for ${POSITIVE_CONTROL_VAR}, or with a different one than this check is now ` +
      'reading — the dominant real-world case is the Vercel project variable not being set for ' +
      'the environment this build ran in.',
  );
  process.exitCode = 1;
}

await main();
