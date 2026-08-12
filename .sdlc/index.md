# shortkit — initiatives

Rebuilt from the state files on 2026-08-09, 2026-08-10 and again 2026-08-11. Every column
below comes from `<slug>/state.yaml` and the TASK cards rather than from the previous version
of this table.

It has now drifted three times — first to `test` while the ledger said `implement`, then to
"TASK-008 is the only TASK with no implementation" after TASK-008 was implemented, and on
2026-08-11 the `tasks:` block in `state.yaml` itself was found carrying
`TASK-006: tests-green, audit_rounds: 0` after two audits and a fix round. All three were
caught by someone reading the file for another reason, which is workflow finding F-O's whole
point: a field nobody owns after the event that should have updated it.

| Initiative | Slug | Track | Phase | Wave | Gate | TASKs | Updated |
|---|---|---|---|---|---|---|---|
| Foundation and tenancy substrate | foundation | full | implement | 2 of 2 | implement wave 2 pending | 9 — 5 done, 3 rework, 1 todo | 2026-08-11 |
| Publish the shortkit engineering posts | tech-writing | — | refine | — | not started; deferred, blocked by foundation | 0 | 2026-08-10 |

## Roadmap

`.sdlc/roadmap.md` names five further increments. None of them is an initiative yet, and
none carries ids, acceptance criteria or design. Each becomes one at Refine, once the one
before it ships.

## foundation — what is left

- **TASK-003** — API production image with a health endpoint. **Code-clear**: 46 of 49
  findings fixed, no blocker, no major, both round-7 auditors `clear`. Its escalation is
  **cleared** as of 2026-08-11: Amendment A-8 narrowed AC-6 to the production image, which
  was already measured. What remains open is **F-247**, a major on a file outside this TASK's
  `paths` — see the open decision below.
- **TASK-006** — Cross-tenant isolation harness. Round 1 closed four leak classes and shipped
  six negative controls, so the audit's measurements run on every CI run. **Round 2 found a
  fifth on the migrated production table** — F-302, unqualified writes — plus F-303 and F-304.
  Fix round 2 in flight.
- **TASK-008** — Web typed API client. Round-1 blocker and six majors all verdicted ADDRESSED
  on re-review, by two auditors that re-measured rather than read the resolutions. Both still
  returned `changes-requested`: **F-306**, new breakage in the fix, found independently by
  both. Fix round 2 in flight, red step first.
- **TASK-059** — *(new, 2026-08-11)* Whole stack up from nothing with `docker compose`, seeded.
  Minted under Amendment A-8. Not yet designed or tested; its design cluster is in flight.

Everything else is `done`.

## Open decisions, held for Juano

- **F-305, F-310, F-311 are one question** — what ADR-0029 and `web-api-client.md` actually
  promise. Whether `OPTIONS` is a mutating method, whether `isMutatingMethod` is
  case-sensitive, and whether the no-credentials guarantee covers `cause`. ADR-0029 is an
  approved artifact whose decision text is now known false, so this escalates rather than
  being patched. Held as one because three separate amendments to one question is how two
  individually-sound ADRs contradict.
- **F-247** — a major against `apps/api/src/tenancy/tenant-context.ts:247`, re-routed to
  TASK-003 by the re-scope sweep, but that path is outside TASK-003's `paths` and its own card
  says so. It needs an owner.

**Re-scoped 2026-08-09** from 6 EPICs and 58 TASKs to EPIC-001 alone. See `foundation/plan.md`
for what changed and `roadmap.md` for where the rest went. The re-scope also produced a defect
class of its own — obligations left on deferred cards that surviving work still owed — which
cost two blockers before it was swept. **A third instance surfaced 2026-08-11**: F-142 was
marked `fixed` when it had only been *deferred and routed*, which are different things.
