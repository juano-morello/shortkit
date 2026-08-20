# Known advisories

Advisories that have been assessed and accepted, one row each, with the assessment and
the condition that clears it. Source: ADR-0018.

**A human reads this file. No tool consumes it.** `pnpm audit` never gets `--ignore` or
any override, so an accepted advisory still fails the weekly `dependencies` run and still
has to be re-read. That is deliberate: an ignore list is where findings go to be
forgotten, and a row nobody re-reads becomes permission to ignore a weekly failure:
the same failure mode, arriving more slowly.

## Where the failures come from

Two audits, two different questions.

| | `quality` | `dependencies` |
|---|---|---|
| Command | `pnpm audit --prod --no-optional --audit-level moderate` | `pnpm audit --audit-level moderate` |
| Trigger | every push and pull request | weekly `schedule`, plus `workflow_dispatch` |
| Sees | production dependency graph only | the whole tree, dev dependencies included |
| Blind to | **every dev-only advisory, at every severity, and every advisory reachable only through an `optionalDependencies` edge** | nothing at `moderate` or above |
| Effect of a hit | blocks the merge | fails a scheduled run, which emails the repo owner |

`--no-optional` was added 2026-08-07 (F-226) and its scope corrected 2026-08-08 (F-230):
it does not just drop dev-only rows, it also takes `sharp` and the `@next/swc-*`
binaries (real production code that runs in the Vercel build) out of the merge gate.
The weekly `dependencies` job still reports everything the `quality` audit is blind to.
If you are reading this because a weekly run failed, check the row against the failure
before spending an hour on it.

## The register

| Advisory | Severity | Package and path | Assessment | Clears when |
|---|---|---|---|---|
| [GHSA-67mh-4wv8-2f99](https://github.com/advisories/GHSA-67mh-4wv8-2f99) | moderate | `esbuild <= 0.24.2`, resolved 0.18.20, via `apps__api > drizzle-kit > @esbuild-kit/esm-loader > @esbuild-kit/core-utils > esbuild` **and, since the `better-auth` pin, also via `apps__api > better-auth > drizzle-kit > …`** | **Not exploitable here. Accepted 2026-08-05, `sdlc-security-auditor`. Acceptance re-argued 2026-08-07, `sdlc-architect` (F-226): the assessment was always right and the reason given for it was wrong.** The vulnerability is in esbuild's development server, which lets any website send requests to it and read the response. `@esbuild-kit/core-utils` uses only the transform API and `drizzle-kit` never starts a server, so there is no listening socket to reach. **What holds is that `drizzle-kit` is a CLI-only optional peer of `better-auth`, used by Better Auth's schema-generation command and never imported at runtime**: `grep -rn "drizzle-kit" better-auth/dist --include=*.mjs` returns no matches, and the same grep over `@better-auth/drizzle-adapter/dist` returns no matches. The Fly image installs production dependencies only, so no copy of `drizzle-kit` or of the vulnerable esbuild is deployed. **This row's previous acceptance ended "`drizzle-kit` is a devDependency, so `--prod` does not see it and it blocks no merge." That sentence was true when it was written and became false on the `better-auth` pin**, which resolved `drizzle-kit` into `apps/api`'s production graph as an optional peer. The `quality` gate now reaches it only through that optional edge, which `--no-optional` removes. The weekly `dependencies` audit still reports this row. | `drizzle-kit` publishes a release that drops `@esbuild-kit/esm-loader`. Both `@esbuild-kit` packages are deprecated upstream and superseded by `tsx`, which `drizzle-kit` already depends on, so the pinned-back esbuild will not move on its own. Re-check on every `drizzle-kit` bump, **and on every `better-auth` bump, because `better-auth`'s optional peer range is what put this path in the production graph**. |
| [GHSA-g7r4-m6w7-qqqr](https://github.com/advisories/GHSA-g7r4-m6w7-qqqr) | low | `esbuild >= 0.27.3 < 0.28.1`, via `apps__api > tsup > esbuild` and `apps__api > tsup > bundle-require > esbuild` | **Not exploitable here. Assessed 2026-08-05, `sdlc-architect`, not reviewed by the security auditor.** Arbitrary file read when running the development server on Windows. `tsup` bundles and does not run esbuild's serve mode, and neither CI nor the Fly image is Windows. Recorded because **neither audit job reports it**: it is below the `moderate` threshold on both, so it is invisible until someone runs `--audit-level low` by hand. | A `tsup` bump to a release resolving `esbuild >= 0.28.1`. A fix exists upstream, unlike the row above. |

Reproduced 2026-08-05 against the committed lockfile, and again 2026-08-06 while wiring
the audits into CI: `pnpm audit --prod --audit-level moderate` exited 0,
`pnpm audit --audit-level moderate` exits 1 reporting the first row,
`pnpm audit --audit-level low` reports both. That first exit code stopped being 0 once
`better-auth` was pinned (TASK-009): `drizzle-kit` resolved into `apps/api`'s production
graph as an optional peer of `better-auth`, and `--prod` walks optional peers as
production. Reproduced 2026-08-07 at the pin and again 2026-08-08: `pnpm audit --prod
--audit-level moderate` exits 1 on the first row above; `pnpm audit --prod --no-optional
--audit-level moderate` exits 0; `pnpm audit --prod --no-optional --audit-level low` also
exits 0, so `--no-optional` is not carrying a quieter finding out of view along with the
loud one.

## Adding a row

Only after the advisory has been assessed against how the dependency is actually used,
not because it is inconvenient. A row needs all five columns, and the "clears when"
column has to name a concrete event, not "when upstream fixes it".

Nothing in `launch-core` schedules a review of this file. If a row has been here long
enough that you no longer remember writing it, re-read it.
