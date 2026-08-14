---
id: TASK-010
story: STORY-003
epic: EPIC-001
title: Prove the stub-drift gate is no longer vacuous
status: todo
owner_slot: sdlc-implementer-backend
depends_on: [TASK-007]
paths: [".github/scripts/assert-stub-drift.mjs"]
contracts: []
test_files: ["pnpm assert:stub-drift (quality gate step, run in CI's quality job)"]
acceptance: [AC-36]
rework_count: 0
---

## Intent

**Marked config chore.** The stub-drift gate currently compares zero pairs. A source file now
exists at an enforced stub's path, so make the gate print what it compared and confirm it is
actually gating.

## Approach

`.github/scripts/assert-stub-drift.mjs` compares each surviving design stub with the source
file at the same path, on **exported shape**: it fails when a declaration the stub exports is
missing from the source or has a different signature. Bodies, comments, declaration order,
interface member order, union order, parameter names and `async` are all excluded, because a
check that fires on those is a check nobody keeps green.

Its `ENFORCED_PREFIXES` is `['apps/web/**']` today, and F-403 records that this "currently
compares zero gating pairs" because that stub had no source. TASK-007 lands
`apps/web/src/lib/session/session.ts`, which is the second of F-403's two triggers. **The
gate starts defending on its own the moment that file exists** — the ordinary outcome of this
TASK is that nothing in the script changes and the run reports one compared pair.

What this TASK must do is make that verifiable: the run prints the number of gating pairs it
compared, and a run comparing **zero** pairs is reported as such rather than as a clean
green. If the script already prints both facts, confirm it and change nothing.

**Do not widen `ENFORCED_PREFIXES` to `['']` here.** The roadmap's condition for that is the
retirement of the logger stub, and F-404 records that
`apps/api/src/observability/logger.ts` is **really drifted** against its stub: the stub
exports `REDACT_PATHS`, `createLogger`, `CORS_ENABLED` and `HSTS_MAX_AGE_S` and the source
exports none of them. `REDACT_PATHS` and `createLogger` are the known F-249 supersession;
`CORS_ENABLED` and `HSTS_MAX_AGE_S` are **not obviously covered by it**. Widening now would
either turn the gate red on a divergence already agreed to, or force an allowlist entry on
day one — which is one of the costs ADR-0039's alternative 1 lost on.

**Do not weaken the script**, and do not touch `gate`. The gate runs as a **step inside the
`quality` job**, which is already named in `gate`'s `needs`, its `env:` and its assertion
loop, so de-gating is one line — deleting the step — and needs no wiring kept in step across
three places. That property is the reason it is a step and not a fourth job.

## The gate cannot see this initiative's stubs — added 2026-08-14, F-087

**This card's premise is that the gate defends something, and for this initiative's stubs it
defends nothing.** Verified: `assert-stub-drift.mjs:74` hardcodes `STUB_ROOT` to
`.sdlc/foundation/design/stubs` and `:99` sets `ENFORCED_PREFIXES` to `['apps/web/']`. Neither
reaches `.sdlc/identity-membership/design/stubs/**`.

Six stubs were frozen at this initiative's Design gate and land as TASK-002's first commit. **In
wave 1 both auditors had to diff the shipped code against those stubs by hand**, and found
`auth/index.ts` byte-identical and `members/index.ts` differing only in the two owned function
bodies. That comparison exists only in two audit files; CI never ran it and would not have
noticed drift.

Juano ruled at the wave-1 fix round: **`STUB_ROOT` covers the active initiative**, and this card
owns the change since it already owns the file. Note the cost he accepted — this is **wave 5**, so
waves 1 through 4 ship stubs no gate compares, and the hand-diffing continues until then.

Widening `STUB_ROOT` is **not** the same as widening `ENFORCED_PREFIXES`, which stays
`['apps/web/']` for the reasons already on this card — F-404's really-drifted logger stub is why.

## Out of scope for this TASK

Widening `ENFORCED_PREFIXES`. Retiring or editing any stub under `.sdlc/foundation/design/stubs/**`.
Anything about the stale `apps/api` mail stub (F-401) — mail is item 1b, and the mail stub
has no source to compare against in this initiative. Any change to `.github/workflows/ci.yml`.
Any application code.

## Interfaces

**Consumes**

From TASK-007: `apps/web/src/lib/session/session.ts` — the source file that gives the
enforced prefix a pair to compare, with the exported names and signatures the stub declares
(`useSession`, `requireAuth`, `setSessionCookies`, `clearSessionCookies`, `refreshAccessToken`).

From the repository (shipped): `pnpm assert:stub-drift` — root script, `node
.github/scripts/assert-stub-drift.mjs`; `ENFORCED_PREFIXES` inside that script.

**Produces**

- `.github/scripts/assert-stub-drift.mjs` — a run that reports the count of gating pairs it
  compared, and reports a zero-pair run as zero rather than as a pass. `ENFORCED_PREFIXES`
  is unchanged at `['apps/web/**']`.
