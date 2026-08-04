---
slug: launch-core
title: Launchable core — tenancy, links, redirect, custom domains
type: feature
created: 2026-08-03
status: approved
---

## Problem

Juano needs a portfolio artifact that shows production engineering judgment to
hiring managers and to a technical audience. A CRUD demo does not show it.
Proving tenant isolation instead of asserting it, keeping a latency-sensitive
path off the ORM, provisioning certificates for domains you do not control:
these decisions separate a senior engineer from a competent one, and they only
appear in a system built under real constraints.

The agency URL shortener forces those constraints. Multi-tenancy is structural
rather than bolted on, the redirect is a genuine hot path, and per-client
branded domains require real certificate automation.

**The market problem it depicts is credible and unvalidated.** Agencies do
juggle per-client branded links across tools, and Bitly, Rebrandly, Dub and
Short.io already serve that need. Shortkit claims no unmet demand. No downstream
decision may cite a user nobody has interviewed; demand stays in the Risks
section.

## Outcome

A running, publicly reachable micro-SaaS where launching to real agencies would
be a business decision rather than an engineering one, plus the writing that
comes out of building it.

"Launch-ready" is the **quality bar**, not the success metric. The system has to
survive production traffic and real customer domains. Whether anyone signs up
does not determine whether this initiative succeeded.

## Users

Three, and they pull in different directions. Naming all three explains why the
success criteria look the way they do.

**The agency operator.** An account manager or social media manager at a small
agency, 2 to 15 people, handling links for 3 to 20 clients. Their flow: sign up,
create the agency, create a workspace per client, point that client's branded
domain at it, create links on that domain, invite a teammate scoped to two
clients and no others. They are the only user who logs in.

**The visitor who clicks a link.** Never authenticates, never sees the product,
and has no idea Shortkit exists. Their entire experience is one redirect that
either resolves fast or does not. SC-2, SC-3 and SC-7 exist for this person, and
they are the reason the redirect path stays isolated from everything else.

**The evaluator.** A hiring manager or a technical reader who arrives through a
post and reads the repository. They never create an account. SC-8 exists for
them, and under a portfolio-first framing they are the user who decides whether
this initiative was worth building.

## Success criteria

- **SC-1 — Tenant isolation is proven, not asserted.** An automated suite
  attempts cross-tenant reads and writes through every repository method and
  every authenticated endpoint. All attempts return zero rows, 403, or 404.
  Zero leaks.
- **SC-2 — Redirect latency is committed and enforced.** A baseline is measured
  during Implement, the target is set from that baseline and recorded, and a
  load test in CI fails when the target regresses. The target may not exceed
  **p99 ≤ 25 ms server-side on the cache-hit path at 500 RPS**. Committing to a
  figure before a baseline exists would be theatre; committing to the mechanism
  and a ceiling is testable today.
- **SC-3 — Cache invalidation is correct, not TTL-dependent.** Editing a link's
  destination is reflected on the redirect path within 5 seconds of the write,
  verified by a test that would still pass with the TTL set to one hour.
- **SC-4 — Custom domains provision end to end with no manual step.** A domain
  goes from added-in-the-UI to serving HTTPS without human intervention. When it
  fails, the UI names the exact DNS record that is wrong.
- **SC-5 — Short codes are unique per domain, not globally.** Two workspaces on
  two different domains can both own `/summer`.
- **SC-6 — Click events accumulate from day one.** The append-only stream is
  populated on the first redirect and is queryable, before anything reads it.
- **SC-7 — The redirect path degrades rather than fails.** With Redis
  unavailable, redirects still resolve correctly via Postgres. No unresolvable
  request returns 5xx to a visitor; it returns the branded 404.
- **SC-8 — DEFERRED OUT OF THIS INITIATIVE on 2026-08-03.** Originally: four
  published posts, each carrying a real artifact. Deferred because the
  publication venue was undecided and the Plan phase found that one candidate
  answer (publishing on the Shortkit site) requires an unplanned blog surface.
  Juano deferred the writing discussion until after implementation. See
  Amendment A-3. **This criterion is not measured by `launch-core`.**

## Scope

### In

- Signup, login, and email verification (Better Auth mounted in NestJS; JWT for
  the web app)
