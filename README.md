# Shortkit

Shortkit is being built as a multi-tenant URL shortener for agencies. An agency signs up
once, creates a workspace per client, points that client's branded domain at the
workspace, and invites teammates scoped to the clients they work on. Visitors never see
the product. They get one redirect that resolves fast or does not.

**Signup, sessions, workspaces, invitations, links and the redirect are here. The rest is
not.** After the `identity-membership`, `invitations` and `links-redirect` branches, an
operator signs up, signs in and holds a session; signup creates a tenant and the operator's
membership in it (`tenant_memberships`); the operator lists, creates, renames and archives
workspaces through five authenticated routes under `/api/workspaces` and one screen in
`apps/web`. A workspace admin invites an address to one or more workspaces, each at a role,
through five routes under `/api/invitations` and a screen per workspace; the invitation is a
link that arrives by mail, printed to the API's log in the local stack and sent by Resend
where a deployment declares it. The invitee opens the link and creates an account with it
(or accepts it while signed in to an account in the same tenant); they land in the inviter's
tenant, no tenant of their own is created, and they see only the workspaces they were
granted. A workspace role is enforced on every workspace route, read from `memberships` on
every request.

A workspace member creates short links through five routes under `/api/links` and two
screens per workspace, on the one system default domain the seed provisions. A slug is
generated or supplied, and it is unique per domain rather than globally. An anonymous
visitor's `GET /:slug` answers 302 with the stored destination byte for byte, or the 404
page, and it answers nothing else: no 5xx ever reaches a visitor. It resolves through a
Redis read-through cache and falls back to Postgres whenever the cache cannot answer, so
the redirect keeps serving with Redis stopped; an edited destination is serving within five
seconds, because a mutation deletes the cache key rather than waiting out its hour. Every
redirect enqueues a click event that a buffer writes to `click_events` off the visitor's
path, and the tenant reads its own clicks back at `GET /api/links/:linkId/clicks`. The
visitor's address is stored as a per-tenant hash and never leaves the database.

The browser never calls the API directly. Every request goes through the web app's own BFF
proxy at `/api/bff/…`, which holds the session cookies. Each matched API request writes one
structured log line. Nothing else exists: no member management after the invitation, no
custom domains and no branding on the 404, no export or erasure paths, no marketing site.
The five increments that turn the substrate into the product above are named in
`docs/roadmap.md`, in the order they have to land; items 1 and 2 are what these three
branches deliver.

Two rules shape the code that exists:

- **Postgres enforces tenant isolation.** Every tenant-scoped query runs inside a
  transaction that has bound the tenant to the connection, and row-level security backs
  that up. Isolation gets measured by a suite that runs against a real database, not
  asserted in a comment. The suite states its own boundary on every run and writes it into
  `report.json`, and the boundary is still narrow: ten tables (`tenants`; a fixture table it
  creates and drops per run from the same production policy builder; `tenant_memberships`;
  `workspaces`; `memberships`, `invitations` and `invitation_workspaces`; and `domains`,
  `links` and `click_events`), the methods of six repository classes, and the sixteen
  registered endpoints under `/api/workspaces`, `/api/invitations` and `/api/links`,
  attacked as a second signed-in operator. That is 117 surfaces, each attempted in both
  directions, 234 attempts in all. The redirect is the one shipped route deliberately not
  attacked: `GET /:slug` is anonymous and cross-tenant by design, so what bounds a redirect
  transaction instead is a carried exclusion, narrowed three ways and all three asserted
  rather than stated: the `FOR SELECT` policy pair on `domains` and `links`, the read-only
  transaction, and the one file that may set `app.redirect_context`. The exact boundary is
  `COVERAGE_BOUNDARY` in `apps/api/test/isolation/coverage.ts`, and it is what the report
  carries. Every one of those subjects is registered by hand, not discovered from the
  module graph, and the run says so. A green run means the mechanism
  works for the surface someone registered. **It does not mean the system has no uncovered
  cross-tenant surface: a route nobody registered is a route nobody attacked, and most of
  the system is unwritten.**
- **One set of contracts.** `packages/contracts` holds the zod schemas the API builds its
  error envelope from and the web client narrows on. It ships TypeScript source with no
  build step, so an incompatible change breaks `pnpm typecheck` in the same commit, and
  CI proves that rather than assuming it, by mutating the package and asserting a
  consumer goes red.

**The redirect hot path is here, built under the constraint that was recorded before it
existed:** two parameterised statement shapes behind a cache, no ORM at any depth under
`apps/api/src/redirect/`, and no import from the management API's modules.
`docs/contracts/redirect-resolution.md` is the decision order it follows and
`docs/contracts/redirect-cache.md` the keys, the TTLs and the invalidation. The constraint
is asserted rather than trusted: `apps/api/src/redirect/redirect-isolation.spec.ts` greps
the module for a drizzle import and compares the set of SELECT literals under it against
the two permitted statement shapes.

