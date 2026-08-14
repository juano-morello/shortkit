---
id: TASK-002
story: STORY-001
epic: EPIC-001
title: Better Auth tables, tenant_memberships with its unique constraint, and tenantIdForUser
status: tests-red
owner_slot: sdlc-implementer-backend
depends_on: [TASK-018]
# TASK-018 ADDED 2026-08-13 at the Design wave-1 gate. It creates `shortkit_auth` in wave 0;
# this card's migration 0001 GRANTs to that role. The edge is hard — a forward-only migration
# on a database that has already applied 0000 fails with `role "shortkit_auth" does not exist`.
paths: ["apps/api/src/db/schema/auth.ts", "apps/api/src/db/schema/tenant-memberships.ts", "apps/api/src/db/schema/index.ts", "apps/api/src/db/schema/auth.spec.ts", "apps/api/drizzle/**", "apps/api/src/auth/tenant-id-for-user.ts", "apps/api/src/auth/membership-lookup.ts", "apps/api/src/db/rls.ts", "apps/api/src/db/client.ts", "apps/api/scripts/check-policies.mts", "apps/api/test/isolation/registrations.ts", "apps/api/test/isolation/coverage.ts", "apps/api/test/isolation/cross-tenant-isolation.int-spec.ts", "apps/api/test/isolation/controls.ts", "docs/architecture/rls.md", "apps/api/src/db/context-flag-owners.spec.ts", "apps/api/test/tenancy/warm-connection-no-context.int-spec.ts", "apps/api/test/security/security-headers.int-spec.ts"]
# security-headers.int-spec.ts ADDED 2026-08-14 by Juano, F-084. It was in NO card's paths. Its
# throw names two DSNs, and it spawns an API child with its OWN env callback rather than
# authServerEnv() - so from THIS wave that child needs DATABASE_AUTH_URL the message never
# mentions. THIRD instance of the same defect across three fixtures, each found by a different
# auditor in a different round. Text and env only; do not touch its assertions.
# paths WIDENED 2026-08-13 by Juano at the Design wave-1 gate, F-002. Six files its own design
# requires and its original declaration did not reach. THE WAVE TABLE IS UNCHANGED: TASK-001 is
# packages/contracts/** only, so wave 1 stays parallel-safe, and every other claimant of these
# files (003 w2, 005 w4, 014 w8, 015 w9) is strictly later. A declaration gap, not an ordering one.
# WIDENED A SECOND TIME 2026-08-13, F-010, after design round 1 moved the fix into the shared
# RLS template, which has more consumers than the new policy did. controls.ts and
# docs/architecture/rls.md are live sites of the old predicate. Neither is claimed by another
# TASK. WITHOUT controls.ts, F-009 IS UNFIXABLE AND THE HARNESS GOES ON PROVING ISOLATION
# AGAINST THE PREDICATE ADR-0049 REPLACED - green, because the old form isolates correctly on a
# cold connection, which is the only state the fixture creates.
# WIDENED A THIRD TIME 2026-08-13, round 5, F-032's remainder: the two control spec files.
# apps/api/test/tenancy/ was in NO card's paths — verified across all eighteen. Consuming
# rls-fixture.ts is not editing it, so that file stays TASK-018's; if the behavioural control
# turns out to need a fixture change, that is a wave-0 edit and not this card's.
contracts: [design/contracts/rls-policy-template.md, design/contracts/isolation-coverage.md, design/contracts/tenant-context.md]
test_files: ["apps/api/src/db/context-flag-owners.spec.ts (unit — ADR-0045's grep control, the ONE executing control wave 1 ships and the entire basis on which F-025 was closed)", "apps/api/test/tenancy/warm-connection-no-context.int-spec.ts (integration — ADR-0049's behavioural control)", "apps/api/src/auth/tenant-id-for-user.spec.ts (unit)", "apps/api/test/auth/tenant-memberships.int-spec.ts (integration)", "apps/api/test/isolation/cross-tenant-isolation.int-spec.ts (isolation, registration only — the assertions there are TASK-015's)"]
acceptance: [AC-2, AC-4]
# AC-4 IS HALF TASK-003's, found 2026-08-13 by the test architect while writing its tests. The
# clause "when a JWT is minted ... no JWT is returned, and the caller receives an error rather than
# a token with an absent tid" NEEDS THE MINT PATH, which is TASK-003 in wave 2. This card can only
# cover tenantIdForUser throwing - the primary stop ADR-0015 names. AC-4 needs a second test in
# TASK-003's wave or it goes green on a partial proof. Recorded rather than silently re-scoped.
rework_count: 0
---

