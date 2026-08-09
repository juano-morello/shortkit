---
id: TASK-001
story: STORY-001
epic: EPIC-001
title: pnpm monorepo bootstrap and quality gates
status: done
owner_slot: sdlc-implementer-backend
depends_on: []
paths: ["package.json", "pnpm-workspace.yaml", "pnpm-lock.yaml", "tsconfig*.json", "vitest.config.ts", ".editorconfig", ".gitattributes", "eslint.config.mjs", "apps/api/**", "apps/web/**", "packages/contracts/**", ".gitignore", "README.md"]
contracts: []
test_files: []
test_exempt: true
test_exempt_reason: >-
  Produces the test runner itself. Under ADR-0001 this TASK writes the root and
  per-workspace vitest configs and ships one passing DB-free test per workspace for
  AC-3, so no failing test can precede it — the runner for that test is its own
  deliverable. Ruled by Juano 2026-08-04 per phases/test.md step 4. The exemption
  covers TASK-001 alone; every later TASK gets red tests first.
acceptance: [AC-1, AC-2, AC-3, AC-4, AC-107]
rework_count: 0
---

## Intent

Create the workspace so that lint, typecheck, test and build are one command each at the root.

## Approach

pnpm workspaces; TypeScript end to end; exactly three workspaces (GC-7); the test framework is whatever Design chose — **jest vs vitest is an open question Design must answer before this TASK dispatches**; each workspace ships one real passing test so `pnpm test` is meaningful.

**README.** `docs.required: [README]` (GC-13) has no other producer — the post TASKs that would have written it left the initiative on 2026-08-03 — so AC-107 lands here. README prose is human-facing (GC-12).

## Out of scope for this TASK

Database, Redis, auth, deploy config, CI workflow, any feature code, any domain schema.

## Interfaces

**Consumes**

Nothing.

**Produces**

Root scripts `lint`, `typecheck`, `test`, `build`; workspaces `@shortkit/api`, `@shortkit/web`, `@shortkit/contracts`; a NestJS composition root at `apps/api/src/app.module.ts` and entrypoint `apps/api/src/main.ts`; a Next.js App Router tree at `apps/web/app/`; `README.md`.

## ⚠ Ownership exception

This is the only TASK owned by `sdlc-implementer-backend` that writes under `apps/web/**`. The root quality commands cannot be verified until the web workspace exists, and the constraint mandates one bootstrap TASK. It runs alone in Wave 0, so there is no concurrency risk.

## ⚠ Hard gate after this TASK

After this TASK merges, **`/juano-sdlc init` must be re-run** to populate `testing:` and `quality:` in `.sdlc/config.yaml`. **No further TASK dispatches until that is done** — until then Implement has no quality gates to run.
