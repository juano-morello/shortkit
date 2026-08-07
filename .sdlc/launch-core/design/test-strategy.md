---
id: test-strategy
slug: launch-core
status: draft
date: 2026-08-04
depends_on_adrs: [ADR-0001, ADR-0018, ADR-0019, ADR-0020, ADR-0003]
---

# Test strategy — launch-core

The brief every `sdlc-test-architect` dispatch works from. It assigns each acceptance
criterion to a layer, names the fixtures that prove it, and lists what this initiative
leaves unautomated.

ADR-0001 already chose the frameworks. This document allocates the 107 acceptance
criteria across the layers it established.

## Scouting note

I skipped the `sdlc-scout` dispatch in step 1. The repository holds three files outside
`.sdlc/`: two agent definitions and `.gitignore`. Nothing exists to discover, match, or
ground against. Design recorded the same absence twice, which makes this the third
time; the defect sits in the workflow rather than in this phase's execution. See
*Sequencing constraint*.

## Layers

ADR-0001 established two vitest commands. ADR-0018 added a third gate that runs k6
instead. Every AC lands in exactly one of the three.

| Layer | Command | Files | External services | CI job |
|---|---|---|---|---|
| Unit | `pnpm test` | `**/*.spec.ts` in all three workspaces | none | `quality` |
| Integration | `pnpm test:integration` | `apps/api/test/**/*.int-spec.ts` | Postgres 17 | `integration` |
| Performance | k6 | `.github/` + harness | Postgres, Redis | `performance`, `performance-full` |

`pnpm test` stays free of Docker and network so AC-1 holds from a clean clone. Any test
needing a live Postgres therefore belongs in the integration layer, even where it would
sit better beside its unit neighbours.

### What goes where

**Unit.** Pure logic and anything mockable at a genuine external boundary: short-code
generation and collision retry, expiry evaluation, slug validation, the error envelope,
zod contract schemas, cache key shape, branding resolution, rate-limit bucket
arithmetic, DNS verification state transitions (against `FakeDnsResolver`), and React
components that render synchronously.

**Integration.** Anything whose correctness *is* the database behaving under a real
policy. Row-level security cannot be faked in a mock: a mocked repository proves the
mock honours tenancy, not that Postgres does. So every RLS policy, the
`withTenantTransaction` helper including context non-leakage across pooled connections,
migration ordering, cascade deletion under GDPR erasure, the audit-log subscriber, and
the whole SC-1 isolation suite.

**Performance.** SC-2 only. Gated on `serverP99` from the `Server-Timing` header,
median of three runs at 100 RPS on PRs, full 500 RPS run weekly. Never asserted from a
vitest test.

## Story → layer allocation

| Story | ACs | Layer | Fixture dependency |
|---|---|---|---|
| STORY-001 Monorepo scaffold | 5 | unit | — (see *Sequencing constraint*) |
| STORY-002 Deployable skeleton + CI | 5 | **exempt + CI** | no vitest tests; see *Deliberately not automated* |
| STORY-003 Tenant-scoped persistence | 5 | **integration** | two-tenant, non-`BYPASSRLS` role |
| STORY-004 Contracts + error surface | 3 | unit + **build** | — (AC-14 is a build property, see below) |
| STORY-005 Signup, login, verification | 10 | unit + integration | fake mail sender, live DB for user rows |
| STORY-006 Agency + client workspaces | 5 | integration | two-tenant |
| STORY-007 Members and roles | 7 | integration | two-tenant, role matrix |
| STORY-008 Email invitations | 5 | unit + integration | fake mail sender, token clock |
| STORY-009 Link CRUD, short codes | 7 | unit + integration | two-tenant, seeded collision |
| STORY-010 Expiry and activation | 4 | unit | deterministic clock |
| STORY-011 Redirect hot path | 8 | unit + integration | fake Redis, then live |
| STORY-012 Click events | 7 | integration | two-tenant, append-only assertions |
| STORY-013 Latency commitment | 4 | **performance** | k6 harness, `baseline.json` |
| STORY-014 Domain add + DNS verify | 5 | unit | `FakeDnsResolver` |
| STORY-015 Automated TLS | 4 | unit + manual | provider client mocked; live path manual |
| STORY-016 White-label surface | 5 | unit | branding port |
| STORY-017 Audit log | 4 | integration | two-tenant |
| STORY-018 Per-tenant rate limiting | 5 | unit + integration | fake clock, in-process limiter |
| STORY-019 GDPR export + deletion | 7 | **integration** | two-tenant, cascade assertions |
| STORY-020 Proven isolation (SC-1) | 4 | **integration** | full harness, discovery |
| STORY-021 Apex marketing page | 3 | unit | — |