## Intent

Put Better Auth's own tables and the `tenant_memberships` table into the one migration
system, with the unique constraint that makes one-tenant-per-user structural and the single
lookup that turns a user id into a `tid` claim.

## Approach

**One migration, three obligations, one commit.** `tenant_memberships` is a tenant-scoped
table, so it owes all three of these in the same commit or the build fails:

1. its `tenant_id` column declared through `TENANT_ID_COLUMN_SQL`
   (`apps/api/src/db/rls.ts:103-104` — `tenant_id uuid NOT NULL REFERENCES tenants(id) ON
   DELETE CASCADE`),
2. the output of `tenantScopedPolicies('tenant_memberships')` (`apps/api/src/db/rls.ts:57-80`)
   hand-appended to the migration drizzle-kit generates, because **Drizzle Kit generates no
   policy DDL** (`rls.ts:6-8`),
3. a `registerTenantScopedSurfaces()` call in `apps/api/test/isolation/registrations.ts`
   naming the table, its owner column and its access methods.

`pnpm db:check-policies` fails on a missing (2); the isolation harness's registry-versus-
database cross-check fails the run on a missing (3). **Splitting any of the three into a
follow-up is a defect, not a sequencing choice.** F-239 is the reason the split is unsafe in
time as well as in review: `ALTER DEFAULT PRIVILEGES` grants `shortkit_app` full DML on
every table the migrator creates, so a new table is writable by the runtime role before any
policy exists for it.

**Better Auth's tables carry no `tenant_id` and no row-level security.** ADR-0013 fixes
that, ADR-0003 explains why it is not a GC-5 exception, and
`apps/api/scripts/check-policies.mts` already names `user`, `session`, `account`,
`verification` **and `jwks`** — **FIVE entries, not four**. Corrected 2026-08-13 at the Design
wave-1 gate; `jwks` was added by F-232 on 2026-08-07, so the `jwt` plugin's table is already
listed. **Add no entry to that list.** Per ADR-0044 you add only the `EXEMPT.size !== 5`
length control. The script's own docblock still says "None of the four exist yet" and is
stale in the same way — that correction is yours, filed as F-001.

`apps/api/src/db/schema/auth.ts` is Better Auth's schema for the pinned `1.6.26` with the
`jwt` and `bearer` plugins enabled, checked in and owned from then on by drizzle-kit
(ADR-0013). ADR-0013 says it is generated once with the Better Auth CLI. **Do not guess the
column naming.** `apps/api/test/support/auth-fixture.ts:19-27` records that nothing in
`design/**` or `tasks/**` fixes whether the generated column is `emailVerified` or
`email_verified`, and the fixture discovers column names from `pg_attribute` for exactly
that reason. Whatever this file declares is what that fixture will find.

`tenant_memberships` follows ADR-0015 exactly: `id uuid PRIMARY KEY DEFAULT
gen_random_uuid()`, `tenant_id` per (1) above, `user_id text NOT NULL REFERENCES "user"(id)
ON DELETE CASCADE`, `role tenant_role NOT NULL`, `created_at timestamptz NOT NULL DEFAULT
now()`, and `CONSTRAINT tenant_memberships_user_unique UNIQUE (user_id)`. **`user_id` is
`text`** — Better Auth's shape, not this repository's uuid convention — and it is the only
non-uuid foreign key in the schema. `tenant_role` is a Postgres enum carrying exactly
`owner`, `admin`, `member`, per ADR-0015 amendment A-8.

