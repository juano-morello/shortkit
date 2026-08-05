# TASK-001 — security audit, round 1

**Scope:** commit `f58f340` (`cee06e4..f58f340`), 37 files, 5150 insertions.
**Mode:** code. **Date:** 2026-08-04.

Nothing authenticates, no database, no request handler with a body, no user input
reaches any code in this commit. The `apps/api` surface is a composition root with
zero controllers; the `apps/web` surface is three static components. The reachable
attack surface is therefore supply chain and repository hygiene, and that is where
this audit spent its time.

## What was verified, and how

Read at source: TASK-001, STORY-001, the full review package, the implementer report,
ADR-0018, ADR-0013 (pinning paragraphs), ADR-0001, findings.yaml, TASK-009, and every
file in the working tree the diff touches.

Executed (read-only, no mutation of the tree):

| Check | Command | Result |
|---|---|---|
| Prod advisories, as ADR-0018 will run it | `pnpm audit --prod --audit-level high` | `No known vulnerabilities found`, exit 0 |
| All advisories including dev | `pnpm audit --audit-level low` | `No known vulnerabilities found` |
| Non-registry resolutions (git, tarball, http, directory) in the lockfile | grep | none |
| Integrity coverage | 470 `resolution:` entries | every one carries `sha512` |
| `overrides` / `patchedDependencies` / `packageExtensions` | grep | none |
| Lockfile importers vs. all four `package.json` files | scripted comparison | in sync, zero drift, zero extras |
| Specifier shape across all four manifests | scripted regex | every specifier is an exact `x.y.z` or `workspace:*`; no caret, tilde or range anywhere |
| Licenses of the installed tree | `pnpm licenses list` | 298 MIT, 25 Apache-2.0, 17 ISC, 13 BSD, 1 LGPL-3.0-or-later (`@img/sharp-libvips-linux-x64`), 1 CC-BY-4.0 (`caniuse-lite`), 1 Python-2.0 (`argparse`) |
| Secrets in the commit | regex over the non-lockfile diff (`secret`, `token`, `passw`, `api[_-]key`, `BEGIN PRIVATE KEY`, `AKIA`, `_authToken`, `bearer`) | only the `verification_token_invalid` / `token_expired` error-code literals |
| Tracked files | `git ls-files` | no `.env`, no key material, no CI workflow, no generated output |
| AI attribution (GC-4) | grep over `cee06e4..HEAD` messages | none |

## F-016 compatibility (frozen lockfile + `quality` audits)

Nothing in this TASK makes F-016 impossible, and one thing makes it easier than the
ADR assumed.

- `pnpm install --frozen-lockfile` is demonstrated in the implementer report and is
  supported by the drift check above: the four importers match the four manifests
  exactly, so a frozen install cannot fail on drift today.
- `pnpm audit --prod --audit-level high` exits 0 against this tree right now, so
  TASK-002's `quality` step lands green rather than red on arrival.
- ADR-0018 says "everything else keeps caret ranges; the lockfile is what makes them
  reproducible". The implementer went further and pinned **every** specifier exactly.
  That is stricter than the ADR and strictly better for reproducibility. It does mean
  that from here on, no dependency updates without a deliberate edit, which raises the
  importance of the audit step actually being able to see what needs bumping (see
  finding 3).
- `pnpm-workspace.yaml:8-10` allows install scripts for exactly two packages,
  `@swc/core` and `esbuild`. pnpm blocks lifecycle scripts by default and this
  allowlist is the minimum needed for a working transform on a clean clone. Both are
  devDependencies, so the executed postinstall code does not reach the deployed image;
  it does reach CI runners, which will hold deploy credentials later. Necessary,
  minimal, correctly scoped. Note for TASK-002: a job that adds `--ignore-scripts` as
  hardening will break `pnpm test` for `apps/api`, so it must not.

## Build and test configuration — can anything execute untrusted content?

- `apps/web/next.config.ts` sets `transpilePackages` and nothing else. There is no
  `typescript.ignoreBuildErrors`, no `eslint.ignoreDuringBuilds`, no
  `images.remotePatterns`, no custom webpack loader, no `experimental` block. The build
  cannot be greened by configuration, and no user-supplied URL is fetchable through the
  image optimizer.
- The three `vitest.config.ts` files set `name`, `environment`, `include`, `setupFiles`
  and a transform plugin. No `globalSetup` shelling out, no `resources: 'usable'` on the
  jsdom environment (so tests cannot fetch remote resources), no `server.deps` widening.
- `apps/api/vitest.integration.config.ts` carries `passWithNoTests: true`. That is a
  green-when-empty risk for TASK-005's suite, not a security issue; the product auditor
  owns it.
- ESLint ignores `.sdlc/**`, which keeps the design stubs unlinted until a TASK
  materialises them. ADR-0005's `no-restricted-imports` ban for `packages/contracts`
  (`node:*`, `@nestjs/*`, `drizzle-orm`, `pg`, `react`) is assigned to TASK-007 and is
  correctly absent here. Until it lands, nothing mechanically stops a Node-only import
  from entering the package that Next bundles into client components. That is TASK-007's
  obligation and it is recorded in `packages/contracts/src/index.ts:8-11`.

