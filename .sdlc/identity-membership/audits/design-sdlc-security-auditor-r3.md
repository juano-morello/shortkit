# Design-mode security re-review — identity-membership, wave 1, round 4

- **Mode:** design, **scoped re-review**, closing check before the wave-1 gate. Not a fresh
  audit. Scope is the round-4 revisions only: ADR-0044/0045/0046/0049/0050/0051/0052, the two
  identity-membership contracts, the two foundation contracts, `design/stubs/**`, **and the
  orchestrator's own rewrite of `tasks/**` and `plan.md`**.
- **Method:** every `resolved_by:` claim treated as unverified. F-029 and F-031 were
  **re-executed**, not re-read, against real `pg_policies.qual` and real
  `has_table_privilege` / `has_any_column_privilege` answers on a throwaway Postgres 17
  (`audit-r4-pg`, `--rm`, port 55434), scratch database `audit_r4`, created and dropped, the
  container stopped and removed. The project's `shortkit-postgres-1` was never started and
  the `shortkit` / `shortkit_test` databases were never touched.
- **`tasks/**` and `plan.md` were read in full**, as the dispatch permits. Path-overlap and
  wave arithmetic were computed from the eighteen cards' front matter rather than from the
  plan's prose.
- **Prior reports:** `audits/design-sdlc-security-auditor-r1.md` (round 2, F-020 … F-027) and
  `audits/design-sdlc-security-auditor-r2.md` (round 3, F-028 … F-033). This is r3 = round 4.
- **Finding id range used this round:** F-034 … F-038.

## Per-finding verdicts

| id | severity (r3) | verdict | how established |
|---|---|---|---|
| F-028 | major | **ADDRESSED** | read + front matter verified on disk: ADR-0050 `supersedes_in_part: ADR-0044, ADR-0046`, ADR-0046 `superseded_in_part_by: ADR-0050`, four sentences struck in place, the Alternatives row marked TAKEN with its Cons intact, and the "do not touch the `REVOKE`" trap written where the implementer lands. Pointers repaired at `stubs/README.md:35-41` and `auth-schema.md:129-137`, and TASK-002's card carries the same warning |
| F-029 | major | **ADDRESSED** | **re-executed.** Both "is untouched" paragraphs struck, `tenantScopedPolicies()`'s snippet shows both policies, migration `0001` is four DROP/CREATE pairs. Built the round-4 DDL on the scratch database and ran the counting control exactly as ADR-0049 specifies it over every row of `pg_policies` in schema `public`: **7 policies, 7 ACCEPT, 0 REJECT** |
| F-030 | minor | **ADDRESSED** | read: the false sentence is struck and replaced with what is true — `assertRuntimeRoleCannotBypassRls` stays parameterless and `DATABASE_URL`-only, the auth role's posture moves to `assertAuthRoleSeparation` with its own `AUTH_VERDICT_PREFIX` and its own `BootPrecondition`. `tenant-context.md:400-407` carries the same correction, and TASK-004's card names the non-change explicitly |
| F-031 | major | **ADDRESSED** | **re-executed.** Reconstructed the attack state (`REVOKE ALL` on the five, then `GRANT INSERT ON "session" TO shortkit_app`): the r3 form returns `false` and passes; the r4 form returns `clean = f` on `session` and fires. All three supporting measurements reproduced independently — comma list is ANY-of, `has_table_privilege` misses `GRANT SELECT (email)` while `has_any_column_privilege` catches it, and `has_any_column_privilege` raises `unrecognized privilege type: "DELETE"` |
| F-032 | major | **NOT ADDRESSED** | four of six items done and done well; **two are untouched**. See below |
| F-033 | minor | **ADDRESSED** | read: ADR-0051 gains a normative docblock — `betterAuthSecret(): string` throws on unset, empty, under 32 characters and on the published default — with the `||` chain at `create-context.mjs:70` given as the reason. The assertion is moved to TASK-003/wave 2, struck in place in both the Decision and the Follow-ups. The orchestrator's own correction is **true**: `auth-fixture.ts:85` does set a non-default 53-character `BETTER_AUTH_SECRET` |