Three stories resist the unit layer entirely: 003, 019 and 020. Each turns on the
database enforcing something rather than the application requesting it, so a unit test
would assert the mock.

## Fixtures required

None of these exist yet. The table names the TASK that produces each one.

| Fixture | Produced by | Needed by |
|---|---|---|
| `docker-compose.test.yml` (Postgres 17) | TASK-005 (assigned by F-038) | every integration test, locally |
| CI `integration` job + `postgres:17-alpine` service | TASK-002 (assigned by F-039) | every integration test, in CI |
| Migration runner invoked before the suite | TASK-005 | every integration test |
| Non-`BYPASSRLS` application role | TASK-005 | every RLS assertion |
| `createTenantFixtures()` → two isolated tenants | TASK-006 | 003, 006, 007, 009, 012, 017, 019, 020 |
| `assertNoCrossTenantAccess()` + `isolationReport()` | TASK-006 | STORY-020 |
| `FakeDnsResolver` | TASK-039 | STORY-014 |
| Fake mail sender (`mail-sender.md`) | TASK-010 | STORY-005, STORY-008 |
| Deterministic clock | **nobody — convention only** | STORY-010, STORY-018, token expiry |
| `infra/loadtest/baseline.json` | TASK-036 | STORY-013 |

Eight stories depend on the two-tenant fixture, more than on anything else here, and it
does not arrive until TASK-006 in wave 2. Tests for those eight cannot be verified red
before wave 2 completes.

One row still has no producer. No ADR or TASK establishes how tests control time, and
three areas need it: link expiry, rate-limit windows, token lifetimes. Left alone,
`sdlc-test-architect` will pick a different approach per story. Whoever writes the first
such test should settle on one convention, either vitest's `vi.useFakeTimers()` or an
injected clock port, and the rest follow it. Too small to file as a finding, big enough
to go wrong three separate ways.

The first two rows had no producer either when this document was drafted. Juano ruled
on both on 2026-08-04, and the TASK files now carry the work. See *Defects found while
writing this*.

## Deliberately not automated

Each of these carries a reason.

- **Live DNS resolution and TLS issuance.** `FakeDnsResolver` (TASK-039) makes the
  verification state machine and the diagnostics UI testable without a registered
  domain. AC-67's live form waits on wave D. STORY-014 already carries the instruction
  to record its unit-level pass as **provisional**, so `sdlc-product-auditor` does not
  read it as end-to-end.
- **Real email delivery.** ADR-0017 caps the provider at 100 messages a day, which
  manual signup and invitation testing will consume on its own. Automated tests use a
  fake sender and assert the message was handed over, not that it arrived.
- **Deployment itself.** TASK-003 and TASK-004 produce deployed URLs. Hit those URLs to
  confirm Fly and Vercel served them. No test in the suite covers it.
- **AC-112 as a vitest test (TASK-009).** Ruled by Juano 2026-08-06. AC-112 has two halves and
  neither belongs in the suite.

  The first is greppable — `apps/api/package.json` must declare `better-auth` with no range
  character. The second is a property of a **report**: TASK-009 must record the four ADR-0018 Better
  Auth facts verified against that exact release. A test asserting a report contains four sentences
  is not a test.

  **`sdlc-product-auditor` verifies both**, which is what AC-112 was minted for. F-050 created it
  precisely because the product auditor checks ACs verbatim and would otherwise never check the pin —
  so routing it back to that auditor is the mechanism working as designed, not a gap.

  Testing the manifest half alone was offered and declined: it is a test of a manifest rather than of
  behaviour, and this initiative already declined that shape once when AC-2's literal reading was
  amended rather than tested. Folding it into CI was declined because TASK-002 owns `.github/**` and
  is done, so it would reopen a merged TASK while still leaving the four-facts half to the auditor.

- **AC-6's deployment half only (TASK-003).** Ruled by Juano 2026-08-06, and this one is a **split**
  rather than a whole-AC exemption, which is why it reads differently from the two below.

  AC-6 asserts that the API *deployed to Fly.io* answers `GET /health` over HTTPS with `status: "ok"`
  and a `commit` matching the deployed git SHA. Part of that is genuinely testable in process and
  part is not, and the two halves fail in different ways.

  **Tested, with a real red step:** the app boots, `GET /health` returns 200, the body carries
  `status: "ok"`, and `commit` is read from the build-time SHA source rather than being empty,
  hardcoded, or a placeholder. That last clause is the one worth the test — a health endpoint
  reporting a stale or empty commit is precisely what makes a deploy unidentifiable, it regresses
  silently, and no other gate would notice.

  **Exempt, no red step available:** "deployed to Fly.io" and "over HTTPS". A test against the live
  URL reports green or red for reasons unrelated to the code — Fly being down, DNS, deployment
  protection — and cannot go red before the first deploy exists, which is the same reasoning that
  exempted AC-7. `sdlc-product-auditor` verifies this half against the deployed URL.

  TASK-003 is therefore **not** `test_exempt`. It carries a real failing test for the handler.

