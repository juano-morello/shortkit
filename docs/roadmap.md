# Roadmap: shortkit

These five increments are named. Nothing here is planned: no ids, no acceptance criteria,
no design, no estimates. Each becomes its own initiative when the one before it ships, and
each starts from Refine against whatever the shipped system has taught by then.

They were split out of `launch-core` on 2026-08-09, when that initiative was re-scoped to
its foundation EPIC alone. It had grown to 6 EPICs and 58 TASKs. Designing all of that
before validating any of it produced a 9:1 artifact-to-code ratio.

The planning artifacts from the 2026-08-03 breakdown carried `status: deferred`, kept because
their ids are frozen and appear in commit subjects. Deleting the process machinery on
2026-08-17 took them too; they sit in git history at `c617ebd` and earlier under
`.sdlc/foundation/`. Read them as history if you go looking. Nothing had shipped when they
were written, and wave 2 already corrected several: TASK-003's card alone carried two lines
describing a repository state that no longer existed.

The ADRs and the design contracts survived that deletion, because the code cites them. They
are in `docs/decisions/` and `docs/contracts/`.

Each item below needs the one above it. Item 1 shipped in two halves, the second on
2026-08-18, and item 2 shipped on 2026-08-19; item 3 is next.

---

1. **Identity, tenancy and membership.** An agency operator signs up, structures the agency
   into client workspaces, and invites a teammate scoped to specific workspaces.

   **Split at the Refine gate, 2026-08-12.** The sentence held two increments.

   - **1a: `identity-membership`, merged to `main` on 2026-08-18 as #9.** Signup, session,
     tenant membership and workspaces. Better Auth per ADR-0013,
     `tenant_memberships` per ADR-0015 with its `UNIQUE (user_id)`, a tenant-scoped
     `workspaces` table, and three screens in `apps/web`. Email verification off as a dated
     decision, because `MAIL_TRANSPORT` unset binds `NoopMailSender` and requiring
     verification would make signup uncompletable. This is the first request path in
     shortkit and the first time SC-1 is testable.

     **Shipped 2026-08-18.** The Better Auth mount at `/api/auth/*` with its body cap and
     IP buckets; `AuthGuard` over cached JWKS and the revocation store; the tenant
     transaction interceptor and the three tenancy decorators; the `workspaces` table, its
     repository, four routes under `/api/workspaces` and the workspaces screen; the signup
     and sign-in screens and the BFF proxy that holds the session cookies; one request log
     line per matched request; the isolation suite over four tables and the four endpoints,
     registered by hand; and the compose stack driving signup, sign-in and workspace
     creation end to end. Out, by the split above: mail, invitations, `memberships` and
     `WorkspaceRole` enforcement, all 1b.
   - **1b: invitations, merged to `main` on 2026-08-20 as #10.** The second-human path:
     capability tokens per ADR-0021, mail, the accept legs, `memberships` and
     `WorkspaceRole` enforcement. **F-018, F-300/F-362 and F-386/F-401 belonged to this
     entry** and are discharged below.

     **Shipped 2026-08-18.** Three tables in one migration (`memberships`, `invitations`,
     `invitation_workspaces`, `0003`, `tenantScopedPolicies()` for all three, ADR-0062); the
     `MailSender` port with `console`, `resend`, `fake` and `none` transports selected by
     `MAIL_TRANSPORT`, unset binding the one that sends nothing, and the
     `workspace_invitation` template dispatched from `afterCommit`; capability tokens
     `<tenantId>.<43 base64url>` with only the digest stored; five routes under
     `/api/invitations` (create, list, revoke, an anonymous `lookup` behind the
     `@Public()` per-IP bucket, and `accept`), the token travelling in a request body and
     the mail link's URL **fragment**, never a path, a query or a log line; the invited
     signup branch in Better Auth's hooks that joins the inviter's tenant as `member` and
     creates no tenant; `WorkspaceAuthorization` reading `memberships` on every workspace
     route, the creator's `workspace_admin` row written with the workspace, the list
     membership-filtered, and `GET /api/workspaces/:id`; the email-keyed sign-in bucket that
     refunds a success; the invitations screen per workspace and the accept page that
     reads `location.hash` and drops it; the isolation suite over seven tables, three
     repository classes and ten endpoints; and the compose stack declaring
     `MAIL_TRANSPORT=console` (D-02) with four clauses that invite, read the link out of
     `docker compose logs api`, sign the invitee up, and assert they see exactly the granted
     workspace at `member`. Not built, by decision: member management after the invitation
     (`PATCH /api/members/:id/workspace-role`, tenant-role changes), a resend action, bounce
     handling, a real `From` domain, and a per-tenant cap on invitation volume (TASK-051's
     bucket). Ledger residuals are in the 2026-08-18 carried-forward list below.

   Why the cut fell there: a workspace with exactly one human who can see it has nothing to
   scope, so `memberships` would be a table nothing reads. ADR-0015 already separates tenant
   membership from workspace membership across two tables at two levels, so 1a builds one of
   them and 1b builds the other. ADR-0015 also states "Signup creates a tenant. Invited signup
   does not", so removing invitations removes a branch rather than half a design.

   The known cost, recorded rather than discovered later: 1b adds a boundary to a `workspaces`
   table and policy set that never had one, which is F-236's class at one remove. Design owes
   an ADR clause naming what 1b adds and why the existing policies survive it. *Paid
   2026-08-18:* ADR-0062 is that clause: the boundary is a second table, `memberships`, the
   `workspaces` policy set is unchanged, and the list is filtered by a join the repository
   owns; a pre-1b volume has workspaces with no creator membership and no backfill, and the
   README's reset ladder says so.

