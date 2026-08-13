# Design-mode security re-review — identity-membership, wave 1, round 5

- **Mode:** design, **scoped re-review**, the last check before the wave-1 gate. Round 5's
  diff only: `design/adr-0045`, `adr-0049`, `adr-0050`, `adr-0051`, and `tasks/TASK-002.md`,
  `TASK-009.md`, `TASK-017.md`, `TASK-018.md`, `plan.md`. F-001 … F-031 and F-033 were not
  re-opened; F-001 and F-009 stay open by design, carried in TASK-002.
- **Method:** every `resolved_by:` claim treated as unverified and checked against the file
  it names. Nothing was re-executed against a database this round — the round-5 edits are
  scope sentences and card text, and the two ADR mechanisms they touch were executed in
  round 4. What *was* executed: the two named control files were checked against the vitest
  configs and against the actual contents of `apps/api/src`, `test/isolation/coverage.ts`
  and the compose files.
- **Prior reports:** `audits/design-sdlc-security-auditor-r1.md` (round 2, F-020 … F-027),
  `r2.md` (round 3, F-028 … F-033), `r3.md` (round 4, F-034 … F-038). This is r4 = round 5.
- **Finding id range used this round:** F-039 … F-043.

## Per-finding verdicts

| id | severity | verdict | how established |
|---|---|---|---|
| F-032 | major | **ADDRESSED** | both residual controls now have a file, an owning card and a `test_files` entry, and **both were checked for reachability rather than read**. See below. The *semantics* of the first control are a new finding (F-039), not a residual of this one |
| F-034 | major | **ADDRESSED** | `TASK-018.md:89-117` declares `BETTER_AUTH_SECRET` and `DATABASE_AUTH_URL` on `docker-compose.yml`'s `api` service in wave 0, with the repair-pressure argument written where the implementer lands; `TASK-009.md:87-91` gives them up and keeps `.env.example`, README and every other `environment:` entry; `ADR-0051:223-242` names the wave, not just the TASK. The `docker-compose.test.yml` correction is **true** — that file declares one service, `postgres` (`:52`), and its `configs:` block at `:114` is the only other top-level key. What the fix does *not* carry is the values and the supporting postgres-service entry: F-040 |
| F-035 | minor | **ADDRESSED** | `TASK-002.md:144-152` states both directions in ADR-0050's own terms — all five `EXEMPT` names present and `shortkit_app` holding none of the four on them, **and** `shortkit_auth` holding none on the tenant-scoped tables — with the reason ("a one-directional matrix … says nothing about the app tables being closed to the auth role") and both round-4 measurements carried through: `has_table_privilege` OR'd with `has_any_column_privilege`, and `has_any_column_privilege`'s list being three because it rejects `DELETE`. The `Produces` bullet at `:237-239` still names the assertion in one line without the second direction; the Approach is four lines above it and is unambiguous, so this is not worth a finding |
| F-036 | minor | **ADDRESSED** | `TASK-009.md:93-95` says `apps/web/.env.example` gets neither variable and why — a Vercel project environment that reads no DSN and no auth secret. `ADR-0051:243-246` carries the same rule with the `assert-no-inlined-secrets.mjs` reason. Checked the other direction as the `resolved_by` promised: **no ADR carried the same error.** `apps/web/.env.example` appears in `design/**` only in ADR-0051's new bullet, where it is the prohibition |
| F-037 | minor | **ADDRESSED** | `TASK-017.md:72-79` names `scripts/check-compose-stack.sh:180`, quotes the three-name loop verbatim, states the fourth variable, and records the availability-not-exposure distinction. Verified at source: `:180` does iterate `POSTGRES_USER SHORTKIT_MIGRATOR_PASSWORD SHORTKIT_APP_PASSWORD`, and that script is in exactly one card's `paths` — TASK-017's. Two residuals I am filing at nit rather than re-opening: the guard stays one variable short from wave 0 to wave 9 (CI is the backstop, and it is a loud one), and TASK-018 — the card that actually writes the new `CREATE ROLE` line — still names no escape (F-043) |
| F-038 | nit | **ADDRESSED** | `plan.md:3` reads "**eighteen** TASKs"; `:5-7` is kept verbatim as the 2026-08-12 statement with `:9-16` amending it to 25 cards / eighteen TASKs / ten waves / 23 edges and stating the AC wrinkle rather than smoothing it; `:280` reads "ten waves" and "Fifteen of eighteen". **Every count recomputed from disk and every one is right**: 18 cards in `tasks/`, 1 epic, 6 stories = 25; `grep -c -- '-->' plan.md` = 23; `owner_slot` across the eighteen is 15 backend / 3 frontend; the wave table has ten rows, 0 through 9. Three lines elsewhere in the file did not move with it: F-041 |

