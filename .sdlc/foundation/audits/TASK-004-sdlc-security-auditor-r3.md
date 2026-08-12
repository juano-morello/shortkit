# TASK-004 — sdlc-security-auditor, round 3

> Persisted by the orchestrator from the agent's return value (read-only role, as r1 and r2).
> Review package `.superpowers/sdd/plan/review-0f56cba..0f4deab.diff` (1 commit, 26178 bytes,
> 2 files). Verification ran in a scratch copy — three Next builds.

## Verdict: CHANGES-REQUESTED

All four findings are ADDRESSED. The verdict is driven by **one new major that lives inside the
F-161 fix**: the condition that activates the positive control and the tree the control searches
do not describe the same set of builds, so a correct build can red the deploy. Reproduced twice,
by building. **Nothing in this diff is exploitable by anyone.**

## Round-2 findings

| Finding | Verdict | Evidence |
|---|---|---|
| **F-161** (major) | **ADDRESSED** — option (a), all three constraints | `hasSourceReference()` (`:262`) gates activation; `SOURCE_EXCLUDED_DIRS` (`:223`) excludes `.next`, `node_modules`, `scripts` (constraint 1); the inactive path prints a `NOTICE:` explicitly disclaiming environment agreement (constraint 2); activation is recomputed per run from the live source tree (constraint 3). Findings 1 and 2 are defects *in this fix*, not a reopening of F-161. |
| **F-163** (minor) | **ADDRESSED** | `:334` fails any root contributing zero files before scanning; `perRootSummary` (`:403`) prints `.next/static (9), .next/server/app (45)`. Fail-closed ordering: the empty check returns before the leak scan. |
| **F-164** (nit) | **ADDRESSED** — cheaper fix, correctly | `BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/` (`:140`), applied only to `BFF_PROXY_SECRET` via `requireBase64Url` (`:170`). Alphabet right: `-`/`_` in, `+`/`/`/`=` out, `-` trailing in the class so literal, no padding. JS `$` is end-of-input, so a trailing newline is rejected — probed, along with leading/trailing space, embedded newline, `+=`, and non-ASCII: all rejected; standard base64 without `+//=` and a `-_`-bearing value accepted. **The escaping claim holds**: no character in `[A-Za-z0-9_-]` is touched by HTML-entity encoding, `\uXXXX` escaping in RSC payloads, or JSON string escaping. |
| **F-165** (nit) | **ADDRESSED** | Doc, check and generator now agree in characters. The generator run 500 times: **500/500** exactly 32 chars matching `^[A-Za-z0-9_-]{32}$`, zero nonconforming. Entropy floor moved from a documented 32 bytes to an enforced 192 bits — not a finding; the value is only ever compared server-side. |

**The orchestrator's reading of the gate is right.** `readRequiredValue(LEAK_TARGET_VAR, …)` is
called in `main()`'s first `try` (`:280`), before `hasSourceReference()` and before any
`collectFiles()`. A deployed secret that violates the format fails loudly at the gate — it cannot
be silently scanned-around, and cannot reach the scan in a form the matcher would miss. The
orchestrator's first probe was invalid and the script was right to reject it; **that ordering is
what makes the charset substitution for escaping-variant coverage sound.**

## New findings

