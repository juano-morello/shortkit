# TASK-005 — sdlc-security-auditor, fix round 1 re-review (r2)

Scope: `cdb07e4..9eb654a` only, read from
`.superpowers/sdd/plan/review-cdb07e4..9eb654a.diff`. Gates not re-run (verified by the
orchestrator). Nothing edited under `apps/**`; this file is the only artifact written.

```yaml
verdict: clear
findings:
  - severity: minor
    kind: behavior
    file: apps/api/src/tenancy/tenant-context.ts
    line: 230
    blocking: no
    summary: The F-121 `settled` flag is raised after COMMIT returns, not when `fn` resolves, leaving a window one network round trip wide in which `activeContext()` still hands out the handle.
    failure_scenario: >-
      `fn` resolves at t0. drizzle then issues COMMIT (a round trip to Neon), and only in
      its own `finally` calls `client.release()`; `withTenantTransaction`'s `finally`
      runs three microtasks after that. A detached continuation resuming anywhere in
      that window reads `settled === false` and gets the live handle. Statements it
      issues inside the window run post-COMMIT with no transaction-local
      `app.tenant_id`, so they see zero rows and fail WITH CHECK on write — fail-closed,
      which is why this is minor and not a repeat of F-121. What is not closed is a
      continuation that captures the handle inside the window and uses it later, after
      the connection has been re-checked-out under another tenant. That residual is the
      same one the design already accepts for `fn`'s own `db` argument.
    required_change: >-
      Optional hardening, not a rework item. Mark the context settled where `fn` settles:
      `return tenantStorage.run(context, () => fn(db)).finally(() => { context.settled = true; })`
      inside the transaction callback, keeping the outer `finally` as the belt for the
      path where `tenantStorage.run` is never reached. `afterCommit` hooks run outside the
      ALS frame and open their own transactions, so they are unaffected — the passing
      invariant-6 test covers exactly that shape.

  - severity: minor
    kind: behavior
    file: apps/api/scripts/check-policies.mts
    line: 132
    blocking: no
    summary: The exception list is unconditional and pre-registers four tables that do not exist, so an exemption is granted before anything can verify it is deserved.
    failure_scenario: >-
      `user`, `session`, `account` and `verification` are exempted by name today. Any
      future migration that creates a table with one of those names is silently skipped
      by the only automated detector of a missing ENABLE/FORCE — the exact class of
      silent green F-122 exists to catch. `verification` is the plausible collision:
      `domain-provisioning.md` runs a DNS verification flow, and a tenant-scoped
      `verification` table would be waved through. The script's own docblock names this
      risk ("an exception list is the obvious place to hide the failure") and then
      implements the weakest form of it.
    required_change: >-
      Make each exemption self-verifying rather than nominal: for an exempt relation,
      assert from `information_schema.columns` that it carries no `tenant_id` column, and
      fail if it does. Optionally report an exempt name that matches no relation, so a
      stale entry surfaces instead of sitting dormant.

  - severity: minor
    kind: docs
    file: docs/architecture/rls.md
    line: 128
    blocking: no
    summary: The new working-version RLS doc describes the isolation model without stating that the redirect-read policy is PERMISSIVE and therefore cross-tenant.
    failure_scenario: >-
      `redirectReadPolicy` emits `CREATE POLICY <t>_redirect_read ... FOR SELECT USING
      (current_setting('app.redirect_context', true) = 'on')` with no `AS RESTRICTIVE`.
      Postgres ORs permissive policies, so a transaction with `app.redirect_context` set
      sees every tenant's rows in `domains` and `links` regardless of `app.tenant_id`.
      That is a deliberate, contract-recorded exclusion (one of exactly two) — but
      `rls.md` lists `app.redirect_context` in its flag table and says nothing about its
      blast radius, and its "per-table template" section presents tenant scoping as
      universal. A developer writing TASK-029's read path from this document alone will
      assume tenant scoping still applies underneath.
    required_change: >-
      Two sentences in `rls.md`: the redirect policy is PERMISSIVE, permissive policies
      are ORed, so within `withRedirectRead` the only thing standing between a request
      and another tenant's rows is the query's own predicate plus `SET TRANSACTION READ
      ONLY`. Cross-reference `rls-policy-template.md`'s exclusion list. Unchanged by this
      diff — the boundary's shape is exactly as it was; this is about the new doc.

  - severity: minor
    kind: test-coverage
    file: apps/api/test/tenancy/tenant-context.int-spec.ts
    line: 1
    blocking: no
    summary: F-137's checked-out client listener has no test, and it is the one guard whose removal is invisible until production.
    failure_scenario: >-
      The fix is four lines that look decorative. A later edit deleting
      `pool.on('connect', ...)` passes every gate: `pnpm test`, `pnpm test:integration`,
      lint, typecheck and build all stay green, because the only F-123 test kills a
      connection that is already IDLE IN THE POOL, where pg-pool re-attaches its own
      listener. The regression then shows up as the API process exiting on a Neon
      scale-to-zero or failover mid-transaction, which also breaks GC-8 for every
      in-flight visitor.
    required_change: >-
      The harness already has both pieces the test needs: `querySql(migrationDsn(), ...)`
      against `pg_stat_activity`, and the `process.on('uncaughtException', capture)`
      pattern from the existing F-123 test. Open a tenant transaction, capture
      `pg_backend_pid()`, `pg_terminate_backend` it from the migrator connection while
      the transaction is still open and idle, then assert the call rejects and `fatal`
      is empty. Test file — routes to sdlc-test-architect, not to the implementer.

  - severity: nit
    kind: implementation
    file: apps/api/src/db/rls.ts
    line: 147
    blocking: no
    summary: The boot check counts owned relations with `relkind = 'r'` while `check-policies.mts`, written in the same commit, uses `relkind in ('r', 'p')`.
    failure_scenario: >-
      A partitioned table owned by the runtime role is not counted, so the F-129
      ownership guard would pass on a database where `check-policies` correctly demands
      RLS on the same relation. Nothing in launch-core partitions, so this is a
      consistency nit rather than a reachable defect.
    required_change: Use `c.relkind in ('r', 'p')` in both, or state why the boot check is narrower.

  - severity: nit
    kind: docs
    file: apps/api/src/db/client.ts
    line: 21
    blocking: no
    summary: The header says `design/contracts/tenant-context.md` "still names three" sanctioned consumers; the architect amended that contract to four in the same round.
    failure_scenario: >-
      `tenant-context.md` "What the implementer must guarantee" now carries a
      four-row table including `assertRuntimeRoleCannotBypassRls` (control path), with
      `ISOLATION_EXCLUSIONS` explicitly held at two. The header's carve-out is stale, and
      it is the text downstream TASKs read before the contract.
    required_change: Delete the "still names three" sentence. Everything else in that paragraph is correct.

  - severity: nit
    kind: implementation
    file: apps/api/scripts/check-policies.mts
    line: 203
    blocking: no
    summary: "`EXEMPT[row.table_name]` resolves through Object.prototype, so a relation named `constructor`, `toString`, `valueOf` or `hasOwnProperty` reads as exempt."
    failure_scenario: >-
      `EXEMPT['constructor']` is not `undefined`, so the table is skipped and printed as
      exempt with the Object constructor as its "reason". No attacker reaches this — table
      names come from this repository's own migrations — which is why it is a nit.
    required_change: "`Object.hasOwn(EXEMPT, row.table_name)`, or build the map with `Object.create(null)`."
```

