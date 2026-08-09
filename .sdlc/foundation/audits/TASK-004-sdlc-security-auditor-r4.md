# TASK-004 — sdlc-security-auditor, round 4

> Persisted by the orchestrator from the agent's return value (read-only role, as r1–r3).
> Package `.superpowers/sdd/plan/review-0f4deab..3f1e429.diff` (1 commit, 27124 bytes).
> Verification ran in a scratch rsync copy — **eight Next builds**. The real repo was never built
> in and never written to.

## Verdict: CHANGES-REQUESTED

All three round-3 findings are ADDRESSED, F-167 with both required changes rather than the floor.
The verdict is driven by **one new major, which is the same root cause as F-167 surviving F-167's
fix in a third shape I did not enumerate in r3** — and it is TASK-008's literal shape, reproduced
by building. Nothing in this diff is exploitable by anyone.

## Round-3 findings

| Finding | Verdict | Evidence |
|---|---|---|
| **F-167** (major) | **ADDRESSED** — both changes, not the floor | `SCAN_ROOTS` (`:110`) byte-identical in membership; the leak loop (`:440`) no longer names `positiveControl` at all; the control's scan is a separate pass at `:487` over `.next` minus `cache`. Both reproduced shapes fixed: the server-only shape (value lands only in `.next/server/chunks/…`, script now exits 0) and the test-only shape (`SOURCE_TEST_FILE_PATTERN` `:295` excludes it). Fail-closed ordering preserved — the leak `return` at `:468` precedes the control pass. |
| **F-168** (minor) | **ADDRESSED** — via the documentation option the finding itself offered | `sourceScanDescription` (`:479`) is built once and interpolated into both messages so they cannot drift; it names the extension filter, all four exclusions, and the `transpilePackages` gap explicitly. |
| **F-170** (nit) | **ADDRESSED** | `:303`–`:309` states the `pageExtensions` tracking obligation and names the MDX case; set unchanged, per the ruling. |

### F-168 — documentation, or a scope excuse?

**Discharged, but the reasoning offered is weaker than it needs to be.** The finding explicitly
offered "state the limit in the NOTICE" as an equal resolution, and the NOTICE now *understates*
rather than overstates. Naming a known hole is acceptable *here* because the hole's failure
direction is a silent inactive — no leak, no red, only a lost proof — and because the message no
longer asserts the false thing ("nothing reads this variable") that made r3's version a finding.

**The workspace-boundary argument is the weak part, and the orchestrator should not accept it as
precedent.** A TASK's `paths` govern which files it may **edit**; nothing about `paths` prevents a
script from **reading** `../../packages/contracts` at run time — no file outside `apps/web/**`
would have been touched. The honest reasons the documentation option is fine are the failure
direction above and that `packages/contracts` is pure zod schema today. Note also that the finding
below, if resolved as recommended, **deletes the source scan entirely and takes F-168's and
F-170's holes with it** — both exist only because activation is inferred from source text.

## New findings

