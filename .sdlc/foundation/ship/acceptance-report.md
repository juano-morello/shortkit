---
initiative: foundation
phase: ship
step: 3
kind: initiative-level acceptance
date: 2026-08-11
auditor: sdlc-product-auditor
verdict: changes-requested
---

# Initiative acceptance — foundation

Measured against `refinement.md`'s success criteria and stated outcome, as re-scoped on
2026-08-09. Test counts, gate results and AC-6/AC-115 measurements are taken from the
orchestrator's clean-tree run and were deliberately not re-executed; an integrator owns
Docker concurrently. Everything below is derived from the artifacts and the source tree.

---

## Part 1 — What this initiative, as re-scoped, actually claimed

Derived from four sources, not from a summary: `plan.md`'s re-scope note and SC→AC table,
`EPIC-001.md`'s own outcome and re-scope block, and the four surviving STORY cards.

**Exactly one success criterion is claimed, and only its first clause: SC-1.**

`plan.md`'s SC→AC table says so directly — SC-1 "partially", SC-2 through SC-7 "no",
SC-8 gone to `tech-writing` under Amendment A-3. Nothing in the four surviving STORIEs
contradicts it.

Which part of SC-1 is claimed, clause by clause:

| SC-1 clause, verbatim | Claimed? |
|---|---|
| "An automated suite attempts cross-tenant reads and writes" | **claimed** — STORY-003, AC-8…AC-12 |
| "through every repository method and every authenticated endpoint" | **not claimed.** Zero repository classes and zero authenticated endpoints exist. `@TenantScopedRepository()` throws `not implemented` (`apps/api/src/tenancy/tenant-context.ts:400`); the only route in `AppModule` is `GET /health` |
| "All attempts return zero rows, 403, or 404. Zero leaks." | **claimed**, over the two tables that exist |

**The structural fact behind the re-scope, which the SC table alone does not show.** Twenty
acceptance criteria are live in this initiative. Five of them (AC-8…AC-12) answer to a
success criterion. **The other fifteen answer to no success criterion in `refinement.md`
at all** — they answer to EPIC-001's outcome sentence, "a deployable, CI-gated monorepo
whose data layer cannot be read across tenants." STORY-001, STORY-002 and STORY-004 carry
no SC between them.

That is legitimate for foundation work and it is not a criticism of the re-scope. It is
worth stating plainly because it means **`refinement.md`'s success criteria are not the
measure of this initiative.** EPIC-001's outcome statement is. Anyone quoting an SC
scoreboard for `foundation` is quoting the wrong instrument.

---

## Part 2 — Are the claimed criteria met

### SC-1 — verdict: **not yet measurable**

Not "met", not "partly met". Stated as one word because the ask was to avoid splitting the
difference, and because both alternatives let a later reader quote a fraction.

**Why not "met".** SC-1's operative quantifier ranges over "every repository method and
every authenticated endpoint". Both sets are empty. A universally quantified claim over an
empty domain is vacuously true, and vacuous truth is not evidence — it is the exact shape
this initiative's own harness spent three audit rounds learning to refuse (`coverage.ts`
F-295: an empty census is "the state in which every attempt in the run passes vacuously").

**Why not "partly met".** A fraction implies the covered part is a proper share of the
whole. Count what the production surface actually is:

- **One migrated table.** `apps/api/drizzle/0000_odd_betty_ross.sql` creates `tenants` and
  nothing else. Four bespoke policies.
- Of the sixteen attempts against it, **four prove that a DELETE policy is absent**, not
  that one is correct — `registrations.ts:511-528` says so itself.
- The second registered table, `rls_fixture_rows`, is a fixture the suite creates and drops
  per run. It exercises the production policy builder `tenantScopedPolicies()`, which is
  real and load-bearing evidence — but it is not a table the system has.

So the denominator is not "most of the system". It is one table, and SC-1 is a claim about
a system.

**What is genuinely proven, and it is not small.** The instrument works. Eleven negative
controls, each real DDL against a real database, each named for the audit finding that
measured this harness reporting `pass` over a database that was not isolated; one positive
control (`isolation_guarded_check_canary`, F-344) so a correct table cannot be reported as
leaking; a five-arm registry-versus-database drift check that fails closed and names the
table (`coverage.ts:749`); a declared-qualification check derived from the compiled SQL
rather than trusted (F-345); and a three-write `report.json` protocol that cannot strand a
stale or self-contradicted pass (F-304, F-331). The escape hatch fails closed too —
`databaseTransaction()` at `apps/api/src/db/client.ts:186` sets no context flag and
therefore sees zero rows on every tenant-scoped table.