## Part 1 — verdict on each round-1 finding

| Finding | Verdict | Evidence checked |
|---|---|---|
| F-120 | **ADDRESSED** | `postgresErrorCode` / `postgresErrorConstraint` exported from `client.ts:226,241`, both routed through one private `driverError()` that unwraps `DrizzleQueryError` then narrows to `pg.DatabaseError`; the false comment claiming the wrapper never leaves the module is replaced by a "CORRECTED 2026-08-05" block that states the statement-vs-transaction boundary explicitly. `tenant-context.md` gained a normative "Driver errors inside `fn`" section with the closed field allowlist. The integration test drives a real `23505` inside a `SAVEPOINT slug_try` loop and asserts `{code:'23505', constraint:'rls_fixture_rows_pkey'}` read from inside `fn`; the unit spec asserts both accessors answer rather than throw for `undefined`, `null` and a bare string. |
| F-121 | **ADDRESSED** (with a minor residual filed above) | `ActiveTenantContext.settled` added; set in a `finally` around `databaseTransaction` (`tenant-context.ts:230-237`); checked in `activeContext()` (:319) so `tenantDb()` and `currentTenantId()` both throw, and checked at the top of the nesting branch (:179) before the tenantId compare, so the reuse path throws instead of degrading silently. The message is a distinct constant, not "call withTenantTransaction first". Two integration tests build the exact detached-continuation shape and now get `{status:'rejected', reason: TenantContextMissingError}` where round 1 got `{status:'fulfilled', value:[{reached_the_database:1}]}`. **Window analysis:** the flag is not set for the interval between `fn` resolving and `withTenantTransaction`'s `finally` — drizzle's `session.cjs:220-229` runs `await transaction(tx)` → `await tx.execute(commit)` → `finally { client.release() }`, so the release happens strictly before our `finally`. Statements issued inside that window run post-COMMIT with no transaction-local flag and are denied by policy (fail-closed); a handle captured inside it and used later is the same accepted residual as `fn`'s own `db` argument, which the contract and `rls.md` both state. No path reaches a live handle without `activeContext()` other than that documented one. Filed as a minor hardening; not a rework item. |
| F-122 | **ADDRESSED** | `apps/api/scripts/check-policies.mts` + `db:check-policies` in `apps/api/package.json`. Matches the minimum viable form I specified: `pg_class` joined to `pg_namespace`, `nspname='public'`, `relkind in ('r','p')`, asserts both `relrowsecurity` and `relforcerowsecurity`, explicit `EXEMPT` map with a reason per entry, non-zero exit listing the offending tables and naming the repair. Two things it does better than my spec: it fails rather than passing vacuously on an empty schema, and it covers partitioned parents. I verified it parses and runs under the repo's Node 24 (`env -u DATABASE_URL node scripts/check-policies.mts` reaches `connectionString()` and exits non-zero with the intended message), so the deliverable is not a script that only looks like one. It reads `pg_class` as `shortkit_app`, which is correct and sufficient — `pg_class` is world-readable and not itself RLS-protected, so a table the runtime role cannot query is still audited. **The four exempt names are `user`, `session`, `account`, `verification`, which do not exist yet — that is not an invention:** `rls-policy-template.md:178` records exactly those four as no-`tenant_id`, no-RLS, owned by TASK-009. The exemption being nominal rather than verified is the minor filed above. CI wiring stays TASK-002's per the ruling. |
| F-123 | **ADDRESSED** | `max: 10`, `connectionTimeoutMillis: 2000`, `pool.on('error')` that logs name + SQLSTATE and discards, and the third `set_config('idle_in_transaction_session_timeout', $2, true)` in `withTenantTransaction`, landed together with F-137's client listener as the architect required. The A4 collision the implementer hit and reported was real: clause A4 permitted only `statement_timeout` and `app.*`, and it has since been widened **by enumeration** with a stated admission test (USERSET, `is_local = true`, bounds a resource the transaction already holds, does not change identity/visibility/name resolution). I re-ran A1–A4 against the tree by hand: `app.tenant_id` appears in exactly `tenancy/tenant-context.ts` and `db/rls.ts`; the other two flags only in `rls.ts`; all six `set_config(` matches in the scan set carry a quoted literal first argument from the permitted list; `rls.ts` contains no match of `/set_config\s*\(/` (its two occurrences of the bare word are followed by " call" and ",", so A3 passes as literally specified). The integration test file lives under `apps/api/test/**`, which the contract excludes from the scan set, so its `set_config('idle_session_timeout', ...)` does not break A4 later. |
| F-124 | **ADDRESSED — the recording satisfies me** | ADR-0018 now carries a two-row advisory register with my assessment of `GHSA-67mh-4wv8-2f99` transcribed intact (dev-server-only, transform API only, `drizzle-kit` never starts a server, devDependency so `--prod` cannot see it), and, more usefully, a **clearing condition** — a `drizzle-kit` release dropping `@esbuild-kit/esm-loader`, re-checked on every bump. The second row, `GHSA-g7r4-m6w7-qqqr`, is correctly labelled as assessed by the architect and not reviewed by me; I read it and concur (`tsup` bundles, does not serve; nothing here is Windows), and its "below both audit thresholds, invisible until someone runs `--audit-level low` by hand" note is the right thing to have written down. The half of my required change that mattered is also answered: the ADR confirms the weekly job runs `pnpm audit --audit-level moderate` across all dependencies and that the `quality` job's `--prod` structurally cannot see this class, and TASK-002 is assigned to create `docs/security/known-advisories.md` from those rows. No dependency change was needed and none was made. |
| F-126 | **ADDRESSED** | `client.ts`'s enumeration now names four consumers including `assertRuntimeRoleCannotBypassRls`, and `tenant-context.md` was amended in the same round to a four-row table that additionally classifies the fourth as control-path and holds `ISOLATION_EXCLUSIONS` at two — so TASK-056 has one list that is true and does not gain a third exclusion. The framing I asked to be carried forward is carried verbatim: the guarantee is not unreachability but that an unscoped transaction sees zero rows and can write none. Residual: `client.ts`'s header still says the contract "names three", which is now stale — nit above. |
| F-127 | **ADDRESSED** | The healthcheck is now `psql "postgres://shortkit_app:app@127.0.0.1:5432/shortkit_test" -tAc "select 1"`, which authenticates as the role, names the database, and goes over TCP. All three halves of the race are closed: during the entrypoint's temporary socket-only server the probe cannot connect at all, and the init script (roles → `CREATE DATABASE` → `\connect` → grants) completes before the real server starts, so healthy implies the grants exist. The comment now describes what the probe actually gates on rather than what `pg_isready` was assumed to. |
| F-129 | **ADDRESSED** | The same round trip now also returns `tables_owned_in_public`, counted as tables in `public` whose `relowner = current_user::regrole`, and a non-zero count throws with a message naming the count and the repair. Counting owned tables rather than existing tables is the right discrimination and the suite proves both directions: the migrator (clean on superuser and bypassrls, owns > 0) is rejected, and the runtime role (owns 0) is accepted. The docblock also records the limit I asked not be over-claimed — `rolbypassrls` is a non-inherited role attribute, so membership in a BYPASSRLS role reads false, reachable only through `SET ROLE`, which nothing issues. |
| F-130 | **ADDRESSED** | `assertUuid` returns `value.toLowerCase()`, and the docblock states the returned value is canonical and the one to compare against database output. `withTenantTransaction` uses the canonical `scopedTo` for both the nesting compare and the `set_config` bind, so the stored and compared forms cannot diverge. |
| F-131 | **ADDRESSED** | `docker-compose.test.yml` gained a delimited "TEST-ONLY. DO NOT ADAPT THIS FILE INTO A PRODUCTION DATABASE" header that splits reusable from not-reusable exactly as assessed: reusable — both roles NOBYPASSRLS with attribute defaults, `shortkit_app` owning nothing, DML only through `ALTER DEFAULT PRIVILEGES` from the migrator, `USAGE` on `public` and nothing more; not reusable — committed literal passwords including the bootstrap superuser's, no TLS with the `sslmode=require` versus `verify-full` distinction spelled out, tmpfs storage, and the `ALTER DEFAULT PRIVILEGES` identity scoping that fails closed at runtime rather than at deploy. It also states that production role provisioning is unowned and routed alongside F-116, which is the honest end of that thread. |
| F-132 | **ADDRESSED** | `InvalidTenantIdError` now reports `JSON.stringify(value.slice(0, 8))` plus the length, so an unauthenticated capability-token URL segment can put at most 8 escaped characters into the log store, with the length preserved for diagnosis. The full value is not retained on the error. The open question of whether that route should answer 400/404 instead of 500 correctly stayed with ADR-0021's TASK. |