## Layout

| Workspace | Package | What it is |
| --- | --- | --- |
| `apps/api` | `@shortkit/api` | NestJS. `GET /health` at the root; Better Auth mounted on Express at `/api/auth/*` ahead of Nest, behind a body cap and IP-keyed buckets, with an invited-signup branch that joins a tenant instead of creating one; five workspace routes under `/api/workspaces` and five invitation routes under `/api/invitations`, behind a bearer-token guard, a per-request tenant transaction and a workspace-role check; five link routes under `/api/links` and one click-read route at `/api/links/:linkId/clicks`, behind the same three; the anonymous `GET /:slug` redirect, registered outside the `/api` prefix, reading through a Redis cache with Postgres behind it, and a click buffer that writes `click_events` after the response has gone; a `MailSender` port with `console`, `resend`, `fake` and `none` transports, selected by `MAIL_TRANSPORT` |
| `apps/web` | `@shortkit/web` | Next.js App Router. `/signup` (which also takes an invitation token), `/sign-in`, `/workspaces`, `/workspaces/<id>/invitations`, `/workspaces/<id>/links`, `/workspaces/<id>/links/<linkId>`, `/invitations/accept`, a root page and a 404; the BFF proxy under `/api/bff/…` that holds the session cookies and forwards to the API |
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
| `pnpm test:compose` | Brings the whole stack up from nothing with Docker and asserts twenty-nine clauses over it |
| `pnpm loadtest` | Drives the cache-hit redirect path with k6 against a stack that is already running, and reports the server-side p99 |

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

`docs/decisions/` holds 63 ADRs and `docs/contracts/` holds 27 contracts. The code cites
them by number (`ADR-0003` in a docblock, a `Contract:` header at the top of a file), and
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
old paths. An ADR records a decision at a date and does not get rewritten to match a later
move. The stub drift check (`pnpm assert:stub-drift`, ADR-0039) is retired outright, because
the tree it compared against is gone.

## Running the whole stack

With Docker, this clone, and one exported variable, `BETTER_AUTH_SECRET`, the JWT signing
key that nothing in the repository commits a value for (ADR-0051):

```
export BETTER_AUTH_SECRET="$(docker run --rm node:24-alpine node -e 'console.log(require("node:crypto").randomBytes(32).toString("base64url"))')"
docker compose up
```

The generation command runs `node` inside a throwaway container rather than on the host,
so it needs only Docker, which is all the machine AC-115 describes has. A command that
instead assumed a host `node` would, on such a machine, print `node: command not found`
to stderr while `export` itself still exits 0 and binds the empty string; `docker compose
up` would then fail with the same "missing a value" error this section's own remedy is
supposed to prevent, having silently not run.

Without it, `docker compose up` fails at parse time and names the variable; nothing is
built or started. `export` supplies it for the current shell only. Setting it in a
project-root `.env` instead (see `.env.example`) makes it persist, at one cost: while that
file exists, `pnpm test:compose` refuses to run at all (`cannot run the AC-115 check:
there is a .env at the repository root`, exit 2, nothing measured). Move it aside first.

Nothing else needs exporting. `docker-compose.yml` sets every other variable the stack
reads: the role passwords, `BETTER_AUTH_URL`, `WEB_APP_ORIGINS` and `MAIL_TRANSPORT` for
the API, `API_BASE_URL` for the web app. It leaves the API's two trust declarations
(`CLIENT_TRUST_BOUNDARY`, `BFF_TRUST_BOUNDARY`) unset, because the stack has no proxy in
front of the API and shares no BFF secret between the two services; `apps/api/.env.example`
says what that costs. That file and `apps/web/.env.example` list every variable each
process reads. Compose reads neither: they are templates for a process run outside the
stack, and each says how to use it.

**Invite links are printed, not sent.** The stack declares `MAIL_TRANSPORT=console`
(D-02, 2026-08-18), so every message the API would send is written to the `api`
container's stdout as plain text (recipient, subject, body), and nothing leaves the
machine. Invite someone from `http://localhost:3000/workspaces/<id>/invitations`, then:

```
docker compose logs api
```

Each message is one block between a header and a footer line, with the accept link on a
line of its own; open it in the same browser and the invitation completes. `console` is
opt-in and this stack opts in. With `MAIL_TRANSPORT` unset the API binds a sender that
sends nothing and logs one warn line per suppressed message; no deployment declares
`console`, because stdout is a log store everywhere but a laptop. `MAIL_TRANSPORT=resend`
needs `RESEND_API_KEY` and `MAIL_FROM` as well and refuses to boot without them;
`apps/api/.env.example` has the table. `MAIL_TRANSPORT=none docker compose up` runs the
silent stack.

