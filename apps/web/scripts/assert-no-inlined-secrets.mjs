/**
 * `pnpm --filter @shortkit/web assert:no-secrets`
 *
 * Contract: TASK-004.md (F-078's AC-113, F-084's split), ADR-0014, design/contracts/web-api-client.md
 * Produced by: TASK-004
 *
 * WHY THIS EXISTS. `BFF_PROXY_SECRET` and `API_BASE_URL` are required, server-only Vercel
 * project variables (ADR-0014). Neither carries the `NEXT_PUBLIC_` prefix, which is what
 * keeps Next.js from inlining them into client JavaScript — but that rule lives in an ADR
 * and a TASK card, not in anything a typecheck or a happy-path test reads. A future edit
 * that moves either read behind a `NEXT_PUBLIC_*` alias, or into a client component that
 * reads it directly, ships a working build and a green typecheck while publishing
 * `BFF_PROXY_SECRET` to every browser. That secret is what the API's constant-time match
 * trusts before honouring a forwarded client address; published, it lets anyone forge
 * `x-shortkit-client-ip` and collapse every IP-keyed rate-limit bucket into one shared by
 * the whole product (web-api-client.md, ADR-0014 Consequences). This script is the only
 * thing that looks.
 *
 * It searches for the two variables' *values*, not their names — the `NEXT_PUBLIC_`
 * inlining this guards against substitutes the literal value at build time and leaves no
 * trace of the variable name behind.
 *
 * AC-113 is a CI build-output assertion, not a vitest spec (design/test-strategy.md):
 * it has nothing to assert until a real `.next/static/**` exists. Run it after
 * `pnpm --filter @shortkit/web build`, with `BFF_PROXY_SECRET` and `API_BASE_URL` set in
 * the environment to the same real values the build ran with.
 *
 * Split (F-084): this script IS the check. TASK-002 owns the CI workflow step that builds
 * `apps/web` and invokes `assert:no-secrets` with those variables exported — everything
 * under `.github/**` is outside this TASK's paths.
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

const STATIC_DIR = path.join(process.cwd(), '.next', 'static');

/**
 * Reads a required, server-only secret from the environment. Mirrors the convention in
 * `apps/api/scripts/check-policies.mts`'s `connectionString()`: throw with a message
 * naming what's missing and why the check needs it, rather than let an unset variable
 * silently make the search find nothing. A check that cannot run because its inputs are
 * missing must fail loudly — a vacuous pass here is the same shape of silent-green defect
 * this script exists to prevent.
 */
function readSecret(name) {
  const value = process.env[name];

  if (value === undefined || value.trim() === '') {
    throw new Error(
      `${name} is not set. This check searches the built client bundle for this ` +
        "variable's value; without a real value there is nothing to search for, and the " +
        'check would pass without having checked anything.',
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

async function main() {
  let secrets;

  try {
    secrets = [
      { name: 'BFF_PROXY_SECRET', value: readSecret('BFF_PROXY_SECRET') },
      { name: 'API_BASE_URL', value: readSecret('API_BASE_URL') },
    ];
  } catch (error) {
    console.error(`FAIL: ${error.message}`);
    process.exitCode = 1;
    return;
  }

  let files;

  try {
    files = await collectFiles(STATIC_DIR);
  } catch (error) {
    if (error.code === 'ENOENT') {
      console.error(
        `FAIL: ${STATIC_DIR} does not exist. Run \`pnpm --filter @shortkit/web build\` ` +
          'first — this check inspects the built client bundle, not source, and has ' +
          'nothing to inspect before a build exists.',
      );
      process.exitCode = 1;
      return;
    }

    throw error;
  }

  const leaks = [];

  for (const file of files) {
    const contents = await readFile(file, 'utf8');

    for (const { name, value } of secrets) {
      if (contents.includes(value)) {
        leaks.push({ file, name });
      }
    }
  }

  if (leaks.length > 0) {
    console.error(
      'FAIL: a server-only value was found in the built client bundle:\n' +
        leaks
          .map(({ file, name }) => `  - ${name} in ${path.relative(process.cwd(), file)}`)
          .join('\n') +
        '\n\nA value only reaches .next/static/** by being read through a NEXT_PUBLIC_-' +
        'prefixed variable, or otherwise passed into code that runs in the browser. ' +
        'BFF_PROXY_SECRET and API_BASE_URL must stay server-only reads (ADR-0014).',
    );
    process.exitCode = 1;
    return;
  }

  console.log(
    `OK: checked ${String(files.length)} file(s) under .next/static/, no server-only ` +
      'values found.',
  );
}

await main();