```yaml
verdict: changes-requested
findings:
  - severity: major
    kind: behavior
    file: apps/web/scripts/assert-no-inlined-secrets.mjs
    line: 390
    summary: >-
      The positive control activates on ANY textual reference under apps/web but searches only the
      two browser-delivery roots, so a server-only or test-only reference reds a correct build and
      the failure message states a diagnosis that is false.
    failure_scenario: >-
      REPRODUCED TWICE BY BUILDING. (A) SERVER-ONLY REFERENCE. Added a static server component and
      a dynamic route handler, both reading process.env.NEXT_PUBLIC_API_BASE_URL without rendering
      the value. The value lands ONLY in .next/server/chunks/*.js - grep -rl under .next/static and
      .next/server/app returns NOTHING - because turbopack puts app code in .next/server/chunks and
      leaves page.js as a loader. The script, run with the IDENTICAL value the build used, exits 1:
      "value was not found ... even though source code references it ... the build ran without a
      real value for this variable, or with a different one than this check is now reading." BOTH
      STATED CAUSES ARE FALSE. (B) TEST-ONLY REFERENCE. With probes removed and a clean build, a
      single vitest spec naming NEXT_PUBLIC_API_BASE_URL - a file Next never compiles - activates
      the control and produces the same exit 1 on an otherwise untouched build. The comment at :258
      anticipates the spec case and rules it acceptable because "a false active fails closed"; that
      holds for a check whose red costs a rerun, and NOT for one chained into vercel.json's
      buildCommand, where the red blocks the deploy. THE TRIGGER IS TASK-008, the very TASK this
      fix names as its activator: its paths are apps/web/src/lib/api/** (spec files included), its
      card lists NEXT_PUBLIC_API_BASE_URL as consumed, and web-api-client.md:202 says that variable
      "is not used for anything authenticated" while ADR-0014 routes all authenticated browser
      traffic same-origin through /api/bff - so a first reference that is server-side, or that
      tree-shakes out of every client bundle, is a LIKELY shape rather than a contrived one. The
      operator meeting this red is Juano at first deploy, the message sends him to check Vercel env
      vars that are correct, and the cheapest repair left is deleting `&& assert:no-secrets` -
      which is the leak guard for BFF_PROXY_SECRET, not just the control. Same remediation-pressure
      shape as F-154, F-161 and F-166, reproduced inside F-161's own fix.
    required_change: >-
      Make the activation condition and the search scope describe the same builds. Two small
      changes: (1) for the POSITIVE CONTROL ONLY, search the whole of .next rather than the two
      delivery roots - proving environment agreement does not require the value to be
      browser-reachable, and .next/server/chunks is where server-side inlining actually lands. This
      must NOT widen the BFF_PROXY_SECRET leak scan, which is correctly bound to the two delivery
      roots. (2) Narrow hasSourceReference to non-test source - exclude *.spec.* and *.test.* - and
      match `process.env.NEXT_PUBLIC_API_BASE_URL` rather than the bare name. FLOOR if either is
      declined: rewrite the failure message to enumerate the third cause ("the reference is
      server-only or test-only and its inlined form is outside the scanned roots") and name the
      command that distinguishes it, so the person debugging is not told something false.

  - severity: minor
    kind: behavior
    file: apps/web/scripts/assert-no-inlined-secrets.mjs
    line: 262
    summary: >-
      The source scan is rooted at apps/web and skips node_modules, so a read inside a
      transpilePackages workspace package leaves the control inactive while the value really is
      inlined into the client bundle - and the NOTICE then asserts that nothing reads the variable.
    failure_scenario: >-
      REPRODUCED. apps/web/next.config.ts:6 already sets transpilePackages: ['@shortkit/contracts'],
      so that package's source is compiled through Next's loader and gets NEXT_PUBLIC_ inlining.
      Added a module in packages/contracts reading process.env.NEXT_PUBLIC_API_BASE_URL, exported
      it, consumed it from a 'use client' component in apps/web that never names the variable.
      After a build the value is present in .next/static/chunks/*.js (browser-delivered) AND in
      .next/server/app/index.html - yet the script exits 0 printing "NOTICE: no source reference to
      NEXT_PUBLIC_API_BASE_URL found under apps/web ... It activates automatically the first time
      client-reachable code reads that variable". EVERY CLAUSE OF THAT IS WRONG FOR THIS BUILD.
      This is constraint 1 arriving from the other side: constraint 1 guards against false
      ACTIVATION, and nothing guards against false INACTIVATION. Not exploitable and no leak - the
      consequence is that the CI path loses its environment-agreement proof while the log says the
      control simply has not been reached yet. Likelihood low today (packages/contracts is pure
      schema, TASK-008's client lives inside apps/web) but the mechanism is already configured.
    required_change: >-
      Either extend the source scan to the workspace packages listed in next.config.ts's
      transpilePackages, or state the limit in the NOTICE itself. The NOTICE currently names only
      the three directory exclusions and so OVERSTATES what was searched: it omits the extension
      filter and omits that the walk never leaves apps/web. Minimum: make the NOTICE say what was
      actually searched.

  - severity: minor
    kind: scope
    file: apps/web/.env.example
    line: 37
    summary: >-
      A format constraint on a TWO-SIDED shared secret is now ENFORCED on the Vercel half and
      documented only in the web app's .env.example; the normative contract for the Fly half still
      says only "set and non-empty".
    failure_scenario: >-
      rate-limit.md:104 and ADR-0014:89 require BFF_PROXY_SECRET to be set and non-empty on the API
      side and say nothing about its alphabet; there is no apps/api/.env.example at all (checked -
      the file does not exist), so the Fly side has no documented generator. Whoever sets the Fly
      half first - TASK-009, per rate-limit.md:129 - reaches for the obvious default, and the
      obvious default is `openssl rand -base64 32`, WHICH IS WHAT THIS REPO RECOMMENDED UNTIL THIS
      COMMIT and what remains in git history one `git log -p` away. Roughly 74% of such values
      contain a + or /. The result is a secret that is correct, secure, and accepted by every
      consumer except this check, which reds the Vercel BUILD - and by then the value is shared
      across two deployables, so the correct repair (rotate both sides, redeploy) is dearer than
      the wrong one (delete the chain). Same shape as F-166, one variable over. base64url is
      already the house convention for every other secret in the design (invitation-tokens.md,
      domain-provisioning.md, adr-0021), so the constraint is right - it is only recorded in the
      one place the person generating the value will not be reading.
    required_change: >-
      State the enforced format - base64url alphabet, no padding, >= 32 characters, with the same
      generator line - where the Fly half is configured: rate-limit.md's configuration section
      and/or TASK-009's card, beside assertBffProxySecretConfigured(). Orchestrator-applied, as
      with F-166.

  - severity: nit
    kind: implementation
    file: apps/web/scripts/assert-no-inlined-secrets.mjs
    line: 231
    summary: >-
      SOURCE_FILE_EXTENSIONS' comment claims it covers "file types Next.js or the test runner
      actually execute" - true only under the default pageExtensions, and nothing re-checks it.
    failure_scenario: >-
      Verified the claim holds today: next@16.3.0 defaults pageExtensions to ['tsx','ts','jsx','js'],
      all covered, and imported modules resolve through extensions the set also covers. It stops
      holding the moment pageExtensions is extended - the standard case is MDX, where a marketing or
      docs page can interpolate process.env.NEXT_PUBLIC_* and be fully client-reachable from a .mdx
      file the walk ignores. Same false-inactive consequence as finding 2, no leak, speculative
      today: @next/mdx is not a dependency.
    required_change: >-
      None now. If MDX or any pageExtensions change lands, extend SOURCE_FILE_EXTENSIONS in the same
      commit; a line in the comment saying the set tracks pageExtensions would make that obligation
      visible to whoever makes the change.
```

