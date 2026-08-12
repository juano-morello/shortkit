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

## Carried forward from `foundation` (F-389, 2026-08-11)

**Twelve obligations belong to deferred work and had no carrier past this initiative.** Ship is the
last gate where the record is still in one place — `findings.yaml` is 808 KB, and one of these
items has a record that reads `status: fixed`. Each is named here with the roadmap entry that
inherits it and the ruling that produced it.

Six came from F-389's sweep on 2026-08-11. Four more — F-236, F-239, F-102, F-157 — were added at
the Retro gate on 2026-08-12, because the prose-driven sweep missed them; that is why
`check-ledger.mjs` rule 4 now asserts this table mechanically. The last two, F-400 and F-401, are
Retro-phase findings and are **below `check-ledger`'s reach**: it only asserts a carrier for
`major` and `blocker`, and both were filed `minor`.

| Obligation | Inherited by | Ruling |
|---|---|---|
| **F-018 is reopened** — `@Public()` invitation routes have no IP-keyed limit in any environment that exists today. Its record still reads `status: fixed`, annotated but not flipped, deliberately: the fix it describes was real and correct against the design of the day, and what changed is the design underneath it. | Item 1 (invitations, auth) | ADR-0040 + Juano's fail-open ruling, 2026-08-11 |
| **The TASK-009 boot assertion** — `assertTrustedClientIpHeaderConfigured()` and `assertBffProxySecretConfigured()`, both gated on a declared property rather than `NODE_ENV`. `TASK-009.md` mentions neither ADR-0040, nor the assertions, nor F-018. | Item 1 | ADR-0040 (F-380), rate-limit.md (F-385) |
| **F-036, F-037** — parked majors on the architect, from the design phase. | whichever entry revives their subject | parked at the design cap |
| **F-300 / F-362** — `invitation-tokens.md` invariant 5 is corrected but the mechanism is undecided: the raw token sits in the URL path on **both** the `GET` and the `POST` accept legs, so the two recorded fixes are **not** equivalent. A redirect covers the GET and not the POST. | Item 1 | Juano's park-and-correct ruling, 2026-08-11 |
| **F-350** — the drift repair reached the isolation suite and not the GDPR paths. `tenantScopedTables()` still has no name-independent derivation, and it is what export and erasure iterate. | Item 4, and any entry adding a tenant-scoped table | ADR-0019 amendment, 2026-08-11 |
| **F-386** — `mail-sender.md` binds the **live Resend sender** when `NODE_ENV` is `production`, which `Dockerfile:83` sets under `docker compose up`. It does not refuse to boot; it waits, and sends real email the first time anyone invites someone from a local stack. | Item 1, or whichever entry writes mail | ruled 2026-08-12: `MAIL_TRANSPORT` is a third declaration, unset binds `NoopMailSender` |
| **F-401 — the mail stub is stale in the unsafe direction.** `design/stubs/apps/api/src/mail/mail-sender.ts` still binds on `NODE_ENV` in four docblocks and has no `NoopMailSender`, while the contract F-386 just corrected forbids exactly that. **An implementer who trusts the stub over the contract reintroduces F-386**, and it fails silently — the stub's version boots and sends. This is F-288's mechanism: a normative-looking artifact carrying a rule the source of truth has replaced. The `apps/web` stub-drift gate does not cover `apps/api`. | Item 1, or whichever entry writes mail | a stub sweep, or TASK-010's ADR-0039 retirement, whichever comes first |
| **F-400 — `domain-provisioning.md:134` names no selector.** It says "Production resolves over DNS-over-HTTPS" and TASK-039 will invent one; the obvious invention is `NODE_ENV`. A DoH resolver bound that way under `docker compose up` resolves real DNS from a laptop against a stranger's domain — the F-386 shape one subsystem over. Caught before it was written, because the architect was asked to enumerate bindings rather than assertions. | Item 3 (custom domains) | name the selector as a declared property, per ADR-0017 and ADR-0040 |
| **F-236 — the GDPR eraser erases nothing and reports success.** `PrivilegedTenantEraser.erase` written the obvious way deletes no rows and returns cleanly. This is F-002's class — a design blocker fixed at *policy* level in design round 1 — reappearing at *statement* level, because the policy fix was verified against the policy set and never against a statement issued under it. **The most consequential item in this table.** | Item 1, and any entry touching GDPR erasure | filed at TASK-006 delivery; owner TASK-054, deferred |
| **F-239 — `ALTER DEFAULT PRIVILEGES` grants `shortkit_app` full DML on every table the migrator creates**, so a new table is writable by the runtime role before anyone writes a policy for it. | Item 1, and any entry adding a table | owner TASK-009, deferred |
| **F-102 — AC-68 versus F-097's DNS-proof ordering.** A finding against an approved artifact, so routing rule 0 makes it Juano's, and it must settle before custom domains are dispatched. | Item 3 (custom domains) | escalated 2026-08-03, unresolved |
| **F-157 — no build-output scan can cover dynamic routes**, which is where the entire authenticated surface will live. AC-113's guard is sound for what it scans and structurally blind to what comes next. | Item 1, when the first authenticated route lands | closed against TASK-004; the residual is real |