- **AC-7 as a vitest test (TASK-004 `test_exempt`).** Ruled by Juano 2026-08-05. The entry
  above anticipated this, but the decisive reason is sharper than "deployment is hard":
  **there is no red step available.** The tempting in-process proxy — render `app/page.tsx`,
  assert HTML — *passes today*, because TASK-001 already shipped `page.tsx` and `layout.tsx`.
  A test that cannot go red proves nothing, which is the standard the bootstrap ruling already
  applied. It would also report green through a 404 from a wrong monorepo root directory, a
  500 from missing build-time env, or a 401 from Vercel deployment protection, which is on by
  default. Verified by `sdlc-product-auditor` hitting the deployed URL.
- **AC-5 as a vitest test (TASK-002 `test_exempt`).** Ruled by Juano 2026-08-05, and **not**
  covered by the deployment entry above — CI is not deployment. This is AC-14's reason: the
  clause carrying the AC's intent, "concludes `failure` if any one of them exits non-zero", is
  GitHub Actions runner semantics rather than a property of any importable value, and the only
  in-process assertion available is an open-ended negative. A test enumerating
  `continue-on-error`, `|| true` and `set +e` passes a workflow that uses the fourth evasion.
  Two supporting facts were verified rather than assumed: nothing hosts such a test today (no
  vitest project collects a file under `tools/`, and `vitest run <path>` reports no test files),
  and **no YAML parser resolves in any workspace** (`MODULE_NOT_FOUND` for both `js-yaml` and
  `yaml`), which leaves regex-over-YAML — named as a warning sign in `writing-good-tests.md`.
  `sdlc-test-architect` called clauses 1 and 2 parse-assertable and the overall call close;
  F-039 is exactly the missing-job defect, so this is not a comfortable exemption.
  **What verifies it instead:** the workflow running in CI, plus `sdlc-product-auditor` reading
  it against AC-5 and AC-114. TASK-002 also carries a recommendation to declare a `gate` job
  with `needs: [quality, integration]` as the branch's required check — Actions rejects a
  workflow whose `needs` names a job that does not exist, which converts a silently dropped or
  renamed job from a green pipeline into a hard configuration error.

**AC-113 and AC-114 (minted 2026-08-05) are CI-level assertions, not vitest tests**, and that
is deliberate. AC-113 searches a production build's `.next/static/**` for the values of
`BFF_PROXY_SECRET` and `API_BASE_URL`; AC-114 asserts the `integration` job collected at least
one test file and at least one test. Both are properties of a build or a pipeline run, so the
suite is the wrong home for them — the same reasoning that exempted AC-5 and AC-14.
- **Async React Server Components.** ADR-0001 records that vitest cannot render them.
  Coverage comes from testing their data functions directly.
- **AC-14 as a vitest test.** AC-14 asserts that an incompatible contract change breaks
  `apps/web`'s typecheck, which is a property of the build rather than of any importable
  value. `sdlc-test-architect` declined to fake it and gave the decisive reason: the obvious
  assertion is **weaker than the AC**, because `pnpm -r typecheck` runs `packages/contracts`
  first and aborts dependents, so a mutation breaking contracts internally exits non-zero
  without `apps/web` ever compiling. The faithful version also mutates a tracked source file
  at runtime and nests a full typecheck inside a 576 ms suite. It belongs in CI: a
  `contract-drift` step under TASK-002's `quality` job asserting non-zero exit **and**
  diagnostics naming a path under `apps/web/`. Recorded here rather than left as a gap.

  **Revised 2026-08-05 (F-091). The check runs two mutations, not one.** TASK-007 added
  `isZodError`, `toValidationDetails` and `FORM_ERROR_KEY` to
  `packages/contracts/src/errors.ts`, and only `apps/api` consumes them. Verified:
  `apps/web`'s only `@shortkit/contracts` import anywhere is `ERROR_CODE_STATUS`, in
  `app/not-found.tsx` and its spec. So an incompatible change confined to those three
  exports fails `apps/api`'s typecheck and never reaches `apps/web`. A check built from
  the `ERROR_CODES`-rename mutation alone would report AC-14 covered while that class of
  change is caught by no gate.

  What the consumer set belongs to is the **export**, not the package, so the assertion is
  "diagnostics name a path in every workspace that consumes the mutated export":

  | Mutation | Consumer | Diagnostics must name |
  |---|---|---|
  | rename an `ERROR_CODES` member and its `ERROR_CODE_STATUS` key together | `apps/web` | a path under `apps/web/` |
  | rename `FORM_ERROR_KEY` and its use inside `errors.ts` together | `apps/api` | a path under `apps/api/` |

  Both mutations keep `packages/contracts` internally consistent on purpose. That is what
  stops `pnpm -r typecheck` aborting on contracts itself and never compiling a dependent,
  which is the weakness the original entry identified.

  **AC-14's literal clause covers only the first row.** An incompatible change to an
  API-only export is caught at build time, but not "because `apps/web` no longer
  compiles". The second row is a wider surface than the AC asserts, recorded here so the
  gap is closed by a decision rather than by nobody noticing. If TASK-002 ships only the
  first row, the API-only exports are an unenforced surface and this entry is the record
  that they are.
