# TASK-018 — security audit, round 1

Mode: code. Range `d6b79f0..4cfa57f` (one commit, 6 files).
Auditor: sdlc-security-auditor. Finding ids F-056 … F-063; four used.

```yaml
verdict: changes-requested
findings:
  - severity: major
    kind: behavior
    file: docker-compose.yml
    line: 238
    summary: >-
      BETTER_AUTH_SECRET gets a repository-published constant as its compose default,
      so the one declared binding in this block that fails open is the signing key.
    failure_scenario: >-
      From wave 2 `betterAuth({ secret })` reads this value. `docker compose config` on a
      clean environment renders
      `BETTER_AUTH_SECRET=development-compose-better-auth-secret-not-a-real-value`
      (measured). That string is committed to this repository and is in its git history
      permanently, so it is a value every reader of the repo has — the same property that
      made better-auth's own published constant F-020's blocker. Anyone who can reach an
      api container brought up by `docker compose up` without the variable exported can
      forge a signed session cookie and decrypt `jwks.privateKey`, then mint a JWT with
      any `sub` and any `tid`. `assertBetterAuthSecretConfigured()` (ADR-0051) rejects
      better-auth's constant by exact value and will accept this one, so the check that
      exists to stop exactly this class of value is green over it. Ten lines above,
      `DATABASE_AUTH_URL` is deliberately given no fallback for the identical argument —
      "an unset value fails boot rather than silently restoring shortkit_app as the auth
      role" — and the higher-value credential in the same block was given one, with the
      asymmetry unstated. Not a blocker today: `ports: 127.0.0.1:3001:3001` is loopback,
      nothing reads the value until wave 2, and ADR-0030 records no deploy target. It
      becomes one the first time a deploy target inherits this file.
    required_change: >-
      The value must be owned by an artifact rather than invented in a compose file.
      Pin it in ADR-0051 (or rls-policy-template.md) alongside the library constant it
      is standing in for, and give it the same treatment: named, rejected by exact value
      by `assertBetterAuthSecretConfigured()` at the point a deploy target is chosen, and
      carrying a `DO NOT USE ON ANY DEPLOYED INSTANCE` banner in the shape
      `.github/scripts/provision-test-database.sql:26` already uses for the fixture
      passwords. Also drop or correct the adjacent comment's claim that this is "A
      development-only value": `Dockerfile:83` sets `ENV NODE_ENV=production`
      unconditionally in the image this file builds, so nothing in the running process
      treats it as development-only.

  - severity: minor
    kind: behavior
    file: docker-compose.test.yml
    line: 9
    summary: >-
      The header export lines were not widened to DATABASE_AUTH_URL, which ADR-0050 and
      the card both assign to this TASK.
    failure_scenario: >-
      Lines 8-9 still tell a developer to export `DATABASE_URL` and
      `DATABASE_MIGRATION_URL` and nothing else. From wave 2 the spawned API child
      refuses to boot without `DATABASE_AUTH_URL`, and `authDsnOrThrow()`
      (`apps/api/test/support/auth-fixture.ts:123`) throws naming the variable but giving
      no DSN. A developer repairing a red local suite from that message, with this header
      as the only place in the repo that spells out the three DSNs, reaches for
      `DATABASE_AUTH_URL="$DATABASE_URL"` — which ADR-0050 names by name as the change
      that "would silently restore shortkit_app as the auth role and every gate would stay
      green". `assertAuthRoleSeparation` catches it in wave 3, leaving a one-wave window,
      and the whole reason this declaration was pulled forward to wave 0 was that "the
      redness is not the danger; the repair pressure is". This omission puts the repair
      pressure back in the one file that answers the question.
    required_change: >-
      Add the third export line to the header block, connecting as `shortkit_auth`:
      `export DATABASE_AUTH_URL='postgres://shortkit_auth:auth@127.0.0.1:55433/shortkit_test'`.

  - severity: minor
    kind: behavior
    file: scripts/check-compose-stack.sh
    line: 180
    summary: >-
      This commit adds a fourth host-interpolated credential to
      configs.shortkit_roles_sh.content and does not add it to the contaminant list that
      keeps that block's `$$` escaping honest.
    failure_scenario: >-
      The guard at :180 refuses to run when POSTGRES_USER, SHORTKIT_MIGRATOR_PASSWORD or
      SHORTKIT_APP_PASSWORD is exported, because Compose interpolates `configs.*.content`
      against the host environment at parse time and an exported value silently repairs a
      missing `$$` (F-315, F-316 — two prior defects of exactly this shape).
      `SHORTKIT_AUTH_PASSWORD` is now the fourth variable in that block and is not on the
      list. A later edit that writes `$SHORTKIT_AUTH_PASSWORD` instead of
      `$$SHORTKIT_AUTH_PASSWORD` renders as `-v auth_password=""` on a clean machine;
      `CREATE ROLE shortkit_auth LOGIN PASSWORD ''` clears the password to NULL (measured,
      `NOTICE: empty string is not a valid password, clearing password`), and
      `pnpm test:compose` stays green on the author's machine because their exported value
      repaired it. Verified this is fail-closed on the database side rather than a
      credential-free login: from the docker network the stock image's pg_hba matches
      `host all all all scram-sha-256` and a NULL-password role cannot authenticate at all
      (measured — `fe_sendauth: no password supplied`). So the cost is a required check
      that is green on the author's machine and red on AC-115's, not disclosure. The
      escaping is correct in this commit — measured: with `SHORTKIT_AUTH_PASSWORD` exported,
      `docker compose config` still renders the literal `$$SHORTKIT_AUTH_PASSWORD`.
    required_change: >-
      Add `SHORTKIT_AUTH_PASSWORD` to the contaminant loop at
      `scripts/check-compose-stack.sh:180`. That file is outside TASK-018's `paths`, so
      this needs routing rather than an edit here — ADR-0050 already assigns
      `check-compose-stack.sh` to TASK-017 in wave 9, which is eight waves after the
      variable it should be covering exists.

  - severity: minor
    kind: behavior
    file: .github/scripts/provision-test-database.sql
    line: 87
    summary: >-
      The comment explaining why shortkit_auth gets no ALTER DEFAULT PRIVILEGES states the
      shortkit_app half of the reasoning and omits the half that forbids a default grant
      to shortkit_auth.
    failure_scenario: >-
      As written: "shortkit_auth gets no default privilege here … because ALTER DEFAULT
      PRIVILEGES would also grant shortkit_app DML on every table the migrator creates,
      forever." That sentence explains why the five auth tables need a hand-written
      `REVOKE` from `shortkit_app`; it does not explain why `shortkit_auth` may not have a
      default privilege of its own, and it names the wrong role to do so. A maintainer
      tired of hand-writing per-table grants reads it, correctly concludes that a second
      `ALTER DEFAULT PRIVILEGES … TO shortkit_auth` does not affect `shortkit_app` at all,
      and adds one — handing `shortkit_auth` DML on `tenants`, `tenant_memberships` and
      every future tenant-scoped table, which is the second direction of ADR-0050's split
      collapsing, and is F-239's shape arriving in reverse exactly as ADR-0050 predicts.
      rls-policy-template.md:40-45 states it correctly ("in either direction"); the
      transcription into the three provisioning sites dropped it. Caught downstream —
      TASK-002's grant matrix and wave 3's `assertAuthRoleSeparation` both assert
      `auth_dml` false on every non-EXEMPT table — which is why this is minor and not
      major. The same omission is in `docker-compose.yml:345-347` and
      `docker-compose.test.yml:134-135`, which state the *what* with no *why not* at all.
    required_change: >-
      At all three sites, state the direction that is actually being refused: a default
      privilege for `shortkit_auth` would grant it DML on every table the migrator creates,
      including every tenant-scoped one, so the split cannot be expressed as a default
      privilege in either direction (rls-policy-template.md:40, ADR-0050).
```