### F-032, precisely

The card work is materially good and I want that on the record before the residual: five cards
gained dated obligation sections that name their ADR, TASK-009's `paths` gained
`docker-compose.test.yml` which was in **no** card's paths at all, TASK-018 exists and is
written from the repository rather than from the ADR, and the two card gaps the architect
reported were checked rather than applied. Measured across the eighteen cards, seven of the
eight strings F-032 grepped for now appear:

| string | cards naming it |
|---|---|
| `BETTER_AUTH_SECRET` | 003, 009, 018 |
| `shortkit_auth` | 002, 004, 009, 017, 018 |
| `DATABASE_AUTH_URL` | 002, 004, 009, 018 |
| `assertAuthRoleSeparation` | 003, 004, 009, 018 |
| ADR-0050 / ADR-0051 / ADR-0052 | 002,004,009,017,018 / 003,018 / 003 |
| **`CONTEXT_FLAG_OWNERS`** | **none** |

The two residual items are the two F-032's `required_change` called "the two new controls",
and neither got a file name, an owning card or a `test_files` entry:

1. **ADR-0045's `set_config(` grep control.** ADR-0045:248-254 — "**Wave 1 therefore ships one
   executing control**", a unit test grepping `apps/api/src/**/*.ts` for `set_config(` first
   arguments and asserting equality with `CONTEXT_FLAG_OWNERS`. `CONTEXT_FLAG_OWNERS` appears
   in zero of eighteen cards. **F-025 was verdicted ADDRESSED in round 3 on the strength of
   this control existing**, because the ADR's narrowness argument otherwise rests on four
   declarations and nothing that runs. A control in no card is not written in the Implement
   phase, and F-025 reopens quietly when it is not.
2. **ADR-0049's behavioural control** — for every table in schema `public`, a warm no-context
   `SELECT` returning zero rows rather than raising. ADR-0049 introduces it as the thing that
   covers what the syntactic control cannot see (a flag reached through a function wrapper, a
   view, a stable helper). TASK-002's `test_files` names three files and none of them is it;
   no other card mentions it. The only near-match in the repository is
   `apps/api/test/tenancy/tenant-context.int-spec.ts:536`, which is F-004's warm-state
   construction and asserts something else.

Everything else F-032 asked for is present. The verdict is `NOT ADDRESSED` rather than
`ADDRESSED` because item 1 is load-bearing on an already-closed finding.

## New findings

