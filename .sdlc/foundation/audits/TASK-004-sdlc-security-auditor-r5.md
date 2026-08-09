# TASK-004 — sdlc-security-auditor, round 5 (final)

> Persisted by the orchestrator from the agent's return value (read-only role, r1–r5).
> Package `.superpowers/sdd/plan/review-3f1e429..fad4d28.diff` (1 commit, 36231 bytes).
> Verification ran in a scratch rsync copy — **six Next builds**. The real repo was never built in.

## Verdict: CHANGES-REQUESTED

All three round-4 findings **ADDRESSED**, F-171 with the required change rather than the floor, and
the source-scan machinery is genuinely gone. The mechanism is **mostly** closed — the half three
rounds of narrowing never touched is closed for good. The other half moved and shrank: **activation
is still inferred, not observed** — from the variable's *name as text* rather than from a *read*.
Reproduced a false red on correct code with a correct environment in two shapes, one of which does
not depend on source maps at all. The remedy is one string constant, verified across five builds.

**Nothing in this diff is exploitable by anyone.** True for five rounds and still true.

## 1. Round-4 findings

| Finding | Verdict | Evidence |
|---|---|---|
| **F-171** (major) | **ADDRESSED** — required change, not the floor | All six source-scan symbols deleted, zero remaining references repo-wide (grep confirmed independently). Three-way discriminator at `:392`–`:467`. **Proved the branch the orchestrator asked for and two more**: read compiled + build unset + check with a value → `EXIT=1` with the mismatch message; same but check's own var unset → `EXIT=1` with the "a compiled reference was found, so this check needs a real value" suffix; build with value A + check with value B (the wrong-value case, riding entirely on `.js.map` `sourcesContent` — the name appears in **exactly one file**, the SSR chunk's map) → `EXIT=1`. F-171's own reproduction now yields NOTICE and exit 0. |
| **F-172** (minor) | **ADDRESSED** | The false claim is gone from both places it lived (`:35`–`:49` header, `:111`–`:114` at `SCAN_ROOTS`), replaced with the reachability rationale, conclusion unchanged. The leak failure message now points a reader at it. One imprecision in the replacement — finding 3. |
| **F-173** (nit) | **ADDRESSED** | Both patterns namespaced to `tk004-scratch-probe-*`; `app/probe-*` can no longer swallow a future liveness route. No plausible product filename collides with a TASK-id-prefixed name. |

## 2. Has the mechanism moved, or is it closed?

**It shrank by most of its surface, and what remains is one specific, nameable proxy.**

Now genuinely *observed*: **build-graph membership**. That was the whole of F-161/F-167/F-171 —
source text standing in for "the compiler reached this". It cannot come back, because there is no
source scan for it to come back in. Real progress, and the larger half.

Still *inferred*: **that a compiled read happened**, from **the variable's name appearing as text
under `.next`**. The name reaches `.next` by four routes, only one of which is a read:

1. an uninlined read — turbopack emits `process.env.NEXT_PUBLIC_API_BASE_URL` literally when the
   build had no value to substitute. **This is the signal.**
2. a source map's `sourcesContent`, which embeds the **entire original file** of every compiled
   module — comments included.
3. a source map's `names` array, carrying the variable as a standalone minifier token.
4. any **string literal** naming the variable in a compiled module — surviving into the client
   chunk *and* the prerendered HTML, **with no source map involved**.

Routes 2 and 4 disagree with the signal, and both were reproduced. **The proxy is now `text
presence` standing in for `a read`, where before it was `source text` standing in for `build-graph
membership`.** Strictly smaller, same family, and — unlike the previous three rounds — closable by
one constant rather than another exclusion rule.

## 3. Exploitability

**Nothing.** No attacker, no reachable path, no exposure anywhere in this diff. The leak scan was
re-proved against the delivered script by building rather than reading: server component reads
`BFF_PROXY_SECRET`, passes it as a prop to a `'use client'` component — the value lands in
`index.html`, `index.rsc` and both `.segment.rsc` files, and the script reds naming all four.
**F-155's guarantee holds on this commit.**

