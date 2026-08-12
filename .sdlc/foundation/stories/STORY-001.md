---
id: STORY-001
epic: EPIC-001
title: Monorepo scaffold and quality gates
status: done
tasks: [TASK-001]
depends_on: []
---

## User story

As Juano, I need a workspace where lint, typecheck, test and build are single commands, so that every later TASK has a gate to run against.

## Acceptance criteria

- [ ] AC-1: Given a clean clone at the repo root, when `pnpm install` then `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build` are run in order, then every command exits 0.
- [ ] AC-2: Given the installed workspace, when `pnpm -r list --depth -1` is run, then the workspace packages it lists are exactly `@shortkit/api` (`apps/api`), `@shortkit/web` (`apps/web`) and `@shortkit/contracts` (`packages/contracts`). The command also prints a line for the workspace root (`shortkit`), which is **expected and not a fourth workspace** — the root is not matched by the `packages:` globs in `pnpm-workspace.yaml` and exists only to hold the root scripts AC-1 requires.
- [ ] AC-3: Given each of the three workspaces, when `pnpm test` runs, then at least one test executes and passes in each workspace (zero-test workspaces fail this AC).
- [ ] AC-4: Given `apps/web` imports a symbol exported by `packages/contracts`, when `pnpm typecheck` runs, then it resolves without error; and when that symbol's type is changed incompatibly, `pnpm typecheck` exits non-zero.
- [ ] AC-107: Given a clean clone, when `README.md` is read, then it states what Shortkit is and lists the install, test, lint, typecheck and build commands, and each listed command exits 0 when run.

Each AC is objectively verifiable. `sdlc-test-architect` turns these into tests
and `sdlc-product-auditor` verifies against them verbatim.

## Definition of Ready

**PASS.** Testable and self-contained. AC-107 was added on 2026-08-03: dropping the post TASKs removed the only producers of `README.md` while `docs.required: [README]` still stands, so TASK-001 absorbed it. Design must answer jest-vs-vitest before TASK-001 dispatches; Design runs before Implement, so this is ordering rather than a blocker.

- [x] ACs are testable and unambiguous
- [x] Dependencies identified
- [ ] Contracts it consumes exist in `design/contracts/` — Design has not run yet
- [x] No blocking open questions

## Definition of Done
- [ ] All ACs green as automated tests
- [ ] All auditors clear of blocker/major
- [ ] Docs updated (README / API / ADR consequences)
- [ ] Observability in place per config
- [ ] Traceable: commits reference TASK ids

**AC-2 amended 2026-08-04 (F-041, ruled by Juano).** The original text said "lists
exactly the workspaces", which `pnpm -r list --depth -1` cannot satisfy literally: it
prints the workspace root as a fourth line, and `--no-include-workspace-root` does not
suppress it (verified). The AC now names the three packages and states the root line is
expected. The id is unchanged and STORY-001 still holds 5 ACs.

## Verification at Ship — 2026-08-11 (F-397)

**No STORY in this initiative recorded its Definition of Done until Ship.** Twenty acceptance
criteria and twenty DoD items across four cards, every one still `- [ ]` while ten TASKs were
`done`. The evidence existed in `state.yaml`, the acceptance report and the integration report; it
was absent from the cards a reader opens. Found by the Ship traceability pass, not by any of the
six audits that ran today.

**Checkboxes are deliberately left unticked and this block records the state instead.** A tick is a
claim with no room for a caveat, and three of this initiative's criteria are not the kind of thing a
tick can honestly carry — one is untestable by construction, one was met by an artifact that no
longer exists, and one has never been observed in the environment it gates. Evidence below, per
criterion, with what is *not* proven stated beside what is.

See `.sdlc/foundation/ship/acceptance-report.md` for the per-criterion verdict and
`ship/integration-report.md` for the evidence. **SC-1 is `untestable`, not "partly met"** — it
quantifies over "every repository method and every authenticated endpoint" and both sets are empty,
so a verbatim reading is vacuously true, which is the shape the harness's own F-295 rule refuses.

**DoD.** Auditors clear of blocker/major: **yes**. Docs updated: **yes**. Observability per config:
**yes**. Traceable: **yes for feature commits**, with five source-touching orphans named in F-398.