### F-032, precisely — both controls are reachable, and one of them will not pass

The two file assignments are correct and I checked the reasoning rather than accepting it.

**`apps/api/src/db/context-flag-owners.spec.ts` collects.** `vitest.config.ts:10` includes
`src/**/*.spec.ts` and nothing else; the path matches. The `src`-spec-imports-from-`test`
precedent is real (`src/observability/framework-400-request-body.spec.ts:12` imports
`../../test/support/response-object-probe.controller`) and `apps/api/tsconfig.json` includes
both trees. `CONTEXT_FLAG_OWNERS` is at `coverage.ts:1718` exactly as claimed, exported, with
three rows, and `grep -rn CONTEXT_FLAG_OWNERS --include=*.ts` over the whole workspace returns
that one line — it still has no consumer, so the card's "gives it its first consumer" holds.

**`apps/api/test/tenancy/warm-connection-no-context.int-spec.ts` collects.**
`vitest.integration.config.ts` includes `**/*.int-spec.ts`, and its
`assertEveryIntegrationSpecRuns()` guard would have failed the run on a near-miss name. The
path is in TASK-002's `paths` (`:12`) and `test_files` (`:28`), and `apps/api/test/tenancy/`
was indeed in no other card's `paths`.

**ADR-0049's scope replacement is correct, and I verified the reasoning the architect gave
for going beyond its brief.** After migration `0001`'s `REVOKE ALL PRIVILEGES … FROM
shortkit_app`, a `SELECT` on the five as `shortkit_app` raises `42501 permission denied for
table <t>` — not zero rows. Nothing restores the privilege: `ALTER DEFAULT PRIVILEGES`
(`docker-compose.yml:334-337`) grants at creation and the `REVOKE` follows it, and Postgres
grants no table privilege to `PUBLIC` by default. So "for every table in schema `public`"
would have asserted the opposite of the property on the day ADR-0050 lands, and the
`has_table_privilege(current_user, c.oid, 'SELECT')` set is the right shape. The **oid** form
is also the right call — round 4 measured the name form raising `42P01` on an absent
relation, and a set computed from `pg_class` cannot hit that. The set is correct in wave 1:
`tenants` and `tenant_memberships`, both policy-covered; `__drizzle_migrations` lives in
schema `drizzle`, not `public`. **One clause of it is narrower than the ADR's own claim for
it** — F-042.

**What is not addressed, and it belongs to a new id.** The control's *assertion* cannot pass
in wave 1. That is F-039, and I am filing it separately rather than holding F-032 open,
because F-032 asked for a file, an owner and a `test_files` entry and got all three.

## New findings

```yaml
verdict: changes-requested
findings:
  - id: F-039
    severity: major
    kind: test-coverage
    claim_type: a control specified in a form its own contract says is not runnable this wave
    file: .sdlc/identity-membership/design/adr-0045-token-mint-membership-lookup.md
    line: 251
    summary: >-
      ADR-0045's WAVE-1 GREP CONTROL ASSERTS SET EQUALITY WITH `CONTEXT_FLAG_OWNERS`, AND TWO
      OF THE FOUR ROWS IT WOULD COMPARE AGAINST NAME FILES THAT DO NOT EXIST AND ARE NOT BUILT
      IN THIS INITIATIVE. The control fails on its first run. `isolation-coverage.md:540-542`
      says so in as many words: "A1 is not runnable earlier."
    failure_scenario: >-
      Measured on disk. `grep -rn 'set_config(' apps/api/src` returns exactly one file,
      `src/tenancy/tenant-context.ts`, with three flag names of which one begins `app.`
      (`app.tenant_id`; the other two are `statement_timeout` and
      `idle_in_transaction_session_timeout`). TASK-002 adds a second,
      `app.membership_lookup_user` in `src/auth/membership-lookup.ts` — the design stub sets
      that literal at `stubs/.../membership-lookup.ts:37`, so the grep will find it. **The
      found set in wave 1 is therefore two pairs.**
      `CONTEXT_FLAG_OWNERS` (`test/isolation/coverage.ts:1718-1722`) holds three rows today
      and four after TASK-002: `app.tenant_id` -> `src/tenancy/tenant-context.ts` (exists),
      `app.redirect_context` -> `src/redirect/db/redirect-read.ts` (**does not exist**;
      TASK-029, deferred), `app.privileged_erase` -> `src/gdpr/privileged-eraser.ts` (**does
      not exist**; TASK-054, deferred), plus the new fourth. `ls` confirms neither
      `src/redirect/` nor `src/gdpr/` is present. Two pairs cannot equal four rows.
      `isolation-coverage.md`'s own Timing paragraph, in a contract TASK-002 lists in its
      front matter, states the constraint the ADR walked into: "A1 asserts exactly-one.
      `redirect-read.ts` (TASK-029) and `privileged-eraser.ts` (TASK-054) both land before
      TASK-056's wave, so all three setters exist when the suite first runs. **A1 is not
      runnable earlier.**" ADR-0045:251 says the wave-1 control "is clause A1 as a live test
      rather than a declaration". TASK-002:158-159 repeats it — "asserts equality with
      `CONTEXT_FLAG_OWNERS`".
      **The danger is the repair, as with F-034.** This is the *one executing control wave 1
      ships*, it runs in `pnpm test` under the required `quality` job, and it is the entire
      basis on which F-025 was closed. An implementer facing a red assertion on a TDD-first
      workflow has two cheap repairs and both are wrong: delete the two deferred rows from
      `CONTEXT_FLAG_OWNERS`, which diverges the registry from the contract table at
      `isolation-coverage.md:460-464` and leaves TASK-029 and TASK-054 landing a flag setter
      with no declaration; or weaken to one direction without recording which direction
      survived, which is exactly how F-025 — "an ADR cites four controls and none of them
      executes" — comes back a third time.
      Only one of the two directions carries the security claim, and it is runnable today:
      **every `(flag, file)` the grep finds must be declared, with the file matching.** That
      is what catches a new context flag set in application code and an existing flag set in
      a second file. The other direction — every declared row must be found — is a
      liveness check on a registry whose subjects are two deferred TASKs away.
    required_change: >-
      ADR-0045 states the wave-1 form explicitly: the found set is a **subset** of
      `CONTEXT_FLAG_OWNERS` with file agreement per flag, and set equality is TASK-056's once
      `redirect-read.ts` and `privileged-eraser.ts` land. Say which direction is dropped and
      why, so a later reader cannot mistake the weaker form for erosion. Amend
      `isolation-coverage.md`'s Timing paragraph in the same commit — it currently says A1 is
      not runnable earlier, and after this change half of it is. TASK-002's bullet at
      `:158-159` says "subset with file agreement", not "equality". Two smaller items on the
      same card: TASK-002:158 says the grep runs "across `apps/api/src`" and omits the
      `*.spec.ts` exclusion that ADR-0045:250 and :278 require — without it the spec's own
      literal `set_config(` occurrences land in its own result — and the scan must exclude
      matches inside `src/db/rls.ts`, which contains three flag literals in policy templates
      and no `set_config(` (contract clauses A2/A3).

  - id: F-040
    severity: major
    kind: process
    claim_type: a variable declared in one wave whose value and supporting binding are scoped to another
    file: .sdlc/identity-membership/tasks/TASK-018.md
    line: 123
    summary: >-
      TASK-018 NOW DECLARES `BETTER_AUTH_SECRET` AND `DATABASE_AUTH_URL` ON THE `api` SERVICE
      IN WAVE 0, AND ITS "OUT OF SCOPE" LINE ASSIGNS "EVERY `environment:` ENTRY OTHER THAN
      THE TWO NAMED ABOVE" TO TASK-009, WAVE 4. The `CREATE ROLE` line it writes in the same
      wave needs one of those other entries, and neither card states a value for either of
      the two it does own.
    failure_scenario: >-
      Three parts, all measured against `docker-compose.yml`.
      **(a) `SHORTKIT_AUTH_PASSWORD` has no owner and is needed in wave 0.** The dev stack's
      role pattern is three coordinated edits, not one: `:95-96` declare
      `SHORTKIT_MIGRATOR_PASSWORD: ${SHORTKIT_MIGRATOR_PASSWORD:-migrator}` and
      `SHORTKIT_APP_PASSWORD: ${SHORTKIT_APP_PASSWORD:-app}` on the **postgres** service;
      `:310-311` pass them into psql as `-v app_password="$$SHORTKIT_APP_PASSWORD"`; `:321-322`
      are the `CREATE ROLE … PASSWORD :'app_password'` lines. TASK-018 owns the third and its
      "Out of scope" sends the first to wave 4. The init script runs under `set -eu`
      (`:307-308`), so an unset `$$SHORTKIT_AUTH_PASSWORD` aborts the postgres init entirely.
      The wave-0 implementer following the scope line writes a **literal** password instead —
      which is what `docker-compose.test.yml:122-123` does and what `:299-302`'s comment says
      the dev file deliberately does not do, because "psql does the quoting here, so an
      overridden password of any shape is quoted correctly instead of concatenated into DDL" —
      or leaves the stack unable to come up.
      **(b) `BETTER_AUTH_SECRET` needs a compose default that satisfies three constraints, and
      nothing states them.** `docker-compose.yml:228`'s existing entry is
      `DATABASE_URL: postgres://shortkit_app:${SHORTKIT_APP_PASSWORD:-app}@…` — the dev stack
      runs on defaults, and `check-compose-stack.sh:180` *refuses to run* if those variables
      are exported, so the default is the only value the `compose` job ever sees. From wave 2
      `assertBetterAuthSecretConfigured()` throws on unset, on empty, on shorter than 32
      characters, and on the published `better-auth-secret-12345678901234567890` by exact
      value (ADR-0051:114-115, :68). A declaration written as `${BETTER_AUTH_SECRET}` with no
      default, or with the value a reader most naturally copies out of better-auth's own docs,
      **reproduces F-034 exactly** — `api` refuses to boot, `check-compose-stack.sh`'s AC-115.3
      goes red, `compose` goes red, and `gate` is the required check. Same repair pressure,
      same two cheap wrong fixes, one wave later than the one F-034 moved it out of.
      **(c) `DATABASE_AUTH_URL`'s DSN must default to the same password the `CREATE ROLE` line
      used.** `${SHORTKIT_AUTH_PASSWORD:-auth}` in the DSN and `'auth'` literal in the role, or
      any other desync, produces an auth pool that cannot connect. Availability, not exposure —
      the stack is `127.0.0.1`-bound — but it is red in the wave the whole split lands.
    required_change: >-
      TASK-018's "Out of scope" line carves out the postgres service's
      `SHORTKIT_AUTH_PASSWORD: ${SHORTKIT_AUTH_PASSWORD:-…}` entry and the `-v
      auth_password="$$SHORTKIT_AUTH_PASSWORD"` psql argument as **its own**, in wave 0,
      naming `docker-compose.yml:95-96` and `:310-311` as the sites. Its `Produces` states the
      compose default for `BETTER_AUTH_SECRET` and the three constraints it has to clear —
      non-empty, at least 32 characters, not the library default — with ADR-0051:68 as the
      source, and states `DATABASE_AUTH_URL`'s DSN in full so its password default and the
      role's password are visibly the same string. ADR-0051's TASK-018 bullet (`:229-232`)
      says the same about the default; today it names the variable and not its value.

  - id: F-041
    severity: minor
    kind: documentation
    claim_type: a plan whose graph and ownership prose still describe the state F-034 replaced
    file: .sdlc/identity-membership/plan.md
    line: 155
    summary: >-
      `plan.md`'s WAVE-0 ROW AND ITS MULTI-CLAIMANT LIST STILL SAY TASK-009 OWNS
      `docker-compose.yml`'s `environment:` BLOCKS, WHICH IS THE ARRANGEMENT F-034 WAS FILED
      AGAINST AND ROUND 5 UNDID. Its edge count line also still says 22 where the header
      amendment says 23.
    failure_scenario: >-
      `:155`, the wave-0 row: "Touches `docker-compose.yml` and `docker-compose.test.yml` for
      their `CREATE ROLE` blocks; **TASK-009 owns those files' `environment:` blocks four
      waves later**." `:169`: "`docker-compose.yml` (018 roles, 009 environment)". Both are
      the pre-F-034 split, and both sit in the section the plan itself calls the graph and the
      constraints — the artifact a later auditor or a re-planning pass reads instead of the
      cards. `:141` reads "Acyclic, 22 edges" against `:11`'s "23 edges"; the graph block does
      carry the `TASK-018 --> TASK-002` edge at `:112`, and `grep -c -- '-->'` returns 23, so
      the header is right and `:141` is the stale line. Same class one card over:
      `TASK-017.md:98` still says "**From TASK-009**: `docker-compose.yml` with the `api`
      service's auth environment declared", and `:89` scopes "the environment declarations" to
      TASK-009 — TASK-017 is wave 9 and consumes the running stack, so nothing breaks, but the
      attribution is now wrong in the card that reads the stack. Nobody is attacked by any of
      this. It is filed because F-034's whole content was a wave assignment being wrong in the
      file that assigns waves.
    required_change: >-
      `plan.md:155` and `:169` say TASK-018 owns `docker-compose.yml`'s two auth
      `environment:` entries in wave 0 and TASK-009 owns the rest in wave 4. `:141` reads 23.
      `TASK-017.md:89` and `:98` attribute the auth environment to TASK-018.

  - id: F-042
    severity: minor
    kind: test-coverage
    claim_type: a control scoped by a predicate weaker than the one its own ADR cites as its source
    file: .sdlc/identity-membership/design/adr-0049-context-flags-are-never-cast-directly.md
    line: 289
    summary: >-
      ADR-0049 SCOPES THE BEHAVIOURAL CONTROL WITH `has_table_privilege(current_user, c.oid,
      'SELECT')` AND CALLS IT "THE CATALOGUE PREDICATE ADR-0050'S GRANT MATRIX ALREADY USES".
      IT IS NOT. Round 4 changed ADR-0050's matrix to `has_table_privilege` **OR'd with**
      `has_any_column_privilege`, and the difference is the thing the control claims to catch.
    failure_scenario: >-
      Round 4 measured this on a live Postgres and ADR-0050 was rewritten for it:
      `GRANT SELECT (email) ON "user"` leaves `has_table_privilege(…, 'SELECT')` false while
      `has_any_column_privilege` returns true and `SELECT email` returns the row. TASK-002's
      card carries the corrected form at `:149-152`. ADR-0049:288-290 carries the uncorrected
      one, and cites ADR-0050 as its authority for it.
      The consequence lands on the exact property the ADR advertises. `:292-294`: "A sixth auth
      table that nobody revoked stays in the set, carries no policy, and returns rows to the
      no-context `SELECT`. This control fires on that, which is the F-239 failure mode." A
      sixth auth table reachable through a **column** grant does *not* stay in the set —
      `has_table_privilege` returns false, the table is filtered out, the control never queries
      it, and it returns rows to a no-context read with nothing looking. The attacker here is
      thin and I am filing this minor because of it: the default path is table-level
      (`ALTER DEFAULT PRIVILEGES … GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES`), so the gap
      needs a hand-written column grant in a future migration. But that is precisely the case
      round 4 spent a measurement on, and the sentence claiming parity with ADR-0050 is false
      as written.
    required_change: >-
      ADR-0049's set predicate reads `has_table_privilege(current_user, c.oid, 'SELECT') OR
      has_any_column_privilege(current_user, c.oid, 'SELECT')`, and the sentence claiming it is
      the predicate ADR-0050's matrix uses becomes true rather than being deleted. TASK-002's
      second control bullet (`:167-173`) carries the same OR — it currently states the
      table-level call alone.

  - id: F-043
    severity: nit
    kind: documentation
    claim_type: a card editing two blocks of one file with opposite escaping rules and naming neither
    file: .sdlc/identity-membership/tasks/TASK-018.md
    line: 69
    summary: >-
      TASK-018 NOW EDITS BOTH THE `configs:` ROLE SCRIPT AND THE `api` SERVICE'S
      `environment:` BLOCK IN `docker-compose.yml`. THOSE TWO BLOCKS TAKE OPPOSITE `$`
      CONVENTIONS AND THE CARD NAMES NEITHER, NOR F-315, NOR F-316.
    failure_scenario: >-
      Inside `configs: content:` the value is consumed by a shell in the container, so Compose
      must be prevented from interpolating: `docker-compose.yml:310-311` writes
      `-v app_password="$$SHORTKIT_APP_PASSWORD"`. Inside `environment:` the opposite is
      wanted, and `:228` writes a single `$`:
      `${SHORTKIT_APP_PASSWORD:-app}`. Getting either backwards is the whole of F-315 and
      F-316, and `check-compose-stack.sh:180`'s contaminant guard exists because an exported
      value repairs the first mistake locally while leaving a clean machine broken. `grep '\$\$'
      TASK-018.md` returns nothing; `grep 'F-315\|F-316\|escape'` returns nothing. TASK-017
      explains the guard well (`:72-79`) but TASK-017 is wave 9 and does not write the line.
      Every wrong version of this is caught by CI in wave 0, loudly and in front of the person
      who wrote it, which is why this is a nit and not F-037 re-opened. Two lines on the card
      remove it entirely.
    required_change: >-
      TASK-018 names both conventions with their line numbers — `$$` in the `configs:` role
      script per `docker-compose.yml:310-311`, single `$` with a `:-` default in the `api`
      service's `environment:` per `:228` — cites F-315/F-316, and records that
      `check-compose-stack.sh:180`'s guard does not cover the new variable until TASK-017 in
      wave 9, so a wrong escape is caught by CI rather than locally.
```