```yaml
verdict: changes-requested
findings:
  - id: F-034
    severity: major
    kind: process
    claim_type: a wave ordering that makes a required CI gate red for two consecutive waves
    file: .sdlc/identity-membership/plan.md
    line: 143
    summary: >-
      TASK-003 ADDS AN UNCONDITIONAL BOOT ASSERTION ON `BETTER_AUTH_SECRET` IN WAVE 2, AND THE
      AUTH POOL NEEDS `DATABASE_AUTH_URL` FROM WAVE 2 AS WELL. BOTH VARIABLES REACH
      `docker-compose.yml`'s `api` SERVICE ONLY IN WAVE 4, TASK-009. Waves 2 and 3 ship a
      repository whose `compose` job — a required check — cannot go green.
    failure_scenario: >-
      Wave 0 does precede every consumer of the *role*; I checked that and it holds. What does
      not hold is the *DSN and the secret*.
        - TASK-003, wave 2, now owns `assertBetterAuthSecretConfigured()` and its call in
          `main.ts` (Juano's F-033 ruling, TASK-003.md:129-136). It throws when
          `BETTER_AUTH_SECRET` is unset. ADR-0051:212 assigns the compose and `.env.example`
          declaration to **TASK-009**, wave 4.
        - ADR-0051:234-235 states it in its own words: "The API child process it spawns will
          refuse to boot **from wave 2** without one", about `DATABASE_AUTH_URL`. ADR-0050's
          GC-B section makes it "required unconditionally in every environment", with "no
          fallback to `DATABASE_URL`". TASK-009, wave 4, is where it is declared.
        - `docker-compose.yml:227-228` gives the `api` service exactly one variable,
          `DATABASE_URL`. TASK-018 holds `docker-compose.yml` in its `paths` but scopes itself
          out of `environment:` blocks in as many words (TASK-018.md:64-66, :86-87).
      What that costs, measured against the repository rather than inferred:
      `.github/workflows/ci.yml:322-352` runs `pnpm test:compose` on **every push**, and
      `ci.yml:382-386` makes `compose` one of three jobs `gate` fans in — `gate` is the
      branch's required check. `scripts/check-compose-stack.sh:109` declares clause AC-115.3,
      "the API reaches a healthy state", and `:116-117` declare AC-115.8/9 on `GET /health`.
      An `api` container that refuses to boot fails all three. So TASK-003 and TASK-004 cannot
      be merged green, and the failure is not a test the implementer wrote — it is the stack.
      **The repair pressure at that moment is the problem, not the redness.** The two cheapest
      repairs both undo a decision this round was spent making: delete or soften the boot
      assertion Juano just moved into wave 2 to close a one-wave window, or give
      `DATABASE_AUTH_URL` a fallback to `DATABASE_URL` — which ADR-0050 names by name as the
      thing that "would silently restore `shortkit_app` as the auth role and every gate would
      stay green". Juano's F-033 ruling is what widened this from one wave to two; it is the
      right ruling and this is its unpriced cost.
    required_change: >-
      Either move the two declarations out of TASK-009 into a wave at or before 2 — they are
      four lines across two compose files and one `.env.example`, and TASK-018 already holds
      both compose files in `paths` — or split TASK-009's declaration half into wave 2 and
      leave its README/`.env.example` prose in wave 4. Whichever is chosen, state the wave in
      ADR-0050's GC-B section and in ADR-0051's follow-up, both of which currently say
      TASK-009 without saying when that is.

  - id: F-035
    severity: minor
    kind: contract
    claim_type: a card stating half of the control its ADR decides
    file: .sdlc/identity-membership/tasks/TASK-002.md
    line: 140
    summary: >-
      TASK-002'S CARD SPECIFIES THE GRANT MATRIX IN ONE DIRECTION ONLY. ADR-0050 decides it in
      two, and the second direction is the one that catches `shortkit_auth` granted more than
      the five auth tables.
    failure_scenario: >-
      The card: "Plus the grant matrix: all five `EXEMPT` names present, and for each,
      `shortkit_app` holding none of `SELECT,INSERT,UPDATE,DELETE`." Its `Produces` bullet
      repeats the same one direction. ADR-0050's own SQL computes `app_dml` **and** `auth_dml`
      over every table in schema `public` and asserts "a table is in `EXEMPT` if and only if
      `auth_dml` is true and `app_dml` is false, and every other table has `app_dml` true and
      `auth_dml` false" — and ADR-0050 says why in its boot-assertion section: "A
      one-directional check passes on a database where `shortkit_auth` was granted
      everything." An implementer working from the card writes the direction the card names.
      The exposure is bounded and that is why this is minor, not major: `shortkit_auth` holds
      `NOBYPASSRLS`, tenant-scoped tables carry `FORCE ROW LEVEL SECURITY`, and Better Auth's
      connection sets no `app.tenant_id`, so an over-granted auth role reads zero rows through
      policy — measured. And `assertAuthRoleSeparation` (TASK-004, wave 3) does run the second
      direction. What is lost is the CI half of a control an ADR decided in both halves.
    required_change: >-
      TASK-002's section and `Produces` state both directions, in ADR-0050's own words: exempt
      tables reach `shortkit_auth` and not `shortkit_app`; every other table the reverse.

  - id: F-036
    severity: minor
    kind: security
    claim_type: an instruction placing server-side secrets in a client app's environment template
    file: .sdlc/identity-membership/tasks/TASK-009.md
    line: 81
    summary: >-
      TASK-009'S CARD SAYS `BETTER_AUTH_SECRET` AND `DATABASE_AUTH_URL` ARE DECLARED "IN BOTH
      COMPOSE FILES AND BOTH `.env.example` FILES". One of those two files is
      `apps/web/.env.example`, which its own header says is registered as Vercel Project
      Environment Variables. Neither variable is read by `apps/web`.
    failure_scenario: >-
      `apps/web/.env.example:1-2`: "Copy to `.env.local` for local development. **On Vercel
      these are registered as Project Environment Variables**, not committed files." The file
      holds three entries today and each has a stated web-side consumer;
      `BFF_PROXY_SECRET` is the only secret and `apps/web/scripts/assert-no-inlined-secrets.mjs`
      is built around that one value.
      An implementer following the sentence literally adds a Postgres DSN carrying
      `shortkit_auth`'s password, and the symmetric key for `jwks.privateKey`, to the template
      for the environment of a deployed Next.js project — a surface with a different access
      list, a different audit trail and a different set of people who can read it, for a value
      no code in `apps/web` reads. The `assert:no-secrets` guard does not cover them: it
      searches `.next` for `BFF_PROXY_SECRET`'s value specifically, so a second and third
      secret in that file are outside its reach.
      The card contradicts itself four lines later — its `Produces` says
      "`apps/web/.env.example` — the **web-side** variables" — which is the correct rule and is
      the reason this is minor rather than major: the card contains its own repair, unmarked.
    required_change: >-
      Say api-side: both variables go in `apps/api/.env.example`, both compose files and the
      README. State that neither belongs in `apps/web/.env.example`, and why — that file is a
      Vercel project's environment, and `apps/web` reads neither value.

  - id: F-037
    severity: minor
    kind: security
    claim_type: an existing guard left one variable short of the surface it guards
    file: .sdlc/identity-membership/tasks/TASK-018.md
    line: 63
    summary: >-
      TASK-018 ADDS A THIRD `CREATE ROLE ... PASSWORD :'...'` LINE TO BOTH COMPOSE INIT
      SCRIPTS, AND NO CARD WIDENS THE F-315/F-316 CONTAMINATION GUARD THAT EXISTS TO CATCH A
      MISSING `$$` ON EXACTLY THAT LINE. The guard's variable list is hardcoded to three names.
    failure_scenario: >-
      `scripts/check-compose-stack.sh:180` iterates a literal list — `POSTGRES_USER`,
      `SHORTKIT_MIGRATOR_PASSWORD`, `SHORTKIT_APP_PASSWORD` — and refuses to run if any is
      exported, because "an exported value here silently repairs a missing `$$` escape and
      turns a stack that is red on a clean machine green on yours (F-315, F-316)".
      `docker-compose.yml:308-311` shows the pattern the new line copies: `-v
      app_password="$$SHORTKIT_APP_PASSWORD"`. A fourth role password variable written with a
      single `$` is interpolated by Compose against the host at parse time, and on a developer
      who has it exported the stack comes up correctly while a clean machine gets
      `CREATE ROLE shortkit_auth LOGIN PASSWORD ''`.
      I measured what that produces, because it changes the severity. Postgres answers
      `NOTICE: empty string is not a valid password, clearing password` and creates the role
      with **no** password; the stock image's `pg_hba.conf` trusts only `127.0.0.1` **inside**
      the container and applies `scram-sha-256` to everything arriving through the published
      port, and a login attempt from outside the container is refused with
      `fe_sendauth: no password supplied`. **So this is not a credential exposure**, and I am
      filing it minor for that reason: it is the auth pool failing to connect, on the machine
      that is not the developer's, in the wave where the whole role split lands. The guard that
      would have named it is one array entry short, and `scripts/check-compose-stack.sh` is in
      exactly one card's `paths` — TASK-017, wave 9 — whose round-4 addition tells it to assert
      three roles and says nothing about the guard.
    required_change: >-
      Whoever owns the new `CREATE ROLE` line also adds its password variable to the
      contaminant loop at `scripts/check-compose-stack.sh:180`, and that script enters that
      card's `paths`. Name the escape explicitly on TASK-018's card: `$$`, not `$`, per
      ADR-0031 and F-315/F-316.

  - id: F-038
    severity: nit
    kind: documentation
    claim_type: a summary line that stopped describing the artifact under it
    file: .sdlc/identity-membership/plan.md
    line: 3
    summary: >-
      `plan.md`'s HEADER STILL SAYS "SEVENTEEN TASKS" AND ITS CRITICAL-PATH PARAGRAPH STILL
      SAYS "NINE WAVES" AND "FOURTEEN OF SEVENTEEN". The amended wave section forty lines
      below says eighteen and adds wave 0.
    failure_scenario: >-
      `:3` "One EPIC, six STORIEs, seventeen TASKs, thirty-six acceptance criteria"; `:5-6`
      "Verified 2026-08-12: 24 cards parse, 36 ACs each claimed by exactly one TASK"; `:269`
      "The critical path is nine waves... Fourteen of seventeen TASKs are backend". `:136-140`
      says "TASK count is now **18**" and the table has ten rows, 0 through 9. There are now 25
      cards and TASK-018 claims no AC, so the `:5-6` verification sentence describes a state
      that no longer exists. Nobody is attacked by this. It is filed because the gate summary
      is read from the header, and this is the bookkeeping-lags-prose failure the workflow's
      own findings log names as its weakest part.
    required_change: >-
      Update `:3`, `:5-6` and `:269` to eighteen TASKs, 25 cards, ten waves, and re-date the
      verification sentence to whatever was actually re-run.
```