**This is not filed as a finding.** `plan.md:124-129` states the boundary in stronger terms
than I would have, the suite prints it on every run and writes it into `report.json`, and
roadmap item 4 carries the remainder explicitly. The gap is published, not hidden. That is
the correct handling; the only thing at risk is somebody later quoting "SC-1: partial"
without the paragraph underneath it.

### SC-2 … SC-7 — not claimed, not built, correctly routed

| SC | Where it went | Anything built here? |
|---|---|---|
| SC-2 redirect latency | roadmap 2 | No. No redirect module, no cache, no load test |
| SC-3 cache invalidation | roadmap 2 | No |
| SC-4 custom domains | roadmap 3 | No. `reserved-hostnames.ts` ships as throwing stubs — see below |
| SC-5 `(domain_id, slug)` | roadmap 2 | No. `slug.ts` ships as throwing stubs |
| SC-6 click events | roadmap 2 | No |
| SC-7 degradation / branded 404 | roadmap 2 | No. `apps/web/app/not-found.tsx` is the framework 404, not the branded/fallback surface A-4 defines |

### SC-8 — out of the initiative since 2026-08-03 (Amendment A-3). Nothing to verify.

---

## Part 3 — Global Constraints: which could be satisfied, and which nobody could test

A constraint nobody could test yet is a different thing from one that failed, and the two
should never appear in the same column.

**Could be satisfied here, and were:**

- **GC-5 — the RLS transaction rule.** The core deliverable, and the strongest thing this
  initiative produced. `withTenantTransaction` binds context transaction-scoped via
  `set_config(..., true)`; the un-scoped escape hatch fails closed; `db:check-policies`
  runs as `shortkit_app` in CI; the isolation suite runs against a role holding neither
  SUPERUSER nor BYPASSRLS. One caveat stated rather than absorbed: "no query path may
  bypass this" is enforced today by construction and by review, not by a lint rule or an
  architectural test — there is nothing that stops a future module reaching for
  `databaseTransaction()`. It fails closed if one does, which is why this is a note and
  not a finding.
- **GC-7 — one backend and one frontend deployable.** Two apps, one shared package, no
  third service.
- **GC-4 — no AI attribution.** Zero matches across the whole history.
- **GC-9 — structured logs via pino**, in the half that has a subject: AC-116 and ADR-0028's
  field allowlist close the "any other logger" class. `ip_hash` has no subject yet.
- **GC-15 — no decision citing an uninterviewed user.** Nothing downstream cites demand.

**Could be satisfied here, and were not:**

- **GC-13 — "README stays current."** See blocker 1. This is a Global Constraint failure,
  not a documentation preference.

**Could not be tested, because the work they constrain is on the roadmap:**

GC-1 (p99 ≤ 25 ms at 500 RPS), GC-2 (5-second destination edits), GC-6
(`(domain_id, slug)` uniqueness), GC-8 (no 5xx to a visitor). All four bind a redirect path
that does not exist. `plan.md:35` keeps them verbatim so roadmap item 2 inherits them
intact, which is the right disposition.

**Partly measurable:**

- **GC-3 — infra under $25/month.** Trivially satisfied today: the only deployed component
  is `apps/web` on Vercel's free tier, and the component the constraint was actually written
  about — Upstash pay-as-you-go under SC-2's benchmark — does not exist. The constraint has
  not been exercised as a design input.
- **GC-10** — TASK ids are in every commit subject; the `feat/` branch prefix is unmet
  whole-repo and is a retro item, excluded from this audit by instruction.
- **GC-11** — one self-reported breach on record (F-361, parked): the main loop appended a
  `Logger` import to `apps/web/src/lib/api/client.ts` to verify a lint claim and destroyed
  an implementer's uncommitted work. Reverted, disclosed. Noted for the retro.
- **GC-14** — sizing did not hold. TASK-002, TASK-003 and TASK-006 each ran four or five
  rework rounds. Retro material, not acceptance material.

---

## Part 4 — Is the substrate one thing, or ten TASKs that each passed?

**It is one thing vertically and not yet one thing horizontally, and the seam is named
rather than hidden.**