Postgres comes up with its roles provisioned, the migrations are applied, the seed inserts
one demo tenant and the platform rows the redirect needs (a platform tenant, its workspace,
and the `domains` row for the system default domain `localhost`), Redis comes up
password-protected, the API starts once both stores are healthy, and the web app starts
once the API is healthy.

| Address | What answers |
| --- | --- |
| `http://localhost:3000/` | the web app's root page |
| `http://localhost:3000/signup` | the signup form; the request goes through the web app's own `/api/bff/…` route to the API |
| `http://localhost:3000/sign-in` | the sign-in form, same path |
| `http://localhost:3000/workspaces` | the workspace list, create, rename and archive screen; a request with no session bounces to `/sign-in` |
| `http://localhost:3000/workspaces/<id>/invitations` | invite an address to that workspace at a role, list its invitations, revoke one; workspace admins only |
| `http://localhost:3000/workspaces/<id>/links` | the links in that workspace, with the create form for a member and above; each row links to `/workspaces/<id>/links/<linkId>`, where the destination, the slug and the validity window are edited and the link is deleted |
| `http://localhost:3000/invitations/accept` | where an invite link lands; the token is in the URL fragment, never sent to a server; offers signup with the token, or accept while signed in |
| `http://localhost:3001/health` | `{"status":"ok","commit":"…"}` |
| `http://localhost:3001/<slug>` | the redirect: 302 to the stored destination, or the default 404 page for a slug no link holds. This is the short link origin the links screens copy, `SHORT_LINK_ORIGIN` |
| `postgres://shortkit_app:app@127.0.0.1:55432/shortkit` | the database |
| `redis://:redis-fixture@127.0.0.1:56379` | the redirect cache, published so a cached record can be read while debugging |

Every port binds `127.0.0.1`, so a stack whose committed password is `app` is not on the
LAN. Docker Compose v2 or newer: the startup ordering uses
`service_completed_successfully`, which older versions do not understand.

The whole file is **local development only**. There is no production database, and no
deploy target is chosen for the API (ADR-0030).

`pnpm test:compose` measures the same stack, one step earlier: it generates and exports
its own `BETTER_AUTH_SECRET` for the duration of the run, so it needs nothing exported
first. It tears any existing stack down to nothing, brings it up, and reports twenty-nine
clauses. Every service healthy; `shortkit_app` authenticating over TCP with the fixture
password and refused with a wrong one; every migration recorded as applied; the demo tenant
readable by that same role; `/health` answering 200 with `status` of `"ok"`; a signup, a
sign-in and a workspace creation driven through the web app's proxy in that order. Then the
second human: an invitation from that owner, its link read out of `docker compose logs api`,
an invited signup that creates no tenant, and a sign-in that lists exactly the granted
workspace at `member` and nothing else. Then the visitor's loop, which is the part only a
real stack can show: a link created through the web app, `http://localhost:3001/<slug>`
answering 302 with the stored destination byte for byte and with the two headers that belong
on a redirect, the click that visit wrote read back through the web app with no address hash
in it, an edited destination serving inside five seconds, `docker compose stop redis` with
the redirect still answering 302, `start redis` and it answering still, and a slug no link
holds rendering the 404 with its own content security policy and no stack in the body. Last,
the data surviving a second `up` and a `restart`. Each clause fails on its own and prints
why, so the output says which part broke rather than that something did. The invitation
clauses are `BLOCKED`, not failed, on a stack whose API is not printing mail: nothing about
that path was measured, and the table says so.

### What a green stack does not give you

`docker compose up` prints six services and ends with `api` and `web` healthy. Three gaps
are worth knowing before you read that as a working system.

**A green `web` means `/` answered, not that the proxied path works.** Everything under
`apps/web` that goes through `apiClient()` targets the same-origin BFF proxy at
`/api/bff/…`. That route exists (`apps/web/app/api/bff/[...path]/route.ts`) and forwards
to the API at `API_BASE_URL=http://api:3001/api`, the compose network's name for the API,
which is why `web` waits for `api` to be healthy before it starts. A signup posted from
`http://localhost:3000` reaches the API and creates an account against an empty database,
with no seed data involved. The web container's health check asks for `/` and nothing
else, so two green containers prove the path exists and not that the flow works;
`pnpm test:compose` is what drives a signup, a sign-in, a workspace creation, an
invitation and its acceptance through that proxy and asserts each one. Two things the
stack still does not do: it forwards no browser address to the API (the two services
share no `BFF_PROXY_SECRET`), so the IP-keyed rate limits do not bind here and every click
row stores the hash of the same "no address was established" sentinel; and
`http://api:3001` resolves only inside the compose network, so a browser reaches the API
through the web app's proxy or on `http://localhost:3001` and no other way.

