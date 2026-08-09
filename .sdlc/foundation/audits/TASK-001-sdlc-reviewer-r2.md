# TASK-001 — code review, round 2 (scoped re-review of fix round 1)

- **Auditor:** `sdlc-reviewer` (opus)
- **Base..head:** `0e7b3b2..5054a03`
- **Verdict:** approved
- **Prior findings:** 7 of 7 ADDRESSED
- **New from this fix diff:** 0 blocker, 0 major, 6 minor

> **Persistence note.** `sdlc-reviewer` has no Write tool; it returned this review inline
> and the orchestrator wrote it here. The auditor created and modified nothing.

## Verdicts on the seven round-1 findings

### F-042 (major) — ADDRESSED

Approach sound. The auditor inspected the committed artifact and config rather than
re-running gates.

- `apps/api/dist/main.js` emits exactly three external requires — `@nestjs/common`,
  `@nestjs/core`, `reflect-metadata` — and zero `.ts` requires.
- `slug_generation_exhausted` appears twice (the `ERROR_CODES` array and the
  `ERROR_CODE_STATUS` table), so workspace source is genuinely inlined.
- `_ts_decorate` appears 4×, `__decorateClass` 0× — the swc helper, not esbuild's. **tsup's
  swc path really ran, so `emitDecoratorMetadata` survives the build.** This was the single
  highest risk in moving off `tsc` and it is discharged.
- `tsconfig.build.json` is gone and nothing references it.

The `rootDir` scatter failure is now structurally impossible: tsup has one `outDir`.
Combined with the new `.gitignore` block, the untracked-`.js` half is closed twice over.

Against later TASKs it holds: GC-7 caps the repo at three workspaces so literal
`noExternal: ['@shortkit/contracts']` cannot rot. Losing typecheck from `build` is a real
cost, but `pnpm typecheck` covers all three workspaces as a separate required gate.

**On `error-envelope.ts` earning its place:** yes, but wrong directory. The error-envelope
contract makes `ERROR_CODE_STATUS` normative and forbids re-declaring it API-side, so a
single helper reading it is a module the design requires regardless of F-042. Implementation
correct: the `Record<ErrorCode, number>` lookup is total, and the `details === undefined`
branch avoids emitting a `details` key. The auditor notes its own F-042 acceptance criteria
forced the module to exist now rather than at TASK-007. Defect is placement — new finding 1.

### F-043 — ADDRESSED

`decorator-metadata.spec.ts` survived: `git log` shows its last touch is still `f58f340`.
Both assertions intact. The auditor accepts removing rather than replacing the empty-imports
assertion — `Reflect.getMetadata('imports', AppModule)` is Nest's own storage format, so any
replacement really would have asserted about Nest. Four spec files, one per workspace,
14 tests.

### F-044 — ADDRESSED (in-repo half); one clause of the required change landed nowhere

The in-repo fix is stronger than asked. `include` widened to `**/*.int-spec.ts` closes the
"lands under `src/`" half; `assertEveryIntegrationSpecRuns()` closes "dot instead of hyphen"
by name. The regex pair is correct: `/\.int[-.]spec\.ts$/` minus `/\.int-spec\.ts$/` is
exactly `*.int.spec.ts`. `readdirSync` recursive does not follow symlinks, so the pnpm store
is not walked. The unit config's `src/**/*.spec.ts` cannot match `*.int-spec.ts`.

**What did not land:** the second clause — *"make its removal an explicit, named obligation
on TASK-005, and have the CI integration job assert a non-zero test count."* Neither exists.
No task file mentions `passWithNoTests` or a non-zero test count. `TASK-002.md` was amended
twice in this diff without picking it up. As it stands `pnpm test:integration` still exits 0
with zero tests inside TASK-002's mandatory integration job, and the flag has no removal
owner. Needs one line in `TASK-002.md` and one in `TASK-005.md`.

### F-045 — ADDRESSED

All three places agree. `"exports": { ".": "./src/index.ts" }` + `"sideEffects": false`; the
`"@shortkit/contracts/*"` key deleted from both tsconfigs, leaving byte-identical single-key
blocks. ADR-0005 carries the amendment, the alternatives table, and — creditably — an honest
correction of its own false claim that path mapping made a build unnecessary. TASK-007,
TASK-009 and TASK-024 each carry the root-specifier rule at the point the implementer needs
it, which is where the original finding said the risk lived.

