---
id: ADR-0050
slug: identity-membership
title: Better Auth's five tables get their own database role, and shortkit_app is revoked on them
status: accepted
supersedes: null
supersedes_in_part: ADR-0044, ADR-0046
amends: ADR-0031, ADR-0002
date: 2026-08-13
---

> **Revised 2026-08-13 (F-028, F-030, F-031), round 4.** Three changes, all inside this ADR's
> own decision: ADR-0046 is now named as superseded in part, because this ADR decides the
> second pool ADR-0046 rejected; the claim that
> `assertRuntimeRoleCannotBypassRls` "runs for both runtime roles" was false and is corrected;
> and `assertAuthRoleSeparation` asserted `SELECT` on one table per direction, which is
> ADR-0044's read-half error reproduced inside the ADR written to correct it. The assertion
> now covers the whole privilege set over the whole exempt list. Measured, both.

## Context

ADR-0044 refused a role split and priced the refusal in reads. The security auditor executed
the write half, and it was re-measured here independently. From tenant A's ordinary
`withTenantTransaction`, `app.tenant_id` set correctly, as `shortkit_app`:

```
UPDATE "account"  SET password='OWNED'           WHERE user_id='user-b'   -> UPDATE 1
INSERT INTO "session" (id, token, user_id, ...)
       VALUES ('forged','ATTACKER-CHOSEN','user-b', now()+'30 days')      -> INSERT 0 1
UPDATE "user"     SET email='attacker@evil.test' WHERE id='user-b'        -> UPDATE 1
```

`session.token` is the credential, stored in plaintext. A forged row with a chosen token is a
working session for another tenant's user, obtained without their password, without mail and
without a token. **The blast radius of a SQL defect in `apps/api` is account takeover, not
credential disclosure.**

The premise is unchanged from ADR-0044's (a SQL defect somewhere in `apps/api`) so the
probability is the same. What changed is the consequence, and it changed the answer.

Juano reversed ADR-0044's refusal at the round-3 gate on 2026-08-13, accepting the cost the
refusal was avoiding.

## Decision

**A second database role, `shortkit_auth`, owns access to Better Auth's five tables.
`shortkit_app` is revoked on all five. Better Auth connects as `shortkit_auth` and nothing
else does.**

### The grant matrix

| Role | `tenants`, `tenant_memberships`, every future tenant-scoped table | `user`, `session`, `account`, `verification`, `jwks` |
|---|---|---|
| `shortkit_app` | `SELECT, INSERT, UPDATE, DELETE`, bounded by RLS | **none** |
| `shortkit_auth` | **none** | `SELECT, INSERT, UPDATE, DELETE` |
| `shortkit_migrator` | owns everything, runs DDL, holds no `BYPASSRLS` | same |

`shortkit_app` keeps `BYPASSRLS = false` and owns nothing. `shortkit_auth` is created with
the same three properties: `NOBYPASSRLS`, not a superuser, owns no table in schema `public`.

~~`assertRuntimeRoleCannotBypassRls` is unchanged and now runs for both runtime roles.~~

**Corrected 2026-08-13 (F-030). That sentence was false.**
`assertRuntimeRoleCannotBypassRls` takes no argument (`apps/api/src/db/rls.ts:137`) and
reaches the database only through `databaseTransaction`, which is the application pool. It
covers `DATABASE_URL` and nothing else, and it stays that way. Its three verdicts all open
with the literal `DATABASE_URL connect`, and `main.ts:47`'s `RLS_VERDICT_PREFIX` matches on
that string to tell an unsafe answer from a failure to answer. Generalising the wording to
cover a second DSN breaks that match in the expensive direction: an unrecognised verdict is
treated as unreachable, retried for the full twenty-second budget, and then refused with a
less precise line.

**The auth role's role attributes are asserted by `assertAuthRoleSeparation` instead**, which
already has to open a connection on the auth pool for its second direction and reads
`pg_roles` in the same round trip. Two functions, two DSNs, two verdict prefixes, each
message naming the DSN that failed. Verified that the prefixes do not collide:
`'DATABASE_AUTH_URL connects as x'.startsWith('DATABASE_URL connect')` is `false`.

### The DDL, and why it is per-table

