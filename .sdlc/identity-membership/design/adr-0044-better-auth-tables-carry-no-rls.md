---
id: ADR-0044
slug: identity-membership
title: Better Auth's five tables carry no row-level security, and shortkit_app keeps full DML on all of them
status: accepted
supersedes: null
amends: null
date: 2026-08-12
---

## Context

ADR-0013 says "auth tables carry no `tenant_id` and no RLS" and points at ADR-0003 for why
that is not a GC-5 exception. Neither ADR says what it costs, and the cost has grown since
they were written, because `docker-compose.yml:334-337` now grants the runtime role DML on
every table the migrator creates:

```sql
ALTER DEFAULT PRIVILEGES FOR ROLE shortkit_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO shortkit_app;
```

That is F-239. It is written once and applies forever, so the five tables this initiative
migrates are readable and writable by `shortkit_app` from the moment they exist, in every
request, in every tenant's context, with no policy standing between a statement and a row.

What is in them, measured against `better-auth@1.6.26`:

| Table | The sensitive column | What reading one row gives an attacker |
|---|---|---|
| `user` | `email` | Every operator's address. GC-G bans `email` from log lines; the database has no such rule |
| `session` | `token` | **The session credential itself, stored in plaintext.** A read is a session takeover for as long as the row lives |
| `account` | `password` | The password hash. Offline cracking, and credential reuse against other services |
| `jwks` | `privateKey` | The token-signing key, **symmetrically encrypted with `BETTER_AUTH_SECRET`** (`plugins/jwt/utils.mjs:46-54`). A row alone is not a signing key; a row plus the environment variable is |
| `verification` | `value` | Verification and reset tokens. Empty in this initiative, since verification is off |

The scope of the read is the whole table, not one tenant's slice. There is no `tenant_id` to
filter on and no predicate to write, which is exactly why the exemption exists.

`apps/api/scripts/check-policies.mts` already names all five. The plan says the list "names
four tables today and the `jwt` plugin adds a fifth"; F-232 added `jwks` on 2026-08-07 and
the list holds five. Nothing needs adding.

## Decision

**The five tables stay exempt. No policy is written for any of them, and no grant is
revoked.**

`user`, `session`, `account`, `verification` and `jwks` are the complete set, and it is
complete because `getSchema({ plugins: [jwt(), bearer()] })` returns exactly those five
(ADR-0043). TASK-002 changes no entry in `EXEMPT`.

**TASK-002 adds one control to `check-policies.mts`: the exemption list is closed at five.**

```ts
// The list is the whole of the security argument, so its LENGTH is the control.
// A sixth exemption arrives as a one-line diff a reviewer sees, with an ADR.
if (EXEMPT.size !== 5) { /* fail */ }
```

Same shape as `ISOLATION_EXCLUSIONS`'s length assertion and `SUITE_OWNED_CONTROL_TABLES`'s
closed list, and for the same reason: naming a real product table in `EXEMPT` is how this
script gets defeated, and the existing `pg_attribute` cross-check only catches the case
where the table carries a column literally named `tenant_id`.

**No `USING (true)` policy.** Writing `ENABLE ROW LEVEL SECURITY`, `FORCE ROW LEVEL
SECURITY` and `CREATE POLICY ... USING (true)` on these tables would make
`check-policies.mts` print `ok user` while enforcing nothing. An exemption that a reader can
see is strictly better than a policy that lies, and the script's own header says so about
its exception list.

## Alternatives considered