## What was measured

Everything below was executed against a throwaway `postgres:17-alpine` cluster created and
destroyed for this audit (`audit-f056-scratch`, published on 127.0.0.1:55999, removed).
The `shortkit` application database was never touched. The `docker-compose.test.yml` stack
on 127.0.0.1:55433 was read once, read-only, and is still running.

**`shortkit_auth`'s attributes, from the CI script run verbatim.** `rolsuper=f`,
`rolcreaterole=f`, `rolcreatedb=f`, `rolreplication=f`, `rolbypassrls=f`, `rolcanlogin=t`,
`rolconnlimit=-1`, no `rolvaliduntil`. Identical to `shortkit_app` and `shortkit_migrator`.
Matches ADR-0050 and rls-policy-template.md.

**What `shortkit_auth` can reach today, before any revoke.** Nothing. `pg_default_acl`
holds exactly two rows, both `shortkit_migrator → shortkit_app` (`r` and `S`); no entry for
`shortkit_auth`. `pg_namespace.nspacl` for `public` is
`{pg_database_owner=UC/pg_database_owner,=U/pg_database_owner,shortkit_app=U/pg_database_owner,shortkit_auth=U/pg_database_owner}`
— USAGE only, no CREATE. After applying `0000` as the migrator,
`has_table_privilege('shortkit_auth','tenants','SELECT,INSERT,UPDATE,DELETE')` is `false`
and `has_any_column_privilege` is `false`, while the same pair for `shortkit_app` is `true`.
The commit adds a login role that can connect and read the catalogue and nothing else. It
opens no new data path.

**Both widened guards refuse what they claim to.** The `DO $$` block was run over clusters
built by hand:

| Cluster | Result |
|---|---|
| `shortkit_auth` with `BYPASSRLS` | REFUSED, guard 1, message names `shortkit_auth` |
| `shortkit_auth` with `SUPERUSER` | REFUSED, guard 1 |
| two-role cluster, no `shortkit_auth` | REFUSED, guard 2, message names `shortkit_auth` |
| correct three-role cluster | passes |

