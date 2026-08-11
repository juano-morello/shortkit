# Contract: isolation surface discovery and the coverage report

- **Boundary:** the SC-1 suite's discovery mechanism, and the report it produces.
- **Normative form:** `apps/api/test/isolation/coverage.ts`. The design stub at `design/stubs/apps/api/test/isolation/coverage.ts` is derived, stale, and not a normative form; it survives only because TASK-006 is still writing the file, and it is deleted when TASK-006 reaches `done` (ADR-0039). See "Which copy of this is normative" below.
- **Produced by:** TASK-006 (harness), TASK-056 (discovery, assertions, report).
- **Consumed by:** every TASK adding a repository or an authenticated route.
- **ADRs:** ADR-0020, ADR-0003, ADR-0019.

> **Amended 2026-08-11 (F-327), carrying F-328, F-333 and F-341 with it. Seven statements in
> this contract were wrong and are corrected here rather than reinterpreted; nine report
> fields and one widened type are declared for the first time.** The contract was frozen at
> the design gate on 2026-08-04 and described the harness as it was then imagined. Three
> audit rounds on TASK-006 produced three blockers, every one of the form *the harness
> reports green while isolation is broken*; each was fixed and measured, and this file went
> on describing the harness that leaked. **Every corrected sentence is struck through in
> place rather than deleted**, because a reader who remembers the old rule has to be able to
> see that it was the old rule.
>
> **Four were disproved by measurement against the shipped harness:**
>
> 1. **"Attempt semantics", the write row.** ~~"rejected or zero rows affected"~~ is exactly
>    the rule F-302 proved insufficient. PostgreSQL applies the SELECT policies to any UPDATE
>    or DELETE that references a column, so an owner-qualified write is routed through the
>    SELECT policy and reports zero rows however wide open the UPDATE or DELETE policy is. An
>    unqualified write is a different attack and is attempted, and judged, separately.
> 2. **"Attempt semantics", the read row.** ~~"zero rows returned, or a throw"~~ is the rule
>    F-294 disproved. Row-level security denies a read by returning zero rows and never by
>    raising, so a read that threw did not run, and it now scores `unverified`.
> 3. **Invariant 3**, which restated statement 1 in the section a caller is told to rely on,
>    which is the worse of the two places to be wrong.
> 4. **The AC-95 post-run-check paragraph**, which restated it a third time and also
>    described a check the harness has since deliberately weakened (F-328).
>
> **Three claimed a mechanism that does not exist, or is weaker than stated:**
>
> 5. **Invariant 4**, "the suite reads the real module graph". True of TASK-056's harness and
>    not of this wave's, where the subjects are a registry.
> 6. **"`pnpm db:check-policies` is the same assertion"** as the `pg_policies` shape check.
>    It is not; it is the weaker form that runs today, and it is **half of a composite gate**
>    whose other half is the registry drift check (F-122, F-333).
> 7. **"uploaded as a CI artifact"**, of `report.json`. No upload step exists (F-297).
>
> **Declared for the first time:** `verdict` widens from `'pass' | 'fail'` to
> `'pass' | 'fail' | 'incomplete'`, and `IsolationReport` gains nine fields the code writes
> and this file did not declare — `attempts`, `failed`, `unverified`, `registryDrift`,
> `coverageBoundary`, `incompleteBecause`, `attemptVerdict`, `suiteOutcome`,
> `declinedShapes`. New sections describe the registry and its five-arm database cross-check
> **with the residual that escapes all five**, the three-write report discipline, how a later
> TASK registers a table, and the five statement shapes that are known-uncovered (F-341).
> `TenantFixtures` carries two fields today rather than six, which was ruled on 2026-08-06
> and had never reached this file.
>
> A refusal on an unqualified write is now `unverified`, never `pass` — F-330, and the third
> blocker. Everything else in this file stands as written.

## Which copy of this is normative

Added 2026-08-11 (F-327, F-288). Three artifacts describe the same mechanism and they have
drifted from each other three times, so the ordering is stated rather than assumed:

| Artifact | Standing |
|---|---|
| `apps/api/test/isolation/coverage.ts` and the three files beside it | **The behaviour.** What the harness does is what these do. Where this contract and the code disagree, the code is the fact and the contract is the defect — that is what F-327 was |
| **this file** | **Normative for what the harness must do**, and the artifact a reimplementer rebuilds from. A change in the code that this file does not describe is a divergence to file, not a silent update |
| `design/stubs/apps/api/test/isolation/coverage.ts` | **Derived, and stale.** Materialised at the design gate on 2026-08-04 and not maintained since. As of 2026-08-11 it still declares `verdict: 'pass' \| 'fail'`, the six-field `TenantFixture`, and an `IsolationReport` missing all nine fields added below |
| ADR-0020, ADR-0019, ADR-0003 | **The decisions**, not the mechanism. They may state a rule once and point here; a rule stated twice is two things that can drift |

**Nothing gates any of that.** No test, lint rule or CI step compares the stub, this
contract and the shipped file, so every one of the three divergences above was found by a
human reading two artifacts side by side, one audit round after it appeared. That absence is
F-288's shape, and this is its third instance on a third artifact. Until a gate exists, the
rule is procedural: **a change to `coverage.ts`'s exported shapes amends this file in the
same commit**.

**The stub's half of that was settled on 2026-08-11 by ADR-0039, and it was settled by
deletion.** A design stub is retired when the TASK that materialised its file reaches `done`.
TASK-006 is in fix round 4, so this stub is one of two survivors of that day's sweep, and it
survives on the narrow ground that TASK-006 is still writing the file it mirrors. It is not
regenerated, it is not synced, and nothing above should be read as asking anyone to. When
TASK-006 closes, the stub is deleted and the row for it in the table above goes in the same
commit.

## What this contract claims that is not yet true

Added 2026-08-11 (F-327). Three of the corrected statements were not stale rules but claims
about mechanisms **that do not exist**. Striking such a sentence tells the next reader what
was wrong and not what is owed, so the ledger is here and each strike below points at it.

| Claim as written | Status today | What would make it true | Owner |
|---|---|---|---|
| "The suite reads the real module graph, so it cannot drift from what the server serves" (invariant 4) | **False in this wave.** No `AppModule` route carries tenant data, no class carries `@TenantScopedRepository()`, and the decorator itself throws `not implemented` | TASK-011 lands the decorator; TASK-056 lands the three discovery mechanisms in "Discovery". Until both, the substitute is the registry plus the five-arm drift check plus `db:check-policies`, and it is a substitute, not the thing | TASK-011, TASK-056 |
| "`pnpm db:check-policies` is the same assertion" as the `pg_policies` shape check | **False.** `assertOnlyApprovedPolicies()` throws `not implemented`; the shape assertion is unbuilt. `db:check-policies` asserts `relrowsecurity` and `relforcerowsecurity` against an exception list and by its own header does **not** assert the policy set | TASK-056 implements `assertOnlyApprovedPolicies()` with expected `qual` strings captured from a live database after migration, which needs `tenantScopedTables()` (ADR-0019, TASK-053). Until then no test matches a policy against an approved shape by name and `qual` text | TASK-053, TASK-056 |
| "`apps/api/test/isolation/report.json`, uploaded as a CI artifact" | **False.** `.gitignore` ignores the path and `ci.yml` has no `upload-artifact` step. The artifact exists only in the workspace of whichever job ran the suite | **F-297, open.** The upload must exist **and** fail the job when the artifact's `runAt` predates the job — that second half is the only side the collection-error residual can be closed from | F-297 |

