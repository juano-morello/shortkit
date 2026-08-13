---
id: ADR-0049
slug: identity-membership
title: A context flag is never cast directly, because a pooled backend resets it to the empty string
status: accepted
supersedes: null
amends: ADR-0003, ADR-0004
date: 2026-08-13
---

## Context

`rls.ts:52-56` states the property every tenant-scoped policy rests on:

> `current_setting(name, true)` — the second argument is load-bearing. Without it an unset
> flag raises rather than returning NULL, and the AC-10 read outside any tenant context
> would fail with an error instead of returning zero rows.

The `true` argument does prevent the *unrecognised parameter* error. It does not prevent the
error that actually occurs, and the difference is the whole of this ADR.

**A transaction-local `set_config` creates a session-level placeholder whose reset value is
the empty string, not NULL.** Measured on the running stack, one session, as
`shortkit_app`:

```
cold: current_setting('app.tenant_id', true) is null = true
BEGIN; select set_config('app.tenant_id','1111...', true); COMMIT;
warm: current_setting('app.tenant_id', true) is null = false ; value = ''
```

`pg.Pool` returns the backend to the pool with no reset query, so the placeholder survives
into every later checkout. From that point
`current_setting('app.tenant_id', true)::uuid` evaluates `''::uuid` and raises `22P02
invalid input syntax for type uuid: ""`.

Reproduced end to end against a scratch database carrying `tenantScopedPolicies()`
verbatim, one session, in order:

| # | Statement | Result |
|---|---|---|
| 1 | out-of-context `select count(*)`, **cold** backend | `0` — AC-10 holds |
| 2 | membership lookup, cold backend | returns the tenant id |
| 3 | ordinary `withTenantTransaction` read | `1` row |
| 4 | out-of-context `select count(*)`, **warm** backend | **`ERROR: invalid input syntax for type uuid: ""`** |
| 5 | membership lookup, warm backend | **same error** |

**Row 4 is wider than the finding that prompted this ADR.** F-003 reports the failure on
the token-mint escape and F-005 reproduces it on `redirectReadPolicy`. Both are true, and
both are instances of something more general: *any* statement against a table carrying
`tenantScopedPolicies()`, on a connection that has previously committed a tenant
transaction, raises when no tenant context is open. That is AC-10's own shape — the
out-of-context read that must return zero rows — failing on the connection state the
application actually runs in. The comment at `rls.ts:52-56` describes the behaviour this
defect removes.

The reviewer declined to choose where the repair belongs and was right to: it is a design
question, not a fix.

## Decision

**No policy expression in this repository casts `current_setting(...)` directly. Every cast
of a context flag goes through `nullif(<flag>, '')` first.**

`tenantScopedPolicies()` in `apps/api/src/db/rls.ts` becomes:

```sql
CREATE POLICY <t>_tenant_isolation ON <t>
  FOR ALL
  USING      (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
```

Unset reads NULL, reset reads `''`, and `nullif` collapses both to NULL. `tenant_id = NULL`
is NULL, which a policy treats as false. **Zero rows, on a cold backend and a warm one
alike** — fail-closed in both states rather than in one.

Verified on the same session that produced the failure above: warm out-of-context read
returns `0`; warm mint lookup returns tenant A's id; with the lookup flag set to `user-a`
a whole-table read returns exactly one row and tenant B's row is not among them; an
unknown user returns `0`; tenant B in its own context sees only its own row.

**The `tenants` policy set carries the same repair, through migration `0001`.** Migration
`0000` is applied, and ADR-0004 is forward-only: a corrected shape is a new migration and
never an edit to an applied one. So `0001` drops and recreates the three policies that
cast:

```sql
DROP POLICY tenants_self_select ON "tenants";
CREATE POLICY tenants_self_select ON "tenants"
  FOR SELECT USING (id = nullif(current_setting('app.tenant_id', true), '')::uuid);
-- and the same for tenants_self_update and tenants_self_insert
```

`tenants_privileged_erase` is untouched: it compares `id::text` against the flag as text and
never casts, so `''` matches nothing and it was always safe. Its shape is what the repair
makes the other three equivalent to, and it is why the eraser's own predicate never had this
defect while the isolation predicate beside it did.