## Notes

**What I built and attacked.** A throwaway Postgres 17 (`audit-r4-pg`, `--rm`, port 55434),
scratch database `audit_r4` owned by `shortkit_migrator`, with `docker-compose.yml:334-337`'s
`ALTER DEFAULT PRIVILEGES` reproduced, three `NOBYPASSRLS` roles, `tenants` built from
`0000_odd_betty_ross.sql:1-34` verbatim, then migration `0001` applied exactly as ADR-0049 and
ADR-0050 now specify it — four DROP/CREATE pairs on `tenants`, the round-4
`tenantScopedPolicies()` and `membershipLookupPolicy()` forms on `tenant_memberships`, the
wrapped `redirectReadPolicy()` on a `links` stand-in, and the five auth tables with the
`REVOKE`/`GRANT`. Everything attacking was issued over TCP as `shortkit_app` or
`shortkit_auth`. Database dropped, container stopped and removed. `shortkit-postgres-1` was
never started.

**F-029, the measurement.** The counting control, implemented from ADR-0049's own words —
count `current_setting(`, count `NULLIF(current_setting('<flag>'::text, true), ''::text)` with
`<flag>` matching `[a-z_][a-z0-9_.]*`, require equality over `qual` + `with_check` — run over
every row of `pg_policies` in schema `public` after `0001`:

