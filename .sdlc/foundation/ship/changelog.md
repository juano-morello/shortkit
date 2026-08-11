# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

No version has been tagged and nothing is deployed. Both apps and `packages/contracts` are
private at `0.0.0`, and ADR-0030 records that the API has no deploy target by decision.
The section below covers everything in the repository, from the first commit to `4a5ab8a`.

## [Unreleased] - foundation - 2026-08-11

Shortkit is being built as a multi-tenant URL shortener for agencies. This release contains
none of that product. It contains the substrate underneath it: one migrated table, one
route, one static page, and the tenancy, contracts, logging and CI machinery around them.

Read it as two different things at once. Vertically it is a foundation: add a table, and
you inherit a tested isolation mechanism that fails closed when you skip a step.
Horizontally it is a demonstration: nothing joins HTTP to the data layer, so the mechanism
guards one table and no request path exercises it. The five increments that turn this into
the product are named in `.sdlc/roadmap.md`, in the order they have to land.

### Added

**Tenant isolation you can run, not read about.**

- Two Postgres roles, `shortkit_migrator` and `shortkit_app`, both `NOBYPASSRLS`. The
  migrator owns every table; the app role owns nothing and runs no DDL. A role that could
  bypass row-level security would turn every isolation assertion into a tautology, so the
  test fixture re-checks the flag before each run.
- `withTenantTransaction` opens a transaction, binds the tenant with
  `SELECT set_config('app.tenant_id', $1, true)`, and runs your function inside it. The
  third argument makes the setting transaction-scoped, so context cannot survive into the
  next use of a pooled connection. Nested frames join the outer transaction and refuse a
  different tenant id. `afterCommit` hooks run once, after the commit, and a throw inside
  one never reaches the caller.
- `tenantScopedPolicies()` generates the four-statement policy block for a new table. Add
  the table, append the block to the generated migration, and `pnpm --filter @shortkit/api
  db:check-policies` fails the build if you forget.
- A cross-tenant isolation suite that runs against a real database. Register a surface with
  one `registerTenantScopedSurfaces()` call and it attempts eight statement shapes in both
  directions between two tenants. Eleven negative controls sit beside it, each one a
  deliberately broken policy that the harness must report as failing, so a green run means
  the harness still detects leaks rather than having stopped looking. A drift check fails
  the run when a tenant-scoped table exists that nobody registered.
- The suite states its own coverage boundary on every run and writes it into `report.json`.
  Today that boundary is two tables, no routes and no repositories, because none exist. A
  green run proves the mechanism works. It does not prove the system has no uncovered
  cross-tenant surface.

**A local stack that comes up with one command.**

- `docker compose up` at the repository root lifts Postgres, applies the migrations, runs
  the seed, and starts the API and the web app. Every service probes what it actually
  promises: the Postgres check authenticates as `shortkit_app` over the compose network
  rather than calling `pg_isready`, which returns success against a server that has not
  finished initialising.
- The seed connects as `shortkit_app` on purpose. Migrate as any other identity and the
  stack stops with `permission denied for table tenants` before the API starts, instead of
  failing later inside whatever feature first reads the table.
- Running `up` twice does not double the seeded data, and the data survives
  `docker compose restart`.
- `./scripts/check-compose-stack.sh` measures fifteen separate clauses and prints a table
  naming which one failed and why. It distinguishes "a clause is red" (exit 1) from "this
  machine could not run the check, so nothing was measured" (exit 2).
- The stack takes its own Compose project name, `shortkit-dev`, so it cannot recreate or
  delete the integration suite's container. Ports do not separate Compose stacks. Project
  names do.

**One set of contracts, and CI proves they bind.**

- `packages/contracts` holds the zod schemas the API builds its error envelope from and the
  web client narrows on. It ships TypeScript source with no build step, so an incompatible
  change breaks `pnpm typecheck` in the same commit.
- CI mutates the package and asserts a consumer goes red, rather than trusting that it
  would.
