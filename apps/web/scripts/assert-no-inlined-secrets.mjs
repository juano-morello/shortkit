/**
 * `pnpm --filter @shortkit/web assert:no-secrets`
 *
 * Contract: TASK-004.md (F-078's AC-113, F-084's split, and the round 1/2/3 fixes:
 * F-154/F-155/F-156/F-160/F-161/F-163/F-164/F-165/F-167/F-168), ADR-0014,
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
 * KNOWN CEILING, NOT FIXED HERE (F-157, routed to TASK-012/ADR-0014, not this TASK — do not
 * attempt from this file). Per-request dynamic server rendering (any route that reads
 * `cookies()`, which is every authenticated dashboard route under ADR-0014) produces no
 * on-disk `.next` artifact at all, so this scan cannot see it in principle. This script covers
 * build-time inlining and prerendered output only.
 *
 * ONE LEAK TARGET, DELIBERATELY (F-154, round 1, escalated to and ruled by Juano — see
 * `LEAK_TARGET_VAR` below for why `API_BASE_URL` is not checked).
 *
 * POSITIVE CONTROL, CONDITIONAL ON A SOURCE REFERENCE (F-156 round 1, F-161 round 2). The
 * script reads its search values from its own environment at check time; nothing by itself
 * proves that environment matches the one the build actually ran with. `vercel.json`'s
 * `buildCommand` closes that gap structurally for the deploy path by chaining this script onto
 * the build that just ran, in the same process environment. `POSITIVE_CONTROL_VAR` closes it
 * for any other invocation (e.g. a future CI step that builds and checks separately): if source
 * code references it, its value must show up in the output, or the environments disagreed.
 *
 * Round 1 asserted the value's presence unconditionally, which fails on today's `apps/web` —
 * nothing yet reads `process.env.NEXT_PUBLIC_API_BASE_URL` (TASK-008 adds the first read), and
 * Next only inlines a `NEXT_PUBLIC_` variable where it is textually referenced, so there was
 * nothing for a real value to produce (F-161, self-identified by `sdlc-security-auditor`: it
 * specified "assert present" assuming a reference already existed and hadn't checked). As of
 * round 2 the control activates only when `hasSourceReference()` finds a real reference under
 * `apps/web`'s own source — see that function and `POSITIVE_CONTROL_VAR` below for the three
 * constraints the auditor called not optional when resolving it this way.
 *
 * ROUND 3 (F-167, major): round 2's activation condition and search scope described different
 * sets of builds. Any textual reference activated the control, but the search stayed bound to
 * the two browser-delivery roots — so a server-only reference (turbopack places server
 * application code in `.next/server/chunks`, not under either delivery root) or a test-only
 * reference (a vitest spec naming the variable, never compiled by Next) activated a control that
 * then had nothing to find, reddening a build with nothing wrong with it and printing a false
 * diagnosis. Fixed two ways, both required together: (1) the positive control's search — and
 * only the positive control's, never the leak scan — now covers all of `.next` except
 * `.next/cache` (turbopack's incremental build cache, not deployed output); see
 * `POSITIVE_CONTROL_SCAN_EXCLUDED_DIRS` below. (2) `hasSourceReference` now excludes
 * `*.spec.*`/`*.test.*` files and matches the full `process.env.NEXT_PUBLIC_API_BASE_URL`
 * expression rather than the bare variable name — see `SOURCE_TEST_FILE_PATTERN` and
 * `POSITIVE_CONTROL_REFERENCE` below.
 *
 * Run after `pnpm --filter @shortkit/web build`, with `BFF_PROXY_SECRET` and (once TASK-008
 * lands) `NEXT_PUBLIC_API_BASE_URL` set in the environment to the same real values the build
 * ran with. `vercel.json`'s `buildCommand` does this for the deploy that matters; TASK-002's CI
 * workflow (`.github/**`, outside this TASK's paths, F-084's split) is a second, earlier
 * invocation of the same command.
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
 * Deliberately NOT widened to `.next/server/chunks` or the rest of `.next` (F-167's fix touches
 * `POSITIVE_CONTROL_SCAN_ROOT` below instead): widening the leak scan itself would red on any
 * legitimate server-side read of `BFF_PROXY_SECRET`, which is exactly what TASK-012's proxy
 * route will write. These two roots are where a value becomes reachable by a request the API
 * never authenticated; server-side-only code paths are the secret's entire legitimate use.
 */
const SCAN_ROOTS = [
  { name: '.next/static', dir: path.join(process.cwd(), '.next', 'static') },
  { name: '.next/server/app', dir: path.join(process.cwd(), '.next', 'server', 'app') },
];

