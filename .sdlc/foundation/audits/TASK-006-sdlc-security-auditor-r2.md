# TASK-006 — security audit r2 (`sdlc-security-auditor`)

Date 2026-08-10. HEAD at audit start `3920f4d`; the rework under audit is `13847ea`.
`reaudit: raised-only`. Read-only on the repository — the only file this audit wrote is
itself. Every mutation was made against the throwaway container and undone with
`down -v` + re-migrate, never by hand.

---

## Verdict table

| Finding | r1 severity | Verdict | Basis |
|---|---|---|---|
| **F-293** | blocker | **RESOLVED** | both r1 leaks re-run; leak 1 now dies in `beforeAll` naming the row, leak 2 fails 3 tests naming the table |
| **F-294** | major | **RESOLVED** | the widened-policy-masked-by-a-CHECK sequence re-run; both `insertOwnedBy` attempts now `unverified` at 23514, verdict `fail` |
| **F-295** | major | **RESOLVED** as filed | the unseeded-target case is a permanent control and reds on every run; one claim in the rework report about it is overstated (see §4) |
| **F-296** | major | **RESOLVED** as filed, **residual filed NEW** | the r1 `workspaces` table is now named in the run log and in `report.json`; rename its owner column and the whole mechanism goes blind again (SEC-006-R2-2) |
| **F-297** | minor | **survives, correctly attributed** | no `upload-artifact` and no `report.json` anywhere in `.github/workflows/ci.yml`; and it must not land alone — see SEC-006-R2-3 |
| **F-298** | minor | **survives, and it is not a false green** | can only make a green run look failed, never the reverse; zero consumers today; the false-green sibling is SEC-006-R2-3 |
| **F-299** | minor | **survives** | architect's; confirmed the contract still describes the pre-rework harness |

```yaml
verdict: changes-requested
safe_to_mark_done: no
four_findings_closed: yes            # F-293, F-294, F-295, F-296 all measured resolved
can_the_harness_still_be_green_while_isolation_is_broken: yes
new_classes_found: 2                 # one blocker, one major, both measured
```

**TASK-006 is not safe to mark `done`.** The four findings routed to this rework are
genuinely closed and I measured every one of them. But the question the TASK exists to
answer is still answered *yes*, and this time on the **migrated production table** rather
than on a table someone forgot to register: with `tenants_self_update` set to
`USING (true) WITH CHECK (true)` — every tenant may rewrite every other tenant's row —
the suite reports **15 passed (15)**, `report.json` reports `"verdict": "pass"`, both
`updateOwnedBy` attempts report `pass`, and `db:check-policies` reports `OK`. Measured
below with the statement that does the damage.

That is a fifth class, it is structural rather than incidental, and it is *baked into a
shipped assertion*: `cross-tenant-isolation.int-spec.ts:429` requires eight `pass`
outcomes over `isolation_masked_refusal_canary`, a table that carries
`FOR UPDATE USING (true) WITH CHECK (true)` and `FOR DELETE USING (true)`.

---

## Baseline, reproduced

Fresh container, `down -v` → `up -d --wait` → `db:migrate`, then the suite:

```
isolation coverage — PASS — 2026-08-10T20:53:49.189Z
 Test Files  1 passed (1)
      Tests  15 passed (15)
```

Full integration suite after the audit's last restore: **48 passed (48)**,
`db:check-policies` → `OK: 1 table(s) in schema public, all protected or exempt`.
Matches the orchestrator's baseline.

---

## 1. F-293 (blocker) — RESOLVED

### Leak 1 of 2: the asymmetric read on the migrated `tenants` table

Re-ran my exact r1 statement — the `OR` arm against a **uuid literal**, which is the form
that does not recurse. Policy count unchanged at 4, all four still present:

```sql
ALTER POLICY tenants_self_select ON tenants
  USING (id = current_setting('app.tenant_id', true)::uuid
         OR current_setting('app.tenant_id', true)::uuid
            = '22222222-2222-4222-8222-222222222222');
```

r1: `isolation coverage — PASS`, `Tests 5 passed (5)`, `report.json` `"verdict": "pass"`.

r2, verbatim:

