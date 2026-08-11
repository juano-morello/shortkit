---
id: ADR-0030
slug: foundation
title: No deploy target is chosen for the API, and the repository stops implying one
status: accepted
supersedes: null
date: 2026-08-11
---

## Context

AC-6 named Fly.io. Nothing ever deployed there. Through five audit rounds and four fix
rounds `shortkit-api.fly.dev` was NXDOMAIN from Fly's own authoritative nameservers,
`flyctl` was not on PATH, `~/.fly` did not exist, and `.github/workflows` held no deploy
job. TASK-003 sat escalated on a clause only Juano could clear. Amendment A-8 narrowed
AC-6 to the production image and minted AC-115 for `docker compose up`.

What the repository still carries from the Fly assumption: `fly.toml`, `infra/deploy.sh`,
the "At deploy" section of `docs/architecture/migrations.md`, the Fly framing in ADR-0027
and ADR-0004, the `Dockerfile` header calling itself "the Fly image", and a
`shortkit-api.fly.dev` origin in `apps/web/.env.example` that resolves to nothing. Every
one of those reads as a working deploy path to someone who has not tried it. That is the
same class of defect A-8 was ruled to close, one layer down.

Four things constrain any answer. GC-3 caps infrastructure at $25 a month. GC-7 allows one
backend deployable and one frontend deployable. The web app is already deployed to Vercel
and AC-7 was verified live on 2026-08-06, so only the API's home is open. And the
production schema is one table, so there is no traffic to serve and nothing to be down.

## Alternatives considered

**Pick a different platform now and deploy to it.** Render, Railway, a VPS running the
compose stack, or Fly again with an account actually created. Pros: the repository answers
"where does this run", and AC-6's original clause becomes true rather than narrowed. Cons:
every one of them needs an account, a credential store, a DNS decision that TASK-057 has
not made, and production role provisioning that is still unowned and routed alongside
F-116. Sizing any of them against GC-3 is guesswork with one table and no traffic. Why it
lost: it buys a running URL for nothing that needs one, and it re-spends the four fix
rounds that were already spent on a platform nobody was ready to operate.

**Keep the Fly artifacts as an unexecuted plan.** Leave `fly.toml` and `infra/deploy.sh` in
place, marked aspirational. Pros: sixty lines of hard-won reasoning about migration
ordering and the migrator credential stay where they were written; picking Fly later costs
nothing. Cons: this is exactly what the repository has been doing for six days, and it is
what produced F-142 and A-8. A committed `fly.toml` with a `[[http_service.checks]]` block
is indistinguishable from a live deploy to a reader, and `infra/deploy.sh` runs to
completion far enough to apply DDL. Why it lost: an artifact that describes a deploy nobody
can perform is worse than no artifact, because it is read as evidence.

**Decide nothing and remove nothing.** Pros: no work. Cons: the amendment already ruled;
leaving the artifacts silently contradicts it. Why it lost: it is not an option, it is the
absence of one.

## Decision

**No deploy target is chosen for `apps/api`. The repository promises three things and
refuses to imply a fourth.**

What it promises, and each is verified:

| Promise | Verified by |
|---|---|
| A production image for the API, built from the repository's `Dockerfile`, that serves `GET /health` with `status: "ok"` and the commit it was built from | AC-6, measured 2026-08-10 |
| The web app deployed to Vercel, serving 200 and HTML at its root | AC-7, measured 2026-08-06 |
| The whole stack running locally from `docker compose up` | AC-115, TASK-059 |

What it does not promise: a hosted API anywhere, a URL a browser on the internet can
reach, an uptime story, a rollback story, or a production database. Nothing in the
repository may state or imply otherwise.

### Artifacts TASK-059 removes or rewrites

| Artifact | Action |
|---|---|
| `fly.toml` | delete |
| `infra/deploy.sh` | delete |
| `infra/` | delete; it holds nothing else |
| `.dockerignore` line `infra` | delete with the directory |
| `docs/architecture/migrations.md`, section "At deploy" | replace with the migration mechanism of the local stack (ADR-0033) plus the platform-independent constraints below |
| `Dockerfile` header comment "The Fly image for `apps/api`" and "Build it through `infra/deploy.sh`, never through bare `fly deploy`" | rewrite; the image is the API's production image and the build command is in the README |
| `Dockerfile` comment at `EXPOSE 3001` referencing `fly.toml`'s `internal_port` | rewrite against `docker-compose.yml` |
| `Dockerfile` comment at the `--prod` install referencing "why `fly.toml` has no `release_command`" | rewrite; the constraint survives and is restated below |
| `apps/web/.env.example`, both `https://shortkit-api.fly.dev/api` values | replace with the local stack's origin and a comment saying no hosted API exists |