## Notes

**What round 5 got right, on the record before the residual.** Four of the six re-reviewed
findings are closed by a card sentence that says the true thing and gives its reason, which is
the shape that survives into the Implement phase. Two are better than that. **F-034's fix is
causal, not cosmetic** — the declarations moved to the wave whose boot assertion needs them,
and the ADR now names the wave rather than the TASK, which was the actual defect. And **the
architect's two out-of-brief edits were both correct and both flagged.** I verified the
load-bearing one from the privilege model rather than accepting the reasoning: after `REVOKE
ALL PRIVILEGES … FROM shortkit_app`, the five exempt tables answer `42501`, nothing restores
the privilege (default privileges grant at creation and the `REVOKE` follows; Postgres grants
no table privilege to `PUBLIC`), and "for every table in schema `public`" would have asserted
the opposite of the property from the day ADR-0050 lands. Replacing the scope with a computed
set was right, using the `oid` form was right for the `42P01` reason round 4 established, and
computing rather than listing does buy the sixth-auth-table property it claims — for
table-level grants. F-042 is one clause of that predicate, not the shape of it.

**On the orchestrator's own card text, which is what I was asked to press on.** The
`docker-compose.test.yml` correction is true and I re-verified it independently: that file
declares one service. Checking for more of the same class, I diffed every round-5 obligation
against the ADR that decided it and against the repository. The three that hold are TASK-002's
grant matrix (both directions, with both of round 4's measurements carried through correctly),
TASK-009's handover, and TASK-017's guard section. **The pattern that did not hold is the same
one twice**: a scope sentence that draws a boundary the repository does not have. TASK-018's
"every `environment:` entry other than the two named above — TASK-009, wave 4" sends the
password its own `CREATE ROLE` line consumes into a wave four later (F-040a), and `plan.md`'s
wave-0 row draws the pre-F-034 boundary in the file that is the graph (F-041). Both are the
same failure as the `docker-compose.test.yml` sentence — a boundary written from the ADR
rather than from the file — and both are one sentence to repair.

**F-039 is the one that will bite, and it is not the orchestrator's.** It was reachable from
round 3's ADR text and neither round 4 nor I caught it then; I closed F-025 on a control
described in a form the contract governing it says is not runnable this wave. Verified from
disk this round rather than reasoned: two setter files in `CONTEXT_FLAG_OWNERS` do not exist,
are not built by this initiative, and `isolation-coverage.md:540-542` states the constraint in
its own words. The subset direction is the one carrying the security claim and it runs today;
the repair is naming which direction wave 1 ships, in three artifacts, and it does not weaken
what F-025 was closed for.

**Three things I checked this round and did not file.**

- *`plan.md`'s invariant 11 after the round-5 edits.* Re-parsed the eighteen cards' `paths`
  and re-intersected pairwise within each wave: still zero same-wave collisions. TASK-018
  (wave 0) and TASK-009 (wave 4) both hold both compose files; four waves apart.
- *TASK-002's `Produces` bullet stating the grant matrix in one line without the second
  direction.* The Approach four lines above is unambiguous and names F-035 and ADR-0050. A
  finding here would be compliance-shaped.
- *TASK-017's guard widening landing in wave 9 while the variable it guards arrives in wave 0.*
  The guard makes a local machine red where CI is already red; the nine-wave lag costs
  local-first feedback, not coverage. Folded into F-043's `required_change` as a sentence on
  TASK-018's card rather than filed as a finding of its own.

**On the verdict, and on whether this wave is done.** `changes-requested`, and I want to be
precise about what that does and does not mean at a five-round cap of two. **Five of six
re-reviewed findings are closed and the sixth is closed on everything it asked for.** Nothing
in this report re-opens F-001 … F-038, nothing in it is an exploitable path in shipped code,
and nothing in it is a decision that needs remaking — every one of the five is a sentence, a
predicate clause or a line number. Of the five, exactly two matter: **F-039**, because the one
executing control wave 1 ships cannot go green in the form three artifacts specify, and the
cheap repairs re-open F-025; and **F-040**, because a variable declared in wave 0 whose value
and supporting binding are scoped to wave 4 is F-034's shape a second time. **F-041, F-042 and
F-043 would not, on their own, be worth a sixth round.** If the gate rules that F-039 and
F-040 are Implement-phase corrections carried on the cards rather than Design-phase edits, I
would not argue the wave is unfinished — they are both fully specified above, both land in
TASK-002 and TASK-018, and both fail loudly rather than silently if missed.

## Dependencies reviewed

Round 5 adds no dependency, bumps nothing and touches no lockfile. It re-states no library
behaviour that round 3 or round 4 did not already execute against `apps/api/node_modules` for
the pinned `better-auth@1.6.26`: ADR-0051's `create-context.mjs:70` `||` chain and its
seven-row table are unchanged this round, and ADR-0052's logger displacement is untouched.
ADR-0050 still adds no package — a database role, a DSN and a second `pg.Pool` on the
already-present `pg` driver.
