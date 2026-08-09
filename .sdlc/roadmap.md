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