### Artifacts that carry Fly and are not TASK-059's to edit

Named here so they are routed rather than discovered. TASK-059 must not touch them.

- `.sdlc/foundation/design/adr-0027-build-commit-provenance.md`: Context bullets 2 and 3,
  the sections "What TASK-003 writes → `fly.toml`" and "→ `infra/deploy.sh`", the first and
  fourth accepted costs, the follow-up naming `infra/deploy.sh`, and the whole "Inferred
  from Fly's documentation" block. Entangled with TASK-003, which is still open.
- `.sdlc/foundation/design/adr-0004-schema-layout-and-migrations.md`: the F-142 correction
  paragraph, the last two negative consequences, and the third follow-up.
- `apps/api/src/main.ts`: the `DATABASE_REACHABLE_BUDGET_MS` docblock and the
  `bootstrap().catch` comment both cite `fly.toml`'s `grace_period` and
  `auto_start_machines`. The coupling is real and moves to `docker-compose.yml` under
  ADR-0036; the comment has to move with it.
- `apps/api/src/health/build-commit.ts`, `apps/api/src/health/health.spec.ts`,
  `packages/contracts/src/domains/reserved-hostnames.ts`.
- `apps/web/src/lib/api/client.ts`. **Corrected 2026-08-11 (F-321):** this entry previously
  said the file carries a `Fly-Client-IP` fallback that is "live behaviour and not just a
  comment". It is a comment. The only occurrence of the string is in a docblock describing
  the unwritten BFF proxy: "If the header is absent (local next dev), OMIT
  BFF_CLIENT_IP_HEADER entirely; the API falls back to Fly-Client-IP." The file reads, sets
  and forwards no such header; its three exported constants are `x-vercel-forwarded-for`,
  `x-shortkit-client-ip` and `x-shortkit-proxy-auth`, and `buildUpstreamUrl` throws
  `not implemented` under the F-291 deferral. The wrong claim mattered because it pointed the
  routing at `apps/web/src/**`, where there is nothing to fix, and away from the artifacts
  that do carry live decisions.
- **`design/stubs/**`. Added 2026-08-11 (F-320, the omission half).** Routing the contracts
  and not the stubs routes the weaker half: a stub is what an implementer compiles against.
  `design/stubs/apps/api/src/auth/resolve-rate-limit-principal.ts`,
  `design/stubs/apps/api/src/clicks/click-event.types.ts`,
  `design/stubs/apps/api/src/observability/logger.ts` (whose `REDACT_PATHS` enumerates
  `req.headers["fly-client-ip"]`), `design/stubs/apps/api/src/redirect/db/redirect-read.ts`,
  `design/stubs/apps/api/src/common/rate-limit/rate-limit.types.ts`,
  `design/stubs/apps/api/src/domains/domain-state.ts`,
  `design/stubs/apps/web/src/lib/api/client.ts` and
  `design/stubs/packages/contracts/src/domains/reserved-hostnames.ts` all carry Fly.
- The design contracts `click-events.md`, `domain-provisioning.md`, `error-envelope.md`,
  `rate-limit.md`, `redirect-resolution.md`, `web-api-client.md`, and ADR-0010, ADR-0014,
  ADR-0016, `test-strategy.md`, `refinement.md`.

### What survives the deletion, because it constrains any deploy target

`fly.toml` and `infra/deploy.sh` carried reasoning that is not about Fly. Deleting them
without restating it means rediscovering it. All six hold for whatever platform is chosen
later.

1. **Migrations cannot run inside the production image.** The runtime stage installs
   production dependencies only, and `drizzle-kit` is a devDependency. Promoting it puts
   GHSA-67mh-4wv8-2f99 into the production graph through a non-optional edge, which fails
   `pnpm audit --prod --no-optional --audit-level moderate` and blocks every merge, and it
   falsifies the accepted assessment in `docs/security/known-advisories.md`. This is F-119's
   settlement and it is platform-independent.
2. **Migrations do not run from application boot** (ADR-0004). Two instances starting
   together would race.
3. **A failed migration blocks the deploy.** Whatever sequences the two must stop before
   shipping code.