2. **Links and the redirect hot path.** A multi-tenant URL shortener on the system default
   domain, with a redirect that stays fast, stays correct when someone edits a destination,
   degrades instead of failing when Redis is gone, and accumulates click events.
   **Merged to `main` on 2026-08-20 as #13**, after #10 and the debt sweep (#12) went in
   ahead of it.

   **Shipped 2026-08-19.** Three tables in one migration (`domains`, `links`,
   `click_events`, `0005`, `tenantScopedPolicies()` for all three plus the first applied
   instances of `redirectReadPolicy()`, on `domains` and `links` and no other table); a
   seeded platform tenant that owns the system default domain, which every link references
   by foreign key (ADR-0063); the link and click contracts in `packages/contracts`, with
   `destinationUrl` parsed by `new URL()` and stored as `href`, so `javascript:` is
   unstorable rather than merely unrendered, and `ipHash` absent from the wire shape; five
   routes under `/api/links` and one click-read route, behind the same guard, tenant
   transaction and workspace-role check as the rest, with slugs drawn from ADR-0007's
   57-symbol alphabet, a collision settled by a savepoint redraw and a supplied duplicate
   answered 409; `GET /:slug` registered outside the `/api` prefix and last in the module
   graph, answering 302 with the destination byte for byte or the 404 page carrying its own
   content security policy, and never a 5xx whatever fails behind it; that resolution
   reading `domains` and `links` outside tenant context through two statement shapes, in one
   read-only transaction, in one file, which is the GC-5 exception ADR-0003 approves and the
   isolation suite carries as an exclusion; the Redis client, the read-through cache with
   its host and link keys, their TTLs and their MISS sentinel, an invalidation subscriber
   that deletes on every mutation and deletes the same keys again a second later to sweep a
   stale write-back, and an unset `REDIS_URL` binding the cache that answers `unavailable`
   to every read and warns once at boot; a click buffer that writes `click_events` off the
   visitor's path, the address stored as a per-tenant HMAC that reaches no response and no
   log line; two link screens per workspace and the short URL the operator copies; the
   isolation suite widened to ten tables, six repository classes and sixteen endpoints, with
   `GET /:slug` registered `@Public()` and deliberately not attacked; a k6 harness, a
   recorded baseline for the cache-hit path and the CI job that gates on it at 100 RPS; and
   seven clauses on the compose stack that create a link, follow it, read the click back,
   edit the destination, stop Redis, start it again, and ask for a slug nobody holds. Not
   built, by decision: custom domains and the branding a 404 would render (item 3, and the
   branding port is deliberately unbound, so every 404 is the default page); click
   retention, rollups and any export of the stream (D-2-03, item 4); a `domainId` on the
   create body while there is one domain to name (D-2-12); and the Redis rebind of the
   revocation store and the rate limiters, deferred with ADR-0053's trigger re-pointed at
   the ADR that supersedes ADR-0030 (D-2-01). Residuals are in the 2026-08-19
   carried-forward list below.

3. **Custom domains and white-label.** A per-client branded domain goes from added-in-the-UI
   to serving HTTPS with no manual step, and the workspace's branding appears on its 404.

4. **Operations, safety and compliance.** Link changes are attributable, write abuse is
   bounded per tenant, tenants can export and erase their data, and the isolation suite
   covers the whole surface instead of the ten tables, six repository classes and sixteen
   endpoints it reaches today (two tables when this was written; 1a widened it to four and
   four, 1b to seven, three repository classes and ten on 2026-08-18, and item 2 to ten, six
   and sixteen on 2026-08-19).

5. **Public marketing surface.** Someone lands on the apex domain and works out what
   Shortkit is without creating an account.

---

Item 2 turned Shortkit from a substrate into a product, and it is the cut line the
2026-08-03 plan called its primary one. Nothing since has argued otherwise.

Two things the old plan already knew. Carry them forward, or pay to learn them again:

- **Item 3 needs a registered apex domain.** Three of its TASKs could not run without one,
  and that blocked them for the eleven days the old initiative ran.
