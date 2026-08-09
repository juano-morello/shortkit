# TASK-001 — Product Audit (round 1)

**Story:** STORY-001, ACs AC-1, AC-2, AC-3, AC-4, AC-107
**Commit range reviewed:** cee06e4..f58f340 (`feat(repo): pnpm monorepo with lint, typecheck, test and build gates [TASK-001]`)
**Verdict: approved**

## How this was verified

Two command runs were performed, both from `/home/juano/Workspaces/JustJuanoDev` on branch
`sdlc/launch-core`:

1. **In-place**, with `node_modules/` already installed (repo's existing state) — `pnpm lint`,
   `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm -r list --depth -1`,
   `pnpm -r list --depth -1 --no-include-workspace-root`.
2. **True clean clone**, `git clone --branch sdlc/launch-core` into `/tmp/tk-clean` (no
   `node_modules` anywhere, fresh `pnpm install --frozen-lockfile`), then `pnpm lint`,
   `pnpm typecheck`, `pnpm test`, `pnpm build` there. All five commands exited 0. This directly
   satisfies AC-1's literal "clean clone" condition rather than approximating it — the temp
   clone was removed afterward.

AC-4's negative direction (renaming `not_found` to break the cross-workspace import) was **not**
independently re-executed — this auditor is read-only and an attempted `sed -i` on
`packages/contracts/src/errors.ts` was correctly blocked by the permission system. Instead the
implementer's transcript was cross-checked against the actual committed files: the reported
`TS2339` errors cite `app/not-found.tsx(5,44)` and `app/not-found.spec.tsx(12,32)`, and those
exact lines in the committed files are `ERROR_CODE_STATUS.not_found` property accesses. The line
numbers and column offsets match the real file content, which corroborates the transcript without
requiring re-execution.

## AC-by-AC

| AC | Status | Evidence |
|---|---|---|
| AC-1 | **met** | Clean clone at `/tmp/tk-clean`: `pnpm install --frozen-lockfile` then `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build` all exit 0. Root `package.json` scripts, `pnpm-workspace.yaml` (`allowBuilds` for `@swc/core`/`esbuild`), `pnpm-lock.yaml`. |
| AC-2 | **met** (amended AC text, F-041) | `pnpm -r list --depth -1` output: `shortkit@0.0.0` (root) + exactly `@shortkit/api`, `@shortkit/web`, `@shortkit/contracts`. Independently confirmed `--no-include-workspace-root` does not suppress the root line, matching the amendment's stated rationale. |
| AC-3 | **met** | `pnpm test` → 4 files, 15 tests, all pass, all three workspaces represented (`contracts` 9, `api` 4 across two files, `web` 2). Read all four spec files: `packages/contracts/src/errors.spec.ts`, `apps/api/src/app.module.spec.ts`, `apps/api/src/decorator-metadata.spec.ts`, `apps/web/app/not-found.spec.tsx` — each asserts real behavior of code in this commit, none is a placeholder (`expect(true).toBe(true)`-style). |
| AC-4 | **met** | Positive direction independently verified: `apps/web/app/not-found.tsx:1` imports `ERROR_CODE_STATUS` from `@shortkit/contracts`, used at line 5; `pnpm typecheck` and `pnpm build` (prerendering `/_not-found`) both exit 0 in the clean-clone run. Negative direction: implementer's transcript (report §3, AC-4) cross-checked against committed file line/column numbers — matches exactly. Not independently re-executed (read-only constraint). |
| AC-107 | **met** | `README.md`: opening paragraph + three bullets state what Shortkit is; Commands table lists `pnpm install`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build` (the five AC-107 names) plus `pnpm test:integration`. Every one of the five required commands verified to exit 0 above; `test:integration` also verified to exit 0 (passes with `passWithNoTests: true`, no integration suites exist yet by design). |

## Scope check

TASK-001's Produces block: root scripts `lint`/`typecheck`/`test`/`build`; three workspaces
`@shortkit/api`/`@shortkit/web`/`@shortkit/contracts`; `apps/api/src/app.module.ts`;
`apps/api/src/main.ts`; `apps/web/app/`; `README.md`.

- **Stubs materialised: exactly 2 of 29**, as instructed. `packages/contracts/src/errors.ts` is
  byte-identical to `design/stubs/packages/contracts/src/errors.ts`. `index.ts` differs only by
  commenting out four re-exports for modules that don't exist yet (`pagination`, `roles`, `slug`,
  `domains/reserved-hostnames`), each annotated `// TASK-007` — this is a re-export list, not a
  signature or type change, so it does not violate the stubs README's "do not change a signature"
  rule. Confirmed the other 27 stub files are untouched, and `packages/contracts/`,
  `apps/api/src/`, `apps/web/app/` contain nothing beyond what the report claims (verified with
  `find`).
- **`apps/web/src/**` does not exist** — confirmed empty. TASK-008/TASK-012's boundary is intact.
- **`app.module.ts`** has `imports: []`, no feature modules — matches "composition root" with
  nothing more.
- **`main.ts`** sets `/api` global prefix excluding `GET /health`, no health controller added —
  minimal entrypoint, no extra surface.
- **Root scripts**: `lint`, `typecheck`, `test`, `build` (asked for) plus `test:integration`
  (not in TASK-001's own Produces line, but ADR-0001 line 93 explicitly states "TASK-001 sets up
  both commands and both configs" — confirmed by reading `design/adr-0001-test-framework.md`).
  Not scope creep.
- **`.gitattributes`**: not listed in TASK-001.md's `paths` frontmatter, but
  `design/adr-0004-schema-layout-and-migrations.md:119` explicitly assigns it to TASK-001 by
  name. The content matches the ADR's stated shape exactly. Legitimate, but the TASK file's
  `paths` field is stale — see finding below.
- **Out of scope respected**: no database, Redis, auth, deploy config, CI workflow, or domain
  schema anywhere in the diff (`git show --stat f58f340` — 37 files, all accounted for above).
  `apps/api/src/decorator-metadata.spec.ts` adds two test-local `@Injectable` classes not named
  by any AC — see "Shipped but not asked for" below; judged in-scope, not a finding.

## Findings

| severity | kind | file | summary |
|---|---|---|---|
| nit | scope | `.sdlc/foundation/tasks/TASK-001.md` (frontmatter `paths`) | `.gitattributes` is genuinely produced under ADR-0004's follow-up assignment, but TASK-001's own `paths` list never names it, so a reader checking scope against the TASK file alone would flag it as unexplained. Cost is documentation only — no code change. Recommend adding `.gitattributes` to `paths` for traceability next time this file is touched. |

No blocker, major, or minor findings. No AC is not-met or partial.

## Shipped but not asked for

- `apps/api/src/decorator-metadata.spec.ts` — two `@Injectable` classes declared inside the spec
  file, asserting that the `unplugin-swc` transform still emits `design:paramtypes` and that Nest
  can inject from it. No AC names this file and it is not required to satisfy AC-3 (`app.module.spec.ts`
  already covers `apps/api`). The implementer flagged it itself (report §7) as a judgment call tied
  to ADR-0001's one accepted toolchain cost, whose regression is otherwise silent. It adds no
  production surface (classes are test-local) and does not affect any AC's pass/fail. Noted for
  visibility, not requiring removal.
- `apps/api/vitest.integration.config.ts` with `passWithNoTests: true` — makes `pnpm test:integration`
  green today with zero integration tests. This is a real, if minor, foot-gun for later (a broken
  glob would also silently pass) — the implementer already flagged it in their own report §5.2 and
  §7. Not a defect against any current AC; recorded here only because it's exactly the class of
  thing this audit is supposed to surface.

## Out-of-scope items that got built

None. Database, Redis, auth, deploy config, CI workflow and domain schema — all named in
TASK-001's own "Out of scope for this TASK" section — are genuinely absent from the diff.

## Notes for the record

- **F-040** (better-auth pin, ADR-0018) remains open (`status: escalated`, unresolved) in
  `findings.yaml`. TASK-001's own "Out of scope" section excludes auth by name, and the
  implementer's report documents the omission and its reasoning rather than silently skipping it.
  Not re-filed here — already tracked and awaiting Juano's ruling.
- **F-041** (AC-2 wording) was already ruled and the STORY-001 text amended before this audit;
  verified the amended text against the actual command output and it holds.