`ALTER DEFAULT PRIVILEGES FOR ROLE shortkit_migrator IN SCHEMA public GRANT ... TO
shortkit_app` (`docker-compose.yml:334-337`) grants `shortkit_app` DML on **every** table the
migrator creates, forever, including these five. So the split cannot be expressed as a
default privilege. Migration `0001` carries it explicitly, immediately after creating each
auth table:

```sql
REVOKE ALL PRIVILEGES ON "user", "session", "account", "verification", "jwks"
  FROM shortkit_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "user", "session", "account", "verification", "jwks"
  TO shortkit_auth;
```

**This is F-239 in reverse and it has F-239's failure mode**: a sixth auth table added later
is granted to `shortkit_app` by the default privilege and revoked by nobody, and nothing
fails. Which is why the next paragraph exists.

### The control that makes it real

`apps/api/scripts/check-policies.mts` gains a grant-matrix assertion, run by CI's
`integration` job alongside the policy check. For every table in schema `public`:

```sql
SELECT c.relname,
       has_table_privilege('shortkit_app',  c.oid, 'SELECT,INSERT,UPDATE,DELETE')
       OR has_any_column_privilege('shortkit_app',  c.oid, 'SELECT,INSERT,UPDATE') AS app_dml,
       has_table_privilege('shortkit_auth', c.oid, 'SELECT,INSERT,UPDATE,DELETE')
       OR has_any_column_privilege('shortkit_auth', c.oid, 'SELECT,INSERT,UPDATE') AS auth_dml
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relkind IN ('r','p')
```

The assertion: a table is in `EXEMPT` **if and only if** `auth_dml` is true and `app_dml` is
false, and every other table has `app_dml` true and `auth_dml` false. `has_table_privilege`
reads the catalogue and is not privilege-filtered, so it answers for a role other than the
connected one, the same property that made `pg_attribute` the right source in F-213.

**Three things about that predicate, all measured on a scratch database (round 4, F-031).**

1. A comma-separated privilege list is **ANY-of**, not ALL-of. With only `INSERT` granted on
   `session`, `has_table_privilege('shortkit_app','session','SELECT,INSERT,UPDATE,DELETE')`
   returns `true`. So the two directions that carry the security property are the negative
   ones, where `false` means "holds none of the four", and the two positive directions read
   stricter than they are. They are availability, not security.
2. **`has_table_privilege` alone does not see a column-level grant.** With
   `GRANT SELECT (email) ON "user" TO shortkit_app`, the table-level call returns `false`
   while `SELECT email FROM "user"` as `shortkit_app` returns the row. That is why
   `has_any_column_privilege` is `OR`ed in. It is one extra term and it closes a grant a
   reviewer can write by hand.
3. **`has_any_column_privilege` rejects `DELETE`** with `unrecognized privilege type:
   "DELETE"`, because `DELETE` is not column-grantable. Its list is the three that are. Do not
   copy the four-privilege string into it; it raises rather than returning false.

The `EXEMPT` membership check also asserts that all five names are **present** in the result
set. A table that does not exist contributes no row, so a missing migration would otherwise
read as a satisfied matrix.

This turns ADR-0044's `EXEMPT` list from a list of tables with no policy into a list of
tables with a different owner, checked both ways. **An exemption now has to be earned twice**,
and a sixth auth table that nobody revoked fails the check rather than passing it.

### Two pools, and what bounds them

`apps/api/src/db/client.ts` stays the only file constructing a Drizzle client and now builds
two pools:

| Pool | DSN | Reached through | Max |
|---|---|---|---|
| application | `DATABASE_URL` | `databaseTransaction` | 10 |
| auth | `DATABASE_AUTH_URL` | `betterAuthDatabase()` (ADR-0046) | 5 |

Both carry the `pool.on('error')` and `pool.on('connect')` listeners verbatim: a missing one
takes the process down on a scale-to-zero or an `idle_in_transaction_session_timeout`, which
is what F-123 and F-137 each cost a finding to establish. `closeDatabase()` ends both.

The auth pool is 5 rather than 10 because it serves sign-in, sign-up, sign-out and token mint
rather than every request, and because the two ceilings now add: fifteen connections per
instance where there were ten. That is a capacity decision and it is stated rather than
inherited.