The vertical is real and it is deep. A future schema TASK gets a genuinely composed path:
declare the table in `src/db/schema/`, apply `tenantScopedPolicies()` from `src/db/rls.ts`,
query it only through `withTenantTransaction`, add **one** `registerTenantScopedSurfaces()`
call in `registrations.ts` — and it inherits eight statement shapes in both directions,
eleven negative controls, a five-arm drift check that fails the run if it *forgot* to
register, `db:check-policies` in CI, and a `report.json` that states its own boundary.
Forgetting a step fails closed and names the table. That is a substrate, and it is the part
of this work that answers the Problem statement's "proving tenant isolation instead of
asserting it."

The horizontal does not exist. **Nothing joins HTTP to the data layer.** The three
decorators that would do it — `Public()`, `NoTenantTransaction()`, `TenantScopedRepository()`
— all throw `not implemented` (`tenant-context.ts:358, :393, :400`). There is no guard, no
interceptor, no request-scoped tenant binding, and no repository base class. The web client
is complete and targets a BFF proxy route that does not exist and answers 404. So the next
initiative does not extend a working request path; it builds the first one.

**Is a substrate with one tenant-scoped table a foundation or a demonstration of one?** It
is a foundation for the mechanism and a demonstration for the claim. The distinction matters
because the two are documented asymmetrically: every internal artifact prints the boundary,
and the one artifact an evaluator reads does not. That asymmetry is blocker 1, and fixing it
is what makes the honest version of this work also the persuasive one.

**Bearing of the 83 open minors/nits and 15 parked findings.** No individual item bears on
the outcome. One pattern does, and it is blocker 2: six known-open obligations belong to
deferred work and have no carrier past this initiative.

**F-018 specifically, as asked.** It bears on no success criterion this initiative claimed
and on no shipped surface: the `@Public()` invitation routes it names do not exist, no rate
limiter exists, and `trustedClientIp` is a stub. Its reopening is a design-state carried
forward, not a live exposure. What it does bear on is the handoff — see blocker 2.

---

## Findings

### Blocker 1 — the README describes three subsystems that do not exist, to the one user who only reads

`README.md:10-16`, `:25`, `:26`.

- `:14-16` — "**The redirect path stays isolated.** It reads a cache, falls back to one
  parameterised statement, and imports nothing from the management API. No ORM runs on it."
  There is no redirect path, no cache, and no fallback statement. Present tense, three
  sentences, all future.
- `:25` — `apps/api` is described as carrying "Management API under `/api`, `GET /health`
  at the root, **and the redirect**". Only `GET /health` is registered in `AppModule`.
- `:26` — `apps/web` is described as a "Next.js App Router **dashboard**". It is one static
  page with an `<h1>` and a sentence, plus a 404.
- `:10-13` — "Isolation gets proven by a suite that runs against a real database, not
  asserted in a comment." True, and stated without the coverage boundary that `coverage.ts`,
  `report.json`, `plan.md` and `roadmap.md` all insist on carrying every single time.

**Failure scenario.** The evaluator is `refinement.md`'s third named user, and under the
portfolio-first framing the refinement itself adopts, "**the user who decides whether this
initiative was worth building**". They never create an account; the README is their entire
experience. They read four confident claims, clone, and find one table, one route and one
page. The specific thing damaged is the specific thing this repository exists to
demonstrate — that its author distinguishes proving from asserting. A README that asserts a
redirect hot path in a repository with no redirect is the strongest available counter-example
to the project's own argument, and it sits above the fold.

The rest of the README already does this correctly, which is what makes it a defect rather
than a style preference: `:82-95` ("What a green stack does not give you") and `:104-112`
(build provenance is not sticky) are scrupulous, measured and unflattering. The bottom of
the file is written to the standard the top of it is not.

**Required change.** Present tense for what exists; the unbuilt parts named as roadmap
rather than as architecture; the isolation claim carrying the same boundary the suite prints
on every run. This also discharges GC-13.

### Blocker 2 — six known-open obligations have no carrier past this initiative

`.sdlc/roadmap.md`, and `.sdlc/foundation/findings.yaml`.

`roadmap.md` is where the next initiative starts, and it says so: each item "starts from
Refine against whatever the shipped system has taught by then", and the deferred TASK cards
are to be read "as history". It carries three follow-up cards (ADR-0041, ADR-0042, F-369),
the isolation-harness method note, and two things "the old plan already knew". It carries
none of the following:

