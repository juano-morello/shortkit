---
id: ADR-0018
slug: launch-core
title: Server-measured latency, a 100 RPS median-of-three gate on every PR, and a 500 RPS run on demand
status: accepted
supersedes: null
date: 2026-08-04
---

## Context

`refinement.md` records the risk plainly: shared CI runners are noisy and rate-limited,
a benchmark that fails at random is worse than no benchmark, and SC-2 assumes a CI gate
exists. If Design cannot produce one, SC-2's wording gets revisited at a gate rather
than quietly weakened. AC-64 makes the flakiness requirement testable: three
consecutive runs against an unchanged build must produce the same verdict.

Three things make 500 RPS in CI unreliable, and they are different problems.

The load generator competes with the application for the runner's four vCPUs. A
Node-based generator loses that fight; a Go or Rust one mostly does not.

Client-observed latency on a shared runner includes scheduler jitter and, if the target
is deployed, internet variance. SC-2 asks for **server-side** p99. Measuring
client-side and calling it server-side is the error that makes the number both noisy
and wrong.

At 500 RPS for 60 seconds, each run costs about 30,000 Upstash commands plus Neon
compute. Per push, per branch, that is real money against GC-3's $25 ceiling.

## Decision

**A CI gate exists.** Three layers, and the artifact says which number means what.

**Layer 0: the server measures itself.** The redirect handler wraps its work in
`process.hrtime.bigint()` and emits `Server-Timing: app;dur=<ms>` on every response.
The load harness aggregates that header into its p50, p95 and p99. Client-side timing
is reported separately as `clientP99` and is never gated on. This removes runner
scheduler noise and network variance from the gated number, which is both more correct
against SC-2's wording and dramatically less flaky.

**Layer 1: the PR gate.** Job `performance` on every pull request.

- k6 as the generator, an `ubuntu-latest` runner, the API and a `redis:7-alpine` and
  `postgres:17-alpine` as service containers. Local Redis, not Upstash: the gate
  measures application overhead on the cache-hit path, and Upstash's round trip is
  network variance plus per-command cost.
- 100 RPS, 30 seconds measured, after a 10 second warm-up that is excluded.
- **Three runs, gate on the median p99.** One outlier cannot fail the build. This is
  what makes AC-64 pass, and it is the single most important choice here.
- Fails when the median `serverP99` exceeds `ciP99BudgetMs` from `baseline.json`.
- Total runtime about 2 minutes and 20 seconds. Zero Upstash commands. Zero marginal
  cost beyond runner minutes, which are free for a public repository.

**Layer 2: the SC-2 run.** Job `performance-full`, on `workflow_dispatch` and on a
weekly `schedule`.

- 500 RPS, 60 seconds measured, against the deployed Fly machine with the real Upstash
  cache. This is the configuration SC-2's sentence describes.
- Fails when `serverP99` exceeds `targetP99` from `baseline.json`, which
  AC-62 caps at 25.
- Roughly 30,000 Upstash commands per run. Weekly plus occasional manual runs is a few
  cents a month.

**Every CI job installs with a frozen lockfile, and two jobs audit.** Added
2026-08-04 (F-016), extended 2026-08-04 (F-049, F-055). Grepping the design, the plan,
TASK-001 and TASK-002 for `audit`,
`dependabot`, `cve`, `lockfile` or `frozen-lockfile` returned nothing, on a stack that
puts a young auth library on the critical path.

| Job | Added step |
|---|---|
| every job | `pnpm install --frozen-lockfile` |
| `quality` | `pnpm audit --prod --audit-level moderate` |
| `dependencies`, weekly `schedule` only | `pnpm audit --audit-level moderate` |

Without `--frozen-lockfile`, resolution can drift between the tested tree and the
deployed one. The `quality` audit runs `--prod` so a dev-only advisory in Vitest or
`unplugin-swc` cannot block a merge.