**On the last one, the sequencing is worth stating.** F-304's argument was that the artifact
must become trustworthy *before* the upload lands, or CI starts publishing a stale pass as
evidence. That argument was written against an upload that did not exist and still does not.
The order held anyway: the three-write discipline shipped first. What is left is to build the
upload with the freshness check, not to retrofit trust into an upload already running.

## Surface identity

```ts
export type SurfaceId =
  | `route:${'GET'|'POST'|'PATCH'|'PUT'|'DELETE'} ${string}`   // 'route:GET /api/links/:id'
  | `repo:${string}.${string}`;                                 // 'repo:LinkRepository.findById'

export interface DiscoveredSurface {
  readonly id: SurfaceId;
  readonly kind: 'route' | 'repository-method';
  readonly authenticated: boolean;
  readonly publicJustification?: string;   // present iff !authenticated
  /** Present iff the route carries @NoTenantTransaction(). Added 2026-08-11 (F-327). */
  readonly noTenantTransactionJustification?: string;
  /**
   * True when a @Public() route reaches a tenant-scoped table through a capability-token
   * entry point (ADR-0021). A @Public() route that touches one WITHOUT this fails the
   * suite. TASK-056 populates it; no route exists to carry it yet.
   * Added 2026-08-11 (F-327).
   */
  readonly usesCapabilityToken?: boolean;
}
```

The last two fields were in `design/stubs/apps/api/test/isolation/coverage.ts` and in the
shipped `apps/api/test/isolation/coverage.ts` from the first commit, and only this file
omitted them. `noTenantTransactionRoutes` in the report below is built from the first one.

## Discovery

Three independent mechanisms. Defeating coverage requires defeating all three.

**1. Routes, via `DiscoveryService` + `MetadataScanner`.** The suite boots the
production `AppModule` in a testing context and walks every controller, reading
`PATH_METADATA` and `METHOD_METADATA` per handler plus the controller path and the
global prefix (ADR-0006). A route is authenticated unless its handler or controller
carries `@Public(justification)`. Public routes are reported with their justification,
not silently skipped.

**2. Repositories, via `@TenantScopedRepository()` + `DiscoveryService`.** Public
methods are enumerated with `MetadataScanner.getAllMethodNames(prototype)`. A new
method on an existing repository is discovered with no edit.

**3. The backstop for a forgotten decorator.**

```ts
// fails and names the class
const undecorated = providers
  .filter((p) => /Repository$|Repo$/.test(p.name))
  .filter((p) => !Reflect.getMetadata(TENANT_SCOPED_REPOSITORY, p.metatype));
expect(undecorated).toEqual([]);
```

plus: every table from `tenantScopedTables()` must be reachable through at least one
registered repository, so a table with no repository fails too.

## The registry, and what bounds the covered set before TASK-056 exists

Added 2026-08-11 (F-327, F-333). All three mechanisms above are TASK-056's, and none of
them runs today: no `AppModule` route carries tenant data, no class carries
`@TenantScopedRepository()`, and the decorator itself still throws `not implemented`
(TASK-011). **The set of subjects in this wave is a registry**, so `uncovered` is
structurally `[]` and cannot fail on its own. An earlier version of the harness header
claimed enumeration where there was a list, and the first audit round measured the
consequence: a tenant-scoped table nobody registered leaked every row to every tenant, with
both gates green and its name in no artifact.

**What keeps the list honest is a second enumeration, read from the database.**
`tenantScopedTableDrift()` asks which relations in schema `public` carry a tenant boundary
and requires that set to equal the registry's. A table in one and not the other fails the
run and names it, in both directions. This is ADR-0019's cross-check, SQL half, pulled
forward — it needs no `tenantScopedTables()` artifact, and TASK-053 and TASK-056 are both
deferred.

### Five arms, and defeating the check means defeating all five

A relation in schema `public` with `relkind` in `('r','p')` must be registered if **any**
of these holds:

| # | Property | Why it is here |
|---|---|---|
| 1 | `relname = 'tenants'` | the cascade root, tenant-scoped and carrying no tenant column at all, named exactly as ADR-0019's exclusion list names it |
| 2 | a column named `tenant_id` | the only arm that sees a table with **no** row-level security whatsoever, which is the shape `scripts/check-policies.mts` exists for |
| 3 | `relrowsecurity AND relforcerowsecurity` | column-name agnostic. Catches the measured `audit_events(owning_tenant)` case |
| 4 | a policy whose `qual` or `with_check` contains `app.tenant_id` | catches a table protected by a tenant policy that arm 3 misses because `FORCE` was forgotten |
| 5 | a foreign key to `tenants(id)` | **F-333.** Independent of protection *and* of the column's name. `TENANT_ID_COLUMN_SQL` declares `REFERENCES tenants(id) ON DELETE CASCADE`, ADR-0019 requires it of every schema TASK, and AC-90's residue check depends on it |

Arm 2 alone was the first version, and it is the assumption ADR-0019 itself files under
"accepted cost". Arms 3 and 4 were added when a table whose owner column is called
`owning_tenant`, force-RLS'd with a `USING (true)` policy, leaked every row to every tenant
while being invisible to the check and called protected by `db:check-policies`.

**Arm 5 exists because arms 3 and 4 are properties of a table being *protected*.** Measured
with three probes, each with owner column `owning_tenant`, each leaking
`bob@tenant-b.example` to tenant A:

| probe | arms 1-4 | arm 5 |
|---|---|---|
| no RLS at all | not named | named |
| `ENABLE`, no `FORCE`, `USING (true)` | not named | named |
| `ENABLE` + `FORCE`, `USING (true)` | named, by arm 3 | named |

The **unprotected** shape is the worst one. Before arm 5 the only arm that could see an
unprotected table at all was arm 2, the literal column name F-303 was filed against — so a
table that departs from the naming convention **and** is unprotected was invisible to all
four.

### The residual: what still escapes all five

Stated as a residual rather than left implicit, because a boundary stated as a residual is
what stops the next reader treating the check as complete. **A table that is not `tenants`,
spells its owner column something other than `tenant_id`, declares no foreign key to
`tenants`, carries no policy reading `app.tenant_id`, and is not force-RLS'd.** That is
three simultaneous departures from ADR-0019's stated convention, and nothing here would
name it.

**Accepted cost, and it fails closed.** Arms 3 and 4 are properties of protection rather
than of tenancy, so a table force-RLS'd for some other reason, or carrying a foreign key to
`tenants` while holding no tenant's data, is reported as drift. The run goes red and names
the table, and the remedy is a registration or a justified entry in a closed list, both of
which are one-line diffs a reviewer sees. The alternative failed open, and this harness has
measured that twice.

**`SUITE_OWNED_CONTROL_TABLES` is a closed list**, for the same reason
`ISOLATION_EXCLUSIONS` is one: naming a real table there is the way to hide it from SC-1,
and it has to be a one-line diff a reviewer sees. The fixture table `rls_fixture_rows` is
**not** on it — it is registered, and it is attempted.

### `db:check-policies` is the other half of a composite gate, not a spare

**Normative, and the reason F-333 was filed.** For the unprotected shape above, the drift
check was neither second nor independent before arm 5: `db:check-policies` was the thing
catching it, `ci.yml` runs that first, and the composite gate held. That is still true of
anything arm 5 does not reach.

