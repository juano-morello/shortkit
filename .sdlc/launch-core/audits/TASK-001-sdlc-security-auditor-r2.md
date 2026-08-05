# TASK-001 — security audit, round 2 (verdict pass on fix round 1)

**Scope:** `0e7b3b2..5054a03`, 6 commits, 24 files, 1166 insertions.
**Mode:** code. **Date:** 2026-08-04.
**Prior:** `.sdlc/launch-core/audits/TASK-001-sdlc-security-auditor-r1.md`.

Verdicts on F-047, F-048, F-049, F-050, F-051, F-052 first; then findings new to this
fix diff; then deferred observations that do not extend the loop.

---

## Verdicts

### F-047 — `packageManager` integrity hash — **PARTIALLY ADDRESSED**

The artifact half is not just present, it is **verified against the registry**. I fetched
`https://registry.npmjs.org/pnpm/11.20.0` and converted `dist.integrity` from base64 to hex:

```
registry sha512 (hex) 9a6f330a95b66446ea088faf1521405a8a01f07fde7124cc9958dfed52d4bb43
                      6737e65b08f85f37b46fcba375092558ac51262b816844b22f63406ed166bfee
package.json          9a6f330a95b66446ea088faf1521405a8a01f07fde7124cc9958dfed52d4bb43
                      6737e65b08f85f37b46fcba375092558ac51262b816844b22f63406ed166bfee
```

Byte-identical. The hash is real, not a transcription of something else. The one unverified
fetch in the toolchain is closed at the manifest.