| Option | Pros | Cons | Why not |
|---|---|---|---|
| Split the database role: a `shortkit_auth` role holding DML on the five auth tables, `shortkit_app` REVOKEd on them, and vice versa | The real fix. A tenant request path could not read `session.token` or `account.password` at all, whatever a SQL defect let it issue | A second role in `docker-compose.yml`, `docker-compose.test.yml`, `.github/scripts/provision-test-database.sql`, `seed.mts`, `rls-fixture.ts` and `check-compose-stack.sh`; a second DSN, which is a new declared variable under GC-B with its own boot assertion; and a second `pg.Pool`, which duplicates the `pool.on('error')` and `pool.on('connect')` listeners that took F-123 and F-137 to get right. `ALTER DEFAULT PRIVILEGES` grants `shortkit_app` on every new table by default, so each auth table needs an explicit per-table `REVOKE` in the migration — F-239 in reverse, with the same "forget it and nothing fails" property | Reopens ADR-0031's role model and touches three TASKs in three waves to protect against a defect class this initiative does not otherwise have. **Recorded as the mitigation that exists and is not taken**, with its trigger below |
| Column-level `REVOKE SELECT (password) ON account FROM shortkit_app` and similar | Cheap; no new role | Better Auth reads `account.password` on every sign-in and writes `jwks.privateKey` on first key generation, as `shortkit_app`. Revoking the column breaks authentication | The role that must be denied the column is the role that needs it |
| Put a `tenant_id` on `user` and give it the standard policy set | One consistent rule for every table | ADR-0015 already rejected this: Better Auth's login-by-email lookup runs before any tenant is known, so the row it needs would be invisible and sign-in would fail for everyone | Rejected in an accepted ADR, for a reason that still holds |
| `ENABLE`/`FORCE` plus a permissive `USING (true)` policy on all five | `check-policies.mts` goes green with no exception list at all | The script would report five protected tables that are not protected. That is the exact false green the script exists to catch, moved inside the script | An exemption a reader can count beats a policy that lies |

## Consequences

### Positive

- The exemption list stops being an open-ended list and becomes a closed one with a length
  assertion, so a sixth entry cannot arrive quietly.
- No change to the role model, the compose stack, the provisioning SQL or the pool, so
  nothing in waves 3 through 9 has to move.
- The five names are derived from `getSchema()` rather than remembered, so the list and the
  migration cannot disagree about which tables exist.

### Negative / accepted cost

- **Any SQL defect anywhere in `apps/api` reads every session token, every password hash and
  every email address in the system, regardless of which tenant's request it is running
  under.** Row-level security bounds the blast radius of such a defect on every product
  table and bounds none of it on these five. This is the accepted cost and it is the largest
  one in this initiative.
- The compensating controls are conventions, not mechanisms. Statements are built with
  `sql` template interpolation, which binds parameters, and `client.ts` exposes no raw
  query path — but nothing fails a build if a future TASK writes string-concatenated SQL
  against `user`.
- `jwks.privateKey`'s encryption moves the secret from the database into the environment. It
  does not remove it. A process that can read the row can usually also read
  `process.env.BETTER_AUTH_SECRET`.
- SC-1's coverage claim now has a stated hole that is bigger than it was: the isolation
  harness attacks tenant-scoped tables, and five of the seven tables this initiative ships
  are outside the set it can attack. `COVERAGE_BOUNDARY` in `coverage.ts` says the suite
  covers the tables that carry a tenant boundary; after this initiative that sentence needs
  to name the five that do not.
- Deleting a tenant does not cascade to `session` or `account` by tenancy. It cascades
  because `privilegedTenantEraser` deletes `user` rows afterwards (ADR-0015), which is
  application code rather than a database constraint on the tenant boundary.

### What would force the role split

Any one of these, and none is scheduled:

- A deploy target with a real user base. ADR-0030 says there is none; the blast radius today
  is a developer's machine and CI.
- A second service or a background worker connecting as `shortkit_app`, which widens the set
  of code that can issue a statement against `session`.
- A raw-SQL surface that takes caller input — a search endpoint, a reporting query, an
  admin console.

### Follow-ups this creates

- TASK-002: the `EXEMPT.size !== 5` control in `check-policies.mts`, and no change to the
  entries themselves.
- TASK-015 (wave 9): `COVERAGE_BOUNDARY` gains a sentence naming the five unattackable
  tables, so `report.json` is not read as stronger than it is.