## Dependencies reviewed

377 packages installed, 470 locked resolutions, all from the npm registry with sha512
integrity, no git or tarball sources, no overrides, no patches.

Direct additions are all mainstream, actively maintained, first-party-published:
`@nestjs/{common,core,platform-express,testing}@11.1.28`, `next@16.3.0`,
`react`/`react-dom@19.2.8`, `zod@4.4.3`, `vitest@3.2.7`, `typescript@5.9.3`,
`eslint@9.39.5`, `typescript-eslint@8.66.0`, `@swc/core@1.15.46`,
`unplugin-swc@1.5.10`, `@vitejs/plugin-react@4.7.0`, `jsdom@26.1.0`,
`@testing-library/react@16.3.2`, `reflect-metadata@0.2.2`, `rxjs@7.8.2`,
`@types/node@24.13.3`, `@types/react@19.2.18`, `@types/react-dom@19.2.4`.
No obscure or single-maintainer package was added by hand. No advisories at any level.

Transitive things worth knowing, none of them findings:

- `sharp@0.35.3` plus ~30 `@img/*` platform binaries arrive through `next`. One of
  them, `@img/sharp-libvips-linux-x64`, is **LGPL-3.0-or-later**. For a hosted
  service that never distributes the binary and does not modify libvips, dynamic use
  is not a distribution trigger, so this is compatible with a private commercial
  service. It would need revisiting only if a binary artifact were ever shipped to a
  third party.
- `multer@2.2.0` and its parsing chain (`file-type`, `strtok3`, `token-types`,
  `@napi-rs/lzma-linux-x64-gnu`, `busboy`) enter as production dependencies of
  `@nestjs/platform-express`, even though nothing accepts uploads. That is
  platform-express's tree, not a choice made here. `multer@2.2.0` is above the 2.0.2
  fix line for the 2.x DoS advisories.
- `esbuild@0.28.1` is well above the 0.24.2 dev-server CORS advisory line.

## Findings