**`redirectReadPolicy` is untouched.** `current_setting('app.redirect_context', true) = 'on'`
is a text comparison; `'' = 'on'` is false. F-005's reproduction on `links` came from the
`tenantScopedPolicies()` policy that `links` also carries, not from the redirect policy, so
repairing the template repairs the redirect path.

### The control that keeps it true

`apps/api/scripts/check-policies.mts` gains an assertion over `pg_policies.qual` and
`pg_policies.with_check` for every table in schema `public`: **no policy expression may
apply a cast directly to `current_setting(...)`**.

The two renderings are distinguishable in the catalogue, checked:

```
unsafe: (id = (current_setting('app.tenant_id'::text, true))::uuid)
safe:   (tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)
```

so the predicate is `/\(current_setting\([^)]*\)\)::/` over the rendered expression. It reads
the database rather than the source, which is what makes it catch a hand-appended migration —
the only way policy DDL enters this system.

This is the mechanism the class needs. The template repair fixes the four policies that
exist; the control is what stops the fifth.

## Alternatives considered

| Option | Pros | Cons | Why not |
|---|---|---|---|
| Repair only the new membership-lookup policy | Smallest diff; touches no foundation-era file; keeps TASK-002 inside its original surface | The new policy is not where the defect is. `redirectReadPolicy`'s table would stay armed, and the redirect path is the one thing in this product that must never return 5xx to a visitor. The privileged eraser stays armed by the same route. Worst of all, AC-10's plain out-of-context read stays broken on every warm connection, which no escape is involved in at all | Repairs the first caller and leaves the cause. F-236's class a fourth time |
| Guard with `AND`: `current_setting(...) <> '' AND tenant_id = current_setting(...)::uuid` | Reads like the obvious fix; no new function; reviewers accept it on sight | **Measured wrong.** Installed verbatim on the scratch table and re-run on a warm session: `ERROR: invalid input syntax for type uuid: ""`. PostgreSQL does not guarantee left-to-right evaluation of `AND` operands and the planner is free to evaluate the cast first, which it does here | The plausible fix that ships green in review and raises in production. Recorded so nobody re-proposes it |
| Compare as text everywhere: `tenant_id::text = current_setting('app.tenant_id', true)` | No cast at all, so nothing to raise; identical to the shape `tenants_privileged_erase` already uses and which was always safe | Casts the **indexed column** rather than the flag, so `<t>_tenant_id_idx` stops being usable for the policy predicate on every tenant-scoped table. It also makes correctness depend on textual form: `assertUuid` lower-cases and PostgreSQL renders `uuid` lower-case, so it works today and breaks silently the day a flag value arrives in another spelling | Trades an index on every read of every table for a property `nullif` gives with the index intact. Verified: under `nullif` the planner still chooses `Bitmap Index Scan on tenant_memberships_tenant_id_idx` |
| Have `withTenantTransaction` reset the flag before COMMIT, or add a `pg.Pool` reset query | Fixes it at the source; policies stay as written | `set_config('app.tenant_id', '', true)` writes the same empty string the reset already produces, so it changes nothing. Writing NULL is not expressible through `set_config`, whose third parameter is `text`. `RESET app.tenant_id` inside the transaction sets it to the placeholder's reset value, which is `''`. A pool-level reset hook would run a statement per checkout on every connection for a property one `nullif` gives for free | The mechanism cannot express what it would need to, and the pool-level version taxes every checkout |
| Declare the GUC in `postgresql.conf` with a valid default uuid | `current_setting` would never be empty | Puts a real tenant id in the server configuration as the fallback every unscoped statement silently uses. Fail-open by construction | The opposite of the property being defended |

## Consequences

### Positive

- The out-of-context read returns zero rows on a warm connection, which is what AC-10 has
  always claimed and what `rls.ts:52-56` says the design intends. It is currently true only
  on a cold one.
- All four escapes — the membership lookup, the redirect read, the privileged eraser and the
  plain no-context read — are fixed by one predicate change, before three of them exist.
- The repair is verified against statements issued under the policies on the connection state
  the pool actually produces, not against the policy set. That is the gap F-236, F-302 and
  F-330 each fell into.
