---
id: TASK-059
story: STORY-002
epic: EPIC-001
title: Whole stack up from nothing with docker compose, seeded
status: todo
owner_slot: sdlc-implementer-backend
depends_on: [TASK-001, TASK-003, TASK-005]
paths: ["docker-compose.yml", "docker-compose.test.yml", "Dockerfile", "apps/web/Dockerfile", ".dockerignore", "fly.toml", "infra/**", "apps/api/scripts/seed.mts", "apps/api/package.json", "package.json", "docs/architecture/migrations.md", "README.md", ".env.example", "apps/web/.env.example", "scripts/**"]
contracts: ["design/contracts/rls-policy-template.md", "design/contracts/tenant-context.md"]
test_files: ["scripts/check-compose-stack.sh"]
acceptance: [AC-115]
rework_count: 0
---

## Why this TASK exists

Minted 2026-08-11 under **Amendment A-8** on STORY-002, by Juano's ruling. AC-6 named
Fly.io; nothing was ever deployed there through five audit rounds and four fix rounds, and
TASK-003 sat escalated on a clause only Juano could clear. Rather than wait on a deploy
target, the ruling repurposes the work: **where this deploys is deliberately undecided, and
what matters now is that the whole stack comes up from nothing with one command.**

AC-6 kept its id and lost only the deploy clause. AC-115 is new and is this TASK's.

## Intent

A machine with Docker and a clone of this repository runs `docker compose up` at the root
and gets a working Shortkit: Postgres with its roles, the schema migrated, seed data
present, the API serving `/health`, and the web app serving its root page.

## Approach

Three services — `postgres`, `api`, `web` — plus migrations and seed as part of bringing
the stack up. Ruled by Juano 2026-08-11: **no Redis yet.** It is in the planned stack and
nothing in the codebase reads it, and a service with no consumer reads as coverage — the
shape F-283 and F-299 name on other artifacts.

### `docker-compose.test.yml` is not the template, and this is the whole hazard

That file carries a banner reading `TEST-ONLY. DO NOT ADAPT THIS FILE INTO A PRODUCTION
DATABASE (F-131)`, and it means it. Reusable from it: the roles section, which is
`rls-policy-template.md` "Roles" applied — both roles `NOBYPASSRLS`, `shortkit_app` owning
nothing and receiving DML only through `ALTER DEFAULT PRIVILEGES` granted by
`shortkit_migrator`, `USAGE` on schema `public` and nothing more.

**Not** reusable, per that file's own list: literal passwords in a committed file including
the bootstrap superuser's; no TLS requirement; **tmpfs storage, which loses everything on
restart** — a stack that seeds and then forgets on `restart` does not satisfy AC-115; and
`ALTER DEFAULT PRIVILEGES` being scoped to the identity `shortkit_migrator`, so a stack that
runs migrations as any other role grants `shortkit_app` nothing. That last one fails closed,
but it fails at runtime rather than at startup.

The health check is worth copying wholesale and the reason is written out at
`docker-compose.test.yml`: `pg_isready` marks the container healthy during the postgres
entrypoint's temporary socket-only server, so `up --wait` returns and the next command gets
`ECONNREFUSED` or "role shortkit_app does not exist". The probe that works authenticates as
`shortkit_app` over TCP against the real database.

### Seeding, and what it can honestly mean today

**The production schema is one table: `tenants`.** `rls_fixture_rows` is created by the test
fixture at runtime and is not in the migration. Links, users, auth and workspaces all left
with EPIC-002..006 in the 2026-08-09 re-scope.

So the seed inserts one demo tenant and that is the truthful whole of it. Write it as the
script that future tables add rows to rather than as a one-off, and **say in the file how
little it covers**, the way `coverage.ts` prints its coverage boundary. A seed that looks
comprehensive and covers one table is the same defect class as a harness that reports PASS
over two tables.

The seed must be idempotent: `docker compose up` twice in a row must not fail on a duplicate
key, and must not silently double the data.

### Removing the Fly artifacts

Under the same amendment: delete `fly.toml` and `infra/deploy.sh`, and strip Fly from
`docs/architecture/migrations.md` and ADR-0027's consequences. An ADR records that no deploy
target is chosen — written by `sdlc-architect`, not by the implementer.