The barrel at `apps/api/src/db/schema/index.ts` gains `export * from './auth';` and
`export * from './tenant-memberships';`, alphabetically. Drizzle Kit reads a glob over the
directory and does not import the barrel, so a forgotten line still produces a correct
migration and is caught only by ADR-0019's cross-check — add both lines.

`tenantIdForUser(userId)` is the single-row lookup on the unique index that ADR-0013's
`definePayload` calls at mint time and ADR-0015 requires to **throw** when no membership row
exists. It runs at token-mint time, when no tenant context is open and no `tid` is known —
that is the chicken-and-egg ADR-0013 names, and it is why this function exists at all. How
it reaches the database without an ambient tenant context, given that
`apps/api/src/db/client.ts:11-23` exports only `databaseTransaction` against an enumerated
caller list, is a **Design decision** and is listed for the architect. Whatever Design rules,
the caller list in `client.ts` is normative and this TASK does not widen it unilaterally.

Migration ordering: this is migration `0001`. TASK-011 adds `workspaces` as a later
migration. Two TASKs generating migrations concurrently would collide on drizzle's
`_journal.json`, which is why TASK-011 depends on this one.

## The role split and the flag wrapper — added 2026-08-13, Design rounds 3 and 4

**Everything in this section arrived after the Plan gate.** It comes from a measured
account-takeover (F-024), Juano's reversal of ADR-0044's refusal, and the `nullif` wrapper
ADR-0049 introduced. None of it was in this card before the Design gate, which is what F-032
was. Read ADR-0049, ADR-0050 and the amended `rls-policy-template.md` before starting.

**Migration `0001` drops and recreates FOUR policies on `tenants`, not three.**
`tenants_self_select`, `tenants_self_update`, `tenants_self_insert` **and
`tenants_privileged_erase`**. The fourth is the one round 3 left out and round 4 put back
(F-029): `apps/api/drizzle/0000_odd_betty_ross.sql:33-34` already ships it in the raw
`current_setting('app.privileged_erase', true)` form, ADR-0004 is forward-only, and the
counting control rejects that form — so omitting it turns `pnpm db:check-policies` red in
this wave. `redirectReadPolicy` is **not** in `0001`: it has no applied instance, so its
correction is to `apps/api/src/db/rls.ts:89-100` and nothing else.

**The wrapper goes on three predicates in `tenantScopedPolicies()`** — the isolation `USING`,
the isolation `WITH CHECK`, and `<t>_privileged_erase`'s `USING` — plus
`redirectReadPolicy()`'s one. `rls.ts:74-76` is the raw site that would otherwise create
`tenant_memberships` in a form the control rejects, in this same wave.

**Migration `0001` also carries the role split.** `REVOKE ALL PRIVILEGES ON "user",
"session", "account", "verification", "jwks" FROM shortkit_app`, and the matching `GRANT` to
`shortkit_auth`. **`shortkit_auth` is created by TASK-018 in wave 0** — this card does not
create it, and without wave 0 the `GRANT` fails with `role "shortkit_auth" does not exist`.

**`client.ts` gets a SECOND POOL, and this is the trap in the whole wave.** The auth pool
connects on `DATABASE_AUTH_URL`, max 5, with both connection-error listeners, and
`closeDatabase()` ends both pools. **ADR-0046 alone will lead you to build one pool on
`DATABASE_URL`, and that build is wrong.** ADR-0046 was written against the single-role model
and is now `superseded_in_part_by: ADR-0050`; read its correction block. One pool on
`DATABASE_URL` connects as `shortkit_app`, which this migration has just revoked on all five
auth tables, so Better Auth cannot read `user` and nobody can sign in. **If sign-in is
failing, the answer is the auth pool. Do not touch the `REVOKE`** — deleting it restores the
cross-tenant session forgery this split exists to close, and the CI check that would catch
that runs in the `integration` job, not `quality`.

