---
id: STORY-002
epic: EPIC-001
title: Deployable skeleton with CI
status: todo
tasks: [TASK-002, TASK-003, TASK-004]
depends_on: [STORY-001]
---

## User story

As Juano, I need both deployables reachable on the internet and a CI pipeline that blocks bad merges, so that later work is validated where it will actually run.

## Acceptance criteria

- [ ] AC-5: Given a pushed branch, when the CI workflow runs, then it executes lint, typecheck, test and build in a job named `quality`, **and runs `pnpm test:integration` against a `postgres:17-alpine` service container in a job named `integration`**, and the workflow concludes `failure` if any one of them exits non-zero.
- [ ] AC-6: Given the API deployed to Fly.io, when `GET /health` is requested over HTTPS, then it returns 200 with a JSON body containing a `status` field equal to `"ok"` and a `commit` field matching the deployed git SHA.
- [ ] AC-7: Given the web app deployed to Vercel, when its root URL is requested, then it returns 200 and HTML.

Each AC is objectively verifiable. `sdlc-test-architect` turns these into tests
and `sdlc-product-auditor` verifies against them verbatim.

**AC-5 amended 2026-08-04 (F-039, ruled by Juano).** The original text named only the
four quality commands, so nothing in this STORY required the integration suite to run
anywhere. ADR-0001 had assigned that job to TASK-002 in its follow-ups and the
assignment never reached either artifact. The id is unchanged and the AC count for
this STORY is still 3; only AC-5's text widened. `sdlc-product-auditor` must verify
both jobs, not just `quality`.

## Definition of Ready

**PASS with a note.** AC-7 uses the Vercel-provided hostname. Apex-domain binding waits on the unresolved apex-domain question; that is TASK-057's concern, not this STORY's.

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