- **Item 4 carries the suite that backs the tenancy claim.** The harness exists and passes
  today, over two tables: `tenants` and `rls_fixture_rows`, which is every table the
  repository has. It prints that boundary on every run. The claim gets stronger only as the
  surface it covers grows. (Since 2026-08-19: ten tables, with `tenant_memberships`,
  `workspaces`, `memberships`, `invitations`, `invitation_workspaces`, `domains`, `links`
  and `click_events` added; the methods of six repository classes; and sixteen endpoints
  under `/api/workspaces`, `/api/invitations` and `/api/links`. Still registered by hand,
  and the run still prints that. The redirect is the one shipped route registered and
  deliberately not attacked, because it is anonymous and cross-tenant by design, and what
  bounds it instead is the carried exclusion and the three narrowings the run asserts.
  `COVERAGE_BOUNDARY` in `apps/api/test/isolation/coverage.ts` is the text.)

## Carried forward 2026-08-11: the isolation harness's method, not its coverage

Ruled by Juano on 2026-08-11, while TASK-006 was in its third fix round.

**The harness enumerates statement shapes a human thought of, and that is its ceiling.** In
three consecutive audit rounds it produced three blockers, every one of the same form,
*harness reports green while isolation is broken*:

| Round | The class nobody had attempted |
|---|---|
| 1 | Attempts ran in one direction only; any throw scored as a pass; no positive control; a forgotten registration shrank the covered set silently |
| 2 | **Unqualified writes.** An owner-qualified write is routed through the SELECT policy by PostgreSQL and reports zero rows however wide open the UPDATE policy is |
| 3 | **Owner-column writes**, and a 42501 refusal on an unqualified write scored as a pass, which proves the WITH CHECK held, not that the USING did |

Every fix was measured, each was proven against a real leak in a real database, and each one
holds. Nine negative controls now ship, so those measurements run on every CI run rather than
once on the afternoon somebody thought of them. **The fixes are not the problem.**

The problem is that each round's coverage is bounded by what someone imagined, and the next
round finds what they did not. That is the exact property SC-1 claims to have escaped, which
is why it is worth naming rather than absorbing into another fix round.

**The alternative, for whoever picks this up:** generate the mutations instead of listing
them. Enumerate the policy set programmatically and mutate it systematically (widen each
`USING`, widen each `WITH CHECK`, drop each policy, swap each owner-column reference), then
assert the harness fails on every mutant that produces a real cross-tenant read or write.
That proves the harness against a generated space rather than an imagined one, and it turns
"which attacks did we think of" into a property the suite computes.

Two things to keep when it is picked up:

- **The negative controls stay.** They are the record of what was actually measured, and a
  generative approach that cannot reproduce all nine has regressed.
- **`db:check-policies` is half of a composite gate**, not an independent second enumeration
  (F-333). Anyone replacing either half needs to know the other was carrying part of the load.

Not scheduled. It is the kind of work that only pays once there are tables to protect;
there was one table when that was written and there are ten now.

### Worked evidence, added 2026-08-11 after round 3

The agent that fixed the third blocker was asked to name a structurally adjacent shape if it
saw one, on the reasoning that the list is worth more than another round. **It named five**,
filed as F-341:

1. **`INSERT ... ON CONFLICT DO UPDATE`**: PostgreSQL applies the INSERT WITH CHECK and, on
   conflict, **the UPDATE policy's USING** to the conflicting row. A table with a correct
   INSERT policy and a wide-open UPDATE USING is reachable through one statement, and the ORM
   idiom `save()` / `upsert()` compiles to exactly it.
2. **`MERGE`** (PG 15+): each `WHEN` branch applies a different policy.
3. **Eviction rather than theft**: `UPDATE <t> SET <owner> = <a tenant the fixture never
   seeds>`. Detected by the count rule, but the digest cannot *name* the recipient.
4. **Cascade and trigger effects on a sibling table**: bounded today only because `tenants`
   has no ordinary DELETE policy, so no cascade can fire.
5. **`SELECT ... FOR UPDATE`**: a locking read applies the UPDATE policy's USING, so a tenant
   can take row locks on rows it cannot read: an existence side channel and a denial of
   service on another tenant's writes.

Its own conclusion is the argument for this item: all three blockers were "a statement shape
nobody thought of", and 1 and 2 are simply the next two nobody thought of.

## Follow-up cards owed by ADR-0041, ADR-0042 and F-369 (recorded 2026-08-11)

Three implementation cards do not exist and were deliberately not minted into a closing wave.
The architect that ruled the decisions flagged that it could not create them; recorded here so the
obligation survives, which is the F-142 lesson.

1. **ADR-0041 section 3: gate "any other logger" at the dependency manifest.** Classify the API's
   dependencies and assert the classification for equality with a non-vacuity control. The stated
   cost is that every dependency addition turns a spec red, and that **a wrong classification is
   invisible**: `@nestjs/common` is the ADR's own proof that a reasonable person files a logging
   package under "the framework".
