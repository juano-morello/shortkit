# TASK-004 — sdlc-security-auditor, round 2

> Persisted by the orchestrator from the agent's return value. Same write constraint as round 1
> (Read, Bash, WebFetch, WebSearch only). Review package
> `.superpowers/sdd/plan/review-1581338..0f56cba.diff` (1 commit, 21933 bytes).
> Verification ran in a fresh clone — a cold filtered install and four builds. The real repo is
> untouched; `git status --porcelain` shows only `.sdlc/` orchestrator state.

## Verdict: CHANGES-REQUESTED

Not because the fix is wrong — the blocker and all three majors are genuinely closed, each
confirmed by building rather than reading. The verdict is driven by F-161's resolution (a code
change under the recommended option) plus one new minor. **Nothing in this diff is exploitable by
anyone.**

## Round-1 findings

| Finding | Verdict | Evidence |
|---|---|---|
| **F-155** (blocker) | **ADDRESSED** | Round-1 reproduction rebuilt in a fresh clone (server component → `'use client'` prop, `openssl rand -base64 32` secret): the guard now exits 1 naming all four `.next/server/app` artifacts. Per-root absence verified separately — `mv .next/server/app` away → `FAIL … does not exist`, exit 1; same for `.next/static`. Neither root is skipped. |
| **F-156** (major) | **ADDRESSED** | `vercel.json:5` chains `&& pnpm --filter @shortkit/web assert:no-secrets`; `&&` short-circuits so a failed build never green-washes the check, and `pnpm --filter` sets cwd to `apps/web` so the script's `process.cwd()`-relative roots resolve. Positive control is a hard `exitCode = 1`, not a warning. See F-161. |
| **F-154** (major, joint) | **ADDRESSED — anti-reintroduction ask met** | `LEAK_TARGET_VAR = 'BFF_PROXY_SECRET'` (`:96`) carries a 14-line comment naming the ruling, the reproduction, the reason (`API_BASE_URL` is public Fly topology) and the failure mode of re-adding it. A future reader who wants to "fix" it back hits that first. `.env.example:13-19` and `:22-27` state it from the other direction; the card's amendment block is the third copy. **This is the durable form; no residual concern.** |
| **F-158** (minor) | **ADDRESSED — and verified the thing the implementer's check could not** | The implementer's `pnpm install` printed "Already up to date" against a fully-populated tree, which proves nothing about a cold Vercel install. Cloned to a scratch dir with no `node_modules`: `pnpm install --frozen-lockfile --filter '@shortkit/web...' --offline` → 269 packages, `apps/api/node_modules` **absent**, then `pnpm --filter @shortkit/web build` → exit 0 **including the `Running TypeScript` step**, which needs root-level `@types/node`. pnpm still installs the workspace-root project's dependencies under `--filter`, so nothing the build needs goes missing. `@shortkit/contracts` resolves and transpiles. `@swc/core` is gone from the deploy tree. **No Vercel-only breakage.** |
| **F-160** (nit) | **ADDRESSED as specified**, one measured residual — finding 2. `MIN_SECRET_LENGTH = 32` enforced; `matchesValue` searches the `JSON.stringify` form; `.env.example` states a format. The escaped-form search **earned its keep**: in the special-character test the `.rsc` twins matched *only* through the JSON-escaped form. |

## F-161 — judgement: take (a), conditional activation

**Take (a). Do not take (c).**

Context that changes the cost calculus: **F-156 had two halves protecting different paths.** The
`buildCommand` chaining makes build/check environment agreement **structural** in the deploy path
— one process, one environment, nothing left to prove. The positive control is the belt for the
*CI* path, where TASK-002 may build in one step and check in another with different env, which is
where the silent-green actually lives. So the current arrangement pays the control's entire cost
on the one path that already has the guarantee by construction, and pays it as a hard deploy
failure.

**(c) accept — argue against.** Its safety rests on an ordering nobody has committed to. The
moment Juano creates the Vercel project — *the entire remaining purpose of TASK-004, its one open
AC* — the first deploy fails on a control correctly reporting "nothing here proves the environment
is wired". The person debugging that red is Juano, at the moment he wants a URL, and the cheapest
repair in reach is deleting `&& assert:no-secrets` from `buildCommand`. **That is the exact
remediation-pressure failure mode F-154's ruling just spent a round eliminating, reproduced on the
other variable.** Making a control that blocks your own open AC the default state is
self-defeating.

**(b) activate in TASK-008 — strictly worse than (a).** It ships the control dormant, and a
dormant control is one that has never fired. Turning it on becomes a cross-TASK obligation with no
enforcement, on a card whose author has no reason to care about it. (a) reaches the same activated
state automatically, on the same trigger, with no obligation to drop.

**(a) conditional on a source reference — take this.** It is a deviation from the round-1 wording,
**and the wording was mine to get wrong**: I specified "assert the value IS present" assuming a
source reference already existed, and I did not check. The control's premise is genuinely
conditional — "this variable is inlined somewhere, so its absence is evidence of mismatch" — and
stating the premise is not weakening the check. Roughly fifteen lines, plus three constraints that
are **not optional** if it is to stay honest:

1. **The source scan must exclude the script itself.** `assert-no-inlined-secrets.mjs` mentions
   `NEXT_PUBLIC_API_BASE_URL` twice in its own header (`:24`, `:111`). A naive `grep -r apps/web`
   matches it, the control re-enables itself immediately, and you are back to today's failure with
   a layer of indirection on top. Exclude `.next/`, `node_modules/` and `scripts/`; scan source
   only.
2. **The inactive state must be loud in the output.** Today's success line reads
   `positive control confirmed` — in the inactive state that would be a lie. It must read as a
   notice: no source reference found, build/check environment agreement is **not** proven by this
   run.
3. **It must fail closed the instant a reference appears** — automatic under (a), and it means
   TASK-008 gets the red at the moment it can actually fix it.

Residual risk under (a): between now and TASK-008 the CI path has no env-agreement proof. That is
the pre-F-156 status quo, and the deploy path — the one that publishes — keeps its structural
guarantee regardless.

## New findings

```yaml
verdict: changes-requested
findings:
  - severity: minor
    kind: behavior
    file: apps/web/scripts/assert-no-inlined-secrets.mjs
    line: 211
    summary: >-
      A scan root that exists but is EMPTY passes green, and the success line still names it as
      covered. F-155's vacuous pass is closed for an absent root and open for an empty one.
    failure_scenario: >-
      REPRODUCED. Against a build where the positive control passes (TASK-008 simulated with a
      client component reading NEXT_PUBLIC_API_BASE_URL), each root was emptied in turn while
      leaving the directory in place. Both runs exit 0 and print "OK: checked N file(s) across
      .next/static, .next/server/app" - naming both roots as covered when one contributed nothing:
      10 files with .next/server/app emptied, 45 with .next/static emptied, against 55 for the
      intact build. The per-root counts that would expose this are not printed. F-155's
      required_change was that a missing root must not be silently skipped "or the widening
      re-creates the vacuous pass one level down" - absent is handled, empty is not, and they are
      the same shape. The realistic trigger is not an attacker but a NEXT.JS LAYOUT CHANGE: the
      roots are hardcoded internal paths, and a version that relocates prerendered output while
      still creating .next/server/app degrades this control to .next/static-only coverage - i.e.
      silently back to the state F-155 was filed against - with a green log asserting otherwise.
      A renamed root is handled correctly (the old path goes absent and reds); an emptied one is
      not.
    required_change: >-
      Fail when any root contributes zero files, with the same message shape as the absent-root
      path, and print the per-root file count in the success line so partial coverage is visible
      in a deploy log rather than inferable only by rebuilding.

  - severity: nit
    kind: behavior
    file: apps/web/scripts/assert-no-inlined-secrets.mjs
    line: 181
    summary: >-
      The escaped-form search covers JSON quote/backslash escaping but not the HTML-entity and
      < escaping Next applies in prerendered HTML, so the one browser-delivered file is the
      one that can be missed.
    failure_scenario: >-
      REPRODUCED with BFF_PROXY_SECRET='PROBE<SECRET>&AMP"QUOTE-0123456789ABCDEF' (40 chars,
      passes the length gate) leaked via a server-component prop. The secret lands in
      .next/server/app/index.html in two escaped forms - HTML entities in the markup and
      <-style escaping in the embedded RSC script - and matchesValue catches NEITHER:
      index.html is ABSENT from the FAIL list. The run still reds, but only because the standalone
      .rsc twins escape as plain JSON and are caught by the JSON.stringify pass. So the miss is
      currently masked by a sibling artifact rather than by the matcher, and the failure output
      UNDER-REPORTS which files leak, which misleads whoever remediates. Low likelihood by design
      - the documented base64 format contains no character that gets escaped, and a plain
      `openssl rand -base64 32` secret matches verbatim in every artifact. The code comment at
      :175-179 is honest that coverage is partial; this records exactly where the boundary falls.
    required_change: >-
      Either add the HTML-entity and \uXXXX renderings alongside the JSON form, or - cheaper and
      more durable - constrain the value at the gate: reject a BFF_PROXY_SECRET containing any
      character outside the base64url alphabet, so no escaping can ever apply. The second also
      makes .env.example's stated format enforced rather than advisory.

  - severity: nit
    kind: behavior
    file: apps/web/.env.example
    line: 36
    summary: >-
      The documented secret format, the enforced check and the recommended generator disagree with
      each other in three ways.
    failure_scenario: >-
      The comment says "base64url, at least 32 bytes"; MIN_SECRET_LENGTH enforces 32 CHARACTERS
      (~24 bytes of base64-encoded entropy), so a value satisfying the check can violate the
      documented floor; and the recommended generator `openssl rand -base64 32` emits STANDARD
      base64, whose + and / are not in the base64url alphabet the same line requires. No attack -
      24 bytes of entropy is not brute-forceable and the API only ever compares the value - but the
      charset half is what the finding above depends on, and a generator that contradicts its own
      stated format is what gets copy-pasted.
    required_change: >-
      Pick one and make the three agree: state the minimum in the same unit the check enforces, and
      either recommend a base64url generator or drop the "base64url" wording in favour of "base64".

  - severity: nit
    kind: behavior
    file: vercel.json
    line: 5
    summary: >-
      Chaining a fail-closed check into buildCommand means BFF_PROXY_SECRET must be registered for
      Preview and Development too, not just Production, or every non-production deploy fails.
    failure_scenario: >-
      The script hard-fails when BFF_PROXY_SECRET is unset, which is the correct posture and was
      the round-1 ask. But Vercel scopes project environment variables per environment, and the
      common default is to register a secret for Production only. Every preview deploy then dies at
      "BFF_PROXY_SECRET is not set" in the build step, on a branch with nothing wrong with it. Same
      remediation-pressure shape as F-154 and F-161: the person unblocking previews reaches for the
      cheapest cut, which is the `&& assert:no-secrets` chain. Operational rather than exploitable,
      and worth recording only because nothing in the repo currently says it - the card's
      env-registration section names the three variables but not their scope.
    required_change: >-
      Record on TASK-004.md, next to the variable registrations, that all three must be set for
      Production, Preview and Development, and that Preview may use a distinct throwaway
      BFF_PROXY_SECRET as long as the Fly side accepts it.
```