```yaml
verdict: clear
findings:
  - severity: minor
    kind: security
    file: package.json
    line: 6
    summary: >-
      packageManager pins pnpm@11.20.0 with no integrity hash, so Corepack installs
      whatever tarball the registry serves for that version.
    failure_scenario: >-
      An attacker who can serve a tampered pnpm tarball to a CI runner - npm account
      compromise of the pnpm publisher, or a registry proxy/mirror on a self-hosted or
      network-restricted runner - gets arbitrary code execution as the build user on
      every job. Per ADR-0018 those jobs are the ones that will hold Fly, Neon and
      Upstash credentials, and Corepack runs before any lockfile integrity check can
      help, because pnpm is the thing that performs those checks. Nothing else in the
      toolchain is unverified: every one of the 470 locked packages carries a sha512.
      The package manager itself is the one hole.
    required_change: >-
      Replace with the hashed form, `"packageManager": "pnpm@11.20.0+sha512.<hash>"`,
      taking the value from `corepack use pnpm@11.20.0`. TASK-002 must then use a setup
      step that honours the field (corepack, or pnpm/action-setup reading
      packageManager) rather than hardcoding a bare version, or the hash is decorative.

  - severity: minor
    kind: security
    file: .gitignore
    line: 13
    summary: >-
      The bootstrap ignore file covers .env and .env.* but no key, certificate or
      registry-credential patterns, in a repository ADR-0018 assumes is public.
    failure_scenario: >-
      ADR-0018 justifies the CI budget with "runner minutes, which are free for a
      public repository", so this repo is intended to be public. A later TASK produces
      credential material that is not a dotenv file - a Postgres CA bundle or client
      cert for Neon (*.pem, *.crt, *.key), a service-account JSON, or a repo-local
      .npmrc holding `//registry.npmjs.org/:_authToken=` while debugging an install -
      and `git add -A` commits it. Once pushed to a public repo the credential is
      compromised and the remedy is rotation, not deletion. This is the commit that
      sets the repo-wide ignore policy, so it is the cheapest possible place to close
      it; every later TASK inherits whatever this file says.
    required_change: >-
      Add to .gitignore in this commit: `.npmrc`, `*.pem`, `*.key`, `*.crt`, `*.p12`,
      `*.pfx`, `id_rsa*`, `.envrc`. Keep the existing `!.env.example` negation. If a
      repo-level .npmrc is later wanted for pnpm settings, add a `!.npmrc` negation at
      that point and review its contents in the same diff.

  - severity: minor
    kind: design
    file: .sdlc/launch-core/design/adr-0018-ci-performance-gate.md
    line: 73
    summary: >-
      `pnpm audit --prod --audit-level high` will not fail on a moderate-severity
      advisory, and with every dependency now exact-pinned, nothing else surfaces one.
    failure_scenario: >-
      ADR-0018 states the exact pin and the audit step are "load-bearing together":
      pinning means security patches arrive only when someone bumps by hand, and the
      audit is what tells them to. A moderate-rated advisory in better-auth - the
      severity band that routinely covers session fixation, open redirect and timing
      leaks - passes `--audit-level high` silently. Because the version is exact-pinned
      and no Dependabot or renovate config exists in this repo, no other mechanism ever
      raises it. The vulnerable auth library stays deployed indefinitely with green CI.
      TASK-001 widened the blast radius of this by pinning everything exactly, not just
      better-auth, so the "lockfile keeps caret ranges reproducible" half of the ADR's
      reasoning no longer applies to anything.
    required_change: >-
      Either lower the production audit to `--audit-level moderate` (the prod tree is
      small and currently has zero advisories at any level, so the noise cost is
      measurable and low), or add a scheduled job that runs the audit at moderate and
      opens an issue rather than failing a merge. Decide in ADR-0018 so TASK-002
      implements one thing.

  - severity: minor
    kind: process
    file: .sdlc/launch-core/tasks/TASK-009.md
    line: 26
    summary: >-
      TASK-009's better-auth pinning step and four-fact re-check live in prose only;
      its acceptance list is [AC-16, AC-20, AC-21] and none of them covers the pin.
    failure_scenario: >-
      This is the residual of F-040 and it is the same failure mode that produced
      F-040: an obligation recorded as prose that no gate checks. The ruling propagated
      correctly - TASK-009 lines 26-49 carry the full pinning step, the four facts and
      the escalate-if-(2)-or-(3)-changed rule - but sdlc-product-auditor verifies ACs
      verbatim, and no AC mentions the pin. An implementer under time pressure writes
      `"better-auth": "^1.x"`, every AC still passes, and the exact failure ADR-0018
      names becomes live: a transitive bump breaks or weakens authentication with no
      code change, and the four facts F-019 and F-021 depend on were never checked
      against the shipped release.
    required_change: >-
      Add an AC to STORY-005 that is objectively checkable, e.g. "apps/api/package.json
      declares better-auth at an exact version with no range character, and the TASK
      report records the four Better Auth facts verified against that release". Nothing
      needs to change in TASK-001.

  - severity: nit
    kind: behavior
    file: apps/api/src/main.ts
    line: 19
    summary: >-
      `process.env.PORT ?? DEFAULT_PORT` does not catch an empty-string PORT.
    failure_scenario: >-
      `??` only falls back on null/undefined. A container or CI environment that sets
      `PORT=""` - a common artifact of an unset variable expanded into an env file -
      passes an empty string to `app.listen`, which resolves to an arbitrary ephemeral
      port. The platform health check on the documented port then fails against a
      process that is running fine, which reads as an outage rather than a config
      error.
    required_change: >-
      Parse and validate: fall back when the value is empty or not an integer in
      1-65535. A one-line guard now, or fold it into the config-validation TASK if one
      exists.

  - severity: nit
    kind: security
    file: package.json
    line: 8
    summary: >-
      `engines.node: ">=22.12.0"` is advisory only - there is no .npmrc and no
      engine-strict - while @types/node is 24.13.3.
    failure_scenario: >-
      Informational. Two consequences, neither with an attacker today. Code can
      typecheck against Node 24 APIs that do not exist on the declared 22.12 floor, and
      a contributor or runner on an end-of-life Node (18, 20) installs and runs without
      an error, on a runtime that no longer receives security patches. The deploy image
      is TASK-042's and will pin its own base, so the exposure is local and CI only.
    required_change: >-
      Optional hardening: add a repo-level .npmrc with `engine-strict=true` (and, if
      added, remember the `!.npmrc` negation from the second finding), or align
      @types/node to the 22.x line matching the engines floor.
```

## Notes

- **No blocker or major.** For a bootstrap commit with no auth, no database, no request
  handling and no user input, that is the expected result, and the checks above are the
  evidence rather than an assumption. The two things that would have been blockers here
  - a committed credential, and a dependency tree with unpinned or non-registry sources
  - are both clean and were checked directly.
- **The exact-pin-everything decision is a security improvement over ADR-0018's
  baseline** and should be kept, with the audit-threshold caveat in finding 3.
- **`allowBuilds` posture is right.** pnpm's default-deny on lifecycle scripts is the
  single most valuable supply-chain control in this stack, and it survives with a
  two-package allowlist of packages that genuinely need to compile a native binary.
  Any future TASK that adds a name to that list is adding arbitrary install-time code
  execution and should say why in its report.
- **GC-9 (no PII in logs)** has no surface yet. `main.ts` uses Nest's default logger;
  pino and the redact list are ADR-0022 and its TASKs. Nothing here logs anything.
- **GC-4** holds: no AI attribution in `cee06e4..HEAD`.
- **F-040:** the ruling propagated correctly into TASK-009's body and into both ADRs.
  The only residual is that it is not an AC (finding 4). I do not think the obligation
  should move back to TASK-001, which has no way to fetch the documentation the
  re-check requires.
- **For TASK-002:** do not add `--ignore-scripts` to any install step; `@swc/core` and
  `esbuild` need their postinstall for `pnpm test` to work. Use a setup step that reads
  `packageManager` so the integrity hash from finding 1 is actually enforced.
