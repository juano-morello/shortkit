# TASK-001 — code review (round 1)

- **Auditor:** `sdlc-reviewer` (opus)
- **Verdict:** changes-requested
- **Counts:** 1 major, 4 minor, 2 nit
- **Base..head:** `cee06e4..f58f340`
- **Date:** 2026-08-04

> **Persistence note.** `sdlc-reviewer` has no Write tool and its instructions forbid
> writing report files, so it returned this review inline and the orchestrator wrote it
> here verbatim. The auditor created and modified nothing.

## Orchestrator verification of the major

The major was reproduced **in this repository**, not accepted on the auditor's scratch
reproduction. A file `apps/api/src/probe-contracts.ts` importing `ERROR_CODE_STATUS`
from `@shortkit/contracts` was added, the three commands run, and the file removed:

```
pnpm typecheck   EXIT=0
pnpm test        EXIT=0
pnpm build       EXIT=2
  error TS6059: File '.../packages/contracts/src/index.ts' is not under 'rootDir'
                '.../apps/api/src'. 'rootDir' is expected to contain all source files.
  error TS6059: File '.../packages/contracts/src/errors.ts' is not under 'rootDir' ...
```

Two green gates and one red, exactly as described. A second observation the auditor did
not report: the failed build also emitted `errors.js`, `errors.js.map`, `index.js` and
`index.js.map` into `packages/contracts/src/`, and **none of them is gitignored**, so a
`git add -A` after a failed build commits compiler output into the contracts package.

The subpath-export minor was reproduced the same way:

```
import { RESERVED_SLUGS } from '@shortkit/contracts/slug';
pnpm typecheck   EXIT=2
  error TS2307: Cannot find module '@shortkit/contracts/slug'
```

Confirmed `packages/contracts/src/` contains `errors.ts` and `index.ts` and no
directory-per-module layout, so every subpath the exports map advertises is dead.

## Findings

