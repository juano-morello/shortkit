---
id: ADR-0033
slug: foundation
title: Migrations and seed run as two one-shot compose services from a non-deployable image stage, each as its own role
status: accepted
supersedes: null
date: 2026-08-11
---

## Context

AC-115 requires that after `docker compose up`, the migrations have been applied and the
seed has run. Something has to run `drizzle-kit migrate`, and four constraints decide what.

`drizzle-kit` is a devDependency of `apps/api`. The `Dockerfile`'s runtime stage installs
production dependencies only, deliberately, and that is what keeps GHSA-67mh-4wv8-2f99 out
of the deployed graph and keeps `docs/security/known-advisories.md`'s acceptance true. So
the API image cannot run migrations. This is F-119's settlement and ADR-0030 carries it
forward as platform-independent.

ADR-0004 forbids running migrations from application boot, because concurrent instances
race.

`ALTER DEFAULT PRIVILEGES FOR ROLE shortkit_migrator IN SCHEMA public` grants
`shortkit_app` its DML on tables **the identity `shortkit_migrator` creates**. A stack that
migrates as any other role produces tables `shortkit_app` cannot touch. `docker-compose.test.yml`
names this as the fourth non-reusable item and adds the part that makes it expensive: it
fails closed, but it fails at runtime rather than at startup. The API would boot fine, and
the first query against `tenants` would return `permission denied for table tenants` in
whatever feature happened to run it.

`apps/api/scripts/check-policies.mts` is the precedent for a script in this repository:
`.mts`, run by `node` with no build step, importing `pg` directly.

## Alternatives considered

**Put the migration SQL in `/docker-entrypoint-initdb.d`.** Pros: no extra service, no
extra image, runs before anything else by construction. Cons: the entrypoint runs those
files as the bootstrap superuser, so every table is owned by `postgres`,
`ALTER DEFAULT PRIVILEGES FOR ROLE shortkit_migrator` applies to none of them, and
`shortkit_app` gets nothing. It also runs once and never again, so a new migration would
need a `down -v`, and `__drizzle_migrations` would not know the migration had been applied.
Why it lost: it is the exact failure the fourth non-reusable item names, reached by the
most tempting route in the file.

**Run migrations from the API's entrypoint before `node dist/main.js`.** Pros: one fewer
service; ordering is automatic. Cons: `drizzle-kit` is not in that image, so it does not
work at all; and if it were, ADR-0004 forbids it. Why it lost: barred twice.

**Promote `drizzle-kit` to a dependency so the API image can migrate.** Pros: one image.
Cons: fails `pnpm audit --prod --no-optional --audit-level moderate`, which blocks every
merge, and falsifies the accepted advisory assessment. Why it lost: F-119 already settled
this and nothing about compose changes the reasoning.

**Mount the working copy into a `node:24-alpine` container and `pnpm install` at start.**
Pros: no new Dockerfile stage; the migration always matches the working tree. Cons: an
install on every `up`, network required every time, and a `node_modules` forest built
inside the container over a bind-mounted tree that may already hold the host's. Why it
lost: `docker compose up` on a fresh clone would spend minutes and would fail offline.

**One combined `migrate-and-seed` service.** Pros: one service, one image reference, a
shorter dependency chain. Cons: the two steps authenticate as different roles and fail for
different reasons, and a combined service makes "the seed could not write" look like "the
migration failed". Why it lost: the role separation is the whole point, and collapsing the
two hides the signal this ADR exists to produce.

## Decision

**A new `migrator` stage in the existing `Dockerfile`, and two one-shot compose services
built from it.**

The stage is `FROM build`, which already ran `pnpm install --frozen-lockfile --filter
@shortkit/api...` with dev dependencies and therefore has `drizzle-kit`. It adds what the
build stage does not copy:

```dockerfile
# NOT A DEPLOYABLE STAGE. It carries devDependencies, including drizzle-kit and the
# esbuild advisory accepted in docs/security/known-advisories.md on the stated grounds
# that no copy of drizzle-kit is deployed. Referenced only by docker-compose.yml.
FROM build AS migrator
COPY apps/api/drizzle.config.ts apps/api/
COPY apps/api/drizzle apps/api/drizzle
COPY apps/api/scripts apps/api/scripts
```

It declares no `ARG GIT_COMMIT_SHA` and runs no provenance guard: neither service serves a
request and neither reports a commit (ADR-0037).

**Two services, in order, each as its own role.**

| Service | Command | DSN | Role |
|---|---|---|---|
| `migrate` | `pnpm --filter @shortkit/api db:migrate` | `DATABASE_MIGRATION_URL` | `shortkit_migrator` |
| `seed` | `node apps/api/scripts/seed.mts` | `DATABASE_URL` | `shortkit_app` |

Both carry `restart: "no"`. The chain is:

```
postgres (service_healthy)
  -> migrate (service_completed_successfully)
    -> seed (service_completed_successfully)
      -> api
```

`web` depends on none of them (ADR-0035).