**`check-policies.mts` gains two assertions.** The counting control runs over **every** row
of `pg_policies` in schema `public` — not a list of repaired names, because a list only ever
covers what was known when it was written.

Plus the grant matrix, **in both directions** (F-035 — ADR-0050 decides two and this card
originally stated one): all five `EXEMPT` names present, and for each, `shortkit_app` holding
none of `SELECT,INSERT,UPDATE,DELETE`; **and** `shortkit_auth` holding none of the same on
the tenant-scoped tables. A one-directional matrix proves the auth tables are closed to the
app role while saying nothing about the app tables being closed to the auth role, and the
second is what stops the new role becoming a way around RLS. Use `has_table_privilege`
**OR'd with** `has_any_column_privilege` — a column-level grant is invisible to the
table-level call, measured — and note `has_any_column_privilege` rejects `DELETE` with
`unrecognized privilege type`, so its list is three.

**Two controls, and they are the reason two earlier findings are closed.** Added 2026-08-13,
round 5, after the round-4 re-review found F-032 only four-sixths done: both were cited by
ADRs and neither had a file, a card or a `test_files` entry anywhere.

- `apps/api/src/db/context-flag-owners.spec.ts` (unit) — runs clauses **A1 and A4** of
  `isolation-coverage.md` over the wave-1 scan set: every `set_config(` first argument in
  `apps/api/src` is checked against **A4's permitted list**, and every one naming a flag
  asserts its **`{ flag, file }` pair** appears in `CONTEXT_FLAG_OWNERS`, imported from
  `../../test/isolation/coverage`.

  *(Corrected 2026-08-13, F-044. This sentence previously said "keeps only those with the
  `app.` prefix" — the round-6 wording — while the sub-bullet below forbade exactly that.
  The architect caught the card contradicting itself in nine lines. An implementer reading
  top-down would have written the filter the ruling deleted.)*

  **This is the wave-1-runnable half of clauses A1 and A4, not a new mechanism** (F-044,
  ruled 2026-08-13). `design/contracts/isolation-coverage.md:487-537` — a **frozen contract,
  already in this card's `contracts:` list** — specifies four text-scan clauses over exactly
  this subject. Read them before writing the test; this control cites them and does not
  restate them.

  - **Inherit A4's permitted list. Do not write an `app.` prefix filter.** A4 already names
    `statement_timeout` and `idle_in_transaction_session_timeout` as legitimate non-`app`
    GUCs, with the four-part test a candidate must pass to join them. An independent filter
    here is a second permitted list that drifts from the contract's silently.
  - **Match on the `{ flag, file }` pair, not the flag alone** — a second file setting an
    already-registered flag is the case A1 exists to catch, and a flag-only match sails past
    it.
  - **Subset now, exactly-one later.** A1's exactly-one direction needs `redirect-read.ts`
    (TASK-029) and `privileged-eraser.ts` (TASK-054), both deferred out of this initiative;
    the contract says in as many words that "A1 is not runnable earlier". TASK-056 flips this
    control to A1's full form rather than replacing it.
  - **Text scan, not an AST parse, and that is deliberate.** The contract states it: none of
    the four clauses parses TypeScript or distinguishes code from a comment, because a
    commented-out setter is one uncomment from being real and A2 is built to fire on it.
    `apps/api/src/observability/logging-opt-out.spec.ts` uses the TypeScript compiler for a
    different assertion with different needs — **do not take it as the pattern here.**

  **A subset, not an equality** (F-039, corrected 2026-08-13 round 6). `coverage.ts:1718-1722`
  holds three rows and two name files that do not exist yet — `redirect-read.ts` (TASK-029)
  and `privileged-eraser.ts` (TASK-054), both deferred out of this initiative. An equality
  assertion would be **red on the day it lands**, and the cheap way to make a red build green
  is to delete the control — which re-opens F-025. The subset direction carries the entire
  security claim: it is what catches a new, unregistered flag setter. **The equality
  direction is TASK-056's**, gated on TASK-029 and TASK-054 landing the other two setters —
  corrected 2026-08-13 (F-044); this line previously said "whichever TASK lands the second
  setter", which names the enabling condition rather than the owner, and disagreed with the
  sub-bullet above.

  **It must live under `src/**`**: `vitest.config.ts:10`
  includes `src/**/*.spec.ts` and nothing else, so the same file under `test/` would collect
  in no tier and pass by not running. Precedent for a `src` spec importing from `test`:
  `apps/api/src/observability/framework-400-request-body.spec.ts:12`.
  **This is the one executing control wave 1 ships**, it gives `CONTEXT_FLAG_OWNERS` its
  first consumer, and F-025 — "an ADR cites four controls and none of them executes" — was
  closed on the strength of it. Skip it and that finding reopens.