**Anyone replacing, weakening or removing either half must know the other is carrying part
of the load.** The two are not interchangeable and neither is a superset of the other:
`db:check-policies` reads the catalogue for protection state and knows nothing about the
registry; the drift arms read the registry and know nothing about whether a policy's
predicate is correct. And `check-policies`' own exemption cross-check verifies the claim
"no `tenant_id`" by looking for a column named `tenant_id`, so a table on its exempt list
(`user`, `session`, `account`, `verification`, `jwks`) that grew an `owning_tenant` column
is invisible to both.

### How a later TASK joins the enumeration

One `registerTenantScopedSurfaces()` call in `apps/api/test/isolation/registrations.ts`,
naming the table, its owner column and the methods to attempt. Nothing in `coverage.ts`
changes. **This is the mechanism this contract means when it says every TASK adding a
repository is a consumer of it.**

```ts
/**
 * What an attempt hands back for judging. A read reports `rows`; a write reports
 * `rowsAffected`. An attempt the database refused simply THROWS, and the runner classifies
 * the refusal — see "What a refusal is evidence of".
 */
export interface CrossTenantAttemptResult {
  readonly rows?: ReadonlyArray<Record<string, unknown>>;
  readonly rowsAffected?: number;
}

export interface TenantScopedMethod {
  readonly name: string;                       // the middle of `repo:<subject>.<name>`
  readonly kind: 'read' | 'write';             // AC-94 covers reads, AC-95 writes
  readonly reaches?: 'existing-row' | 'new-row';
  /** REQUIRED and deliberately not defaulted. See "Attempt semantics". */
  readonly qualification: 'owner-qualified' | 'unqualified';
  readonly attempt: (actor: TenantFixture, target: TenantFixture) => Promise<CrossTenantAttemptResult>;
}

export interface TenantScopedSurfaceRegistration {
  readonly subject: string;                    // class name; the middle of every id
  readonly table: string;
  readonly ownerColumn: string;                // `tenant_id` on template tables, `id` on `tenants`
  /** Called BEFORE every attempt. MUST seed a row for BOTH tenants. */
  readonly reset: () => void | Promise<void>;
  readonly methods: readonly TenantScopedMethod[];
  readonly declinedShapes?: ReadonlyArray<{ shape: string; because: string }>;
}

export declare function registerTenantScopedSurfaces(r: TenantScopedSurfaceRegistration): void;
```

What a registration owes, each clause the residue of a measured failure:

1. **`reset()` seeds a row for both tenants.** Four of the eight shapes return zero rows
   when the target owns none, whatever the policy says, and the harness refuses to score
   them: the surface comes back `unverified` and the run fails (F-295).
2. **Every method declares `reaches`.** It is what tells the harness which attempts need
   the target to own a row.
3. **Every method is attempted in both directions.** Use the `actor` and `target`
   arguments; do not close over a fixture constant (F-293).
4. **Every method declares `qualification`, and at least one write is `'unqualified'`**
   (F-302).
5. **Registering the same subject twice throws** rather than overwriting: two registrations
   disagreeing about a table's owner column would silently disable half the attempts.
6. **A registration with no methods throws.** A subject with nothing to attempt is
   indistinguishable from a subject nobody remembered to cover.
7. **Every read attempt projects the owner column.** The harness judges a read on the owner
   of each row returned, so a projection without it is unjudgeable and throws.

## Coverage assertion

```ts
const uncovered = discovered
  .filter((s) => s.authenticated)
  .map((s) => s.id)
  .filter((id) => !attempted.has(id) && !excludedIds.has(id));

expect(uncovered).toEqual([]);   // names every uncovered surface (AC-96)
```

`toEqual([])` on an array of ids, not a count comparison. AC-96 requires the failure to
**name** the uncovered route.

## Exclusions: exactly two

```ts
export const ISOLATION_EXCLUSIONS = [
  {
    id: 'repo:RedirectReadRepository.resolveByHostAndSlug',
    justification:
      'Redirect resolution runs before a tenant is known; the visitor is anonymous and the only inputs are a hostname and a slug. Narrowed by ADR-0003 to FOR SELECT policies on domains and links only, inside a READ ONLY transaction, in one file.',
  },
  {
    id: 'repo:PrivilegedTenantEraser.erase',
    justification:
      'Amendment A-2: GDPR deletion is deliberately outside the tenant-facing interface. Narrowed by ADR-0003 to a FOR DELETE policy scoped to a single tenant id. Reachable only from POST /api/gdpr/delete under tenant owner plus confirmation (AC-106).',
  },
] as const;

expect(ISOLATION_EXCLUSIONS).toHaveLength(2);
```

A third exclusion fails the length assertion. Raising the number is a one-line diff a
reviewer sees, and ADR-0020 requires a written justification with it.

## Two completeness assertions, not one

### 1. The grep assertion

Normative, and stated to be implemented literally. Settled 2026-08-05 (F-118); the
earlier one-sentence form ("each flag appears in exactly one non-test source file") was
unsatisfiable, because the policies that read a flag are built in
`apps/api/src/db/rls.ts` while the statement that sets it lives elsewhere.

**The scan set.** Every file matching `apps/api/src/**/*.ts` whose name does not end
`.spec.ts`. Nothing else is scanned. Three exclusions, each deliberate:

| Excluded | Why |
|---|---|
| `apps/api/src/**/*.spec.ts` | unit tests set flags to prove policies deny |
| `apps/api/test/**` | the integration harness sets `app.tenant_id` by design (`apps/api/test/support/psql.ts`) |
| `apps/api/drizzle/**` | migration DDL. Its flag literals are all inside `CREATE POLICY ... current_setting(...)`, which is the read side of the same distinction A1 draws. DDL applied by `shortkit_migrator` at deploy cannot set a flag on a request path |

**The three flags and their permitted files.**

| Flag | The one file that may SET it | May also contain the string |
|---|---|---|
| `app.tenant_id` | `apps/api/src/tenancy/tenant-context.ts` | `apps/api/src/db/rls.ts` |
| `app.redirect_context` | `apps/api/src/redirect/db/redirect-read.ts` | `apps/api/src/db/rls.ts` |
| `app.privileged_erase` | `apps/api/src/gdpr/privileged-eraser.ts` | `apps/api/src/db/rls.ts` |

**A1. Set call sites.** For each flag `F`, let `setters(F)` be the files in the scan set
containing at least one match of