```
 FAIL  |api-integration| test/isolation/cross-tenant-isolation.int-spec.ts
Error: the fixture leaks before any attempt has run:
  - tenant 22222222-2222-4222-8222-222222222222 could see a row it does not own before this attempt ran: tenants seen-by=22222222-2222-4222-8222-222222222222 id=11111111-1111-4111-8111-111111111111 owner=11111111-1111-4111-8111-111111111111
 ❯ createTenantFixtures test/isolation/coverage.ts:501:11

 Test Files  1 failed (1)
      Tests  15 skipped (15)
```

The census line I said in r1 was "computed and discarded" is now the failure message.
Fail-closed, before any attempt, and it names the row.

### Leak 2 of 2: the unregistered `workspaces` table with `USING (true)`

Same DDL as r1 — `tenant_id`, `ENABLE`, `FORCE`, `FOR ALL USING (true) WITH CHECK (true)`,
granted to `shortkit_app`, registered nowhere.

r1: `Tests 5 passed (5)`, `db:check-policies` OK, `grep workspaces report.json` → no match.

r2:

```
isolation coverage — FAIL — 2026-08-10T20:57:40.425Z
  TENANT-SCOPED IN THE DATABASE AND REGISTERED NOWHERE (F-296):
    - workspaces — add a registerTenantScopedSurfaces() call in registrations.ts
 Test Files  1 failed (1)
      Tests  3 failed | 12 passed (15)
report.json verdict: fail {"inDatabaseNotRegistered":["workspaces"],"registeredNotInDatabase":[]}
```

### Both directions, and the rework's claim about the two mechanisms

`report.attempts` is 20 (8 read, 12 write); `A->B` and `B->A` each cover the same ten
surface ids; every `A->B` actor is tenant A's id and every `B->A` actor is tenant B's.
Confirmed from the emitted run log and `report.json`.

**The claim in the rework report §2 is correct, and the shipped control proves it rather
than asserting it.** `isolation_direction_canary` scopes `SELECT`, `UPDATE` and `DELETE`
correctly for both tenants and carries the `OR … = <tenant B>` arm on `FOR INSERT` only.
Its expectation — which passed in my baseline — is that **exactly one of ten** attempts is
not a pass, `B->A insertOwnedBy`. That expectation is itself the measurement: the census
runs before all ten attempts and reported clean on all ten, so a directional INSERT leak
really is invisible to any census and really is reachable only by acting as the other
tenant. Mechanism (a) is load-bearing and mechanism (b) does not subsume it.

**And there is a shape neither mechanism catches.** The census reads through `SELECT`; the
attempt battery's writes are all qualified by the owner column, which PostgreSQL routes
through the `SELECT` policy. A policy correct for `SELECT` and broken for `UPDATE` or
`DELETE` is therefore invisible to both. Measured in §5, filed as SEC-006-R2-1.

---

## 2. F-294 — RESOLVED

Re-ran my r1 two-step against the migrated `tenants` table:

```sql
ALTER POLICY tenants_self_insert ON tenants WITH CHECK (true);   -- pg_policies: with_check = true
ALTER TABLE tenants ADD CONSTRAINT tenants_name_not_planted
  CHECK (name <> 'planted-by-another-tenant');
```

r1: `pass … refused: error [23514]`, `isolation coverage — PASS`, `Tests 5 passed (5)`,
green while any tenant could insert a `tenants` row carrying any id.

r2, verbatim from the run log:

```
isolation coverage — FAIL — 2026-08-10T20:59:19.615Z
  UNVERIFIED  A->B  repo:TenantsTableAccess.insertOwnedBy  (write on tenants, saw 0, affected 0) — refused: error [23514]: new row for relation "tenants" violates check constraint "tenants_name_not_planted"
      ? the database refused this attempt for a reason the harness cannot attribute to a policy: … Only a row-level security refusal is evidence that a policy denied the write (F-294).
  UNVERIFIED  B->A  repo:TenantsTableAccess.insertOwnedBy  … (same)

 Test Files  1 failed (1)
      Tests  3 failed | 12 passed (15)
verdict: fail  unverified: ["repo:TenantsTableAccess.insertOwnedBy"]
```

The SQLSTATE **and** the message survive into `report.json`, `unverified` fails the run,
and the message names what would have to be true for the refusal to count. Closed.