**This supersedes ADR-0046 in part (F-028).** ADR-0046 decided that `betterAuthDatabase()`
is built from the same pool as `databaseTransaction`, and its Alternatives table rejected a
second pool on the cost "doubles the effective connection ceiling without doubling the
database's". That cost is accepted here, verbatim, in the bullet three sections down. The
rejection was made against a single-role model, where a second pool bought a true sentence in
a docblock and nothing else. With two roles, a pool is how a process holds a role, and one
pool on `DATABASE_URL` cannot read `user` at all once migration `0001` runs. ADR-0046 carries
a correction block over the four sentences this falsifies; its narrowed-export decision, its
`transaction: false` and its one-caller rule are untouched.

**Where the second pool is constructed.** `apps/api/src/db/client.ts`, beside the first, not
in `auth.config.ts`. ADR-0046's Alternatives row named `auth.config.ts` as the location and
that part of the rejection stands: `client.ts` remains the only file in `apps/api` that
constructs a Drizzle client or a `pg.Pool`.

### GC-B: the new declared variable

`DATABASE_AUTH_URL` is a **declared binding, required unconditionally in every environment**.
It has no enumerated value set (it is a DSN) so GC-B's obligation here is the other half:
an unset value binds to nothing and **fails boot everywhere**, with no `NODE_ENV` consulted
and no fallback to `DATABASE_URL`. A fallback is the failure mode this entire ADR exists to
close: it would silently restore `shortkit_app` as the auth role and every gate would stay
green.

**Which TASK declares it, and in which wave. Added 2026-08-13 (F-034), ruled by Juano.**
A boot assertion is only as early as the binding it asserts. `client.ts` constructs the auth
pool on this DSN in wave 1 and Better Auth reads through it from wave 2, so TASK-018 declares
the variable in wave 0, before anything can read it:

- **TASK-018, wave 0** adds `DATABASE_AUTH_URL` to `docker-compose.yml`'s `api` service
  `environment:` block (`docker-compose.yml:227-228`, which carries `DATABASE_URL` and
  nothing else today), beside the `CREATE ROLE shortkit_auth` work that card already owns in
  the same file. The same card adds it to `apps/api/test/support/auth-fixture.ts`, which
  spawns the API child process the integration tier boots and where `DATABASE_URL` arrives
  through `appDsnOrThrow()`. `docker-compose.test.yml` has **no `api` service**. It is
  Postgres alone, so its share is the role block and the export lines in its header comment.
- **TASK-009, wave 4** keeps `apps/api/.env.example` and `README.md`. Documentation can lag
  the binding by four waves and break nothing.

Declaring in wave 4 costs two waves of red, measured against the repository rather than
inferred. `.github/workflows/ci.yml:382-386` makes `compose` one of three jobs the required
`gate` fans in, and `scripts/check-compose-stack.sh:109` declares AC-115.3 on the API
reaching a healthy state. So waves 2 and 3 would ship an `api` container that refuses to boot
and a required check nobody can turn green. The cheapest repair under that pressure is a
fallback to `DATABASE_URL`, which is what the paragraph above refuses.

Neither `DATABASE_AUTH_URL` nor `BETTER_AUTH_SECRET` (ADR-0051) goes in
`apps/web/.env.example`. That file is a Vercel project's environment, with its own access
list and its own audit trail, and `apps/web` reads neither value.

### The boot assertion

`assertRuntimeRoleCannotBypassRls` proves a negative about privilege. The split needs the
same shape, and TASK-004's boot assertions gain it.

~~```
assertAuthRoleSeparation():
  as shortkit_app:  has_table_privilege(current_user, 'session', 'SELECT') must be FALSE
  as shortkit_auth: has_table_privilege(current_user, 'tenant_memberships', 'SELECT') must be FALSE
```~~

**Replaced 2026-08-13 (F-031). The form above proves the wrong negative, and it is
ADR-0044's error reproduced inside the ADR written to correct it.** The attack this split
exists to close is an `INSERT`. `account` and `jwks` were not checked at all. Constructed and
measured: `REVOKE ALL` on the five, then a hand-written `GRANT INSERT ON "session" TO
shortkit_app`: a revoke that reasoned about the read half.

```
has_table_privilege('shortkit_app','session','SELECT')                     -> false  (PASSES)
has_table_privilege('shortkit_auth','tenant_memberships','SELECT')         -> false  (PASSES)
INSERT INTO "session" (id,token,user_id) VALUES (...) as shortkit_app      -> INSERT 0 1
```

A working session credential of the attacker's choosing for another tenant's user, with the
boot assertion green. Under the full privilege set the same state reads
`has_table_privilege('shortkit_app','session','SELECT,INSERT,UPDATE,DELETE') -> true`, and
the assertion fires.