| Obligation | Status today | Inherits it |
|---|---|---|
| **F-018 reopened** in compose, CI and local dev by the 2026-08-11 fail-open ruling. Closes in production only when TASK-009 lands the boot assertion | record still reads `status: fixed`; the reopening is a note inside it | roadmap 1 |
| **ADR-0040:277** — "TASK-009 gains a second boot assertion", `assertTrustedClientIpHeaderConfigured`. **`TASK-009.md` does not mention ADR-0040, the assertion, or F-018** | recorded in the ADR only | roadmap 1 |
| **F-036** (parked, major) — the rate-limit port still documents its principal as the pre-F-031 "platform-trusted client IP" | parked | roadmap 1 |
| **F-037** (parked, major) — `resolveRateLimitPrincipal` / `assertBffProxySecretConfigured` assigned to a TASK that moved the work away | parked | roadmap 1 |
| **F-300 / F-362** (parked, major/minor) — invitation-tokens.md invariant 5 is false the moment the accept screen exists; the raw token is in the path too | parked | roadmap 1 |
| **F-350** (parked, major) — ADR-0019's drift fix reached the isolation suite and not the GDPR paths | parked | roadmap 4 |

**Failure scenario.** A refiner opens roadmap item 1 in some weeks, reads `roadmap.md`, and
plans identity and invitations. Nothing they read mentions that the invitation routes were
already found unlimited, that the ruling which closed it was withdrawn in every environment
that exists, or that the boot assertion which restores it is an unwritten obligation on a
deferred card that does not mention it. `findings.yaml` is 770 KB and the F-018 record's
status field says `fixed`. The finding is rediscovered by a security auditor two phases
later, or it is not rediscovered.

