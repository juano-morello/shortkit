---
id: ADR-0045
slug: identity-membership
title: Token-mint tenant resolution reads one membership row through a third context flag
status: accepted
supersedes: null
amends: ADR-0002, ADR-0020
depends_on: ADR-0049
date: 2026-08-12
---

> **Corrected 2026-08-13 (F-003, F-005, F-006, F-007, F-008), round 1.** This ADR asserted
> twice that an unset `app.tenant_id` makes `current_setting` return NULL, so the isolation
> policy would admit nothing and the mint-time lookup would work. **That is true only on a
> backend where the flag placeholder has never been created.** A transaction-local
> `set_config` leaves the placeholder behind with a reset value of the **empty string**, and
> `pg.Pool` never resets the backend, so on any connection that has served one tenant
> transaction `''::uuid` raises `22P02` and the mint fails. Reproduced through the real pool
> by the reviewer and confirmed at statement level here.
>
> The premise was wrong; the decision was not. The escape's shape, its narrowing and its
> controls all stand. What changed is that the predicate it relies on had to be repaired
> first, and the repair belongs to the shared template rather than to this policy —
> **ADR-0049**, which also covers `redirectReadPolicy`'s table, the privileged eraser, and
> the plain out-of-context read that no escape is involved in.
>
> Every corrected sentence below is struck through in place rather than deleted.

## Context

`definePayload` must put `tid` in every token (ADR-0013, GC-D). `tid` comes from
`tenantIdForUser(user.id)`, a single-row lookup on `tenant_memberships`'
`UNIQUE (user_id)` index (ADR-0015). It runs at token-mint time, when no tenant is known —
that is the whole reason the claim exists.

`tenant_memberships` is a tenant-scoped table. GC-A and GC-E fix that: it carries
`tenant_id` and it gets `tenantScopedPolicies('tenant_memberships')` hand-appended to its
migration. Its isolation policy reads
`tenant_id = current_setting('app.tenant_id', true)::uuid`.

So the obvious implementation returns nothing. `databaseTransaction` sets no flag, so
~~`current_setting` returns NULL with the second argument true, `tenant_id = NULL` is NULL,
zero rows.~~ **corrected 2026-08-13 (F-003):** the flag reads NULL on a cold backend and the
**empty string** on any backend that has already served a tenant transaction, because a
transaction-local `set_config` leaves a session placeholder whose reset value is `''` and
`pg.Pool` issues no reset. Under the original template the first case returns zero rows and
the second **raises `22P02`**. Either way the lookup gets no tenant id; it is fail-closed
against itself on a cold connection and fail-loud on a warm one. ADR-0049 repairs the
predicate so both cases return zero rows.

`withTenantTransaction` is not available either: it needs the tenant id this function exists
to produce.

Three artifacts already priced the escape hatch:

- `docs/contracts/tenant-context.md`, "Admitting a fifth": a fifth consumer of
  `databaseTransaction` "qualifies only if it is one of the two `ISOLATION_EXCLUSIONS`, or
  if it reads `pg_catalog` and `information_schema` only and runs before the process serves
  traffic. **Anything else needs an ADR superseding ADR-0002.**"
- `docs/contracts/isolation-coverage.md`, "Exclusions: exactly two": "A third exclusion
  fails the length assertion. Raising the number is a one-line diff a reviewer sees, and
  ADR-0020 requires a written justification with it."
- `apps/api/src/db/rls.ts:72,87`: "Exclusion 1 of exactly 2", "Exclusion 2 of exactly 2".

This is that ADR and that justification.

## Decision

**A third context flag, `app.membership_lookup_user`, and a `FOR SELECT` policy on
`tenant_memberships` that admits exactly one user's row.**

### The policy

Built in `apps/api/src/db/rls.ts`, which is the only file besides a flag's setter that may
contain a flag string (isolation-coverage.md clause A2), and which sets nothing (clause A3):