- `apps/api/test/tenancy/warm-connection-no-context.int-spec.ts` (integration) — ADR-0049's
  behavioural control: a warm, no-context `SELECT` returns zero rows. **Scope it to the tables
  `has_table_privilege(current_user, c.oid, 'SELECT') OR has_any_column_privilege(current_user,
  c.oid, 'SELECT')` says this role can read** — both terms, matching ADR-0050's grant matrix,
  because a column-level grant is invisible to the table-level call (measured, F-031) and a
  column-granted table would otherwise drop out of the set and take the sixth-auth-table
  property with it. Do not widen the `'SELECT'` argument: `has_any_column_privilege` accepts
  only the three column-grantable privileges and raises on `DELETE`. Not scoped
  to every table in `public`: after migration `0001` the five exempt tables answer
  `permission denied` (42501) to `shortkit_app`, not zero rows, so the naive form fails on
  the day the role split lands. The computed set has a bonus property — a sixth auth table
  nobody revoked stays in it, has no policy, returns rows, and the control fires.

**F-001 is still yours** and is unrelated to the above: `check-policies.mts`'s docblock says
four exempt tables where the Map holds five.

## Your first commit is the six design stubs — added 2026-08-13, Test phase (F-046)

**Before any other work**, copy the six files under `.sdlc/identity-membership/design/stubs/` to
their mirrored paths. The stubs README records they typecheck as-is.

This is not ceremony. Four of the eight spec files written for this wave currently fail with
`Cannot find module` rather than as assertions, because those modules do not exist. The test
architect proved they fail *correctly* once the stubs are present — it copied them in, recorded
the real assertion failures, and deleted them again — and Juano accepted that demonstration at
the Test gate. **Until your first commit lands, `pnpm test` shows four load failures that look
like breakage**, and the test strategy warns in as many words that this is the state someone
"fixes" by deleting a test. Land the stubs and the red becomes legible.

**`apps/api/src/db/auth-schema.spec.ts` does not sit beside the module it pins, deliberately**
(F-045). `drizzle.config.ts:16` globs `./src/db/schema/*.ts` and drizzle-kit `require()`s every
match through its CJS transformer, so a vitest import in that directory **breaks `pnpm
db:generate`** — the command you run first to produce migration `0001`. Measured with a probe
spec, not inferred. `db:migrate` is unaffected. Do not move it back.

**`CONTEXT_FLAG_OWNERS` gains a fourth row** for `app.membership_lookup_user` ←
`apps/api/src/auth/membership-lookup.ts`. `coverage.ts` is in your paths so the row is yours —
but the contract's own flag table and A2's carve-out were amended for it by Juano's ruling on
F-047, because a frozen contract enumerating three flags is not an implementer's to widen. Read
the amended `isolation-coverage.md` before adding the row.

## The exclusion count goes from two to three — SIX sites, added 2026-08-14, Implement pre-flight

`membershipLookupPolicy()` makes `withMembershipLookup` the **third** isolation exclusion.
"Exactly two" is then wrong in six places, and this card previously named none of them —
the implementer works from the card, so a site not listed here is a site that stays stale.