## 4. Findings

```yaml
verdict: changes-requested
findings:
  - severity: major
    kind: behavior
    file: apps/web/scripts/assert-no-inlined-secrets.mjs
    line: 398
    summary: >-
      Activation matches the BARE variable NAME anywhere under .next, so a compiled module that
      MENTIONS NEXT_PUBLIC_API_BASE_URL without reading it - a comment, or a user-facing error
      string - activates the control, finds no value, and reds a build with correct code and a
      correct environment. This is F-167 constraint 2 (match the full process.env.X expression,
      not the bare name) silently dropped in the move from source to build output.
    failure_scenario: >-
      REPRODUCED BY BUILDING, twice, on the delivered script at fad4d28, with the build's
      environment and the checker's environment both holding the correct value.
      (a) SOURCE-MAP SHAPE - a compiled 'use client' component whose only mention is a comment
      ("configured through NEXT_PUBLIC_API_BASE_URL; this component does not read it yet"). Name
      lands in the SSR chunk's .js.map sourcesContent; value lands nowhere. Exit 1: "the build ran
      without a real value ... or with a different one". BOTH STATED CAUSES FALSE.
      (b) STRING-LITERAL SHAPE, which does NOT depend on source maps and so survives every
      mitigation offered for the caveat at :169 - a component rendering "The API is not configured.
      Set NEXT_PUBLIC_API_BASE_URL and redeploy." The name lands in .next/server/app/index.html,
      .next/static/chunks/*.js AND the SSR chunk; the value lands nowhere; exit 1 with the same
      false diagnosis. That sentence is what an error surface under TASK-008's declared path
      apps/web/src/components/errors/** says, and this repo's house style is heavily commented with
      exactly the comment shape (a) uses. The trigger window is "some compiled module names the
      variable in text while no compiled module reads it" - precisely the interim TASK-008 creates,
      since its card puts every screen that would import the api client out of scope while its
      error components can be wired into app/ directly.
    required_change: >-
      Match the full expression, not the bare name - restore F-167 constraint 2 on the build-output
      side. MEASURED ACROSS FIVE BUILDS, all states preserved or fixed: mention-only comment ->
      NOTICE exit 0 (was exit 1); mention-only string -> NOTICE exit 0 (was exit 1); real read +
      build unset + check with value -> FAIL unchanged (the literal process.env.X is emitted into
      the SSR chunk itself, so this branch does NOT become source-map-dependent); real read + build
      set + same value -> OK unchanged; real read + build set + DIFFERENT value -> FAIL unchanged.
      Residual worth one comment line: a destructured `const { X } = process.env` read would not
      match - but turbopack does not inline destructured process.env access either, so no value
      lands and NOTICE is the CORRECT outcome, not a miss.
    ship_judgement: >-
      I would NOT ship with this open. Not because it is dangerous - nothing leaks - but because it
      is the fifth appearance of one failure shape whose damage is entirely to the guard's
      credibility, the remedy is a single string constant, and I have already measured the
      replacement against every branch. If you rule to ship anyway, the mitigating facts are real:
      today's tree contains no NEXT_PUBLIC_ string anywhere under .next (verified), so it cannot
      fire now, and the fix stays one line whenever it does.

  - severity: minor
    kind: behavior
    file: apps/web/scripts/assert-no-inlined-secrets.mjs
    line: 383
    summary: >-
      A value match ALONE prints "positive control confirmed", with no requirement that the name
      also appear and no minimum length on the value - so any incidental occurrence of the value
      string under .next claims a proof the run does not have.
    failure_scenario: >-
      readRequiredValue is never reached on the passing path and there is no analogue of
      MIN_SECRET_LENGTH, which exists on the leak target for exactly this reason (F-160).
      CONCRETE, MEASURED ON TODAY'S REAL TREE: with NEXT_PUBLIC_API_BASE_URL="/api", the string
      "/api" already appears in 14 files under apps/web/.next, several outside cache/ - so
      valueFound is true on the first file, the loop short-circuits, and the script prints
      "positive control confirmed" for a build that never read the variable. A same-origin relative
      base URL is not hypothetical: ADR-0014 has the browser calling only this app, never Fly,
      which is the direction TASK-012's proxy points. The same holds for a hardcoded fallback
      literal (F-174) - now the ONLY thing needed to claim "confirmed". The diff's contribution is
      the WORDING: before, an unproven control printed an honest NOTICE; now it can print a
      positive claim.
    required_change: >-
      Either require nameFound alongside valueFound before printing "confirmed" - cleanest, but it
      makes the whole control source-map-dependent and gives up the tolerance the ordering was
      designed for, and I do NOT recommend it - or keep the ordering and put a floor under the
      needle: run the control value through readRequiredValue with a minLength before searching,
      and say in the OK message that a value match alone is evidence the value is present, not
      evidence it got there through this variable.
    ship_judgement: >-
      I WOULD ship with this open. It cannot produce a red, it cannot hide a leak, and the value it
      turns on is configuration TASK-008/TASK-012 will set, not something TASK-004 controls. The
      honest framing is that it is a claim-strength defect in a diagnostic, not a defect in a guard.

  - severity: nit
    kind: implementation
    file: apps/web/scripts/assert-no-inlined-secrets.mjs
    line: 43
    summary: >-
      F-172's replacement rationale is itself slightly false in the same direction as the one it
      replaced - .next/server/app is not "exactly the artifacts an unauthenticated request can
      retrieve"; it also holds compiled server-only route handlers and their source maps.
    failure_scenario: >-
      MEASURED: a route handler builds to .next/server/app/<segment>/route.js plus route.js.map,
      route.js.nft.json and route_client-reference-manifest.js - all inside a leak-scan root, none
      retrievable by any request. So a red naming a route.js would carry the claim "reachable by
      anyone right now" when it is not. It would still be a real baked-in secret, so the red is a
      TRUE POSITIVE - only the explanation is wrong. Cost is one more overstated rationale in the
      one file where three rounds have been spent correcting overstated rationales.
    required_change: >-
      One clause: these two roots are a SUPERSET of what an unauthenticated request retrieves - all
      the browser-reachable output plus the compiled server code colocated with it - so a red here
      is at minimum a baked-in secret and usually a directly reachable one. Conclusion unaffected.
    ship_judgement: >-
      I WOULD ship with this open. The direction is harmless: the scan covers MORE than the comment
      claims, not less, and every red under these roots is a genuine defect either way.
```