**The threshold is `moderate`, not `high`.** Lowered 2026-08-04 (F-049). `moderate` is
the band that carries session fixation, open redirect and timing leaks, which is the
band an auth library's advisories land in, and this ADR puts `better-auth` on the
critical path. The security auditor ran `pnpm audit --audit-level low` across the whole
tree, dev dependencies included, and got zero advisories, so lowering the merge gate
blocks nothing that passes today.

**A `dependencies` job audits the whole tree weekly.** Added 2026-08-04 (F-049). Every
dependency is exact-pinned and every job installs `--frozen-lockfile`, so an audit that
only runs on push and pull request cannot see an advisory published against a version
already merged. Nothing in the tree changes, so nothing triggers a run. The weekly
`schedule` is the only thing that re-asks the question against unchanged code. It drops
`--prod` because a moderate advisory in a dev tool is worth knowing about when it is not
blocking a merge. A failed scheduled run is the notification: GitHub emails the repo
owner, and no issue-filing script or `issues: write` permission is needed.

**Every dependency is pinned to an exact version.** Amended 2026-08-04 (F-055, ruled by
Juano). TASK-001 pinned all four manifests exactly, against this ADR's earlier wording
that only `better-auth` needed it. Juano kept the stricter version and this paragraph
records it as the stance rather than the deviation it was.

`better-auth` has its own reason: ADR-0013 accepts that a Better Auth release can break
the hand-written mount, so a floating range lets a transitive bump break authentication
with no code change. The rest are pinned so the manifests state what actually resolves.
The earlier wording said carets stay reproducible because of the lockfile, which is
true, and it is also true that a committed lockfile plus `--frozen-lockfile` already
stopped carets from picking up patches. Carets bought drift on the next unpinned
`pnpm install` and nothing else.

**`.github/dependabot.yml` is what moves versions.** One `npm` ecosystem entry at
`directory: "/"`, weekly. Dependabot reads `pnpm-workspace.yaml` and `pnpm-lock.yaml`
(v9) and covers all four manifests from that entry. Minor and patch updates group into
one PR; majors arrive one at a time. Exact pins mean a human merges every upgrade, and a
bot opening the PR is what separates deliberate pinning from rot. Dependabot PRs run
`quality`, `integration` and `performance` like any other PR. **A PR that bumps
`better-auth` does not merge until the four facts below are re-checked against the new
version**, same obligation as the original pin.

**Whoever pins the version re-checks the four Better Auth facts the design was written
against**, because they were verified against current-latest docs, not a pinned
release: (1) `rateLimit` defaults to enabled-in-production, the reason ADR-0013
disables it; (2) `hooks.before` / `createAuthMiddleware` signature; (3)
`ctx.body.email` shape; (4) `ctx.path` being base-path-relative. If (1) has changed the
disable is harmless; if (2) or (3) has changed, F-019's and F-021's mechanisms need
revisiting before the pin lands. This travels with TASK-009's pinning step below.

**Layer 3: the artifact separates the numbers.** `infra/loadtest/baseline.json` carries
both, and `docs/performance/redirect-baseline.md` says which is which in prose, so
nobody reads the CI number as the latency commitment.

```json
{
  "measuredAt": "...", "machine": "...", "emissionMode": "deferred-batch",
  "rate": 500, "achievedRate": 0, "p50": 0, "p95": 0, "p99": 0,
  "targetP99": 0,
  "ciRate": 100, "ciP99BudgetMs": 0, "ciRunner": "ubuntu-latest"
}
```

`ciP99BudgetMs` is measured on the same runner class during TASK-036 and set with
headroom above the observed median. It is a regression tripwire, not a latency promise.

**How this reads against SC-2, stated so the gate can rule on it.** SC-2 says a
baseline is measured, a target is recorded, and "a load test in CI fails when the
target regresses", and separately that the target may not exceed p99 ≤ 25 ms at
500 RPS. This design measures the target at 500 RPS, records it, and runs a CI load
test that fails on regression. It does not run the CI test at 500 RPS. That reading is
consistent with SC-2's wording, and it is an interpretation rather than a fact.
**Juano should confirm it at the Design gate.** No wording has been changed.

