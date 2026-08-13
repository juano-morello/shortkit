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
| Identity, tenancy and membership | identity-membership | full | design | plan **approved** | 17 — all todo | 2026-08-12 |
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
