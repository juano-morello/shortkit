# TASK-018 — security audit, round 3 (fix rounds 2 and 3)

Mode: code. Range `60afdeb..4ea2096` (two commits, 8 files). Fix diff only; nothing cleared
in rounds 1 or 2 was re-opened.
Auditor: sdlc-security-auditor. Finding ids F-082 … F-087; four used (F-082 … F-085).

## Should TASK-018 be marked done?

**Yes — after one sentence in `docker-compose.yml` is corrected.** That is the only change
I am asking for inside this card. F-083, F-084 and F-085 need routing, not edits here, and
none of the four is exploitable by anyone today. There is no blocker and no major in this
range.

## Verdicts on the four findings I was asked to rule

| Finding | Severity | Verdict |
|---|---|---|
| F-072 | major | **ADDRESSED.** Both wrong claims are now right, measured. The rewrite introduced one new wrong claim in the other direction — **F-082**. |
| F-075 | minor | **ADDRESSED.** All four counts moved with the value; every DSN-to-variable claim in the file verified. Forward-looking residual from the F-081 ruling — **F-083**. |
| F-073 | minor | **ADDRESSED.** Verified sentence by sentence against the header it describes. |
| F-080 | minor | **ADDRESSED** in `rls-fixture.ts`. One sibling fixture still names two — **F-084**. |

### F-072 — does the rewrite name what a reader will actually see?

The two claims the finding killed are gone and their replacements hold:

- **The `migrate` claim is now correctly qualified as a wave-1 fact.** `grep -rn shortkit_auth
  apps/api/drizzle/` returns nothing; the only migration is `0000_odd_betty_ross.sql`. The
  note's forward reference is consistent with the plan rather than invented: TASK-002
  `depends_on: [TASK-018]` and its own header says "this card's migration 0001 GRANTs to that
  role — a forward-only migration on a database that has already applied 0000 fails with
  `role "shortkit_auth" does not exist`" (`TASK-002.md:8-11`), and `plan.md:156` says the same.
  ADR-0050:52/88-90 confirms `jwks` is in the GRANT set.
- **The `api` symptom is right in substance.** Re-measured on a fresh scratch two-role cluster:
  a missing role over the docker network answers `password authentication failed for user
  "shortkit_auth"`, never `role does not exist`.
- **The remedy sentence is right, and I measured it rather than assuming it.** Scratch compose
  project (`audit-r3-compose`, created and destroyed): first `up` with a two-role init script
  → one role; widen the script, plain `down` then `up` → still one role; `down -v` → volume
  removed → next `up` → both roles. `docker compose down -v` does what the note says.

What the rewrite oversold is the parenthetical it added to justify the measurement, which is
F-082.

### F-075 — did the counts move, and is the new block true?

Four counts moved, and all four are right: "four passwords" (four entries in the file:
superuser, migrator, app, auth), "three NOBYPASSRLS roles", "largest of the three
credentials", "THE THREE PASSWORDS ABOVE MUST BE URL-SAFE".

The claim worth measuring rather than reading is which DSN reads which variable, and it holds:
`DATABASE_URL` (`docker-compose.yml:181`/`:201`/`:232`), `DATABASE_MIGRATION_URL`
(`docker-compose.yml:181`) and `DATABASE_AUTH_URL` (`docker-compose.yml:263`) are all three
assembled by `${VAR:-default}` interpolation, so all three of those passwords really are
URL-constrained. **Excluding `POSTGRES_SUPERUSER_PASSWORD` from the URL-safety rule is correct,
not an off-by-one**: it reaches Postgres only as `POSTGRES_PASSWORD` (initdb pwfile) and the
`postgres` healthcheck passes `shortkit_app`'s value through `PGPASSWORD`, not through a URL
(`docker-compose.yml:153`). No DSN in this repository interpolates the superuser variable.

The rest of the new block is accurate: `shortkit_auth` is reached only through
`DATABASE_AUTH_URL` in the stack, it holds no BYPASSRLS and owns nothing (measured in round 1),
and it is the role that will hold DML on `jwks` once TASK-002 lands.

### F-073 — `docs/architecture/migrations.md:40-44`

