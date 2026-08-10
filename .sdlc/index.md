# shortkit — initiatives

Rebuilt from the state files, 2026-08-09 and again 2026-08-10. Every column below comes from
`<slug>/state.yaml` and the TASK cards rather than from the previous version of this table.
It has now drifted twice — first to `test` while the ledger said `implement`, then to
"TASK-008 is the only TASK with no implementation" after TASK-008 was implemented. Both were
caught by someone reading it for another reason, which is workflow finding F-O's whole point.

| Initiative | Slug | Track | Phase | Wave | Gate | TASKs | Updated |
|---|---|---|---|---|---|---|---|
| Foundation and tenancy substrate | foundation | full | implement | 2 of 2 | implement wave 2 pending | 8 — 5 done, 1 tests-green, 2 rework | 2026-08-10 |
| Publish the shortkit engineering posts | tech-writing | — | refine | — | not started; deferred, blocked by foundation | 0 | 2026-08-10 |

## Roadmap

`.sdlc/roadmap.md` names five further increments. None of them is an initiative yet, and
none carries ids, acceptance criteria or design. Each becomes one at Refine, once the one
before it ships.

## foundation — what is left

Rebuilt 2026-08-10 after a day that closed one GC-9 regression, audited three TASKs for the
first time, and found two blockers in code every gate called green.

- **TASK-003** — API deployable on Fly.io with a health endpoint. **Code-clear**: 46 of 49
  findings fixed, no blocker, no major, both round-7 auditors `clear`. **Blocked on
  infrastructure only Juano can create** — `shortkit-api.fly.dev` is NXDOMAIN from Fly's own
  nameservers and nothing has ever been deployed, so AC-6's opening clause has never been true.
- **TASK-006** — Cross-tenant isolation harness. Blocker F-293 closed and proven both ways on
  one mutation: the old harness reported PASS with exit 0 while a tenant read another tenant's
  row; the new one exits 1. Six negative controls now ship, so the audit's measurements run on
  every CI run. Re-audit in flight.
- **TASK-008** — Web typed API client. Implemented and green, then its first audit returned
  **1 blocker and 6 majors**. Rework in flight: contract decisions landed (ADR-0029), red step
  next.

Everything else is `done`. Gates: unit 137/137, integration 48/48, drift 6/6, typecheck, lint,
build and the RLS policy gate all 0.

**Re-scoped 2026-08-09** from 6 EPICs and 58 TASKs to EPIC-001 alone. See `foundation/plan.md`
for what changed and `roadmap.md` for where the rest went. The re-scope also produced a defect
class of its own — obligations left on deferred cards that surviving work still owed — which
cost two blockers before it was swept.
