# Design-mode security re-review — identity-membership, wave 1, round 3

- **Mode:** design, **scoped re-review**. Not a fresh audit. The scope is the round-3
  revisions to ADR-0044, ADR-0045, ADR-0049, `tenant-membership-lookup.md`,
  `rls-policy-template.md`, `tenant-context.md` and the two stubs, plus the three new ADRs
  0050, 0051 and 0052. ADRs 0043, 0046, 0047, 0048 and `auth-schema.md` /
  `auth-contracts.md` were cleared in round 2 and were re-opened only where a round-3
  revision reaches into them — which ADR-0050 does to ADR-0046 (F-028).
- **Method:** every claim the architect recorded as `resolved_by` was treated as unverified.
  F-020, F-021, F-022 and F-024 were re-executed rather than re-read. F-023 was re-executed
  against the pinned dependency. A scratch Postgres 17 was created in a throwaway container
  (`audit-r3-pg`, port 55433, `--rm`), the scratch database `audit_r3` was created and
  dropped, and the container was removed. The project's own `shortkit-postgres-1` container
  was never started; the `shortkit` and `shortkit_test` databases were not touched.
- **Prior report:** `audits/design-sdlc-security-auditor-r1.md` (the dispatch calls it
  round 2; the file is named r1). Findings F-020 … F-027.
- **Finding id range used this round:** F-028 … F-033.

## Per-finding verdicts

| id | severity (r2) | verdict | how established |
|---|---|---|---|
| F-020 | blocker | **ADDRESSED** | executed: default-secret fallback reproduced in dev and test; ADR-0051's explicit-`secret` mechanism executed and confirmed to win over env and over the default |
| F-021 | major | **ADDRESSED** | executed both ways: ghost `user.id = ''` row present, raw form leaks tenant B's row into tenant A's transaction, `nullif` form returns zero rows and keeps the index |
| F-022 | major | **ADDRESSED** | executed: the new present-form counting control run against thirteen real `pg_policies.qual` renderings; it rejects all four raising forms including the two the blacklist missed |
| F-023 | major | **ADDRESSED** | executed against `better-auth@1.6.26`: the `log` hook is taken, zero `console` fallbacks, `level: 'error'` suppresses the email line at source |
| F-024 | major | **ADDRESSED** | executed both ways: takeover reproduced pre-split (`UPDATE 1`, `INSERT 0 1`, `UPDATE 1`), and `permission denied` on all four tables post-split from the identical transaction |
| F-025 | major | **ADDRESSED** | verified: `CONTEXT_FLAG_OWNERS` still has zero consumers, `toHaveLength(2)` is the only live mechanism — the ADR's correction is factually right |
| F-026 | minor | **ADDRESSED** | read; the note is accurate and the ADR-0050 forward reference is correct (post-split, `shortkit_app` gets `permission denied` on all five — measured) |
| F-027 | minor | **ADDRESSED** | verified against `logger.ts:159` (`includeMessage: false`) in all four artifacts |

Eight of eight addressed. The verdict below is `changes-requested` on the **new** findings
only — six defects the revision itself introduced, none of which reopens F-020 … F-027.