### F-046 — ADDRESSED. The auditor accepts the dispute and withdraws `node16`/`nodenext`.

The defect named — node10 silently ignoring `exports` maps, so the cheap green fix is a
`declare module` shim that discards types — is closed. `Bundler` reads exports maps and the
`reflect-metadata/lite` probe is the right demonstration.

**The one concrete gap `Bundler` leaves**, asked for explicitly: it does not enforce Node's
ESM/CJS interop, so an ESM-only external dependency can typecheck while `dist/main.js` emits
`require("that-pkg")`. Under `node16` that is a compile error. **But** F-052 raised the floor
to Node 24 in the same round, and Node 24 supports `require()` of ESM. The residual narrows
to one shape: an ESM-only dependency containing top-level await, which throws
`ERR_REQUIRE_ASYNC_MODULE` at first require. Rare, loud, and immediate at boot — unlike the
node10 failure whose danger was silence. Set against a broken `apps/web` Turbopack build and
a frozen TASK-007 stub, the trade is right.

Consistency note, not a finding: `apps/api`, `apps/web` and the root tsconfig now all use
`moduleResolution: Bundler`, a coherent repo-wide position rather than a per-workspace
exception.

### F-051 (nit) — ADDRESSED

`resolvePort` correct on every constructed case: `undefined`, `""`, `"   "`, `"abc"`, `"0"`,
`"65536"` → 3001; `"3000"` → 3000. `"0x1f"` → 31 and `"3e3"` → 3000 are `Number()` being
permissive, not a defect. The bootstrap handler exists and logs with context; its exit path
has a defect — new finding 2.

### F-052 (nit) — ADDRESSED, and the direction is right

Raising the floor beats pinning `@types/node` down for a reason beyond those given:
`@types/node@22.x` would make the compiler blind to APIs the runtime has, and implementers
would work around it with casts. Raising the floor makes the types honest in the direction
that produces correct code.

Dropping Node 22 costs nothing verifiable here. No `.nvmrc`, no Dockerfile, no CI workflow,
and `config.yaml` records no Node version; the only surviving `22.12` references are in audit
prose. It also removes the original F-042 runtime hazard entirely, since Node 24
type-stripping is no longer load-bearing anywhere.

## New findings from the fix diff