- Every rejected request returns a stable machine-readable `code`. Unresolvable requests
  return 404 with that envelope. No unresolvable request returns 5xx.
- The web API client validates every response against the declared contract and raises a
  distinguishable contract-violation error rather than handing back malformed data. It
  refuses URLs that do not resolve under the same-origin proxy prefix, rejects repeated and
  malformed path placeholders, and attaches a cause only to genuine aborts.

**Logging that cannot leak by accident.**

- Structured logs through pino. A field reaches the log line only if it is named in the
  allowlist, so adding a field to an object does not publish it.
- Errors are replaced at every key, not only under `err`, and a credential cannot be
  constructed into an error string.
- A lint rule fails the build when a module imports `Logger` from `@nestjs/common` or any
  other logging package, which is what keeps the allowlist from being bypassed one import
  at a time.

**The rest of the scaffold.**

- pnpm workspaces with three packages: `@shortkit/api` (NestJS), `@shortkit/web` (Next.js
  App Router) and `@shortkit/contracts`. Vitest 3 in all three.
- `GET /health` returns `{"status":"ok","commit":"<sha>"}`. The sha arrives as a build
  argument, and an image that can reach traffic refuses to start without a real one.
- Security headers on every API response through helmet. CORS off.
- CI runs three jobs that all have to pass: `quality` (lint, typecheck, test, build,
  production dependency audit, inlined-secret scan, contract-drift mutation), `integration`
  (migrations, the RLS policy gate, then the suite against a real Postgres), and `compose`
  (the fifteen-clause stack check).

### Changed

- Migrations are applied forward and never reversed. Going back means reverting the code
  and writing a new forward migration. Juano ruled this on 2026-08-11 under F-392: the
  posture holds while the schema stays additive-only and no production database exists, and
  gets revisited when either stops being true. ADR-0004 and `docs/architecture/migrations.md`
  carry the reasoning.
- Git refuses to merge migration metadata. A conflict in `drizzle/meta/**` or a migration
  `.sql` stops for a human instead of producing a plausible wrong file that applies cleanly
  on a developer machine and fails on an empty database.
- The isolation harness was rebuilt across five rounds. Each round found a class of leak the
  previous one scored as a pass: attempts running in one direction only, a throw counting as
  a refusal, unqualified writes that PostgreSQL routes through the SELECT policy and reports
  as zero rows however wide open the UPDATE policy is, and owner-column writes. The negative
  controls are the record of what each round measured.

### Removed

- `fly.toml` and `infra/deploy.sh`. Nothing was ever deployed to Fly, and keeping the files
  implied a deploy target that does not exist. ADR-0030 records the decision and lists the
  six constraints that survive it, so whoever picks a platform later reads one list instead
  of reconstructing it. The one place migrations run outside a developer's shell is
  `docker compose up`.

### Security

- Row-level security is forced on every tenant-scoped table, and `db:check-policies` blocks
  CI when a migrated table is missing its policies. Grants come from
  `ALTER DEFAULT PRIVILEGES`, so a table shipped without policy DDL is readable by every
  tenant and its own tests still pass. The gate is what catches that.
- Both database roles are `NOBYPASSRLS`, and the API refuses to boot if the runtime role
  turns out to be able to bypass row-level security.
- The production dependency graph is audited on every pull request. As of `4a5ab8a`:
  `No known vulnerabilities found`.
- A build that inlines `BFF_PROXY_SECRET` into the client bundle fails CI. The check refuses
  to run at all when the variable is empty rather than reporting a pass it never made.
- Log field allowlisting and credential-safe error construction, above.

### Not in this release

Named because a changelog that lists only what landed reads like more than it is.

There is no redirect path, no cache and no link table. There is no dashboard, no sign-up,
no authentication and no invitations. No custom domains. Nothing joins HTTP to the data
layer: the decorators that would bind a request to a tenant throw `not implemented`, and
the web client's proxy route does not exist and answers 404. Both deployables boot and
serve, and neither one calls the other.
