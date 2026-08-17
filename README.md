# Shortkit

Shortkit is being built as a multi-tenant URL shortener for agencies. An agency signs up
once, creates a workspace per client, points that client's branded domain at the
workspace, and invites teammates scoped to the clients they work on. Visitors never see
the product. They get one redirect that resolves fast or does not.

**None of that is here yet.** This repository holds the substrate underneath it: one
migrated table, `tenants`; one route, `GET /health`; one static page; and the tenancy,
contracts and CI machinery around them. The five increments that turn it into the product
above are named in `docs/roadmap.md`, in the order they have to land.

Two rules shape the code that exists:

- **Postgres enforces tenant isolation.** Every tenant-scoped query runs inside a
  transaction that has bound the tenant to the connection, and row-level security backs
  that up. Isolation gets measured by a suite that runs against a real database, not
  asserted in a comment. The suite states its own boundary on every run and writes it into
  `report.json`, and the boundary is narrow: it covers the two tables that carry a tenant
  boundary today — `tenants`, and a fixture table it creates and drops per run from the
  same production policy builder — and no routes and no repositories, because none exist.
  A green run means the mechanism works. **It does not mean the system has no uncovered
  cross-tenant surface: most of the system is unwritten.**
- **One set of contracts.** `packages/contracts` holds the zod schemas the API builds its
  error envelope from and the web client narrows on. It ships TypeScript source with no
  build step, so an incompatible change breaks `pnpm typecheck` in the same commit — and
  CI proves that rather than assuming it, by mutating the package and asserting a
  consumer goes red.

**The redirect hot path is on the roadmap, not in this repository.** There is no redirect,
no cache and no link table. The constraint it will be built under — one parameterised
statement behind a cache, no ORM, and no import from the management API — is recorded in
`apps/api/src/app.module.ts` for the module that adds it.

## Layout

| Workspace | Package | What it is |
| --- | --- | --- |
| `apps/api` | `@shortkit/api` | NestJS. `GET /health` at the root; the management API prefix `/api` is registered and carries no routes yet |
| `apps/web` | `@shortkit/web` | Next.js App Router. One static page and a 404 |
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
| `pnpm test:compose` | Brings the whole stack up from nothing with Docker and asserts fifteen clauses over it |

`pnpm build` bundles the API with tsup rather than emitting file by file.
`packages/contracts` ships TypeScript source and has no build step (ADR-0005), so
the bundler inlines it; a file-by-file emit would leave the API requiring a `.ts`
file at runtime. Types are checked by `pnpm typecheck`, not by the build.

The three test commands are separate on purpose, and they are three tiers of cost. `pnpm
test` runs anywhere, on a clone with nothing installed but the workspace. `pnpm
test:integration` needs a database, so it stays off the loop a contributor runs on every
save. `pnpm test:compose` needs Docker, builds four images and takes minutes; it is
`scripts/check-compose-stack.sh`, and the `compose` job in CI runs it on every push, so a
change to the Dockerfile, the compose file, the roles SQL, the migration or the seed
cannot break the stack silently.

## Where the decisions live

`docs/decisions/` holds 61 ADRs and `docs/contracts/` holds 26 contracts. The code cites
them by number — `ADR-0003` in a docblock, a `Contract:` header at the top of a file — and
every one of those citations resolves inside this repository. When a contract and the
shipped file disagree the shipped file wins, and the divergence is a finding.
`logger-contract-drift.spec.ts` is the only place that comparison runs mechanically today,
checking `docs/contracts/logging-and-headers.md`'s normative fence against `logger.ts` on
every `pnpm test`.

They moved here on 2026-08-17, out of a `.sdlc/` tree that also carried the process
machinery: task cards, audit rounds, gate state, design stubs. That machinery is deleted
rather than moved, and it sits in git history at `c617ebd` and earlier. Two of its pieces
are still named by things that outlived it. CI comments cite
`.sdlc/foundation/design/test-strategy.md`, and ADR prose cites task and work files at their
old paths — an ADR records a decision at a date and does not get rewritten to match a later
move. The stub drift check (`pnpm assert:stub-drift`, ADR-0039) is retired outright, because
the tree it compared against is gone.

## Running the whole stack

With Docker, this clone, and one exported variable — `BETTER_AUTH_SECRET`, the JWT
signing key, which nothing in the repository commits a value for (ADR-0051):