```yaml
verdict: changes-requested
findings:
  - severity: major
    kind: behavior
    file: apps/web/scripts/assert-no-inlined-secrets.mjs
    line: 499
    summary: >-
      The positive control still infers activation from SOURCE TEXT while taking its evidence from
      BUILD OUTPUT, so a module that references the variable but is not yet imported by any route
      is never compiled, lands nothing in .next, and reds a correct build - which is exactly the
      module TASK-008's card describes.
    failure_scenario: >-
      REPRODUCED BY BUILDING, on this diff at 3f1e429. Created apps/web/src/lib/api/<client>.ts -
      `const baseUrl = process.env.NEXT_PUBLIC_API_BASE_URL ?? ''` plus an exported fetch wrapper -
      with a colocated .spec.ts, and NO page importing it. Clean build with the real value set:
      grep -rl for the value across ALL of .next returns NOTHING, and grep -rl for the variable
      NAME across all of .next also returns nothing, because turbopack only compiles modules
      reachable from an entrypoint. Run with the IDENTICAL value the build used, the script exits 1
      - "the build ran without a real value for this variable, or with a different one than this
      check is now reading." BOTH STATED CAUSES ARE STILL FALSE, on a build with correct code and
      correct environment. Not contrived: TASK-008.md declares paths ["apps/web/src/lib/api/**",
      "apps/web/src/components/errors/**"], lists NEXT_PUBLIC_API_BASE_URL as consumed, and puts
      "any feature screen" OUT OF SCOPE - so on the day TASK-008 merges there is a non-test source
      reference and no route importing it, apps/web/src does not exist today, and the first thing
      that reds is vercel.json's buildCommand and TASK-002's CI. Same operator, same false
      diagnosis, same cheapest repair as F-154/F-161/F-166/F-167. F-167's fix closed the two shapes
      I enumerated and did not close the root cause they were instances of: SOURCE PRESENCE DOES
      NOT IMPLY THE MODULE IS IN THE BUILD GRAPH.
    required_change: >-
      Derive ACTIVATION from the build, not from the source tree. MEASURED DISCRIMINATOR, verified
      in three builds: a compiled reference always leaves the variable NAME somewhere under .next -
      when the value is unset turbopack emits `process.env.NEXT_PUBLIC_API_BASE_URL` literally into
      both .next/static/chunks and .next/server/chunks/ssr, and when the value IS set the name
      survives in the SSR chunk's .js.map sourcesContent - whereas an uncompiled reference leaves
      NEITHER. So: value present -> pass (unchanged); NAME present and value absent -> FAIL exactly
      as today (the real environment mismatch, and the dominant real-world case, the Vercel
      variable not configured); neither present -> the reference is not in the build graph, which
      is not evidence of a mismatch - print a NOTICE that the control could not be proven and exit
      0. That removes the source scan, and with it F-168's transpilePackages hole and F-170's
      pageExtensions obligation. CAVEAT TO RECORD IF TAKEN: the "compiled with a WRONG value" case
      relies on server source maps, which Next 16 emits by default; disabling them would weaken
      that branch to a silent inactive rather than a red. FLOOR if the fail stays unconditional:
      the message must enumerate this third cause and name the command that distinguishes it -
      grep -rl for the variable NAME under .next.

  - severity: minor
    kind: implementation
    file: apps/web/scripts/assert-no-inlined-secrets.mjs
    line: 104
    summary: >-
      The comment recording WHY the leak scan stays narrow states a reason that is measurably false
      - my own r3 wording, propagated verbatim into the code - and it is the reason the next person
      will read when deciding whether to widen it.
    failure_scenario: >-
      :104-108 says widening "would red on any legitimate server-side read of BFF_PROXY_SECRET,
      which is exactly what TASK-012's proxy route will write." VERIFIED FALSE BY BUILDING: a route
      handler plus a server module reading process.env.BFF_PROXY_SECRET without rendering it
      compile to a runtime property access - the emitted chunk contains
      `"string"==typeof process.env.BFF_PROXY_SECRET` - and grep -rl for the secret's value across
      ALL of .next, INCLUDING cache, returns nothing. Only NEXT_PUBLIC_-prefixed variables are
      build-time substituted. Consequence: whoever next weighs widening the leak scan weighs it
      against a false-positive risk that DOES NOT EXIST, and will either widen believing they are
      accepting a cost they are not, or decline on a reason that does not hold. Same class as
      F-167's false diagnosis, one layer up - a security decision recorded with a wrong rationale.
    required_change: >-
      Correct the rationale at :104 to what the evidence supports: the two delivery roots are
      exactly the set of artifacts an unauthenticated request can retrieve, so a red there means
      "this secret is reachable by anyone" - precise and actionable; widening to all of .next would
      change a red's meaning to the weaker "this secret was baked into the build somewhere" and
      would require rewriting the failure message, which currently explains only the two delivery
      paths. Also correct the same claim where it lives in findings.yaml F-167's required_change
      and in the r3 audit's Notes, so the false reason does not outlive the comment.

  - severity: nit
    kind: implementation
    file: apps/web/.gitignore
    line: 6
    summary: >-
      The new ignore patterns hide exactly the class of file `git status` is being used across
      rounds to prove absent, while the source scan - which walks the filesystem, not git - still
      sees it.
    failure_scenario: >-
      Confirmed with git check-ignore: `_probe-*` ignores an underscore-probe at ANY depth under
      apps/web, and `app/probe-*` ignores apps/web/app/probe-health/route.ts. Two consequences.
      (1) The r3 note that caught a transient apps/web/app/_probe-client.tsx did so precisely
      BECAUSE it was not ignored; `git status --porcelain apps/web/app/` - the evidence cited again
      this round - is now BLIND to that exact file. (2) collectSourceFiles walks the FS and does not
      consult git, so a leftover ignored probe still activates the positive control and is still
      compiled by a local build: an invisible file can red a local run, or green one whose
      committed tree has no reference at all. Nothing ships - an ignored file cannot be committed
      and Vercel builds from git - so the cost is MISLEADING VERIFICATION, not exposure.
      Separately, `app/probe-*` would silently swallow a future liveness route named
      apps/web/app/probe-*, which would 404 in production with no diff to look at.
    required_change: >-
      Use `git status --porcelain --ignored apps/web/` for the cleanliness evidence in every
      remaining round, or narrow the patterns to a single unambiguous prefix so no plausible
      product filename collides. No code change required.

  - severity: nit
    kind: behavior
    file: apps/web/scripts/assert-no-inlined-secrets.mjs
    line: 484
    summary: >-
      A hardcoded fallback default in source satisfies the positive control without the build
      having read the environment at all - pre-existing, marginally enlarged by the wider scan.
    failure_scenario: >-
      `process.env.NEXT_PUBLIC_API_BASE_URL ?? 'https://shortkit-api.fly.dev/api'` is the standard
      way people write that read, and TASK-008 is the TASK that writes it. With such a default the
      literal lands in .next from the SOURCE, so the control greens even on a build that ran with
      the variable entirely unset - the one thing it exists to detect. True under round 2's narrow
      scan too for a client-side default; the wider scan makes it true for a server-only default as
      well. Not a leak; the cost is a control that reports proof it does not have.
    required_change: >-
      None in this TASK. Worth one line in TASK-008's card: do not give NEXT_PUBLIC_API_BASE_URL a
      hardcoded fallback - let it fail loudly - or the positive control becomes a tautology.
```