- `check-policies.mts` gains a control that reads the catalogue, so a future hand-appended
  migration that reintroduces a direct cast fails a gate rather than a token mint.

### Negative / accepted cost

- **This amends a foundation-era template that every tenant-scoped table depends on**, in a
  wave whose TASK-002 acquired `rls.ts` in its paths for an unrelated reason. ADR-0003's
  policy text and `rls-policy-template.md`'s normative SQL both change.
- **Migration `0001` contains `DROP POLICY` statements against a table it did not create.**
  ADR-0004 tells a reviewer who sees `DROP` in a generated migration to stop and ask for the
  ADR. This is that ADR. No data is destroyed and no column or table is dropped, so
  ADR-0004's forward-only conditions still hold — but the rule was written to make a human
  look, and a human should look.
- **The isolation harness's canary tables carry a hand-written copy of the production
  predicate** at `apps/api/test/isolation/controls.ts:130`
  (`const TENANT_ID = \`current_setting('app.tenant_id', true)::uuid\``), under a comment
  claiming it comes "from the same production constant". It does not; it is a copy, and it
  has to move with the template or every canary tests a shape the product no longer uses.
  That is F-288's class, found here rather than fixed here, and `controls.ts` is a seventh
  file TASK-002's paths do not reach.
- Any `PolicyShape.qual` string captured from a live database before this change no longer
  matches. `isolation-coverage.md` says those are captured and never hand-written, so the
  correct response is to re-capture — but anything that did hand-write one breaks, and the
  break will read as a harness failure rather than as this change.
- The predicate is longer and a reader has to know why `nullif` is there. The reason is a
  pooling behaviour with no local evidence, so the comment carrying it is load-bearing in the
  way `rls.ts`'s existing comments are.
- **The repair does not extend to a flag compared as text.** `app.redirect_context` and
  `app.privileged_erase` are safe because `''` simply fails to match, which is luck rather
  than design: a future text flag whose empty value is meaningful would be a fail-open with
  no cast to catch it. The new control cannot see that case, because there is no cast to
  match on.
- One `NULLIF` evaluation per row per policy check. Immaterial next to `current_setting`,
  which is already `STABLE` and already evaluated, and the index scan is preserved — but it
  is not zero.

### Follow-ups this creates

- TASK-002: `tenantScopedPolicies()`'s two predicates; the three `DROP POLICY`/`CREATE POLICY`
  pairs for `tenants` in migration `0001`; the `check-policies.mts` cast control; the
  `controls.ts:130` constant.
- **Every live site of the old predicate, swept 2026-08-13.** Four in code, and TASK-002's
  paths reach two of them:

  | Site | Action | In TASK-002's paths? |
  |---|---|---|
  | `apps/api/src/db/rls.ts` (two predicates) | rewrite | yes, after F-002's widening |
  | `apps/api/drizzle/0000_odd_betty_ross.sql` (three policies) | **do not edit** — repaired by `0001` | n/a, forward-only |
  | `apps/api/test/isolation/controls.ts:130` | rewrite the `TENANT_ID` constant | **no — seventh file** |
  | `docs/architecture/rls.md` | rewrite the quoted predicate | **no — eighth file** |

  `.sdlc/identity-membership/tasks/TASK-011.md` also quotes the old predicate in its
  Approach. It is a TASK card and not a design artifact, so it is the orchestrator's to
  correct, not mine.
- **ADR-0003 is frozen and is not edited.** This ADR records the amendment and
  `rls-policy-template.md` carries the corrected normative SQL, which is the same pattern
  ADR-0043 used for ADR-0013. A reader arriving at ADR-0003's policy block will find the old
  form there and nothing pointing here, which is the cost of a frozen-ADR convention and is
  worth naming rather than assuming.
- `rls.ts:52-56`'s comment gains the second half — the `true` argument answers the unset case,
  `nullif` answers the reset case, and on a pooled backend the reset case is the common one.
- `design/contracts/rls-policy-template.md` is amended in this initiative: the per-table
  template, the `tenants` set, and the paragraph at line 104 that states the NULL premise.
- TASK-011 (`workspaces`) and every later tenant-scoped table inherit the repaired template
  with no action.
- TASK-029 and TASK-054, both deferred, no longer need to discover this independently.