```ts
/**
 * The token-mint lookup escape. Applied to `tenant_memberships` ONLY.
 * FOR SELECT only. Set only by withMembershipLookup, which additionally issues
 * SET TRANSACTION READ ONLY.
 *
 * Exclusion 3 of exactly 3 (ADR-0045).
 */
export function membershipLookupPolicy(): PolicySet {
  return {
    table: 'tenant_memberships',
    statements: [
      `CREATE POLICY tenant_memberships_membership_lookup ON tenant_memberships\n` +
        `  FOR SELECT\n` +
        `  USING (user_id = nullif(current_setting('app.membership_lookup_user', true), ''));`,
    ],
  };
}
```

The table name is a literal rather than a parameter. This policy applies to one table by
design and a parameter would invite a second.

**`user_id` is `text` and `current_setting` returns `text`, so this policy never casts and
was never affected by F-003.** ~~With the flag unset it reads NULL and with it reset it reads
`''`; `user_id = NULL` is NULL and `user_id = ''` matches no row, because `user_id` is a
foreign key into `"user"(id)` and no such row exists. The policy admits nothing in either
state~~

**Corrected 2026-08-13 (F-021). "No such row exists" is a data property asserted as if it
were a constraint, and it was wrong to rest on it.** `user.id` is `text PRIMARY KEY` with no
`CHECK` and no non-empty constraint. With one `"user"` row whose `id` is `''` and a
membership referencing it, measured on a warm backend as `shortkit_app`: a no-flag read
returned that row, and **tenant A's ordinary transaction returned tenant B's full membership
row** — `tenant_id`, `user_id` and `role` — through the permissive OR. That falsifies
`rls-policy-template.md` invariant 1, which this wave amended one round earlier.

Latent, not live: `parseUserInput` drops `id` on the sign-up route, so nothing creates the row
today. It is one `INSERT`, one custom `advanced.database.generateId`, or one item-1b
invitation path away, and no constraint stands between here and there.

The repair is the `nullif` above, per ADR-0049's widened rule. Verified: with the `''` row
present, the warm no-flag read returns zero rows, tenant A sees only its own row, the warm
mint still resolves, and the plan still uses `tenant_memberships_user_unique`.

An ordinary tenant transaction is unaffected either way, because PostgreSQL ORs permissive
policies.

~~The isolation policy beside it is what raised.~~ The isolation policy beside it **did**
raise, on every warm connection, and that is ADR-0049's subject rather than this one's. The
two policies are ORed into the same `SELECT`, so a raise in either aborts the statement
whatever the other would have returned — which is why repairing only this policy would have
changed nothing.

**No `TO` clause, deliberately. Ruled 2026-08-14 (F-121, folding in F-110), after four agents
raised it independently.** The policy applies to `PUBLIC`. `docs/contracts/isolation-coverage.md`
quoted it with `TO shortkit_app` inside the F-047 amendment; that quotation was wrong and is
struck there. Nothing else ever carried the clause, and the installed policy was measured as
`TO PUBLIC`.

A role list would decide which roles evaluate the policy. It would not change which roles the
policy can admit a row to, and three mechanisms already decide that. `shortkit_auth` holds no
privilege on `tenant_memberships`, so it fails with `permission denied for table
tenant_memberships` before RLS runs. `nullif(current_setting('app.membership_lookup_user', true),
'')` reads NULL in any session that has not set the flag, and `user_id = NULL` is NULL, so the
policy admits nothing to a role that cannot set it. `isolation-coverage.md` clauses A1 and A2
make `apps/api/src/auth/membership-lookup.ts` the only file that may set it. `tenant_memberships`
carries `FORCE ROW LEVEL SECURITY`, so the same gate binds `shortkit_migrator` as owner.

Consistency decided the rest of it. No policy in `rls-policy-template.md`'s approved set carries
a role clause, and one policy that did would be a deviation with nothing behind it. The cost
accepted: the guarantee rests on the grant matrix rather than on the policy text limiting itself,
so a fourth runtime role granted SELECT on `tenant_memberships` lands inside the escape's
evaluation without editing this policy. `check-policies.mts`'s grant matrix is the control that
makes that visible, and a fourth role is when this gets revisited.

### The setter

