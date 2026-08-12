# TASK-005 Product Audit r2 — fix round 1 (scoped re-review)

> Persisted verbatim by the orchestrator from the agent's return value.
> `sdlc-product-auditor` has no write tool in its session and its operating rules
> forbid producing report `.md` files, so it returned the report as its return value
> and asked for it to be written here. Same handling as its r1 report.

Review package: `.superpowers/sdd/plan/review-cdb07e4..9eb654a.diff` (2 commits, read as
given, not re-derived). It did not re-run `pnpm test`, `test:integration`, `lint`,
`typecheck` or `build` — it relied on the orchestrator's stated 65/65 and 21/21.
Everything else below it checked against the tree.

## Overall verdict: **APPROVED** (`clear`)

Five minor findings, no blocker, no major. All four ACs remain MET, and it verified the
two things that could have broken them silently.

## F-128 — **ADDRESSED**

Nine distinct new tests, all of them assertions of the thing the finding named, and the
"green on arrival" claim independently confirmed rather than accepted.

| Invariant / case | Test | Where |
|---|---|---|
| 4 (`tenantDb()` outside a context) | `invariant 4: tenantDb() throws TenantContextMissingError rather than returning a client` | `apps/api/src/tenancy/tenant-context.spec.ts:23` |
| 4 (`currentTenantId()`) | `invariant 4: currentTenantId() throws ...` | same file:27 |
| AC-9 re-parenting | `AC-9: re-parenting tenant A's own row to tenant B is refused ...` | `apps/api/test/tenancy/tenant-context.int-spec.ts:177` |
| 5 (reuse) | `invariant 5: a nested frame runs inside the outer transaction and sees its uncommitted writes` | int-spec:423 |
| 5 (no savepoint) | `invariant 5: statements a nested frame issued commit with the outer ...` | int-spec:438 |
| 5 (mismatch) | `invariant 5: nesting a different tenant id throws TenantContextMismatchError` | int-spec:460 |
| 6 (once, after COMMIT) | `invariant 6: afterCommit runs exactly once, and the transaction is committed by then` | int-spec:525 |
| 6 (not after rollback) | `invariant 6: afterCommit does not run when fn throws` | int-spec:550 |
| 6 (throw is contained) | `invariant 6: a throw inside afterCommit does not reach the caller or the committed work` | int-spec:578 |

Green-on-arrival, verified by construction rather than taken on report:
`git show cdb07e4:apps/api/src/tenancy/tenant-context.ts` already had `activeContext()`
throwing `TenantContextMissingError` on an absent store (invariant 4), the same-tenant
reuse branch with `return fn(active.db)` and no savepoint, the mismatch throw *before*
`fn` runs, and the post-`databaseTransaction` hook loop with its `try/catch` +
`logger.error` (invariant 6). The `WITH CHECK` half of `tenantScopedPolicies` predates
this diff, so the AC-9 re-parenting case was green too. None of these nine could have
been red at `2ffa011`, and the test commit touched test files only
(`git show --stat 2ffa011`: 3 files, all specs).

Do the tests assert the invariant or something adjacent? Checked against
`design/contracts/tenant-context.md:275-293` verbatim. Two are notably strong rather than
adjacent: invariant 6's "after COMMIT" is proved by a *separate* transaction on a
*separate* connection seeing the row from inside the hook, not by ordering a boolean;
invariant 5's no-savepoint case asserts the nested frame's INSERT survives a nested throw
the outer swallows, which is precisely the assertion F-125's repair could have broken and
did not.

One bookkeeping correction to the claim relayed to it: **nine tests, not ten.**
`TASK-005-fix-r1-tests-report.md:231` counts F-128 as 10 by also attributing "the two
F-125 tests"; there is one F-125-labelled test (int-spec:475, red on arrival, not
F-128's) and the no-savepoint green test, already counted under invariant 5. The report's
own table (lines 25-37) lists exactly nine F-128 rows. The tenth green row in that table
is `F-129: the boot check accepts the runtime role, which owns nothing` — F-129's, not
F-128's. No test is missing; the arithmetic double-counts.

## AC verification