```yaml
verdict: changes-requested
findings:
  - severity: major
    kind: implementation
    file: apps/api/tsconfig.build.json
    line: 6
    summary: >-
      apps/api has no working build or runtime path to @shortkit/contracts. The first
      apps/api/src file that imports it makes `pnpm build` exit non-zero, and the emitted
      CommonJS requires TypeScript source that the declared minimum Node cannot load.
    failure_scenario: >-
      A wave-1/2 TASK writes `import { ERROR_CODE_STATUS } from '@shortkit/contracts'` in
      apps/api/src/common/error.filter.ts (ADR-0005 and errors.ts's own header say the API
      exception filter reads this table, so this import is certain, not hypothetical).
      `pnpm typecheck` still passes and `pnpm test` still passes, because tsc --noEmit and
      Vitest both resolve the mapped source happily. `pnpm build` then fails with TS6059.
      Relaxing rootDir does not fix it either: tsc never rewrites module specifiers, so
      dist/main.js resolves @shortkit/contracts through its exports map to ./src/index.ts,
      a .ts file. On Node v24 here that loads via default type stripping, but root
      package.json declares engines.node ">=22.12.0", and Node 22.12-22.17 has no default
      type stripping: `node dist/main.js` dies with ERR_UNKNOWN_FILE_EXTENSION ".ts" on the
      deployed API. Type stripping is also erasable-syntax-only, so the day
      packages/contracts uses an enum or a decorator the production API breaks at require
      time regardless of Node version.
    required_change: >-
      apps/api must have a proven compile-and-run path for the contracts package before any
      wave-1 TASK imports it. Any of: (a) give packages/contracts a build to dist JS +
      .d.ts and point exports at it for the API while keeping source for the bundler-based
      web app; (b) build apps/api with a bundler/transpiler that inlines workspace source
      (swc/tsup) rather than bare tsc with rootDir src; (c) widen rootDir to the repo root
      and add specifier rewriting. Acceptance evidence must include `pnpm build` exiting 0
      AND `node apps/api/dist/main.js` starting, with a real apps/api/src ->
      @shortkit/contracts import present. ADR-0005 rules out (a) in its alternatives table
      on typecheck grounds only and never addresses the API's runtime, so this may need a
      design ruling rather than a pure implementation fix.

  - severity: minor
    kind: implementation
    file: apps/api/src/app.module.spec.ts
    line: 21
    summary: >-
      The test `starts with no feature modules registered` asserts
      Reflect.getMetadata('imports', AppModule) equals [], encoding a transient bootstrap
      state as a permanent invariant.
    failure_scenario: >-
      TASK-003 registers HealthModule (or TASK-005 DbModule) in AppModule.imports.
      `pnpm test` goes red with "expected [ HealthModule ] to deeply equal []" in a spec
      file that TASK's paths do not necessarily cover, so its implementer must delete or
      rewrite a test it does not own -- either a rework round or an out-of-scope edit, on
      the very next backend TASK.
    required_change: >-
      Assert something that stays true as modules are added (that AppModule compiles and
      resolves, which the first test already does). AC-3 remains satisfied by the compile
      test.

  - severity: minor
    kind: implementation
    file: apps/api/vitest.integration.config.ts
    line: 19
    summary: >-
      passWithNoTests: true makes `pnpm test:integration` exit 0 when its glob matches
      nothing, which is indistinguishable from a suite that ran.
    failure_scenario: >-
      TASK-056's isolation suite lands as apps/api/test/isolation/rls.int.spec.ts (dot
      instead of hyphen) or under apps/api/src/. The include glob test/**/*.int-spec.ts
      matches nothing, vitest prints "No test files found" and exits 0, and TASK-002's
      mandatory integration job (per the F-039 ruling) is green with a real Postgres
      service container spun up and zero assertions executed. SC-1's "isolation proven by
      an automated suite" is then satisfied on paper by a suite no pipeline actually runs
      -- the exact failure shape F-039 was filed to prevent.
    required_change: >-
      The flag must not survive past the first real .int-spec.ts. Either remove it and give
      the command something to match now, or make its removal an explicit, named obligation
      on TASK-005, and have the CI integration job assert a non-zero test count.

  - severity: minor
    kind: contract
    file: packages/contracts/package.json
    line: 8
    summary: >-
      The subpath export "./*": "./src/*/index.ts" (mirrored in both apps' tsconfig paths)
      cannot resolve any file in the contracts package as the stubs lay it out.
    failure_scenario: >-
      TASK-024 must import the reserved-slug list from packages/contracts (ADR-0006
      follow-up). Written the natural way, `import { RESERVED_SLUGS } from
      '@shortkit/contracts/slug'` maps to packages/contracts/src/slug/index.ts, which does
      not exist -- the stub is src/slug.ts. Result TS2307 in apps/api, plus a Turbopack
      module-not-found at build in apps/web. Same for /roles, /pagination and /domains.
      Every subpath the map advertises is dead.
    required_change: >-
      Either the map becomes "./*": "./src/*.ts" plus a nested entry, or the stub layout
      moves to directory-per-module, or the package documents that only the root specifier
      is supported and the subpath entry is removed. TASK-001 copied ADR-0005's block
      verbatim, so the inconsistency originates in ADR-0005 vs design/stubs -- this likely
      routes to design. Whatever is chosen must be applied in three places at once:
      packages/contracts/package.json, apps/api/tsconfig.json, apps/web/tsconfig.json.

  - severity: minor
    kind: implementation
    file: apps/api/tsconfig.json
    line: 5
    summary: apps/api uses moduleResolution "Node" (node10), which ignores package exports maps.
    failure_scenario: >-
      node10 resolution finds types only via main/typings and real directories on disk.
      Every dependency the roadmap adds that publishes subpath types exclusively through
      "exports" -- better-auth (ADR-0013 mounts better-auth/node), several @upstash/redis
      and pino transport subpaths -- resolves to TS2307, and the cheapest green fix an
      implementer reaches for is a `declare module` shim or `any`, which silently discards
      the types the design relies on. Honest limit: none of those packages are installed
      yet, so the failure could not be demonstrated here -- everything currently in
      apps/api does resolve under node10, which is why typecheck is green today.
    required_change: >-
      Move apps/api to "moduleResolution": "node16" (or nodenext with the matching module
      setting) now, while the workspace has four dependencies, rather than after fifty
      TASKs have been written against node10 semantics. If node10 is kept deliberately,
      record why, because it constrains every backend dependency choice that follows.

  - severity: nit
    kind: implementation
    file: apps/api/src/main.ts
    line: 19
    summary: >-
      `process.env.PORT ?? DEFAULT_PORT` treats an empty PORT as a valid value, and a
      failed bootstrap surfaces only as a bare unhandled rejection.
    failure_scenario: >-
      A platform or compose file that sets PORT= (empty) gets app.listen('') rather than the
      3001 default; Express treats an empty string as a path/pipe rather than a port and the
      process comes up unreachable instead of falling back. TASK-004 owns env config.
    required_change: >-
      Coerce and validate (Number(process.env.PORT) || DEFAULT_PORT) or defer entirely to
      TASK-004's env schema, and attach a failure handler to bootstrap() that logs before
      exit.

  - severity: nit
    kind: implementation
    file: package.json
    line: 7
    summary: >-
      engines.node is ">=22.12.0" while @types/node is 24.13.3, so the compiler advertises a
      Node API surface wider than the minimum supported runtime.
    failure_scenario: >-
      Code typechecks against a Node 24-only API and fails at runtime on the 22.12 floor the
      repo claims to support. Realistic but not imminent.
    required_change: >-
      Align the two: either raise the engines floor to the Node major actually targeted for
      deploy, or pin @types/node to the 22.x line.
```