`apps/api/src/auth/membership-lookup.ts`, a new file, following the shape of the two
existing escapes — each lives in its own feature directory, not in `tenancy/`.

```ts
export type MembershipLookupDb = PgTransaction<any, typeof schema, any> & {
  readonly [membershipLookupBrand]: true;
};

export async function withMembershipLookup<T>(
  userId: string,
  fn: (db: MembershipLookupDb) => Promise<T>,
): Promise<T>;
```

SQL issued, in this order:

```
BEGIN;
SET TRANSACTION READ ONLY;
SELECT set_config('statement_timeout',                   '5000', true);
SELECT set_config('idle_in_transaction_session_timeout',  '5000', true);
SELECT set_config('app.membership_lookup_user',          $1,     true);
```

`SET TRANSACTION READ ONLY` is not redundant with the `FOR SELECT` policy. The handle also
reaches the five RLS-exempt Better Auth tables (ADR-0044), where a write would be
unconstrained; read-only closes the transaction rather than one table.

`MembershipLookupDb` carries its own brand, so it is not assignable to `TenantDb` and a
repository written against tenant context cannot be handed one by mistake.

`withMembershipLookup` never sets `app.tenant_id` and never enters `tenantStorage`, so
`tenantDb()` and `currentTenantId()` keep throwing inside `fn`. It is the fifth sanctioned
consumer of `databaseTransaction`.

`userId` is asserted non-empty and at most 255 characters before it reaches `set_config`.
The value is bound as `$1`, so this is a shape check and not an injection defence.

### The caller

`apps/api/src/auth/tenant-id-for-user.ts`:

```ts
export async function tenantIdForUser(userId: string): Promise<string>;
export class NoTenantMembershipError extends Error;
```

It resolves to the lower-cased uuid on that user's single membership row, and throws
`NoTenantMembershipError` when there is no row — never `null`, never `''`. It contains no
flag string and does not import `databaseTransaction`; `withMembershipLookup` is its only
database reach.

**`NoTenantMembershipError.message` carries an eight-character prefix of the user id and its
length, never the whole id.** The full value is on a readable `userId` property for the
mint path. This is F-132's rule and it is load-bearing here for a different reason:
~~`serializers.err` reduces a logged error to `err_name` and `err_stack`, and `Error.stack`
begins with the message, so anything interpolated into the message reaches the log line
whatever `LOGGABLE_FIELDS` says.~~

**Corrected 2026-08-13 (F-027). The rule is right and this reason for it was false against
shipped code.** `logger.ts:159` binds `serializers.err` with `includeMessage: false`, and
`errorLogFields` emits `err_message` only when that is true; `logger.ts:880-884` records as a
measured result that `err_stack` carries frames only, because the `${name}: ${message}` header
is stripped by prefix and then by shape. F-090, F-093, F-108 and F-111 are the findings that
made it so. **A message does not reach a log line through `err`, and did not before this wave
either.**

Keep the truncation, on the grounds that are true:

- **`includeMessage: true` is opt-in at two sanctioned call sites**, and `DomainError` is one
  of them. A message is one subclass change from being logged, and the change would not look
  like a logging change.
- **The full value is on `.userId` and nothing needs it in the message.** `LOGGABLE_FIELDS`
  has no `userId` entry, so an object carrying it renders `[redacted]`, and `serializers.err`
  builds a fixed field set rather than copying the error's own properties (F-244). Truncating
  the message costs a caller nothing.
- **This error is thrown inside `definePayload`, on the Better Auth mount, outside the Nest
  graph** — so `ApiExceptionFilter` never sees it and the code that does is the dependency's.
  ADR-0052 binds that logger and drops its positional `args`, which closes the channel the
  auditor identified; it closes it by a decision made in the same round, not by a property
  that predates this one.

Whether a user identifier joins `LOGGABLE_FIELDS` is a separate decision this initiative has
not made.

### The exclusion

`ISOLATION_EXCLUSIONS` in `apps/api/test/isolation/coverage.ts` gains a third entry, and the
AC-12 assertion in `cross-tenant-isolation.int-spec.ts` moves from `toHaveLength(2)` to
`toHaveLength(3)` with the id added to its `toEqual` list:

```ts
{
  id: 'repo:TenantMembershipLookup.tenantIdForUser' as SurfaceId,
  justification:
    'Token minting runs before a tenant is known: the claim this reads produces is what a tenant context is later opened from. Narrowed by ADR-0045 to a FOR SELECT policy admitting one user_id, inside a READ ONLY transaction, in one file. Reachable only from definePayload.',
}
```

**TASK-002 makes both edits, in wave 1, in the same commit as the policy.** Landing the
escape in wave 1 and its exclusion entry in wave 9 would leave eight waves in which the
suite is green and an unlisted escape exists, which is the failure mode the length assertion
was built to prevent.

### What keeps it narrow

~~Four controls, three of which already exist:~~

**Corrected 2026-08-13 (F-025). None of the four executes today, and "three of which already
exist" was the sentence a gate reviewer weighs.** Checked against the shipped test tier:
`CONTEXT_FLAG_OWNERS` is exported at `coverage.ts:1718` and **has no consumer anywhere in
`apps/api`**; no test reads a source file for a flag string; and controls 3 and 4 are
TASK-056's, which is deferred. The only mechanism that runs is
`expect(ISOLATION_EXCLUSIONS).toHaveLength(2)`, which counts *declared* exclusions and cannot
detect an undeclared one.

**Wave 1 therefore ships one executing control**, and it is the cheapest honest one: ~~a unit
test that greps `apps/api/src/**/*.ts` (excluding `*.spec.ts`) for `set_config(` first
arguments and asserts the result equals `CONTEXT_FLAG_OWNERS`.~~ That is clause A1 as a live
test rather than a declaration, it gives `CONTEXT_FLAG_OWNERS` its first consumer, and it
needs nothing from TASK-056.

**Corrected 2026-08-13 (F-039). Equality is red on the day it lands. Wave 1 asserts the
subset direction.** Two of the three rows already in `CONTEXT_FLAG_OWNERS`
(`coverage.ts:1718-1722`) name files that do not exist:
`apps/api/src/redirect/db/redirect-read.ts` belongs to TASK-029 and
`apps/api/src/gdpr/privileged-eraser.ts` to TASK-054, both deferred out of this initiative.
`isolation-coverage.md:540-542` records the same thing in as many words: A1 is not runnable
earlier. An equality assertion in wave 1 fails on first run, and the cheap way to get the
build green is to delete the control or weaken it to nothing, which re-opens F-025.

~~The wave 1 control is therefore:~~

> ~~Grep `apps/api/src/**/*.ts`, excluding `*.spec.ts`, for `set_config(` calls whose first
> argument is a string literal beginning `app.`. Every `{ flag, file }` pair found must
> appear in `CONTEXT_FLAG_OWNERS`. Rows in `CONTEXT_FLAG_OWNERS` with no occurrence in the
> scan set are not a failure.~~

~~Two details the equality wording got wrong and this one has to state. The scan set also
contains `statement_timeout` and `idle_in_transaction_session_timeout`
(`tenant-context.ts:217-219`), which are PostgreSQL's own GUCs and are not registry rows, so
the first argument is filtered on the `app.` prefix rather than taken whole.~~ And the match is
on the pair, not the flag alone: a second file setting `app.tenant_id` is exactly the escape
clause A1 exists to catch, and a flag-only subset would pass it.

**Corrected 2026-08-13 (F-044), round 7. This is not a new mechanism, and the round-6 wording
described it as one.** `docs/contracts/isolation-coverage.md:487-542`, frozen, already
specifies four text-scan clauses over exactly this subject: every `set_config(` match in the
scan set, its first argument, and which file may set which flag. Round 6 hit A4's problem
from scratch, that `statement_timeout` and `idle_in_transaction_session_timeout`
(`tenant-context.ts:217-219`) are PostgreSQL's own GUCs and not registry rows, and answered
it with an `app.` prefix filter. **A4 already answers it, with a closed permitted list naming
both and a four-part test for admitting a third name.** Two permitted lists over one scan
drift silently, because each passes on its own terms, and A4's is the one a reviewer finds
first. **The `app.` prefix filter is deleted. The control cites the contract's clauses and
inherits their list rather than restating either.**