```yaml
verdict: approved
findings:
  - severity: minor
    kind: implementation
    file: apps/api/src/common/error-envelope.ts
    line: 1
    summary: >-
      The new module sits outside TASK-007's paths (apps/api/src/common/errors/**), even
      though its own docblock names TASK-007's exception filter as its consumer.
    failure_scenario: >-
      TASK-007 has paths ["packages/contracts/**", "apps/api/src/common/errors/**"] and
      Produces the API-side exception filter. Its implementer writes
      apps/api/src/common/errors/http-exception.filter.ts and needs the code-to-status
      lookup. error-envelope.ts is one directory above its whitelist, so it can import the
      helper but cannot move, extend or correct it. Likely outcomes are all bad:
      re-implement ERROR_CODE_STATUS[code] inside errors/, the exact duplication the file's
      own comment forbids; request an out-of-path edit, costing a rework round on a wave-1
      TASK; or leave the error-shape logic split across two directories with the seam owned
      by nobody.
    required_change: >-
      Move it to apps/api/src/common/errors/error-envelope.ts, inside TASK-007's existing
      paths, needing only the main.ts import updated. Moving is cheaper than widening paths
      and puts the envelope next to the filter that serialises through it.

  - severity: minor
    kind: behavior
    file: apps/api/src/main.ts
    line: 56
    summary: >-
      The bootstrap catch sets process.exitCode = 1 and never closes the Nest app, so the
      process only exits if the event loop happens to be empty.
    failure_scenario: >-
      Works today because AppModule has no providers holding handles. It stops working at
      TASK-005: DbModule opens a pg Pool during NestFactory.create; if app.listen then fails
      the pool keeps the event loop alive indefinitely. process.exitCode = 1 is recorded but
      never delivered, so the container runs forever, never listening and never exiting. On
      Fly.io the platform sees a live process, so the restart path that would recover a
      crashed boot never triggers - the API is down and looks up. Same shape for Redis
      (TASK-051) and any provider with a timer.
    required_change: >-
      Hold the app instance outside the try so the catch can await app?.close(), then call
      process.exit(1) after the log flushes rather than relying on the loop draining.

  - severity: minor
    kind: implementation
    file: apps/api/src/main.ts
    line: 47
    summary: >-
      The comment "TASK-003 swaps console for the pino logger" names a TASK that cannot write
      this file, so the interim console.error has no owner able to remove it.
    failure_scenario: >-
      TASK-003's paths are fly.toml, Dockerfile, infra/**, apps/api/src/health/** and
      app.module.ts - main.ts is not among them. Only TASK-009 lists main.ts. TASK-003 lands
      pino and logging-and-headers.md, whose Normative form is
      "apps/api/src/observability/logger.ts and apps/api/src/main.ts" and whose Consumed-by
      is "every API TASK. Nothing may opt out." Its implementer reads the comment, finds the
      file out of path, and either commits an ownership violation or leaves it. The API then
      deploys with a boot-failure log line carrying no level, service, env, timestamp or
      redaction until TASK-009's wave at the earliest.
    required_change: >-
      Either add apps/api/src/main.ts to TASK-003's paths - which logging-and-headers.md
      already implies, since it names main.ts as TASK-003's normative form - or change the
      comment to name the TASK that owns main.ts. Note this also means the logging contract
      currently assigns TASK-003 a file it cannot write, independent of this line.

  - severity: minor
    kind: behavior
    file: apps/api/tsup.config.ts
    line: 1
    summary: >-
      The production bundle's decorator-metadata transform is asserted by nothing;
      decorator-metadata.spec.ts covers the vitest/unplugin-swc transform, now a different
      code path from the build.
    failure_scenario: >-
      tsup declares @swc/core as an OPTIONAL peerDependency (verified:
      peerDependenciesMeta."@swc/core".optional = true). When absent, or when the
      emitDecoratorMetadata detection changes across a tsup upgrade, tsup warns and falls
      back to esbuild, which does not emit design:paramtypes, and pnpm build still exits 0.
      Nothing notices: decorator-metadata.spec.ts runs under vitest's own unplugin-swc
      pipeline and stays green, typecheck is unaffected, and no gate executes dist/main.js.
      TASK-003 adds a HealthController with an injected provider; CI is fully green and the
      deployed container crash-loops on "Nest can't resolve dependencies". ADR-0001 accepted
      the swc configuration precisely because this failure is silent; the fix moved the build
      onto a second instance of it that carries no assertion.
    required_change: >-
      Minimum: name the @swc/core coupling in tsup.config.ts so a dependency cleanup cannot
      silently remove it. Better: a CI step on TASK-002 that runs the built artifact to a
      successful listen, so a bundle Nest cannot boot fails the pipeline rather than the
      deploy. This is a TASK-002 obligation, not a TASK-001 code change.

  - severity: minor
    kind: implementation
    file: .gitignore
    line: 27
    summary: >-
      .npmrc is now ignored repo-wide, which forecloses committed pnpm/npm configuration for
      the whole initiative.
    failure_scenario: >-
      A project-level .npmrc is normal committed configuration; secrets belong in ~/.npmrc or
      in env interpolation, not in a repo file. The concrete case is the one this round
      raised: F-052 suggests .npmrc with engine-strict=true to make the new >=24.13.0 floor
      enforced rather than advisory. An implementer writes it, runs git add -A, and commits -
      git silently skips the file. Locally installs are engine-strict; on a fresh clone and
      in CI they are not. The team believes a Node-version guard exists and it does not, with
      no error anywhere to say so.
    required_change: >-
      Root .npmrc must be committable without git add -f. Remove the .npmrc line or narrow it
      so it cannot swallow repo configuration. The rest of the credential block is correct
      and should stay.

  - severity: minor
    kind: implementation
    file: apps/api/tsconfig.json
    line: 17
    summary: >-
      tsup.config.ts is not in the include list, so the file that now defines how the API is
      built is the one file no gate typechecks - while both vitest configs beside it are
      listed.
    failure_scenario: >-
      tsup loads its config through bundle-require/esbuild, which transpiles without
      typechecking, so a type error there is caught by nothing. The failure that matters:
      someone edits noExternal to a bare string, or misspells the key. tsc would flag it; tsc
      never sees the file. The contracts package then goes external, dist/main.js gets
      require("@shortkit/contracts"), that resolves through the exports map to
      ./src/index.ts, and Node 24 type-strips it - so it appears to work, pnpm build exits 0,
      and F-042 has silently returned, latent until packages/contracts uses one non-erasable
      construct.
    required_change: >-
      Add "tsup.config.ts" to apps/api/tsconfig.json's include, matching the treatment its
      two vitest siblings already get.
```