- **Upstash in the PR gate.** ADR-0018 uses a local `redis:7-alpine` so the gated number
  measures application overhead rather than network variance.
- **Browser-level checks.** ADR-0001 cites them for async React Server Component
  coverage, but no ADR chose a tool, no TASK produces one, and no AC requires one. Ruled
  manual by Juano on 2026-08-04: the unit and integration layers already cover all 107
  ACs, so nothing in the plan depends on a browser runner. Revisit in a later initiative
  rather than adding scope here.

## Defects found while writing this

Resolving fixture ownership turned up two gaps between what the ADRs require and what
the TASKs produce. Both were filed in `findings.yaml`, and both landed on `tasks/**`, so
routing rule 0 sent them to Juano rather than to an agent. He ruled on both the same
day; the TASK files now carry the work.

- **F-038** — `docker-compose.test.yml` had no producer. ADR-0001 requires it, TASK-001
  excludes "Database" by name, and TASK-005's paths did not reach it. Without the file,
  `pnpm test:integration` cannot run locally at all. **Assigned to TASK-005**, which
  already owns the migration runner and the non-`BYPASSRLS` role, neither of them
  verifiable without a database to apply them to.
- **F-039** — the CI `integration` job had no producer. ADR-0001's follow-ups assigned
  it to TASK-002, but TASK-002's Produces block listed only the `quality` job.
  `pnpm test` is DB-free and would stay green, so CI passes while the whole RLS surface
  goes unexercised and SC-1 reads as proven by a suite nothing invokes. **Assigned to
  TASK-002**, and AC-5 widened to require both jobs. The AC id is unchanged and
  STORY-002 still holds 3 ACs, so nothing downstream renumbered.

ADR-0001 and ADR-0018 both wrote their follow-ups as prose inside the ADR, and nobody
propagated them into the TASK files. Design's `contracts:` injection pass did propagate,
giving all 57 TASKs their contract bindings, but nobody treated "Follow-ups this
creates" as a second propagation source.

## Sequencing constraint

The Test phase requires every new test to fail as an assertion, and rejects a test that
fails on module resolution as proving nothing. That check cannot run here.

There is no vitest, no `package.json`, no `tsconfig`, no `node_modules`. Every test
written against this repository today fails on import, the exact failure mode the phase
forbids. It is also unfalsifiable: an import error looks identical whether the test
encodes its AC correctly or is empty.

TASK-001 creates the runner, and ADR-0001 assigns it both vitest configs plus one
passing DB-free test per workspace. No failing test can precede it, because the runner
for that test is its own deliverable.

`plan.md`'s wave table already encodes most of the answer: wave 0 is TASK-001 alone,
followed by a hard gate re-running `/juano-sdlc init` to populate `testing:` and
`quality:` in `config.yaml`, with no dispatch permitted past that line. The table left
one thing unsettled, which is whether wave 0 runs before or after the Test gate.

**Ruled by Juano, 2026-08-04.** Wave 0 runs first. TASK-001 is marked
`test_exempt: true` with its reason in front-matter, the exemption covers that one TASK,
and every later TASK still gets red tests before an implementer sees it. The order is
therefore: TASK-001 → re-run `/juano-sdlc init` → the Test phase proper for TASK-002
through TASK-058 against a working vitest → the Test gate.

One workflow defect has now surfaced three times: the phases assume a repository that
already builds. Design hit it with stubs and wrote them as inert sources under
`design/stubs/`. Test hits it harder, because "verify red for the right reason" has no
inert equivalent. Recorded for Retro alongside F-M.
