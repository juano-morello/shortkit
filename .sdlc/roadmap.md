# Roadmap — shortkit

These five increments are named. Nothing here is planned: no ids, no acceptance criteria,
no design, no estimates. Each becomes its own initiative when the one before it ships, and
each starts from Refine against whatever the shipped system has taught by then.

They were split out of `launch-core` on 2026-08-09, when that initiative was re-scoped to
its foundation EPIC alone. It had grown to 6 EPICs and 58 TASKs. Designing all of that
before validating any of it produced a 9:1 artifact-to-code ratio.

The planning artifacts from the 2026-08-03 breakdown sit under `.sdlc/foundation/` marked
`status: deferred`, kept because their ids are frozen and appear in commit subjects. Read
them as history. Nothing had shipped when they were written, and wave 2 already corrected
several of them: TASK-003's card alone carried two lines describing a repository state that
no longer existed.

Each item below needs the one above it.

---

1. **Identity, tenancy and membership.** An agency operator signs up, structures the agency
   into client workspaces, and invites a teammate scoped to specific workspaces.

2. **Links and the redirect hot path.** A multi-tenant URL shortener on the system default
   domain, with a redirect that stays fast, stays correct when someone edits a destination,
   degrades instead of failing when Redis is gone, and accumulates click events.

3. **Custom domains and white-label.** A per-client branded domain goes from added-in-the-UI
   to serving HTTPS with no manual step, and the workspace's branding appears on its 404.

4. **Operations, safety and compliance.** Link changes are attributable, write abuse is
   bounded per tenant, tenants can export and erase their data, and the isolation suite
   covers the whole surface instead of the two tables it reaches today.

5. **Public marketing surface.** Someone lands on the apex domain and works out what
   Shortkit is without creating an account.

---

Item 2 turns Shortkit from a substrate into a product. The 2026-08-03 plan called the end
of that work its primary cut line, and nothing since has argued otherwise.

Two things the old plan already knew. Carry them forward, or pay to learn them again:

- **Item 3 needs a registered apex domain.** Three of its TASKs could not run without one,
  and that blocked them for the eleven days the old initiative ran.
- **Item 4 carries the suite that backs the tenancy claim.** The harness exists and passes
  today, over two tables: `tenants` and `rls_fixture_rows`, which is every table the
  repository has. It prints that boundary on every run. The claim gets stronger only as the
  surface it covers grows.

## Carried forward 2026-08-11 — the isolation harness's method, not its coverage

Ruled by Juano on 2026-08-11, while TASK-006 was in its third fix round.

**The harness enumerates statement shapes a human thought of, and that is its ceiling.** In
three consecutive audit rounds it produced three blockers, every one of the same form —
*harness reports green while isolation is broken*:

| Round | The class nobody had attempted |
|---|---|
| 1 | Attempts ran in one direction only; any throw scored as a pass; no positive control; a forgotten registration shrank the covered set silently |
| 2 | **Unqualified writes.** An owner-qualified write is routed through the SELECT policy by PostgreSQL and reports zero rows however wide open the UPDATE policy is |
| 3 | **Owner-column writes**, and a 42501 refusal on an unqualified write scored as a pass — which proves the WITH CHECK held, not that the USING did |

Every fix was measured, each was proven against a real leak in a real database, and each one
holds. Nine negative controls now ship, so those measurements run on every CI run rather than
once on the afternoon somebody thought of them. **The fixes are not the problem.**

The problem is that each round's coverage is bounded by what someone imagined, and the next
round finds what they did not. That is the exact property SC-1 claims to have escaped, which
is why it is worth naming rather than absorbing into another fix round.

**The alternative, for whoever picks this up:** generate the mutations instead of listing
them. Enumerate the policy set programmatically and mutate it systematically — widen each
`USING`, widen each `WITH CHECK`, drop each policy, swap each owner-column reference — then
assert the harness fails on every mutant that produces a real cross-tenant read or write.
That proves the harness against a generated space rather than an imagined one, and it turns
"which attacks did we think of" into a property the suite computes.

Two things to keep when it is picked up:

- **The negative controls stay.** They are the record of what was actually measured, and a
  generative approach that cannot reproduce all nine has regressed.
- **`db:check-policies` is half of a composite gate**, not an independent second enumeration —
  F-333. Anyone replacing either half needs to know the other was carrying part of the load.

Not scheduled. It is the kind of work that only pays once there are tables to protect, and
today there is one.

### Worked evidence, added 2026-08-11 after round 3

The agent that fixed the third blocker was asked to name a structurally adjacent shape if it
saw one, on the reasoning that the list is worth more than another round. **It named five**,
filed as F-341:

1. **`INSERT ... ON CONFLICT DO UPDATE`** — PostgreSQL applies the INSERT WITH CHECK and, on
   conflict, **the UPDATE policy's USING** to the conflicting row. A table with a correct
   INSERT policy and a wide-open UPDATE USING is reachable through one statement, and the ORM
   idiom `save()` / `upsert()` compiles to exactly it.
2. **`MERGE`** (PG 15+) — each `WHEN` branch applies a different policy.
3. **Eviction rather than theft** — `UPDATE <t> SET <owner> = <a tenant the fixture never
   seeds>`. Detected by the count rule, but the digest cannot *name* the recipient.
4. **Cascade and trigger effects on a sibling table** — bounded today only because `tenants`
   has no ordinary DELETE policy, so no cascade can fire.
5. **`SELECT ... FOR UPDATE`** — a locking read applies the UPDATE policy's USING, so a tenant
   can take row locks on rows it cannot read: an existence side channel and a denial of
   service on another tenant's writes.

Its own conclusion is the argument for this item: all three blockers were "a statement shape
nobody thought of", and 1 and 2 are simply the next two nobody thought of.

## Follow-up cards owed by ADR-0041, ADR-0042 and F-369 (recorded 2026-08-11)

Three implementation cards do not exist and were deliberately not minted into a closing wave.
The architect that ruled the decisions flagged that it could not create them; recorded here so the
obligation survives, which is the F-142 lesson.

1. **ADR-0041 section 3 — gate "any other logger" at the dependency manifest.** Classify the API's
   dependencies and assert the classification for equality with a non-vacuity control. The stated
   cost is that every dependency addition turns a spec red, and that **a wrong classification is
   invisible** — `@nestjs/common` is the ADR's own proof that a reasonable person files a logging
   package under "the framework".
2. **ADR-0042 — move the logger-import restriction to follow the package** while `no-console` stays
   scoped to `src`. Measured to land green. The residual the ADR states: nothing checks what
   `seed.mts` prints when it has the database URL in its environment.
3. **F-369 / F-382 — close the lint fence's three doors.** Both `no-restricted-imports` entries move
   to `patterns` (the `pino`/`pino/` asymmetry was the tell), a shared predicate lands in
   `logging-opt-out.spec.ts`, and subpath fixtures cover two depths plus the `.mts`/`.tsx`
   extension gap. Two auditors found this class independently, at different depths, both by
   emitting a real Nest log line rather than reasoning about the matcher.

Also riding item 3: two stale quotations of the retired exemption at
`apps/api/src/observability/logging-opt-out.spec.ts:15-16` and `:25`.