The wave 1 control is therefore:

> Clauses **A1** and **A4** of `isolation-coverage.md`, run over the wave-1 scan set:
> `apps/api/src/**/*.ts`, excluding `*.spec.ts`.
>
> For every match of `/set_config\s*\(/` in the scan set, take the first argument as A4
> defines it (`isolation-coverage.md:534-535`: the text between `set_config(` and the first
> following comma, trimmed) and apply **A4's predicate and A4's permitted table verbatim**
> (`isolation-coverage.md:487-501`). A first argument A4 permits as a non-`app` GUC is not a
> registry row, and the control moves on. Every other first argument yields a
> `{ flag, file }` pair, and every such pair must appear in `CONTEXT_FLAG_OWNERS`.
>
> This is **A1's subset direction only**. Rows in `CONTEXT_FLAG_OWNERS` with no occurrence in
> the scan set are not a failure.

The subset direction carries the security claim on its own. What it catches is a new,
unregistered flag setter appearing in `apps/api/src`, which is the only way an escape enters
without a reviewer seeing the registry change. What it does not catch is a registry row that
has gone stale, and a stale row grants nothing.

**Subset now, exactly-one later, and TASK-056 flips it.** A1's exactly-one direction needs
both deferred setters to exist, `redirect-read.ts` (TASK-029) and `privileged-eraser.ts`
(TASK-054), and `isolation-coverage.md:540-542` states in as many words that "A1 is not
runnable earlier." **TASK-056 owns A4's predicate and the full grep tier in the contract, so
TASK-056 is the card that raises this control to A1's full form**: it drops the "rows with no
occurrence are not a failure" clause and asserts exactly-one. It extends this control rather
than replacing it, and the file does not move. Until then the control is half-armed by design
rather than by accident. **Without it, this ADR's narrowness argument rests on four
declarations and nothing else** — the pattern foundation's retro named as decisions whose
validity conditions nothing enforces.

**Text scan, not an AST parse, and that is the contract's choice rather than a shortcut.**
`isolation-coverage.md:527-532`: all four clauses are text scans over file contents, none
parses TypeScript, and none distinguishes code from a comment. A commented-out
`set_config('app.privileged_erase', ...)` is one uncomment from being real, and A2 is built
to fail on it. `apps/api/src/observability/logging-opt-out.spec.ts` runs the TypeScript
compiler for a different assertion with different needs; **it is not the pattern here.**
Rewriting this control onto an AST would break A2's intent quietly, which is why the reason
is recorded rather than left to be rediscovered.

**Where that control lives. Added 2026-08-13 (F-032).** Round 3 decided the control and gave
it no file, so no card owned it and nobody would have written it. That is F-025 again, inside
the fix for F-025.

**`apps/api/src/db/context-flag-owners.spec.ts`, owned by TASK-002, wave 1.** Four constraints
pin that path:

- It is a unit test, and `vitest.config.ts` includes `src/**/*.spec.ts` and nothing else.
  A file under `apps/api/test/` never runs under `pnpm test`, which is the command the
  `quality` job runs.
- `src/db/rls.ts` renders every policy that reads these flags, so `src/db/` is where the
  registry belongs. `src/db/client.spec.ts` and `src/db/client-logging.spec.ts` are the
  sibling-spec precedent for a cross-cutting assertion filed there.
- TASK-002 already owns `src/db/rls.ts`, `src/db/client.ts`, `test/isolation/coverage.ts` and
  `src/auth/membership-lookup.ts`, so the control, the flag it adds and the list it asserts
  against all land in one commit. TASK-002's `paths` name files rather than globs, so this
  path is an added entry rather than one already covered.