This **discharges F-142**, open and undischarged since 2026-08-05: `migrations.md:120` says
the Fly release command runs migrations while `fly.toml` deliberately has none, which sends a
reader to `fly deploy` by hand against an unmigrated schema with `/health` still reporting
green. Confirm it is gone rather than assuming the deletion covered it.

### Design constraints — ADR-0030 through ADR-0037 (2026-08-11)

Design ran for this TASK on 2026-08-11 and settled eight decisions. Each is an ADR under
`.sdlc/foundation/design/`. What follows is what you must respect; the reasoning and the
rejected alternatives are in the ADRs and are worth reading before you write the compose
file, not after.

**ADR-0037 was `proposed` and is now ACCEPTED — Juano ruled 2026-08-11.** Build with
`GIT_COMMIT_SHA: ${GIT_COMMIT_SHA:-0000000000000000000000000000000000000000}` — git's null
object id, forty zeros. It matches the Dockerfile guard's `/^[0-9a-f]{40}$/`, so **no `??`,
`||`, default parameter or sentinel string goes into any TypeScript file**, and `git rev-parse
HEAD` can never return it, so `/health` reporting it is unambiguous. The README carries both
forms, the real-provenance one first.

The narrowing this makes to ADR-0027 is: *an image that cannot reach traffic may report an
unknown commit; an image that can, may not.* **The precondition it adds to ADR-0030 is not
optional** — whatever builds a deployed image supplies a real SHA, and nothing inherits this
default. The `migrator` stage takes no build argument and runs no guard; neither one-shot
service serves a request or reports a commit.

#### READ THIS FIRST: every `$` in the compose file is `$$`

Design rework round 1, 2026-08-11 (F-315, F-316). **Docker Compose interpolates
`configs.*.content`, `healthcheck.test` and `command` against the HOST environment at parse
time.** A single `$` in any of those is substituted before the container ever sees it, and on
AC-115's own scenario — nothing exported, no `.env` — it is substituted with the empty
string. Proved twice by execution with `docker compose config`, once by the security auditor
and once independently.

It does not fail loudly. The roles script would run `--username "" -v app_password=""`;
libpq treats an empty user as unset and connects as `postgres`, PostgreSQL answers
`PASSWORD ''` with a NOTICE rather than an error, `ON_ERROR_STOP=1` never fires, and the
container reports initialisation complete with two passwordless roles that nothing else in
the stack can authenticate as. The health probe would run `PGPASSWORD=""` and Postgres would
never go healthy, so `migrate` never starts and `up --wait` exits non-zero. AC-115 red on its
own command, on a clean machine, every time.

**So: `$$POSTGRES_USER`, `$$SHORTKIT_MIGRATOR_PASSWORD`, `$$SHORTKIT_APP_PASSWORD` inside
`configs.*.content`, and `PGPASSWORD="$$SHORTKIT_APP_PASSWORD"` in the probe.** `$$` reaches
the container as a single `$`. **The `node -e` probes contain no `$` and must not be given
`$$`.** `${VAR:-default}` in `environment:`, `args:` and `ports:` is different and correct as
written — that is interpolation you want.

Two traps around this. `docker compose config` prints `$$` back, so **reading the rendered
output cannot tell you the escaping is right** — the printer escapes on output and a source
`$$` and a substituted `$` are indistinguishable in it. What is observable without a
container is the lexer: `$$NAME` with `NAME` unset emits **no warning at all**, where a real
reference always warns. If you want to check your escaping before running anything, delete
the variable from your shell and look for the absence of a warning, not at the dollars. And
`docker-compose.test.yml`'s probe contains no `$` at all, so **the repository has no worked
example of this and you will not find one**. When Postgres will not go healthy, do not reach
for a literal password in the probe (that is the F-131 shape), for `pg_isready` (the measured
false positive ADR-0036 exists to prevent), or for `POSTGRES_HOST_AUTH_METHOD=trust` (a
Postgres on 55432 accepting any password for `shortkit_migrator`). Check the escaping first.