**The form that holds. The whole privilege set, over the whole list, in both directions.**

```
assertAuthRoleSeparation():

  on the APPLICATION pool, as shortkit_app:
    for each t in EXEMPT (user, session, account, verification, jwks):
      NOT (has_table_privilege(current_user, t, 'SELECT,INSERT,UPDATE,DELETE')
           OR has_any_column_privilege(current_user, t, 'SELECT,INSERT,UPDATE'))

  on the AUTH pool, as shortkit_auth:
    for each tenant-scoped table t in schema public:
      NOT (has_table_privilege(current_user, t, 'SELECT,INSERT,UPDATE,DELETE')
           OR has_any_column_privilege(current_user, t, 'SELECT,INSERT,UPDATE'))
    AND rolbypassrls = false
    AND current_setting('is_superuser') = 'off'
    AND it owns no table in schema public
```

The negated ANY-of list is exactly the "holds none of the four" assertion wanted, and it is
the same one line. The column term is the F-031 measurement in point 2 above.

**Both directions read the catalogue in one query each, not one call per table name.**
`has_table_privilege('shortkit_app','jwks_not_yet','SELECT')` on a table that does not exist
raises `relation "jwks_not_yet" does not exist` (`42P01`), which `main.ts` cannot tell from a
driver error. So each direction joins `pg_class` and `pg_namespace` the way the CI check
does, and a table that is absent produces no row. The exempt direction then additionally
requires the five names to be present, and reports "migrations have not run against
`DATABASE_AUTH_URL`" when they are not. That verdict is distinct from a privilege verdict on
purpose: the two call for opposite responses, which is F-245's rule applied one level down.

**Verdict wording and how `main.ts` reads it.** Every verdict `assertAuthRoleSeparation`
reaches on its own begins with the literal `DATABASE_AUTH_URL connect`. `main.ts` gains
`AUTH_VERDICT_PREFIX = 'DATABASE_AUTH_URL connect'` beside `RLS_VERDICT_PREFIX`, and a third
`BootPrecondition` member, `'auth_role_separation'`. The reachability half is retried on the
same budget and by the same loop as precondition 2, for the same reason: a cold Neon wake is
not a wrong grant. Measured that the two prefixes do not collide, in both directions.

A one-directional check passes on a database where `shortkit_auth` was granted everything, so
both directions run and both refuse.

**What this assertion still cannot see.** It reads grants, not statements. A `SECURITY
DEFINER` function owned by `shortkit_migrator` would let either role reach the other's tables
with no grant of its own, and none exists today. The behavioural proof is the integration
tier's, where a statement is actually issued.

### Cross-role integrity: measured, not assumed

Three things had to hold or the split breaks signup, and all three were measured against the
revoked grants:

| Question | Result |
|---|---|
| Can `shortkit_app` `INSERT` into `tenant_memberships` with an FK to a `"user"` row it cannot `SELECT`? | **Yes.** `INSERT 0 1`. Referential-integrity triggers run with the referenced table's owner's rights, not the caller's |
| Is a bogus FK still rejected? | **Yes.** `violates foreign key constraint "tenant_memberships_user_id_fkey"` |
| Does `ON DELETE CASCADE` from `"user"` into `tenant_memberships` work as `shortkit_auth`, which cannot read that table? | **Yes.** `DELETE 1` |
| Is the takeover closed? | **Yes.** `ERROR: permission denied for table account`, from the same transaction that succeeded before |

The third result is a property worth naming rather than celebrating: **`shortkit_auth`
deleting a `user` row writes into a tenant-scoped table by cascade, with row security
bypassed.** `rls-policy-template.md` invariant 5 already records that referential actions
bypass RLS; this is a second role that can now trigger one.

## Alternatives considered