2. **ADR-0042: move the logger-import restriction to follow the package** while `no-console` stays
   scoped to `src`. Measured to land green. The residual the ADR states: nothing checks what
   `seed.mts` prints when it has the database URL in its environment.
3. **F-369 / F-382: close the lint fence's three doors.** Both `no-restricted-imports` entries move
   to `patterns` (the `pino`/`pino/` asymmetry was the tell), a shared predicate lands in
   `logging-opt-out.spec.ts`, and subpath fixtures cover two depths plus the `.mts`/`.tsx`
   extension gap. Two auditors found this class independently, at different depths, both by
   emitting a real Nest log line rather than reasoning about the matcher.

Also riding item 3: two stale quotations of the retired exemption at
`apps/api/src/observability/logging-opt-out.spec.ts:15-16` and `:25`.

## Carried forward from `foundation` (F-389, 2026-08-11)

**Twelve obligations belong to deferred work and had no carrier past this initiative.** Ship is the
last gate where the record is still in one place: `findings.yaml` is 808 KB, and one of these
items has a record that reads `status: fixed`. Each is named here with the roadmap entry that
inherits it and the ruling that produced it.

Six came from F-389's sweep on 2026-08-11. Four more (F-236, F-239, F-102, F-157) were added at
the Retro gate on 2026-08-12, because the prose-driven sweep missed them; that is why
`check-ledger.mjs` rule 4 now asserts this table mechanically. The last two, F-400 and F-401, are
Retro-phase findings and are **below `check-ledger`'s reach**: it only asserts a carrier for
`major` and `blocker`, and both were filed `minor`.

| Obligation | Inherited by | Ruling |
|---|---|---|
| ~~**F-018 is reopened**: `@Public()` invitation routes have no IP-keyed limit in any environment that exists today.~~ **Discharged 2026-08-18 (TASK-1b-07, TASK-1b-08):** `RateLimitGuard` charges every `@Public()` route 30/60 s per client IP where a trusted header is declared, before the token is parsed; the one such route is `POST /api/invitations/lookup`. Where no header is declared the bucket does not bind and the warn line says so (the fail-open ruling, unchanged). | Item 1 (invitations, auth) | ADR-0040 + Juano's fail-open ruling, 2026-08-11 |
| **The TASK-009 boot assertion**: `assertTrustedClientIpHeaderConfigured()` and `assertBffProxySecretConfigured()`, both gated on a declared property rather than `NODE_ENV`. `TASK-009.md` mentions neither ADR-0040, nor the assertions, nor F-018. | Item 1 | ADR-0040 (F-380), rate-limit.md (F-385) |
| **F-036, F-037**: parked majors on the architect, from the design phase. | whichever entry revives their subject | parked at the design cap |
| ~~**F-300 / F-362**: `invitation-tokens.md` invariant 5 is corrected but the mechanism is undecided: the raw token sits in the URL path on **both** the `GET` and the `POST` accept legs.~~ **Discharged 2026-08-18 (D-03, TASK-1b-04, TASK-1b-08, TASK-1b-13):** the token travels in the mail link's URL **fragment** and in the bodies of `POST /api/invitations/lookup` and `POST /api/invitations/accept`; the path forms were not built. | Item 1 | Juano's park-and-correct ruling, 2026-08-11 |
| **F-350**: the drift repair reached the isolation suite and not the GDPR paths. `tenantScopedTables()` still has no name-independent derivation, and it is what export and erasure iterate. *Item 2, 2026-08-19: still open, and three tables wider. `tenantScopedTables()` still does not exist, so `domains`, `links` and `click_events` reached the isolation registry the way every other table did, by hand, and an eraser would still have nothing to iterate.* | Item 4, and any entry adding a tenant-scoped table | ADR-0019 amendment, 2026-08-11 |
| ~~**F-386**: `mail-sender.md` binds the **live Resend sender** when `NODE_ENV` is `production`, which `Dockerfile:83` sets under `docker compose up`.~~ **Discharged 2026-08-18 (TASK-1b-02):** `resolveMailTransport` is the one read of `MAIL_TRANSPORT`, nothing under `apps/api/src/mail/**` reads `NODE_ENV`, unset binds `NoopMailSender`, and `resend` refuses boot without `RESEND_API_KEY` and `MAIL_FROM`; a spec scans the source for both facts. | Item 1, or whichever entry writes mail | ruled 2026-08-12: `MAIL_TRANSPORT` is a third declaration, unset binds `NoopMailSender` |
| ~~**F-401: the mail stub is stale in the unsafe direction.**~~ **Discharged by absence 2026-08-18 (TASK-1b-02):** `design/stubs/**` left the repository with the process tree on 2026-08-17, so there is no stub to trust over the contract; `mail-sender.md`'s normative form names the shipped files. | Item 1, or whichever entry writes mail | a stub sweep, or TASK-010's ADR-0039 retirement, whichever comes first |
| **F-400: `domain-provisioning.md:134` names no selector.** It says "Production resolves over DNS-over-HTTPS" and TASK-039 will invent one; the obvious invention is `NODE_ENV`. A DoH resolver bound that way under `docker compose up` resolves real DNS from a laptop against a stranger's domain, which is the F-386 shape one subsystem over. Caught before it was written, because the architect was asked to enumerate bindings rather than assertions. | Item 3 (custom domains) | name the selector as a declared property, per ADR-0017 and ADR-0040 |
| **F-236: the GDPR eraser erases nothing and reports success.** `PrivilegedTenantEraser.erase` written the obvious way deletes no rows and returns cleanly. This is F-002's class (a design blocker fixed at *policy* level in design round 1) reappearing at *statement* level, because the policy fix was verified against the policy set and never against a statement issued under it. **The most consequential item in this table.** *1b, 2026-08-18: untouched, and no eraser exists yet; the three new tables cascade from `tenants(id)` like the rest, so the statement-level problem is the same shape, one table wider three times over.* *Item 2, 2026-08-19: untouched again, and three tables wider again. `click_events` is the first table whose rows a tenant cannot delete through any route at all, since the click surface is a GET and nothing else, so erasure is the only thing that will ever remove them.* | Item 1, and any entry touching GDPR erasure | filed at TASK-006 delivery; owner TASK-054, deferred |
| **F-239: `ALTER DEFAULT PRIVILEGES` grants `shortkit_app` full DML on every table the migrator creates**, so a new table is writable by the runtime role before anyone writes a policy for it. *1b, 2026-08-18: still open. Migration `0003` created three tables and hand-appended `tenantScopedPolicies()` for all three in the same commit, so the window was zero seconds long this time; nothing prevents a later migration from leaving it open, and `db:check-policies` plus `tenantScopedTableDrift()` are what would catch it after the fact.* *Item 2, 2026-08-19: the same again for migration `0005`, which created three tables and appended their policies in the same commit, `domains` and `links` additionally carrying the redirect read policy.* | Item 1, and any entry adding a table | owner TASK-009, deferred |
| **F-102: AC-68 versus F-097's DNS-proof ordering.** A finding against an approved artifact, so routing rule 0 makes it Juano's, and it must settle before custom domains are dispatched. | Item 3 (custom domains) | escalated 2026-08-03, unresolved |
| **F-157: no build-output scan can cover dynamic routes**, which is where the entire authenticated surface will live. AC-113's guard is sound for what it scans and structurally blind to what comes next. *1b, 2026-08-18: unchanged; the accept page and the invitations screen are dynamic routes the scan does not see, as predicted.* *Item 2, 2026-08-19: two more, the links list and the link editor.* | Item 1, when the first authenticated route lands | closed against TASK-004; the residual is real |