```
/set_config\s*\(\s*(['"`])(app\.[a-z_]+)\1/
```

whose second capture group equals `F`. Assert `setters(F)` equals exactly the one
permitted setter for `F`. This is the clause that carries the security claim: reading a
flag in a policy is not an escape, setting one is.

**A2. Containment.** For each flag `F`, let `mentions(F)` be the files in the scan set
containing the substring `F` anywhere at all: code, comment, template string, JSDoc.
Assert `mentions(F)` is a subset of `{ permitted setter for F, apps/api/src/db/rls.ts }`.
A copy of the literal in a repository, a service or a guard fails here even if nothing
sets it, because it is the step before someone does.

**A3. `rls.ts` reads, never sets.** Assert `apps/api/src/db/rls.ts` contains no match of
`/set_config\s*\(/`. Without A3, A2's carve-out is the hole: `rls.ts` would be a file
permitted to contain all three strings and permitted to set them.

**A4. No computed flag name, and a closed list of non-`app` names.** For every match of
`/set_config\s*\(/` in the scan set, assert the first argument is a single-quoted,
double-quoted or backtick-quoted string literal whose value is one of these three:

| Permitted first argument | Issued by | Since |
|---|---|---|
| `statement_timeout` | `withTenantTransaction` (`tenant-context.md`, "SQL issued") | 2026-08-04, F-007 |
| `idle_in_transaction_session_timeout` | `withTenantTransaction`, in the same statement group | 2026-08-05, F-123 |
| anything beginning `app.` | the three flag setters in the table above, further constrained by A1 and A2 | initial |

The predicate TASK-056 implements, over the first argument as defined below:

```
/^(['"`])(statement_timeout|idle_in_transaction_session_timeout|app\.[^'"`]*)\1$/
```

An identifier, a `${...}` interpolation, or a concatenation fails. A4 is what makes A1
sound: without it, `set_config(FLAG, ...)` defeats A1 with a one-line alias. It is also
the first enforcement of ADR-0003's no-concatenation rule, which was prose with no test
behind it.

**The two non-`app` names are an enumeration, not a pattern, and that is deliberate.**
A pattern loose enough to admit a legitimate GUC by shape (`/^[a-z_]+$/`, say) also
admits `role`, `session_authorization`, `row_security` and `search_path`. Grep cannot
tell a resource bound from an identity switch, so the list names the GUCs rather than
describing them. This is the same shape as `ISOLATION_EXCLUSIONS`'s length assertion
above and as `tenant-context.md` rule 3's closed field allowlist: widening it is a
one-line diff a reviewer sees.

**Admitting a third name.** Edit the table above and ADR-0003's A4 restatement in the
same commit, and record why. The test a candidate has to pass: the GUC is `USERSET`, it
is set transaction-locally with `is_local = true`, and it bounds a resource the
transaction already holds. It must not change the connection's identity, its row
visibility, or how an unqualified name resolves. `idle_in_transaction_session_timeout`
passes on all four counts, which is why it is here and `row_security` never will be.

**Consequence for implementers: a flag name gets no named constant.** A4 rejects
`set_config(TENANT_ID_SETTING, ...)`. The setter files write their own flag literal
inline, and `rls.ts` writes all three inline in its policy templates.

**All four clauses are text scans over file contents. None of them parses TypeScript, and
none distinguishes code from a comment.** That is intended. A commented-out
`set_config('app.privileged_erase', ...)` in a repository file is a copy-paste one
uncomment away from being real, and A2 fails on it. The cost is that the permitted setter
files carry their own flag name in their header comments, which A1 and A2 both match
harmlessly because those files are the permitted ones.

For A4, "first argument" means the text between `set_config(` and the first following
comma, trimmed. No flag name contains a comma, so no balanced-paren parse is needed.

A fourth escape, a second file setting an existing flag, a stray copy of a flag string,
or a flag name passed as a variable each fail one of the four clauses and name the file.

**Timing.** A1 asserts exactly-one. `redirect-read.ts` (TASK-029) and
`privileged-eraser.ts` (TASK-054) both land before TASK-056's wave, so all three setters
exist when the suite first runs. A1 is not runnable earlier.

### 2. The `pg_policies` shape assertion

Added 2026-08-04. Grep catches an escape that **sets a new context flag**. It does not
catch a cascade, and it does not catch a permissive policy added to an existing table.
F-005 was exactly that: `tenants` carried a `FOR ALL` policy whose `DELETE` let any
authenticated handler cascade-destroy the tenant's click stream and audit log while
setting no flag and greping clean.

Every policy on every tenant-scoped table must match one of the approved shapes in
`rls-policy-template.md` **by name and by `qual` text**. Anything else fails and names
the policy and the table.

```ts
export interface PolicyShape {
  readonly namePattern: RegExp;   // e.g. /^(.+)_tenant_isolation$/
  readonly command: 'ALL' | 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE';
  readonly qual: string | null;   // normalised, captured from a live database
  readonly withCheck: string | null;
  readonly tables: 'all-tenant-scoped' | readonly string[];
}

export declare function assertOnlyApprovedPolicies(): Promise<void>;
```

The check runs three ways, and all three must hold:

1. Every policy present matches an approved shape.
2. Every tenant-scoped table has the shapes it is **required** to have, so a table
   missing `<t>_privileged_erase` fails rather than silently surviving erasure.
3. `relrowsecurity` and `relforcerowsecurity` are both true on every tenant-scoped
   table. Without `FORCE`, the owner bypasses every policy and the whole suite is
   theatre.

**Expected `qual` strings are captured from a live database after migration**, not
written by hand: PostgreSQL normalises and reformats policy expressions, so a
hand-written string will not match.

~~`pnpm db:check-policies` is the same assertion, runnable outside the suite, and CI's
`integration` job runs it.~~ **Amended 2026-08-11 (F-122, F-333, F-327).** It is not the
same assertion. `assertOnlyApprovedPolicies()` is TASK-056's and throws `not implemented`;
`db:check-policies` is the **weaker form that runs today**, it checks protection state
rather than matching every policy against an approved shape by name and `qual` text, and
CI's `integration` job runs it after `db:migrate` and **before** the suite. That ordering
is load-bearing: see "`db:check-policies` is the other half of a composite gate" above.
**What is owed to make this section true is in "What this contract claims that is not yet
true": TASK-053's `tenantScopedTables()`, then TASK-056's `assertOnlyApprovedPolicies()`.**

### What the two assertions together do and do not cover

| Way a third escape could arrive | Caught by |
|---|---|
| a new context flag set in application code | grep A1 |
| an existing flag set in a second file | grep A1 |
| a flag literal copied into a file that does not set it | grep A2 |
| `rls.ts` itself setting a flag | grep A3 |
| a flag name passed to `set_config` as a variable, to defeat A1 | grep A4 |
| a fourth flag added to a policy template in `rls.ts` | **not by grep.** A2 permits all flag strings there. The `pg_policies` shape assertion rejects it, because the policy carrying it is not on the approved list |
| a new permissive policy on an existing table | `pg_policies` shape |
| a widened `FOR` clause on an approved policy | `pg_policies` shape |
| a tenant-scoped table with RLS not forced | `pg_policies` shape |
| a table with a `tenant_id` column and no policies at all | `pg_policies` shape, via `tenantScopedTables()` |
| a `BYPASSRLS` or superuser runtime role | boot-time assertion (`rls-policy-template.md`) |
| a cascade from a table whose `DELETE` is ungated | **indirectly**: the shape assertion proves `tenants` has no ordinary `DELETE` policy, which is what makes the cascade reachable only from the eraser |

## Attempt semantics

```ts
export interface TenantFixtures {
  readonly tenantA: { id: string; ownerUserId: string; token: string; workspaceId: string; linkId: string; domainId: string };
  readonly tenantB: { /* same shape */ };
}
export declare function createTenantFixtures(): Promise<TenantFixtures>;
export declare function assertNoCrossTenantAccess(surface: DiscoveredSurface, f: TenantFixtures): Promise<void>;
export declare function isolationReport(): IsolationReport;
```

**`TenantFixtures` carries two fields today, not six.** Ruled 2026-08-06 and recorded here
2026-08-11 (F-327). Five of the six fields above name rows in tables no migration creates
yet — `user` and `tenant_memberships` (TASK-013), `workspaces` (TASK-018), `links` and
`domains` (TASK-024, TASK-028) — so the shipped `TenantFixture` is `{ id: string; name:
string }`. The shape above is the target. **The wave that adds each table adds its field in
the same commit that registers the table**, and until then the missing field is a
divergence with a ruling behind it rather than an oversight.

| Kind | Attempt | Assertion |
|---|---|---|
| route | request as A's user against B's resource id | status is 403 or 404, and the body contains no id or `tenant_id` belonging to B (AC-94) |
| repository method, read | call inside A's transaction with B's arguments | zero rows returned (AC-94). ~~or a throw~~ **Amended 2026-08-11 (F-294, F-327):** a read that threw is `unverified`, not a pass. Row-level security denies a read by returning zero rows and never by raising, so a read that raised did not run, and whatever it proves it is not that a policy denied it |
| repository method, write | as above | ~~rejected or zero rows affected (AC-95)~~ **Amended 2026-08-11 (F-302, F-330, F-327).** The rule depends on whether the statement names the owning tenant in a `WHERE` clause. See the two rows below |
| write, `owner-qualified` | a statement whose `WHERE` names the target's owner column | zero rows affected, or a refusal the harness recognises as row-level security. Every row the statement can reach belongs to the target, so **any** row affected is the leak |
| write, `unqualified` | a statement with no `WHERE` clause at all | rows affected ≤ the number of its own rows the acting tenant was shown to see, **and** the per-row digest of every row the actor does not own is unchanged. **A refusal scores `unverified`, never `pass`** |

**Why the original write row was wrong, measured.** PostgreSQL applies the SELECT policies
to any UPDATE or DELETE that references a column, and a `WHERE <owner> = <target>`
references one. On the migrated `tenants` table with `tenants_self_update` altered to
`USING (true) WITH CHECK (true)`, inside one ordinary tenant-A transaction:

```
UPDATE tenants SET name = 'x' WHERE id = <B>   -> UPDATE 0   (SELECT policy applied)
UPDATE tenants SET name = 'x'                  -> UPDATE 2   (both tenants' rows destroyed)
```

The suite reported 15 passed, exit 0, and `db:check-policies` OK. "Rejected or zero rows
affected" is satisfied by the first statement over a policy that admits every row of every
tenant, which is why an unqualified write has to be attempted separately and judged by a
different rule.

### Eight statement shapes per table, three of them carrying no `WHERE` clause

Every registered subject is attacked with all eight, in **both directions** (F-293), so a
policy that leaks only to one tenant is attempted rather than assumed symmetric.

| Shape | Statement | Kind | Qualification | Reaches |
|---|---|---|---|---|
| `findAll` | `select <projection> from <t> order by id` | read | unqualified | existing-row |
| `findOwnedBy` | `select <projection> from <t> where <owner> = <target>` | read | owner-qualified | existing-row |
| `updateOwnedBy` | `update <t> set <mutable> = <constant> where <owner> = <target>` | write | owner-qualified | existing-row |
| `deleteOwnedBy` | `delete from <t> where <owner> = <target>` | write | owner-qualified | existing-row |
| `insertOwnedBy` | `insert into <t> (...) values (...)` planting a row | write | owner-qualified | new-row |
| `updateAll` | `update <t> set <mutable> = <constant>` | write | unqualified | existing-row |
| `deleteAll` | `delete from <t>` | write | unqualified | existing-row |
| `reparentAll` | `update <t> set <owner> = <actor>` | write | unqualified | existing-row |

`findAll` is deliberately unfiltered: a `where <owner> = <actor>` here would assert the
`WHERE` clause rather than the policy.

**`updateAll`'s `SET` expression must not read a column.** `set <col> = <constant>`
references no existing column, which is what keeps the SELECT policies out of it; a `SET`
expression reading a column pulls them back in and the shape degrades into `updateOwnedBy`
with extra steps.

`updateAll` and `deleteAll` are F-302's. **`reparentAll` is F-330's and it is the worse
half.** Tighten that mutation's `WITH CHECK` back to the predicate the production builder
emits, leaving only the `USING` widened, and `updateAll` is *refused* with 42501 — which
the harness scored as a denial. Measured: every attempt green, `verdict: pass`, over a
policy admitting every row of every tenant. `UPDATE <t> SET <owner> = <actor>` reports
`UPDATE 2` and leaves the other tenant's row belonging to the actor. Theft rather than
vandalism: the row is not damaged, it changes hands, and the `WITH CHECK` is satisfied
*because* the result belongs to the actor.

**A registration whose writes are all `owner-qualified` is blind to a wide-open UPDATE or
DELETE policy.** `qualification` is required per method and deliberately not defaulted: a
defaulted field is how a later TASK inherits whichever value was convenient.

### Two independent judgements per write, because a count cannot see an overwrite

A **read** is judged on the owner column of every row it returned: a row whose owner is not
the acting tenant is the leak. **A read attempt must project the owner column, or the
harness refuses to judge it and throws** — an attempt whose projection omits it cannot be
judged, and passing it silently is how a harness stops detecting anything.

A **write** is judged on both of the following, and either one alone is insufficient. The
second also runs for reads, as the before-and-after comparison around every attempt:

1. **The row count the statement itself reported**, against the number of its own rows the
   actor was shown to see through its own transaction moments earlier. `UPDATE 2` from a
   single-tenant context that can see one row of its own is the leak, stated in the one
   place a wide-open UPDATE or DELETE policy cannot hide it.
2. **A per-row digest of every row the actor does not own**, `md5(<row>::text)` computed by
   the database over the whole row, compared either side of the attempt. An overwrite
   **preserves ownership** — `UPDATE tenants SET name = 'pwned'` leaves every id and every
   owner where they were — so a census of ids and owners is identical before and after one
   tenant has destroyed another's data.

The actor's own rows are excluded from the digest set deliberately, and that exclusion is
what lets an unqualified write be attempted at all: `DELETE FROM <t>` issued as tenant A is
*supposed* to remove A's own row. Nothing is lost, because a row that moved from the actor
to anyone else appears in the set afterwards and a row that moved the other way disappears
from it.

### What a refusal is evidence of

**Only a refusal the harness recognises as row-level security counts** (F-294): SQLSTATE
`42501` **and** a message matching `/violates row-level security policy/i`. An RLS `WITH
CHECK` violation and `permission denied for table ...` are both 42501, so the code alone
cannot tell a policy refusal from a missing grant. Anything unrecognised is `unverified`.

**And a recognised refusal proves the `WITH CHECK` clause held, not that the `USING` clause
did** (F-330). `USING` decides which existing rows the statement may reach; `WITH CHECK`
decides what the resulting row may look like. For an `owner-qualified` write the
distinction does not matter — the statement names the target, so a refusal on any ground
means the target's row was not written. **For an `unqualified` write it is the whole
question**: the statement sweeps every row `USING` admits, and a `WITH CHECK` refusal on
the first foreign row it reaches is exactly what a wide-open `USING` with a correct `WITH
CHECK` produces.

So: **an unqualified write refused by row-level security scores `unverified` with the
reason named. It is never a pass.** The repair is to re-issue the statement in a form the
`WITH CHECK` admits — `reparentAll` is that form — or to narrow the shape.

### The premise an attempt needs before its answer means anything

F-295. Most shapes return zero rows when the target owns no row, whatever the policy says,
and every shape returns zero rows if the tenant context never reached the database. Both
are indistinguishable from a denial. Before scoring, the harness establishes through the
tenants' own transactions that there was something to deny and someone to deny it to:

- the actor sees at least one row of its own in the table, else `unverified`;
- for any method whose `reaches` is not `'new-row'`, the target sees at least one row of
  its own, else `unverified`.

### Three outcomes, not two

`pass | fail | unverified`. **`unverified` fails the run and names the surface, in the same
shape as `uncovered`.** An attempt that neither leaked nor proved anything is not a pass;
scoring it as one is what produced a green report over surfaces that were never tested.

### Declined shapes

A table that cannot express a shape **declines it by name, against a stated reason**, and
the reason reaches `report.json` in `declinedShapes`. `tenants` is the case that forced it:
its owner column is its primary key, so `UPDATE tenants SET id = <actor>` collides with
23505 raised by the index before any policy is consulted — indistinguishable from the 42501
a policy owes us.

Removing a shape is possible **only** through this route. "This table never had that
attempt" and "this table quietly lost that attempt" must not look the same to a reader; a
shape that can be dropped without a stated reason is a shape that gets dropped.

**The consequence, stated where it is load-bearing:** on the migrated `tenants` table,
`updateAll` is the only live unqualified write attempt per direction. `deleteAll` there is
inert because `tenants` carries no ordinary DELETE policy at all (F-005, F-329, F-334), and
`reparentAll` is declined. Four green delete attempts on that table prove a policy is
*absent*, not that one is correct.

A surface whose arguments cannot be inferred registers a fixture builder. **Absence of
one fails as uncovered**; it is never skipped.

### AC-95's post-run check

~~runs once: a single query asserts no row's `tenant_id` differs from a snapshot taken
before the run.~~ **Amended 2026-08-11 (F-302, F-328, F-327).** That sentence described the
only ownership check the harness had, and it is now neither the only one nor the strongest.

- **Per attempt**, the harness compares the census either side of every individual attempt
  and names the method that moved a row. That is the strictly stronger check and it is
  where AC-95 is actually enforced.
- **After the run**, `assertNoTenantIdAltered()` compares the whole-registry ownership
  census against the snapshot `createTenantFixtures()` took. It is the contract's declared
  form, kept for TASK-056, and it is **narrowly weaker than it reads** (F-328): an
  unqualified write that affected rows triggers a `reset()` immediately after the attempt,
  because `DELETE FROM <t>` issued as tenant B legitimately removes B's own row and would
  otherwise leave the fixture short for the rest of the run.

**Why that weakening is bounded, and where it is not.** A cross-tenant write the reset
restores has already been judged, recorded in `leaks`, and reported as a `fail` naming the
surface; the judgement runs strictly before the reset. What the reset erases is any effect
on rows the per-attempt comparison deliberately excludes: the actor's own rows, and rows
owned by a tenant the two-tenant fixture never seeds. The second of those is live — see
"Statement shapes known to be uncovered" below, item 3.

**ADR-0020 carried the same two sentences and was amended the same day.** Its Decision read
*"AC-95's write check runs once after the suite. A single query asserts no row's `tenant_id`
changed against a snapshot taken before the run"*, and its "Attempts are generated"
paragraph said repository attempts assert zero rows — the same defect as this paragraph's,
one document upstream, which is why one fix had to be applied in five places and reached
two. Both are struck there now, and **the ADR points here rather than restating the rule**:
the attempt semantics are stated once, in this file. A future change amends this file, and
ADR-0020 only if the decision itself changed.

## Enforcing "exactly one of Form A, B or C"

`workspace-authorization.md` invariant 8 says every authenticated route is authorised by
exactly one form. Form A is a decorator and `DiscoveryService` sees it. **Forms B and C
are method calls**, so they need a source-level check.

```ts
export type AuthorizationForm = 'A-decorator' | 'B-in-handler' | 'C-in-transaction' | 'unverified';
export declare function authorizationFormOf(surface: DiscoveredSurface): AuthorizationForm;
```

The scan resolves each authenticated route's handler and looks for a call to
`authorizer.assert`, `authorizer.assertTenant`, or `assertNotLastOwner`. It follows **one
level of delegation**: a handler whose body is a single call into a service method also
has that method's body scanned.

**A route the scan cannot resolve is reported as `unverified`, not as passing.**
`unverified` is a suite failure with the route named, exactly like `uncovered`. That is
what stops the check degrading into a rubber stamp when a handler delegates two levels
deep: the fix is to move the call up or to add the route to the scan's resolution hints,
both of which are visible in a diff.

Known limit, stated: the scan proves an authorization call exists on the path, not that
its arguments are right. A handler calling `assert(someOtherWorkspaceId, ...)` passes.
Form B's correctness still rests on the cross-tenant attempts above, which is why both
mechanisms exist.

## What enumeration cannot reach

Added 2026-08-04 (F-021). `DiscoveryService` walks the Nest module graph. Better Auth is
mounted on the raw Express instance ahead of Nest (ADR-0013), so **nothing under
`/api/auth/*` appears in `discoverRoutes()`**, including `onUserCreated`, which is the
single anonymous path that writes `tenant_memberships`.

This is a real gap in SC-1's completeness claim, recorded rather than left implicit.

| Surface | Why enumeration misses it | Coverage instead |
|---|---|---|
| `onUserCreated`, invited branch | inside Better Auth's handler, outside the Nest graph | TASK-013 integration test: a token whose tenant half names another tenant creates no user and no membership there |
| `onUserCreated`, uninvited branch | same | TASK-013 integration test: the created tenant is the generated uuid and nothing else |
| in-handler authorization on `@NoTenantTransaction` routes | the check is a call, not a decorator | TASK-054 integration test: tenant `member` and `admin` both get 403 on `POST /api/gdpr/delete` (F-020) |

`isolationReport()` carries these as `unenumerable`, each with the test that covers it,
so a reader of the report sees the boundary of what the suite proves.

```ts
export const UNENUMERABLE_SURFACES = [
  { id: 'hook:onUserCreated', reason: 'Better Auth handler is mounted outside the Nest module graph (ADR-0013).', coveredBy: 'apps/api/test/auth/signup-invited.int-spec.ts' },
  { id: 'handler:POST /api/gdpr/delete authorization', reason: '@NoTenantTransaction moves the owner check into the handler (F-020).', coveredBy: 'apps/api/test/gdpr/delete-authorization.int-spec.ts' },
] as const;
```

Adding an entry here is not a substitute for an exclusion and does not change the
exclusion count: these surfaces are covered, just not by enumeration.

## Report

`apps/api/test/isolation/report.json`, ~~uploaded as a CI artifact~~. **Amended 2026-08-11
(F-297, F-327): no upload step exists.** The path is gitignored and `ci.yml` has no
`upload-artifact` for it, so today the artifact exists only in the workspace of whichever
job ran the suite. **What is owed is in the ledger under "What this contract claims that is
not yet true": F-297 builds the upload, and it must fail the job when the artifact's `runAt`
predates the job** — see the three-write discipline below for why that half is the one that
closes the collection-error residual.

**Amended 2026-08-11 (F-327).** Nine fields the code writes were undeclared here, and
`verdict` carried two values where the code has three. The declared shape was not a subset
of the written one in any useful sense: `attempts` is what AC-12's "pass/fail per method"
requires, `failed` and `unverified` are what AC-96's "name it" requires of a red run, and
`attemptVerdict` plus `suiteOutcome` are what stops a red run publishing a green artifact.

```ts
export type IsolationVerdict = 'pass' | 'fail' | 'incomplete';

/** What the test runner observed of the isolation spec file's own tests. */
export type SuiteOutcome = 'pass' | 'fail' | 'incomplete';

export interface AttemptOutcome {
  readonly id: SurfaceId;
  readonly subject: string;
  readonly method: string;
  readonly table: string;
  readonly kind: 'read' | 'write';
  readonly direction?: 'A->B' | 'B->A';
  readonly actor?: string;
  readonly target?: string;
  readonly outcome: 'pass' | 'fail' | 'unverified';
  /** One entry per way this attempt crossed the boundary. Empty on a pass. */
  readonly leaks: readonly string[];
  readonly rowsSeen?: number;
  readonly rowsAffected?: number;
  readonly qualification?: 'owner-qualified' | 'unqualified';
  /** Rows the actor could see that it owns, read through its own transaction. */
  readonly actorOwnRowsVisible?: number;
  /** Rows the target could see that it owns. Zero makes a reaching attempt vacuous. */
  readonly targetOwnRowsVisible?: number;
  /** How the database refused it, when it did. SQLSTATE AND MESSAGE (F-294). */
  readonly refusedWith?: string;
  readonly refusalKind?: 'row-level-security' | 'unrecognised';
  /** Why the attempt proved nothing. Present iff outcome is `unverified`. */
  readonly unverifiedBecause?: string;
}

export interface RegistryDatabaseDrift {
  /** Tenant-scoped in the database, registered nowhere. The suite is blind to these. */
  readonly inDatabaseNotRegistered: string[];
  /** Registered, absent from the database or no longer tenant-scoped. */
  readonly registeredNotInDatabase: string[];
}

export interface IsolationReport {
  runAt: string;
  discovered: DiscoveredSurface[];
  /** One id per surface, however many directions it was attempted in. */
  covered: SurfaceId[];
  uncovered: SurfaceId[];
  /** AC-12: pass/fail PER METHOD, per direction. Added 2026-08-11 (F-327). */
  attempts: AttemptOutcome[];
  /** The subset of `covered` whose outcome was `fail`. Added 2026-08-11 (F-327). */
  failed: SurfaceId[];
  /** Attempted and proved nothing. A run with any of these is `fail`. Added 2026-08-11 (F-327). */
  unverified?: SurfaceId[];
  /** Added 2026-08-11 (F-327). Both directions fail the run. */
  registryDrift?: RegistryDatabaseDrift;
  excluded: ReadonlyArray<{ id: SurfaceId; justification: string }>;
  publicRoutes: ReadonlyArray<{ id: SurfaceId; justification: string }>;
  noTenantTransactionRoutes: ReadonlyArray<{ id: SurfaceId; justification: string }>;
  /** Covered by named integration tests rather than by enumeration. See above. */
  unenumerable: ReadonlyArray<{ id: string; reason: string; coveredBy: string }>;
  /** Shapes a registration declined, and why. Added 2026-08-11 (F-327, F-330). */
  declinedShapes?: ReadonlyArray<{ table: string; shape: string; because: string }>;
  /** The boundary of what this run proves, in the artifact itself. Added 2026-08-11 (F-327). */
  coverageBoundary: string;
  /** The judgement over the attempts alone. Added 2026-08-11 (F-327, F-331). */
  attemptVerdict?: 'pass' | 'fail';
  /** `incomplete` until `afterAll` has run. Added 2026-08-11 (F-327, F-331). */
  suiteOutcome?: SuiteOutcome;
  verdict: IsolationVerdict;
  /** Present iff the verdict is `incomplete`: what the artifact is not saying. */
  incompleteBecause?: string;
}
```

This is the artifact SC-1 points at.

### `incomplete` is a third verdict

Added 2026-08-11 (F-304, F-327). The artifact was written once, after the attempts, so a
run that died earlier left the **previous** run's `"verdict": "pass"` on disk. Measured: a
mutation that made `createTenantFixtures()` throw in `beforeAll` — the absolute census
assertion doing exactly its job — exited 1 with every test skipped, and `report.json` still
read `verdict=pass` with the previous run's timestamp. The most alarming failure this
harness has is precisely the one that stranded a stale pass.

`incomplete` means **this run did not finish**. It is never the last run's answer.

### The artifact is written three times, and only the last write can say `pass`

Added 2026-08-11 (F-331, F-332, F-327). Normative.

| # | When | `verdict` | Why there |
|---|---|---|---|
| 1 | **module scope**, before anything that can throw | `incomplete`, no attempts | `beforeAll` does not run when every test in the file is filtered out. Measured: `-t 'a name that matches no test'` gave 18 skipped, exit 0, and the previous run's `pass` still on disk with no marker. Module scope runs at collection, and collection happens for a filtered run (F-332) |
| 2 | **end of `beforeAll`**, after the attempts are judged | **still `incomplete`**, with the attempts | a process killed mid-suite strands the evidence without stranding a verdict |
| 3 | **`afterAll`**, which runs after every test in the file *and* when `beforeAll` threw | the conjunction of `attemptVerdict` and `suiteOutcome` | eleven of the file's tests run after write 2, including `assertNoTenantIdAltered()`, whose failure is by construction something no attempt judged |

Measured before the fix: `Tests 1 failed | 17 passed (18)`, exit 1, and `report.json` read
`verdict=pass attempts=28 failed=[]` **for that run**. The suite was strictly stronger than
its own report, because `verdict` was computed from the attempt judgements alone.

**The bound, stated rather than overclaimed.** `verdict: 'pass'` on disk implies every
attempt passed **and** every test in the isolation spec file passed. **It cannot imply the
process exited 0** — a failure in another spec file is invisible from that file.
`suiteOutcome` carries the half the file can observe; an uploader wanting the stronger
property keys on the job's exit code as well.

**What write 1 still does not cover, stated:** a **collection error**. An import-time throw
means the module body never executes and a stale artifact survives. Closing it needs a
`globalSetup`, or F-297's upload step failing when the artifact's `runAt` predates the job,
which is the more robust side to close it from.

**On the in-memory report**, `verdict` is the attempt judgement alone, because that is the
question a negative-control run asks. Only `report.json` carries the conjoined answer.

**`isolationReport()` is not the run's report.** It returns the report of the most recent
`runCrossTenantAttempts()` in the process, and the negative controls each call that after
the real run, so after the controls it holds a canary's `fail`. A caller wanting the
production run's judgement reads the value `runCrossTenantAttempts()` returned, or
`report.json`. Recorded here 2026-08-11 as a hazard the contract had not stated (F-298).

## Invariants a caller may rely on

1. Adding an authenticated route or a repository method without a cross-tenant attempt
   fails the suite and names it (AC-93, AC-96).
2. Every cross-tenant read returns zero rows, 403 or 404 (AC-94). **A read that raised
   returns nothing a caller may rely on**: it is `unverified` and fails the run
   (amended 2026-08-11, F-294, F-327).
3. ~~Every cross-tenant write is rejected or affects zero rows, and no `tenant_id` is
   altered (AC-95).~~ **Amended 2026-08-11 (F-302, F-330, F-327).** This was the same
   disproved rule as the "Attempt semantics" write row, restated in the section a caller is
   told to rely on, which is the worse of the two places to be wrong. What holds:
   - an **owner-qualified** cross-tenant write affects zero rows, or is refused by a
     refusal recognised as row-level security;
   - an **unqualified** write affects no more rows than the acting tenant can see of its
     own, and changes the digest of no row the actor does not own. Its legitimate answer is
     `affected <= actorOwnRowsVisible`, **not** zero — `DELETE FROM <t>` as tenant A is
     supposed to remove A's own row;
   - a refusal of an **unqualified** write proves the `WITH CHECK` clause held and nothing
     about the `USING` clause, so it scores `unverified` and never `pass`;
   - no row's owning tenant changed across the run, subject to the bound recorded under
     "AC-95's post-run check".
4. The suite reads the real module graph, so it cannot drift from what the server
   serves. **Not yet true in this wave** (added 2026-08-11, F-327): no route and no
   repository exists to walk, the subjects are a registry, and what holds the registry
   honest is the five-arm database cross-check plus `db:check-policies`. **What is owed —
   TASK-011's decorator, then TASK-056's three discovery mechanisms — is in the ledger under
   "What this contract claims that is not yet true". A caller may not rely on this invariant
   until both land.**
5. Exactly two exclusions exist, both justified in-file and both narrowed by database
   policy.
6. **The complete set of ways data crosses a tenant boundary is the approved policy set
   in `rls-policy-template.md`**, and a test asserts that, so the claim is enforced
   rather than stated.
7. Every `@Public()` route that touches a tenant-scoped table reaches it through a
   capability-token entry point (ADR-0021), not through an escape.
8. **An attempt that proved nothing is `unverified`, and a run with any `unverified`
   surface is a failing run that names it** — the same treatment as `uncovered`. Added
   2026-08-11 (F-294, F-295, F-327).
9. **`report.json` never carries a `pass` a later assertion in the same run disproved, and
   never carries a previous run's answer.** The three writes above are what makes that
   true. Added 2026-08-11 (F-304, F-331, F-332, F-327).
10. **A tenant-scoped table the registry does not know about fails the run and names the
    table**, and so does a registered table the database does not have. Added 2026-08-11
    (F-296, F-327), subject to the residual stated under "The registry".

## What the implementer must guarantee

- TASK-011 makes `@Public()` and `@NoTenantTransaction()` require a non-empty
  justification string. Both are enumerated and printed.
- **A `@NoTenantTransaction` route may not also carry `@RequireTenantRole` or
  `@RequireWorkspaceRole`.** The suite asserts that combination never exists (F-020):
  the guards need an ambient tenant context the route does not have, and the cheapest
  repair is to make `WorkspaceGuard` tolerate its absence, which removes the owner check
  from tenant erasure.
- **`as TenantRole` and `as WorkspaceRole` appear only inside `asTenantRole` and
  `asWorkspaceRole`.** The suite greps for a third cast site and fails on it (ADR-0023).
- **Separately, the suite enumerates `asTenantRole(` and `asWorkspaceRole(` call sites
  and asserts the count** against a recorded number. The string-cast grep above and this
  one catch different things: the first catches someone bypassing the functions, the
  second catches someone adding a boundary where a role enters the system. A new call
  site is legitimate and needs the recorded count bumped in the same diff.
- Every repository-producing TASK applies `@TenantScopedRepository()`.
- The suite runs in CI's `integration` job (ADR-0001).
- A surface that is hard to fixture gets a fixture builder, not an exclusion.
- The `pg_policies` expected values are generated by a script against a freshly migrated
  database and committed. Regenerating them is a reviewed diff, which is the point.

Added 2026-08-11 (F-327), each the residue of a measured failure rather than a preference:

- **Every registered method declares `qualification` and `reaches`, and every registration
  has at least one `'unqualified'` write.** No defaults.
- **A shape is removed from a table only through `declinedShapes`, with a reason that
  reaches `report.json`.**
- **`reset()` seeds a row for both tenants and runs before every attempt**, so an attempt
  that wrongly succeeded cannot make the next one's result meaningless.
- **Every attempt runs real SQL through `withTenantTransaction` against a live PostgreSQL
  as the application role**, which holds neither `SUPERUSER` nor `BYPASSRLS`. The suite
  asserts that before it asserts anything else: a role exempt from row-level security makes
  a correct implementation and a missing one look identical. Nothing here is asserted
  against a mock, and no test in the suite asserts that a test helper works.
- **The harness's own ability to see a leak is proved by negative controls, not by prose.**
  Each is a real table built by real DDL, defective in a way an audit measured this harness
  reporting as clean, and every one of its attempts is required to report `fail`. **Eight
  controls and four probes today**, one per finding: the leak canary that omits `ENABLE ROW
  LEVEL SECURITY`, F-293's direction and baseline-leak canaries, F-294's grant-gap and
  masked-refusal canaries, F-295's half-seeded canary, F-302's unqualified-write canary and
  F-330's owner-theft canary, plus the unregistered-table probe (F-296) and the three
  owner-column probes at each protection state (F-303, F-333). **A finding of the form "the
  harness reported green while isolation was broken" is closed by adding a control, not by
  adding a comment.**
- **The suite's own tables are subtracted from the drift check through
  `SUITE_OWNED_CONTROL_TABLES`, and probes deliberately stay off it** — being caught is
  what a probe is for.

## Statement shapes known to be uncovered

Added 2026-08-11 (F-341, F-327). Filed and deliberately not fixed, by Juano's ruling of
2026-08-11: the round shipped the two concrete gaps and the generative alternative —
deriving statements from the policy set rather than listing them — became a roadmap item.
**These live here rather than only in a findings file, because a reader of this contract is
exactly who needs them.** All three blockers so far have been "a statement shape nobody
thought of", and items 1 and 2 are the next two nobody thought of.

1. **`INSERT ... ON CONFLICT DO UPDATE`.** PostgreSQL applies the INSERT `WITH CHECK` and,
   on conflict, **the UPDATE policy's `USING`** to the conflicting row plus the UPDATE
   `WITH CHECK`. A table with a correct INSERT policy and a wide-open UPDATE `USING` is
   therefore reachable through one statement no shape here issues — **and the ORM idiom
   `save()` / `upsert()` compiles to exactly it.** Same defect class as F-330 arriving
   through a third policy path. This is the one to take next.
2. **`MERGE`** (PostgreSQL 15+). Each `WHEN` branch applies a different policy, and no
   shape produces the combination.
3. **Eviction rather than theft**: `UPDATE <t> SET <owner> = <a tenant the fixture never
   seeds>`. The count rule **detects** it, because `affected > actorOwnRowsVisible`. The
   digest cannot **name** the recipient, because a third tenant appears in no census line.
   Detected but not attributed; attribution costs a third fixture tenant and is worth
   deciding the next time `censusRows()` is touched.
4. **Cascade and trigger effects on a sibling table.** The per-attempt census reads only the
   attempted table, so a write whose foreign-key cascade or trigger touches a *different*
   registered table is outside the comparison. Bounded today **only** because `tenants` has
   no ordinary DELETE policy, so no cascade can fire. It goes live the day one lands, which
   is F-329's table.
5. **`SELECT ... FOR UPDATE` / `FOR SHARE`.** A locking read applies the UPDATE policy's
   `USING` in addition to the SELECT policy, so on a table with a wide-open UPDATE `USING`
   a tenant can take row locks on rows it cannot read: an existence side channel and a
   denial of service on another tenant's writes. No shape issues a locking read.

## Versioning

`SurfaceId` strings appear in `ISOLATION_EXCLUSIONS`. Renaming a repository class or a
route path changes the id and breaks an exclusion, which fails loudly. That is
intended.

**`IsolationReport` is additive, and `verdict` widened once.** Added 2026-08-11 (F-327).
The nine fields declared above were all written by the code before this file declared them,
so no consumer breaks by their appearance; a consumer of `report.json` tolerates fields it
does not know. **`verdict` is the exception and it is not backward compatible**: a consumer
that switched on `'pass' | 'fail'` now meets `'incomplete'`, and the safe reading of
`incomplete` is *not a pass*. F-297's upload step is the first consumer that has to handle
it, and it should also fail when the artifact's `runAt` predates the job, which is the only
side the collection-error case can be closed from.

**This contract is amended, not rewritten.** Every corrected sentence stays visible with a
strikethrough and the finding that disproved it, because three audit rounds turned on
someone reading a stale sentence as current. A future correction takes the same form.