## On the two items flagged for hardest scrutiny

**`error-envelope.ts`** — defensible as permanent, not scaffolding. Objection is directory
placement only; one `git mv` now versus a rework round on TASK-007.

**`main.ts` logging through the envelope** — challenged partially. The import is legitimate:
a startup failure genuinely is an `internal_error`, and taking the code from the contracts
union rather than hardcoding a string is right. But the call site destructures
`const { body } = errorResponse(...)` and **discards `status`**, and the status lookup is the
only thing `errorResponse` contributes. The contract's boundary is "every API response body
that is not 2xx", and a log line is not a response body.

Measurable cost: `dist/main.js` is 571 KB and carries the full zod runtime (681 `zod`
occurrences) because `errors.ts` evaluates `z.object(...)` at module scope. Today that
payload exists to support a status lookup that is thrown away. **Not filed** — the cost is
temporary, since TASK-004's env schema and TASK-007's validation pipe put zod in the graph
legitimately, after which tsup will externalise it.

Net: the import earns its place, the exact call is slightly stretched, and the real defect at
this site is the exit path (finding 2).

## Cannot verify from diff

- The six command exit codes and the clean-install run — not re-run per brief; the
  orchestrator's verification stands. Artifact properties were confirmed independently from
  the committed `dist/`.
- The `packageManager` sha512 — no network. *Orchestrator note: `sdlc-security-auditor`
  fetched the npm registry metadata and confirmed `dist.integrity` is byte-identical.*
- The nodenext/Turbopack failure the F-046 dispute rests on — not reproduced; accepted on the
  implementer's evidence. The auditor's agreement with `Bundler` does not depend on it.
- Node 24.13.0 availability on the eventual runner and base image. Worth flagging to TASK-002
  that `node-version-file: package.json` reads `engines` and keeps the floor in one place.
- Whether TASK-005/TASK-056's suites will match `**/*.int-spec.ts` — cross-TASK; the guard
  makes a near-miss loud rather than silent.

## Notes — consequences of the tsup approach, handed forward

1. **`@shortkit/contracts` is still in `apps/api`'s `dependencies` while being inlined.** A
   Dockerfile doing `pnpm install --prod --filter @shortkit/api` still resolves the
   `workspace:*` link and needs `packages/contracts` in the build context. TASK-003/TASK-042
   should know. Moving it to `devDependencies` would keep a `--prod` install clean.
2. **`pnpm build` is no longer a type gate.** The Dockerfile must not treat a green build as
   evidence the code typechecks. Belongs in TASK-003's brief.
3. **`sourcemap: true` ships a 995 KB `.map` into the image.** Deliberate; size it into the
   deploy TASK.

Deferred minors for the ledger:

- `.gitignore`'s `apps/*/src/**/*.js` kills the F-042 debris class but also silently skips a
  legitimate `.js` under any `src/`. Unlikely rather than impossible in a TS-only repo.
- `errorResponse(code, message, details?: unknown)` lets any code carry `details`, while the
  contract's invariant 4 says `details` appears only where the contract names a shape
  (currently `validation_failed` alone). TASK-007 will want to tighten the signature.

## Checked and clean

GC-4 holds — no AI attribution in any of the six commit subjects or bodies. GC-10 holds —
`[TASK-001]` / `[launch-core]` scoping correct, and the code commit `a3221b9` is separated
from the `.sdlc/` bookkeeping commits. `packages/contracts/src/errors.ts` remains
byte-identical to its stub.

ADR-0005's amendment is called out as unusually good: it corrects its own prior false claim
rather than papering over it, and the "land together or not at all" follow-up names the
invariant that produced F-045. The F-044 guard is ~20 lines in a config file and the auditor
explicitly rejects a YAGNI objection: the failure mode is silent by construction and the flag
must survive until TASK-005.
