# Shortkit

Shortkit is a multi-tenant URL shortener for agencies. An agency signs up once,
creates a workspace per client, points that client's branded domain at the
workspace, and invites teammates scoped to the clients they work on. Visitors
never see the product. They get one redirect that resolves fast or does not.

Three rules shape the codebase:

- **Postgres enforces tenant isolation.** Every tenant-scoped query runs inside a
  transaction that has bound the tenant to the connection, and row-level security
  backs that up. Isolation gets proven by a suite that runs against a real
  database, not asserted in a comment.
- **The redirect path stays isolated.** It reads a cache, falls back to one
  parameterised statement, and imports nothing from the management API. No ORM
  runs on it.
- **One set of contracts.** `packages/contracts` holds zod schemas that the API
  validates against and the web app compiles against, so a shape change breaks
  the typecheck in the same commit.

## Layout

| Workspace | Package | What it is |
| --- | --- | --- |
| `apps/api` | `@shortkit/api` | NestJS. Management API under `/api`, `GET /health` at the root, and the redirect |
| `apps/web` | `@shortkit/web` | Next.js App Router dashboard |
| `packages/contracts` | `@shortkit/contracts` | Shared zod schemas and the types inferred from them |

## Requirements

- Node 24.13 or newer. `@types/node` tracks the same line, so the API surface the
  compiler knows is the one the runtime has. `engineStrict` in `pnpm-workspace.yaml`
  makes the floor a hard failure: an older Node fails the install instead of warning
- pnpm 11.20.0, pinned in `packageManager` with the tarball hash Corepack verifies

## Commands

Run these from the repository root.

| Command | What it does |
| --- | --- |
| `pnpm install` | Installs every workspace from `pnpm-lock.yaml` |
| `pnpm lint` | ESLint across all three workspaces |
| `pnpm typecheck` | TypeScript with no emit, per workspace |
| `pnpm test` | Vitest across all three workspaces, with no database and no network |
| `pnpm build` | Bundles the API to `apps/api/dist/` with tsup and builds the Next.js app |
| `pnpm test:integration` | API suites that need a live Postgres |

`pnpm build` bundles the API with tsup rather than emitting file by file.
`packages/contracts` ships TypeScript source and has no build step (ADR-0005), so
the bundler inlines it; a file-by-file emit would leave the API requiring a `.ts`
file at runtime. Types are checked by `pnpm typecheck`, not by the build.

`pnpm test` and `pnpm test:integration` are separate on purpose. The first runs
anywhere, on a clone with nothing installed but the workspace. The second needs a
database, so it stays off the loop a contributor runs on every save.

## Running the whole stack

With Docker and this clone, and nothing else installed:

```
docker compose up
```

Postgres comes up with its two roles, the migrations are applied, the seed inserts one
demo tenant, and the API and the web app start.

| Address | What answers |
| --- | --- |
| `http://localhost:3000/` | the web app's root page |
| `http://localhost:3001/health` | `{"status":"ok","commit":"…"}` |
| `postgres://shortkit_app:app@127.0.0.1:55432/shortkit` | the database |

Every port binds `127.0.0.1`, so a stack whose committed password is `app` is not on the
LAN. Docker Compose v2 or newer: the startup ordering uses
`service_completed_successfully`, which older versions do not understand.

The whole file is **local development only**. There is no production database, and no
deploy target is chosen for the API (ADR-0030).

### What a green stack does not give you

`docker compose up` prints five services and ends with `api` and `web` healthy. Two gaps
are worth knowing before you read that as a working system.

**The frontend cannot call the backend.** Everything under `apps/web` that goes through
`apiClient()` targets the same-origin BFF proxy at `/api/bff/…`, and that route does not
exist in this repository. It returns 404. No screen calls it today, so nothing is broken,
but two green containers are not evidence of a path between them.

**A green `api` means the process is up, not that the database is reachable now.**
`/health` touches no database by design. What carries the database claim is boot: the API
refuses to start unless it reached Postgres and established that its role cannot bypass
row-level security.

### Build provenance

```
docker compose up                                                   # AC-115's command
GIT_COMMIT_SHA="$(git rev-parse HEAD)" docker compose up --build    # real provenance
```

A bare `up` builds with git's null object id — forty zeros — and `/health` reports it.
That is correct and deliberate: no fresh clone can know its own commit through Compose,
which cannot run a command (ADR-0037). Forty zeros is a value `git rev-parse` can never
return, so it is unambiguous rather than misleading.

`--build` is load-bearing in the second form, not decoration. So is the placement of the
variable: **real provenance is not sticky.** The next bare `docker compose up` rebuilds
with forty zeros and `/health` reverts, announcing nothing. Export it on every `up` that
is meant to carry a real SHA.

Every `up` now pays a build-graph evaluation, because all four built services set
`pull_policy: build`. With a warm cache that is a second or two. Without it — after a
`docker system prune` — it is a full rebuild of four images on a command you expected to
be instant.

### Resetting, and the one command that destroys data

| Command | What survives | When to use it |
| --- | --- | --- |
| `docker compose restart` | everything | restart a process |
| `docker compose stop` / `start` | everything | free the ports for a while |
| `docker compose down` | the volume, so all data | free the containers |
| `docker compose down -v` | nothing | see below |

**`docker compose down -v` destroys the database with no confirmation**, including
anything you created by hand. It is not a last resort; it is the normal response to three
situations, and in the first two nothing else works:

1. **A change to the roles SQL in `docker-compose.yml`.** `/docker-entrypoint-initdb.d`
   runs once, against an empty data directory. Edit it and run `up` again and nothing
   happens: the stack keeps working with the old roles and there is no error anywhere.
2. **An edited migration that was already applied.** The migrator compares timestamps, not
   contents, so `migrate` reports success having executed no statement.
   `docs/architecture/migrations.md` has the detail.
3. **A branch switch across a migration.** The volume does not switch with the branch.

`docker compose restart` prints `migrate` and `seed` as failed, every time, and the stack
is fine. Compose restarts exited one-shot containers too and ignores `depends_on`
conditions, so both reconnect to a Postgres that is not yet accepting connections and
exit non-zero. The data survives, which is the point of the command. Do not reach for
`down -v` on that signal — it destroys exactly what the restart just preserved.

### Two stacks, two projects, one volume per project name

This stack pins `name: shortkit-dev`, so its containers are `shortkit-dev-*`, its volume
is `shortkit-dev_pgdata`, and it shares nothing with `docker-compose.test.yml`, which runs
in project `shortkit` on port 55433. Both can run at once: `pnpm test:integration` does
not require stopping the stack you are developing against.

The pinned name is not fixed. `COMPOSE_PROJECT_NAME` overrides it, and `-p` overrides
both. That matters because two clones of this repository now share `shortkit-dev_pgdata`
whatever their directories are called — the second clone gets the first's schema, roles
and data, and the symptom is a green stack rather than an error. Set
`COMPOSE_PROJECT_NAME` to separate them.

The volume is unencrypted developer storage. It survives `docker compose down`,
`git clean -xdf` and a branch switch, and `docker volume ls` is the only place it appears.
Today it holds one synthetic demo tenant, whatever you typed, and Postgres's own password
verifiers for three fixture roles. Nothing personal. The first table carrying real
personal data is what makes that sentence need rewriting.