---

## 3. F-295 — RESOLVED as filed

The unseeded-target case is now `isolation_half_seeded_canary`, a real table with the
production policies and only tenant A seeded, attacked on every run. Baseline:

```
✓ F-295: an attempt against a tenant that owns no row proves nothing and is not a pass  3897ms
```

Its expectation is that exactly one of ten attempts passes (`A->B insertOwnedBy`, the only
shape that needs no pre-existing target row) and the other nine are `unverified` with a
stated reason. The positive control is also real: the baseline census is compared against
four hand-derived literals including the row ids, so an empty or wrong census is red
rather than vacuously green. `rowsSeen`, `rowsAffected`, `actorOwnRowsVisible` and
`targetOwnRowsVisible` are all in `report.json`.

**`reaches` is fail-closed when omitted** — I checked this because the dispatch asked.
`TenantScopedMethod.reaches` is optional in the type, and `premiseFailure()`
(`coverage.ts:738`) tests `method.reaches !== 'new-row'`, so a registration that omits it
gets the *strict* branch: the target must own a row. A registration cannot weaken the gate
by forgetting the field. It can weaken it by declaring `reaches: 'new-row'` on a statement
that in fact reaches an existing row, and nothing cross-checks the declaration against the
SQL — a registration-author footgun, not an attacker path. Noted, not filed.

---

## 4. One overstated claim in the rework report, scoped

Rework report §2, F-295: the actor-premise clause "is the clause that fires if the tenant
context is not what the harness thinks it is." It fires when the flag reaches **nothing**.
It cannot fire when the flag reaches the **wrong thing symmetrically**. Measured — this is
my r1 SEC-006-4 proxy, re-run against the reworked harness:

```sql
ALTER ROLE shortkit_app SET "app.tenant_id" = '22222222-2222-4222-8222-222222222222';
```

```
# psql as shortkit_app, no tenant transaction at all:
#   current_setting('app.tenant_id', true) -> 22222222-…
#   select id, name from tenants           -> 22222222-… | Tenant B      <-- reads B's row
# vitest cross-tenant-isolation            -> isolation coverage — PASS, Tests 15 passed (15)
```

`withTenantTransaction` sets the flag transaction-locally, so every actor still sees its
own row and the premise holds on all twenty attempts. This is r1's SEC-006-5 — the harness
observes no flag-free query path — which was never filed as an F-number and which the
rework explicitly did not attempt (its §7). Recording it here so it is not lost: it is a
real gap in what a green run means, the fix is one probe (a transaction on the pool that
sets no flag, reading each registered table, expecting zero rows or a raise), and it is the
only thing that would notice `is_local` flipping to `false`. **Not filed as new — it is
r1's, unfiled, and unchanged.**

---

## 5. F-296 — RESOLVED as filed, and the residual is new

`tenantScopedTableDrift()` runs on every `runCrossTenantAttempts()` call, diffs both ways,
feeds the verdict, and lands in `report.json` as `registryDrift`. The r1 measurement is
closed (§1, leak 2).

Two probes the dispatch asked for, answered:

- **Can `tenantScopedTableDrift()` be satisfied by a table invisible to `pg_attribute`
  under the app role?** No. The query runs on `migrationDsn()` — as `shortkit_migrator` —
  and PostgreSQL's catalogs carry no row-level security, so catalog visibility is not
  role-dependent in the first place. This vector does not exist.
- **What the query IS bounded by**, from its own text at `coverage.ts:416-429`: schema
  `public` only, `relkind in ('r','p')` only, and the **literal column name `tenant_id`**
  plus one hard-coded exception, `tenants`. The third bound is reachable and I measured it
  — SEC-006-R2-2 below. The first two are reasoned from the SQL: a tenant-scoped relation
  in another schema, or a materialized view (`relkind 'm'`, to which RLS does not apply at
  all), is outside the enumeration. Both are low-plausibility against Drizzle's defaults;
  stated, not filed.

---

## 6. The question that matters: can the harness still be green while isolation is broken?

**Yes. Measured twice, on a settled tree, against the shipped harness.**

### 6a. A wide-open UPDATE policy on the migrated `tenants` table

