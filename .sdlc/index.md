# shortkit — initiatives

Rebuilt from the state files on 2026-08-09, 08-10, 08-11 and again 2026-08-12. Every column comes
from `<slug>/state.yaml` and the TASK cards.

This table drifted three times during `foundation`, each time caught by someone reading a file for
another reason. It is no longer maintained by care alone:
`node ~/.claude/skills/juano-sdlc/scripts/check-ledger.mjs .sdlc/<slug>` runs before every gate
summary and returns non-zero on the inconsistencies that used to reach one.

| Initiative | Slug | Track | Phase | Gate | TASKs | Updated |
|---|---|---|---|---|---|---|
| Foundation and tenancy substrate | foundation | full | **done** | merged `aa9c288`, retro applied and its residue repaired | 10 — all done | 2026-08-12 |
| Identity, tenancy and membership | identity-membership | full | design → test | **wave 2 designed and approved**; waves 0-1 implemented | 19 — 4 done, 15 todo | 2026-08-16 |
| Publish the shortkit engineering posts | tech-writing | — | refine | not started; deferred | 0 | 2026-08-10 |

## foundation — closed 2026-08-12

Merged as `aa9c288` via PR #1, `feat/foundation` into `main`, no history rewritten. Nine days, ten
TASKs, 404 findings, 12 blockers, 47 rulings.

**What shipped.** One migrated table with RLS enforced and forced, a tenant-context transaction
helper, a cross-tenant isolation harness with thirteen negative controls, a shared contracts
package both deployables read as source, an error envelope, structured logging with a field
allowlist no module can opt out of, a typed web API client, a Docker Compose stack that comes up
from nothing with one command, and a four-check CI gate that has now run.

**What it is.** In the acceptance auditor's words: **vertically a foundation, horizontally a
demonstration.** Declare a table, get `tenantScopedPolicies()`, `withTenantTransaction` and one
`registerTenantScopedSurfaces()` call, and you inherit eight statement shapes in both directions
plus a drift check that fails the run if you forgot to register. Nothing yet joins HTTP to the data
layer — the next initiative builds the first request path rather than extending one.

**SC-1 is `untestable`, not partly met.** It quantifies over "every repository method and every
authenticated endpoint" and both sets are empty, so a verbatim reading is vacuously true — the
shape the harness's own F-295 rule refuses.

## identity-membership — waves 0 and 1, 2026-08-14

Four TASKs done. 236 unit tests, 82 integration across six suites, AC-115 green on every clause,
typecheck/lint/build clean. Every gate run rather than read from a report.

**What shipped.** Better Auth's five tables and `tenant_memberships` under one migration system, the
`shortkit_auth` role split with its `REVOKE`/`GRANT` and a two-directional grant matrix, a second
connection pool, `nullif` on every context-flag cast, the token-mint membership lookup and its
policy, the auth and member contracts with branding as a separate step, and a compose stack that no
longer carries a signing key.

**The cross-tenant account takeover is measured shut.** The auditor that reproduced it in Design
re-ran it statement for statement against the real migrated schema: `42501` on every write, while
the tenant-scoped read in the same transaction still returned the acting tenant's row.

**Read F-133 first.** The token-mint escape's only behavioural control passed a policy admitting
every membership row of every tenant — proved by installing that policy and watching the shipped
suite pass 6 of 6. Two other controls were equally blind: views bypassed the grant matrix, the RLS
check and the behavioural control at once, and AC-2's count assertion never observed the table it
counted. **None of the three was found by a test failing.** Each came from someone asking whether a
passing test *could* fail.

**And F-034/F-074/F-081/F-144/F-147 are one story.** Five mechanisms on a single variable, each
ruled after the last broke, each broken by something nobody had checked — ending in an approved,
shipped, `met` criterion in the closed `foundation` initiative being amended from both sides.

## identity-membership — wave 2 design, 2026-08-16

Nine ADRs, two contracts, three stubs, four security rounds, 26 findings. Three fix rounds against
a cap of two, the third scoped by Juano.

**What the wave decided.** The composed Better Auth instance declares what it was otherwise
inheriting: its origin, its cookie policy, its session lifetime, its log level and its issuer. Every
one of those was being taken from the request or from `NODE_ENV`, and each was found by executing
the composition rather than reading it.

**Read F-173 first**: with `BETTER_AUTH_URL` unset, one session produced two validly-signed tokens
with different issuers — same `kid`, same `tid`, both conforming to the claim contract, because the
origin came from the Host header. The only tier that sets that variable is the only tier that
exercises the mount, so **the suite was green on a configuration `pnpm dev` never runs.**

**And F-175 is why it stayed invisible.** `logger.level: 'error'` discarded the one warning that
reports it — the bound hook received zero lines. The justification for `'error'` was a PII leak
that is `logger.info` at the source, so `'warn'` suppresses it just as completely.

**F-188 is the one to read for how the panel works.** The auditor found a real response-shape
divergence and concluded an enumeration oracle from it. The architect disputed the *reasoning* —
the measurement was on the in-memory adapter, and its own stated grounds implied convergence under
the real one — and refused to encode either answer, pre-committing both outcomes to a test. The
auditor then ran it against the real drizzle adapter and **withdrew its own major in writing**.
Three agents and a ruling to establish one fact, and the ledger has no terminal status for
"disproved".

**Six of the 26 findings were introduced by a fix for an earlier finding.** The rounds converged;
the round count does not show that.

## Roadmap

`.sdlc/roadmap.md` names five increments, three follow-up cards owed by ADR-0041, ADR-0042 and
F-369, the generative-mutation question the isolation harness raised, the compose gate's de-gating
fallback, and a **carried-forward block** naming ten obligations that belong to deferred work with
the entry that inherits each. That block exists because a Ship-phase audit found six of them had no
carrier at all — a refiner opens the roadmap, not a 800 KB ledger.

**F-236 is the one to read first**: the GDPR eraser, written the obvious way, erases nothing and
reports success. It is F-002's class — a design blocker fixed at policy level in round 1 —
reappearing at statement level, because the policy fix was verified against the policy set and
never against a statement issued under it.
