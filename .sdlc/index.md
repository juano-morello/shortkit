# shortkit — initiatives

Rebuilt from the state files on 2026-08-09. Every column below comes from
`<slug>/state.yaml` rather than from the previous version of this table, which had drifted
to `test` / `design approved` while the ledger said `implement`.

| Initiative | Slug | Track | Phase | Wave | Gate | TASKs | Updated |
|---|---|---|---|---|---|---|---|
| Foundation and tenancy substrate | foundation | full | implement | 2 of 2 | implement wave 2 pending | 8 — 5 done, 1 tests-green, 1 rework, 1 tests-red | 2026-08-09 |
| Publish the shortkit engineering posts | tech-writing | — | refine | — | not started; deferred, blocked by foundation | 0 | 2026-08-09 |

## Roadmap

`.sdlc/roadmap.md` names five further increments. None of them is an initiative yet, and
none carries ids, acceptance criteria or design. Each becomes one at Refine, once the one
before it ships.

## foundation — what is left

Two TASKs. The 53 that used to sit behind them now live on the roadmap.

- **TASK-003** — API deployable on Fly.io with a health endpoint. In fix round **4 of 5**,
  returned `DONE_WITH_CONCERNS`. F-273 is open and disclosed; two contract-drift tests are
  red by design because the shipped logger moved ahead of the contract fence.
- **TASK-008** — Web typed API client and error surface. The only TASK with no
  implementation at all. Its 6 red tests throw `not implemented` from `client.ts:77` and
  are the standing red in every wave-2 run.

Then TASK-006 needs an auditor pass to move from `tests-green` to `done`, and the wave 2
implement gate closes the initiative.

**Re-scoped 2026-08-09.** This was `launch-core` — 6 EPICs, 21 STORIEs, 58 TASKs — until it
was re-gated under `phases/plan.md` step 7 and failed the shippability check on both
signals. See `foundation/plan.md` for what changed and `roadmap.md` for where the rest
went.