One `ALTER POLICY`. `SELECT`, `INSERT` and `DELETE` policies untouched; policy count
unchanged at 4.

```sql
ALTER POLICY tenants_self_update ON tenants USING (true) WITH CHECK (true);
```

The attacker, measured as `shortkit_app` (no SUPERUSER, no BYPASSRLS) inside a normal
tenant-A transaction:

```
BEGIN; SELECT set_config('app.tenant_id','1111…1111', true);
UPDATE tenants SET name = 'overwritten-by-another-tenant' WHERE id = '2222…2222';  -> UPDATE 0
UPDATE tenants SET name = 'pwned-by-tenant-A';                                     -> UPDATE 2
COMMIT;

# read back as tenant B:  2222…2222 | pwned-by-tenant-A      <-- B's row, rewritten by A
```

The gates, under exactly that database:

```
isolation coverage — PASS — 2026-08-10T21:01:51.591Z
  pass  A->B  repo:TenantsTableAccess.updateOwnedBy  (write on tenants, saw 0, affected 0)
  pass  B->A  repo:TenantsTableAccess.updateOwnedBy  (write on tenants, saw 0, affected 0)
 Test Files  1 passed (1)
      Tests  15 passed (15)
verdict: pass
db:check-policies -> ok tenants / OK: 1 table(s) in schema public, all protected or exempt.
```

The same asymmetry on `DELETE`, measured on a purpose-built table with a correct
`FOR SELECT` policy and `FOR DELETE USING (true)` — the F-005 shape:

```
DELETE FROM probe_rows WHERE tenant_id = '2222…2222';   -> DELETE 0     (the harness's shape)
DELETE FROM probe_rows;                                 -> DELETE 2     (both tenants' rows gone)
```

**Why.** Every write in `tableAccess()` is qualified by the owner column
(`registrations.ts:148-163`), and PostgreSQL applies the `SELECT` policies to any `UPDATE`
or `DELETE` that references a table column. So a correct `SELECT` policy masks a broken
`UPDATE` or `DELETE` policy, and the write half of the battery can only ever re-prove the
`SELECT` policy. The repository already knows this rule — `test/support/rls-fixture.ts:175-188`
records it as a measured result, `DELETE … WHERE → DELETE 0` versus `DELETE FROM <t> → DELETE 1`
— and the attempt battery was built in the one shape the rule defeats.

### 6b. A leaking tenant-scoped table whose owner column is not called `tenant_id`

```sql
CREATE TABLE audit_events (id uuid PRIMARY KEY,
  owning_tenant uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  actor_email text NOT NULL);
GRANT SELECT, INSERT, UPDATE, DELETE ON audit_events TO shortkit_app;
ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events FORCE  ROW LEVEL SECURITY;
CREATE POLICY audit_events_tenant_isolation ON audit_events FOR ALL USING (true) WITH CHECK (true);
```

```
# shortkit_app, inside a correct tenant-A transaction:
#   a1a1… | 1111…1111 | alice@tenant-a.example
#   b1b1… | 2222…2222 | bob@tenant-b.example        <-- another tenant's row, with an email in it

isolation coverage — PASS — 2026-08-10T21:07:46.856Z
 Test Files  1 passed (1)
      Tests  15 passed (15)
verdict: pass  drift: {"inDatabaseNotRegistered":[],"registeredNotInDatabase":[]}
audit_events mentioned in report.json: false
db:check-policies -> OK: 2 table(s) in schema public, all protected or exempt.
```

This is my r1 `workspaces` measurement with one column renamed. Worth stating plainly:
with RLS *off* the same table **is** caught, by `db:check-policies`, which enumerates every
table in `public` rather than only the `tenant_id`-carrying ones —

```
FAIL: 1 table(s) in schema public are readable and writable by any tenant:
  - audit_events — missing ENABLE ROW LEVEL SECURITY and FORCE ROW LEVEL SECURITY
```

— so the hole is specifically **RLS on, policy wrong, owner column named anything else**,
which is the state `db:check-policies` is documented not to see and which drift is now the
only thing that would.

---

## Findings