/**
 * F-167's fix, part 1. The positive control's search — never the leak scan's — covers all of
 * `.next`, because proving build/check environment agreement does not require the value to be
 * browser-reachable: a server component or route handler reading
 * `process.env.NEXT_PUBLIC_API_BASE_URL` without rendering it is still real evidence the build
 * saw the variable, and turbopack places that code under `.next/server/chunks`, outside both of
 * `SCAN_ROOTS`. `.next/cache` is excluded — it is turbopack's incremental build cache, never
 * part of what Vercel serves or what "the build ran with real values" means, and can hold tens
 * of megabytes of binary blobs a text search gains nothing from reading.
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
 * F-156's positive control, gated as of F-161. `NEXT_PUBLIC_API_BASE_URL` is genuinely public
 * (see `LEAK_TARGET_VAR` above), so its value being present in the output is not itself a
 * finding — it is proof the build ran with the same environment this check is reading, which
 * the check otherwise has no way to confirm. It only makes sense to assert presence once some
 * source file actually reads it; `hasSourceReference()` below decides that at run time instead
 * of assuming it, which is exactly what round 1 got wrong.
 */
const POSITIVE_CONTROL_VAR = 'NEXT_PUBLIC_API_BASE_URL';

/**
 * F-167's fix, part 2. Round 2 activated the control on the bare variable name appearing
 * anywhere in source, which a code comment, a type export, or (reproduced) a vitest spec title
 * satisfies without the build ever reading the variable. Matching the full expression a real
 * read actually looks like is a tighter, still-conservative signal — it still cannot detect
 * every possible read (a destructured `process.env` access would slip past this too), but a
 * miss there fails closed the same way an unnarrowed bare-name match did, just less often.
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
 * exactly — every file, no exclusion. F-167 adds the one caller that passes a non-empty set:
 * the positive control's wider `.next` scan, which excludes `cache` (see
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
 * `BFF_PROXY_SECRET`. This function stays in place because `POSITIVE_CONTROL_VAR` is a URL, not
 * a charset-gated secret, and the cheap extra pass still costs nothing.
 */
function matchesValue(contents, value) {
  if (contents.includes(value)) {
    return true;
  }

  const jsonEscaped = JSON.stringify(value).slice(1, -1);
  return jsonEscaped !== value && contents.includes(jsonEscaped);
}

/**
 * F-161, constraint 1. Directories the source scan never enters. `.next` and `node_modules`
 * are build output and dependencies, not this app's source. `scripts` holds this very file,
 * which names `POSITIVE_CONTROL_VAR` repeatedly in its own comments — scanning it would make
 * the positive control activate itself immediately regardless of whether any real code reads
 * the variable, reproducing F-161's failure one layer of indirection down.
 *
 * NOT extended to `../../packages/contracts` (F-168, minor, accepted as documented rather than
 * fixed): `next.config.ts`'s `transpilePackages: ['@shortkit/contracts']` means a read inside
 * that workspace package also gets `NEXT_PUBLIC_` inlining, and this scan would miss it and
 * report the control inactive when it should be active. Crossing into another workspace from a
 * script whose paths are `apps/web/**` blurs a boundary this TASK doesn't own resolving, for a
 * package that is (today) pure zod schema with no reason to read a Vercel env var. The honest
 * fix taken instead: the messages below (`hasSourceReference`'s callers) say exactly what was
 * and was not searched, rather than implying whole-repo coverage.
 */
const SOURCE_EXCLUDED_DIRS = new Set(['.next', 'node_modules', 'scripts']);

/**
 * F-167, constraint 2. A vitest spec naming `NEXT_PUBLIC_API_BASE_URL` — reproduced by the
 * auditor — is a file Next never compiles, so it cannot possibly be the reference that would
 * cause real inlining. Excluding it (and the `.test.` convention some projects use instead)
 * removes exactly the false-activation shape F-167 reproduced, without narrowing coverage of
 * anything Next actually builds.
 */
const SOURCE_TEST_FILE_PATTERN = /\.(spec|test)\.[^./]+$/;

/**
 * Only file types Next.js or the test runner actually execute are treated as source. This is
 * what excludes `apps/web/.env.example` and `package.json` without a hardcoded per-file
 * exception list — `.env.example` names both env vars in plain text and would "activate" the
 * positive control the same way the script's own header would, for the same underlying reason.
 *
 * F-170: this set tracks Next's `pageExtensions` (default `['tsx', 'ts', 'jsx', 'js']` as of
 * Next 16.3, plus `.mjs`/`.cjs` for parity with this repo's own module files) — not a fixed
 * list independent of it. If `pageExtensions` is ever widened (the standard case is adding
 * `@next/mdx` for `.mdx`/`.md`), this set needs the same change in the same commit, or a
 * client-reachable `.mdx` read of `NEXT_PUBLIC_API_BASE_URL` becomes invisible to this scan the
 * same way F-168's `transpilePackages` gap is. Not widened speculatively now: `@next/mdx` is not
 * a dependency of this workspace.
 */
const SOURCE_FILE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);

async function collectSourceFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SOURCE_EXCLUDED_DIRS.has(entry.name)) {
        continue;
      }

      files.push(...(await collectSourceFiles(path.join(dir, entry.name))));
    } else if (
      entry.isFile() &&
      SOURCE_FILE_EXTENSIONS.has(path.extname(entry.name)) &&
      !SOURCE_TEST_FILE_PATTERN.test(entry.name)
    ) {
      files.push(path.join(dir, entry.name));
    }
  }

  return files;
}