True as rewritten. The header does carry three export lines
(`docker-compose.test.yml:8-10`); "the two these commands read" is right — no command in that
page's table reads `DATABASE_AUTH_URL`, and grep confirms the only readers in the tree are
`auth-fixture.ts`, `ci.yml` and the two compose artifacts; and "needs none of the three
exported" is right for the dev stack, which supplies all three from compose defaults.

### F-080 — `rls-fixture.ts`

The throw now names all three DSNs with their roles and defers to the compose header, matching
`auth-fixture.ts:104-118`. No logic or signature change; the union type is still the two
variables this fixture reads, so the fix is text-only and cannot introduce a fallback. F-052's
property — the two files cannot state a different number of variables to each other — holds
again. The sibling site that still states two is F-084.

## Findings

```yaml
verdict: changes-requested
findings:
  - severity: minor
    kind: behavior
    file: docker-compose.yml
    line: 254
    summary: >-
      The rewrite that fixed F-072 added a new measured-sounding claim that is wrong: over the
      loopback port a developer actually uses, pg_hba does NOT run a different method, and the
      one probe that would disclose the missing role is not named.
    failure_scenario: >-
      The new note reads "measured over the docker network (where `api` actually connects, not
      over loopback, where pg_hba runs a different method)". The stock image's pg_hba does carry
      `host all all 127.0.0.1/32 trust` (read off the live test container), but a connection from
      the developer's shell to the published port arrives at the server from the docker bridge
      gateway, not from 127.0.0.1, so it is matched by the appended `host all all all
      scram-sha-256` line like every other connection. Measured on a scratch two-role cluster
      published on 127.0.0.1:55999, four paths, one missing role - host shell over the published
      loopback port (node `pg`, the repo's own driver) - `password authentication failed for user
      "shortkit_auth"`, `inet_client_addr` 172.17.0.1; another container over the bridge - the
      same; inside the container over 127.0.0.1 - `FATAL: role "shortkit_auth" does not exist`;
      inside the container over the unix socket - the same. So the developer this note is written
      for, who reaches for `psql postgres://shortkit_auth:auth@127.0.0.1:55432/shortkit` to check
      whether their volume is stale, is told by this sentence to expect a different answer there
      and gets the identical password failure - which reads as a wrong password and pushes them
      back toward the two repairs the same paragraph is trying to talk them out of, the second of
      which is ADR-0050's silent collapse to `shortkit_app`. The only probe that discloses the
      missing role is in-container (`docker compose exec postgres psql -U shortkit_auth -d
      shortkit`), and the note does not name it. Second, smaller: the `FATAL:` prefix is psql's,
      not the API's. `api` is node `pg` (`apps/api/src/db/client.ts:34`), whose `error.message` is
      `password authentication failed for user "shortkit_auth"` with severity carried in a
      separate field (measured), and `main.ts:309` logs it through `errorLogFields` as
      `err_message`. `docker compose logs api` will not contain the string the note promises, only
      its greppable tail - the same "greps for the string this comment promised, finds nothing"
      failure F-072 was filed over, one prefix smaller.
    required_change: >-
      Drop the loopback parenthetical or replace it with the distinction that is true - the trust
      line applies only to connections that originate inside the container - and name the probe
      that answers the question, `docker compose exec postgres psql -U shortkit_auth -d shortkit`,
      which returns `role "shortkit_auth" does not exist`. Attribute the `FATAL:` form to psql and
      quote the API's as `password authentication failed for user "shortkit_auth"`. Inside this
      card's paths; one sentence.

  - severity: minor
    kind: security
    file: .env.example
    line: 6
    summary: >-
      The credential-rotation template this commit widened describes a flow the F-081 ruling is
      about to invalidate, and still omits the one credential in the stack that is a signing key.
    failure_scenario: >-
      Two things become false or dangerous at wave 2, in a file TASK-018 has just taken ownership
      of. (1) `.env.example:6-8` says "YOU DO NOT NEED THIS FILE ... `docker compose up` on a
      fresh clone works with no `.env` at all - that is AC-115". Under the ruling recorded as
      F-081, ADR-0051 rejects the compose `BETTER_AUTH_SECRET` default by exact value and a
      generation step writes a random secret into the root `.env` before compose starts, so from
      wave 2 a clean clone with no `.env` does not work and this file's headline instruction is
      wrong. (2) That generation step and this file will both write the same `.env`. A developer
      who followed this file - copied it and rotated the four passwords - and then runs a
      generator that truncates or rewrites `.env` silently reverts all four to the published
      compose defaults; because the roles are created once, the next `up` is an authentication
      dead end, and after the `down -v` this file recommends the roles are recreated on the
      published literals while the developer believes they are rotated. That is F-075's own
      hazard, mechanised. (3) `BETTER_AUTH_SECRET` is still absent from this file, while
      `docker-compose.yml:283` tells the reader to "Override it for anything beyond a throwaway
      loopback stack" - the documented place to override is `.env`, which this file describes,
      and the highest-value credential the stack has is the one it does not list. That is exactly
      the argument F-075 was granted on, applied to the next value up.
    required_change: >-
      Belongs to whoever picks up F-081, before wave 2, not to a fix round here. The generation
      step must merge into an existing `.env` rather than overwrite it (or refuse and say so),
      and this file's header must stop promising that no `.env` is needed once the secret is
      required. When `BETTER_AUTH_SECRET` lands in a template, name the root `.env.example` -
      ADR-0051:236 still points at `apps/api/.env.example`, which TASK-009 does not create until
      wave 4 (F-074's outstanding routing correction).

  - severity: minor
    kind: behavior
    file: apps/api/test/security/security-headers.int-spec.ts
    line: 130
    summary: >-
      F-080's class survives in the one other fixture that spells out the DSNs, and that file
      spawns an API child which will require all three from wave 1.
    failure_scenario: >-
      Its `beforeAll` guard checks `DATABASE_URL` only and its remedy message names exactly two
      DSNs with full values (`:129-133`). It then calls `startApiServer` with its own `env`
      callback (`:140`), so it does NOT go through `authServerEnv()` and the child inherits
      whatever the developer's shell holds. ADR-0050:175-182 makes `DATABASE_AUTH_URL` "required
      unconditionally in every environment", failing boot with no fallback, and `client.ts`
      constructs the auth pool in wave 1. A developer who exports the two DSNs this file names
      gets a child that refuses to boot, from a file whose own remedy told them they had exported
      everything - the repair pressure F-064 was filed over, in the last fixture that still
      undercounts. `rls-fixture.ts` and `auth-fixture.ts` are both fixed; this one was in no
      finding.
    required_change: >-
      Route it. The file is outside TASK-018's paths and outside every other card's; the message
      needs the third export line and the guard should check `DATABASE_AUTH_URL` from the wave
      that requires it. Not an edit here.

  - severity: nit
    kind: documentation
    file: .sdlc/identity-membership/tasks/TASK-004.md
    line: 10
    summary: >-
      The F-075 explanatory note was pasted verbatim into three cards; in two of them its first
      sentence describes a path that is not in that card's path list, and its citation was
      invalidated by its own insertion.
    failure_scenario: >-
      The note opens "`apps/api/.env.example` does not exist ON DISK TODAY. THAT IS NOT AN ERROR
      IN THIS PATH LIST". TASK-004's paths contain no `.env.example` of any kind and TASK-017's
      are `["scripts/check-compose-stack.sh"]` alone, so in two of the three cards the note
      defends a path list entry that does not exist there - a reader auditing path coverage is
      told a nonexistent entry is fine. It also cites "TASK-009:37-39" for the quote "does not
      exist and is owed by three separate ADR follow-ups. It lands here", which now sits at
      TASK-009:40 because the eight-line note itself pushed it down. Bookkeeping, no attacker,
      which is why it is a nit - but it is the class this initiative keeps filing, self-inflicted
      inside the commit that fixed an instance of it.
    required_change: >-
      Keep the note in TASK-009, where the path list it defends actually lives; in TASK-004 and
      TASK-017 either drop it or say why it is there. Cite the quote without line numbers, or
      re-check them after insertion.
```

## What was measured

A throwaway `postgres:17-alpine` cluster (`audit-r3-pg`, published on 127.0.0.1:55999, two
roles only) and a throwaway compose project (`audit-r3-compose`, own project name, own named
volume). Both created and destroyed for this audit; `docker ps -a` and `docker volume ls`
confirm nothing named `audit` remains. The `shortkit` application database was never touched.
**The `docker-compose.test.yml` stack on 127.0.0.1:55433 was read only — `pg_hba.conf` and
nothing else — and is still up**: `shortkit-postgres-1 Up 34 minutes (healthy)
127.0.0.1:55433->5432/tcp`.

**Where a missing role is disclosed, and where it is not.** One cluster, one absent role,
four paths:

| Path | Answer |
|---|---|
| host shell → published `127.0.0.1:55999` (node `pg`, the API's own driver) | `password authentication failed for user "shortkit_auth"`, code `28P01`, severity `FATAL` as a separate field |
| host shell → published port (psql) | `FATAL:  password authentication failed for user "shortkit_auth"` |
| second container → bridge network | `FATAL:  password authentication failed for user "shortkit_auth"` |
| inside the container → `127.0.0.1` | `FATAL:  role "shortkit_auth" does not exist` |
| inside the container → unix socket | `FATAL:  role "shortkit_auth" does not exist` |

`inet_client_addr()` for the host-published connection is `172.17.0.1`, which is why the
image's `host all all 127.0.0.1/32 trust` line never matches it. The live test stack's
`pg_hba.conf` is the stock set plus the entrypoint's appended `host all all all
scram-sha-256`. F-082.

**`docker compose down -v` does what both files claim.** Scratch project, named volume:
first `up` with a one-role init script → `shortkit_app`; widen the script and do a plain
`down`/`up` → still `shortkit_app` only, container healthy, nothing in the log; `down -v` →
`Volume audit-r3-compose_pgdata Removed`, volume gone from `docker volume ls`; next `up` →
`shortkit_app` and `shortkit_auth`. The remedy sentence in `docker-compose.yml` and the one in
`.env.example:17` are both correct, and the "plain restart does not help" premise holds.

**Every DSN claim in `.env.example` checks out.** The three named variables are the three
interpolated in `docker-compose.yml` (`:181` twice, `:263`), and the superuser password is
correctly outside the URL-safety rule — it reaches the server through `POSTGRES_PASSWORD` and
the healthcheck uses `PGPASSWORD`, not a URL. No new credential is introduced by either commit;
`SHORTKIT_AUTH_PASSWORD=auth` in the template is the fixture value already published in three
committed files, for a loopback-bound stack.

**No new secret, no new fallback, no new surface.** `.env` is gitignored
(`.gitignore:45 .env*` with `!.env.example` restated at `:47`) and does not exist on this
machine. Grepped every `DATABASE_AUTH_URL` site again: still four, none reads `DATABASE_URL`.
Neither commit touches a handler, a query, a header or a logging surface.

## Notes

**The class did not recur where it was fixed; it recurred inside the fix.** F-072's two claims
are now true, and the implementer verified both independently before editing — the report shows
the repro. What was not measured is the sentence added to explain the measurement, and it is
wrong in the direction that flatters the fix ("I measured this over the network *because*
loopback answers differently"). That inference is in the implementer's report too, so it was
carried from reasoning into the file. It is the cheapest possible correction and I would not
spend a round on it alone; fold it into whatever next touches that block.

**`rls-fixture.ts:25-26` was checked and is not a finding.** "docker-compose.test.yml … exports
`DATABASE_URL` / `DATABASE_MIGRATION_URL` for them. This fixture reads those two variables and
nothing else." The clause is scoped to the two roles the same sentence names and the second
half is still exactly true of `dsn()`'s union type. Recorded so round 4 does not re-litigate it.

**`docs/architecture/rls.md:12` and `scripts/check-compose-stack.sh` were left alone, correctly.**
Both were named as other cards' in the dispatch and both remain open items there (TASK-002 wave 1,
TASK-017 wave 9). The `check-compose-stack.sh` contaminant-list gap is round 1's finding and is
unchanged by this range; not re-opened here.

**GC-B.** Nothing in either commit branches on `NODE_ENV`. The `.env.example` additions are
compose interpolation defaults, not environment-keyed behaviour.

**GC-G.** No logging surface touched. Worth carrying forward for whoever writes the wave-2 boot
path: `main.ts:309` logs boot failures with `includeMessage: true`, so a connection failure
message reaches stdout. `pg` does not put the DSN in `error.message`, so no password leaks
there today — that stays true only as long as nobody logs the DSN alongside it.

## Dependencies reviewed

None. Neither commit adds a dependency, bumps one, or touches a lockfile.