```yaml
findings:
  - id: SEC-006-R2-1
    new: true
    severity: blocker
    kind: behavior
    file: apps/api/test/isolation/registrations.ts
    line: 148
    summary: >
      EVERY WRITE ATTEMPT IS QUALIFIED BY THE OWNER COLUMN, so PostgreSQL evaluates the
      table's SELECT policy against it. A correct SELECT policy therefore masks a broken
      UPDATE or DELETE policy, and the write half of the battery can only ever re-prove
      the read half. Measured on the migrated `tenants` table: the suite reports 15/15
      pass and report.json reports verdict pass while any tenant may rewrite every other
      tenant's row.
    attacker: >
      Any authenticated tenant user, through any repository method that issues an UPDATE
      or DELETE without a WHERE clause on the owner column — which is the shape ADR-0003's
      own doctrine encourages, because the policy is meant to be the boundary and the
      WHERE clause is not. `registrations.ts:70` says so in as many words about reads.
      The defect that opens it is an ordinary one: a per-command policy widened during
      debugging, or a second permissive `FOR UPDATE`/`FOR DELETE` policy added by a later
      migration, which is F-005's shape and which the pg_policies shape assertion would
      catch — TASK-056, deferred.
    reachable_path: >
      `tableAccess()` builds `updateOwnedBy` as `update <t> set <col> = … where <owner> =
      <target>` and `deleteOwnedBy` as `delete from <t> where <owner> = <target>`
      (registrations.ts:148-163). Both reference a table column, so PostgreSQL applies the
      SELECT policies in addition to the UPDATE/DELETE policy — the rule this repository
      has already measured and written down at test/support/rls-fixture.ts:175-188. With
      the SELECT policy correct, both statements affect zero rows whatever the UPDATE or
      DELETE policy says, `judge()` sees `rowsAffected = 0`, the before/after census is
      identical, and the attempt scores `pass`. The census cannot compensate: it reads
      through SELECT, which is the policy that is still correct. The both-directions loop
      cannot compensate: the leak is symmetric, and it is masked in both directions.
    measured_evidence: |
      ALTER POLICY tenants_self_update ON tenants USING (true) WITH CHECK (true);
      # policy count still 4; SELECT/INSERT/DELETE policies untouched.

      # as shortkit_app (no SUPERUSER, no BYPASSRLS), app.tenant_id = tenant A:
      UPDATE tenants SET name='overwritten-by-another-tenant' WHERE id='2222…2222'; -> UPDATE 0
      UPDATE tenants SET name='pwned-by-tenant-A';                                  -> UPDATE 2
      # read back as tenant B: 2222…2222 | pwned-by-tenant-A

      # vitest cross-tenant-isolation -> "isolation coverage — PASS", Tests 15 passed (15)
      #   pass A->B repo:TenantsTableAccess.updateOwnedBy (write on tenants, saw 0, affected 0)
      #   pass B->A repo:TenantsTableAccess.updateOwnedBy (write on tenants, saw 0, affected 0)
      # report.json -> "verdict": "pass"
      # db:check-policies -> OK: 1 table(s) in schema public, all protected or exempt.

      # the DELETE half, on a table with FOR SELECT correct and FOR DELETE USING (true):
      DELETE FROM probe_rows WHERE tenant_id='2222…2222';  -> DELETE 0   # the harness's shape
      DELETE FROM probe_rows;                              -> DELETE 2   # both tenants' rows
    required_change: >
      Add an UNQUALIFIED write attempt per registered table — `update <t> set <mutable> =
      …` and `delete from <t>` with no WHERE, run inside the actor's transaction — and
      require zero rows affected. That is the statement shape that reaches the UPDATE and
      DELETE policies directly, and it is what a repository written to this project's own
      doctrine will issue. Reset already runs before every attempt, so a wrongly-successful
      unqualified write cannot poison the next one. Separately, add an attempt that MUTATES
      THE OWNER COLUMN (`update <t> set <owner> = <target>`): no attempt in the battery
      does, so AC-95's "no tenant_id is altered" is only ever checked passively by a census
      over statements that never try. Both are additions to `tableAccess()`; nothing in
      `coverage.ts` changes. Finally, `cross-tenant-isolation.int-spec.ts:429` currently
      ASSERTS eight passes over `isolation_masked_refusal_canary`, a table carrying
      `FOR UPDATE USING (true)` and `FOR DELETE USING (true)` — that expectation encodes
      this defect and has to change with the battery.

  - id: SEC-006-R2-2
    new: true
    severity: major
    kind: behavior
    file: apps/api/test/isolation/coverage.ts
    line: 426
    summary: >
      The registry/database cross-check that closes F-296 enumerates on the LITERAL COLUMN
      NAME `tenant_id`, with exactly one hard-coded exception (`tenants`). A tenant-scoped
      table whose owner column is named anything else is invisible to it, and to
      `db:check-policies` as soon as RLS is switched on. Measured: `audit_events`
      (`owning_tenant`, ENABLE + FORCE + `USING (true)`) leaks every row to every tenant
      with both gates green and its name in no artifact.
    attacker: >
      Any authenticated tenant user, against whichever table the naming departure lands on.
      The condition is created by a future schema TASK. It is not exotic: `tenants` itself
      is already a tenant-scoped table with no `tenant_id` column, `ownerColumn` is a free
      string in `TenantScopedSurfaceRegistration`, and `check-policies.mts` already carries
      five named exemptions for tables that carry no `tenant_id` (`user`, `session`,
      `account`, `verification`, `jwks`).
    reachable_path: >
      `tenantScopedTableDrift()` (coverage.ts:416-429) selects relations in schema `public`
      with `relkind in ('r','p')` where `relname = 'tenants'` OR a `pg_attribute` row named
      exactly `tenant_id` exists. `audit_events` matches neither arm, so it is not in
      `inDatabase`, the drift is empty, the verdict stays `pass`, and the table appears
      nowhere in `report.json`. `check-policies.mts` DOES enumerate every table in `public`
      and does catch the same table while RLS is off — but it only reads
      `relrowsecurity`/`relforcerowsecurity`, never a predicate, so `ENABLE` + `FORCE` +
      `USING (true)` returns `ok`. Two gates, one shared blind spot.
    measured_evidence: |
      CREATE TABLE audit_events (id uuid PRIMARY KEY,
        owning_tenant uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        actor_email text NOT NULL);
      GRANT SELECT, INSERT, UPDATE, DELETE ON audit_events TO shortkit_app;
      ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
      ALTER TABLE audit_events FORCE  ROW LEVEL SECURITY;
      CREATE POLICY audit_events_tenant_isolation ON audit_events
        FOR ALL USING (true) WITH CHECK (true);

      # shortkit_app, inside a correct tenant-A transaction:
      #   a1a1… | 1111…1111 | alice@tenant-a.example
      #   b1b1… | 2222…2222 | bob@tenant-b.example        <-- another tenant's row, with an email

      # vitest cross-tenant-isolation -> "isolation coverage — PASS", Tests 15 passed (15)
      # report.json -> "verdict":"pass",
      #   registryDrift {"inDatabaseNotRegistered":[],"registeredNotInDatabase":[]}
      #   and the string "audit_events" appears nowhere in it
      # db:check-policies -> OK: 2 table(s) in schema public, all protected or exempt.

      # with RLS OFF the same table IS caught, by the sibling gate only:
      # db:check-policies -> FAIL: 1 table(s) ... - audit_events — missing ENABLE/FORCE
    required_change: >
      Enumerate what the drift check calls tenant-scoped by REACHABILITY, not by column
      name: every relation in `public` carrying a foreign key whose referenced table is
      `tenants`, plus `tenants` itself, plus anything already matching `tenant_id`. That is
      one join over `pg_constraint`, it needs no artifact that does not exist, and it
      catches `owning_tenant` and every other spelling. A table that is genuinely outside
      the tenant boundary then has to say so in the closed exclusion list, which is a
      one-line diff a reviewer sees — the same control shape `SUITE_OWNED_CONTROL_TABLES`
      and `ISOLATION_EXCLUSIONS` already use. Also state, in `COVERAGE_BOUNDARY`, that the
      enumeration is bounded to schema `public` and to ordinary and partitioned tables, so
      a reader of `report.json` knows a materialized view is outside it.

  - id: SEC-006-R2-3
    new: true
    severity: major
    kind: behavior
    file: apps/api/test/isolation/cross-tenant-isolation.int-spec.ts
    line: 150
    summary: >
      `report.json` is written ONCE, inside `beforeAll`, after `runCrossTenantAttempts()`
      returns. A run that dies before that point leaves the PREVIOUS run's artifact on disk
      still reading `"verdict": "pass"`. Measured: the F-293 leak run above went red, and
      `report.json` still said `pass` with the earlier run's `runAt`. This is the false
      green F-298 is NOT; the two are different defects on the same API surface, and this
      one must be fixed BEFORE F-297's CI upload lands, not after.
    attacker: >
      No external attacker. The affected party is whoever the artifact is shown to — a gate
      reviewer, an auditor, or a customer-facing claim built on SC-1. ADR-0020 calls this
      file "the artifact SC-1 points at", and the failure direction is the dangerous one:
      the harness detected a real leak and the artifact says the run passed.
    reachable_path: >
      `writeIsolationReport(report, REPORT_PATH)` is the only writer and it is at
      `cross-tenant-isolation.int-spec.ts:150`, after `createTenantFixtures()` and
      `runCrossTenantAttempts()` on line 147-148. Every fail-closed guard the rework added
      throws EARLIER than that: the absolute census assertion in `createTenantFixtures()`,
      the empty-census assertion, `assertAppRoleCannotBypassRls()`,
      `assertTenantsIsMigrated()`. So the harder the harness fails, the more certainly the
      artifact is stale. Today the blast radius is one machine because the file is
      gitignored (`.gitignore:51`) and `.github/workflows/ci.yml` contains no
      `upload-artifact` step and no mention of `report.json` — which is F-297. The moment
      F-297's owner adds that upload, CI publishes a green artifact for a red run.
    measured_evidence: |
      # database mutated so the fixture leaks (the F-293 leak-1 statement above):
      # vitest cross-tenant-isolation -> Test Files 1 failed (1), Tests 15 skipped (15)
      #   Error: the fixture leaks before any attempt has run: …
      # then, on disk, unchanged:
      #   report.json verdict: pass   runAt: 2026-08-10T20:53:49.189Z   <-- the PREVIOUS run
    required_change: >
      Delete `report.json` before the run, or write a failure stub as the first act of
      `beforeAll` — `{ verdict: 'fail', runAt, reason: 'the run did not reach
      runCrossTenantAttempts()' }` — so the artifact can never be older than the run that
      produced it. Whichever is chosen, F-297's CI upload should land in the same wave or
      after it, never before.
```

---

## 7. F-298 and F-297, judged

**F-298 — `lastReport` clobbered by six control runs. Real, correctly filed, and NOT a
false green.** I read the path rather than assuming it.

- `report.json` is safe. It is written from the local `report` binding in `beforeAll`
  (line 150), before any control run exists, and `writeIsolationReport` is called exactly
  once in the repository. A control run cannot corrupt the artifact.
- The suite's own assertions are safe. Every test reads the local `report` or the local
  `control` binding; none calls `isolationReport()`.
- The error can only run in one direction. Each of the six controls ends `verdict: 'fail'`
  — every control test asserts exactly that — and the last `runCrossTenantAttempts()` call
  in file order is `halfSeededCanaryAccess`. So after the suite, `isolationReport()` returns
  a **failing** report over `HalfSeededCanaryTableAccess` surface ids. **It cannot make a
  real run look green; it makes a green run look failed, over surfaces that do not exist
  outside the control.**
- Consumers today: **zero.** `grep` finds `isolationReport()` defined at `coverage.ts:992`
  and called nowhere in `apps/**` or `.github/**`.

So: cosmetic in blast radius today, wrong on a documented and contract-declared API, and a
trap set for TASK-056, which is the consumer the contract names. `minor` is the right
severity and the rework was right to disclose rather than unilaterally reshape a consumed
API. What it is **not** is the thing that could publish a false green — that is
SEC-006-R2-3, and it is a different defect.

**F-297 — still open, correctly attributed, and now sequenced.** Verified: `report.json` is
at `.gitignore:51`, and `.github/workflows/ci.yml` contains no `actions/upload-artifact`
step and no occurrence of `report.json`. The `owner_slot` of `sdlc-implementer-backend` is
right. The one thing to add to the finding: **the upload must not land alone.** With
SEC-006-R2-3 unfixed, adding the upload converts a local staleness bug into a published
false-green artifact. The boundary-statement half of F-297 is genuinely done — I read
`COVERAGE_BOUNDARY` in the emitted run log and it now states how the covered set is
bounded and what a pass means, which is what my r1 SEC-006-7 asked for.

**F-299 — survives, and it is the architect's.** Confirmed by reading
`design/contracts/isolation-coverage.md` at the audited HEAD: "Attempt semantics" still
says "zero rows returned, or a throw", the declared `IsolationReport` still lacks
`attempts`, `failed`, `unverified` and `registryDrift`, and nothing in it mentions both
directions, the census invariant, the refusal predicate or the three outcomes. The contract
understates the shipped harness in exactly the direction that lets a future change quietly
weaken it. **Not this rework's to fix, and I am not treating the divergence as a defect in
TASK-006.** One consequence worth handing the architect with it: whichever repair
SEC-006-R2-1 gets, the "Attempt semantics" table is where the unqualified write shape has
to be written down, or the next implementer rebuilds the same blind spot.

---

## 8. Probes that came back clean

| Probe from the dispatch | Result |
|---|---|
| a leak on a table registered but with no `reaches` metadata | **clean, fail-closed.** Omitting `reaches` selects the strict branch of `premiseFailure()`; the target must own a row. §3 |
| a policy correct for `SELECT` and broken for `UPDATE` | **NOT clean — this is the fifth class.** SEC-006-R2-1 |
| a leak visible only inside a transaction that has already written | **not reachable through this harness, and not a live hole today.** Every attempt is a single statement in its own `withTenantTransaction`, so a defect that appears only on a second statement — a policy predicate depending on rows written earlier in the same transaction, `ON CONFLICT DO UPDATE`, a `RETURNING` projection — is not exercised. I could not construct an instance that leaks under the two policy sets that actually ship: the `FOR ALL` template's `WITH CHECK` refuses an owner-column mutation, and `tenants_self_update`'s `WITH CHECK` does the same. Reasoned, with one attempted construction that failed to leak; recorded rather than filed |
| `tenantScopedTableDrift()` satisfied by a table invisible to `pg_attribute` under the app role | **vector does not exist.** The query runs as `shortkit_migrator` on `migrationDsn()`, and PostgreSQL catalogs carry no row-level security. What the query IS bounded by is schema, `relkind`, and the column name — §5, SEC-006-R2-2 |

---

## What I could not verify

- **The CI path.** Read, not executed. My claim about `ci.yml` is a grep for
  `upload-artifact` and `report.json`, both absent.
- **TASK-056's half of `coverage.ts`.** Unchanged and still throwing with an owner named in
  each message. Not this audit's subject.
- **`is_local`.** Still reasoned, not measured, for the same reason as r1: proving it would
  require editing `src/tenancy/tenant-context.ts`. §4's ambient-GUC measurement is the
  hazard, not the flip.
- **Routes, guards, repositories.** Still none exist.

## Environment and residue

- Postgres left running: `docker compose -f docker-compose.test.yml`, container
  `shortkit-postgres-1`, port 55433, freshly migrated.
- Restored by `down -v` → `up -d --wait` → `db:migrate` after every mutation, never by
  hand. Final state verified from the catalog: schema `public` holds exactly one relation
  (`tenants`) across `relkind` r/p/m/v; `tenants` carries its four migration policies with
  the original `qual`/`with_check` text; both roles `rolbypassrls=f rolsuper=f
  rolcreaterole=f` with an empty `rolconfig`.
- Final gates run by me after the last restore: integration **48 passed (48)** across 3
  files, `db:check-policies` **OK: 1 table(s) in schema public, all protected or exempt**.
- `git status --porcelain` clean. The only file this audit wrote is itself. `report.json`
  is gitignored and untracked; every run rewrote it, which cannot show as drift.
- One correction worth recording for the next person mutating this database: `docker exec`
  without `-i` silently discards a heredoc, so a mutation can appear applied when nothing
  ran. I caught one such no-op by re-reading `pg_class` before trusting a green run. Verify
  every mutation from the catalog before you believe the gate result.