## Alternatives considered

| Option | Pros | Cons | Why not |
|---|---|---|---|
| 500 RPS on every PR against service containers | Literally matches the rate in SC-2's sentence | The generator and the application share four vCPUs, so p99 measures contention rather than the code. Expect swings well beyond the 25 ms budget, and AC-64's three-runs-agree requirement fails | Produces a gate that fails at random, which the refinement calls worse than no gate |
| 500 RPS on every PR against the deployed Fly machine | Real infrastructure; real cache | Every PR runs load against production, and every PR costs 30,000 Upstash commands. Concurrent PRs interfere with each other's measurements | Cost and interference, and it makes CI able to degrade the live service |
| Single run rather than median-of-three | Three times faster | One noisy neighbour on the runner fails the build. AC-64 is precisely a test for this | The 90 seconds saved is the whole reason the gate can be trusted |
| No gate; measure on demand only | Zero flakiness by construction | SC-2 requires enforcement, not a recorded number. A regression would ship and be found by whoever noticed | Fails SC-2 and is the outcome the refinement said to escalate rather than accept |
| Relative gate: fail if p99 rises more than 20% over the previous run on `main` | Adapts to runner drift | Needs stored history and lets slow drift accumulate: twelve 15% regressions each pass individually | An absolute budget with headroom is simpler and catches drift |
| Autocannon or a Node-based generator | Same language as the project | Competes with the application for the event loop and the same CPUs; its own p99 includes its own scheduling | Measures the generator |

On the audit threshold and the pinning stance, decided 2026-08-04 (F-049, F-055):

| Option | Pros | Cons | Why not |
|---|---|---|---|
| Keep `--audit-level high` on `quality` | No new failure mode; the highest-signal advisories still block | Session fixation, open redirect and timing-leak advisories are rated moderate, and `better-auth` is on the critical path. Nothing else in the repo surfaces one | Leaves the exact class of advisory this stack is most exposed to passing silently |
| `--audit-level low` on `quality` | Nothing gets through | Low advisories are mostly prototype-pollution reachability notes in transitive dev tools. A merge blocked on one that cannot be fixed pushes the team to an ignore list | Buys noise at the tier where the ignore list starts filling up |
| Revert non-`better-auth` deps to caret ranges, as this ADR originally said | Restores the ADR's written stance without amending it; `pnpm update` picks up patches | The manifests then claim a range while `pnpm-lock.yaml` and `--frozen-lockfile` pin the resolution anyway, so the range describes nothing that happens in CI or in the Fly image | Undoes work the security auditor called strictly better to preserve a sentence |
| Exact pins with no bot, relying on the audit alone | Nothing to configure; no PR noise | The audit reports a vulnerable version and no mechanism raises the version. Every bump is somebody remembering | Detection with no remediation path, which is how a known advisory stays deployed for a quarter |
| Exact pins, `moderate` on both audits, Dependabot weekly | Manifests state what resolves; a bot proposes every bump; a scheduled run catches advisories published after merge | Weekly PR noise on a solo project, and CI minutes spent on bumps nobody asked for | Chosen |
| Renovate instead of Dependabot | Better pnpm workspace support, richer grouping and automerge rules | Needs a GitHub App installed on the account and a config file with its own dialect to learn | Dependabot is native, needs no install, and grouping is enough at four manifests |

## Consequences

### Positive

- A gate exists on every pull request, so SC-2's enforcement half is real rather than
  aspirational.
- Gating on `Server-Timing` removes runner and network jitter from the number, which
  is both more faithful to SC-2's "server-side" and the main reason the gate is stable.
- Median-of-three makes a single noisy neighbour a non-event, which is what AC-64
  tests.
- The PR gate costs no Upstash commands and no Neon compute beyond a container, so
  GC-3 is unaffected by CI frequency.

### Negative / accepted cost

- **The PR gate runs at 100 RPS, not 500.** A regression that only appears under
  connection-pool or event-loop pressure at 500 RPS passes CI and is caught weekly.
  That is a real detection gap, and it is the cost of a gate that does not lie.