**Why this block exists rather than a pointer to `findings.yaml`.** The initiative named the same
defect four times in its own logs: a routing recorded as a resolution, a record that lagged its
artifact, a fix that landed where the finding pointed and survived everywhere it did not. It is
also the stated reason the ADR-0041, ADR-0042 and F-369 cards above are on this roadmap at all.
A refiner who opens an entry reads this file; they do not grep a 770 KB ledger.

## The compose gate, and how to de-gate it if the first run is red (F-390, 2026-08-11)

`scripts/check-compose-stack.sh` is now a **required** CI check: a third gating job, `compose`,
alongside `quality` and `integration`. The implementer chose a gating job over a nightly and over a
manual cadence, and the reasoning is worth keeping: **a nightly is chronologically detached from the
commit that broke it**, and this check only goes red because the tree changed, unlike
`dependencies.yml`, whose schedule exists to re-ask about *unchanged* code.

**It has never been observed on a GitHub runner.** Disk for four cold-built images is the item that
could least be verified locally. So, recorded before anyone needs it:

- **If the first run is red environmentally, the smallest correct repair is to remove `compose`
  from `gate`'s three lists (`needs`, `env:`, and the assertion loop) and leave the job visible.
  Do not weaken the script.** A job named in fewer than all three blocks nothing, so all three move
  together or the change is a no-op that reads like a fix.
- **Exit code 2 means "could not run, nothing measured"** and is never an AC-115 failure. That
  distinction is written into the workflow and into the script; a red `compose` job needs its exit
  code read before it is diagnosed.

Recorded here because the choice and its fallback had no carrier otherwise, which is F-389's exact
shape one day later, and it was the implementer, not an auditor, that pointed out its own decision
had nowhere to live.

## The stub-drift gate: its scope, and when to widen it (F-288, 2026-08-12)

`.github/scripts/assert-stub-drift.mjs` closes the gap ADR-0039 admits it leaves open: the gap
F-288 came through, named four times across the foundation initiative and gated by nothing. It
compares each surviving stub with the source file at the same path on **exported shape** and fails
when a declaration the stub exports is missing from the source or has a different signature. Bodies,
comments, declaration order, interface member order, union order, parameter names and `async` are
all excluded, because a check that fires on those is a check nobody keeps green.