| policy | refs | wraps | control |
|---|---|---|---|
| `tenants_self_select` / `_update` / `_insert` | 1 / 2 / 1 | 1 / 2 / 1 | ACCEPT |
| `tenants_privileged_erase` | 1 | 1 | ACCEPT |
| `tenant_memberships_tenant_isolation` | 2 | 2 | ACCEPT |
| `tenant_memberships_privileged_erase` | 1 | 1 | ACCEPT |
| `tenant_memberships_membership_lookup` | 1 | 1 | ACCEPT |
| `links_redirect_read` (wrapped form) | 1 | 1 | ACCEPT |

Seven of seven, zero failures — **the whole-schema property ADR-0049 states is the one the
DDL it specifies actually satisfies**, which is what round 3 said it did not. The shipped raw
form `((id)::text = current_setting('app.privileged_erase'::text, true))` still REJECTs, so
the control has not been loosened to reach the green: it is the DDL that moved.

**F-031, the measurement.** Attack state reconstructed from round 3: `REVOKE ALL` on the five,
then `GRANT INSERT ON "session" TO shortkit_app`.
`has_table_privilege(current_user,'session','SELECT')` as `shortkit_app` → `f`, so the r3 form
passes. The r4 form over the whole exempt list returns `account t, jwks t, user t,
verification t, session f` — **it fires on the one table the hand-written revoke got wrong.**
The auth direction over `tenants`, `tenant_memberships` and `links` returns `t, t, t`, with
`rolbypassrls f`, `rolsuper f` and `current_setting('is_superuser') = off`. All three of
ADR-0050's round-4 measurements reproduced independently: the comma list is ANY-of;
`GRANT SELECT (email) ON "user"` leaves `has_table_privilege` `false` while
`has_any_column_privilege` returns `true` and `SELECT email` returns the row; and
`has_any_column_privilege(..., 'SELECT,INSERT,UPDATE,DELETE')` raises `unrecognized privilege
type: "DELETE"`. `has_table_privilege` on an absent relation raises `42P01`, as stated.