## The claim I was asked to check: verified, and here is what follows

**The implementer's empirical result is correct.** Reproduced independently: a `force-dynamic`
route handler and a server module both reading `process.env.BFF_PROXY_SECRET` without rendering it,
built with a distinctive 36-character base64url value — `grep -rl` for that value across **all** of
`.next`, `cache/` included, returns nothing. The compiled chunk retains the property access
(`configured:"string"==typeof process.env.BFF_PROXY_SECRET`). Only `NEXT_PUBLIC_`-prefixed
variables get build-time substitution.

**So my r3 rationale was wrong as written**, and I have raised it against myself above. TASK-012's
proxy route will not be red by a widened leak scan, because it will leave no trace to red on.

**But the conclusion survives on its own, for a different reason than I gave.** The scan is
value-based, so the secret's bytes can only reach `.next` by being *baked in at build time*: a
`NEXT_PUBLIC_` alias, a hardcoded literal or fallback, a `next.config` `env:` entry, or the value
being rendered/serialised. A runtime read never bakes. So widening would, on today's evidence,
produce **no false positives at all** — every remaining way the value can appear under `.next` is a
defect. What widening buys is catching a baked secret somewhere *not* browser-reachable: not itself
an exposure, but one client import away from one.

What it costs is **the precision of a red**. Today "found under `.next/static` or
`.next/server/app`" means *anyone can fetch this*. Widened, a red means only *this was baked in
somewhere*, and the message would have to be rewritten or it misdiagnoses — the same defect as
F-167, from the other direction.

**Recommendation: the rendered-leak argument stands; do not widen `SCAN_ROOTS`.** If the extra
coverage is wanted, add it as a *separate, differently-worded* assertion with its own message,
exactly as the positive control was separated in this diff — so each red keeps a precise meaning.
Hardening, minor and optional. **What is not optional is fixing the false rationale in the
comment**, since it is what the next person will read.

## Answers to the four audit items

1. **`.next/cache` exclusion — correct, empirically sufficient, and the masking scenario does not
   reproduce.** Tested three ways, no survivor: (a) build with value A, incremental rebuild with
   value B, no `rm -rf` → A gone from all of `.next`; (b) same, rebuilding with the variable unset →
   both gone, script correctly exits 1; (c) build with A, then **orphan the module** and rebuild
   unset → the old chunk is removed too, script correctly exits 1. `next build` under turbopack
   rewrites the output tree rather than accumulating. Vercel restores only `.next/cache` between
   builds, which is exactly what is excluded. One imprecision worth knowing rather than fixing: the
   exclusion matches a directory *name* at any depth, so a future route segment named `cache` would
   drop `.next/server/app/cache/**` from the control's scan; the leak scan passes no exclusions and
   is unaffected.
2. **Two overlapping passes — correct, cost nil.** Structurally separate; the leak loop no longer
   references `positiveControl`; the control pass runs only after the leak `return`. Measured: 144
   files under `.next`, 131 excluding `cache`, 55 in the two leak roots — 55 read twice, whole
   script **0.075 s** on a 35 MB tree. The control pass `break`s on first match.
3. **`.gitignore` — see the nit.** It cannot mask a real source file with any name in this repo
   today (`apps/web/app/_components/**`, the Next private-folder convention, is unaffected —
   verified with `git check-ignore`), and it hides nothing from the source scan. The two real costs
   are the weakened `git status` evidence and the `app/probe-*` collision.
4. **The fifth shape is present, and it is finding 1.** Correct in intent, reds a build with correct
   code and correct environment, blocks the deploy through `buildCommand`, misdirects the operator
   with a diagnosis I verified false, one edit from removal — trigger being TASK-008, the same TASK
   F-167 named, arriving through the one artefact TASK-008's card actually promises to produce.

## Notes

- **This is the third consecutive round in which the defect was inside the previous round's fix.**
  F-161's fix contained F-167; F-167's fix contains finding 1. The pattern is stable and worth
  naming: **each round fixed the *instances* I enumerated rather than the *mechanism* they were
  instances of.** The mechanism here is that activation is inferred from a proxy (source text) while
  the evidence is taken from ground truth (build output), and the two disagree in every case where
  the proxy is present but the compiler never reached it. The recommended fix removes the proxy.
- **GC-9 re-confirmed on all new output.** No value-derived datum beyond `String(value.length)` in
  the too-short error, unchanged since r2.
- **The `.gitignore` header comments are accurate**, including the reason `app/probe-*` cannot use
  the underscore prefix — Next does treat a leading-underscore folder as private and unrouted.
  Verified against the round-3 probe route, which registered as `ƒ /probe-bff`.
- **F-155's leak reproduction was not re-run by me**; the leak roots are unchanged in this diff,
  which I confirmed by reading `SCAN_ROOTS` and the leak loop rather than by rebuilding.
- **F-157, F-159, F-162 untouched and correctly so.**

## Dependencies reviewed

No package added, no version bumped, `pnpm-lock.yaml` untouched.