## Notes

- **On the deliberate ordering — both choices are right, and both were verified.** Value-before-name
  means a disabled server source map degrades a pass toward less certainty and can never manufacture
  a false fail. **Worth recording plainly for adjudication, because the implementer's phrasing
  understates it**: with server source maps disabled, the *wrong-value* case (build with A, check
  with B) loses its only evidence and degrades from **red to green-with-a-NOTICE** — a missed real
  mismatch, not merely a less certain pass. A config nobody has made, not Next 16's default, failing
  in the direction of silence rather than false alarm. Acceptable, documented, ship with it.
- **Four rounds of "the defect was inside the previous round's fix" — this round is different in
  kind, and that matters for the ruling.** Rounds 2 and 3 added an exclusion to a scan that should
  not have existed. Round 4 deleted the scan. The residual is not another instance hiding behind
  another exclusion; it is **one constant that was correct in round 3 and got dropped in transit**,
  and putting it back is verified not to disturb any branch. One line for the retro: **the fix was
  structurally right and lost one narrowing in the move.**
- **F-174 stays valid and gets more load-bearing** under the new logic — a hardcoded fallback is now
  the only thing needed to make the control claim "confirmed". Already on TASK-008's card.
- **F-163's empty-root handling and F-155's two-root guarantee both re-verified** against the
  delivered script this round, the latter by building.
- Nothing outside `apps/web/**` touched; two files changed, matching the report.

## Dependencies reviewed

No package added, no version bumped, `pnpm-lock.yaml` untouched.