- Agency account (tenant) → client workspaces → members with per-workspace roles
- Member invitations by email, scoped to specific workspaces
- Link CRUD, short-code generation, custom slugs, `(domain_id, slug)` uniqueness
- Link expiry and scheduled deactivation
- Redirect service: cache-first hot path, isolated NestJS module, branded 404
- Per-client custom branded domains: DNS verification, automated TLS
- White-label surface: per-workspace logo, brand colour, branded 404 / fallback
- Click events written as an append-only stream from day one (written in this
  initiative, read by a later one)
- Audit log of link changes: who changed which destination, and when
- Per-tenant rate limiting on API writes
- GDPR data export and account deletion with cascade
- Public marketing / landing page at the apex domain
- Load test with a CI performance gate (SC-2)
- Four published posts (SC-8)

### Out

Explicit non-goals. Everything here was decided, not forgotten.

**Deferred to the next initiative.** Both were on the launch-core list and cut
on 2026-08-03:

- **Password-protected links.** Puts an interstitial on the redirect path, the
  same path SC-2 and SC-7 exist to characterise. Defer it and the hot-path
  numbers publish without a caveat.
- **Bulk CSV link import.** The first slice of SP4 campaign governance. Pulling
  it forward blurs the launch boundary.

**Deferred to later roadmap initiatives:**

- Click analytics dashboards and reporting (SP3)
- Campaign and UTM governance (SP4)
- Remote MCP server (SP5). The API is shaped to serve it; nobody builds it here
- Smart routing, geo/device rules, link-in-bio (SP6)
- Client-facing reports, scheduled digests, billing (SP7)

**Not planned at all:**

- SSO / SAML
- Internationalisation
- Native mobile apps
- **Postgres-loss degraded mode.** SC-7 covers Redis loss only. Serving from a
  stale cache with no source of truth is real design work, and we scoped it out
  on 2026-08-03.
- **Multi-region redirect deployment.** SC-2 is a single-machine commitment.

## Constraints

**Effort and money**

- Roughly 25 hours a week, solo, with no hard external deadline. Size TASKs to
  finish in one sitting where the work allows.
- Infrastructure stays under $25/month total. This is a real design input, not a
  preference: SC-2's 500 RPS benchmark plus a CI gate that reruns it will exceed
  a free-tier Redis request quota, so Upstash runs pay-as-you-go while Neon and
  Vercel stay on free tiers.

**Process**

- Solo development, orchestrated through the `juano-sdlc` workflow. All feature
  code comes from implementer subagents; the main loop does not write it.
- `testing:` and `quality:` in `.sdlc/config.yaml` are currently `null`, because
  the repository was empty at init. **The first TASK scaffolds the monorepo,
  then we re-run `/juano-sdlc init` to populate them.** No other TASK dispatches
  before that. Until it happens, Implement has no quality gates to run.
- This machine has no YAML parser, so nothing has ever machine-validated
  `config.yaml`. Install `yq` before Plan; later phases read that file.
- No AI attribution in any commit, changelog, or release note.

**Already fixed by earlier decisions:**

- TypeScript end to end. Next.js (frontend) and NestJS (backend) only. No
  Next.js backend, no third service.
- Postgres with row-level security; tenant scoping via `tenant_id` and a
  per-request `SET LOCAL app.tenant_id`.
- Drizzle as the data-access layer.
- Redis for the redirect cache and rate limiting.
- Fly.io (API), Vercel (web), Neon (Postgres).
- Better Auth, mounted in NestJS. JWT for the frontend; API keys reserved for
  the future MCP server.
- Short-code uniqueness is scoped `(domain_id, slug)`, never global.
- One backend deployable and one frontend deployable.
- No AI attribution in any commit, changelog, or release note.

## Open questions