**A green `api` means the process is up, not that the database is reachable now.**
`/health` touches no database by design. What carries the database claim is boot: the API
refuses to start unless it reached Postgres and established that its role cannot bypass
row-level security.

**A green `redis` is not what makes the redirect work.** `api` waits for it to be healthy
before starting, which is startup ordering and not a runtime dependency: with the service
stopped, every cache read answers "unavailable", resolution falls through to Postgres, and
the redirect still answers 302. `pnpm test:compose` stops the service and asserts exactly
that, then starts it again and asserts the redirect still answers. What a stopped Redis
does cost is the cache: every redirect pays a Postgres read until it is back.

### Build provenance

```
docker compose up                                                   # AC-115's command
GIT_COMMIT_SHA="$(git rev-parse HEAD)" docker compose up --build    # real provenance
```

A bare `up` builds with git's null object id (forty zeros), and `/health` reports it.
That is correct and deliberate: no fresh clone can know its own commit through Compose,
which cannot run a command (ADR-0037). Forty zeros is a value `git rev-parse` can never
return, so it is unambiguous rather than misleading.

`--build` is load-bearing in the second form, not decoration. So is the placement of the
variable: **real provenance is not sticky.** The next bare `docker compose up` rebuilds
with forty zeros and `/health` reverts, announcing nothing. Export it on every `up` that
is meant to carry a real SHA.

Every `up` now pays a build-graph evaluation, because all four built services set
`pull_policy: build`. With a warm cache that is a second or two. Without it, after a
`docker system prune`, it is a full rebuild of four images on a command you expected to
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
   A volume from before `feat/invitations` is the case to know about: its `workspaces` rows
   have no `memberships` row for their creator, and after migration `0003` the workspace
   list is membership-filtered, so an owner who created workspaces on the old volume sees
   none of them. There is no backfill; ADR-0062 says why. `down -v` and start again.

**A volume from before `feat/links-redirect` is the one case on this ladder where `down -v`
is not the cheapest repair.** Migration `0005` adds `domains`, `links` and `click_events`, and
`migrate` applies it on the next `up` like any other migration. What is missing is not
schema but rows: the seed writes a platform tenant, its workspace, and the `domains` row for
the system default domain, and every link references that domain row by foreign key. Without
it `POST /api/links` answers 500 `internal_error` while everything else on the stack stays
green, which is a confusing symptom for a create route that is fine.

Re-running the seed is the repair, and a plain `docker compose up` re-runs it: `seed` is a
one-shot service and `up` starts it again. Measured on 2026-08-19, by deleting the platform
tenant (its workspace and the `domains` row cascade with it) and running `up` again: the
seed reported `tenants 1 row inserted` for the platform unit, `workspaces 1 row inserted`
and `domains 1 row inserted`, `tenants 0 rows inserted` for the demo tenant that was still
there, and the create route answered 201 again. A third `up`, on the now complete volume,
inserted 0 rows in all four units. Every insert the seed makes ends `ON CONFLICT (<pk>) DO
NOTHING`, which is what makes re-running it safe on a volume that already has the rows: it
adds what is missing and touches nothing else. `down -v` also works, at the price of
everything you created.

`docker compose restart` prints `migrate` and `seed` as failed, every time, and the stack
is fine. Compose restarts exited one-shot containers too and ignores `depends_on`
conditions, so both reconnect to a Postgres that is not yet accepting connections and
exit non-zero. The data survives, which is the point of the command. Do not reach for
`down -v` on that signal: it destroys exactly what the restart just preserved.

### Two stacks, two projects, one volume per project name

This stack pins `name: shortkit-dev`, so its containers are `shortkit-dev-*`, its volume
is `shortkit-dev_pgdata`, and it shares nothing with `docker-compose.test.yml`, which runs
in project `shortkit` on port 55433. Both can run at once: `pnpm test:integration` does
not require stopping the stack you are developing against.

The pinned name is not fixed. `COMPOSE_PROJECT_NAME` overrides it, and `-p` overrides
both. That matters because two clones of this repository now share `shortkit-dev_pgdata`
whatever their directories are called: the second clone gets the first's schema, roles
and data, and the symptom is a green stack rather than an error. Set
`COMPOSE_PROJECT_NAME` to separate them.

The volume is unencrypted developer storage. It survives `docker compose down`,
`git clean -xdf` and a branch switch, and `docker volume ls` is the only place it appears.
Today it holds one synthetic demo tenant, Postgres's own password verifiers for three
fixture roles, and whatever you typed: a local signup writes its email address and password
hash to Better Auth's `user` and `account` tables, its workspace names to `workspaces`, and
every address it invited to `invitations` (the token's digest, never the token). Since
2026-08-18 that is real personal data if you typed a real address, so the volume is not
something to hand around, and neither is `docker compose logs api`, which under `console`
holds every invited address and every invite link.
