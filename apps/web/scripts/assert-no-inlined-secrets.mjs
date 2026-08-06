/**
 * `pnpm --filter @shortkit/web assert:no-secrets`
 *
 * Contract: TASK-004.md (F-078's AC-113, F-084's split, F-154/F-155/F-156/F-160's round-1
 * fixes), ADR-0014, design/contracts/web-api-client.md
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
 * Neither root may be silently skipped when absent — see `SCAN_ROOTS` and its handling below.
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
 * POSITIVE CONTROL (F-156, round 1, major). The script reads its search values from its own
 * environment at check time; nothing by itself proves that environment matches the one the
 * build actually ran with. A build made without `BFF_PROXY_SECRET` exported, checked afterward
 * with a placeholder, finds nothing and passes forever while a real Vercel build — which does
 * have the real values — inlines them into a different artifact. Two things close that gap:
 * (1) `vercel.json`'s `buildCommand` now runs this script immediately after the build it just
 * produced, in the same environment, so there is only ever one artifact and one environment to
 * agree or disagree; and (2) `POSITIVE_CONTROL_VAR` below asserts that a *known-public* value
 * actually made it into the output, so an environment that silently supplied nothing reds
 * instead of vacuously greening.
 *
 * Run after `pnpm --filter @shortkit/web build`, with `BFF_PROXY_SECRET` and
 * `NEXT_PUBLIC_API_BASE_URL` set in the environment to the same real values the build ran
 * with. `vercel.json`'s `buildCommand` does this for the deploy that matters; TASK-002's CI
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
 * F-155: `.next/static/**` alone misses prerendered HTML and RSC flight payloads. Both roots
 * are walked in full — no extension filter — because the leak this guards against can surface
 * as `.html`, `.rsc`, `.segment.rsc`, a `.meta`/`.segments` file, or something a future Next
 * version names differently; scanning every file is the only form of this that doesn't need
 * updating when the internal naming does.
 */
const SCAN_ROOTS = [
  { name: '.next/static', dir: path.join(process.cwd(), '.next', 'static') },
  { name: '.next/server/app', dir: path.join(process.cwd(), '.next', 'server', 'app') },
];

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
 * F-156's positive control. `NEXT_PUBLIC_API_BASE_URL` is genuinely public (see above), so its
 * value being present in the output is not itself a finding — it is proof the build ran with
 * the same environment this check is reading, which the check otherwise has no way to confirm.
 *
 * Expected to fail on a build of today's `apps/web`: no code under `apps/web` reads
 * `process.env.NEXT_PUBLIC_API_BASE_URL` yet (TASK-008 adds the first read), and Next.js only
 * inlines a `NEXT_PUBLIC_` variable where it is textually referenced in code, so there is
 * nothing yet for a real value to produce. That is not a bug in this control — it correctly
 * reports that nothing yet proves the deploy environment is wired the way the build assumed.
 * It starts passing once client-reachable code reads that variable.
 */
const POSITIVE_CONTROL_VAR = 'NEXT_PUBLIC_API_BASE_URL';

/**
 * F-160: a secret this short makes the search meaningless — either it matches incidentally
 * across large parts of the build output, or it is a placeholder that was never going to be
 * inlined anywhere in the first place. `openssl rand -base64 32` (the format `.env.example`
 * documents) produces 44 characters; 32 is a floor below that, not a target.
 */
const MIN_SECRET_LENGTH = 32;

/**
 * Reads a required value from the environment. Mirrors the convention in
 * `apps/api/scripts/check-policies.mts`'s `connectionString()`: throw with a message naming
 * what's missing and why the check needs it, rather than let an unset variable silently make
 * the search find nothing. A check that cannot run because its input is missing must fail
 * loudly — a vacuous pass here is the same shape of silent-green defect this script exists to
 * prevent.
 */
function readRequiredValue(name, { minLength } = {}) {
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

  return value;
}

async function collectFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const full = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      files.push(...(await collectFiles(full)));
    } else if (entry.isFile()) {
      files.push(full);
    }
  }

  return files;
}

/**
 * F-160: plain substring matching misses an escaped rendering of the value — an RSC flight
 * payload or an HTML attribute can escape characters a raw secret might contain. `JSON.stringify`
 * covers the common case (quotes, backslashes, control characters); it will not catch every
 * possible escaping scheme, but it costs nothing extra to check alongside the raw form.
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
  let positiveControl;

  try {
    secret = {
      name: LEAK_TARGET_VAR,
      value: readRequiredValue(LEAK_TARGET_VAR, { minLength: MIN_SECRET_LENGTH }),
    };
    positiveControl = {
      name: POSITIVE_CONTROL_VAR,
      value: readRequiredValue(POSITIVE_CONTROL_VAR),
    };
  } catch (error) {
    console.error(`FAIL: ${error.message}`);
    process.exitCode = 1;
    return;
  }

  const filesByRoot = [];

  for (const root of SCAN_ROOTS) {
    try {
      filesByRoot.push({ root: root.name, files: await collectFiles(root.dir) });
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
  }

  const leaks = [];
  let positiveControlFound = false;
  let totalFiles = 0;

  for (const { root, files } of filesByRoot) {
    totalFiles += files.length;

    for (const file of files) {
      const contents = await readFile(file, 'utf8');

      if (matchesValue(contents, secret.value)) {
        leaks.push({ root, file, name: secret.name });
      }

      if (!positiveControlFound && matchesValue(contents, positiveControl.value)) {
        positiveControlFound = true;
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

  if (!positiveControlFound) {
    console.error(
      `FAIL: ${positiveControl.name}'s value was not found anywhere under ` +
        `${SCAN_ROOTS.map((root) => root.name).join(' or ')}. This is the positive control ` +
        "(F-156): its presence is what proves the build actually ran with this check's " +
        'environment, rather than the search finding nothing because there was nothing there ' +
        'to find. If no client-reachable code reads NEXT_PUBLIC_API_BASE_URL yet, this failure ' +
        'is expected — see the note on POSITIVE_CONTROL_VAR above.',
    );
    process.exitCode = 1;
    return;
  }

  console.log(
    `OK: checked ${String(totalFiles)} file(s) across ${SCAN_ROOTS.map((root) => root.name).join(', ')}, ` +
      'no leaked value found; positive control confirmed.',
  );
}

await main();
