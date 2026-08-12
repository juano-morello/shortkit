# TASK-004 Product Audit r1

> Persisted verbatim by the orchestrator from the agent's return value.
> `sdlc-product-auditor` has no write tool and its rules forbid producing report `.md`
> files. Third instance today; the brief pre-empted it this time by asking for the body.

Review package: `.superpowers/sdd/plan/review-97b6143..1581338.diff` (1 commit, 9599 bytes).

## Overall verdict: CHANGES-REQUESTED

The single blocker is AC-7, which is not-met **by design** and cannot be closed by any code
change in this repo — it requires Juano's Vercel account and a git remote, both outward-facing
actions outside the implementer's authority. **No rework is owed from the implementer on
AC-7**; it is correctly left open. AC-113 (TASK-004's owned half) is fully met.

```yaml
verdict: changes-requested
ac_verification:
  - id: AC-7
    status: not-met
    evidence: >-
      no vercel.json in history prior to this diff (now present but unverifiable against a
      real deploy), no .vercel/, no VERCEL_TOKEN/ORG_ID/PROJECT_ID anywhere, no .github/
      (confirmed absent: `ls .github` -> No such file or directory), `git remote -v` returns
      nothing.
    note: >-
      Cannot be met from inside this repo under any implementation. AC-7 requires a deployed
      URL that sdlc-product-auditor verifies by hitting it; deploying needs Juano's Vercel
      account and a git remote, both his to authorise. The implementer correctly did not
      attempt it - no `vercel` CLI invocation, no remote created, no URL fabricated anywhere
      in the diff or the report. TASK-004 stays open on AC-7; this is the correct and expected
      outcome, not a defect to fix in code.
  - id: AC-113
    status: met
    evidence: >-
      apps/web/scripts/assert-no-inlined-secrets.mjs (diff lines 74-231),
      apps/web/package.json:11 ("assert:no-secrets": "node scripts/assert-no-inlined-secrets.mjs")
    note: >-
      TASK-004's owned half - the check itself - is fully built and independently verified
      (functional detector test run by the orchestrator: clean build passes exit 0, a value
      genuinely inlined into a chunk fails exit 1 naming the file and variable, unset env
      fails closed rather than passing vacuously). AC-113's own text says "fails the CI
      workflow" - no CI workflow exists yet (.github/ is absent; that's TASK-002's paths).
      Per F-084's split, TASK-004 alone cannot make CI fail; TASK-002.md:26-45 confirms it
      owns the invocation step ("run: pnpm --filter @shortkit/web assert:no-secrets").
      Stated plainly: as literally worded, AC-113 is not closed by TASK-004 alone - it is
      closed jointly once TASK-002 lands and wires the invocation. TASK-004's deliverable is
      complete and correct on its own terms.
findings:
  - severity: blocker
    kind: process
    file: (none - external dependency, not a code defect)
    summary: >-
      AC-7 requires a live deployed Vercel URL; no deployment exists and none can be produced
      from inside this repository (no remote, no Vercel project/token).
    failure_scenario: >-
      Not applicable as a code failure - this is a status-tracking blocker, not a bug.
      TASK-004 cannot reach `done` until Juano deploys.
    required_change: >-
      No code change required. Juano must create a git remote, connect/create the Vercel
      project on his account, and deploy. Once a URL exists, re-audit AC-7 by hitting it
      (200 + HTML expected per STORY-002's AC-7 text).
```

## Shipped but not asked for

- **`apps/web/.env.example`** — no AC mentions this file. Judged **warranted rather than scope
  creep**: the card's Interfaces/Produces line and the Design-round-5 amendment both obligate
  TASK-004 to "register" `NEXT_PUBLIC_API_BASE_URL`, `API_BASE_URL` and `BFF_PROXY_SECRET`.
  Real Vercel-project registration is unreachable for the same reason AC-7 is unreachable.
  `.env.example` is the closest in-repo artifact that discharges that obligation, and the
  implementer disclosed the reasoning candidly rather than silently adding a file. The root
  `.gitignore` already anticipated `.env.example` (`.env` / `.env.*` / `!.env.example`) before
  this diff, so the convention was pre-existing, just unused. Not a blocker. **If Juano
  considers documentation-only env registration out of scope for this card, that is a call for
  him, not a defect in the diff.**
- Nothing else in the diff exceeds the card's four named deliverables.
  `git diff HEAD -- apps/web/app/` confirmed empty — the temporary leak-test component and its
  import into `page.tsx` are fully reverted, matching the report's claim.

## Out-of-scope items that got built

None. The card's Out-of-scope block (apex-domain binding, landing-page content, auth screens)
has no trace in the diff. `paths: ["apps/web/**", "vercel.json"]` is respected exactly — all
four changed files fall inside it.

## Report body

**AC-7 — NOT MET.** No `vercel.json` existed before this commit (now present but unverifiable
against a real Vercel build); no `.vercel/`; no `VERCEL_TOKEN` / `VERCEL_ORG_ID` /
`VERCEL_PROJECT_ID` anywhere; no `.github/` (confirmed: `ls .github` fails); `git remote -v`
returns nothing. Genuinely unreachable from inside the repository under any implementation — it
requires Juano's Vercel account and a git remote, and deploying is his call regardless of what
code exists. The implementer's report and the diff both corroborate no attempt was made.
Recording this as NOT MET, as instructed — the correct state for TASK-004 to stay open in, not
a defect.

**AC-113 — TASK-004's half MET; the AC as literally worded ("fails the CI workflow") is not
closed by this TASK alone.** The script reads both variables from the environment, fails loudly
(non-zero, naming the variable) if either is unset or blank — closing the vacuous-pass risk the
scout flagged regardless of what TASK-002's workflow does — recursively walks `.next/static/**`,
searches file contents for the two variables' *values* (not names, correctly reasoned:
`NEXT_PUBLIC_` inlining substitutes the value and leaves the name behind), and reports the
offending file and variable name on a hit. Wired as `assert:no-secrets`, matching the card's
exact naming. This matches the orchestrator's independent functional verification. Per F-084's
split, confirmed by reading both cards, TASK-002 owns the workflow step that invokes it
(`TASK-002.md:26-45`); `.github/**` does not exist yet, so no CI workflow can fail today
regardless of TASK-004's output. TASK-004's deliverable is correct and complete on its own
terms; the STORY-level AC-113 closes only once both halves exist.