## Cannot verify from diff

- **AC-1 / AC-3 / AC-107 command exit codes.** The reviewer did not re-run them per its
  brief. *Orchestrator note: covered — the orchestrator ran all four gates from a
  deleted-`node_modules` state, and `sdlc-product-auditor` ran them in a genuine clean
  clone at `/tmp/tk-clean`.*
- **`pnpm-workspace.yaml` `allowBuilds:` semantics.** pnpm 11.20.0 is past the auditor's
  knowledge cutoff. Install-log evidence judged adequate; not flagged. *Orchestrator note:
  `sdlc-security-auditor` independently confirmed the key is correctly scoped to
  `@swc/core` and `esbuild`, both dev-only.*
- **AC-4 negative direction.** Rests on the implementer's report; nothing in the tree
  records it. *Orchestrator note: covered — the orchestrator re-executed it directly
  (two TS2339, exit 2, reverted clean).*
- **`better-auth` pin.** Correctly absent from this diff; tracked as F-040.
- **Cross-TASK items** — `docker-compose.test.yml` (TASK-005), the CI `integration` job
  (TASK-002), and the `config.yaml` population (the post-merge `init` re-run) — all
  correctly out of this diff. *Orchestrator note: the init re-run has since been done.*
- **`coverage_gate`.** No coverage reporter is configured anywhere in the diff. No AC
  requires one. *Orchestrator note: `coverage_gate` was left `null` at the init re-run
  precisely because nothing can satisfy it yet.*

## Checked and clean

Commit `f58f340` carries no AI attribution in subject or body (GC-4 holds); the subject is
`feat(repo): ... [TASK-001]` on branch `sdlc/launch-core` (GC-10 holds); nothing under
`.sdlc/` is in the commit. `main.ts`'s global prefix and `GET /health` exclusion match
ADR-0006's Decision block character for character. `packages/contracts/src/errors.ts` is
byte-identical to its design stub. The root `vitest.config.ts` `test.projects` shape,
`unplugin-swc` with `module: { type: 'es6' }`, jsdom + `@vitejs/plugin-react`, and the
two-command split all match ADR-0001.

Vitest project isolation is real: three distinct configs, distinct names, distinct
environments, and `apps/api`'s `include` is `src/**` only, so future
`test/**/*.int-spec.ts` files cannot leak into `pnpm test`.

`.gitattributes`'s `-merge` usage is correct git semantics (unset `merge` = declare a
conflict rather than auto-merge), and the globs match drizzle's actual output layout.

**On `decorator-metadata.spec.ts`:** the reviewer explicitly disagrees with the
implementer's offer to delete it. It is the only thing converting ADR-0001's silent
accepted cost into a loud one. Keep it.

**Both deliberate deviations were honoured.** `test_exempt` produced four passing spec
files with genuine assertions, one per workspace as AC-3 requires. Nothing was written
under `apps/web/src/**`, so TASK-008 and TASK-012 start on empty ground; the ownership
exception was used narrowly.

## Raised against the ledger, not the code

**TASK-001's `paths:` whitelist is narrower than what the TASK must produce.**
`pnpm-lock.yaml`, root `vitest.config.ts`, `.gitattributes` and root manifests are all
required by ADR-0001/ADR-0004/ADR-0018 but are not in the list (`tsconfig*.json` and
`"lint config"` do not cover `vitest.config.ts`). The implementer wrote them anyway and
flagged `.gitattributes`; that was the right call. A TASK-file defect, not an
implementation defect. `sdlc-product-auditor` filed the `.gitattributes` half as its one
nit independently.

**Findings-ledger discrepancy.** F-040 and F-041 still read `status: escalated` with
`resolved_by: null` and no `ruling:` block, unlike F-038 and F-039 which carry `status:
fixed` plus written rulings — yet `STORY-001.md` already contains the amended AC-2 text.
*Orchestrator note: correct, and it was the orchestrator's defect. Fixed in the same pass
that filed this report.*

On the substance the reviewer agrees with both rulings: F-041's amendment is the only
reading that keeps AC-1 satisfiable, and F-040's move to TASK-009 is right because the
pin's precondition is a documentation re-check the TASK-001 implementer cannot perform.

## Forward risks, deliberately not filed

1. The four unmaterialised contracts stubs (`pagination.ts`, `roles.ts`, `slug.ts`,
   `domains/reserved-hostnames.ts`) have still never been compiled. `design/stubs/README.md`
   says "TASK-001 and TASK-007 must verify these compile", so the whole obligation now
   rests on TASK-007, which should know it is inheriting all of it.
2. `apps/web/tsconfig.json`'s `paths` block is redundant under `moduleResolution:
   "Bundler"`, which reads the exports map directly. Harmless duplication today, but it is
   a third place the contracts mapping must be kept in sync.