**Invariant 11 holds. Computed, not read.** The eighteen cards' `paths` were parsed and
intersected pairwise within each of the ten waves: **zero same-wave collisions.** Twelve files
are claimed by more than one TASK and every pair is wave-separated. `plan.md`'s multi-claimant
list is now accurate for the four entries round 4 added, with one harmless imprecision —
`test/support/auth-fixture.ts (018)` is listed under "files touched by more than one TASK" and
has exactly one claimant. Two pre-existing pairs are still missing from that list
(`test/isolation/cross-tenant-isolation.int-spec.ts` and `controls.ts`, both 002 and 015); both
are wave-separated, both predate this round, neither is a finding here.

**Wave 0 does precede every consumer of `shortkit_auth`.** TASK-018 `depends_on: []`, TASK-002
`depends_on: [TASK-018]`, and every other card naming the role is wave 3 or later. The role
itself is provisioned before anything grants to it or connects as it. **What wave 0 does not
precede is the DSN and the secret**, which is F-034 and is the one ordering defect I found.

**Two things about TASK-018 I checked and did not file.** Its three creation sites are real:
`docker-compose.yml:308-321` and `docker-compose.test.yml` each carry an inline `CREATE ROLE`
block, and `.github/scripts/provision-test-database.sql:57,:66` do hardcode
`rolname IN ('shortkit_app','shortkit_migrator')` and `count(*) <> 2` — the card is right that
both guards go blind on the new role otherwise, and right that the escalation under-counted
the sites. And the card's decision to grant `USAGE ON SCHEMA public` at only one of the three
sites is harmless, not a bug: measured, `pg_namespace.nspacl` on a stock database carries
`=U/pg_database_owner`, so `PUBLIC` already holds `USAGE` and `shortkit_auth` reads `"user"`
without an explicit grant. The explicit grant is redundant at all three sites, including the
one that has it.

**On TASK-018 claiming no AC — the question asked.** **It is not load-bearing, and flagging it
was still right.** The substantive risk in that card — an auth role created with `BYPASSRLS`,
or not created at all — is caught by two owned controls: the widened
`provision-test-database.sql` guard, and `assertAuthRoleSeparation`'s role-attribute half in
TASK-004, wave 3. And a TASK-018 that simply does not run fails loudly one wave later, with
`role "shortkit_auth" does not exist` inside a forward-only migration. So nothing silently
degrades. What the empty `acceptance` costs is ledger reach, not coverage: TASK-018 appears in
no row of `plan.md`'s coverage table, so it is invisible to any check that reasons AC-first,
and that is the exact class of bookkeeping defect this workflow's own findings log says to
expect before anywhere else. Two smaller things worth ruling on with it: **the card's cited
precedent is factually wrong** — it says "a marked config chore in TASK-010's shape", and
TASK-010 carries `acceptance: [AC-36]`; TASK-018 is the only one of eighteen with an empty
list. And `plan.md:5-6` still asserts "36 ACs each claimed by exactly one TASK" as a verified
property, which is now a statement about seventeen of eighteen cards. My recommendation: keep
the empty list, correct the precedent sentence, and let F-038 carry the header repair.