This is the state my design-round measurement recorded as broken (both guards passed a
`BYPASSRLS` auth role and a two-role cluster at the two-role form). It is fixed. CI invokes
the file with `psql -v ON_ERROR_STOP=1` (`.github/workflows/ci.yml:253`), so the `RAISE`
fails the step rather than being reported and skipped.

**`ALTER DEFAULT PRIVILEGES` is genuinely not extended to `shortkit_auth`, and nothing
else grants it broadly.** `pg_default_acl` confirms it (above). The only statement in the
commit that names `shortkit_auth` on the grant side is `GRANT USAGE ON SCHEMA public`, which
is a no-op against the `=U/pg_database_owner` entry PUBLIC already holds. The decision is
correct; only its stated reasoning is wrong, which is F-059.

**The `$$` escaping of the new variable holds.** With `SHORTKIT_AUTH_PASSWORD=LEAKED-HOST-VALUE`
exported, `docker compose -f docker-compose.yml config --format json` still renders
`-v auth_password="$$SHORTKIT_AUTH_PASSWORD"`. No host-time interpolation leak. F-043's
convention was applied correctly to the new line.

**`DATABASE_AUTH_URL` has no fallback anywhere.** Grepped the whole tree: the only
constructions are `docker-compose.yml:233` (connects as `shortkit_auth`) and
`authDsnOrThrow()` (`apps/api/test/support/auth-fixture.ts:122-131`), which reads
`process.env.DATABASE_AUTH_URL` and throws on unset or empty with no read of `DATABASE_URL`.
The throw message names the variable and the role and carries no value. Correct, and it is
the half of ADR-0050 that mattered most.

## Notes

**GC-B.** No behavioural choice in this diff keys on `NODE_ENV`. `${BETTER_AUTH_SECRET:-…}`
is a Compose default, not an environment-keyed branch, and GC-B's own wording permits a
conditional *requirement* with unconditional *validity*. F-056 is not a GC-B finding; it is
a hardcoded-credential finding.

**GC-G.** No logging surface is touched. `LOGGABLE_FIELDS` is unchanged and `email` was not
added. `apps/api/test/support/api-server.ts:183-184` captures the spawned child's stdout and
stderr into a failure message, and from wave 1 that child will hold `DATABASE_AUTH_URL` with
a password in its environment — worth remembering when the second pool lands, but nothing
today writes a DSN to either stream and the value is the throwaway `auth` against a loopback
test stack.

**Role membership is covered downstream, so no finding.** The widened guard passes a
`shortkit_auth` created `IN ROLE shortkit_migrator` — it inspects `rolbypassrls`, `rolsuper`
and `rolcreaterole`, none of which is set on the member. I measured the downstream answer
before reporting it: with that membership in place,
`has_table_privilege('shortkit_auth','tenants','SELECT,INSERT,UPDATE,DELETE')` returns
`true`, so both TASK-002's grant matrix (wave 1) and `assertAuthRoleSeparation` (wave 3)
fire on it. The control chain holds; the provisioning-time guard is simply not the link that
catches this one.

**`REPLICATION` is not a reachable bypass, so no finding.** The guard does not inspect
`rolreplication`, and a replication-attributed role can stream every row past RLS in
principle. I could not build a path: with `ALTER ROLE shortkit_auth REPLICATION` set, a
replication connection from the docker network is refused — `no pg_hba.conf entry for
replication connection from host "172.17.0.1"` — because the stock image's appended
`host all all all scram-sha-256` does not match replication connections. Reporting it as a
finding would be theoretical.

**The compose init scripts carry no guard at all, and that is unchanged by this commit.**
`docker-compose.test.yml`'s `shortkit_roles_sql` and `docker-compose.yml`'s
`shortkit_roles_sh` create the three roles and never run the `DO $$` block; only the CI file
has it. The test stack is nonetheless covered — the new spec's "shortkit_auth owns no
relation in the migrated schema" reads `bypasses_rls` and `superuser` off the live
`migrationDsn()`. The dev stack is covered for role *names* only (spec case 4 asserts the
census, not the attributes), so a `BYPASSRLS` typo in `docker-compose.yml` would pass all
nine tests. No isolation assertion runs against that stack, so the exposure is a developer's
own machine. Recorded, not filed.

**The nine tests are real controls, not tautologies.** Cases 7 and 8 build the cluster the
guard must refuse and require a refusal, and case 8's `/shortkit_auth/` match cannot be
satisfied by the pre-TASK wording — reverting the guards to the two-role form makes case 8
throw a message that names only `shortkit_app` and `shortkit_migrator`, so the test goes red.
The control (case 9) does what it says.

**`apps/api/scripts/seed.mts`.** The docblock exception is accurate. `REQUIRED_ROLE` is
still `shortkit_app` (`:62`) and `:206` still refuses any other connected role, so the seed's
grant check keeps covering exactly what it writes.

## Dependencies reviewed

None. The diff adds no dependency and bumps none; no lockfile change. The new CI dependency
the card flags — the spec shelling out to `docker run` / `docker exec` /
`docker compose config` from the `integration` job — landed in the Test-phase commit, not in
this range.