- It imports `CONTEXT_FLAG_OWNERS` from `../../test/isolation/coverage`.
  `apps/api/src/observability/framework-400-request-body.spec.ts:12` is the precedent for a
  `src` spec importing from `test/`, and `apps/api/tsconfig.json` includes both trees.

The scan set excludes `*.spec.ts`, which is also what keeps this file's own literal
`set_config(` occurrences out of its own result. The fourth row it asserts against is
`{ flag: 'app.membership_lookup_user', file: 'apps/api/src/auth/membership-lookup.ts' }`,
added to `CONTEXT_FLAG_OWNERS` at `coverage.ts:1718-1722` by the same card.

The four controls, with what actually runs marked:

1. **Clause A1** — `app.membership_lookup_user` is set in exactly one file in the scan set,
   `apps/api/src/auth/membership-lookup.ts`. It is the **fourth** flag, not the third:
   `CONTEXT_FLAG_OWNERS` (`coverage.ts:1718-1722`) already holds `app.tenant_id`,
   `app.redirect_context` and `app.privileged_erase`, so this adds a fourth row and a fourth
   permitted `app.` name (corrected 2026-08-13, F-006).
2. **Clause A2** — the string appears in exactly that file and `rls.ts`.
3. **The `databaseTransaction` file list** in `tenant-context.md` grows from four paths to
   five, and TASK-056's grep asserts set equality.
4. **New: `withMembershipLookup` is imported by exactly one file**,
   `apps/api/src/auth/tenant-id-for-user.ts`, and `tenantIdForUser` by exactly one,
   `apps/api/src/auth/auth.config.ts`. File-level and by grep, like control 3 and for the
   same reason. This is what stops a request-path caller reaching the escape; there is no
   runtime guard.

## Alternatives considered

| Option | Pros | Cons | Why not |
|---|---|---|---|
| Denormalise the tenant id onto Better Auth's `user` table via `user.additionalFields`, written by `onUserCreated`, read by `definePayload` from the `user` object | **No database read at mint time at all**, no third flag, no third exclusion, exclusion count stays at two. Cheapest by a wide margin | The column would be named `tenantId`. `check-policies.mts`'s cross-check reads `pg_attribute` for a column named literally `tenant_id`, so `user` keeps its exemption while carrying tenant data — the guardrail is defeated by camelCase. Naming it `tenant_id` instead makes the cross-check refuse the exemption and demand RLS on `user`, and Better Auth's login-by-email lookup runs with no tenant context, so sign-in returns zero rows for everyone. It also creates a second source of truth for a fact `UNIQUE (user_id)` was chosen to make structural, with no constraint keeping the two equal | Honest naming breaks authentication; dishonest naming defeats the check. ADR-0015 rejected the same shape for the RLS half of this reason and the naming half is worse |
| A separate lookup table `user_tenant_index(user_id text PRIMARY KEY, tenant_id uuid)`, unscoped | Keeps `tenant_memberships` purely tenant-scoped | It carries a `tenant_id` column, so `check-policies.mts` refuses to exempt it and demands the standard policy set, which puts it back behind `app.tenant_id`. Exempting it needs the same camelCase evasion as above. And it duplicates the row `tenant_memberships` already holds, without the unique constraint that makes the cardinality structural | Same dead end, plus a second copy of the data |
| A `SECURITY DEFINER` function owned by `shortkit_migrator` returning the tenant id | No new flag, no new policy, no application-side escape | `FORCE ROW LEVEL SECURITY` applies policies to the table owner too, so a definer function running as the owner is still filtered — it works only if its owner holds `BYPASSRLS`, which `assertRuntimeRoleCannotBypassRls` exists to forbid. Worse, an escape expressed as a function body is invisible to `check-policies.mts`, to the four grep clauses and to the `pg_policies` shape assertion | Moves the escape somewhere no control can enumerate it, and needs the one role attribute the boot check refuses |
| Make `tenant_memberships` a second cascade root with a bespoke policy set instead of `tenantScopedPolicies()` | One policy set instead of a template plus an addendum | Contradicts GC-A, GC-E and TASK-002's card, all of which fix `tenantScopedPolicies('tenant_memberships')`, and removes the standard isolation policy that in-tenant member reads will need in item 1b. It also does not avoid the second predicate: the mint-time read has no tenant whatever the policy set is called | Changes an approved shape without removing the problem |
| Read `tenant_memberships` through `databaseTransaction` and accept zero rows | No design at all | `tid` is never minted, no token works, the product does not function | Not an option; recorded because it is what the code does if nobody decides |