- The PR gate uses local Redis, so a regression caused by Upstash round trips or by a
  change in Redis command count per request is invisible to it. The weekly full run is
  the only thing that sees it.
- `ciP99BudgetMs` is tied to `ubuntu-latest`'s current hardware. GitHub changing the
  runner class silently invalidates the budget, and the symptom is a build that starts
  failing with no code change.
- `Server-Timing` on every redirect response adds a header to the hot path and exposes
  internal timing to anyone who clicks a link. Negligible in bytes, and it is
  information disclosure that a reviewer should be told about deliberately.
- Two numbers in one artifact invites confusion. The document has to work hard to keep
  `ciP99BudgetMs` from being quoted as the latency commitment.
- Roughly 2 minutes 20 seconds added to every pull request.
- `pnpm audit` fails a merge on an advisory that may have no fix available and no
  bearing on how the dependency is used. Dropping to `moderate` widens that band, and
  the escape hatch is an ignore list, which becomes a place findings go to be forgotten.
  Nothing in `launch-core` reviews it.
- A low-severity advisory passes both audits. That band is deliberate and nothing else
  catches it.
- Exact pins across all four manifests mean security patches arrive only when someone
  merges a bump. The `quality` audit surfaces the need on any open PR, the weekly
  `dependencies` job surfaces it when no PR is open, and Dependabot proposes the bump.
  Remove any of the three and the other two stop being sufficient.
- Dependabot opens PRs weekly on a project with one maintainer. Unreviewed bot PRs pile
  up, and a stale queue is worse than no queue because it looks like coverage. Nothing
  in `launch-core` schedules the review.
- The weekly `dependencies` job reports through a failed scheduled run, which GitHub
  emails to the repo owner. An owner who filters those emails has no signal. Filing an
  issue instead would need `issues: write` and a script, and that was not worth building
  for one job.
- A Dependabot PR that bumps `better-auth` carries the four-fact re-check, so it is
  never a rubber-stamp merge. Whoever reviews it has to read release notes.

### Follow-ups this creates

- TASK-029 and TASK-030 emit the `Server-Timing` header.
- TASK-035 owns the k6 script, `--rate` and `--duration`, the excluded warm-up, the
  reported request count, and both `serverP99` and `clientP99` in its output.
- TASK-036 measures both `targetP99` (500 RPS, deployed) and `ciP99BudgetMs` (100 RPS,
  `ubuntu-latest`), and writes a document that keeps them apart.
- TASK-037 owns both jobs, the median-of-three logic, and the documented on-demand
  invocation.
- TASK-009 pins `better-auth` exactly in `apps/api/package.json` and commits
  `pnpm-lock.yaml`, **and re-checks the four Better Auth facts listed in the pinning
  paragraph above against the docs for that exact version**, recording the result in
  the commit message. A divergence on `hooks.before` or `ctx.body.email` blocks the pin
  and escalates. Re-attributed from TASK-001 on 2026-08-04 (F-040): TASK-001 bootstraps
  the monorepo and excludes auth by name, so the pin had no producer there. The
  implementer that mounts the library is the one that needs the four facts to hold.
- TASK-002 adds `--frozen-lockfile` to every job, the `pnpm audit --prod --audit-level
  moderate` step to `quality`, and the `dependencies` job running `pnpm audit
  --audit-level moderate` on a weekly `schedule` and on `workflow_dispatch`.
- TASK-002 also adds `.github/dependabot.yml`. **Its `paths` currently read
  `.github/workflows/**`, which excludes that file.** Widening them to `.github/**` is
  Juano's edit, not the implementer's. Flagged 2026-08-04 (F-055).
- Every dependency across `package.json`, `apps/api`, `apps/web` and
  `packages/contracts` stays at an exact `x.y.z` or `workspace:*`. A reviewer seeing a
  caret or tilde in a diff rejects it.
- **Gate item for Juano:** confirm the reading of SC-2 recorded above.
- Contract: `design/contracts/loadtest-result.md`.
