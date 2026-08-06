# TASK-005 — sdlc-reviewer, fix round 1 re-review (scoped)

> Persisted verbatim by the orchestrator from the agent's return value.
> `sdlc-reviewer` is read-only and its configuration forbids writing report files, so it
> returned the report as its return value. Same defect as `sdlc-product-auditor` this
> round; both are dispatched with a report path they structurally cannot write.

**Verdict: APPROVED** — all eight of my round-1 findings are ADDRESSED. Nine new items, all
`minor` or `nit`, none blocking. My recommendation is that none of them extend the loop;
two (#5, #9) should be recorded against later TASKs before deploy rather than dropped.

Scope: `.superpowers/sdd/plan/review-cdb07e4..9eb654a.diff` (commits `2ffa011`, `9eb654a`),
read against the whole files. I did not re-run the gates.

## Part 1 — verdict per finding

| Finding | Verdict | Evidence |
|---|---|---|
| **F-120** | **ADDRESSED** | `apps/api/src/db/client.ts:213-243` — one private `driverError()` unwraps `DrizzleQueryError` once, then `instanceof pg.DatabaseError`; two exported accessors read `.code` and `.constraint` off it. The two-accessor shape satisfies the loop I was protecting: `design/contracts/slug.md:93-98` now specifies exactly `postgresErrorCode(error) === '23505' && postgresErrorConstraint(error) === 'links_domain_id_slug_unique'`, and the integration case at `apps/api/test/tenancy/tenant-context.int-spec.ts` reads `{code:'23505', constraint:'rls_fixture_rows_pkey'}` from a catch **inside `fn`**, then `ROLLBACK TO SAVEPOINT` + redraw + commit — the full loop, not just the read. The false comment ("two reasons the wrapper does not leave this module") is gone and replaced with the corrected statement at `client.ts:186-194`. **Residual:** handled at the level my finding asked for and no further — `tenant-context.md` "The residual, stated rather than left implicit" states `detail`/`where`/`internalQuery` explicitly, rule 2 forbids reading them, rule 3 closes the allowlist, and `client.ts` exposes no accessor for them. Enforcement is documentation-only: `databaseTransaction` still rethrows the raw `pg.DatabaseError`, and the TASK-056 greps the contract specifies cover `.code` and `DrizzleQueryError`, not `.detail`. See new finding 6 for the one place the repo already violates rule 2. |
| **F-123** | **ADDRESSED** | `client.ts:69,81,114-132` — `max: 10`, `connectionTimeoutMillis: 2000`, `pool.on('error')` logging name + SQLSTATE only. Idle bound landed in the follow-up at `tenant-context.ts:150,221-223`. Both integration cases pin the behaviour (`stillWaitingForAConnection` = 0 at 40 concurrent; no `uncaughtException` on an idle-connection death, and the pool still serves after). See new finding 9 on the 2000 ms number. |
| **F-125** | **ADDRESSED** | `tenant-context.ts:190-201` — `const nested = await fn(active.db)` **then** `active.afterCommit.push(...)`. The savepoint-free shape my finding said to keep is intact and pinned by `invariant 5: statements a nested frame issued commit with the outer`, so the repair did not buy its own test with a savepoint. |
| **F-126** | **ADDRESSED** | Both lists now say four and agree: `client.ts:10-22` and `design/contracts/tenant-context.md:302-311` ("`databaseTransaction` has exactly four sanctioned consumers", with `assertRuntimeRoleCannotBypassRls` as the control-path row and `ISOLATION_EXCLUSIONS` explicitly held at two). TASK-056 has one list that is true. One stale sentence survives — new finding 2. |
| **F-127** | **ADDRESSED, and the change is right** | `docker-compose.test.yml:80-82` — `psql "postgres://shortkit_app:app@127.0.0.1:5432/shortkit_test" -tAc "select 1"`. All three properties `pg_isready` lacked are present: it authenticates (so it is false until `CREATE ROLE` has run), it names `shortkit_test` (false until `CREATE DATABASE` has run), and it goes over TCP to 127.0.0.1 — which the entrypoint's temporary init server does not listen on, since it starts with `listen_addresses=''`. The probe is therefore strictly stronger than the old one and cannot go true early; its only new failure mode is never going true if the DSN drifts from the `configs` block, which fails loudly at `up --wait`. The comment at `:70-79` now describes what it gates on. **I concur that the absent test is not the defect** — a cold-start test needs `down -v`, which destroys the database the suite runs on, and inspection plus a demonstrated cold start is the right evidence here. |
| **F-128** | **ADDRESSED** | Invariant 4 as a pure unit test with no database (`apps/api/src/tenancy/tenant-context.spec.ts`, both accessors); invariant 5 as three integration cases including the uncommitted-write visibility that is what "reuses the outer transaction" actually means, and the no-savepoint case; invariant 6 as three cases (runs once after COMMIT is proven by a *separate* transaction seeing the row, not by ordering); AC-9 re-parenting added. The tests assert the properties, not the implementation. |
| **F-130** | **ADDRESSED** | `tenant-context.ts:293-299` returns `value.toLowerCase()`, docblock at `:283-292` states the returned value is canonical and is the one to compare against database output. No test covers it (see Notes). |
| **F-133** | **ADDRESSED** (via the finding's own second branch) | `apps/api/drizzle.config.ts:40-46` carries the caveat, naming the gate that does not run and the one-line repair, and `apps/api/scripts/check-policies.mts:119-123` carries the same for itself. My finding offered "typechecked, or the caveat moves into the file"; the second was taken, correctly, since `tsconfig.json` is not this TASK's. The widened version is F-135 and is not mine to resolve. |

## Part 2 — findings on the fix diff

```yaml
verdict: clear
findings:
  - severity: minor
    kind: contract
    file: .sdlc/launch-core/design/contracts/tenant-context.md
    line: 290
    summary: The contract's invariants never describe the settled-context behaviour F-121 introduced; invariant 5 still promises unconditional reuse.
    failure_scenario: >-
      Invariant 5 reads "Nesting withTenantTransaction with the same tenantId reuses the outer
      transaction and does not open a savepoint", with no exception. The shipped code
      (tenant-context.ts:179-181) throws TenantContextMissingError when the outer context has
      settled. A TASK-011 or TASK-025 implementer who reads only the contract writes a
      fire-and-forget follow-up inside fn that calls withTenantTransaction, expects reuse, and
      gets a runtime throw with no contract text explaining it — the behaviour is documented
      only in docs/architecture/rls.md ("The context ends when the transaction ends"), which is
      not normative and which no consuming TASK is pointed at. Invariant 4 covers tenantDb()
      by a generous reading of "outside an active context"; the nesting branch is uncovered.
    required_change: >-
      tenant-context.md states, as an invariant, that a context is invalidated when its
      transaction settles and that every read of it afterwards — tenantDb, currentTenantId and
      a nested withTenantTransaction — throws TenantContextMissingError rather than reusing a
      released handle.

  - severity: minor
    kind: implementation
    file: apps/api/src/db/client.ts
    line: 21
    summary: The sanctioned-consumer comment says tenant-context.md "still names three"; it names four, as of the same round.
    failure_scenario: >-
      client.ts:21-22 reads "design/contracts/tenant-context.md still names three; that file is
      the architect's and the amendment is reported rather than made here." The architect's
      follow-up made that amendment: contracts/tenant-context.md:302-311 is a four-row table.
      F-126 existed precisely so TASK-056 would find one list that is true; a comment in the
      file TASK-056 greps from, asserting that the normative document disagrees, invites the
      next reader to trust the wrong one or to "fix" the contract back.
    required_change: The comment either drops the stale sentence or cites the amended contract.

  - severity: minor
    kind: implementation
    file: docs/architecture/migrations.md
    line: 20
    summary: The Commands section says every command needs DATABASE_MIGRATION_URL; db:check-policies reads DATABASE_URL and hard-fails without it, and db:generate needs no connection.
    failure_scenario: >-
      "Both run from the repository root and both need `DATABASE_MIGRATION_URL`" is followed by
      a three-row table. A developer or a TASK-002 author following it exports only
      DATABASE_MIGRATION_URL and runs db:check-policies, which exits 1 on
      "DATABASE_URL is not set" — or, reading the sentence as authoritative, sets DATABASE_URL to
      the migrator DSN, which silently defeats the script's own recorded design decision to
      check as the role whose access the policies constrain (check-policies.mts:164-175).
    required_change: >-
      The section states per command which variable it needs: db:generate none, db:migrate
      DATABASE_MIGRATION_URL, db:check-policies DATABASE_URL as the runtime role, with the
      reason for the last.

  - severity: minor
    kind: implementation
    file: docs/architecture/rls.md
    line: 160
    summary: rls.md presents assertRuntimeRoleCannotBypassRls as a check that runs at boot; nothing calls it.
    failure_scenario: >-
      The "What checks what" table gives its When as "boot, before traffic" and line 164 adds
      "the process still exits non-zero". The function is implemented and uncalled — the
      implementer's own report §5 item 5 records that main.ts has no call site and that F-116
      routed it to TASK-003. A reader of the only architecture document on RLS concludes that a
      DATABASE_URL pointing at a superuser, a BYPASSRLS role or a table-owning role cannot boot
      the API; today it boots normally and every policy is decoration. Of the three checks in
      that table this is the one with no other detector.
    required_change: >-
      The row says the check exists and is not yet wired, naming the TASK that wires it, until
      the call site lands.

  - severity: minor
    kind: behavior
    file: apps/api/src/db/client.ts
    line: 152
    summary: Nothing fails if the F-137 checked-out-client error listener is deleted, and TASK-003 is slated to edit those exact lines.
    failure_scenario: >-
      Removing the pool.on('connect', client => client.on('error', ...)) block leaves all 65
      unit and 21 integration tests green: the F-123 idle test kills a connection that is
      already back in the pool, where pg-pool re-attaches its own idleListener on release
      (pg-pool@3.14.0 _release, line 385), so the pool-level handler alone satisfies it — which
      is why both log lines appear for one failure. The guarded path is the opposite state:
      _acquireClient removes idleListener on checkout (line 344) and drizzle's
      NodePgSession.transaction attaches none, so a client killed mid-transaction has zero
      listeners and Node exits the process. The five-second idle_in_transaction bound this round
      added makes that path routine rather than exceptional, and client.ts:54 already announces
      "TASK-003 replaces this with the pino logger" — a refactor of these lines by a TASK that
      has no test telling it the block is load-bearing.
    required_change: >-
      An integration case that kills a backend while it is checked out inside a transaction —
      pg_terminate_backend from a second connection, or the idle bound itself — and asserts the
      call rejects with no uncaughtException. The existing F-123 test already installs the
      uncaughtException capture the assertion needs.

  - severity: minor
    kind: contract
    file: apps/api/src/tenancy/tenant-context.ts
    line: 247
    summary: The afterCommit failure logger reads error.message off any caught error, which tenant-context.md rule 2 — added this round — forbids for database errors.
    failure_scenario: >-
      Rule 2 ("never read message ... off a caught database error. Not to log it") became
      normative in this round's contract edit. The line logs
      `${error.name}: ${error.message}` for whatever the hook threw. afterCommit hooks are
      permitted to open their own transaction — the invariant-6 test does exactly that — so an
      unwrapped pg.DatabaseError reaches this catch, and Postgres embeds offending values in the
      primary message for a whole class of conditions (`invalid input syntax for type uuid:
      "<value>"`, `date/time field value out of range: "<value>"`). That lands in the log store
      unredacted, which is also GC-9's "no PII in log bodies". The line is pre-existing and the
      fix diff did not touch it; the rule it now contradicts is new.
    required_change: >-
      The hook-failure log reports the error name and, for a database error, the SQLSTATE
      through postgresErrorCode — the same allowlist discardedConnection() already uses in
      client.ts.

  - severity: minor
    kind: behavior
    file: apps/api/src/db/client.ts
    line: 81
    summary: connectionTimeoutMillis also caps establishment of a new connection, not only the queue wait the docblock reasons about, so 2000 ms is a hard ceiling on a Neon cold start.
    failure_scenario: >-
      The docblock justifies the number purely as "how long an acquisition waits" and "dead time
      before any work starts". pg-pool applies the same value in newClient (pg-pool@3.14.0
      lines 250-263): when a brand-new client has not finished connecting within it, pg-pool
      destroys the socket and the caller gets "Connection terminated due to connection timeout"
      (line 276). GC-3 pins Neon's free tier, which scales to zero; the first request after an
      idle period pays TCP + TLS + auth + compute wake on a fresh connection, and if that
      exceeds 2 s the request fails rather than waiting. The pool is empty at process start too,
      so the same cap applies to the first request after a deploy. I cannot verify the real
      figure — no Neon endpoint exists yet, and the implementer flagged these numbers as
      measured against nothing.
    required_change: >-
      Either the docblock states that the number also bounds connection establishment against a
      scale-to-zero compute and that it was chosen without measurement, or the establishment
      bound is separated from the queue-wait bound. The number itself is TASK-003's to confirm
      when it wires the real endpoint.

  - severity: nit
    kind: implementation
    file: apps/api/scripts/check-policies.mts
    line: 113
    summary: The exemption lookup goes through Object.prototype, so a table named constructor, toString or valueOf reads as exempt.
    failure_scenario: >-
      EXEMPT is a plain object literal and the test is `EXEMPT[row.table_name] !== undefined`.
      A table named `constructor` resolves to Object's constructor function, so the script prints
      `skip constructor — exempt: function Object() { [native code] }` and passes an unprotected
      table. No such table is planned; the cost of closing it is Object.create(null) or
      Object.hasOwn, and this is the one script whose whole purpose is not silently exempting a
      table.
    required_change: The lookup consults own properties only.

  - severity: nit
    kind: implementation
    file: apps/api/src/db/rls.ts
    line: 147
    summary: The ownership count matches relkind 'r' while check-policies matches ('r','p'), so a partitioned table owned by the runtime role passes the boot check.
    failure_scenario: >-
      check-policies.mts:154-162 deliberately covers both ordinary and partitioned tables,
      arguing that a partitioned parent lacking RLS is the same defect. The boot check written in
      the same round counts only relkind = 'r'. A runtime role owning a partitioned table in
      public is owner-exempt wherever FORCE is absent and the boot check reports zero. No
      partitioned table exists or is planned in launch-core.
    required_change: The two checks use the same relkind set, or the boot check says why it does not.
```

## Cannot verify from diff

- **`db:check-policies` in CI.** The script and its `package.json` entry are here; wiring it
  into the integration job is TASK-002's (F-122's ruling). Nothing in this diff shows the gate
  actually runs anywhere.
- **F-119 / the release command.** `docs/architecture/migrations.md` "At deploy" states as fact
  that the Fly release command runs `db:migrate`. `drizzle-kit` is a devDependency and F-119 is
  open on whether it exists in the production image. The document may be describing something
  that cannot run; TASK-003 settles it.
- **Production role provisioning.** `rls.md`'s two-role table and the compose header both
  describe roles that no TASK creates on the deployed database (F-116/F-131). Unowned, as both
  documents say.
- **The three capacity numbers** (`max: 10`, `connectionTimeoutMillis: 2000`, the 5 s idle
  bound) against GC-1's p99 ceiling and GC-3's Neon free tier. No measurement exists and no
  endpoint exists to measure. Finding 9 is the one of the three I can state a concrete
  mechanism for.
- **TASK-056's A1–A4 greps and the four-consumer set equality** once `redirect-read.ts` and
  `privileged-eraser.ts` land. I re-ran A1–A4 against the tree today and all hold (`rls.ts`
  contains zero `set_config(` matches; `app.tenant_id` is set in exactly one file and mentioned
  in exactly two; all six `set_config(` first arguments are quoted literals matching the widened
  A4 regex). Future-tree behaviour is not decidable here.

## Notes

**The `finally` window that sets `settled` — the implementer's first question.** I could not
construct a cross-tenant reach through it either, and I think the reason is stronger than "I
could not find one". `context.settled = true` runs as a microtask chained off the resolution of
drizzle's transaction promise, and Node drains the entire microtask queue before any macrotask.
Every detached continuation that resumes on I/O — a timer, a socket, a `fetch` — resumes in a
macrotask, so it cannot land between drizzle's `client.release()` and the assignment. The only
interleaving left is a continuation whose promise already resolved *during* COMMIT; that one
queues its statement on our own client while the transaction is still ours, so it executes after
COMMIT on that same connection with `app.tenant_id` already gone (transaction-local), and RLS
returns zero rows and refuses every write. Fail-closed, not cross-tenant. The guard is sound as
written; what would reopen it is anything that moves `settled` off the synchronous continuation
of the awaited promise.

**`TenantContextMissingError` gaining an optional message — the implementer's second
question.** Not a contract widening. `export class TenantContextMissingError extends Error {}`
inherits `Error`'s constructor signature, so `new TenantContextMissingError('reason')` already
typechecks against the declared shape. The implementation is in fact marginally *narrower*,
since it drops the second `ErrorOptions` parameter — nobody passes it, and `cause` on this error
would be a rule-2 hazard anyway. A distinct class would be worse: the tests, the contract's
invariant 4 and every consumer catch on one class, and a settled context genuinely is a missing
one. Keep it.

**F-130 and F-137 both shipped without a test.** `assertUuid`'s lowercasing is exported and
trivially unit-testable, and reverting it fails nothing; I did not file it because the failure it
prevents needs a non-lower-case uuid that no sanctioned source produces. F-137 I did file
(finding 5), because what it prevents is process death and the lines are already earmarked for a
TASK-003 edit.

**`db:check-policies` design decisions the implementer asked about.** Both are right. Connecting
as `DATABASE_URL` is correct — `pg_class` is world-readable, and a check run as the migrator
would prove nothing about the DSN the API uses. Failing on an empty `public` is correct for
exactly the reason stated: vacuous truth is the failure shape the script exists to catch.
`__drizzle_migrations` lives in schema `drizzle`, not `public`, so it neither trips the loop nor
rescues the empty-schema case. The four Better Auth names ahead of their tables are fine: each
carries an ADR citation, which is the property that keeps an exception list from becoming a
dumping ground.

**F-118's byte-identical claim holds.** `'app.tenant_id'` written inline produces the same two
policy strings the `${TENANT_ID_SETTING}` interpolation did; I compared them character by
character in the diff. The frozen fixture builds from the same function, so the AC suites are a
real check on this and not a coincidence.

**`drizzle-kit migrate` really does compare timestamps.** I checked independently because
`migrations.md` leans on it: `drizzle-kit@0.31.10/bin.cjs` imports
`drizzle-orm/node-postgres/migrator` for the `pg` driver, which reaches
`drizzle-orm@0.45.2/pg-core/dialect.js:57-67` — `order by created_at desc limit 1`, then
`Number(lastDbMigration.created_at) < migration.folderMillis`; the stored hash is written and
never read back. `.gitattributes` matches the rebase procedure the document gives.

**Ownership observation, for you rather than for anyone to fix.** The test commit added
`apps/api/src/db/client.spec.ts` and `apps/api/src/tenancy/tenant-context.spec.ts`. Neither is in
TASK-005's `paths` (F-074 ruled the narrow file glob `apps/api/src/tenancy/tenant-context.ts`,
not the directory, and named TASK-011 as the other holder of that directory) nor in its
`test_files`. Nothing is wrong with the tests; the cards do not describe where they live.

**GC checks that came out clean.** GC-4: neither commit carries AI attribution. GC-5: the only
`set_config` of a context flag in `apps/api/src` remains the one in `withTenantTransaction`, flag
name inline and value bound; `rls.ts` sets nothing. GC-9: `discardedConnection` logs name and
SQLSTATE only — finding 6 is the single log line that does not meet that bar, and it predates the
rule. GC-13: README untouched, F-136 already logs the missing link.