## Part 2 — new breakage in the fix diff

Nothing blocking. Findings above are the complete list; all are minor or nit and none needs another fix round.

### F-137 — verdict: ADDRESSED. The evidence is adequate for correctness, not for regression.

I verified the mechanism independently against the pinned trees rather than taking the
report's word:

- `pg-pool@3.14.0/index.js:343` — `_acquireClient` calls `client.removeListener('error', idleListener)` on every checkout. Between checkout and release the client has zero `'error'` listeners from pg-pool.
- `drizzle-orm@0.45.2/node-postgres/session.cjs:215-229` — `transaction()` does `await this.client.connect()` and attaches no listener of its own.
- `pg@8.22.0/lib/client.js:198-219` — the socket `end` handler calls `_errorAllQueries(error)` **and** `_handleErrorEvent(error)`, so the pending query rejects *and* `'error'` is emitted on the client. With no listener, Node turns that into an uncaughtException.
- `pg-pool@3.14.0/index.js:381-395` — `_release` removes rather than re-pools a client that is no longer `_queryable`, so the dead connection is not handed to the next request. This was the failure mode I most wanted to rule out and it is ruled out.
- `_acquireClient` emits `'connect'` only when `isNew`, so `pool.on('connect')` attaches exactly one client listener per physical connection and does not stack. `'acquire'` would have.