This is the F-142 shape, and this initiative has now named it at least four times in its own
logs — F-142 itself, the AC-112/113/114/116 mintings ("an obligation with no AC is one nobody
checks"), the "seven structured fields that lagged the prose" count on 2026-08-11, and the
roadmap's own reason for recording the three ADR-owed cards: *"the architect flagged that it
could not create them; recorded here so the obligation survives, which is the F-142 lesson."*
The same reasoning applies to these six and was not applied. Ship is the last gate at which
this record is still in one place.

**Required change.** A "Carried forward" block in `roadmap.md` naming each item above, the
roadmap entry that inherits it, and the ADR or finding that rules it. The F-018 record keeps
`status: fixed` — that call was right — but the roadmap has to say the invitation routes are
unlimited by decision in every environment that exists.

### Major 1 — AC-115 is now the only evidence the system runs, and nothing re-verifies it

`scripts/check-compose-stack.sh`.

The script is referenced by nothing: not `.github/workflows/ci.yml`, not any `package.json`
script, not `docs/`. Its own header shows it being invoked by hand. It was run once, on
2026-08-11, and passed fifteen clauses.

Amendment A-8 removed the deploy clause from AC-6 and minted AC-115 in its place, on the
reasoning that "the criterion that matters now is that the whole stack comes up from nothing
with one command." That makes AC-115 the sole demonstration that this substrate runs as a
system rather than as a test suite — and it is the one claim in the initiative with no
regression gate behind it. CI never builds the Compose stack. A change to `Dockerfile`,
`docker-compose.yml`, the roles SQL, the migrate service or the seed breaks it silently, and
the next person to find out is the next person to clone.

The project already holds itself to the opposite standard, in `roadmap.md:67`: negative
controls ship "so those measurements run on every CI run rather than once on the afternoon
somebody thought of them."

**Required change.** Wire the script into CI, or into a scheduled job, or record on the
roadmap that it is a manual gate with a named cadence. Not a blocker: AC-115 as written asks
for a `docker compose up` and got one.

### Minor 1 — dead surface for deferred EPICs ships from the published entry point

- `packages/contracts/src/roles.ts` (166 lines, 4 throwing functions) — TASK-016's consumer
  is deferred with EPIC-002
- `packages/contracts/src/slug.ts` (69 lines, 2 throwing) — SC-5, roadmap 2
- `packages/contracts/src/domains/reserved-hostnames.ts` (68 lines, 3 throwing) — SC-4,
  roadmap 3. Named on no live TASK card
- `packages/contracts/src/pagination.ts` — zero consumers
- `apps/api/src/tenancy/tenant-context.ts:358, :393, :400` — three throwing decorators

`RESERVED_HOSTNAMES`, `Paginated` and `slugSchema` have no importer anywhere outside their
own module. All of it reaches consumers through `src/index.ts`, the package's single
sanctioned entry point. ADR-0039 retired the 29 *design* stubs at the design gate; the
already-materialised copies stayed in the source tree, and the 2026-08-09 re-scope did not
sweep them. They fail loudly if called, which is why this is minor and not major — but it is
carrying cost and review surface the re-scoped initiative never asked for.

### Nit 1 — AC-107's "each listed command exits 0"

`README.md`'s command tables also list `pnpm test:integration` and four `docker compose`
forms, none of which exits 0 without Docker. AC-107 enumerates five commands (install, test,
lint, typecheck, build) and the natural reading is that "each listed command" means those
five, which is how it was verified. Recorded because the sentence supports the other reading.

---

## Shipped but not asked for

Minor 1 is the whole of it: roughly 330 lines of contracts and tenancy surface whose only
consumers are deferred TASKs. Everything else in the tree traces to a live AC.

Two things I checked and cleared: `docker-compose.test.yml` serves the AC-5 integration job;
`apps/api/test/security/security-headers.int-spec.ts` traces to ADR-0022 under TASK-003.

## Out-of-scope items that got built

**None.** Every non-goal in `refinement.md`'s Out section is absent from the tree:
password-protected links, bulk CSV import, analytics and reporting, campaign/UTM governance,
the MCP server, smart routing, client-facing reports and billing, SSO/SAML,
internationalisation, native mobile, Postgres-loss degraded mode, multi-region redirect.
The re-scope held.

## Outcome assessment

**Does this deliver the outcome in `refinement.md`?** No, and it was never going to — the
2026-08-09 re-scope deliberately deferred that outcome. `refinement.md`'s outcome is "a
running, publicly reachable micro-SaaS where launching to real agencies would be a business
decision rather than an engineering one." What shipped is a substrate with one table, one
route and no product. That is not a failure; it is the re-scope working as designed, and
`plan.md:131-136` says so in the plainest terms available.

**So the question that matters is the one EPIC-001 actually took on:** "a deployable,
CI-gated monorepo whose data layer cannot be read across tenants," restated by `plan.md` as
"a deployable, CI-gated monorepo, **on the internet**, whose data layer refuses to answer a
query issued without tenant context, with one shared contracts package and a uniform error
surface."

Measured clause by clause:

- **"whose data layer refuses to answer a query issued without tenant context"** —
  delivered, and this is the strong result. AC-10's test, `databaseTransaction()`'s
  fail-closed default, four policies on the one real table, `db:check-policies` in CI, and
  a harness whose eleven negative controls make its own blind spots a thing that runs rather
  than a thing somebody remembered.
- **"CI-gated"** — delivered. `quality` and `integration` jobs, an `always()` gate job,
  a contract-drift check, an inlined-secret scan, a collected-tests assertion, a dependency
  audit.
- **"one shared contracts package and a uniform error surface"** — delivered. Single entry
  point, no subpath keys, typecheck coupling proven by a CI script rather than by assertion.
- **"deployable"** — delivered as an artifact: the production image builds, serves `/health`
  with correct provenance, and refuses to boot if it cannot establish that its role cannot
  bypass RLS.
- **"on the internet"** — half. `apps/web` is live on Vercel (AC-7, verified by curl). The
  API has no deploy target by Juano's ruling in ADR-0030. **Not filed, by instruction**, and
  recorded here only because the outcome sentence contains the words.

**The judgement.** The substrate is coherent and the engineering behind it is the good kind:
three blockers on the isolation harness were each closed by measuring a real leak in a real
database and then shipping the measurement as a control, and the artifacts refuse to
overstate what a green run means. Two things stand between that and a defensible ship. The
README claims a system that does not exist, to the exact reader this whole initiative is
addressed to — which inverts the credibility the work earned. And six known-open obligations,
four of them security-relevant, are about to fall out of the record at the one handoff where
they are still in one place.

Both are cheap. Neither is code. Until they are fixed, the honest summary of `foundation` is
better than what a reader of it will actually get, and that is a strange way to lose.

**Verdict: changes-requested.**