**Where the cards diverge from the ADRs, and where they do not.** I diffed every round-4
obligation section against the ADR that decided it. TASK-002's migration-`0001` content (four
pairs, three wrapped predicates in `tenantScopedPolicies()`, `redirectReadPolicy()` not in the
migration), TASK-003's secret and logger obligations, TASK-004's five-point specification of
`assertAuthRoleSeparation` including the `42P01` and column-grant traps, TASK-009's DSN role
warning and TASK-017's three-role widening all match their ADRs. Two do not, and both are in
this report: F-035 (half the grant matrix) and F-036 (both `.env.example` files). One more is
too small to file — TASK-003 says `auth.config.spec.ts` asserts "the logger key is present",
where ADR-0052 asks for `level === 'error'` and `log` being a function; the card names the ADR
two lines above, so an implementer reaches the stronger form.

**Three things I decided not to file.**

- *`shortkit_auth` deleting a `"user"` row writes `tenant_memberships` by cascade with row
  security bypassed.* Re-measured and still true. ADR-0050 names it, `rls-policy-template.md`
  invariant 5 and the new invariant 7 both carry it, and it is the accepted cost of the split
  rather than an unnoticed residual.
- *A developer's existing Postgres volume never runs the compose init script again, so
  `shortkit_auth` will not exist when wave 1's migration grants to it.* True, and its symptom
  is the loud one — `role "shortkit_auth" does not exist` from the `migrate` service, with the
  repair (`docker compose down -v`) already the documented reflex for this stack. CI is
  unaffected: `check-compose-stack.sh:293` does `down -v --rmi local` before it measures.
  Informational; it belongs in TASK-018's card as a sentence, not in a findings ledger.
- *`DATABASE_AUTH_URL` is a fourth credential in a repo that deploys from a working copy.*
  Same reasoning as round 3. No deploy target (ADR-0030), and no mechanism here that
  `DATABASE_MIGRATION_URL` does not already have.

**On the verdict.** `changes-requested`, and it is a thinner list than round 3's by design.
Five of six re-reviewed findings are addressed and **the two I re-executed are addressed
causally, not coincidentally** — the counting control passes because the DDL changed, and the
boot assertion fires because the privilege set widened. Of what remains, **F-034 is the one
that will bite**: it makes a required check red for two consecutive waves, and both of its
cheap repairs undo a decision this round was spent making. F-032's residual is the one that
bites *quietly* — a control in no card is not written, and F-025's closure depends on it.
F-035, F-036 and F-037 are corrections of a sentence each. F-038 is bookkeeping. Nothing here
reopens F-020 … F-031 or F-033, and nothing here is an exploitable path in shipped code.

## Dependencies reviewed

Round 4 adds no dependency, bumps nothing and touches no lockfile. It re-states two behaviours
of the already-pinned `better-auth@1.6.26` (ADR-0018, F-016) that I executed against
`apps/api/node_modules` in round 3 and did not re-execute here, because the round-4 edits are
to the prose describing them rather than to the mechanism: the `create-context.mjs:66-80`
fallback to the published constant `better-auth-secret-12345678901234567890`, and the
`@better-auth/core` `console` logger fully displaced by an `options.log` function. ADR-0051's
seven-row table is reproduced correctly in the ADR against my round-3 measurements. ADR-0050
still adds no package — a database role, a DSN and a second `pg.Pool` on the already-present
`pg` driver.