```yaml
ac_verification:
  - id: AC-8
    status: met
    evidence: apps/api/test/tenancy/tenant-context.int-spec.ts:140::"AC-8: a read inside tenant A's transaction returns A's row and not B's"
    note: >-
      Test body byte-identical to round 1 (verified by extracting both revisions and
      comparing). Still an unfiltered SELECT through production withTenantTransaction,
      isolated by the USING clause of production tenantScopedPolicies().
  - id: AC-9
    status: met
    evidence: >-
      int-spec:146 (insert refused, 42501), int-spec:162 (update affects zero rows),
      int-spec:177 (re-parenting A's own row to B refused, 42501 + both tenants re-read)
    note: >-
      The round-1 coverage gap it raised is closed. The re-parenting case is the only one
      that isolates WITH CHECK on the UPDATE path: USING admits the row, so a policy
      written with USING alone passes every other test in the file and fails this one.
  - id: AC-10
    status: met
    evidence: int-spec:200::"AC-10: a read issued outside any tenant-context transaction returns zero rows"
    note: >-
      Still issued through raw psql (test/support/psql.ts), never through
      withTenantTransaction. The mechanism it rests on is unchanged - see "The
      byte-identity claim" below, which it checked by execution rather than by reading.
  - id: AC-11
    status: met
    evidence: int-spec:219 (rollback proved by row absence) and int-spec:238 (no context leak on the next transaction)
    note: >-
      Both bodies byte-identical to round 1. The pool changes do not disturb the
      verification method: POOL_MAX = 10 is pg's own default, so nothing about
      sequential reuse changed, and pg-pool@3.14.0 acquires with `this._idle.pop()`
      (pg-pool/index.js:158) - LIFO, so sequential use returns the connection just
      released. connectionTimeoutMillis affects acquisition failure, not connection
      identity. The assumption remains implicit and unasserted; see finding 5.
```

The premise that made round 1 meaningful still holds:
`apps/api/test/support/rls-fixture.ts:34` is untouched and still imports
`TENANT_ID_COLUMN_SQL` and `tenantScopedPolicies` from production `../../src/db/rls`, and
`createRlsFixture()` still applies the fixture table's policies by calling that function.
The tests exercise Postgres enforcing shipped policy, not fixture SQL.

### The byte-identity claim (F-118 / `TENANT_ID_SETTING` deletion)

Checked by executing both revisions, not by reading. It extracted `tenantScopedPolicies`,
`redirectReadPolicy` and `TENANT_ID_COLUMN_SQL` from `cdb07e4:apps/api/src/db/rls.ts` and
`9eb654a:apps/api/src/db/rls.ts`, ran both, and diffed the emitted SQL: **786 bytes each,
`cmp`-identical.** AC-10's denial rests on `current_setting('app.tenant_id', true)`
returning NULL when unset inside the policy DDL, and that DDL is unchanged to the byte.
AC-10 is not at risk.

The claim is very slightly overstated in one place that does not matter: the **setter's**
SQL did change shape. It was `select set_config($1, $2, true)` (flag name bound as a
parameter) and is now `select set_config('app.tenant_id', $1, true)` (name inline, value
bound). Semantically identical for `set_config(text, text, boolean)`, and it is what
`isolation-coverage.md:171` ("a flag name gets no named constant") requires, so it is
ruled rather than invented — but "byte-identical" is true of the policy templates and not
of the `set_config` call. Worth one sentence in the record so the next reader is not
surprised.

## Findings

