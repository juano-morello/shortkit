---
id: STORY-002
epic: EPIC-001
title: Deployable skeleton with CI
status: in-progress
tasks: [TASK-002, TASK-003, TASK-004, TASK-059, TASK-060]
depends_on: [STORY-001]
---

## User story

As Juano, I need both deployables reachable on the internet and a CI pipeline that blocks bad merges, so that later work is validated where it will actually run.

## Acceptance criteria

- [ ] AC-5: Given a pushed branch, when the CI workflow runs, then it executes lint, typecheck, test and build in a job named `quality`, **and runs `pnpm test:integration` against a `postgres:17-alpine` service container in a job named `integration`**, and the workflow concludes `failure` if any one of them exits non-zero.
- [ ] AC-6: Given the API running from the production image built by the repository's `Dockerfile`, when `GET /health` is requested, then it returns 200 with a JSON body containing a `status` field equal to `"ok"` and a `commit` field matching the git SHA the image was built from. **Narrowed by ADR-0037 (accepted 2026-08-11, F-368):** an image that cannot reach traffic may report the git null SHA. The local compose stack builds this same production image and reports forty zeros on a bare `docker compose up`; that is the narrowing, not a failure of this AC. An image that *can* reach traffic may not.
- [ ] AC-7: Given the web app deployed to Vercel, when its root URL is requested, then it returns 200 and HTML.
- [ ] AC-115: Given a machine with only Docker and a clone of this repository, when `docker compose up` is run at the repository root, then Postgres, the API and the web app all reach a healthy state, the migrations have been applied, the seed has run, and `GET /health` on the composed API returns 200 with `status` equal to `"ok"`.
- [ ] AC-116: Given the API source tree, when every module that emits a log line is enumerated, then each one emits through the pino instance registered at the composition root — no module constructs `Logger` from `@nestjs/common` or any other logger — and a lint rule fails the build if one does.
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

## Amendment A-8 — AC-6 narrowed, AC-115 minted (2026-08-11, ruled by Juano)

AC-6 named Fly.io as the deploy target. Nothing was ever deployed there: through five
audit rounds and four fix rounds, `shortkit-api.fly.dev` was NXDOMAIN from Fly's own
authoritative nameservers, no `flyctl` was on PATH, no `~/.fly` existed, and
`.github/workflows` held no deploy job. TASK-003 sat escalated on a clause only Juano
could clear.

Juano's ruling repurposes the infrastructure work rather than waiting on it: **the
deploy target is deliberately undecided, and the criterion that matters now is that the
whole stack comes up from nothing with one command.** So:

- **AC-6 keeps its id and loses only the deploy clause.** What remains is the half that
  was already measured on 2026-08-10 — `sdlc-product-auditor` built the shipped
  `Dockerfile` and got `GET /health` → 200 with `commit` equal to `git rev-parse HEAD`,
  and the same run proved F-116's boot refusal fires in the real image. The criterion now
  reads against the artifact this repository actually produces. It is not a weakening: an
  image that serves `/health` with correct provenance is the whole of what TASK-003 was
  ever able to build.
- **AC-115 is minted** for the compose criterion and is **not** TASK-003's. It goes to
  TASK-059 with a fresh rework budget, because TASK-003 has spent 4 of its 5 rounds and
  new scope in a last round is how a cap stops meaning anything.
- **AC-7 is untouched.** It was met live on 2026-08-06 and verified by curl at 200
  `text/html`. Where the web app deploys is a separate question from where the API does,
  and this amendment does not reopen it.

This STORY now holds 7 ACs. AC-115 is CI-and-shell-level rather than a vitest test, like
AC-5 and AC-113 before it.

## Amendment A-9 — AC-116 minted for the logging opt-out class (2026-08-11, ruled by Juano)

`logging-and-headers.md` says the pino pipeline is consumed by "every API TASK. Nothing may
opt out." **That is measurably false and has been since before TASK-003 closed.** F-278
established the class: `apps/api/src/db/client.ts:55` and
`apps/api/src/tenancy/tenant-context.ts:136` each construct `Logger` from `@nestjs/common`,
reaching neither pino, nor the field allowlist, nor any of the seven doors. They write
unstructured, uncensored, ANSI-coloured lines to the same stdout the JSON goes to.

F-247 is the sharp end of it: `tenant-context.ts:247` logs a raw `error.message` on a
per-request tenant path — the exact field ADR-0028's policy makes default-deny everywhere
else. A pg error there carries the DSN; an application hook's error can carry row data.

**Why it needed an AC rather than a fix.** F-247 had no owner able to take it: `tenancy/**`
is TASK-005's and TASK-005 is `done`; TASK-003 owns the logging policy but not that path, and
its own card says so under "Not this TASK's, routed away". It was re-routed to TASK-003 by the
re-scope sweep and sat ownerless for a day. This is the fourth time on this initiative that an
obligation with no acceptance criterion turned out to be one nobody checked — the shape that
produced AC-112, AC-113 and AC-114. Juano ruled 2026-08-11: mint the AC, mint **TASK-060** to
carry it with a fresh rework budget, and do not spend TASK-003's reserve round on a finding
discovered after its count was set.

The lint half is load-bearing and is why the AC names it. **F-268's rule bans importing
`pino` and says nothing about Nest's `Logger`**, so the cheapest way to opt out of the entire
policy passes lint today, and a later TASK copying either file inherits the bypass.

The Fly artifacts — `fly.toml`, `infra/deploy.sh`, and the Fly references in
`docs/architecture/migrations.md` and ADR-0027 — are removed under the same ruling, with
an ADR recording that no deploy target is chosen. That discharges **F-142**, which has
been undischarged since 2026-08-05: `migrations.md:120` says the Fly release command runs
migrations while `fly.toml` deliberately has none, which sends a reader to `fly deploy` by
hand against an unmigrated schema with `/health` still reporting green.