The handler logs `error.name` and the SQLSTATE only, which complies with `tenant-context.md`
rule 2. The observed values in the implementer's probe (`25P03` on the FATAL, then a
second emit with no SQLSTATE from the socket close) match what the sources predict, and
the accepted double-log on the idle path is real and correctly explained: on an
idle-in-pool death both listeners fire, because `makeIdleListener` removes only its own.

The throwaway probe is gone — `apps/api/scripts/` contains `check-policies.mts` and
nothing else, and `git status` shows no untracked file anywhere under `apps/`.

So: the fix is correct, minimal, and matches the required change exactly, and the
implementer was right not to write a test in a file it does not own. What the round does
**not** produce is anything that would notice the listener being deleted later. That is
the coverage minor filed above, routed by kind rather than by me.

### F-118 — the emitted SQL

`rls.ts` is byte-identical. `TENANT_ID_SETTING` was `'app.tenant_id'` and every use was
`current_setting('${TENANT_ID_SETTING}', true)`, which rendered exactly
`current_setting('app.tenant_id', true)`; the inline literal produces the same bytes, in
both the `USING` and the `WITH CHECK` half. Policy names, index names and the
`privileged_erase` clause are untouched.

**Parameterisation did change, in `tenant-context.ts`, and the change is the point.**
Before: ``sql`select set_config(${TENANT_ID_SETTING}, ${scopedTo}, true)` `` — the flag
name was a bind parameter, so the wire statement was `set_config($1, $2, true)`. After:
`set_config('app.tenant_id', $1, true)`. The *value* is still bound; what moved to an
inline literal is a compile-time constant that never touches user input, and clause A4
requires it there precisely so grep can tell a literal from an identifier that might hold
a concatenation. No tenant id, timeout, or any other runtime value is interpolated
anywhere in the three statements. `assertUuid` still runs before `scopedTo` reaches the
bind. No injection surface was opened.