## Consequences

### Positive

- `tenantIdForUser` reads exactly one row, chosen by the caller's own authenticated user id,
  inside a read-only transaction, under a policy that cannot return a second row.
- The escape is enumerable by every mechanism the repository already has: a named policy in
  `pg_policies`, a named flag under clauses A1 to A4, a named file in the
  `databaseTransaction` list, and a named entry in `ISOLATION_EXCLUSIONS`.
- `tenant_memberships` keeps its standard isolation policy, so item 1b's member-list reads
  need no new policy work.
- The failure mode of an orphaned `user` row stays exactly what ADR-0015 specified: no
  membership row, no `tid`, no token.

### Negative / accepted cost

- **The exclusion count goes from two to three, and "exactly two" appears in five artifacts
  that all become wrong**: `rls.ts:72`, `rls.ts:87`, `coverage.ts:490-499`,
  `cross-tenant-isolation.int-spec.ts:1360-1368`, and `tenant-context.md`'s "Deliberate
  exclusions" table plus its "**`ISOLATION_EXCLUSIONS` stays at two**" sentence. Each is a
  deliberate edit in TASK-002's commit, and each is a place a future reader can find a stale
  count if one is missed.

  **Two of those edits are more than a number** (added 2026-08-13, F-007 and F-008).
  `rls.ts:10-19`'s header enumerates the three permitted flag strings by name and calls
  itself exhaustive — `membershipLookupPolicy()` puts a fourth string in that file, so the
  header is false in the same commit unless it moves. And the AC-12 test is *titled*
  "AC-12: exactly two isolation exclusions are declared"; moving only the assertion leaves a
  green test whose name contradicts what it asserts, which is what a reader greps for. The
  title and its comment move with the number.
- **ADR-0015 argued against the `user.tenant_id` alternative partly on the grounds that
  "SC-1's exclusion count is exactly two".** That argument no longer distinguishes. The
  alternative is still rejected, for the stronger reason in the table above, but an accepted
  ADR's stated reasoning is weakened by this decision and that is recorded rather than
  quietly outgrown.
- ~~A third flag~~ **A fourth flag** (F-006) means one more thing a reviewer has to hold in
  mind when reading a policy, and clause A4's permitted-name list is now four `app.` flags
  rather than three.
- **The narrowing control on the caller is a grep over file names, not a type or a runtime
  guard.** Any module can import `withMembershipLookup`; nothing throws if a controller
  does. The guarantee is that the import is a reviewed diff, and TASK-056 is what turns it
  into an assertion — until then it is a rule.