**The seed runs as `shortkit_app`, and that is the grant check.** This is the decision that
converts the fourth non-reusable item from a runtime failure into a startup failure. If
anything migrated as a role other than `shortkit_migrator`, the tables exist, the API would
boot, and nothing would be wrong until a query ran. Instead the seed's first `INSERT` fails
with `permission denied for table tenants`, the `seed` service exits non-zero, `api` never
starts because its dependency did not complete successfully, and `docker compose up`
reports the failing service by name. The error text is Postgres's own and names the table.

**The seed also proves the RLS path, because it has no way not to.** `tenants` carries
`FORCE ROW LEVEL SECURITY`, so the owner is subject to its policies too, and
`tenants_self_insert` admits only a row whose `id` equals `current_setting('app.tenant_id')`.
No role in this stack can insert a tenant without setting the flag first. There is no
design freedom here and the seed is written against it rather than around it (ADR-0034).

**`apps/api/scripts/seed.mts` sets `app.tenant_id`, and that is a widening recorded rather
than discovered.** ADR-0003 clause A1 requires exactly one file in the scan set to contain
a `set_config` call naming each flag. The scan set is `apps/api/src/**/*.ts` minus
`*.spec.ts`, so `apps/api/scripts/**` is outside it by construction, exactly as
`apps/api/test/**` and `apps/api/drizzle/**` are. The seed is admissible on the same terms
those are: it never runs on a request path, it runs as a one-shot process that exits, and
the value it binds is a module constant in the same file, not a request-derived value. This
does not change `ISOLATION_EXCLUSIONS` and does not add a policy.

**And the strongest form of that argument is structural rather than conventional: the file
is not in the runtime image.** The `Dockerfile`'s runtime stage COPYs `apps/api/dist` and
nothing else, so no copy of `seed.mts` exists in the container that serves requests. The
`migrator` stage that does carry `scripts/` is never deployed and exits. So the second
`set_config` call site cannot reach a request path by construction, which is a different and
better claim than deciding it is acceptable. Anything that changes the runtime stage's COPY
list to include `scripts/` invalidates this paragraph.

If a later TASK widens clause A1's scan set to `apps/api/**`, this file is the first thing
it will find, and it should be listed rather than exempted.

**`db:check-policies` does not run in this stack.** It is the third loud check and it would
catch a migration whose policy DDL was forgotten. It is not included because AC-115 does not
ask for it and CI's `integration` job already runs it. What would force including it: a
migration landing whose policies were missing and CI not catching it before a developer did.

## Consequences

### Positive

- Migrations run as `shortkit_migrator` and nothing else in the stack can run DDL, so the
  grant chain the whole role model depends on is the one that actually executes.
- The single most expensive failure in this stack, migrating as the wrong identity, now
  fails during `docker compose up` with a Postgres error naming the table, before the API
  starts. It used to fail in an unrelated feature at an unrelated time.
- The API image is unchanged. It still installs production dependencies only, still ships
  no `drizzle-kit`, and `docs/security/known-advisories.md` stays true.
- Migrations do not run from application boot, so ADR-0004 holds without a special case.
- `up` prints four named steps, so a reader of the console output can see which one failed.

### The cost accepted

- **A second image stage exists that must never be deployed.** It carries `drizzle-kit` and
  the accepted esbuild advisory. The comment in the Dockerfile is the only thing stopping
  someone from choosing `target: migrator` for a deployed service, and a comment is not a
  guard. ADR-0030's precondition list is where this has to be re-read before a deploy target
  is chosen.
- **The migrator stage runs as root.** The `build` stage sets no `USER` and the migrator
  inherits that. Both services are local-only and exit, so the exposure is bounded, and it
  is a real difference from the `runtime` stage's `USER node`.
- **The seed doubles as a test and is not named one.** If the seed ever becomes trivially
  satisfiable, for example by a unit that does nothing when its table is missing, the grant
  check silently stops checking. ADR-0034's requirement that every unit performs a real
  write is what keeps it honest, and nothing enforces it.
- **Four services to start before the API, so `up` on a cold cache takes longer** and the
  dependency chain is serial by construction. On a warm cache it is a few seconds.
- **`service_completed_successfully` is not supported by every Docker Compose version.** It
  needs Compose v2. The README states the floor rather than letting it fail obscurely.
- **A failed `migrate` leaves a database with roles and no schema.** The next `up` retries
  from where it stopped, which is correct, but a partially applied non-transactional
  migration leaves a state no file describes and `down -v` is the only repair.

### Follow-ups this creates

- TASK-059 writes the `migrator` stage, both services, and `apps/api/scripts/seed.mts`.
- `docs/architecture/migrations.md` gains a section describing this mechanism, replacing
  the "At deploy" section ADR-0030 removes.
- If `db:check-policies` is ever added to this stack it belongs as a third one-shot service
  between `seed` and `api`, reading `DATABASE_URL`, for the reason `migrations.md` already
  gives about running it as the runtime role.