```yaml
findings:
  - severity: minor
    kind: behavior
    file: apps/api/scripts/check-policies.mts
    line: 113
    summary: >-
      EXEMPT is a plain object literal, so `EXEMPT[row.table_name]` resolves through
      Object.prototype. A table named constructor, toString, valueOf, hasOwnProperty or
      __proto__ is reported as exempt and skipped without ever being checked.
    failure_scenario: >-
      Demonstrated, not predicted - it ran the lookup: 'constructor' returns
      "function Object() { [native code] }", which is !== undefined, so the script prints
      `skip constructor - exempt: function Object()...` and continues. All five names are
      legal lowercase Postgres identifiers and pass SAFE_TABLE_NAME. This is the one
      script whose entire purpose is to prevent a silently unprotected table from passing
      a green gate, and its own comment says an exception list is the obvious place to
      hide that failure. Low likelihood, exact shape of the defect the script exists to
      catch.
    required_change: >-
      Look the exemption up with Object.hasOwn(EXEMPT, row.table_name), or build EXEMPT
      with Object.create(null) or a Map. If the script ever gains a test, one case with a
      prototype-named table.

  - severity: minor
    kind: scope
    file: apps/api/scripts/check-policies.mts
    line: 42
    summary: >-
      EXEMPT is pre-populated with four Better Auth tables - user, session, account,
      verification - none of which exist in the repository, in a TASK whose stated
      out-of-scope list names auth.
    failure_scenario: >-
      F-122's ruling asked for "an explicit exception list", not for entries in it. The
      exemption is granted before the schema that would justify it exists, and before
      anyone has read that schema. If the auth tables land carrying a tenant_id, or land
      under different names with a prefix, or if ADR-0015's workspace scoping changes what
      is tenant-scoped, the check passes them silently and the reviewer of that TASK sees
      no diff because the carve-out was written three waves earlier.
    required_change: >-
      Juano's call, not the implementer's: keep the four entries as a recorded decision, or
      ship the list empty so the first exemption arrives as a reviewed one-line diff in the
      TASK that creates the table. Either way the script is correct today - schema public
      holds only `tenants`.

  - severity: minor
    kind: docs
    file: docs/architecture/rls.md
    line: 160
    summary: >-
      The "What checks what" table states that assertRuntimeRoleCannotBypassRls() runs at
      "boot, before traffic". It has no call site anywhere in the application.
    failure_scenario: >-
      Verified: grep over apps/api/src finds the function defined in src/db/rls.ts and
      called only from the integration spec; apps/api/src/main.ts's bootstrap does not call
      it. F-116 is open for exactly that missing call site (TASK-003). A reader of the
      repository's own architecture document concludes that a deployed API refuses a
      DATABASE_URL whose role holds BYPASSRLS or owns tables, and it does not. Two smaller
      instances in the same file: line 161 says db:check-policies runs "in CI's integration
      job" (TASK-002, not built), and the flag table at line 83 names
      src/redirect/db/redirect-read.ts and src/gdpr/privileged-eraser.ts, neither of which
      exists.
    required_change: >-
      Mark the not-yet-wired rows as intended state with the owning TASK id, the way the
      same document already does for tenantScopedTables()/TASK-053. The boot-check row is
      the one that matters; it is a safety control the document asserts is running.

  - severity: minor
    kind: docs
    file: docs/architecture/migrations.md
    line: 102
    summary: >-
      The "At deploy" section describes the Fly release command running db:migrate as an
      existing procedure. No fly.toml, Dockerfile or release command exists, and F-119
      records that db:migrate runs drizzle-kit, a devDependency, which is not installed in
      a production image.
    failure_scenario: >-
      Someone follows the document, or cites it as settled, and the procedure it describes
      is both unbuilt and known to be in dispute - F-119 is open precisely because TASK-003
      has not yet decided how drizzle-kit reaches the deployed image. A document that
      states an unresolved question as fact is how the answer stops being asked.
    required_change: >-
      Mark the section as ADR-0004's intended state owned by TASK-003 and cross-reference
      F-119, or drop it until TASK-003 settles it. Neither the F-117 ruling nor STORY-003's
      DoD asked for a deploy section.

  - severity: minor
    kind: test-coverage
    file: apps/api/test/tenancy/tenant-context.int-spec.ts
    line: 238
    summary: >-
      AC-11's no-leak test still depends on pg-pool's LIFO idle reuse returning the same
      connection, and asserts nothing about connection identity. Restated from round 1
      because this diff changed the pool.
    failure_scenario: >-
      The dependency is currently satisfied - pg-pool@3.14.0 acquires with _idle.pop() and
      POOL_MAX = 10 is pg's own default, so sequential use is unchanged - but the test
      cannot tell "the same connection carried no residue" from "a different connection was
      handed out". If a later change pins, rotates or resets connections, this test goes on
      passing while proving nothing, and AC-11's stated verification method quietly stops
      being exercised. The same file now creates up to ten connections in its pool suite,
      so the pool is no longer trivially single-connection.
    required_change: >-
      Select pg_backend_pid() inside both transactions and assert equality, so the test
      fails loudly if the premise stops holding rather than passing vacuously. Not a code
      defect and not blocking; apps/api/test/** is sdlc-test-architect's.
```

## The three ruled-in deliverables

**`pnpm db:check-policies` — matches F-122's ruling.** The required change was, verbatim,
"assert from pg_class that every table in schema public has relrowsecurity AND
relforcerowsecurity true, with an explicit exception list". `check-policies.mts:56`
queries exactly that, over `relkind in ('r','p')` in `public`, and `apps/api/package.json`
gained the script entry. It correctly stops short of the `pg_policies` shape assertion
that needs `tenantScopedTables()` (TASK-053), and says so at length in its header. CI
wiring is correctly left to TASK-002. Two additions beyond the ruling, both listed below.
It runs under `node scripts/check-policies.mts`, which needs type stripping — the root
`package.json` pins `engines.node >= 24.13.0`, so that is safe. It is outside
`apps/api/tsconfig.json`'s `include` (confirmed) and therefore typechecked by nothing,
which is F-135, already escalated with no owner; it is not re-filing it, but notes that
this script currently has **no gate coverage at all** — not typechecked, no test, not run
by any job yet.