| Option | Pros | Cons | Why not |
|---|---|---|---|
| Per-table `REVOKE INSERT, UPDATE, DELETE ON session, account FROM shortkit_app`, keeping `SELECT` and one role | No new role, no second DSN, no second pool, no compose change. Closes the takeover: writing a session row is what makes it takeover | Better Auth writes all five tables **as `shortkit_app`**, so revoking write from `shortkit_app` revokes it from Better Auth. Sign-in cannot create a session, sign-up cannot create a user | The role that must lose the write is the role that needs it. Stated because ADR-0044 left the write half unconsidered and a reader will reach for this first |
| Keep one role; add a `BEFORE INSERT OR UPDATE` trigger on `session` and `account` rejecting statements outside Better Auth's call path | No provisioning change | A trigger cannot see a call path. Any discriminator it could read (a GUC, a session variable) is settable by the same connection the attacker already controls | Defends against a bug, not against the defect class this is about |
| Row-level security on the five tables with a policy keyed on a new `app.auth_context` flag | Uses the mechanism already in place; no second role | Better Auth's login-by-email lookup runs before any context exists, so the flag would have to be set for the whole auth surface: a policy that is on whenever it matters is `USING (true)` with extra steps. ADR-0044 already refused that shape | A policy that is always satisfied is a lie in the catalogue, which is the thing `check-policies.mts` exists to catch |
| Do nothing, accept it, deploy nothing until it is fixed | Zero cost now | The refusal is what is under review, and ADR-0030's "no deploy target" was already the argument for accepting it. It does not survive the corrected consequence | Reversed by Juano's ruling |

## Consequences

### Positive

- **A SQL defect anywhere in `apps/api` cannot forge a session row, cannot overwrite a
  password hash and cannot change an email address.** Measured: `permission denied for table
  account` from the exact transaction that succeeded before.
- The `EXEMPT` list stops being "tables with no policy" and becomes "tables another role
  owns", asserted in both directions by a catalogue read. That is a stronger claim than
  ADR-0044's length control and it subsumes it.
- `privilegedTenantEraser` (TASK-054) is forced to declare which role it deletes `user` rows
  as, instead of inheriting the answer.
- The compose stack, the CI provisioning SQL and the integration fixture all describe the
  same two-role model, so a database that grants too much fails a check rather than passing
  quietly.

### Negative / accepted cost

- **ADR-0031's role model is reopened**, which is exactly what ADR-0044 refused to do. Every
  artifact listed below changes. ~~and the ones with no owning TASK are the ones that will be
  missed.~~ Amended 2026-08-13: all eleven now have an owning TASK and three of them moved
  into wave 1 to get one. The cost of that is wave 1 grew, which is the cost of the split
  being real rather than described.
- **Fifteen connections per instance rather than ten.** The two ceilings add. On a small
  Postgres this is the number that matters, and no code path enforces the sum.
- **A second DSN is a second credential** to provision, rotate and keep out of logs, in a
  repository whose deploy story is `infra/deploy.sh` running from a working copy
  (ADR-0004, F-142). `DATABASE_AUTH_URL` will live in a developer's shell alongside
  `DATABASE_MIGRATION_URL`.
- **The `REVOKE`/`GRANT` pair is hand-written per table in a migration, exactly like the
  policy DDL, and forgetting it fails open.** The grant-matrix check is what catches it, and
  that check runs in the `integration` job, not at generation time, and not in the `quality`
  job.
- **`shortkit_auth` can write tenant data by cascade.** Deleting a `user` row removes that
  user's `tenant_memberships` row with row security bypassed. It cannot be used to reach
  another tenant's data selectively, but it is a second role with a cascade path into
  tenant-scoped tables and no policy stands in it.
- **The split does not protect `jwks`.** `shortkit_auth` must read the signing key, so any
  defect in the auth path still reaches it, and F-020's default secret is what decides
  whether that row is useful. ADR-0051 is the other half of this and neither is sufficient
  alone.
- **Two roles is a shape every future table has to be assigned to**, and the assignment is
  not obvious for a table that both sides touch. There is no such table today. The first one
  needs an ADR, not a judgement call in a migration.
- Local development gains a required environment variable that did not exist. Anyone with a
  working checkout gets a boot failure on their next pull, which is correct and will still
  read as a regression.
- **Boot now has three preconditions instead of two, and the third is the first one that
  needs a second connection before the process serves.** Added 2026-08-13 (F-030, F-031).
  `main.ts` gains a second verdict prefix and a third `BootPrecondition` member, so the
  string-matching arrangement F-245 introduced is now duplicated rather than shared. Two
  prefixes that must not collide is a thing to get wrong; it is checked by construction today
  and by nothing at build time.
- **The boot assertion reads grants, not statements.** It cannot see a `SECURITY DEFINER`
  function, and it cannot see what a role does with a privilege it legitimately holds. It
  proves the matrix, and the matrix is a proxy for the property.