**Why this block exists rather than a pointer to `findings.yaml`.** The initiative named the same
defect four times in its own logs — a routing recorded as a resolution, a record that lagged its
artifact, a fix that landed where the finding pointed and survived everywhere it did not. It is
also the stated reason the ADR-0041, ADR-0042 and F-369 cards above are on this roadmap at all.
A refiner who opens an entry reads this file; they do not grep a 770 KB ledger.

## The compose gate, and how to de-gate it if the first run is red (F-390, 2026-08-11)

`scripts/check-compose-stack.sh` is now a **required** CI check — a third gating job, `compose`,
alongside `quality` and `integration`. The implementer chose a gating job over a nightly and over a
manual cadence, and the reasoning is worth keeping: **a nightly is chronologically detached from the
commit that broke it**, and this check only goes red because the tree changed — unlike
`dependencies.yml`, whose schedule exists to re-ask about *unchanged* code.

**It has never been observed on a GitHub runner.** Disk for four cold-built images is the item that
could least be verified locally. So, recorded before anyone needs it:

- **If the first run is red environmentally, the smallest correct repair is to remove `compose`
  from `gate`'s three lists — `needs`, `env:`, and the assertion loop — and leave the job visible.
  Do not weaken the script.** A job named in fewer than all three blocks nothing, so all three move
  together or the change is a no-op that reads like a fix.
- **Exit code 2 means "could not run, nothing measured"** and is never an AC-115 failure. That
  distinction is written into the workflow and into the script; a red `compose` job needs its exit
  code read before it is diagnosed.

Recorded here because the choice and its fallback had no carrier otherwise, which is F-389's exact
shape one day later — and it was the implementer, not an auditor, that pointed out its own decision
had nowhere to live.

## The stub-drift gate: its scope, and when to widen it (F-288, 2026-08-12)

`.github/scripts/assert-stub-drift.mjs` closes the gap ADR-0039 admits it leaves open — the gap
F-288 came through, named four times across the foundation initiative and gated by nothing. It
compares each surviving stub with the source file at the same path on **exported shape** and fails
when a declaration the stub exports is missing from the source or has a different signature. Bodies,
comments, declaration order, interface member order, union order, parameter names and `async` are
all excluded, because a check that fires on those is a check nobody keeps green.

**It gates as a step in `quality`, not as a fourth job.** `quality` is already named in `gate`'s
`needs`, its `env:` and its assertion loop, so a step inside it blocks a merge with no wiring to
keep in step across three places — which is the failure F-390 filed against the compose script. A
job earns its three entries when it needs its own services or its own timeout; this one is a
filesystem walk and a parse, well under a second. **De-gating it is therefore one line**: delete the
`Assert no surviving design stub has drifted from its source` step. Do not weaken the script, and do
not touch `gate`.

**Two things about its scope are true today and should not be discovered by surprise:**

- **F-403 — it enforces `apps/web/**` only, and that stub has no source yet, so it currently
  compares zero gating pairs.** That is the retro's approved scope and the correct verdict under ADR-0039 clause 2,
  and the run prints both facts rather than reporting a clean green. It starts defending the moment
  TASK-012 lands `apps/web/src/lib/session/session.ts` — the same window F-288 happened in.
- **F-404 — `apps/api/src/observability/logger.ts` is really drifted and is reported without
  gating.** The stub exports `REDACT_PATHS`, `createLogger`, `CORS_ENABLED` and `HSTS_MAX_AGE_S`;
  the source exports none of them. `REDACT_PATHS` and `createLogger` are the known F-249
  supersession; **`CORS_ENABLED` and `HSTS_MAX_AGE_S` are not obviously covered by it** and should
  be checked rather than assumed when the stub retires. Treated as known drift, not a new defect —
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
performed on that stub and reported the exported declaration sets matching exactly — true at the
level of names, false at the level of signatures. The stub is gone and there is nothing to fix; the
point is that the human check missed it and this one does not. Filed as **F-402**, parked, and
recorded so ADR-0039's clause-4 claim is never cited as a stronger check than it was — that sweep
authorised ten deletions.
