# TASK-003 Product Audit — AC-6 (STORY-002)

> Returned inline by `sdlc-product-auditor` and persisted verbatim by the orchestrator on
> 2026-08-06. Review package: `.superpowers/sdd/TASK-003/review-af4e5bb..f379953.diff`.

**Scope confirmed before auditing:** Per `test-strategy.md`'s AC-6 entry (ruled 2026-08-06), AC-6 splits into a **tested half** (app boots, `GET /health` → 200, `status: "ok"`, `commit` from build-time source not a placeholder) and an **exempt half** (`deployed to Fly.io`, `over HTTPS`) that has no vitest coverage and is this auditor's job to check against a live URL. AC-5, AC-7, AC-113, AC-114 belong to other TASKs and are already `done`; I checked the diff does not claim them (it doesn't — `.sdlc/foundation/state.yaml`'s new `TASK-003` line lists only `acceptance: [AC-6]`).

## Tested half — genuinely met, not weakly

Read `apps/api/src/health/build-commit.ts`, `apps/api/src/health/health.controller.ts`, `apps/api/src/main.ts`, and `Dockerfile` directly rather than trusting the ADR's description of them.

- `readBuildCommitSha()` (`apps/api/src/health/build-commit.ts:36-49`) has **no `??`, no `||`, no default parameter, no sentinel** anywhere in the read path. It validates against `/^[0-9a-f]{40}$/` and throws on `undefined` or malformed input. Grepped the shipped file myself for `??`/`||` — the only `||` present is inside the throw's own guard condition (`value === undefined || !FULL_COMMIT_SHA.test(value)`), which is a rejection, not a fallback. This directly answers F-225's concern: the code, not just the ADR, forbids the fallback.
- `health.controller.ts` calls `readBuildCommitSha()` per request (lazy), matching ADR-0027's requirement that the read never happen at import time or in a constructor — verified against `app.module.spec.ts`/`exception-filter.spec.ts` staying outside TASK-003's paths, which is why laziness matters.
- `main.ts`'s `assertBootPreconditions()` calls `readBuildCommitSha()` before `assertRuntimeRoleCannotBypassRls()` — the ordering ADR-0027 mandates, string-check before I/O.
- `Dockerfile`'s runtime-stage `ARG`/`RUN grep -Eq '^[0-9a-f]{40}$'`/`ENV` block is byte-for-byte the text ADR-0027 § "What TASK-003 writes" prescribes, including the re-declaration-inside-the-stage requirement that the ADR verified would otherwise silently ship `GIT_COMMIT_SHA=`.
- `fly.toml`'s `[[http_service.checks]]` block matches the ADR's prescribed `method`/`path`/timings, and correctly carries **no** `[env]`/`[build.args]` entry for the SHA, per the ADR's explicit rejection of that alternative.
- The frozen test (`apps/api/src/health/health.spec.ts`, not touched by this diff) asserts 200, `status: "ok"`, and `commit` equal to a fixture SHA injected via `vi.stubEnv`, over a real HTTP round trip against an app built from `AppModule` — not a controller-method call, which closes F-217's exact failure mode (a route configured but unserved). Per the implementer's report this went from 3 failing to 3 passing with no other test regressed.

This is a real red-to-green implementation, not "three tests pass and that's it" — I independently confirmed the fallback-forbidding property in the shipped code, which is the one thing a green suite alone cannot prove.

## Exempt half — cannot verify today, and I am saying so rather than implying otherwise

"Deployed to Fly.io" and "over HTTPS" require a live URL. I have no deploy tool access (no `flyctl`, no Fly credentials, read-only tools only), and the implementer's report and `infra/deploy.sh`'s own dirty-tree test confirm **nothing has been deployed from this environment** — `flyctl` isn't installed here either. So per F-225's surviving residue, I cannot perform the comparison the finding demands (deployed `commit` vs. the SHA actually deployed), because there is no deployment to compare against yet. This is expected at this stage per the ADR/ruling, not a defect I'm papering over — but it means AC-6 as a whole is not fully closeable today, only its tested half is.

**AC-6 verdict: `partial`** — tested half `met` (evidence: `apps/api/src/health/health.spec.ts::GET /health`, all 3 cases; `apps/api/src/health/build-commit.ts:36-49`), exempt half `untestable` in this environment (no deployment exists to check).

## Claims on other ACs

None. `.sdlc/foundation/state.yaml`'s new TASK-003 entry lists only `acceptance: [AC-6]`. Nothing in the diff touches `.github/**`, `apps/web/**`, or anything under AC-5/AC-7/AC-113/AC-114's territory.

## Shipped but not asked for

- `USER node` in the `Dockerfile` — self-disclosed by the implementer as having no AC/test/finding behind it. Harmless standard hardening (non-root container user); flagging per instructions rather than treating it as a defect.
- Everything else large in this diff (health module, pino, boot refusal, exception-filter rewrite, Dockerfile, fly.toml, deploy script, lockfile) traces to a named AC or finding: AC-6/F-217 (health), F-090/F-108/F-111/GC-9 (pino + exception-filter), F-116 (RLS boot refusal), F-119/F-142 (release-command settlement), F-075/F-085 (pino manifest+lockfile). I checked each claim against the actual diff rather than the report's assertion, and they hold up.
- `apps/api/src/observability/logger.ts` — implementer's own flagged path excursion. Justified: structurally forced by the `main.ts` → `app.module.ts` → `exception-filter.ts` import cycle, and the contract already names this exact path as TASK-003's Normative form with a stub present. This is already captured by **F-243** (escalated, `owner_slot: null`) — not re-filing.
- `.dockerignore` — also self-flagged, required for the Dockerfile to build without shipping a multi-gigabyte `node_modules` symlink forest. Justified.

## Out-of-scope items that got built

None found. Helmet/HSTS, which `logging-and-headers.md` assigns to TASK-003, was correctly **not** built — no AC, no test, no finding required it this round, and the implementer's Iron Law argument (no production code without a failing test) is sound. This gap is already tracked in **F-243** item 2, not a new finding.

## Findings contested/checked, not re-filed

- **F-225** (open, `sdlc-architect`): confirmed still open and correctly scoped — the code has no fallback, but the comparison-not-existence verification it demands needs an actual deployment, which doesn't exist yet.
- **F-241** (fixed): confirmed in the diff — `credential-auth.int-spec.ts` now splits `beforeAll`/`beforeEach` exactly as described, and `auth-fixture.ts` now supplies `GIT_COMMIT_SHA`. This restores the pre-existing `9 failed | 30 passed` shape rather than masking it as skips.
- **F-242, F-243**: read, both accurately describe what I independently found in the diff. Not re-filing.

## What I could not verify (read-only, no deploy access)

I cannot confirm `fly deploy` behavior, the actual Fly health-check semantics, or that `GET /health` answers over HTTPS from a live `shortkit-api.fly.dev` — no `flyctl`, no Fly account, nothing deployed. This matches what the implementer's report itself discloses (`infra/deploy.sh` was only run to its dirty-tree guard). Stating this plainly rather than implying I checked it.

## Verdict

**APPROVED** for TASK-003 as scoped. AC-6's tested half is genuinely met by real tests and independently-verified fallback-free code; AC-5/AC-7/AC-113/AC-114 are not claimed by this diff; no unjustified scope creep found beyond what's already tracked in F-243. AC-6's exempt half (Fly deployment, HTTPS) remains open pending an actual deploy — not a defect in this diff, but a fact that should not be read as closed.