| Q | Owner | Blocking? | Answer |
|---|---|---|---|
| Which apex domain does Shortkit run on? Verifying SC-4 end to end needs a real registered domain; custom-domain TLS cannot be tested against a domain nobody owns. | Juano | No (not for this gate) | Unresolved. Must be answered before the custom-domain TASKs are dispatched. |
| Transactional email provider for invitations and verification: Resend, Postmark, or SES? | Design | No | Design decision. Free tier is sufficient at this volume. |
| Test framework: jest (NestJS default) or vitest (shared with the web app)? | Design | No | Design decision. Recorded here so `init`'s null `framework:` is filled deliberately rather than by whichever scaffolder runs first. |
| How does an expired link leave the redirect cache, given nothing writes at expiry time? | Design | No | Design decision. Candidate approaches: bound the cache TTL by time-to-expiry, or sweep on read. |
| Can SC-2's load test run as a CI gate at 500 RPS, or only locally? | Design | No | Unresolved. See Risks. |
| Which roles exist at the tenant and workspace levels? | Juano | Was blocking Plan | **Answered 2026-08-03.** See Amendment A-1. |
| How do SC-6's append-only guarantee and GDPR erasure coexist? | Juano | Was blocking Plan | **Answered 2026-08-03.** See Amendment A-2. |
| Where do the four posts publish? | Juano | Was blocking Plan | **Deferred 2026-08-03.** SC-8 moved out of this initiative. See Amendment A-3. |
| What happens on an unknown slug — branded 404, or a configurable fallback? | Juano | Was blocking Plan | **Answered 2026-08-03.** See Amendment A-4. |

## Risks & unknowns

- **Demand is unvalidated.** Nobody has interviewed an agency. We accept this
  risk rather than mitigate it here, and it sits in writing so no downstream
  decision cites a user nobody has spoken to.
- **The CI performance gate may not survive 500 RPS.** Shared CI runners are
  noisy and rate-limited, and a benchmark that fails at random is worse than no
  benchmark. The likely resolution is a full-rate run on demand plus a
  lower-rate regression check in CI. SC-2 assumes a CI gate exists, so if Design
  cannot get one, SC-2's wording needs revisiting rather than quiet weakening.
- **Better Auth inside NestJS is less well-trodden than Better Auth inside
  Next.js.** The library is framework-agnostic and exposes a node handler, so
  the integration should be straightforward, but this specific pairing has less
  public prior art than the alternative. If it resists during Design, a
  timeboxed spike initiative is the right response, not improvisation.
- **Fly's certificate API has unpublished quotas for large numbers of custom
  hostnames.** Not a launch risk at the volumes this project will see, but it is
  an unknown behind SC-4 and worth confirming before anything depends on it at
  scale.
- **This initiative is large.** Fourteen capability areas, six of them added
  during this refinement. The EPIC/STORY breakdown has to allow a coherent
  partial ship, so that running out of time leaves a smaller working product
  instead of an unfinished one.

## Amendments after gate approval

The Refine gate was approved on 2026-08-03. The Plan phase then found four gaps
that made three STORIEs fail Definition of Ready. Juano ruled on all four the
same day. Each ruling is recorded here rather than merged silently, because
amending an approved artifact is his call and downstream work cites this file.

**A-1 — Role taxonomy named.** "Members with per-workspace roles" never named the
roles, so the membership ACs could not be tested. Resolved: tenant level `owner`
and `admin`; workspace level `workspace_admin`, `member`, and `viewer`.
`viewer` is read-only and nothing in `launch-core` reads it — it exists so the
schema and the authorization checks are correct before SP7 reporting needs it.

**A-2 — Append-only is scoped to the tenant-facing API.** SC-6 and the in-scope
GDPR erasure requirement contradicted each other as written: one said click
events are never deleted, the other said a tenant's rows are gone after account
deletion. Resolved: no tenant-facing interface may delete or mutate a click
event, and account deletion runs as a separate privileged path outside that
interface which does hard-delete rows. Both claims hold under that scoping. This
inconsistency reached the approved gate unnoticed.

**A-3 — SC-8 and the four posts deferred out.** The refinement required four
*published* posts and never said where they publish. Publishing on the Shortkit
site needs a blog surface nobody planned. Juano chose to settle the writing
after implementation, so SC-8, STORY-022 and TASK-058 through TASK-061 leave
`launch-core`. The apex landing page (STORY-021) stays; it is a marketing
surface, not a writing one.

**A-4 — Fallback semantics decided.** "Branded 404 / fallback" never defined
fallback. Resolved as an optional per-workspace fallback URL: an unknown slug
302s there when set, and renders the branded 404 when unset.

## Existing-system notes

Greenfield. The repository contained no source at the time of this refinement.
`git ls-files` returned only the five scaffold files created during
`/juano-sdlc init` (config, index, gitignore, two agent definitions). No prior
art, no conventions to follow, no existing ADRs.

`sdlc-scout` was deliberately not dispatched for this reason, and the decision
is recorded in `state.yaml`.
