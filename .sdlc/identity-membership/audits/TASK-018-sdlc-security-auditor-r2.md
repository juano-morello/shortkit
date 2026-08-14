# TASK-018 — security audit, round 2 (fix round 1)

Mode: code. Range `4cfa57f..60afdeb` (one commit, 7 files). Fix diff only; the original
commit was not re-reviewed and nothing cleared in round 1 was re-opened.
Auditor: sdlc-security-auditor. Finding ids F-072 … F-077; four used (F-072 … F-075).

## Verdicts on the findings I was asked to rule

| Finding | Severity | Verdict |
|---|---|---|
| F-056 | major | **ADDRESSED** as far as this card's paths reach. Residual is real and needs an artifact owner — carried as **F-074**, a wave-2 card obligation, not another round here. |
| F-057 | minor | **ADDRESSED**, as part of F-064. |
| F-059 | minor | **ADDRESSED** at all three provisioning sites. |
| F-064 | blocker | **ADDRESSED.** The line landed *and* the repair path is foreclosed — measured. One residual repair surface outside this card's paths: **F-073**. |
| F-065 | major | **ADDRESSED.** |
| F-050 | minor | **ADDRESSED.** Every claim in the replacement comment verified against the code it names. |

### F-064 — does the fix foreclose `DATABASE_AUTH_URL="$DATABASE_URL"`, or only add a line?

It forecloses it. Three things had to be true and all three are:

1. **The line exists and is executable as written.** `docker-compose.test.yml:10` now carries
   `export DATABASE_AUTH_URL='postgres://shortkit_auth:auth@127.0.0.1:55433/shortkit_test'`.
   Measured against the live stack from a throwaway client container, so the connection
   arrives from `172.18.0.1` rather than loopback and real `scram-sha-256` runs rather than
   the image's `trust` line: `shortkit_auth | shortkit_test | roles=shortkit_app,shortkit_auth,shortkit_migrator`.
   The documented DSN is copy-pasteable and correct, not aspirational.
2. **The failure message routes the developer to that line rather than to a variable name.**
   `dsnOrThrow()` (`apps/api/test/support/auth-fixture.ts:104-118`) now ends with
   "see that file's header for the exact export lines. This call needed DATABASE_AUTH_URL
   (shortkit_auth)". Round 1's complaint was that the throw named the variable and gave no
   DSN, with the one file that answers the question silent. Both halves are now closed, and
   the message names the *role* as well as the variable, which is what makes
   `="$DATABASE_URL"` visibly wrong rather than merely untested.
3. **No fallback was introduced anywhere while fixing it.** Grepped the tree: the only
   `DATABASE_AUTH_URL` sites are `auth-fixture.ts:83/104`, `ci.yml:206`,
   `docker-compose.yml:248` and the header line. No read of `DATABASE_URL` reaches any of
   them.

The one place the old repair pressure survives is outside this card's paths and is filed as
F-073: `docs/architecture/migrations.md:42` still tells a developer that "the header of that
file has the two exports". That sentence was *true before this diff and is false after it*.

### F-065 — `.github/workflows/ci.yml`

`ci.yml:206` sets `DATABASE_AUTH_URL: postgres://shortkit_auth:auth@127.0.0.1:55433/shortkit_test`.
Checked against what CI actually provisions rather than against the compose file: the role,
the password and the database all come from `.github/scripts/provision-test-database.sql`
(`CREATE ROLE shortkit_auth LOGIN PASSWORD 'auth' NOBYPASSRLS`, `CREATE DATABASE
shortkit_test`), and the port matches the `55433:5432` service mapping. The three DSNs in
that `env:` block are byte-identical to the three export lines in the compose header, which
is what the adjacent comment claims. No secret is introduced — the value is the same fixture
credential already published in two committed files, for a container destroyed with the
runner. Card `paths` widened to include the file.

### F-050 — the guard comment

Every claim in the replacement was verified against the code it names, because the finding's
whole class is a comment crediting coverage that does not exist:

- `assertRuntimeRoleCannotBypassRls` exists at `apps/api/src/db/rls.ts:137` and does read
  `tables_owned_in_public` for `current_user` (`rls.ts:148`, `:169`). Not a stale name.
- It is reachable in the same CI job the comment is describing:
  `apps/api/test/security/security-headers.int-spec.ts:140` spawns the API child through
  `startApiServer`, which boots `main.ts` as `shortkit_app`. The downstream check the
  comment defers to is not hypothetical in CI.
- `check-policies.mts` holds **zero** ownership reads (grep for
  `relowner|pg_get_userbyid|datdba|owner` returns 0). The comment's new negative claim is
  the accurate one.
- `assertAuthRoleSeparation` → TASK-004, wave 3 matches ADR-0050's own routing table
  (`adr-0050:378-379`), and TASK-004's card is the boot-assertions card
  (`apps/api/src/auth/boot-assertions.ts` in its `paths`).
- The interim coverage it names is real: `auth-role-provisioning.int-spec.ts:268-293` counts
  relations in `public` owned by `shortkit_auth` against the live migration DSN and requires 0.

### F-059 — the `ALTER DEFAULT PRIVILEGES` comment

The refused direction is now stated at all three sites
(`provision-test-database.sql:93-99`, `docker-compose.yml:379-384`,
`docker-compose.test.yml:131-135`) and matches `rls-policy-template.md:40-42` — "the split
cannot be expressed as a default privilege in either direction". The wrong-role half is gone.
The maintainer path the finding described (add a second `ALTER DEFAULT PRIVILEGES … TO
shortkit_auth`, hand it DML on every tenant-scoped table) is now argued against explicitly at
the point of edit.

### F-056 — sufficient, or does the residual need an artifact owner?

**The residual needs an artifact owner.** Plainly: yes.

What landed in `docker-compose.yml:249-272` is everything the file could carry, and it is
good work — the `DO NOT REUSE THIS VALUE ANYWHERE A REAL DEPLOY TARGET COULD READ IT` banner,
the false "development-only" claim replaced with the measured fact that `Dockerfile:83` sets
`NODE_ENV=production` unconditionally, the asymmetry with `DATABASE_AUTH_URL` stated in the
terms the finding asked for (fixture placeholder vs. symmetric key), and all four of
ADR-0051's rejections enumerated. As a comment, it is now correct and complete. I have no
further comment-level finding against it.

What a comment cannot do is change what the check accepts. From wave 2,
`assertBetterAuthSecretConfigured()` rejects better-auth's published constant *by exact
value* and will accept `development-compose-better-auth-secret-not-a-real-value`, which by
then is a value every reader of this public repository has had for two waves. Grepped: the
string appears in exactly one non-audit file, `docker-compose.yml:272`. No ADR, no contract,
no test names it. That is the half of F-056 that mattered and it is carried as F-074.

## Findings