```
export BETTER_AUTH_SECRET="$(docker run --rm node:24-alpine node -e 'console.log(require("node:crypto").randomBytes(32).toString("base64url"))')"
docker compose up
```

The generation command runs `node` inside a throwaway container rather than on the host,
so it needs only Docker — the machine AC-115 describes, and nothing else. A command that
instead assumed a host `node` would, on such a machine, print `node: command not found`
to stderr while `export` itself still exits 0 and binds the empty string; `docker compose
up` would then fail with the same "missing a value" error this section's own remedy is
supposed to prevent, having silently not run.

Without it, `docker compose up` fails at parse time and names the variable; nothing is
built or started. `export` supplies it for the current shell only. Setting it in a
project-root `.env` instead (see `.env.example`) makes it persist, at one cost: while that
file exists, `pnpm test:compose` refuses to run at all (`cannot run the AC-115 check:
there is a .env at the repository root`, exit 2, nothing measured) — move it aside first.

Nothing else needs exporting. `docker-compose.yml` sets every other variable the stack
reads: the role passwords, `BETTER_AUTH_URL` and `WEB_APP_ORIGINS` for the API,
`API_BASE_URL` for the web app. It leaves the API's two trust declarations
(`CLIENT_TRUST_BOUNDARY`, `BFF_TRUST_BOUNDARY`) unset, because the stack has no proxy in
front of the API and shares no BFF secret between the two services; `apps/api/.env.example`
says what that costs. That file and `apps/web/.env.example` list every variable each
process reads. Compose reads neither: they are templates for a process run outside the
stack, and each says how to use it.

Postgres comes up with its roles provisioned, the migrations are applied, the seed
inserts one demo tenant, the API starts, and the web app starts once the API is healthy.

| Address | What answers |
| --- | --- |
| `http://localhost:3000/` | the web app's root page |
| `http://localhost:3000/signup` | the signup form; the request goes through the web app's own `/api/bff/…` route to the API |
| `http://localhost:3000/sign-in` | the sign-in form, same path |
| `http://localhost:3001/health` | `{"status":"ok","commit":"…"}` |
| `postgres://shortkit_app:app@127.0.0.1:55432/shortkit` | the database |

Every port binds `127.0.0.1`, so a stack whose committed password is `app` is not on the
LAN. Docker Compose v2 or newer: the startup ordering uses
`service_completed_successfully`, which older versions do not understand.

The whole file is **local development only**. There is no production database, and no
deploy target is chosen for the API (ADR-0030).

`pnpm test:compose` measures the same stack, one step earlier: it generates and exports
its own `BETTER_AUTH_SECRET` for the duration of the run, so it needs nothing exported
first. It tears any existing stack down to nothing, brings it up, and reports fifteen
clauses — every service healthy,
`shortkit_app` authenticating over TCP with the fixture password and refused with a wrong
one, every migration recorded as applied, the demo tenant readable by that same role,
`/health` answering 200 with `status` of `"ok"`, and the data surviving a second `up` and
a `restart`. Each clause fails on its own and prints why, so the output says which part
broke rather than that something did.

### What a green stack does not give you

`docker compose up` prints five services and ends with `api` and `web` healthy. Two gaps
are worth knowing before you read that as a working system.

**A green `web` means `/` answered, not that the proxied path works.** Everything under
`apps/web` that goes through `apiClient()` targets the same-origin BFF proxy at
`/api/bff/…`. That route exists (`apps/web/app/api/bff/[...path]/route.ts`) and forwards
to the API at `API_BASE_URL=http://api:3001/api`, the compose network's name for the API,
which is why `web` waits for `api` to be healthy before it starts. A signup posted from
`http://localhost:3000` reaches the API and creates an account against an empty database,
with no seed data involved. The web container's health check asks for `/` and nothing
else, and `pnpm test:compose` asserts reachability and health rather than a signup, so
two green containers prove the path exists and not that the flow works. Two things the
stack still does not do: it forwards no browser address to the API (the two services
share no `BFF_PROXY_SECRET`), so the IP-keyed rate limits do not bind here; and
`http://api:3001` resolves only inside the compose network, so a browser reaches the API
through the web app's proxy or on `http://localhost:3001` and no other way.

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