**Rebuilds (ADR-0037, F-319).** `docker compose up` builds only when no image exists, so
after the first bare `up` an exported `GIT_COMMIT_SHA` changes nothing and a source edit
serves the previous image. Set `pull_policy: build` on all four built services (`api`,
`web`, `migrate`, `seed`), and write the provenance form in the README with `--build`:
`GIT_COMMIT_SHA="$(git rev-parse HEAD)" docker compose up --build`. Verified that Compose
parses and preserves `pull_policy: build`. Two things for the README: every `up` pays a
build-graph check, and **real provenance is not sticky** — because `up` now rebuilds every
time, the next bare `docker compose up` rebuilds with forty zeros and `/health` silently
reverts. The exported variable belongs on every `up` meant to carry a real SHA, not just the
first.

**Deploy target (ADR-0030).** Delete `fly.toml`, `infra/deploy.sh` and the now-empty
`infra/` directory, and drop the `infra` line from `.dockerignore`. Rewrite the "At deploy"
section of `docs/architecture/migrations.md` and the four Fly comments in the `Dockerfile`
(header, the `--prod` install, `EXPOSE`). Replace both `https://shortkit-api.fly.dev/api`
values in `apps/web/.env.example`. **Do not touch ADR-0027, ADR-0004, `apps/api/src/**` or
`apps/web/src/**`** — they carry Fly references too and ADR-0030 lists them for routing.
Six constraints from `fly.toml` are platform-independent and survive in ADR-0030's "What
survives the deletion" section; `migrations.md` cites them rather than restating them.
Confirm F-142 is discharged by reading `migrations.md:118-157` before you rewrite it, not
by assuming the deletion covered it.

**Roles (ADR-0031).** Transcribe `rls-policy-template.md`'s "Roles" section into
`docker-compose.yml`. Do not copy `docker-compose.test.yml` and do not edit it. Deliver the
SQL as a shell init script at `/docker-entrypoint-initdb.d/10-roles.sh` so `psql -v` is
available and the contract's `:'app_password'` form works verbatim; the exact script is in
the ADR — **with `$$`**. `POSTGRES_DB: postgres`, and
`CREATE DATABASE shortkit OWNER shortkit_migrator` is what makes the migrator the owner.
`ON_ERROR_STOP=1`. Carry the `NOBYPASSRLS` comment across, not just the keyword: it is the
Postgres default and reads as redundant to anyone who does not know what it is doing, and the
test file carries the same sentence for the same reason. Passwords are fixture defaults,
every published port binds `127.0.0.1`, Postgres on 55432, and the file carries a
`LOCAL DEVELOPMENT ONLY` banner with its own reusable and not-reusable lists — including
`restart: unless-stopped` on `postgres`, which is right here and means a database with the
committed superuser password returns on every daemon start.

**Persistence (ADR-0032).** One named volume `pgdata` at `/var/lib/postgresql/data`. No
tmpfs, no bind mount. Do **not** set `name:` in the compose file. README carries the reset
ladder and the three situations that require `down -v`, including the silent one: the roles
script runs only against an empty data directory, so editing it changes nothing until
`down -v`. Two more sentences for the README (F-318, F-325): Compose derives the project name
from the **directory basename**, so two clones both named `shortkit` share one `pgdata` and
`COMPOSE_PROJECT_NAME` is how a developer separates them; and the volume is unencrypted
developer storage outside every repository-level clean, holding one synthetic tenant and no
personal data today.

**Migrations and seed (ADR-0033).** A new `migrator` stage in the existing `Dockerfile`,
`FROM build`, adding `drizzle.config.ts`, `drizzle/` and `scripts/`, commented as NOT
DEPLOYABLE. Two one-shot services: `migrate` runs `db:migrate` as `DATABASE_MIGRATION_URL`,
then `seed` runs `node apps/api/scripts/seed.mts` as `DATABASE_URL`. Chain is
`postgres` healthy → `migrate` completed → `seed` completed → `api`. **The seed runs as
`shortkit_app` on purpose**: it is what turns "migrated as the wrong identity" from a
runtime failure into a `permission denied for table tenants` before the API starts. Never
put migration SQL in `/docker-entrypoint-initdb.d`; that runs as the superuser and grants
`shortkit_app` nothing.