### F-134

`fileParallelism: false` with the reasoning recorded, including the alternative
(per-file table names) and why it was rejected — the remaining races are a shared
`tenants` root, a shared role and the pool `max` split across workers, none of which
renaming a table fixes. Correct call. `assertEveryIntegrationSpecRuns()` still guards
against a suite filed under a name the glob misses.

### The three new deliverables

- **`check-policies.mts`** — verdicted under F-122 above. Two nits filed, nothing blocking.
- **`docs/architecture/rls.md`** — accurate on every mechanism I checked: the three-statement preamble, why `set_config` and not `SET LOCAL`, why the flag name is inline, the settled-context rule, `FORCE`, `USING` + `WITH CHECK`, the second argument to `current_setting`, the checks table, and the error-reading rules including the `detail`-contains-values residual. One omission, filed as a minor: the redirect-read escape's permissive shape.
- **`docs/architecture/migrations.md`** — the timestamps-not-hashes caveat and the "integration suite wipes the migrated tables" caveat are both correct and both are the kind of thing that otherwise costs an afternoon. Neither doc contains a credential, a production hostname, or an instruction that weakens a control. GC-13 is not engaged: `docs.required: [README]` and README is untouched.

## Notes

- **No dependency was added or bumped.** `pnpm-lock.yaml` is not in the changed-file list and `apps/api/package.json` gained one `scripts` entry and nothing else. See "Dependencies reviewed" below.
- **The redirect boundary is unchanged in shape.** `redirectReadPolicy` is untouched by this diff, still `FOR SELECT` with no `AS RESTRICTIVE`, and nothing in the diff sets `app.redirect_context` — `grep -rl` over `apps/api/src` finds that string only in `rls.ts`, which is the read side. The carried-forward design property still holds and is still not a defect in this TASK; my only new remark is that the new doc should say so.
- **The three capacity numbers.** `max: 10` and `connectionTimeoutMillis: 2000` change an unbounded hang into a bounded rejection, which is strictly better than what shipped in round 1, and both are reasoned rather than inherited. Neither is pinned by a test against a real Neon endpoint and neither should block here. Two things for the ledger rather than this loop: (1) the acquisition timeout rejects with a plain `Error: timeout exceeded when trying to connect` carrying no SQLSTATE, and **GC-8 requires that no unresolvable request return 5xx to a visitor** — the redirect path shares this pool, so TASK-029/TASK-007 must map an acquisition failure to the branded 404, not to a 500; (2) `POOL_MAX × instances` against the Neon compute's backend ceiling is a number worth measuring once TASK-002's perf gate exists, since GC-1's 500 RPS is nowhere near satisfiable from ten connections if the cache misses.
- **The 5 s idle bound has teeth, and the teeth are pointed the right way.** It terminates the connection rather than cancelling a statement, and the caller sees a `pg` connection failure with no SQLSTATE, so nothing can branch on it — correct, because there is nothing to retry inside a transaction that no longer exists. Worth recording that the SQLSTATE is *not* lost: `25P03` reaches the checked-out client listener and lands in the log line, so the failure is diagnosable even though it is not branchable. Note also that the bound is set only by `withTenantTransaction`, so `withRedirectRead` (TASK-029), which goes through `databaseTransaction` directly, is unaffected.
- **`driverError` unwraps one level.** If drizzle ever nested a `DrizzleQueryError` inside another, `postgresErrorCode` would silently answer `undefined`. I could not construct a nesting path in 0.45.2 — a failed `ROLLBACK` in `transaction()`'s catch replaces rather than wraps — so this is a remark, not a finding. A recursive unwrap is one line if anyone touches that function again.
- **File placement, informational only.** `apps/api/src/tenancy/tenant-context.spec.ts` is a new file that is not covered by TASK-005's `paths:` (which names the narrow glob `apps/api/src/tenancy/tenant-context.ts`) nor by `test_files:` (which names only the int-spec). `apps/api/src/db/client.spec.ts` is inside `apps/api/src/db/**` and is fine. Placement is sensible and the file is correct; flagging only because the TASK card does not authorise the path and routing is yours.
- I did not re-run `pnpm test`, `test:integration`, `lint`, `typecheck` or `build`, per instruction. The one thing I executed was `node scripts/check-policies.mts` with `DATABASE_URL` unset — no database touched — to confirm the new script actually parses and runs under Node 24 rather than only appearing to.

## Dependencies reviewed

None. This diff adds no dependency and bumps none; `pnpm-lock.yaml` is unmodified. The
only supply-chain movement in the round is documentary — F-124's two esbuild advisories
recorded in ADR-0018's register, both dev-only, neither reachable, both with a stated
clearing condition, and destined for `docs/security/known-advisories.md` under TASK-002.
