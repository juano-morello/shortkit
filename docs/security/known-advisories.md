# Known advisories

Advisories that have been assessed and accepted, one row each, with the assessment and
the condition that clears it. Source: ADR-0018.

**A human reads this file. No tool consumes it.** `pnpm audit` never gets `--ignore` or
any override, so an accepted advisory still fails the weekly `dependencies` run and still
has to be re-read. That is deliberate: an ignore list is where findings go to be
forgotten, and a row nobody re-reads becomes permission to ignore a weekly failure —
the same failure mode, arriving more slowly.

## Where the failures come from

Two audits, two different questions.

| | `quality` | `dependencies` |
|---|---|---|
| Command | `pnpm audit --prod --audit-level moderate` | `pnpm audit --audit-level moderate` |
| Trigger | every push and pull request | weekly `schedule`, plus `workflow_dispatch` |
| Sees | production dependency graph only | the whole tree, dev dependencies included |
| Blind to | **every dev-only advisory, at every severity** | nothing at `moderate` or above |
| Effect of a hit | blocks the merge | fails a scheduled run, which emails the repo owner |

Both rows below are dev-only, so neither blocks a merge. If you are reading this because
a weekly run failed, check the row against the failure before spending an hour on it.

## The register

| Advisory | Severity | Package and path | Assessment | Clears when |
|---|---|---|---|---|
| [GHSA-67mh-4wv8-2f99](https://github.com/advisories/GHSA-67mh-4wv8-2f99) | moderate | `esbuild <= 0.24.2`, resolved 0.18.20, via `apps__api > drizzle-kit > @esbuild-kit/esm-loader > @esbuild-kit/core-utils > esbuild` | **Not exploitable here. Accepted 2026-08-05, `sdlc-security-auditor`.** The vulnerability is in esbuild's development server, which lets any website send requests to it and read the response. `@esbuild-kit/core-utils` uses only the transform API and `drizzle-kit` never starts a server, so there is no listening socket to reach. `drizzle-kit` is a devDependency, so `--prod` does not see it and it blocks no merge. | `drizzle-kit` publishes a release that drops `@esbuild-kit/esm-loader`. Both `@esbuild-kit` packages are deprecated upstream and superseded by `tsx`, which `drizzle-kit` already depends on, so the pinned-back esbuild will not move on its own. Re-check on every `drizzle-kit` bump. |
| [GHSA-g7r4-m6w7-qqqr](https://github.com/advisories/GHSA-g7r4-m6w7-qqqr) | low | `esbuild >= 0.27.3 < 0.28.1`, via `apps__api > tsup > esbuild` and `apps__api > tsup > bundle-require > esbuild` | **Not exploitable here. Assessed 2026-08-05, `sdlc-architect`, not reviewed by the security auditor.** Arbitrary file read when running the development server on Windows. `tsup` bundles and does not run esbuild's serve mode, and neither CI nor the Fly image is Windows. Recorded because **neither audit job reports it**: it is below the `moderate` threshold on both, so it is invisible until someone runs `--audit-level low` by hand. | A `tsup` bump to a release resolving `esbuild >= 0.28.1`. A fix exists upstream, unlike the row above. |

Reproduced 2026-08-05 against the committed lockfile, and again 2026-08-06 while wiring
the audits into CI: `pnpm audit --prod --audit-level moderate` exits 0,
`pnpm audit --audit-level moderate` exits 1 reporting the first row,
`pnpm audit --audit-level low` reports both.

## Adding a row

Only after the advisory has been assessed against how the dependency is actually used —
not because it is inconvenient. A row needs all five columns, and the "clears when"
column has to name a concrete event, not "when upstream fixes it".

Nothing in `launch-core` schedules a review of this file. If a row has been here long
enough that you no longer remember writing it, re-read it.