/**
 * F-161 (option (a), routed and ruled by `sdlc-security-auditor`, the agent that specified the
 * control and owned getting its wording wrong in round 1 — see `POSITIVE_CONTROL_VAR` above).
 * True only if some non-test source file under `apps/web` (excluding `.next/`, `node_modules/`,
 * `scripts/` — constraint 1 — and `*.spec.*`/`*.test.*` files — F-167 constraint 2) textually
 * references `reference`, which callers pass as `POSITIVE_CONTROL_REFERENCE`
 * (`process.env.NEXT_PUBLIC_API_BASE_URL`), not the bare variable name.
 *
 * Matching the full expression instead of the bare name closes F-167's reproduced false
 * activation (a comment or an unrelated identifier containing the variable's name), but does not
 * make this exhaustive — a destructured `const { NEXT_PUBLIC_API_BASE_URL } = process.env` would
 * still slip past. A residual false "active" here still fails closed rather than vacuously
 * passing, which stays the safe direction to be wrong in.
 */
async function hasSourceReference(reference) {
  const files = await collectSourceFiles(process.cwd());

  for (const file of files) {
    const contents = await readFile(file, 'utf8');

    if (contents.includes(reference)) {
      return true;
    }
  }

  return false;
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

  const positiveControlActive = await hasSourceReference(POSITIVE_CONTROL_REFERENCE);
  let positiveControl = null;

  if (positiveControlActive) {
    try {
      positiveControl = {
        name: POSITIVE_CONTROL_VAR,
        value: readRequiredValue(POSITIVE_CONTROL_VAR),
      };
    } catch (error) {
      console.error(`FAIL: ${error.message}`);
      process.exitCode = 1;
      return;
    }
  }

  // --- BFF_PROXY_SECRET leak scan: SCAN_ROOTS only, never widened (F-167's own required
  // constraint). This loop never reads positiveControl.
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
        'path (ADR-0014).',
    );
    process.exitCode = 1;
    return;
  }

  // --- Positive control scan: POSITIVE_CONTROL_SCAN_ROOT only (all of `.next` except
  // `.next/cache` — F-167's fix, part 1), entirely separate from the leak scan above, and only
  // run at all when the control is active. `.next` is guaranteed to exist here — the leak scan
  // above already confirmed both of its subdirectories (SCAN_ROOTS) exist and are non-empty.
  const perRootSummary = filesByRoot
    .map(({ root, files }) => `${root} (${String(files.length)})`)
    .join(', ');

  const sourceScanDescription =
    'apps/web (.ts/.tsx/.js/.jsx/.mjs/.cjs files, excluding .next/, node_modules/, scripts/, ' +
    'and *.spec.*/*.test.* files — does not include workspace packages such as ' +
    '@shortkit/contracts, even though next.config.ts transpiles one; F-168)';

  if (positiveControlActive) {
    let positiveControlFound = false;

    for (const file of await collectFiles(
      POSITIVE_CONTROL_SCAN_ROOT.dir,
      POSITIVE_CONTROL_SCAN_EXCLUDED_DIRS,
    )) {
      const contents = await readFile(file, 'utf8');

      if (matchesValue(contents, positiveControl.value)) {
        positiveControlFound = true;
        break;
      }
    }

    if (!positiveControlFound) {
      console.error(
        `FAIL: ${positiveControl.name}'s value was not found anywhere under ` +
          `${POSITIVE_CONTROL_SCAN_ROOT.name} (excluding cache/), even though ${sourceScanDescription} ` +
          `references \`${POSITIVE_CONTROL_REFERENCE}\`. This is the positive control ` +
          "(F-156/F-161/F-167): its presence is what proves the build actually ran with this " +
          'check\'s environment. A reference existing without the value landing anywhere in ' +
          '.next means the build ran without a real value for this variable, or with a ' +
          'different one than this check is now reading.',
      );
      process.exitCode = 1;
      return;
    }

    console.log(
      `OK: checked ${String(totalFiles)} file(s) across ${perRootSummary} for ` +
        `${secret.name}, no leaked value found; positive control confirmed (${sourceScanDescription} ` +
        `references \`${POSITIVE_CONTROL_REFERENCE}\`, and its value is present somewhere under ` +
        `${POSITIVE_CONTROL_SCAN_ROOT.name}).`,
    );
  } else {
    console.log(
      `OK: checked ${String(totalFiles)} file(s) across ${perRootSummary} for ${secret.name}, ` +
        `no leaked value found. NOTICE: no reference to \`${POSITIVE_CONTROL_REFERENCE}\` found ` +
        `in ${sourceScanDescription} — the positive control is inactive, so this run does NOT ` +
        'prove build/check environment agreement (F-161/F-167). It activates automatically the ' +
        'first time non-test code under apps/web reads that expression (TASK-008).',
    );
  }
}

await main();