```yaml
verdict: changes-requested
findings:
  - id: F-028
    severity: major
    kind: contract
    claim_type: contradiction between an accepted ADR and its unmarked partial reversal
    file: .sdlc/identity-membership/design/adr-0050-better-auth-tables-get-their-own-database-role.md
    line: 94
    summary: >-
      ADR-0050 DECIDES THE SECOND POOL THAT ADR-0046 EXPLICITLY REJECTED, AND ADR-0046 IS
      NEITHER AMENDED NOR ANNOTATED. ADR-0050's front matter reads
      `supersedes_in_part: ADR-0044` and `amends: ADR-0031, ADR-0002`. ADR-0046 is named
      once, in a table cell, as the thing the auth pool is "reached through". This is the
      third instance in three rounds of this initiative contradicting itself inside one
      commit — F-021 and F-022 were the first two.
    failure_scenario: >-
      ADR-0046 is `status: accepted` and still says, in its Decision: "It is built from the
      SAME `pg.Pool` as `databaseTransaction`'s client, through the same lazy `client()`
      path, so both connection-error listeners (F-123, F-137), `POOL_MAX`,
      `CONNECTION_TIMEOUT_MS` and `allowExitOnIdle` apply unchanged" (:57-60), and in its
      Positive consequences: "One pool, one set of error listeners, one `closeDatabase`, one
      capacity number" (:114). Its Alternatives table rejects a second pool on the grounds
      that it "Doubles the effective connection ceiling without doubling the database's, so
      `POOL_MAX`'s capacity reasoning stops describing the process" (:105) — which is
      verbatim the cost ADR-0050 now accepts ("Fifteen connections per instance rather than
      ten", :183-184). Four sentences in an accepted ADR are now false and nothing in the
      file says so.
      The reachable path is the implementer's. TASK-002's `Follow-ups` inherit from ADR-0046
      ("TASK-002 writes `betterAuthDatabase()`", :144), `auth-schema.md:133` points at
      ADR-0046 for the client, `design/stubs/README.md:35` points at ADR-0046, and TASK-002's
      card says nothing about a second pool or a second DSN (F-032). An implementer who reads
      ADR-0046 builds one pool on `DATABASE_URL`, which connects as `shortkit_app` — the role
      migration `0001` revokes on all five auth tables. Better Auth then cannot read `user`
      to sign anyone in. **The two ways out of that failure are to add the second pool, or to
      drop the `REVOKE` so sign-in works again.** The second is the cheaper-looking one, it
      is a one-line edit to a migration nobody has a reason to re-read, and it silently
      restores exactly the account-takeover path F-024 measured and Juano reversed a decision
      to close. The CI grant-matrix check would catch it — in the `integration` job, which
      ADR-0050 itself notes is not the `quality` job.
    required_change: >-
      ADR-0050's front matter names ADR-0046 in `supersedes_in_part`, and ADR-0046 gains a
      `superseded_in_part_by: ADR-0050` key and a correction block over the four false
      sentences — same treatment ADR-0044 correctly received in this round. State in ADR-0050
      that `betterAuthDatabase()` is now built on the auth pool and that ADR-0046's rejection
      of a second pool was made against the single-role model.

  - id: F-029
    severity: major
    kind: contract
    claim_type: a control specified in a form that cannot pass on the database the same ADR specifies
    file: .sdlc/identity-membership/design/adr-0049-context-flags-are-never-cast-directly.md
    line: 139
    summary: >-
      ADR-0049'S WIDENED DECISION SAYS ALL FOUR FLAGS TAKE THE WRAPPER; ITS OWN MIGRATION AND
      `rls.ts` SECTIONS, FIFTY LINES LOWER AND NOT UPDATED, STILL SAY `tenants_privileged_erase`
      "IS UNTOUCHED" AND "`redirectReadPolicy` IS UNTOUCHED". The new counting control rejects
      both untouched forms, so the ADR specifies DDL that its own control fails.
    failure_scenario: >-
      Decision, :86-107: "No policy expression in this repository references
      `current_setting(...)` raw... **All four flags take the wrapper**", listing
      `app.privileged_erase` and `app.redirect_context` in the `nullif` form, with the reason:
      "a rule with two exceptions cannot be checked mechanically and the exceptions are where
      the next instance will land". `rls-policy-template.md` was edited in this round to match
      (:99, :187, :193-196).
      Implementation sections, unedited: :109-116 shows `tenantScopedPolicies()` becoming only
      the isolation policy and omits `<t>_privileged_erase` entirely; :139-142 "`tenants_privileged_erase`
      is untouched"; :144-147 "**`redirectReadPolicy` is untouched.**"; the migration `0001`
      snippet at :132-137 drops and recreates only the three casting policies.
      Measured, against real `pg_policies.qual` renderings on the scratch database, using the
      control exactly as ADR-0049 now specifies it (count `current_setting(` occurrences,
      count `NULLIF(current_setting('<flag>'::text, true), ''::text)` occurrences, require
      equality):
        | rendered qual                                                          | control |
        | `((id)::text = current_setting('app.privileged_erase'::text, true))`   | REJECT  |
        | `(current_setting('app.redirect_context'::text, true) = 'on'::text)`   | REJECT  |
      `apps/api/drizzle/0000_odd_betty_ross.sql:33-34` creates `tenants_privileged_erase` in
      exactly the first form and is already applied; ADR-0004 is forward-only, so only a
      migration `0001` statement can change it, and ADR-0049 says not to write one.
      `apps/api/src/db/rls.ts:76` emits the same raw form for **every** tenant-scoped table,
      so `tenant_memberships` — created by TASK-002 in wave 1 — is a second instance created
      on the day the control lands.
      Consequence: `pnpm db:check-policies` goes red in wave 1 on a database built exactly as
      ADR-0049 instructs. The pressure at that point is on the control, not on the DDL, and
      loosening a control to make a build green is the failure mode ADR-0049 exists to record
      (F-022, and F-390 in foundation's retro).
    required_change: >-
      Delete or strike the two "is untouched" paragraphs and the `tenantScopedPolicies()`
      snippet's omission of `<t>_privileged_erase`, and extend migration `0001`'s statement
      list to drop and recreate `tenants_privileged_erase` alongside the three casting
      policies. Confirm in the ADR that no policy in schema `public` survives `0001` in a form
      the counting control rejects; that is the property, and it is checkable.

  - id: F-030
    severity: minor
    kind: documentation
    claim_type: a factual error about an existing control's reach
    file: .sdlc/identity-membership/design/adr-0050-better-auth-tables-get-their-own-database-role.md
    line: 50
    summary: >-
      "`assertRuntimeRoleCannotBypassRls` IS UNCHANGED AND NOW RUNS FOR BOTH RUNTIME ROLES" IS
      FALSE. The function takes no argument and reaches the database only through
      `databaseTransaction`, which is the application pool. It cannot run for `shortkit_auth`
      without a signature change, and no artifact asks for one.
    failure_scenario: >-
      `apps/api/src/db/rls.ts:137-138`: `export async function
      assertRuntimeRoleCannotBypassRls(): Promise<void> { const privileges = await
      databaseTransaction(...)`. Every verdict it raises begins "DATABASE_URL connects as
      ...", and `main.ts:47` pattern-matches on `RLS_VERDICT_PREFIX = 'DATABASE_URL connect'`
      to distinguish an unsafe answer from a failure to answer. A second call parameterised
      on `DATABASE_AUTH_URL` would either reuse that wording, making the log line wrong about
      which DSN failed, or use different wording, which `main.ts` treats as unreachable and
      retries for the full twenty-second budget before refusing with a less precise message.
      The exposure this leaves is genuinely small, and I am filing it as minor for that
      reason: `BYPASSRLS` on `shortkit_auth` buys nothing without table privileges on the
      tenant-scoped tables, and `assertAuthRoleSeparation`'s second direction does catch
      `DATABASE_AUTH_URL` pointed at `shortkit_app` or `shortkit_migrator`, since both can
      `SELECT tenant_memberships`. What is wrong is the claim. This is F-025's shape — an ADR
      resting a decision on a control that does not execute — filed by the same auditor one
      round earlier, in an ADR written to answer it.
    required_change: >-
      Say what is true: `assertRuntimeRoleCannotBypassRls` covers `DATABASE_URL` only, and
      either give it a DSN parameter with the verdict wording generalised and `main.ts`'s
      prefix updated, or state that the auth role's `BYPASSRLS` posture is asserted nowhere
      and why that is acceptable.

  - id: F-031
    severity: major
    kind: security
    claim_type: concrete runtime failure of a proposed control
    file: .sdlc/identity-membership/design/adr-0050-better-auth-tables-get-their-own-database-role.md
    line: 128
    summary: >-
      `assertAuthRoleSeparation` — THE ONE CONTROL THAT RUNS IN A DEPLOYED PROCESS — CHECKS
      `SELECT` ON ONE TABLE PER DIRECTION. THE ATTACK ADR-0050 EXISTS TO CLOSE IS AN `INSERT`,
      AND `account` AND `jwks` ARE NOT CHECKED AT ALL.
    failure_scenario: >-
      As specified: `as shortkit_app: has_table_privilege(current_user, 'session', 'SELECT')
      must be FALSE`. Constructed and measured on the scratch database — `REVOKE ALL` on the
      five, then `GRANT INSERT ON "session" TO shortkit_app`, i.e. a hand-written revoke that
      reasoned about the read half, which is precisely the error ADR-0044 made and F-024
      corrected:
        - `has_table_privilege('shortkit_app','session','SELECT')` -> `false`, so direction 1
          **passes**.
        - `has_table_privilege('shortkit_auth','tenant_memberships','SELECT')` -> `false`, so
          direction 2 **passes**.
        - and from an ordinary `withTenantTransaction` for tenant A, as `shortkit_app`:
          `INSERT INTO "session" (id,expires_at,token,user_id) VALUES ('forged2', now()+'30
          days','ATTACKER-CHOSEN-2','user-b')` -> `INSERT 0 1`. A working session credential
          of the attacker's choosing for another tenant's user, with the boot assertion green.
      The same shape covers a `REVOKE` that omits `account` (password hashes) or `jwks` (the
      JWT signing key): the boot assertion never looks at either table. The CI grant-matrix
      check does catch this state — measured, `has_table_privilege('shortkit_app','session',
      'SELECT,INSERT,UPDATE,DELETE')` returns `true` and an `EXEMPT` table requires `false`.
      But that check runs in the `integration` job on a CI database, and the boot assertion is
      what runs in the process that serves traffic. ADR-0050 introduces it as the analogue of
      `assertRuntimeRoleCannotBypassRls`, "proves a negative about privilege"; the negative it
      proves is not the one that was breached.
    required_change: >-
      Assert the whole privilege set over the whole exempt list, in both directions:
      `NOT has_table_privilege(current_user, t, 'SELECT,INSERT,UPDATE,DELETE')` for each of
      the five as `shortkit_app`, and the same against the tenant-scoped tables as
      `shortkit_auth`. The comma list is ANY-of (measured), so the negated form is exactly the
      "holds none of the four" assertion wanted, and it is the same one line.

  - id: F-032
    severity: major
    kind: process
    claim_type: design output with no delivery vehicle
    file: .sdlc/identity-membership/tasks/TASK-002.md
    line: 9
    summary: >-
      NOT ONE OF THE SEVENTEEN TASK CARDS MENTIONS `BETTER_AUTH_SECRET`, `shortkit_auth`,
      `DATABASE_AUTH_URL`, `assertAuthRoleSeparation`, `CONTEXT_FLAG_OWNERS`, ADR-0050,
      ADR-0051 or ADR-0052. A grep across `tasks/` for all eight strings returns zero files.
      Everything this round decided exists only in ADRs.
    failure_scenario: >-
      The dispatch for this re-review listed `TASK-002.md` and `TASK-011.md` as revised this
      round. `git diff HEAD -- .sdlc/identity-membership/tasks/` is empty: neither file was
      touched. What that leaves, item by item:
        - ADR-0050 assigns the migration `REVOKE`/`GRANT`, the grant-matrix assertion in
          `check-policies.mts` and the second pool in `client.ts` to **TASK-002, wave 1**.
          TASK-002's `paths` reach all three files, so this is recoverable — but the card's
          Approach section still describes "one migration, three obligations" and names none
          of them, and its `Produces` list has no `REVOKE`, no second pool and no
          `DATABASE_AUTH_URL`.
        - ADR-0050 assigns `docker-compose.test.yml` to TASK-009. **TASK-009's `paths` are
          `["docker-compose.yml", "apps/api/.env.example", "apps/web/.env.example",
          "README.md"]` — `docker-compose.test.yml` is in no card's paths at all.**
        - ADR-0051 assigns `assertBetterAuthSecretConfigured()` to TASK-004 and the explicit
          `secret` plus its spec assertion to TASK-003. Neither card mentions a secret.
        - ADR-0052 assigns the `logger` key and its spec assertion to TASK-003. TASK-003 does
          not mention a logger.
        - ADR-0045's **one executing control for wave 1** — the grep of `set_config(` first
          arguments asserted equal to `CONTEXT_FLAG_OWNERS`, which is the entire answer to
          F-025 — has no file name, no owning card and no `test_files` entry anywhere.
        - ADR-0049's behavioural control (warm no-context `SELECT` returns zero rows on every
          table) likewise names no file and no card.
      ADR-0050 reports three artifacts with no owning TASK and correctly says "Reported, not
      made". It does not report that the artifacts which **do** have owners were not written
      into those owners' cards either. The Implement phase runs from the card. A blocker fix
      (F-020) and a reversed gate decision (F-024) currently have no delivery vehicle.
    required_change: >-
      Each of TASK-002, TASK-003, TASK-004 and TASK-009 states its new obligations in its
      Approach and `Produces`, with the ADR id; TASK-009's `paths` gain
      `docker-compose.test.yml`; the two new controls get a file name and a `test_files`
      entry. The three genuinely unowned artifacts
      (`.github/scripts/provision-test-database.sql`, `apps/api/test/support/rls-fixture.ts`,
      `apps/api/scripts/seed.mts`) remain the Plan-gate matter ADR-0050 already escalated —
      and note ADR-0050's own point that the CI provisioning has to land in or before wave 1,
      not wave 4, or TASK-002 cannot go green.

  - id: F-033
    severity: minor
    kind: security
    claim_type: concrete runtime behaviour of an unspecified accessor
    file: .sdlc/identity-membership/design/adr-0051-better-auth-secret-is-a-declared-binding.md
    line: 96
    summary: >-
      ADR-0051 SAYS `betterAuthSecret()` "READS THE DECLARED BINDING" AND NEVER SAYS WHAT IT
      RETURNS WHEN THE BINDING IS ABSENT. A falsy return silently restores the published
      default, because `options.secret` participates in the library's `||` chain rather than
      overriding it.
    failure_scenario: >-
      Executed against the pinned `better-auth@1.6.26`, one process per row, `BETTER_AUTH_SECRET`
      and `AUTH_SECRET` unset:
        | `betterAuth({...})` argument                     | NODE_ENV    | resulting `ctx.secret` |
        | (no `secret` key)                                | development | the published default  |
        | (no `secret` key)                                | test        | the published default  |
        | (no `secret` key)                                | production  | THREW BetterAuthError  |
        | `secret: ''`                                     | development | the published default  |
        | `secret: undefined`                              | development | the published default  |
        | `secret: 'AUDIT-EXPLICIT-...'`                   | development | ours                   |
        | `secret: 'AUDIT-EXPLICIT-...'` + env set to junk | development | ours                   |
      So ADR-0051's mechanism works — and it works only for a non-empty return.
      `create-context.mjs:70` is `options.secret || env.BETTER_AUTH_SECRET || env.AUTH_SECRET
      || ""` followed by `|| DEFAULT_SECRET`, so `''` and `undefined` fall straight through.
      Two things make the window real rather than theoretical. TASK-003 (wave 2) composes the
      config; TASK-004 (wave 3) owns the boot assertion that is the only thing making the
      accessor's return value safe — so wave 2 is a wave in which `pnpm dev` boots on the
      published constant with no assertion anywhere, which is F-020's original state.
      And ADR-0051's own follow-up records that the integration tier has no owner for the
      value and that `isTest()` means the library will not complain, so the test tier is the
      environment most likely to hit the falsy path.
      The production row confirms ADR-0051's stated mitigation: `Dockerfile:83` pins
      `NODE_ENV=production`, so the compose stack does refuse to boot. That claim holds.
    required_change: >-
      State that `betterAuthSecret()` **throws** when the binding is unset or empty rather
      than returning a falsy value, and say why: `options.secret` is the first operand of a
      `||` chain, not an override. Either move the assertion into wave 2 with TASK-003, or
      record in ADR-0051 that wave 2 ships an auth surface whose secret is unasserted and that
      wave 3 is where it closes.
```

## Notes

**What I built and attacked.** A throwaway Postgres 17 container (`audit-r3-pg`, `--rm`, port
55433), holding a scratch database `audit_r3` owned by `shortkit_migrator`, with
`docker-compose.yml:334-337`'s `ALTER DEFAULT PRIVILEGES` grant to `shortkit_app` reproduced,
`tenants` and `tenant_memberships` under the round-3 `nullif` policy set, and the five Better
Auth tables with no RLS. Roles `shortkit_app`, `shortkit_auth` and `shortkit_migrator` were
created `NOBYPASSRLS`. Everything attacking was issued over TCP as `shortkit_app` or
`shortkit_auth`, never as the superuser. The database was dropped and the container removed.
The project's `shortkit-postgres-1` container was never started.

**F-024's split, measured end to end.** Pre-split, from tenant A's ordinary transaction with
`app.tenant_id` set correctly and `SELECT count(*) FROM tenants WHERE id = <tenant B>`
returning `0` in the same transaction: `UPDATE "account" ... WHERE user_id='user-b'` →
`UPDATE 1`; `INSERT INTO "session" (...)` with a chosen token → `INSERT 0 1`; `UPDATE "user"
SET email=...` → `UPDATE 1`; `SELECT private_key FROM jwks` → the row. After ADR-0050's
`REVOKE ALL PRIVILEGES ON "user","session","account","verification","jwks" FROM shortkit_app`
and the `GRANT` to `shortkit_auth`, the identical four statements return `permission denied
for table account`, `... session`, `... user`, `... jwks`. **The designed split closes the
write path that reversed the gate decision.**

**ADR-0050's three cross-role integrity claims all hold, re-measured independently.**
`shortkit_app` inserts a `tenant_memberships` row with an FK to a `"user"` row it cannot
`SELECT` (`INSERT 0 1`); a bogus FK is still rejected (`violates foreign key constraint
"tenant_memberships_user_id_fkey"`); and `DELETE FROM "user"` as `shortkit_auth`, which cannot
read `tenant_memberships`, removes the membership row by cascade (`DELETE 1`, row count `0`
afterwards). The residual ADR-0050 names is therefore real: **a second role can now write a
tenant-scoped table with row security bypassed**, and it named it rather than discovering it.

**The F-022 control is materially better and still a proxy — and the ADR says so.** Run against
thirteen real `pg_policies.qual` renderings, the present-form counting predicate rejects
`current_setting(...)::uuid`, `CAST(... AS uuid)`, `nullif(..., 'x')::uuid` and
`(... || '')::uuid` — the last two are the ones the blacklist missed — and accepts the repaired
form, the wrapped text comparisons, and three benign outer wrappers (`COALESCE(NULLIF(...,''),
<uuid literal>)`, nested `NULLIF`, `ltrim(NULLIF(...,''))`). I found one accepted-but-raising
form: `COALESCE(NULLIF(current_setting(...),''), '')::uuid`, counts equal, `ACCEPT`, and it
raises `22P02`. It is worth knowing and it is not worth a finding, because unlike
`nullif(..., 'x')` it raises on a **cold** connection too, so every existing fixture catches it
on the first run. Any form that evades the new control has to reintroduce `''` after the
`NULLIF`, and doing that is visible cold. The behavioural control ADR-0049 now specifies beside
it covers the rest.

**ADR-0052's binding executes exactly as designed.** With `logger: { level: 'error',
disableColors: true, log: (level, message) => ... }` on the composed config, four calls
(`error` with a positional `Error`, `warn`, `info` carrying an email, `debug`) produced one
hook invocation — `["error","ERROR-LINE"]` — and **zero** `console.error`/`warn`/`log` calls.
`level: 'error'` suppresses `sign-up.mjs:168`'s email line at the source, as claimed, and the
positional `Error` does not cross. `code` is on `LOGGABLE_FIELDS` (`logger.ts:55`), so
`{ code: 'better_auth' }` survives `fieldsCensored`. The `origin-check.mjs:110` residual is
untouched and remains live — `logger.error` is at the level that passes — which is what the ADR
says, in the section where it says it.

**F-021's repair is causal, not coincidental.** With the ghost `"user"` row (`id = ''`) and a
`tenant_memberships` row referencing it in tenant B, on a warm backend as `shortkit_app`: under
the raw form, a no-context read returns tenant B's row and **tenant A's ordinary transaction
returns two rows, its own and tenant B's**; under the `nullif` form on the same session with the
same data, the no-context read returns `0` and tenant A sees only its own row, the warm mint
resolves, and `EXPLAIN` still shows `Index Scan using tenant_memberships_user_unique`.

**Two claims in ADR-0050 that I checked and that are stronger than they read.**
`has_table_privilege` with a comma-separated privilege list is ANY-of, not ALL-of (measured: a
table with only `INSERT` granted returns `true` for `'SELECT,INSERT,UPDATE,DELETE'`). The
grant-matrix assertion's "if and only if" therefore reads stricter than it is — but the two
directions that carry the security property are the negative ones (`app_dml` false on an exempt
table, `auth_dml` false on a tenant table), and ANY-of makes `false` mean "holds none of the
four", which is exactly right. The two loose directions are availability, not security. No
finding. The same semantics is what makes F-031's one-line fix work.

**Three things I decided not to file.**

- *`DATABASE_AUTH_URL` is a second credential in a repo that deploys from a working copy.*
  ADR-0050 states it (`:186-188`). There is no deploy target (ADR-0030) and no new mechanism
  here that the existing `DATABASE_MIGRATION_URL` does not already have.
- *FK existence probing across the new privilege boundary.* `shortkit_app` cannot `SELECT` from
  `"user"` but can distinguish "row exists" from "row does not" by the FK violation on a
  `tenant_memberships` insert. It is inherent to the foreign key, `UNIQUE (user_id)` bounds it,
  and it needs the SQL-defect premise anyway. Informational.
- *`tenant_memberships_privileged_erase` and the eraser's role.* ADR-0050 says
  `privilegedTenantEraser` is "forced to declare which role it deletes `user` rows as" and
  leaves it to TASK-054, which is deferred. That is the right place for it; there is no code and
  no card, so there is nothing to attack yet.

**What I could not do, and one false premise in my own dispatch.** The dispatch listed
`.sdlc/identity-membership/tasks/TASK-002.md` and `TASK-011.md` among the artifacts "revised
this round". They were **not** revised — `git diff HEAD -- .sdlc/identity-membership/tasks/`
is empty and neither file has been touched since commit `3f14806`. I reviewed them as they
stand; the gap is F-032. Nothing else was blocked. The dispatch also names my prior report as
"round 2" while the file is `design-sdlc-security-auditor-r1.md`; this report is written to the
path the dispatch names, `design-sdlc-security-auditor-r2.md`, so the two files are r1 = round
2 and r2 = round 3.

**On the cap round.** All six new findings are load-bearing, and they are not equally so.
**F-029 and F-032 are the two that will bite in wave 1 if nothing changes** — F-029 makes
`pnpm db:check-policies` red on a database built exactly as ADR-0049 instructs, and F-032 means
no card tells anyone to write any of this. **F-028 and F-031 are the two whose bad resolution
silently reopens F-024** — dropping a `REVOKE` to make sign-in work, and a boot assertion that
stays green while a session can be forged. **F-030 and F-033 are cheap corrections**: one
sentence and one specified throw. None of the six reopens a round-2 finding, and none of them
would justify a fourth round on its own; F-029 and F-032 together would.

## Dependencies reviewed

This round adds no dependency and changes no lockfile. It configures the already-pinned
`better-auth@1.6.26` (ADR-0018, F-016) and `@better-auth/drizzle-adapter@1.6.26`. Two default
behaviours of that pin are the subject of ADR-0051 and ADR-0052 and both were re-executed
against `apps/api/node_modules` this round: the `create-context.mjs:66-80` secret fallback to
the published constant `better-auth-secret-12345678901234567890`, which throws under
`NODE_ENV=production` only (confirmed, per-process), and the `@better-auth/core/dist/env/logger.mjs:55-69`
`console` logger, which is fully displaced by an `options.log` function (confirmed, zero
`console` calls). Neither is a CVE; both are defaults this repository now overrides by design.
ADR-0050 adds no package — its cost is a database role, a DSN and a second `pg.Pool` on the
already-present `pg` driver.