4. **The image builds before any DDL is applied.** The `Dockerfile` COPYs an explicit file
   list, so a commit that adds a file it does not name builds green under `pnpm build` and
   fails inside `docker build`. Applying DDL first leaves the schema ahead of the code with
   the old image serving.
5. **`GET /health` touches no database.** A green health check means the process is up, not
   that it can serve a DB-backed request. Anything that gates a deploy on `/health` alone
   is measuring the wrong thing. On the redirect path that is GC-8.
6. **Boot spends up to 20 seconds reaching the database** before it refuses
   (`DATABASE_REACHABLE_BUDGET_MS` in `main.ts`, F-245). Any platform health check needs a
   grace period above that number, and raising one means raising the other.

### What has to be true before this is revisited

A deploy target becomes worth choosing when all of these hold, and not before:

- There is something to serve. Today the schema is one table and no route reads it.
  Roadmap item 1 returning `links` and the redirect path is the trigger.
- TASK-057's apex-domain question is answered, since the API's hostname and the redirect
  hostname are the same decision.
- Production role provisioning has an owner. `shortkit_migrator` and `shortkit_app` with
  real, rotatable passwords is still unowned and routed alongside F-116.
- **Build provenance is supplied for real.** Added 2026-08-11 as a condition of accepting
  ADR-0037, not as a follow-up to it. Whatever builds a `runtime`-target image that will
  serve a request supplies a real `GIT_COMMIT_SHA`, and **no build inherits
  `docker-compose.yml`'s forty-zeros default**. Worded against the image rather than against
  the file, because the compose `api` service builds `target: runtime` and that is the same
  production image AC-6 measures: the sentinel travels with the artifact, not with the YAML.
- The candidate is priced against GC-3 with the six constraints above applied, in a new
  ADR that supersedes this one.

## Consequences

### Positive

- The repository stops answering a question it cannot answer. A reader who wants to know
  where this deploys finds a decision saying "nowhere yet, and here is what it would take",
  which is the truth and is actionable.
- F-142 stays discharged and cannot recur through the artifact it lived in: there is no
  `fly.toml` to disagree with `migrations.md` about a release command.
- No **script** points a migrator DSN at a remote database any more. `infra/deploy.sh`'s
  loopback refusal and its type-the-host confirmation are gone along with the path they
  guarded. Narrowed 2026-08-11 (F-326), because the first version of this bullet said the
  largest credential "stops circulating" and that is not what happened. It circulates in
  more places than before and is merely a fixture in all of them: `DATABASE_MIGRATION_URL`
  sits in the `migrate` service's environment where `docker inspect` and
  `docker compose config` print it, the `migrator` image stage runs as root (ADR-0033), and
  `db:migrate` and the new `db:seed` both read whatever DSN the developer's shell holds. The
  loopback refusal that guarded the remote case is deleted with nothing replacing it, which
  is a reason production role provisioning stays routed alongside F-116 rather than an
  argument that the exposure went away.
- Every constraint the Fly work discovered survives in one place instead of five.

### The cost accepted

- **AC-6's original intent is not met and will not be until a target is chosen.** The image
  serves `/health` correctly and nothing runs it anywhere. Calling that "the API" is a
  stretch, and this ADR is what keeps the stretch visible.
- **The Vercel-deployed web app now points at nothing.** AC-7 stays green because the root
  page is static, but `apps/web/.env.example`'s API origin becomes a local address, and the
  deployed frontend has no backend. That gap existed before this ADR and was hidden by a
  hostname that looked live.
- **Sixty lines of reasoning are deleted and six lines of summary replace them.** The
  summary above is thinner than what `fly.toml` said. Whoever picks a platform will have to
  re-derive the details, and the git history is the only place the long form survives.
- **The choice gets more expensive the longer it waits.** Picking a platform at the point
  where there is traffic means learning it under pressure. This ADR trades that against not
  paying for a platform nobody is using.
- **The compose stack is now the only place the API runs**, so it inherits load it was not
  designed for. Anything that would have been caught by a real deploy will be caught by
  nothing.

### Follow-ups this creates

- TASK-059 deletes and rewrites the artifacts in the first table.
- The edits in the second table need routing. ADR-0027 and ADR-0004 in particular still
  read as though `infra/deploy.sh` exists.
- `apps/api/.env.example` does not exist, although ADR-0027's follow-up assigns it to
  TASK-003. Whoever closes TASK-003 either writes it or discloses that it is unwritten.
- README gains the compose section (GC-13). It must not gain a deploy section.