**It gates as a step in `quality`, not as a fourth job.** `quality` is already named in `gate`'s
`needs`, its `env:` and its assertion loop, so a step inside it blocks a merge with no wiring to
keep in step across three places, which is the failure F-390 filed against the compose script. A
job earns its three entries when it needs its own services or its own timeout; this one is a
filesystem walk and a parse, well under a second. **De-gating it is therefore one line**: delete the
`Assert no surviving design stub has drifted from its source` step. Do not weaken the script, and do
not touch `gate`.

**Two things about its scope are true today and should not be discovered by surprise:**

- **F-403: it enforces `apps/web/**` only, and that stub has no source yet, so it currently
  compares zero gating pairs.** That is the retro's approved scope and the correct verdict under ADR-0039 clause 2,
  and the run prints both facts rather than reporting a clean green. It starts defending the moment
  TASK-012 lands `apps/web/src/lib/session/session.ts`, the same window F-288 happened in.
- **F-404: `apps/api/src/observability/logger.ts` is really drifted and is reported without
  gating.** The stub exports `REDACT_PATHS`, `createLogger`, `CORS_ENABLED` and `HSTS_MAX_AGE_S`;
  the source exports none of them. `REDACT_PATHS` and `createLogger` are the known F-249
  supersession; **`CORS_ENABLED` and `HSTS_MAX_AGE_S` are not obviously covered by it** and should
  be checked rather than assumed when the stub retires. Treated as known drift, not a new defect:
  `design/stubs/README.md` already calls that stub "superseded and unsafe to copy" and ADR-0028
  deleted `REDACT_PATHS` from the running logger. Enforcing the whole tree today would mean shipping
  an allowlist entry on day one for a divergence already agreed to, which is one of the costs
  ADR-0039's alternative 1 lost on.

**Widen `ENFORCED_PREFIXES` to `['']` when TASK-003 closes and retires the logger stub.** Nothing
else in the tree has a source file, so at that point the whole tree enforces with no exception to
write, and the constant is the only edit.

**One real divergence this check found in history, recorded because nothing else records it.** Run
against the F-288 pair as it stood at `ecc9275`, it names all three missing exports. Run against the
same pair as it stood the commit before the stub was deleted, it still fails: the stub's
`ContractViolationError` and `NetworkError` constructors took a trailing optional `ErrorOptions`
parameter that `a6dd8fb` had removed from the source. ADR-0039's clause 4 pre-deletion check was
performed on that stub and reported the exported declaration sets matching exactly: true at the
level of names, false at the level of signatures. The stub is gone and there is nothing to fix; the
point is that the human check missed it and this one does not. Filed as **F-402**, parked, and
recorded so ADR-0039's clause-4 claim is never cited as a stronger check than it was: that sweep
authorised ten deletions.

## Carried forward from `identity-membership`, added 2026-08-14

- **A fourth runtime database role must be checked against ADR-0045's accepted cost.**
  `membershipLookupPolicy()` carries no `TO` clause, ruled deliberately at F-121: it applies to
  `PUBLIC`, and what keeps the token-mint escape narrow is the grant matrix plus the `nullif`'d flag,
  **not** the policy text limiting itself. So a fourth role granted `SELECT` on `tenant_memberships`
  lands inside the escape's evaluation **with no edit to that policy**. `check-policies.mts`'s grant
  matrix reports the grant but does not connect it to the escape, and there is no automated control
  that does. Whoever adds the role owns the check.

## Carried forward from `identity-membership`, 2026-08-18

Gaps the wave ledger recorded as real and nothing on the branch closes. Each line carries
its ledger id.

- **W8-07, W8-02**: a guard-refused 401, and every `DomainError` refusal, leaves no
  request log line: the interceptor wraps matched handlers only and the filter's
  `DomainError` branch does not log. Repeated credential failures on the bearer surface are
  unobservable. Express-level request logging in `main.ts` is the place.
- ~~**W5-01**: `apiClient` does not normalise a 429's `Retry-After` header or
  `retryAfterSeconds` body into `ApiError.retryAfterSeconds`.~~ **Closed 2026-08-18
  (TASK-1b-12):** `apiClient` reads the header first and the body field second, and
  `web-api-client.md` step 4 is true through the real client.
- **W4-13**: the ESLint config has no `eslint-plugin-react-hooks` and no `jsx-a11y`, so
  `use-session.ts` has no rules-of-hooks or exhaustive-deps coverage. Needs a dependency add
  and a lockfile change.
- **W8-06**: `serverApiClient`'s `token_expired` bounce drops the current URL for every
  protected page. The workspaces page handles it locally in `refresh-bounce.ts` by parsing
  Next's `NEXT_REDIRECT` digest; the fix belongs in `src/lib`, with `serverApiClient`
  accepting a `returnTo`.