## Answers to the two specific questions

1. **No, the gating does not reintroduce F-156's silent green.** `vercel.json` is not in this diff
   and the tree still carries the `&&` chain, so a failed build cannot green-wash the check. What
   remains unconditionally fail-closed after gating: `BFF_PROXY_SECRET` must be set, ≥32 characters
   and base64url; **both** roots must exist **and** be non-empty. So "the check ran against nothing"
   is still impossible. One measured reduction, and it is the right one: when the control is
   inactive, `NEXT_PUBLIC_API_BASE_URL` no longer has to be set at all, where round 1 hard-failed on
   it — self-healing, because the first reference both activates the control and restores that
   requirement. The honesty of the inactive state is bounded only by finding 2's scope hole.

2. **Fourth-shape judgement.** *The empty-root check is not it* — it cannot red a correct build. Any
   app-router build emits chunks and manifests under `.next/static` and prerendered artifacts plus
   loaders under `.next/server/app` (54–55 files today); a root that goes empty is a genuine
   coverage loss, and a root that goes away is handled by the ENOENT path. No operator meets it on a
   healthy build. *The charset gate is it only through finding 3* — on its own it reds exactly one
   thing, a secret violating a format this repo now documents and that matches its own convention
   everywhere else; the pressure exists only because the other half of the secret is configured from
   documents that do not carry the constraint. **The actual fourth instance is finding 1, and it is
   inside the F-161 fix itself**: a control correct in intent, that reds a build with nothing wrong
   with it, blocks the deploy through `buildCommand`, misdirects the person debugging with a false
   diagnosis, and sits one edit from removal — with the trigger being TASK-008, the very TASK this
   fix nominates as its activator.

## Notes

- **A transient untracked file was present in `apps/web/app/` during this review.** At a 23:12
  snapshot it contained `apps/web/app/_probe-client.tsx` (133 bytes, a `'use client'` probe); by
  23:22 it was gone and `git status --porcelain apps/web/` is empty. It was **not** gitignored, so
  it would have shown as untracked had it survived. Flagged only because something was mutating
  `apps/web/` during the review, and the orchestrator's "empty" evidence and this snapshot disagree
  about a ten-minute window.
- **`.next/server/chunks` remains correctly out of the leak scan.** Finding 1 asks to widen only the
  positive control's search there. Chunks are never browser-delivered, and widening the
  `BFF_PROXY_SECRET` scan to them would red on any legitimate server-side use of the secret — which
  is exactly what TASK-012 will write.
- **GC-9 re-confirmed on the new output paths.** The two new failure messages print a directory path
  and a variable name respectively; the charset error deliberately does not echo the offending
  value. The only value-derived datum printed anywhere is still `String(value.length)`, which fires
  only for a value already too short to be a real secret.
- **F-157, F-159, F-162 untouched and correctly so.**

## Dependencies reviewed

No package added, no version bumped, `pnpm-lock.yaml` untouched. Nothing enters the deploy tree that
was not already reviewed in r2.