**Seed (ADR-0034).** `apps/api/scripts/seed.mts`, `.mts` with no build step, importing `pg`,
in the manner of `check-policies.mts` — no syntax that needs emit. The `SeedUnit` interface,
`SEED_UNITS`, the **six** rules, the census query and the exact printed output are normative
in the ADR. `DEMO_TENANT_ID` is `00000000-0000-4000-8000-000000000001` and is frozen. The
census reads `pg_class`, never `information_schema` — F-213, and the seed connects as
`shortkit_app`, which is exactly the connection that makes the difference. **Rule 6 is new
(F-322)**: the seed reads `select current_user, current_database()`, prints both as its first
line, and exits non-zero before writing if the role is not `shortkit_app` or the database is
not `shortkit`. The role half is what makes the grant check real — nothing else asserts the
seed connected as the role it is credited with, and `shortkit_app` to `shortkit_migrator` in
the compose file is a one-token edit that makes the seed pass unconditionally. The database
half replaces `infra/deploy.sh`'s deleted refusal: `pnpm db:seed` from a shell that exported
the integration suite's `DATABASE_URL` would otherwise write the demo tenant into
`shortkit_test`. **Do not write a loopback refusal**, which would be wrong both ways — it
permits the dangerous case, since the test database is on `127.0.0.1`, and rejects the
legitimate one, since the seed's primary invocation is inside the `seed` container where the
host is the service name `postgres`. The database **name** separates them from wherever the
script runs. Residual to keep in mind and not to solve here: neither check distinguishes a
future production database, which would plausibly also be `shortkit` with role
`shortkit_app`. Add a `db:seed` script to `apps/api/package.json`.

**Web (ADR-0035).** `apps/web/Dockerfile`, context is the repository root, stages mirroring
the API's. The runtime stage needs `packages/contracts/src` present for the prod install's
workspace symlink, and `next.config.ts` for `next start`. Set no `NEXT_PUBLIC_*` variable and
no `BFF_PROXY_SECRET`. `web` declares **no** `depends_on`. Say plainly in the compose file
and the README that anything through `apiClient()` returns 404 because the BFF proxy route
does not exist in this repository; `apps/web/.env.example` documents
`API_BASE_URL=http://api:3001/api` as the value the proxy will read when it is written, and
its head comment gets rewritten in the same edit — it currently explains that
`NEXT_PUBLIC_API_BASE_URL` and `API_BASE_URL` are deliberately the same Fly value, and after
this they are neither. **Do not re-open the F-154 ruling** and do not touch `LEAK_TARGET_VAR`
or `POSITIVE_CONTROL_VAR` in `assert-no-inlined-secrets.mjs`. Do not add
`output: 'standalone'`; `next.config.ts` is outside your paths.

**The web Dockerfile's COPY list is explicit, and `COPY apps/web apps/web` is forbidden
(F-317).** `apps/web/.env.example` line 1 tells developers to copy it to `.env.local`; that
file holds `BFF_PROXY_SECRET` and sits in your build context. The broad COPY puts it in an
image layer, and `next build` loads `.env.local` in every environment but test, so any
`NEXT_PUBLIC_*` a developer added to it is inlined into `.next/static/**`. The compose build
runs `next build` only, never `assert:no-secrets`, so the repository's one guard against that
is absent from this path. The exact COPY list is in ADR-0035. **In the same edit that drops
the `infra` line, `.dockerignore`'s secret block gains recursive forms** — `**/.env`,
`**/.env.*`, `!**/.env.example`, `**/.npmrc`, `**/*.pem`, `**/*.key` — because the existing
patterns are root-anchored, which the file's own author knew for `dist` and `.next` and not
for these. Verify by creating `apps/web/.env.local`, building, and inspecting the image and
`.next/static/**`; not by reading the Dockerfile.