- **W3-02**: `203.0.113.60` and its IPv4-mapped form `::ffff:203.0.113.60` key two
  rate-limit buckets. Reachable only through a trusted proxy that forwards mixed forms.
  Canonicalise in `readTrustedClientAddress`.
- **W3-01**: the auth body cap's 413 linger path holds a slow-drip client's connection
  until Node's default `requestTimeout` (5 min); `main.ts` sets no `server.requestTimeout`
  and no `headersTimeout`.
- **W5-04**: a handler returning a non-completing Observable (SSE, a stream) under the
  tenant transaction interceptor holds a pooled connection; `idle_in_transaction_session_timeout`
  kills the backend after 5 s but `client().transaction` may never settle. No such route
  exists. An overall deadline in `withTenantTransaction`, or a rule that forbids streaming
  handlers under the interceptor.
- **W4-08**: `AuthGuard` has no refetch on an unknown `kid`; a rotated key 401s until the
  600 s JWKS TTL passes. That matches `auth-tokens.md`'s key-rolling convention (publish,
  wait 600 s) and is where a skipped rotation wait shows up.
- **W8-03 (F-216)**: Better Auth's package-level `onError` logger writes
  `ERROR [Better Auth]: Invalid JSON in request body` to stderr, coloured, bypassing pino.
  A fixed string today; the SC-5 scan pins that only it and Nest's bootstrap lines are
  non-JSON.
- **W8-01**: the request log line carries no `method`. `logging-and-headers.md`'s
  "Required fields" table does not name it and ADR-0028 lets no unnamed field through, so
  the contract amendment comes first.

## Carried forward from `invitations` (item 1b), 2026-08-18

The 1b wave ledger's residuals, each with its ledger id. None is closed by the branch.

- **1b-W3-07**: no per-tenant or per-caller cap on `POST /api/invitations`: a
  `workspace_admin` can script mail volume bounded only by the transport. The tenant write
  bucket is TASK-051's and lands with item 4.
- **Member management is not built.** `PATCH /api/members/:id/workspace-role` and the
  tenant-role change route are rows in `workspace-authorization.md` marked "not built in
  1b"; the only way a role changes today is a direct `memberships` update, which the next
  request honours (no cache, AC-1b-21).
- **The tenant-`admin` creator gap.** Creating a workspace needs tenant `admin`, so an
  invitee (tenant `member`) cannot create one even where they are `workspace_admin`
  elsewhere; nothing promotes a tenant role after signup.
- **The fragment needs JavaScript.** The accept page reads `location.hash`; a browser
  with scripts off sees the page with no token and no way to hand it over (D-03's accepted
  cost).
- **1b-W1-08**: `ResendMailSender` retries once on a network throw with no
  `Idempotency-Key` and no timeout, so a lost response after acceptance can send a
  duplicate invitation. Candidate: a key from invitation id plus attempt.
- **1b-W1-09**: workspace and tenant names admit control characters; a newline in one
  forges the console transport's block boundary (a dev-only channel, same-tenant author).
  Candidate: refuse control characters in the name contracts.
- **1b-W1-10**: `MAIL_TRANSPORT=fake` is a legal production value that swallows mail with
  no signal; a boot warn parallel to `none`'s is the candidate.
- **1b-W1-11**: foreign keys without a leading-column index: `memberships.user_id`,
  `invitations.invited_by_user_id`, `invitations.accepted_by_user_id`,
  `invitation_workspaces.workspace_id`. Add when a query plan asks for one.
- **1b-W1-03**: `LocalRateLimiter` copies rather than imports `LocalAuthRateLimiter`'s
  algorithm (per F-034); a shared bounded-map core is the candidate refactor.
- **1b-W1-06 (fixed) leaves a question**: Express routes case-insensitively, so
  `/API/...` reaches the same handler; the public IP bucket now lower-cases the path, and
  `auth-rate-limit.ts`'s `bucketFor` still compares exactly (1b-W1-07, benign: Better Auth
  404s the varied path). Whether `main.ts` should set `case sensitive routing` is open.
- **1b-W3-03**: the invited signup form does not prefill the invited address; the address
  is shown as context.
- **1b-W3-08**: `WorkspaceRepository` is registered twice; `WorkspacesModule` should
  export it.
- **1b-W4-01**: `classifyInvitationScreenError` lives in `invite-form.tsx` and is imported
  by sibling components; belongs in `invitations-api.ts`.
- **1b-W4-02**: `workspaceContract.workspaceRole` is `.optional()` to accommodate web
  fixtures; the API always sends it. Tighten once the fixtures carry the field.
- **1b-W1-04**: AC-1b-38's wording (the unresolved-principal warn fires with no header
  declared) disagrees with `trusted-client-address.md`'s "Signal" (silent then); the
  contract was implemented, the story sentence stands corrected here.
- **1b-W1-13**, an accepted cost under ADR-0062: `reparentAll` on the composite-FK tables scores a
  widened `USING` as unverified (23503) rather than fail; still red, and inherent.