**`docs/architecture/rls.md` and `docs/architecture/migrations.md` — the ruling's two
named caveats are both there, correctly.** "The migrator compares timestamps, not
contents" (`migrations.md:76`) states the silent no-op on an already-applied migration and
gives the `down -v` reset; "Running the integration suite wipes the migrated tables"
(`migrations.md:88`) states that `db:migrate` does not repair it. Those are the two the
panel surfaced and the ruling said had no other home, and they are the strongest part of
the two documents. `rls.md` is accurate on the mechanisms it describes — it checked its
policy block against the emitted SQL and its `current_setting(name, true)` explanation
against AC-10's actual mechanism. Its inaccuracies are all of one kind: intended state
written in the present tense (findings 3 and 4). The "Rebasing a branch that added a
migration" section checks out — `.gitattributes` really does mark
`apps/api/drizzle/meta/**` and `apps/api/drizzle/*.sql` as `-merge`.

**`drizzle.config.ts` — ratified, and the diff only adds a comment.** Eight lines
recording F-133 (the file is outside `tsconfig.json`'s `include`, so `pnpm typecheck`
never reads it). That is option (b) of F-133's required change verbatim. No behavior
change. Consistent with "records reality rather than assigning new work".

## The three capacity numbers

All three were asked for. F-123's required change reads "Set an explicit `max` and a
finite `connectionTimeoutMillis`, justified against the Neon pooled endpoint ADR-0002
targets", and the same finding names the `idle_in_transaction_session_timeout` statement.
So none is unrequested. Verdicted individually:

- **`POOL_MAX = 10`** (`client.ts:69`) — this is `pg`'s own default, written out with a
  reason. The lowest-risk possible choice: it changes nothing that was running before and
  makes the number reviewable. Justified by argument (per-instance concurrency × Fly
  machines against the pooler's backend cap), not by measurement.
- **`CONNECTION_TIMEOUT_MS = 2000`** (`client.ts:81`) — bounded and deliberately under the
  5 s `statement_timeout`. Exercised in spirit by int-spec:663 (40 concurrent, none still
  waiting after the window) but not pinned to 2000; the test architect states that choice
  explicitly and it agrees — pinning the constant would test the constant, not the
  property.
- **`IDLE_IN_TRANSACTION_TIMEOUT_MS = 5000`** (`tenant-context.ts:150`) — the only one of
  the three with a live production edge. It terminates the connection, not the statement,
  so a legitimate transaction whose internal gap exceeds 5 s fails with a connection error
  carrying no SQLSTATE to branch on. That is the intended mechanism (ADR-0002's ban on
  third-party I/O inside `fn`, made enforceable) and no launch-core caller needs a longer
  gap, but it is the number it would want re-examined against a real endpoint before the
  first slow multi-step flow ships.

None of the three has been measured against a Neon endpoint. It does not think that blocks
TASK-005 — F-123 asked for explicitness and a bounded failure, and both are delivered —
but "justified against the Neon pooled endpoint" has been satisfied by reasoning, and the
record should say so rather than imply a measurement happened.

## Shipped but not asked for

It mapped every hunk in the diff to a finding or ruling. Unlike round 1, **almost nothing
here is unrequested**:

| Change | Basis |
|---|---|
| `postgresErrorCode` / `postgresErrorConstraint`, `driverError()`, corrected unwrap comment | F-120 + `tenant-context.md` "What the implementer must guarantee" (names both accessors) |
| `pool.on('error')`, `max`, `connectionTimeoutMillis` | F-123 |
| `pool.on('connect', c => c.on('error'))` and the shared `discardedConnection()` | F-137 |
| `idle_in_transaction_session_timeout` statement | F-123 |
| `settled` flag, `finally`, guard in `activeContext()` and in the nesting branch | F-121 (which specifies this design exactly) |
| nested `afterCommit` enqueued after `fn` resolves | F-125 |
| `assertUuid` returning lower case | F-130 |
| `InvalidTenantIdError` truncation | F-132 |
| `TENANT_ID_SETTING` deleted, flag names inline | `isolation-coverage.md:171`, A3/A4 — the architect's ruling, not the implementer's invention |
| `tables_owned_in_public` in the boot check | F-129 |
| `fileParallelism: false` | F-134 |
| healthcheck executing a statement as `shortkit_app` over TCP | F-127 |
| compose header, test-only warning | F-131 |
| `drizzle.config.ts` comment | F-133 |
| the two documents, the script, the `package.json` entry | F-117 / F-122 rulings |

Genuinely unrequested, three items, all small:

1. **The four pre-populated `EXEMPT` entries** (finding 2). The ruling asked for a list;
   this fills it with names for tables that do not exist, in a TASK whose out-of-scope
   line says "auth".
2. **`check-policies.mts` failing on an empty schema** (`:79`). Beyond the assertion F-122
   specified. It endorses it — "every table has RLS" over zero tables is exactly the
   vacuous green the script exists to prevent — but it is an addition, and it is why
   running the script straight after `pnpm test:integration` fails (documented in the impl
   report and in `migrations.md`).
3. **`TenantContextMissingError` gaining an optional `reason` constructor argument** plus
   the `CONTEXT_HAS_SETTLED` message. F-121 said "throw when it is set" and named no
   class. Widening a public error's constructor is a small API decision made in passing;
   the test architect flagged the class choice and offered to change it. It reads
   correctly — a settled context is not an active one, and the distinct message is what
   stops the next developer concluding the guard is broken — but it was nobody's explicit
   call.

The `migrations.md` "At deploy" and "Rebasing" sections are also beyond what the ruling
asked for; "Rebasing" is genuinely useful and accurate, "At deploy" is finding 4.

## Out-of-scope items that got built

TASK-005's "Out of scope" line: *any domain table other than `tenants`, auth, seeding, the
isolation suite itself (TASK-006)*.

- **No domain table, no seeding, no isolation suite** — clean. The fixture table
  `rls_fixture_rows` is the test architect's and predates this round.
- **Auth**: one brush, item 1 above. Four Better Auth table names appear in
  `check-policies.mts`'s exemption list. No auth code, no auth schema, no auth behavior —
  a name-level carve-out only. Flagged as minor scope rather than a violation, because
  F-122's ruling did ask for an exception list and the reasons given cite ADR-0003 and
  ADR-0015 rather than shrugging.

## STORY-003 Definition of Done — "Docs updated (README / API / ADR consequences)"

**Partly satisfied, and the unsatisfied half is not TASK-005's to finish.**

- *ADR consequences* — **satisfied.** ADR-0002's context binding, ADR-0003's roles and
  policy template, and ADR-0004's migration procedure now each have a working-version
  document, and the two procedure caveats that justified writing them now are both present
  and correct. This is the substantive half of the line and it is delivered.
- *README* — **not satisfied.** `README.md` contains no reference to `docs/architecture/`
  (verified), so both documents are reachable only by knowing they exist. This is F-136,
  logged with `owner_slot: null` and "carry to Ship-phase triage". `README.md` is
  TASK-001's under GC-13 and is outside TASK-005's paths, so the implementer could not
  have closed it. It should be closed before STORY-003's DoD is ticked, not before
  TASK-005 is.
- *API* — not applicable to this TASK; no HTTP surface here.

The orchestrator's correction to F-117's GC-13 basis is applied and reads correctly now:
GC-13 is `docs.required: [README]` with TASK-001 as sole producer, and the two
architecture documents rest on this DoD line plus the ADR-0003/ADR-0004 prose follow-ups.
The TASK-005 card (`tasks/TASK-005.md:47-49`) states it the same way. No remaining
inconsistency.

Note for the Ship-phase pass, not for this TASK: STORY-003's DoD also requires "All ACs
green as automated tests", and AC-12 belongs to TASK-006, which has not run. The story is
not done; TASK-005 is.

## Files worth having open

- `apps/api/scripts/check-policies.mts` (findings 1, 2)
- `docs/architecture/rls.md` (finding 3)
- `docs/architecture/migrations.md` (finding 4)
- `apps/api/test/tenancy/tenant-context.int-spec.ts` (finding 5, and all four ACs)
- `apps/api/src/tenancy/tenant-context.spec.ts` (F-128, invariant 4)
- `apps/api/src/db/rls.ts` and `apps/api/src/db/client.ts`

No `owner_slot` assigned on anything above — routing is the orchestrator's.