| # | Site | What changes |
|---|---|---|
| 1 | `apps/api/src/db/rls.ts:72` | the count |
| 2 | `apps/api/src/db/rls.ts:87` | the count |
| 3 | `apps/api/src/db/rls.ts:10-19` | **more than a number** — the header enumerates the three permitted flag strings by name and calls itself exhaustive. `membershipLookupPolicy()` puts a fourth string in this file, so the header is false in the same commit unless it moves |
| 4 | `apps/api/test/isolation/coverage.ts:490-499` | the count |
| ~~5~~ | ~~`.sdlc/foundation/design/contracts/tenant-context.md`~~ **ALREADY CORRECT — do not edit.** Verified 2026-08-14 by the TASK-002 scout: its "Deliberate exclusions" table and its `databaseTransaction` consumer list are already at *exactly three* and five consumers, including `withMembershipLookup`. Fixed in an earlier design round; this table was written before that. **Six sites need your edit, not seven.** |
| 6 | `.sdlc/foundation/design/contracts/isolation-coverage.md` | its "Exclusions: exactly two" section and `expect(ISOLATION_EXCLUSIONS).toHaveLength(2)`. **ADR-0045 does not list this one** — it was found on 2026-08-14 by the architect amending that contract for F-047, which deliberately left the bump for this commit rather than making it a wave early |

| 7 | `.sdlc/foundation/design/contracts/isolation-coverage.md:1195` | "Invariants a caller may rely on" item 5: *"Exactly two exclusions exist, both justified in-file and both narrowed by database policy."* **Found 2026-08-14 by the test architect**, after site 6 was already on this card. Site 6 named only the "Exclusions: exactly two" section and its length assertion — this is a different line in the same file |

**DO NOT FIND THESE BY GREPPING `exactly two`. It misses two of the seven.** Verified:
`rls.ts:72` reads `Exclusion 2 of exactly 2`, `rls.ts:87` reads `Exclusion 1 of exactly 2`
(digit, not word), and `coverage.ts:492` reads `EXACTLY TWO.` (upper case). A search for the
literal lower-case phrase returns the two contracts and neither source file. **Work from the
`file:line` table above, not from a search.** `coverage.ts:496` additionally carries "Neither
surface exists yet", prose that stops being true once a third exclusion exists — that is the
same class as site 3's exhaustive-flag header and it moves with the count.

**The AC-12 test at `cross-tenant-isolation.int-spec.ts:1360-1377` is ALREADY DONE and is NOT
yours.** It is a
seventh site and `sdlc-test-architect` moves it **before** you run, by Juano's ruling at the
Implement pre-flight: test files route to the test architect, and a feature implementer
editing a test is the pattern the phase treats as a red flag. It now reads
`toHaveLength(3)`, is titled "exactly three", and its `toEqual` list expects your third id
**`'repo:TenantMembershipLookup.tenantIdForUser'` in third position**. It fails today with
`expected [ … ] to have a length of 3 but got 2`, and it goes green only when you add that
exact id in that position. **Do not edit any file under
`apps/api/test/isolation/*.int-spec.ts`.** Your isolation work is the `registrations.ts` entry
and the `coverage.ts` count, nothing else.

Two of these are more than a number, and that is ADR-0045's own point: a green test whose
*name* says "exactly two" is what a future reader greps for, and an exhaustive-flag header
that is silently no longer exhaustive is the F-009 class. Move the words with the count.

## Out of scope for this TASK

The Better Auth instance and its plugin configuration (TASK-003) — this TASK writes no
`auth.config.ts`. The `workspaces` table (TASK-011). The `memberships` workspace-level table
(item 1b, not built). Any endpoint, any guard, any web code. Endpoint-level isolation
controls (TASK-014, TASK-015) — this TASK's registry entry covers the **table**, and the
assertions in `cross-tenant-isolation.int-spec.ts` are not edited here.

## Interfaces

**Consumes**

