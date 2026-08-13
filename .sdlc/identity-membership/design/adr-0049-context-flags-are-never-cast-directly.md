---
id: ADR-0049
slug: identity-membership
title: A context flag is never compared raw, because a pooled backend resets it to the empty string
status: accepted
supersedes: null
amends: ADR-0003, ADR-0004
date: 2026-08-13
---

> **Widened 2026-08-13 (F-021, F-022), round 3. The rule was about casts and it needed to be
> about comparisons.**
>
> The original decision — "no policy expression casts `current_setting(...)` directly" — is
> right about the mechanism it names and too narrow by one case. **The cast is not what makes
> `''` dangerous; the comparison is.** `membershipLookupPolicy()` compares a text flag with
> no cast, so it passed the original rule, and with one `"user"` row whose `id` is `''` an
> out-of-context read on a warm backend returns that row and **tenant A's ordinary
> transaction returns tenant B's full membership row**. Measured. This ADR named that exact
> hazard class in its own Consequences ("a future text flag whose empty value is meaningful
> would be a fail-open with no cast to catch it") while ADR-0045 shipped the first instance of
> it in the same commit.
>
> **The rule is now: every reference to a context flag inside a policy expression is wrapped
> in `nullif(..., '')`. No exceptions, cast or not.**
>
> And the control was a proxy for the rule rather than the rule. The original regex passed
> `nullif(current_setting(...), 'x')::uuid` and `(current_setting(...) || '')::uuid`, both of
> which still raise. It has been replaced with one that asserts the safe form is **present**
> rather than asserting a blacklist of unsafe forms is absent (F-022).
>
> The file name still says "cast". It is the original scope and the id is referenced
> elsewhere, so it stays.
>
> **Round 4, 2026-08-13 (F-029). The widening did not reach the implementation sections and
> they contradicted it.** Two paragraphs below said `tenants_privileged_erase` and
> `redirectReadPolicy` were untouched, and migration `0001` was specified as three statements
> covering the casting policies only. Under the counting control this ADR now specifies,
> untouched means rejected: the shipped `tenants_privileged_erase` fails it. Both paragraphs
> are struck in place, the migration is four pairs, `tenantScopedPolicies()`'s snippet gains
> the erase policy it had dropped, and the property is stated as a whole-schema assertion.
> **A decision widened in one section and not carried into the sections that implement it is
> the same defect as a control that does not execute, and this ADR now has one of each in its
> history.**

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

**No policy expression in this repository references `current_setting(...)` raw. Every
reference to a context flag is wrapped in `nullif(<flag>, '')`, whether or not it is cast.**

~~No policy expression in this repository casts `current_setting(...)` directly. Every cast
of a context flag goes through `nullif(<flag>, '')` first.~~ Widened 2026-08-13 (F-021):
a text comparison against a raw flag is a fail-open with no cast to catch it, and
`membershipLookupPolicy()` was the first instance. **All four flags take the wrapper:**

```sql
-- app.tenant_id, cast          (tenantScopedPolicies, tenants_self_*)
tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
-- app.membership_lookup_user, text   (membershipLookupPolicy, ADR-0045)
user_id = nullif(current_setting('app.membership_lookup_user', true), '')
-- app.privileged_erase, text         (<t>_privileged_erase, tenants_privileged_erase)
tenant_id::text = nullif(current_setting('app.privileged_erase', true), '')
-- app.redirect_context, text         (redirectReadPolicy)
nullif(current_setting('app.redirect_context', true), '') = 'on'
```

The last two are semantically unchanged — `''` already matched no tenant id and `'' = 'on'`
was already false — and they take the wrapper anyway, because a rule with two exceptions
cannot be checked mechanically and the exceptions are where the next instance will land.

`tenantScopedPolicies()` in `apps/api/src/db/rls.ts` becomes, **both policies, not one**
(corrected 2026-08-13, F-029 — the snippet here previously showed only the isolation policy,
which reads as licence to leave `<t>_privileged_erase` raw):

```sql
CREATE POLICY <t>_tenant_isolation ON <t>
  FOR ALL
  USING      (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY <t>_privileged_erase ON <t>
  FOR DELETE
  USING (tenant_id::text = nullif(current_setting('app.privileged_erase', true), ''));
```

`rls.ts:74-76` emits the second one raw today, for **every** tenant-scoped table, so
`tenant_memberships` would be created by TASK-002 in a form the control rejects on the day
the control lands.

Unset reads NULL, reset reads `''`, and `nullif` collapses both to NULL. `tenant_id = NULL`
is NULL, which a policy treats as false. **Zero rows, on a cold backend and a warm one
alike** — fail-closed in both states rather than in one.

Verified on the same session that produced the failure above: warm out-of-context read
returns `0`; warm mint lookup returns tenant A's id; with the lookup flag set to `user-a`
a whole-table read returns exactly one row and tenant B's row is not among them; an
unknown user returns `0`; tenant B in its own context sees only its own row.

**The `tenants` policy set carries the same repair, through migration `0001`.** Migration
`0000` is applied, and ADR-0004 is forward-only: a corrected shape is a new migration and
never an edit to an applied one. So `0001` drops and recreates **all four** policies on
`tenants`:

```sql
DROP POLICY tenants_self_select ON "tenants";
CREATE POLICY tenants_self_select ON "tenants"
  FOR SELECT USING (id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- and the same pair for tenants_self_update and tenants_self_insert

DROP POLICY tenants_privileged_erase ON "tenants";
CREATE POLICY tenants_privileged_erase ON "tenants"
  FOR DELETE USING (id::text = nullif(current_setting('app.privileged_erase', true), ''));
```

~~`tenants_privileged_erase` is untouched: it compares `id::text` against the flag as text and
never casts, so `''` matches nothing and it was always safe. Its shape is what the repair
makes the other three equivalent to, and it is why the eraser's own predicate never had this
defect while the isolation predicate beside it did.~~

~~**`redirectReadPolicy` is untouched.** `current_setting('app.redirect_context', true) = 'on'`
is a text comparison; `'' = 'on'` is false. F-005's reproduction on `links` came from the
`tenantScopedPolicies()` policy that `links` also carries, not from the redirect policy, so
repairing the template repairs the redirect path.~~

**Struck 2026-08-13 (F-029). Both paragraphs were written against the original narrow rule
and survived the widening fifty lines above them.** The widened decision says all four flags
take the wrapper, and the control counts wrappers. Under that control "untouched" means
"rejected". Measured, using the control exactly as this ADR specifies it, against the real
`pg_policies.qual` renderings from a scratch Postgres 17:

| policy, as rendered by the catalogue | `current_setting(` | wrapped | control |
|---|---|---|---|
| `((id)::text = current_setting('app.privileged_erase'::text, true))` | 1 | 0 | **REJECT** |
| `(current_setting('app.redirect_context'::text, true) = 'on'::text)` | 1 | 0 | **REJECT** |
| `((id)::text = NULLIF(current_setting('app.privileged_erase'::text, true), ''::text))` | 1 | 1 | ACCEPT |
| `(NULLIF(current_setting('app.redirect_context'::text, true), ''::text) = 'on'::text)` | 1 | 1 | ACCEPT |

The first row is `apps/api/drizzle/0000_odd_betty_ross.sql:33-34`, applied. Left alone, `pnpm
db:check-policies` goes red in wave 1 on a database built exactly as this ADR instructed, and
the pressure at that moment falls on the control rather than on the DDL. Loosening a control
to make a build green is the failure this ADR exists to record.

**The two struck paragraphs are still right about the runtime hazard and that is what made
them survive.** Neither policy can raise: `''` matches no `id::text` and `'' = 'on'` is false.
They are rewritten for the rule, not for the bug. A rule with two exceptions cannot be checked
mechanically, and the exceptions are where the next instance lands.

**`redirectReadPolicy` differs from the other three in where the repair goes.** `domains` and
`links` do not exist yet (TASK-023), so there is no applied instance and migration `0001`
carries no statement for it. The change is to `redirectReadPolicy()` in
`apps/api/src/db/rls.ts:89-100`, and every table that later applies it inherits the wrapped
form.

### The property, stated so it can be checked

**No policy in schema `public` survives migration `0001` in a form the counting control
rejects.**

That is one query and it is the assertion, not a description of one: after `0001`, for every
row of `pg_policies` in schema `public`, the count of `current_setting(` in `qual` plus
`with_check` equals the count of the exact wrapper. Migration `0001` therefore accounts for
every applied policy, and the applied set is exactly the four on `tenants`. The control is
run over the whole schema rather than over a list of repaired names, so a policy nobody
thought of fails it rather than being skipped by it.

### The control that keeps it true

`apps/api/scripts/check-policies.mts` gains an assertion over `pg_policies.qual` and
`pg_policies.with_check` for every table in schema `public`.

**Replaced 2026-08-13 (F-022). The original control asserted that a blacklist of unsafe
renderings was absent, and two unsafe forms were not on it.** Measured, four variants
installed and their real `pg_policies.qual` run against the original predicate
`/\(current_setting\([^)]*\)\)::/`:

| policy `USING` clause | raises `22P02` warm | original regex flagged it |
|---|---|---|
| `current_setting(...)::uuid` | yes | yes |
| `CAST(current_setting(...) AS uuid)` | yes | yes |
| `nullif(current_setting(...), 'x')::uuid` | yes | **no** |
| `(current_setting(...) \|\| '')::uuid` | yes | **no** |
| `nullif(current_setting(...), '')::uuid` | no | no (correct) |

Row three is the realistic one: a hand-appended migration copies the repaired pattern with a
wrong sentinel, `pnpm db:check-policies` prints green, and the raise returns on the redirect
path or the token mint. **A control that reports a policy set as repaired when it is not is
the same shape as the round that produced this ADR, one level up, inside the fix.**

The control now asserts the **safe form is present**, which is the decision rather than a
proxy for it. For each policy expression, count occurrences of `current_setting(` and count
occurrences of

```
NULLIF(current_setting('<flag>'::text, true), ''::text)
```

with `<flag>` matching `[a-z_][a-z0-9_.]*`. **The two counts must be equal.** A reference that
is not inside the exact wrapper is unmatched, whatever it is wrapped in instead.

Verified against real `pg_policies.qual` strings for all nine variants — the five above plus
the raw and wrapped text-comparison forms. It rejects every form that raises, accepts the
repaired form, and rejects the two raw text comparisons, which under the widened rule is the
intended answer rather than a false positive: those are F-021's shape.

It reads the database rather than the source, which is what makes it catch a hand-appended
migration — the only way policy DDL enters this system.

**A syntactic control over a rendered expression is still a proxy, and this is what it does
not see.** It cannot tell that `nullif(current_setting('app.tenant_id', true), '')` is
compared against the right column, and it cannot see a flag reached by any route other than
`current_setting` — a function wrapper, a view, a stable helper. The behavioural control
below is what covers those; the syntactic one is what runs on every migration.

**Add the behavioural control beside it, in the test tier.** ~~For every table in schema
`public`~~ **For every table in the set defined below**, on a connection that has committed
one transaction-local `set_config` of each declared flag, issue a no-context `SELECT` and
require zero rows rather than a raise. That
control cannot be evaded by rendering, and it is the state F-004 already established the
test tier must construct.

**Where it lives, and over which tables. Added 2026-08-13 (F-032).** Round 3 decided this
control and gave it no file, so no card owned it and nobody would have written it.

**`apps/api/test/tenancy/warm-connection-no-context.int-spec.ts`, owned by TASK-002, wave 1.**
It issues statements against a live database as `shortkit_app`, so it takes the `.int-spec.ts`
suffix `vitest.integration.config.ts` matches. That config's own guard fails the run on an
integration suite named outside the glob, and its `fileParallelism: false` means a new file
costs wall clock rather than a race on the shared fixture tables. No card holds
`apps/api/test/tenancy/` in its `paths`, and `tenant-context.int-spec.ts` beside it already
constructs the warm-backend state this control needs (`:536`, F-121) while asserting
something else about it.

**The table set is computed, not listed, and it is not all of schema `public`.** The
control connects as `shortkit_app`, and migration `0001` revokes every privilege on `user`,
`session`, `account`, `verification` and `jwks` from that role (ADR-0050). Those five answer
`permission denied for table <t>` (`42501`), not zero rows, so a control written over the
whole schema asserts the opposite of the property on the day the role split lands. The set is
therefore every `relkind IN ('r','p')` table in schema `public` where
~~`has_table_privilege(current_user, c.oid, 'SELECT')` holds, which is the catalogue predicate
ADR-0050's grant matrix already uses.~~

**Corrected 2026-08-13 (F-042). The predicate is the table-level call `OR` the column-level
one, because that is what the matrix became in round 4:**

```sql
has_table_privilege(current_user, c.oid, 'SELECT')
OR has_any_column_privilege(current_user, c.oid, 'SELECT')
```

`has_table_privilege` alone does not see a column-level grant (ADR-0050, F-031 point 2,
measured: `GRANT SELECT (email) ON "user" TO shortkit_app` returns `false` from the
table-level call while the read succeeds). Under the single-term predicate a column-granted
table drops out of the computed set, which is precisely the sixth-auth-table property claimed
below: the table stays readable, carries no policy, returns rows to the no-context `SELECT`,
and the control has to be in scope to fire on it.

`has_any_column_privilege` accepts only the three column-grantable privileges and raises
`unrecognized privilege type: "DELETE"` on the four-privilege string. `'SELECT'` alone is
column-grantable, so the term above is safe as written; do not widen it by copying a
`DELETE`-bearing list into it.

Computing the set beats listing it, for a reason beyond the maintenance. A sixth auth table
that nobody revoked stays in the set, carries no policy, and returns rows to the no-context
`SELECT`. This control fires on that, which is the F-239 failure mode, as well as on its own.

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
- **Widened 2026-08-13 (F-029): four pairs, not three, and the fourth is the only `DELETE`
  path on `tenants`.** `tenants_privileged_erase` is dropped and recreated for a rule rather
  than for a bug: it never raised and `''` never matched an id. The cost is a `DROP` against
  the policy that guards tenant erasure, bought to keep the control mechanical. Between the
  `DROP` and the `CREATE` there is no `DELETE` policy on `tenants` at all, which is fail-closed
  and is why the two statements are adjacent and in one migration.
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
- ~~**The repair does not extend to a flag compared as text.** `app.redirect_context` and
  `app.privileged_erase` are safe because `''` simply fails to match, which is luck rather
  than design: a future text flag whose empty value is meaningful would be a fail-open with
  no cast to catch it. The new control cannot see that case, because there is no cast to
  match on.~~

  **This bullet described the hole and the same commit shipped it (F-021).** The instance was
  `membershipLookupPolicy()`, one file away, comparing `app.membership_lookup_user` as text
  against `user_id` — where a `"user"` row with `id = ''` makes the empty value meaningful
  and returns that row cross-tenant. Widened above: every flag takes the wrapper, and the
  control counts wrappers rather than looking for casts. **Writing a hazard down in a
  Consequences section is not the same as checking whether the artifact beside it has that
  hazard, and that is the lesson worth more than the fix.**
- One `NULLIF` evaluation per row per policy check. Immaterial next to `current_setting`,
  which is already `STABLE` and already evaluated, and the index scan is preserved — but it
  is not zero.

### Follow-ups this creates

- TASK-002, corrected 2026-08-13 (F-029): `tenantScopedPolicies()`'s **three** predicates
  (isolation `USING`, isolation `WITH CHECK`, and `<t>_privileged_erase`'s `USING`);
  `redirectReadPolicy()`'s one predicate; the **four** `DROP POLICY`/`CREATE POLICY` pairs for
  `tenants` in migration `0001`; the `check-policies.mts` counting control and the
  whole-schema property above; the `controls.ts:130` constant. **Added 2026-08-13 (F-032):
  and `apps/api/test/tenancy/warm-connection-no-context.int-spec.ts`, the behavioural
  control, which is a new file in TASK-002's `paths` and a new entry in its `test_files`.**
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