- The escape returns a tenant uuid for any user id the caller supplies. In the mint path the
  user id is the authenticated subject, so this is not a leak. ~~if the file-level control
  ever fails, the leak is a routing identifier rather than tenant data.~~

  **Corrected 2026-08-13 (F-025). That sentence is true in one direction only and understates
  the failure.** Measured: in a transaction where **both** `app.tenant_id` (tenant A) and
  `app.membership_lookup_user` (tenant B's user) are set, a whole-table read returned two rows
  — A's own and tenant B's complete membership row, `tenant_id`, `user_id` and `role`.
  PostgreSQL ORs permissive policies. So a second setter of the lookup flag anywhere on a
  request path is **a cross-tenant read of tenant data**, not of a routing identifier. That is
  what the file-level control is holding back, and it is a larger thing than this ADR said.

  Two adjacent claims were re-measured and both hold: `FOR SELECT` does **not** widen `UPDATE`
  or `DELETE` — both returned zero rows under the same two flags, because PostgreSQL requires
  the `ALL`/`UPDATE` `USING` policy independently of `SELECT` visibility — and
  `SET TRANSACTION READ ONLY` does block a write to the RLS-exempt auth tables
  (`cannot execute UPDATE in a read-only transaction`).
- `withMembershipLookup` takes a pooled connection for the duration of a token mint, so
  token minting now competes with request handling for the ten connections `POOL_MAX`
  allows. A 5-minute token lifetime means roughly twelve mints an hour per active session
  (ADR-0014).
- The `pg_policies` shape assertion that would reject an unapproved policy is TASK-056's and
  does not exist. Until it does, nothing mechanically checks that
  `tenant_memberships_membership_lookup` is the policy this ADR describes rather than a
  wider one someone edited. `check-policies.mts` asserts `ENABLE` and `FORCE` and reads no
  policy body.

### Follow-ups this creates

- TASK-002 writes `membershipLookupPolicy()` in `rls.ts`, hand-appends its statement to
  migration `0001` beside `tenantScopedPolicies('tenant_memberships')`, writes
  `membership-lookup.ts` and `tenant-id-for-user.ts`, adds the fifth entry to `client.ts`'s
  docblock caller list, adds the third `ISOLATION_EXCLUSIONS` entry, and corrects the
  five "exactly two" sites — plus **`rls.ts`'s own header docblock at lines 10-19**, which
  names the three permitted flag strings and calls itself exhaustive (F-007), and the
  **AC-12 test's title and comment** (F-008).
- TASK-002 also carries ADR-0049's repair, which lands in the same `rls.ts` and the same
  migration: the `nullif` predicates, the three `DROP POLICY`/`CREATE POLICY` pairs for
  `tenants`, the `check-policies.mts` cast control, and `controls.ts:130`.
- TASK-002 ships three integration controls in
  `apps/api/test/auth/tenant-memberships.int-spec.ts`. **Corrected 2026-08-13 (F-004): the
  two originally specified here could not observe F-003.** Both were written with no
  reference to connection state, both are true on a cold backend, and
  `test/support/rls-fixture.ts` seeds through the migrator DSN, which leaves the application
  pool cold — so both would have gone green over the blocker. **Connection state is the
  variable, so every control names it:**

  1. **Warm-connection mint.** Commit a `withTenantTransaction` first, in the same process
     and the same pool, then call `tenantIdForUser` and assert it resolves to the right
     tenant id. This is the only control that would have failed before ADR-0049 and it is
     the one that matters. `POOL_MAX` is 10, so the test must either exhaust or pin the pool
     to guarantee the mint reuses a used backend rather than a fresh one — asserting on a
     connection you did not choose is asserting on luck.
  2. **Warm-connection isolation.** In the same state, with the lookup flag set to user A, a
     whole-table read returns exactly A's row and not tenant B's. Verified by hand:
     it returns one row.
  3. **Warm-connection zero rows.** In the same state, with no flag set at all, the read
     returns zero rows rather than raising. This is the assertion that was untrue before
     ADR-0049, and it is AC-10's shape rather than this escape's.

  A refusal is not a pass in any of the three: row-level security denies a read by returning
  zero rows and never by raising, so a test that throws proves nothing
  (`isolation-coverage.md`, corrected statement 2). A `22P02` here is the blocker, not a
  denial.
- TASK-056 (deferred): clause A1's flag table gains a third row; the
  `databaseTransaction` file list gains a fifth path; control 4 above becomes an assertion.
  **Added 2026-08-13 (F-044), round 7:** and `apps/api/src/db/context-flag-owners.spec.ts`
  goes from A1's subset direction to A1's full exactly-one form, once `redirect-read.ts`
  (TASK-029) and `privileged-eraser.ts` (TASK-054) exist. TASK-056 extends that file rather
  than replacing it, and drops the "rows with no occurrence are not a failure" clause. This
  bullet is the only place that obligation is recorded, because TASK-056 is deferred out of
  this initiative and has no card here.
- `docs/contracts/tenant-context.md` is amended in this initiative — the fifth consumer,
  the third exclusion, and the four-versus-three caller-count note at `client.ts:21-22`
  that was already stale.