From `apps/api/src/db/rls.ts` (shipped):
- `TENANT_ID_COLUMN_SQL: string` — `'tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE'`
- `tenantScopedPolicies(table: string): PolicySet` — four DDL statements plus the `tenant_id` index; table name validated by `assertTableName` against `^[a-z_][a-z0-9_]*$`
- `assertRuntimeRoleCannotBypassRls(): Promise<void>`

From `apps/api/src/db/schema/tenants.ts` (shipped):
- `tenants` — `id uuid PRIMARY KEY` (application-supplied), `name text NOT NULL`, `createdAt timestamptz NOT NULL DEFAULT now()`

From `apps/api/test/isolation/coverage.ts` (shipped):
- `registerTenantScopedSurfaces(registration: TenantScopedSurfaceRegistration): void` — exported at `coverage.ts:614`, called at `registrations.ts:591`
- `interface TenantScopedSurfaceRegistration { subject: string; table: string; ownerColumn: string; reset: () => void | Promise<void>; methods: readonly TenantScopedMethod[] }`
- `interface TenantScopedMethod { ...; qualification: 'owner-qualified' | 'unqualified'; attempt: CrossTenantAttempt }` — `qualification` is **required**, deliberately undefaulted (F-342)
- `tableAccess({ table, ownerColumn, projection, mutableColumn, plantedOwnerId, plantedRow })` from `registrations.ts` — the generic table-attempt builder both existing subjects use

From `packages/contracts/src/roles.ts` (shipped): `TENANT_ROLES`, `TENANT_ROLE`.

**Produces**

- `apps/api/src/db/schema/auth.ts` — Better Auth 1.6.26's tables for the `jwt` and `bearer`
  plugins: `user`, `session`, `account`, `verification` and the plugin's key table. No
  `tenant_id`, no RLS.
- `apps/api/src/db/schema/tenant-memberships.ts` — `export const tenantMemberships` with
  columns `id`, `tenantId`, `userId`, `role`, `createdAt`, and the Postgres enum
  `tenant_role` carrying `owner | admin | member`.
- `apps/api/drizzle/0001_*.sql` — creates every table above, plus the hand-appended
  `tenantScopedPolicies('tenant_memberships')` statement set.
- `apps/api/src/auth/tenant-id-for-user.ts` exporting:
  - `tenantIdForUser(userId: string): Promise<string>` — resolves to the tenant id on that
    user's single `tenant_memberships` row, lower-cased uuid; **throws
    `NoTenantMembershipError` when no row exists.** Never returns `null` and never returns
    an empty string.
  - `class NoTenantMembershipError extends Error` — `name` is `'NoTenantMembershipError'`;
    carries the user id it was asked about and no email address.
- `apps/api/test/isolation/registrations.ts` — one added
  `registerTenantScopedSurfaces()` call for subject `TenantMembershipsTableAccess`, table
  `tenant_memberships`, owner column `tenant_id`.
- `apps/api/src/db/schema/index.ts` — two added `export *` lines.

Added 2026-08-13, Design rounds 3 and 4 — see the role-split section above:

- `apps/api/drizzle/0001_*.sql` — **four** DROP/CREATE policy pairs on `tenants`, including
  `tenants_privileged_erase`; plus `REVOKE ALL PRIVILEGES ON "user","session","account",
  "verification","jwks" FROM shortkit_app` and the matching `GRANT` to `shortkit_auth`.
- `apps/api/src/db/rls.ts` — `nullif(<flag>, '')` on three predicates in
  `tenantScopedPolicies()` and on `redirectReadPolicy()`'s one.
- `apps/api/src/db/client.ts` — a second `pg.Pool` on `DATABASE_AUTH_URL`, max 5, both
  error listeners, ended by `closeDatabase()`; `betterAuthDatabase()` built on it.
- `apps/api/scripts/check-policies.mts` — the counting control over every `pg_policies` row
  in schema `public`, and the grant-matrix assertion with its `has_any_column_privilege`
  term and the all-five-`EXEMPT`-names-present check.
- `apps/api/test/isolation/controls.ts` — the hand-written predicate reconciled with the
  production constant (F-009). Already in this card's `paths` from the F-010 widening.