**The second half of the required change has no producer.** Round 1 said, verbatim:
"TASK-002 must then use a setup step that honours the field (corepack, or pnpm/action-setup
reading packageManager) rather than hardcoding a bare version, **or the hash is decorative**."
I grepped `tasks/` and `design/` for `packageManager` and `corepack`: **zero hits.** The fix
report acknowledges the obligation ("TASK-002 reading `packageManager` ... is its own TASK's
obligation") but it was never written into TASK-002 or ADR-0018 — and both files were edited
in this very diff for other reasons, so the opportunity was in hand and passed.

This is the F-040/F-050 failure mode again: an obligation that lives in a report no gate
reads. Filed below as a finding against `TASK-002.md`.

### F-048 — `.gitignore` credential patterns — **ADDRESSED**

All eight requested patterns present, `!.env.example` negation preserved in the correct
position (after `.env.*`), compiler-output patterns added as a bonus. Verified independently
rather than trusting the report:

- `git ls-files` matched against `\.env($|\.)|\.npmrc|\.pem$|\.key$|\.crt$|\.p12$|\.pfx$|id_rsa|\.envrc` → **empty**.
- `git ls-files -i -c --exclude-standard` → **0**. Nothing already tracked became ignored.
- Secret regex over the non-lockfile diff (`BEGIN * PRIVATE KEY`, `AKIA…`, `_authToken`, `xox[baprs]-`, `ghp_…`, `password=`, `api_key=`, `secret=`) → **no hits**.

**On the `.npmrc` question I was asked to judge: keep the wholesale ignore.** A tracked
`.npmrc` is a file that CI tooling appends to — `actions/setup-node` with `registry-url`
writes `//registry.npmjs.org/:_authToken=${NODE_AUTH_TOKEN}` into the *project* `.npmrc`,
and `pnpm config set --location project` does the same. Once the file is tracked, an
appended auth line is inside `git add -A`'s reach and git cannot ignore lines, only files.
Ignoring it fails closed; committing it fails open on the exact vector F-048 names. The
"non-secret settings plus an ignore for credential lines" shape is not expressible in git.

The implementer treated this as a forced tradeoff against `engine-strict`. **It is not
forced.** pnpm's own settings documentation (pnpm.io/settings, versions 11 & 12) states
"Only auth and registry settings are read from `.npmrc` files. All other settings … must be
configured in `pnpm-workspace.yaml`", and lists `engineStrict` among them. This repo already
uses `pnpm-workspace.yaml` for `allowBuilds`. `engineStrict: true` goes in a tracked file
with no `.npmrc` at all — both halves, no conflict. Filed below as a minor.

### F-049 — audit threshold — **ADDRESSED**

ADR-0018 now carries the decision as prose, an options table and consequences. `quality`
runs `pnpm audit --prod --audit-level moderate`; a `dependencies` job runs a full-tree
`pnpm audit --audit-level moderate` on `schedule` + `workflow_dispatch`, gating nothing.
Both are recorded in the follow-ups with TASK-002 named as producer, and TASK-002's `paths`
were widened to `.github/**` so `dependabot.yml` has an owner. The detection/remediation
loop the ADR describes now closes: `quality` on open PRs, `dependencies` when none are
open, Dependabot to move the version.

I ran both thresholds against the current tree:

| Command | Result |
|---|---|
| `pnpm audit --prod --audit-level moderate` | `No known vulnerabilities found`, exit 0 |
| `pnpm audit --audit-level moderate` | 1 low reported, **exit 0** |
| `pnpm audit --audit-level low` | 1 low, esbuild GHSA-g7r4-m6w7-qqqr |

Both gates land green on arrival, which is what TASK-002 needs. The ADR explicitly accepts
that low-band advisories pass both audits ("That band is deliberate and nothing else catches
it"). I am not re-litigating that. I am reporting its first live instance, which arrived in
this same diff — see the esbuild finding.

### F-050 — AC-112 — **ADDRESSED**

I was asked to judge whether the AC actually closes the gap, given `sdlc-product-auditor`
verifies ACs verbatim. It does. STORY-005:27 reads:

> Given `apps/api/package.json`, when its `better-auth` specifier is read, then it is an
> exact version carrying no range character (`^`, `~`, `>`, `<`, `*` or `x`); and given
> TASK-009's report, then it records the four Better Auth facts of ADR-0018 verified against
> that exact release.

Verbatim-checkable on both limbs: it names the file, the field, an enumerated character set,
and the report obligation. An auditor reading only this line can fail it. TASK-009's
`acceptance` front-matter carries `AC-112`, so the routing holds.

One residual I judge acceptable: the AC does not encode TASK-009's escalate-if-fact-(2)-or-(3)-
changed branch. But "records the four facts **verified against that exact release**" cannot be
satisfied by an implementer who finds a fact no longer true, so the check is forced to happen
and a divergence cannot be recorded as a pass. Prose carrying the escalation path is enough
once the check itself is gated.

### F-051 — PORT validation and bootstrap failure handler — **ADDRESSED**

`resolvePort` is correct. I traced it rather than trusting the table: `undefined` short-
circuits before `Number(undefined)` (NaN) matters; `""`/whitespace caught by `.trim()`;
`"abc"` → NaN → `Number.isInteger` false; `0` and `70000` caught by the range; `"8080"` → 8080.
`bootstrap().catch()` replaces the bare unhandled rejection. Both limbs of the finding closed.

Two things about the *new* handler are findings in their own right (raw `error.stack` through
`console.error`, and `process.exitCode` vs `process.exit`) — below.

### F-052 — engines/types alignment — **ADDRESSED**

`engines.node` `>=24.13.0`, `@types/node` `24.13.3`, `tsup target: 'node24'`, README updated.
Compiler surface and declared floor agree, which is what the finding asked for.

**On the supply-chain / runtime-support exposure I was asked to assess: none that I care
about.** Raising a floor is monotonically better for patch posture, not worse. Node 24 is the
active LTS line; Node 22 is in maintenance. Dropping 22 removes supported runtimes from the
matrix but every runtime that remains is better patched than the one removed. There is no
dependency in the tree that constrains to Node 22 — I checked the new packages' `engines`
fields; the strictest is `sucrase` at `>=16 || 14 >=14.17`.

Two residuals, both filed below as minors rather than re-opened here: `engines` remains
advisory because `engine-strict` was skipped (avoidable — see F-048 above), and `>=24.13.0`
is a floor, not a patched-version guarantee. The thing that must actually track the 24.x
security line is TASK-042's base-image pin, and nothing yet records that it must.

---

## Supply chain — what tsup pulled in

**Round 1: 470 resolutions, 377 packages. Now: 522 resolutions, +52, 0 removed.**

| Check | Command | Result |
|---|---|---|
| Integrity coverage | 522 `resolution:` entries | every one carries `sha512`; **zero** without |
| Non-registry sources | grep for `tarball`/`repo`/`commit`/`directory`/`type: git` | **none** |
| `overrides` / `patchedDependencies` / `packageExtensions` | grep across lockfile, workspace, root manifest | **none** |
| Install lifecycle scripts, whole installed tree | scripted walk of `node_modules/.pnpm/*/node_modules/**/package.json` for `preinstall`/`install`/`postinstall` | exactly **3**: `@swc/core@1.15.46`, `esbuild@0.27.7`, `esbuild@0.28.1` |
| Licenses | `pnpm licenses list --json` | all 26 new packages MIT or Apache-2.0 |

**`allowBuilds` still correctly scopes what may run postinstall.** The allowlist is keyed by
name (`'@swc/core'`, `esbuild`), so the newly-arrived `esbuild@0.27.7` is covered without an
edit — and the scan confirms nothing *else* in the +52 has an install hook. `tsup` itself has
no lifecycle script. `sucrase`, `mz`, `thenify`, `any-promise`, `pirates` — the older
micro-packages in tsup's tree — are all script-free. The two-package minimum from round 1
holds; the fix did not widen install-time code execution.

**The +52, in shape.** One direct devDependency (`tsup@8.5.1`, MIT, egoist/sxzz, actively
maintained, 3M+ weekly downloads). Its tree splits three ways:

- *Modern, maintained:* `esbuild@0.27.7` + `@esbuild/linux-x64@0.27.7`, `chokidar@4.0.3`,
  `consola@3.4.2`, `readdirp@4.1.2`, `bundle-require@5.1.0`, `mlly`/`pkg-types`/`confbox`/`ufo`
  (unjs), `fix-dts-default-cjs-exports@1.0.1`, `tinyexec`, `tree-kill@1.2.2`.
- *Old but stable and script-free:* `sucrase@3.35.1` → `mz@2.7.0` → `thenify@3.3.1` →
  `any-promise@1.3.0`. `any-promise` has not been published since 2016. It is a
  four-function Promise shim, dev-only, reached only when sucrase transpiles a TS config
  file. Low value as an attack surface, but it is an unmaintained package on the build host —
  noted, not filed.
- *Duplicate:* `postcss@8.5.25` entered as an auto-installed optional peer of
  `postcss-load-config@6.0.1`, alongside the pre-existing `postcss@8.5.23` from `next`. Two
  copies, both dev, both pinned by the lockfile. Not a finding; worth knowing the resolver
  chose it, no manifest did.

**One known-vulnerable dependency entered.** `esbuild@0.27.7` sits inside
GHSA-g7r4-m6w7-qqqr (`>=0.27.3 <0.28.1`). Filed below. Round 1 recorded "esbuild@0.28.1 is
well above the advisory line" — that statement is now only true of one of the two copies.

**Lockfile drift:** `pnpm list --prod` confirms `apps/api → @shortkit/contracts (link) → zod@4.4.3`,
so the repo-root `pnpm audit --prod` in `quality` still sees zod despite it being bundled.
The CI gate is intact. The gap is image-level only — filed below.

## Bundle inlining — what reaches the deployed image

Verified against the built artifact rather than the report:

```
grep -o 'require("[^"]*")' apps/api/dist/main.js | sort -u
  require("@nestjs/common")  require("@nestjs/core")  require("reflect-metadata")

node -e '…JSON.parse(fs.readFileSync("apps/api/dist/main.js.map"))'
  sources: 82 | sourcesContent: 82
  ../../../node_modules/.pnpm/zod@4.4.3/node_modules/zod/v4/classic/external.js
  ../../../node_modules/.pnpm/zod@4.4.3/node_modules/zod/v4/core/*.js   (…and 80 more)
```

`zod@4.4.3` is inlined into `dist/main.js` (571 KB) and its full source is embedded in
`dist/main.js.map` (995 KB) via `sourcesContent`. Two consequences, both filed as minors: the
deployed unit vendors a runtime dependency that no manifest inside it declares, and a
wholesale `COPY dist/` ships ~1 MB of original source into the image.

`sideEffects: false` on `packages/contracts` is **accurate today** — I read
`packages/contracts/src/{index,errors}.ts`; there is not one top-level statement with an
effect, only `export *`, `z.object(...)` const initialisers and a frozen status table. The
concern is forward-looking and filed as a minor: nothing enforces the assertion, and
`index.ts` already lists twelve commented-out re-export lines that later TASKs will
uncomment.

---

## Findings

```yaml
verdict: changes-requested
findings:
  - severity: minor
    kind: process
    file: .sdlc/launch-core/tasks/TASK-002.md
    line: 9
    summary: >-
      Nothing requires TASK-002's CI setup step to resolve pnpm from the packageManager
      field, so F-047's integrity hash is unenforced. This is the unclosed half of F-047.
    failure_scenario: >-
      Grepping tasks/ and design/ for `packageManager` and `corepack` returns zero hits.
      TASK-002's implementer, with no instruction, writes the idiomatic thing - a setup
      action with a hardcoded `version: 11.20.0`, or `npm i -g pnpm` - and the sha512 in
      package.json is never checked by anything. F-047's original attack is then fully
      live: whoever can serve a tampered pnpm tarball to a runner (publisher account
      compromise, or a registry proxy on a self-hosted runner) gets code execution as the
      build user on every job, and ADR-0018 puts Fly, Neon and Upstash credentials in
      those jobs. Corepack runs before any lockfile check because pnpm is what performs
      those checks. The verified hash then reads as coverage that does not exist, which is
      worse than no hash - a reviewer sees the sha512 and stops looking.
    required_change: >-
      Record the obligation where an implementer will read it: one line in TASK-002's
      Produces block, or in ADR-0018's follow-ups next to the `--frozen-lockfile` line,
      saying the setup step must resolve pnpm from the `packageManager` field (Corepack,
      or a setup action given no explicit version) and must not hardcode a version string.

  - severity: minor
    kind: security
    file: pnpm-lock.yaml
    line: 1583
    summary: >-
      tsup@8.5.1 pulls esbuild@0.27.7, inside GHSA-g7r4-m6w7-qqqr, and its ^0.27.0 range
      cannot reach the 0.28.1 fix. Neither audit job will ever report it.
    failure_scenario: >-
      Not exploitable here, and I checked before filing: the advisory needs `esbuild serve`
      on Windows, tsup never invokes the dev server, and this is a devDependency. What
      makes it worth a line is the mechanics. tsup declares `esbuild: ^0.27.0`, so on 0.x
      semantics the range is >=0.27.7 <0.28.0 and the patched 0.28.1 is unreachable without
      a tsup release. Dependabot bumping esbuild cannot fix it because esbuild is not a
      direct dependency. And both audit jobs run at `--audit-level moderate` (F-049's
      resolution), so a low-rated advisory exits 0 - I confirmed `pnpm audit
      --audit-level moderate` reports "1 low" and still exits 0. The result is a
      known-vulnerable package that no configured mechanism can either surface or move.
      The exposure today is zero; the concern is that the same three properties would hold
      for a dev-tool advisory that did matter, and this is the first live instance of the
      band ADR-0018 knowingly left uncovered.
    required_change: >-
      No dependency change - do not add an override, the fix is not reachable. Record the
      known exception where the next auditor will find it (a line in the TASK report or
      ADR-0018's consequences), and re-check when tsup ships a release on esbuild 0.28.x.
      If a low-band exception list is wanted, ADR-0018 is where it belongs, not a config.

  - severity: minor
    kind: security
    file: pnpm-workspace.yaml
    line: 9
    summary: >-
      engine-strict was skipped as a forced tradeoff against gitignoring .npmrc. It is not
      forced - pnpm reads engineStrict from pnpm-workspace.yaml, which is tracked.
    failure_scenario: >-
      The fix report states engine-strict was dropped because ".npmrc that git ignores is a
      config that silently does not exist on a fresh clone", which is correct reasoning
      about the wrong file. pnpm's settings documentation (pnpm.io/settings, v11/v12) says
      only auth and registry settings are read from .npmrc and that everything else belongs
      in pnpm-workspace.yaml, where this repo already keeps `allowBuilds`. With the setting
      absent, `engines.node: ">=24.13.0"` stays advisory: a contributor or a self-hosted
      runner on an end-of-life Node 18 or 20 installs and runs with a warning at most, on a
      runtime that no longer receives security patches, and produces a lockfile and test
      results from a runtime nobody reviewed. F-052's own required_change named this as the
      hardening; it was dropped for a reason that has a clean answer.
    required_change: >-
      Add `engineStrict: true` to pnpm-workspace.yaml. Keep .npmrc gitignored - that
      decision is right and should not be revisited. Confirm the key is honoured on pnpm
      11.20.0 before relying on it.

  - severity: minor
    kind: design
    file: apps/api/tsup.config.ts
    line: 20
    summary: >-
      The config asserts only the workspace package is inlined. zod@4.4.3 is inlined too,
      so the deployed unit vendors a runtime dependency no manifest inside it declares.
    failure_scenario: >-
      tsup externalises what the bundled package's own package.json declares. zod is a
      dependency of packages/contracts, not of apps/api, so esbuild inlined it - verified:
      dist/main.js requires only @nestjs/common, @nestjs/core and reflect-metadata, while
      the sourcemap lists 82 sources including the full zod tree. The inlining is correct
      and necessary (pnpm's strict layout means an external `require("zod")` would not
      resolve from apps/api/node_modules), so this is not a defect to reverse. The exposure
      is inventory. A container scanner or SBOM generator pointed at the Fly image derives
      its Node inventory from package.json files; apps/api declares six runtime deps and
      the artifact contains a seventh. A zod advisory would be flagged by the repo-root
      `pnpm audit --prod` (I confirmed apps/api -> @shortkit/contracts -> zod@4.4.3 is in
      the prod tree, so the CI gate holds) and missed by every image-level scan. The set of
      silently-vendored packages grows with every dependency a later TASK adds to
      packages/contracts, and nothing announces the growth.
    required_change: >-
      Correct the config comment so it says what happens - anything reachable from the
      workspace package that apps/api does not declare is inlined - and record for TASK-042
      that image-level scanning will not see bundled dependencies, so the repo-root audit is
      the authoritative inventory for the API image.

  - severity: minor
    kind: security
    file: apps/api/tsup.config.ts
    line: 18
    summary: >-
      sourcemap: true emits dist/main.js.map with sourcesContent for all 82 sources; a
      wholesale COPY dist/ ships ~1 MB of original source into the deployed image.
    failure_scenario: >-
      Verified: the map carries `sourcesContent` for every one of its 82 sources, i.e. the
      full TypeScript of apps/api, the inlined packages/contracts, and the zod tree. Today
      the repo is public (ADR-0018) so the source is not a secret and the map is not served
      to browsers, which is why this is minor and not major. It matters as a default that
      TASK-042 will inherit without deciding: the naive Dockerfile line is `COPY dist/
      dist/`, the map goes with it, and from then on anything that lands in an API source
      comment - a rate-limit threshold, an internal hostname, a note about how a token is
      derived - is readable by anyone who can exec into the container or pull the image
      from a registry. It also becomes materially wrong if the repo is ever made private.
    required_change: >-
      Decide it deliberately in TASK-042 rather than inheriting it: either exclude
      *.map from the image, or keep the map and pass --enable-source-maps so it is at least
      earning its size in readable stack traces. Nothing to change in TASK-001; this needs
      to be written where the Dockerfile is authored.

  - severity: minor
    kind: behavior
    file: packages/contracts/package.json
    line: 9
    summary: >-
      sideEffects: false licenses bundlers to drop import-for-effect modules, and nothing
      enforces the assertion. It is true today and unguarded for every later TASK.
    failure_scenario: >-
      I read the package: index.ts and errors.ts contain no top-level statement with an
      effect, so the flag is accurate right now. index.ts also carries twelve commented-out
      re-export lines that TASK-007, TASK-009, TASK-013, TASK-021, TASK-025, TASK-040,
      TASK-049 and TASK-053 will uncomment. When one of those modules registers something
      at import time - a zod global error map, a frozen reserved-hostname list, a canonical
      redaction map that both surfaces share - esbuild (API) and Turbopack (web) are
      entitled to drop the import whose bindings look unused, and they will do it silently
      and only in the bundled production build. Vitest and the dev server do not bundle, so
      every gate in this repo stays green while the production artifact is missing the
      registration. For a validation or redaction registration that is a security control
      that exists in test and not in prod, which is the worst shape a control can have.
    required_change: >-
      Keep the flag - it is correct and it is what lets apps/web tree-shake the barrel -
      and make the assertion enforceable: state in packages/contracts/src/index.ts, next to
      the existing "MAY IMPORT zod AND NOTHING ELSE" rule, that no module in this package
      may do work at import time, so a later TASK reads the constraint at the point of
      violating it. TASK-007 already owns a lint block for this package and is the natural
      place if a rule is wanted.

  - severity: minor
    kind: security
    file: apps/api/src/main.ts
    line: 49
    summary: >-
      The new bootstrap catch prints error.stack verbatim through console.error, outside
      whatever redaction ADR-0022's pino config will apply.
    failure_scenario: >-
      Forward-looking, and there is already a named successor (the comment says TASK-003
      swaps console for pino), which is why this is minor. Today bootstrap creates a Nest
      app with no modules and the only reachable failure is EADDRINUSE, whose stack holds
      nothing sensitive. From TASK-004 onward bootstrap initialises config and a database
      client, and a startup failure there produces an error whose message can embed the
      connection target and, depending on the driver's URL-parse path, the full
      postgres://user:password@host/db string. That goes to stdout as one JSON line, into
      Fly's log stream and any drain attached to it, having bypassed the redact list that
      ADR-0022 exists to apply - because this handler predates the logger and is the one
      log line in the process that will never route through it unless someone remembers.
      The risk is precisely that the TASK-003 swap covers request logging and leaves the
      bootstrap handler as written.
    required_change: >-
      When TASK-003 registers pino, route this handler through it so the redact list
      applies, or narrow what it emits to error.message plus a stack with no cause chain.
      Add the obligation to TASK-003 rather than leaving it in a code comment in a file
      TASK-003 has no reason to open.

  - severity: nit
    kind: behavior
    file: apps/api/src/main.ts
    line: 56
    summary: >-
      process.exitCode = 1 instead of process.exit(1) lets a partially-started app keep the
      process alive on an open handle.
    failure_scenario: >-
      Availability, not security, and it does not reproduce on the failure the report
      exercised - EADDRINUSE leaves no handle, which is why exit 1 was observed. Setting
      exitCode only requests an exit when the event loop drains. Once bootstrap has more
      than a listen call - a database pool from TASK-004, a Redis client, a health probe
      timer - a throw after one of those is created leaves a live handle, the process never
      exits, and the exit code is never delivered. Fly restarts on process exit, not on a
      process that is alive and not serving, so the failure presents as a healthy-looking
      instance that answers nothing rather than as a crash loop with a readable log.
    required_change: >-
      Use process.exit(1) after the log write, or keep exitCode and call app.close() in the
      handler. Cheapest now, while the handler has one caller.
```

## Deferred — ledger only, does not extend the loop

Out of scope for this fix diff. Recorded so they are not rediscovered.

- **`errorResponse(code, message, details?: unknown)`** — `apps/api/src/common/error-envelope.ts:16`
  is the single choke point through which TASK-007's exception filter will serialise every
  client-facing error, and `details` is unconstrained. The contract permits this
  (`errorEnvelopeContract` declares `details: z.unknown().optional()`), so it is not a
  deviation, but it is the exact line where a caught `ZodError` carrying submitted values -
  an email, an invitation token, a hostname - would reach a client verbatim under
  `validation_failed`. `validationDetailsContract` already defines the only legal shape for
  that code (`{ fieldErrors }`). TASK-007 should narrow or validate at this function rather
  than trusting call sites.
- **`.gitignore` `packages/*/src/**/*.js` and `apps/*/src/**/*.js`** are broad enough to
  swallow a legitimate `.js` under a source directory. Nothing is affected today
  (`git ls-files -i -c` is 0), but a later TASK that adds one gets a file that never commits
  and CI failures that reproduce only on a fresh clone. Cheap to survive; worth knowing.
- **Node 24 floor has no downstream producer.** `tsup` targets `node24` and `engines` now
  says `>=24.13.0`, but grepping TASK-002, TASK-003 and TASK-042 for a Node version or
  `setup-node` returns nothing. A CI runner or base image on Node 22 would run a bundle
  emitted for 24. Availability, not security, but it is the same dropped-handoff shape as
  the F-047 residual.
- **`>=24.13.0` is a floor, not a patch guarantee.** It permits exactly 24.13.0 forever. The
  artifact that must track the 24.x security line is TASK-042's base-image pin.
- **`any-promise@1.3.0`** (last published ~2016) is now on the build host via
  tsup → sucrase → mz → thenify. Script-free, four functions, dev-only. Not worth acting on;
  worth not rediscovering.
- **Commit `96d2d54`** removes an assertion from `apps/api/src/app.module.spec.ts` while the
  fix report states "No test file was created, modified or deleted." Both are true of their
  own commits (the deletion is a separate, earlier commit), but the report reads as covering
  the range. Test-coverage question, not mine — noted for whoever owns the range.

## Notes

- **No blocker, no major, and nothing in the fix diff regressed a round-1 conclusion of
  substance.** The two things I would have blocked on - a credential reaching the tree, or a
  dependency arriving from a non-registry source or without integrity - were both checked
  directly and are clean at 522 resolutions.
- **The tsup ruling is safe from a supply-chain standpoint.** It added 52 resolutions, all
  sha512 from the npm registry, all MIT or Apache-2.0, and - the part that mattered most -
  **zero new install-time code execution**. The install-hook scan across the whole installed
  tree returns exactly the three entries `allowBuilds` already covers. A bundler was the
  category of dependency most likely to widen that surface, and it did not.
- **The F-047 residual is the finding I would most want read.** Its severity is minor and its
  importance is not: the fix produced a verified integrity hash and no mechanism that checks
  it, which is the shape that reads as coverage on every future review. It is also the third
  time in this initiative (F-040, F-050, now this) that an obligation stated only in a report
  failed to reach a TASK file. That is a workflow observation, not a code one, and belongs in
  the retro.
- **F-049's resolution is sound and its known gap arrived immediately.** ADR-0018 accepted
  that low-band advisories pass both audits; the esbuild advisory landed in the same diff and
  is unreachable, unfixable and unreportable at once. Nothing to change - the ADR predicted
  this band - but a first instance is worth recording against the prediction.
- **GC-9 has no live surface yet.** The only log statement in the API is the bootstrap catch,
  covered above.
- **GC-4 holds:** no AI attribution anywhere in `0e7b3b2..5054a03`.

## Dependencies reviewed

Added: **1 direct** (`tsup@8.5.1`, dev, MIT), **+52 lockfile resolutions**, 0 removed.
Total 522, every one sha512 from the npm registry. No `overrides`, no `patchedDependencies`,
no `packageExtensions`, no git/tarball/directory sources. Licenses of everything new: MIT or
Apache-2.0 (`ts-interface-checker`); no copyleft entered with this change. Install lifecycle
scripts across the entire tree: 3, all covered by the existing `allowBuilds` allowlist.
One known advisory in the new set - `esbuild@0.27.7`, GHSA-g7r4-m6w7-qqqr, low, not
reachable in this configuration - filed above.