### Follow-ups this creates

Every artifact the split touches, and the wave it lands in:

| Artifact | Change | Owning TASK | Wave |
|---|---|---|---|
| `apps/api/drizzle/0001_*.sql` | `REVOKE`/`GRANT` for the five tables | TASK-002 | **1** |
| `apps/api/scripts/check-policies.mts` | grant-matrix assertion | TASK-002 | **1** |
| `apps/api/src/db/client.ts` | second pool, `DATABASE_AUTH_URL`, both listeners, `closeDatabase` | TASK-002 | **1** |
| `apps/api/src/db/rls.ts` | unchanged. `assertRuntimeRoleCannotBypassRls` stays parameterless and `DATABASE_URL`-only (F-030) | n/a | n/a |
| `apps/api/src/auth/boot-assertions.ts` | `assertAuthRoleSeparation()`, both directions, full privilege set | TASK-004 | 3 |
| `apps/api/src/main.ts` | `AUTH_VERDICT_PREFIX`, third `BootPrecondition`, the retried call | TASK-004 | 3 |
| `.github/scripts/provision-test-database.sql` | `shortkit_auth` in CI's database, and its grants | ~~wave-1 provisioning TASK~~ TASK-018 | ~~**1**~~ **0** |
| `apps/api/test/support/rls-fixture.ts` | its role-and-grant preconditions | ~~wave-1 provisioning TASK~~ TASK-018 | ~~**1**~~ **0** |
| `apps/api/scripts/seed.mts` | its grant docblock | ~~wave-1 provisioning TASK~~ TASK-018 | ~~**1**~~ **0** |
| ~~`docker-compose.yml`~~ | ~~`shortkit_auth` role, its grant, `DATABASE_AUTH_URL` on the api service~~ | ~~TASK-009~~ | ~~4~~ |
| ~~`docker-compose.test.yml`~~ | ~~the same role and grant~~ | ~~TASK-009~~ | ~~4~~ |
| ~~`.env.example`, `README.md`~~ | ~~the new variable~~ | ~~TASK-009~~ | ~~4~~ |
| `docker-compose.yml` | `shortkit_auth` role, its grant, **and `DATABASE_AUTH_URL` on the `api` service** | TASK-018 | **0** |
| `docker-compose.test.yml` | the same role and grant. No `api` service, so no `environment:` entry | TASK-018 | **0** |
| `apps/api/test/support/auth-fixture.ts` | `DATABASE_AUTH_URL` on the spawned API child process | TASK-018 | **0** |
| `apps/api/.env.example`, `README.md` | the new variable, documented. **Not `apps/web/.env.example`** | TASK-009 | 4 |
| `scripts/check-compose-stack.sh` | asserts the two-role model comes up | TASK-017 | 9 |

The three `wave-1 provisioning TASK` cells and the three `TASK-009` rows are struck rather
than edited: the first three name a card that had no id when this ADR was written, and the
second three name a wave that F-034 showed makes a required check red for two waves. Both
were resolved by the same ruling, 2026-08-13.

### The plan amendment this needed, and Juano's ruling on it

**Ruled 2026-08-13, round 4.** The three artifacts this ADR escalated as unowned get an
owning TASK, and **CI role provisioning moves into wave 1**. The three rows above are written
against that ruling rather than against the wave table as it stood.

~~**Reported, not made.**~~ The reasoning that produced the escalation is kept because it is
why the ruling went the way it did: CI's `integration` job provisions its database from
`.github/scripts/provision-test-database.sql`, so without `shortkit_auth` there, every
integration test connecting as the auth role fails to authenticate. That put wave-1 work
(`client.ts`'s second pool, `0001`'s `REVOKE`) in a state nothing could exercise until wave 4.
TASK-002 could not go green, and the cheapest way to make it green would have been to drop the
`REVOKE`.

Two consequences of the move, both accepted:

- **Wave 1 now provisions a role that nothing connects as until wave 2.** The provisioning is
  inert for one wave. That is the correct direction for the inertness to run; the reverse is
  the state above.
- **The order inside wave 1 is load-bearing.** Provisioning lands before or with TASK-002's
  migration. A `GRANT ... TO shortkit_auth` against a role that does not exist fails with
  `role "shortkit_auth" does not exist`, and it fails at migration time rather than at boot.

The TASK id is the Plan's to assign; this ADR names the three paths and the wave.