## Carried forward from the merge itself, 2026-08-21

Three things the merges taught, recorded because none of them has a carrier otherwise.

- **Two gates had never run on a runner, and both were wrong.** `performance` pointed its
  three DSNs at `shortkit_test` and then ran `db:seed`, which refuses any database but
  `shortkit` by name (`seed.mts:94`, ADR-0034), so the gate could not have passed at all;
  provisioning now creates both databases with identical grants. `redirect.int-spec.ts` and
  `click-emission.int-spec.ts` were written before TASK-2-07 added the cache and never
  revisited, so five assertions measured the cache rather than the Postgres path they name;
  they passed locally only because a run with no `REDIS_URL` binds a cache that answers
  `unavailable` to every read. Both are fixed, and the shape is F-390's prediction arriving
  twice: **a gate nobody has watched run is a claim, not a control.**
- **A scratch-Redis suite can fail on the runner's Docker, not on the code.** One
  `integration` run failed both suites that start their own Redis with `driver failed
  programming external connectivity on endpoint`, while its twin passed on the identical
  commit; a re-run went green. The ports are already distinct per suite by design, so this
  was the daemon and not a collision. **Recorded rather than retried in code**: one
  observation is not a pattern, and a retry loop around a container start hides a broken
  daemon as easily as it absorbs a flake. If it recurs, this is the note that says so.
- **The two residuals that lose data or signal both wait on item 3.** Nothing deletes a host
  key, and no code path writes `domains` at all, so the invalidation has no producer until
  custom domains adds the first one. Every click row hashes the same sentinel because no
  environment declares a trusted client address header, and none honestly can while the
  redirect is reached directly: a declared header with no hop in front of it is a value the
  visitor chose, which is F-009. Both close inside the work that creates their producer.

## Carried forward from `links-redirect` (item 2), 2026-08-19

Item 2 ran without a wave ledger, so each line names the artifact that records the gap
rather than a ledger id. None is closed by the branch.

- **A cache fill that lands after the delayed second deletion still wins**, and is then
  bounded only by the 3600 s link TTL. The subscriber deletes a mutated link's keys and
  deletes them again a second later, which narrows the window from "any request in flight
  across the commit" to "a request whose Postgres read predates the commit and whose cache
  write lands more than a second after it". It does not close it. `redirect-cache.md`
  records both halves and `test/links/cache-invalidation.int-spec.ts` measures both against
  a live Redis.
- **A deletion that exhausts its retry schedule is logged and nothing else.** Staleness can
  then exceed GC-2's five seconds, and one `cache_invalidation_failed` line carrying
  `link_id` and `attempts` is the whole signal: no metrics facility exists to count it, so
  the metric name lives on as a `code` occurrence (ADR-0008, and ADR-0053's substitution
  pattern before it).
- **Nothing deletes a host key.** The `hst:` rows of the invalidation table belong to later
  cards, so a domain that leaves `active` keeps serving from its cached record for up to the
  300 s host TTL. Resolving the host before the link is what holds that bound at 300 s
  rather than at the link key's hour, and it is the reason the read path does it in that
  order.
- **Every click row in every environment that exists hashes the same sentinel.** No
  deployment declares a trusted client address header, and the click path honours the BFF's
  forwarded-address pair at no position by design (F-009), so `ip_hash` is the hash of
  `unknown-client-address` and a unique-visitor count derived from the stream means nothing.
  Better than the visitor choosing their own hash, and still a real loss of signal
  (`click-events.md`, F-320).
- **`click_events` grows without bound.** No retention, no rollup and no export: D-2-03
  ruled the raw stream in and everything else out of item 2, with the growth arithmetic in
  `docs/performance/redirect-baseline.md`. Deleting a link cascades its click rows away,
  which is the only deletion path there is.
- **The redirect's branding port is unbound**, so every 404 is the default page. Item 3
  binds it and owes the other half of the cache rule with it: `resolveHost` has to fill
  branding before the record is written, or a branded host caches as unbranded for the host
  TTL (`redirect-cache.md`).
- **ADR-0018 layer 2 is unbuildable** under ADR-0030, because there is no deployed instance
  to drive 500 RPS at. Layer 1 gates in CI at 100 RPS against service containers, and the
  baseline doc keeps the runner tripwire and the latency promise apart rather than letting
  one read as the other.
- **The revocation store and the rate limiters stay in process.** `redisClient` exists now,
  which was ADR-0053's stated trigger for replacing them; D-2-01 deferred the rebind and
  re-pointed the trigger at whichever ADR supersedes ADR-0030. Revocations still die with
  the API process, bounded at the 300 s access token lifetime.
- **A multi-segment path is a JSON 404, not the branded page.** `GET /:slug` matches one
  segment, so `/a/b` falls through to the error envelope. Accepted in D-2-13; ADR-0006's
  accepted-cost note already covers the confusing-page case.
