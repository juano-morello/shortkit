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
| STORY-002 Deployable skeleton + CI | 3 | unit + manual | deploy verification is manual |
| STORY-003 Tenant-scoped persistence | 5 | **integration** | two-tenant, non-`BYPASSRLS` role |
| STORY-004 Contracts + error surface | 3 | unit | — |
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
- **Async React Server Components.** ADR-0001 records that vitest cannot render them.
  Coverage comes from testing their data functions directly.
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