## Answers to the three specific questions

1. **The widened, extension-filter-free walk.** No false-positive surface I could produce, and I
   tried the one I most expected. **Hypothesis: edge-runtime env inlining** — Next historically
   substituted `process.env.*` at build time for edge bundles, which would put a legitimately
   server-side `BFF_PROXY_SECRET` into `.next/server/app/<route>/route.js` and red a correct build.
   **It does not reproduce on Next 16.3 with turbopack**: built a route handler with
   `export const runtime = 'edge'` reading the secret, and a Node-runtime twin, and `grep -r` found
   the value nowhere under `.next` at all. Dropping that finding; noting it because **TASK-012 will
   pick a runtime for the BFF proxy** and this was the plausible objection. Otherwise the roots hold
   no build-time-substituted values — only manifests, `.nft.json` traces and server source maps.
   No performance cliff: 912K across 55 files, scaling with route count rather than `node_modules`;
   `.next/server/chunks` is correctly out of scope since it is never browser-delivered.
   **Missing root, per root: both fail loudly. Renamed root: correct. Emptied root: silent green —
   finding 1.**
2. **`MIN_SECRET_LENGTH` and the escaped form.** Enforced, and now matters, with the unit/charset
   mismatch above. The escaped-form search does **not** cover the RSC-payload escaping described in
   round 1. It does cover quote/backslash escaping, which is what the standalone `.rsc` files use,
   and in the test that is the only reason the run went red. Finding 2 — cheaper fix is a charset
   gate rather than more escaping variants.
3. **GC-9, re-confirmed across every new output path. Clean.** All five `console.*` sites read. The
   leak message (`:251`) prints `${name} in ${root} (${relative path})` — names and paths, never the
   value. The positive-control failure (`:270`) prints only the variable name, which is public
   anyway. The per-root ENOENT message (`:216`) prints an absolute directory path. The success line
   (`:282`) prints a count and root names. **The only value-derived datum printed anywhere is
   `String(value.length)` in the minimum-length error at `:148` — and it only fires for a value
   already under 32 characters, i.e. by construction not a real secret.**

## Notes

- **The report UNDERSTATES what was delivered on F-157.** `TASK-004-report.md` says the ceiling
  statement was not attempted; the script header at `:120-124` in fact carries a correct one
  ("KNOWN CEILING, NOT FIXED HERE … produces no on-disk `.next` artifact at all, so this scan
  cannot see it in principle"), matching the card's amendment block. **TASK-004's half of F-157 is
  done.** Discrepancy in the safe direction, flagged so the routing does not chase a statement that
  already exists.
- **F-159** (web-origin security headers) is routed to `sdlc-architect` and correctly untouched.
  `vercel.json` still sets no `headers` — unchanged from r1, no new exposure introduced.
- One limit on the F-158 verification: the cold install used `--offline` against a warm store. That
  affects fetching, not resolution or linking, so the tree is what Vercel would produce — but I
  cannot verify Vercel's own build image, or a dashboard Root Directory override. The implementer's
  r1 caveat still stands.

## Dependencies reviewed

No package added, no version bumped, `pnpm-lock.yaml` untouched — consistent with
`--frozen-lockfile`. The diff does change *what gets installed at deploy time*: `@swc/core` is now
absent from the Vercel build environment, closing F-158's exposure as specified (verified by
inspecting the cold-install tree — only `@swc/helpers`, a `next` transitive with no install script,
remains). Residual, not worth a finding: `esbuild@0.28.1` is still installed and still permitted to
run its install script by `allowBuilds`, because it arrives through `@shortkit/web`'s own `vitest`
devDependency rather than through `apps/api`. A `--prod` install would remove it but would also
remove `typescript` and `@types/react`, which `next build` needs. **The exposure is inherent to
building a TypeScript Next app on Vercel, not something this TASK left on the table.**