**Both env-var rules are correctly encoded in `.env.example` and readable.** Neither
`API_BASE_URL` nor `BFF_PROXY_SECRET` carries `NEXT_PUBLIC_`, and the comment block spells out
why in the terms that matter (inlining into the client bundle, what the API's constant-time
match trusts, the IP-rate-limit collapse consequence) rather than a bare rule. Both
`NEXT_PUBLIC_API_BASE_URL` and `API_BASE_URL` are set to `https://shortkit-api.fly.dev/api` —
both carry the `/api` suffix — and the comment cites the exact mechanism verified at source
(TASK-001's global prefix, TASK-029's redirect controller registered outside it), matching
`adr-0006:112-113` verbatim. A reader copying this file to `.env.local` gets both rules right
without having to go find the ADR.

**Tooling exclusions are sound and match precedent.** The `.mjs` extension keeps the script
outside `apps/web/tsconfig.json`'s typecheck `include` **by construction** (no edit needed,
unlike `apps/api/scripts/check-policies.mts`'s `.mts`, which needed an explicit exclusion per
F-133/F-135). The `/* global process, console */` directive is scoped to this one file rather
than touching `eslint.config.mjs`, which is outside TASK-004's `paths` — a reasonable,
disclosed workaround rather than a silent scope violation.

**Negative-test artifacts are fully reverted.** `git diff HEAD -- apps/web/app/` is empty and
`git diff 97b6143..1581338 --stat` shows only the four intended files changed.

No tool or path gaps encountered — everything reachable.
