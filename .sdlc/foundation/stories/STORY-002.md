---
id: STORY-002
epic: EPIC-001
title: Deployable skeleton with CI
status: in-progress
tasks: [TASK-002, TASK-003, TASK-004]
depends_on: [STORY-001]
---

## User story

As Juano, I need both deployables reachable on the internet and a CI pipeline that blocks bad merges, so that later work is validated where it will actually run.

## Acceptance criteria

- [ ] AC-5: Given a pushed branch, when the CI workflow runs, then it executes lint, typecheck, test and build in a job named `quality`, **and runs `pnpm test:integration` against a `postgres:17-alpine` service container in a job named `integration`**, and the workflow concludes `failure` if any one of them exits non-zero.
- [ ] AC-6: Given the API deployed to Fly.io, when `GET /health` is requested over HTTPS, then it returns 200 with a JSON body containing a `status` field equal to `"ok"` and a `commit` field matching the deployed git SHA.
- [ ] AC-7: Given the web app deployed to Vercel, when its root URL is requested, then it returns 200 and HTML.
- [ ] AC-113: Given a production build of `apps/web`, when the built client bundle under `.next/static/**` is searched for the values of the server-only variables `BFF_PROXY_SECRET` and `API_BASE_URL`, then neither value appears, and the check fails the CI workflow if either does.
- [ ] AC-114: Given the CI `integration` job, when `pnpm test:integration` completes, then the job asserts the run collected at least one test file and at least one test, and concludes `failure` if it collected none.

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

**AC-113 and AC-114 minted 2026-08-05 (F-078, F-079, ruled by Juano).** Both encode
obligations that already existed in a TASK file with no acceptance criterion to carry them,
which is the shape F-050 established and Juano resolved the same way by minting AC-112.
`sdlc-product-auditor` verifies ACs verbatim, so an obligation with no AC is one nobody checks.

- **AC-113** comes from TASK-004's Design-round-5 amendment, which forbids the
  `NEXT_PUBLIC_` prefix on `BFF_PROXY_SECRET` because that prefix inlines a value into the
  client bundle. Nothing in this STORY mentioned environment variables, so a build publishing
  the shared proxy secret to every browser satisfied AC-7 and every other criterion here. The
  secret is what the API's constant-time match trusts before honouring a forwarded client
  address; leaking it collapses all four IP-keyed rate-limit buckets into one.
- **AC-114** comes from TASK-002's F-064 obligation 2. AC-5's only occurrence of "non-zero"
  is about a command's exit code, so AC-5 as written was satisfied by an `integration` job
  that stands up `postgres:17-alpine` and collects nothing — the failure F-039 was filed to
  prevent, re-entering through the acceptance criteria rather than through the workflow.

Ids are appended and nothing renumbered. This STORY now holds 5 ACs. Both are CI-level
assertions rather than vitest tests, which is consistent with AC-5 and AC-7 being
`test_exempt` — the verification is real, it just does not live in the suite.