**Health and ordering (ADR-0036).** Postgres gets the test stack's probe carried forward
with its reasoning, using `PGPASSWORD="$$SHORTKIT_APP_PASSWORD"` rather than a DSN. API and
web get `node -e` fetch probes; the API's asserts 200 and `status === 'ok'`.
`start_period: 30s` on the API is coupled to `main.ts`'s 20-second
`DATABASE_REACHABLE_BUDGET_MS` and the comment must say so, because that coupling currently
lives in `fly.toml` and you are deleting it. Write in the compose file that a green `api`
means the boot check passed at boot, not that the database is reachable now.
`restart: unless-stopped` on the three long-running services, `"no"` on the two one-shots.

**`docker compose restart` restarts the exited one-shots too and ignores `depends_on`
conditions**, so the DoD's restart rung prints `migrate` and `seed` failing against a
Postgres that is not yet accepting connections. Data survives, which is what the DoD asks.
Say so in the README beside the command, or the next developer reads two red services as a
broken stack and reaches for `down -v`, destroying the data the rung exists to demonstrate.

**Verify rather than assume, and disclose in your report if any of these is wrong.** Design
started no containers and built no images. Three items from round 1 are now settled by
execution and are stated above as facts rather than assumptions: Compose interpolation of
`configs.*.content` and `healthcheck.test`, that `$$` survives to the container as `$`, that
`pull_policy: build` parses, and that the project name defaults to the directory basename.
Still unverified: **that `mode: 0555` takes effect at all.** Docker's reference says `mode` is
ignored for bind-mounted config content, which is how a `content:` config is delivered. It
parses and is preserved; that is all that was measured. Set it and read the entrypoint's own
log line, which says `running` or `sourcing`, and record which you got. Either outcome comes
up: run means executed cleanly, sourced means the script's `set -eu` stays set in the
entrypoint's shell for the rest of initialisation. That hazard is **latent, not live** —
nothing the entrypoint executes afterwards dereferences an unset variable today, and the
maintainers' own `# TODO swap to -Eeuo pipefail` on line 3 is the shape of it. Also
unverified: that `service_completed_successfully` behaves as described on the installed
Compose; that `next start` in the runtime stage works with a prod install rather than a
standalone build; and that `.dockerignore`'s recursion behaves as described, which needs a
build to confirm. The `node -e` probe strings **were** checked and are fine as written.

## Out of scope

Choosing a deploy target. Production role provisioning with real secrets — still unowned and
routed alongside F-116. Redis. Anything the schema does not yet have to seed. A CI job that
runs `docker compose up`; AC-115 is satisfied on a developer machine, and wiring it into CI
belongs with whoever owns the workflow next.

## Interfaces

**Consumes**

The `Dockerfile` TASK-003 built and proved (200 on `/health` with `commit` equal to
`git rev-parse HEAD`, measured 2026-08-10). The migration in `apps/api/drizzle/`. The roles
contract at `design/contracts/rls-policy-template.md`.

**Produces**

`docker-compose.yml` at the repository root; a web image; `apps/api/scripts/seed.mts`; a
`README` section on bringing the stack up; the deletion of the Fly artifacts.

## Path overlap, stated rather than discovered

`fly.toml`, `Dockerfile`, `.dockerignore` and `infra/**` are also in **TASK-003's** `paths`.
That is a real overlap and not an oversight: TASK-003 must be finished before this TASK is
dispatched, and both are owned by `sdlc-implementer-backend`, so they serialize. Do not run
them concurrently in one worktree.

`docker-compose.test.yml` is **TASK-005's** and TASK-005 is `done`. It is listed here because
the roles block may need to move to a shared place rather than being copied — and copying it
is the F-131 hazard above. If it stays copied, say why in the file.

## Definition of Done

- [ ] AC-115 green, demonstrated from a genuinely clean state: `docker compose down -v --rmi
      local`, then bare `docker compose up`. `down -v` alone removes the volume and leaves the
      images, so it does not exercise the build the null-SHA default lives in (ADR-0037)
- [ ] `docker compose up` twice in a row succeeds; the seed is idempotent
- [ ] Data survives `docker compose restart`
- [ ] All auditors clear of blocker/major
- [ ] README updated with the one command and what it gives you
- [ ] F-142 confirmed discharged
- [ ] Traceable: commits reference `[TASK-059]`