```yaml
verdict: changes-requested
findings:
  - severity: major
    kind: security
    file: .sdlc/identity-membership/design/adr-0051-better-auth-secret-is-a-declared-binding.md
    line: 68
    summary: >-
      F-056's residual. The compose BETTER_AUTH_SECRET default is still owned by no artifact,
      so the wave-2 assertion that rejects a published constant by exact value will accept
      this repository's own published constant.
    failure_scenario: >-
      `docker-compose.yml:272` is the only place in the repository that names
      `development-compose-better-auth-secret-not-a-real-value` (grepped; the other hits are
      round-1 audit reports). ADR-0051:68 defines the accepted set as "any string of at least
      32 characters that is not the library default", and ADR-0051:77 encodes the library
      default rejection by exact value. From wave 2, TASK-003 ships that assertion and it is
      green over a 55-character string that has been in this public repository's git history
      since 2026-08-13 — the exact property that made better-auth's own constant F-020's
      blocker, one string later. The attacker is anyone who reaches an `api` container started
      by `docker compose up` without `BETTER_AUTH_SECRET` exported: they hold the signing key,
      forge a session cookie, decrypt `jwks.privateKey` and mint a JWT with any `sub` and any
      `tid`. Still not exploitable today — port 3001 is loopback, nothing reads the value until
      wave 2, ADR-0030 records no deploy target — which is why this stays major. The compose
      comment now says all of this in prose; nothing mechanical reads prose.
      Related routing defect found while placing this obligation: ADR-0051:236 assigns the
      documentation half to `apps/api/.env.example`, which DOES NOT EXIST (`ls` fails; `git
      ls-files` knows only `.env.example` and `apps/web/.env.example`). So the wave-4 card that
      is supposed to document this variable points at a path nothing will create.
    required_change: >-
      ADR-0051 names the compose default as a second rejected-by-value constant, in the same
      table as the library default, and TASK-003's `assertBetterAuthSecretConfigured()` rejects
      both. If that is judged too strong for a stack with no deploy target, the alternative
      that closes the same hole is for the compose file to carry NO default at all
      (`BETTER_AUTH_SECRET: ${BETTER_AUTH_SECRET:?set this to a locally generated value}`), so
      the value is never published. Either way it is an artifact decision for wave 2, not an
      edit available inside TASK-018's paths. Also correct ADR-0051:236 to name the root
      `.env.example`.

  - severity: minor
    kind: behavior
    file: docker-compose.yml
    line: 242
    summary: >-
      The new EXISTING VOLUME? note states a failure that does not happen at wave 0 and an
      error string PostgreSQL does not emit for the half that will happen, so the symptom it
      teaches points at a credential problem rather than at a missing role.
    failure_scenario: >-
      As written: "A `shortkit-dev_pgdata` volume from before this role existed keeps a
      two-role database forever; `migrate` fails with `role \"shortkit_auth\" does not exist`
      and, from wave 2, so does `api` against this DSN." Measured on a scratch cluster built to
      be exactly that stale volume (two roles, `shortkit` owned by `shortkit_migrator`, the
      same ALTER DEFAULT PRIVILEGES): `pnpm --filter @shortkit/api db:migrate` exits 0
      ("migrations applied successfully"), and `node apps/api/scripts/seed.mts` exits 0
      ("covered 1 of 1 tables"). Nothing in `apps/api/drizzle/**` names `shortkit_auth` today,
      so `migrate` cannot fail the way the comment says until TASK-002's migration 0001 lands
      in wave 1. This is the present-tense-future-fact class the SAME diff just fixed in
      `seed.mts` for F-071, reintroduced four files away. Worse for the reader: measured, the
      `api` half does not produce that message either. A connection as a role that does not
      exist returns `FATAL: password authentication failed for user "shortkit_auth"`, because
      scram does not distinguish a missing role from a wrong password. A developer at wave 2
      with a stale volume therefore sees an authentication failure, greps for the string this
      comment promised, finds nothing, and reads it as a wrong password — whose cheapest
      repairs are overriding `SHORTKIT_AUTH_PASSWORD` (does not help; the role is absent) and
      pointing `DATABASE_AUTH_URL` at the DSN that does authenticate, which is `DATABASE_URL`.
      That is ADR-0050's named failure, reached from a note written to prevent confusion. Its
      remedy sentence (`docker compose down -v`) is correct, which is what keeps this minor,
      and the premise is sound: verified independently that a second container started on the
      same named volume with a three-role init script leaves the database at two roles, with
      no error in the log and the container healthy (ADR-0032 holds).
    required_change: >-
      Qualify the `migrate` claim the way the `api` claim is already qualified ("from wave 1,
      once migration 0001 grants to it, `migrate` fails with …") and give the `api` half its
      real symptom: `FATAL: password authentication failed for user "shortkit_auth"`, which
      looks like a wrong password and is not one. Both are inside this card's paths.

  - severity: minor
    kind: documentation
    file: docs/architecture/migrations.md
    line: 42
    summary: >-
      This diff made a doc sentence false: migrations.md still says the compose header carries
      "the two exports", and it is the one prose page a developer reads before that header.
    failure_scenario: >-
      `migrations.md:41-44`: "For work against the integration suite's container,
      `DATABASE_URL` and `DATABASE_MIGRATION_URL` point at `docker-compose.test.yml` on port
      55433; the header of that file has the two exports." True before `60afdeb`, false after
      it — the header now has three. This is the same repair surface F-064 was filed over,
      surviving one file to the left: a developer setting the integration tier up from the
      architecture docs exports two DSNs, and the third is not mentioned. They are rescued by
      `dsnOrThrow()`'s message when the suite goes red at wave 2, so this is minor rather than
      a re-open of F-064 — but the page that is supposed to be the reference is now the one
      artifact that undercounts. No card in this initiative owns
      `docs/architecture/migrations.md` (only completed `foundation` cards name it), which is
      F-065's shape again: a file that must change with the role split, owned by nobody.
      `docs/architecture/rls.md:12` ("## The two roles", a two-row table) has the same gap but
      IS owned — TASK-002, wave 1 — so it is noted, not filed.
    required_change: >-
      A card owns `docs/architecture/migrations.md` and the sentence names three exports and
      three roles. Out of TASK-018's paths; needs routing, not an edit here.

  - severity: minor
    kind: security
    file: .env.example
    line: 20
    summary: >-
      The stack now creates three roles and the credential-override template still documents
      two, omitting the one whose password will guard the Better Auth tables.
    failure_scenario: >-
      `.env.example` is the documented way to change the dev stack's passwords. It says
      "every statement the API, the migrator and the seed issue comes from one of the two
      NOBYPASSRLS roles below" (:20), documents `SHORTKIT_MIGRATOR_PASSWORD` (:26) and
      `SHORTKIT_APP_PASSWORD` (:30), calls the migrator "the larger of the two credentials"
      (:25) and warns "THE TWO PASSWORDS ABOVE MUST BE URL-SAFE" (:32). `SHORTKIT_AUTH_PASSWORD`
      — read by `docker-compose.yml:99` and interpolated into `CREATE ROLE shortkit_auth` — is
      absent. The developer this file exists for is the one deliberately getting off the
      committed defaults; they follow it, rotate two of three, and leave `shortkit_auth` on the
      published literal `auth`, believing from the file's own words that they have covered every
      role. From wave 2 that is the role holding `user`, `session`, `account`, `verification`
      and `jwks`, so any local process or any container on that machine that reaches
      127.0.0.1:55432 authenticates with a password printed in this public repository and reads
      `jwks.privateKey` — the private signing keys — while the two credentials the file told
      them to rotate are the ones that no longer matter for that path. Minor because the stack
      is loopback-bound, development-only, and nothing writes those tables until wave 2. Not
      merely stale prose: this file's whole function is credential rotation, and the omitted
      credential is the highest-value one it governs.
    required_change: >-
      `.env.example` documents `SHORTKIT_AUTH_PASSWORD` beside the other two, with the same
      URL-safety warning (it is interpolated into `DATABASE_AUTH_URL` the same way), and its
      "two roles"/"two passwords" sentences say three. Out of TASK-018's paths and owned by no
      card — TASK-009's `paths` name `apps/api/.env.example`, which does not exist. Needs
      routing together with F-074's ADR-0051:236 correction.
```

## What was measured

A throwaway `postgres:17-alpine` cluster and a throwaway named volume, created and destroyed
for this audit (`audit-r2-pg`/`audit-r2-pg2`, volume `audit-r2-vol`, published on
127.0.0.1:55999; both containers removed and the volume deleted). The `shortkit` application
database was never touched. **The `docker-compose.test.yml` stack on 127.0.0.1:55433 was
read only and is still running** — confirmed after the audit: `shortkit-postgres-1 running`.

**The documented `DATABASE_AUTH_URL` export line works, over real password authentication.**
From a throwaway client container on the host network against the live test stack:
`shortkit_auth | shortkit_test | roles=shortkit_app,shortkit_auth,shortkit_migrator |
inet_client=172.18.0.1`. Non-loopback source, so the image's `host all all 127.0.0.1/32 trust`
line does not apply and scram actually ran. The header's line is not just present, it is right.

**`migrate` does NOT fail against a stale two-role volume at wave 0.** Built the exact
database the new comment describes (roles `shortkit_migrator` and `shortkit_app` only,
`CREATE DATABASE shortkit OWNER shortkit_migrator`, both `ALTER DEFAULT PRIVILEGES`), then:

| Command | Result |
|---|---|
| `pnpm --filter @shortkit/api db:migrate` (as `shortkit_migrator`) | exit 0, "migrations applied successfully" |
| `node apps/api/scripts/seed.mts` (as `shortkit_app`) | exit 0, "covered 1 of 1 tables", 1 row inserted |
| connect as `shortkit_auth` to that database | `FATAL: password authentication failed for user "shortkit_auth"` — NOT `role … does not exist` |

`apps/api/drizzle/**` contains no reference to `shortkit_auth` and no `GRANT`/`REVOKE`, which
is why. F-072.

**ADR-0032's once-only init premise holds.** Started a container on a named volume with a
two-role init script, removed it, started a second container on the *same* volume with a
three-role init script: roles remain `shortkit_app,shortkit_migrator`, container `running`,
nothing in the log but the ordinary startup lines. The stale volume really does keep a
two-role database forever and really is silent about it — the comment's premise is correct
even though the two failure claims built on it are not.

**No new secret, no new fallback, no new reachable surface.** The diff introduces no
credential that was not already committed; `ci.yml:206` reuses the fixture password the
provisioning script creates. Grepped every `DATABASE_AUTH_URL` site in the tree (four): none
reads `DATABASE_URL`. `.env.local` is present on this machine and is **not tracked**
(`git ls-files --error-unmatch` fails), so nothing secret entered the repository here.

## Notes

**On the prose-to-behaviour ratio.** 34KB for what is mostly comment repair is defensible
here — of the six findings ruled, four were comment-accuracy findings and the panel filed
them because this initiative keeps shipping comments that assert coverage they do not have.
The diff's only behavioural changes are one env var in `ci.yml`, one export line in a header
comment, and the `dsnOrThrow()` collapse in `auth-fixture.ts`, all of which I verified. But
the class did recur: F-072 is a comment that is now confidently wrong where the old file said
nothing, and it is in the same commit that fixed F-071 for exactly that reason.

**`dsnOrThrow()` (F-052's fix) is behaviour-preserving.** Same unset-or-empty test, same
throw, no fallback introduced by the parameterisation; the union type on `variable` means a
third caller cannot pass an arbitrary name. The merged message names all three DSNs and
which one the failing call needed, which is strictly more than either old message had.

**"the two live-database sites" (`provision-test-database.sql:57`) — considered, not filed.**
Only one of the suite's two live-database tests asserts ownership (`:268`); the other asserts
the role census (`:253`). But the phrase also reads as "the two databases this suite runs
against" — CI's provisioned one and the local compose one — which is true. Ambiguous rather
than wrong, and F-050's class is a *false* claim, not an imprecise one. Recorded so the next
round does not re-litigate it.

**`docs/architecture/rls.md:12` "## The two roles" is stale but owned.** TASK-002 (wave 1)
carries it in `paths`. Noted rather than filed; if it survives TASK-002 it is a finding then.

**GC-B.** Unchanged from round 1. `${BETTER_AUTH_SECRET:-…}` is still a Compose default, not
an environment-keyed branch, and the diff's own comment now states the `NODE_ENV=production`
fact correctly. F-074 is a published-credential finding, not a GC-B finding.

**GC-G.** No logging surface touched. `ci.yml`'s new `env:` entry is job-scoped and GitHub
masks nothing here because nothing here is a secret — the value is a committed fixture, and
a workflow log printing it discloses what two committed files already publish.

## Dependencies reviewed

None. The fix diff adds no dependency, bumps none, and touches no lockfile.
