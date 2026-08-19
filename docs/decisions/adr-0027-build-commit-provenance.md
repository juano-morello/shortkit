---
id: ADR-0027
slug: foundation
title: The deployed commit SHA reaches /health as a build argument, and its absence refuses the deploy
status: accepted
supersedes: null
date: 2026-08-08
---

## Context

AC-6 requires `GET /health` to answer `200` with `status: "ok"` and a `commit` field matching the
deployed git SHA. Juano split that AC on 2026-08-06: the not-a-placeholder clause is tested, because
a health endpoint reporting a stale or empty commit makes a deploy unidentifiable and no other gate
notices.

A test that proves the value is not hardcoded has to set the value, and setting it means naming the
variable it comes from. `sdlc-test-architect` searched on 2026-08-07 and found no ADR, contract,
workflow, manifest or `.env.example` that names one, so `apps/api/src/health/health.spec.ts` picked
`GIT_COMMIT_SHA` and wrote the choice into its own docblock. F-224 records that as a test making a
production decision by default. This ADR takes the decision back.

What already constrains the answer:

- No `Dockerfile`, no `fly.toml`, no `apps/api/.env.example` exists in the repository today. TASK-003
  creates all three.
- Fly injects no git metadata into a running Machine. The documented set is `FLY_APP_NAME`,
  `FLY_MACHINE_ID`, `FLY_ALLOC_ID`, `FLY_REGION`, `FLY_PUBLIC_IP`, `FLY_IMAGE_REF`,
  `FLY_MACHINE_VERSION`, `FLY_PRIVATE_IP`, `FLY_PROCESS_GROUP`, `FLY_VM_MEMORY_MB` and
  `PRIMARY_REGION`. `FLY_MACHINE_VERSION` is a machine-config version and `FLY_IMAGE_REF` is a
  registry reference; neither names a commit.
- CI does not deploy. `.github/workflows/ci.yml` runs `quality`, `integration` and `gate`, and
  `docs/security/ci-secrets.md` states that CI holds no Fly credentials and has no deploy step. Every
  Fly deploy today is a command Juano runs by hand, so any mechanism that depends on remembering a
  flag will eventually be forgotten.
- `apps/api/src/db/client.ts` already sets the repository's precedent for a required environment
  variable: `connectionString()` throws with the reason attached rather than substituting a default.
- `apps/api/src/app.module.spec.ts` and `apps/api/src/common/errors/exception-filter.spec.ts` both
  compile `AppModule` without `GIT_COMMIT_SHA` set. Anything that reads the variable during
  dependency injection turns both of those suites red, and neither file belongs to TASK-003.

F-225 is the other half of the problem. A `?? 'unknown'` fallback in the handler passes the spec,
because the spec always sets the variable and the fallback branch never executes. Forget the build
argument and every gate stays green while the deployed API reports `commit: "unknown"`.

## Alternatives considered

### The variable name

**`GIT_COMMIT_SHA`, the spec's choice.** Adopted. It names its content and its format, it matches the
repository's unprefixed SCREAMING_SNAKE convention (`DATABASE_URL`, `PORT`, `BFF_PROXY_SECRET`,
`API_BASE_URL`), and Fly rejects names starting with `FLY_` so that namespace was never available.
Adopting costs zero edits anywhere.

**`GITHUB_SHA`.** Rejected. GitHub Actions populates it in every job, including `quality` and
`integration`, which run no deploy. A boot guard reading it would be satisfied by ambient CI
environment rather than by the image's build argument, so the check would pass in the one place it
cannot mean anything. Naming the variable after a producer that does not produce it here is also
wrong on its face: the producer today is Juano's shell.

**`SHORTKIT_COMMIT_SHA`.** Rejected. No environment variable in this repository carries a project
prefix, and inventing one here buys nothing. Consistency wins a tie.

### Where the value comes from

**Docker build argument, promoted to `ENV` in the runtime stage.** Adopted. The value is baked into
the image, so the image and the SHA it reports cannot disagree. A rollback to an older image, a
`fly deploy --image` that reuses a built image, a machine restart and a `fly machine clone` all carry
the correct value with no further action.

**A Fly runtime variable.** Rejected on fact. Fly injects none that carries a commit. Recorded here
because it is the first thing a reader will ask.

**`[env]` or `[build.args]` in `fly.toml`.** Rejected. Both are static TOML values committed to the
repository, so the file is correct for exactly one commit and wrong for every commit after it. AC-6's
failure mode is a `commit` that no longer matches what is running, and this alternative manufactures
that failure by construction.

**`fly deploy --env GIT_COMMIT_SHA=...`.** Rejected. It sets Machine configuration rather than image
content, so the SHA becomes a property of the machine instead of the artifact. Deploy a different
image without the flag, or roll back, and the pairing goes wrong silently. It also loses to the build
argument on a smaller point: `flyctl` reconciles machine environment against `fly.toml`, so a value
that lives only in a flag has no home in the repository.

**`git rev-parse` at runtime.** Rejected. The deployed image has no `.git` directory, shipping one
puts the full history in the container, and it would report the SHA of whatever tree happens to be
present rather than the one that was built.

**A generated `build-info.ts` written during the build.** Rejected. It needs a codegen step, it
dirties the working tree, and a stale generated file typechecks and ships. The environment variable
needs no new file format and no new build step.

### What happens when the value is absent

**Refuse. No fallback at any layer.** Adopted, in three places, described below.

**`?? 'unknown'` in the handler.** Rejected, and named here so nobody re-adds it. It converts a broken
build into a running service that lies about its identity, and F-225 shows the test suite cannot see
the difference.

**An obviously-wrong sentinel such as `commit: "UNSET"`.** Rejected, though it is defensible. It keeps
`/health` answering, which keeps the Fly check green, which keeps the deploy succeeding. The whole
value of AC-6 is that a deploy nobody can identify should not reach traffic. A sentinel makes the
problem visible to a human who reads the response and invisible to every machine that does not.

**Refuse only outside development, gated on `NODE_ENV`.** Rejected. It reintroduces a fallback branch
that never runs under test, which is exactly F-225's shape, and it makes correctness in production
depend on two settings agreeing. Local development gets the value the same way the deploy does.

## Decision

**The variable is `GIT_COMMIT_SHA`. Its value is the full 40-character lowercase hexadecimal git
SHA of the commit that was built, matching `/^[0-9a-f]{40}$/`.**

Full length, not abbreviated. One predicate then rejects `unknown`, the empty string, a literal
`$(git rev-parse HEAD)` that failed to expand, a branch name, `HEAD`, an uppercase SHA and a
seven-character abbreviation. `git rev-parse HEAD` in this repository produces exactly this form;
`extensions.objectFormat` is unset, so objects are SHA-1.

**The value enters as a Docker build argument and is promoted to an environment variable in the
runtime stage.** `fly deploy --build-arg GIT_COMMIT_SHA=<sha>` supplies it. `infra/deploy.sh` is the
command Juano runs, so the flag is not something anyone has to remember.

**Absence refuses, at three layers, with no fallback at any of them.**

1. **Build.** The Dockerfile's runtime stage validates the argument against the regex and fails the
   build. A missing or malformed SHA never becomes an image.
2. **Boot.** `main.ts` reads and validates the value during bootstrap and refuses to start if it is
   absent or malformed. A machine that exits non-zero fails the Fly deploy, and the previous version
   keeps serving.
3. **Handler.** The read throws. No `??`, no `||`, no default parameter, no sentinel string.

**The response shape is `{"status":"ok","commit":"<40 hex>"}`** with `Content-Type: application/json`
and status `200`, served at `/health` outside the `/api` global prefix.

**The read is lazy.** `readBuildCommitSha()` executes inside the request handler or inside the
bootstrap sequence, never at module import time and never in a provider constructor.
`app.module.spec.ts` and `exception-filter.spec.ts` compile `AppModule` with no `GIT_COMMIT_SHA` set;
a read during dependency injection turns both red, and both files sit outside TASK-003's paths.

**Ordering inside bootstrap.** The commit check runs before `assertRuntimeRoleCannotBypassRls()`
(F-116). It is a string comparison with no I/O, so a mis-built image fails before the process opens a
database connection. F-116 left the ordering to TASK-003 and asked for it to be recorded; this
narrows that choice for one pair and leaves the rest of the sequence open.

## What TASK-003 writes

Transcribe these. The surrounding lines of each file are TASK-003's to decide.

### `Dockerfile`, runtime stage

`ARG` must be declared inside the runtime stage. Verified 2026-08-08 on Docker 29.7.1 with BuildKit:
an `ARG` declared only before the first `FROM` expands to the empty string in a later stage, the
build succeeds with nothing worse than an `UndefinedVar` warning, and the image ships
`GIT_COMMIT_SHA=`.

```dockerfile
ARG GIT_COMMIT_SHA
RUN printf '%s' "$GIT_COMMIT_SHA" | grep -Eq '^[0-9a-f]{40}$' \
    || { echo "GIT_COMMIT_SHA must be a 40-character lowercase hex git SHA, got '${GIT_COMMIT_SHA}'" >&2; exit 1; }
ENV GIT_COMMIT_SHA=${GIT_COMMIT_SHA}
```

The `RUN` guard needs a shell and `grep` in the runtime base image. `node:24-alpine` and
`node:24-slim` both provide them. If TASK-003 picks a distroless runtime base, move the `RUN` guard
into the build stage, declare `ARG GIT_COMMIT_SHA` in both stages, and keep `ARG` plus `ENV` in the
runtime stage.

The SHA appears in `docker history` output. It is public information by AC-6's own requirement, so
this is not a leak.

### `fly.toml`

```toml
[build]
  dockerfile = "Dockerfile"
```

**Do not add `GIT_COMMIT_SHA` to `[env]`, and do not add it to `[build.args]`.** Both are static
values in a committed file and both go stale on the next commit. `fly.toml` names the Dockerfile;
the SHA arrives from the command line.

The health check is what makes the endpoint load-bearing rather than decorative:

```toml
[[http_service.checks]]
  grace_period = "10s"
  interval = "15s"
  method = "GET"
  path = "/health"
  timeout = "2s"
```

`method = "GET"` and `path = "/health"` are fixed by AC-6 and ADR-0006. The three durations are
starting values that TASK-003 may tune.

### `infra/deploy.sh`

```sh
#!/usr/bin/env bash
set -euo pipefail

# The deployed image has to be able to say which commit it is (AC-6, ADR-0027).
# `fly deploy` passes no git metadata of its own, so this script is the only place
# the SHA enters the build. Deploy through it, not through bare `fly deploy`.

if [ -n "$(git status --porcelain)" ]; then
  echo "refusing to deploy: the working tree is dirty, so HEAD does not describe what would ship" >&2
  exit 1
fi

GIT_COMMIT_SHA="$(git rev-parse HEAD)"

exec fly deploy \
  --build-arg "GIT_COMMIT_SHA=${GIT_COMMIT_SHA}" \
  "$@"
```

The dirty-tree refusal is deliberate. Deploying uncommitted work makes `commit` report a SHA that
does not describe the running code, which is the same lie AC-6 exists to prevent, and it is harder to
detect than an empty value because it looks right.

### `apps/api/.env.example`

Nothing in `apps/api` loads a `.env` file today, so this file documents what the process needs rather
than supplying it. The other variables belonging in it are outside this ADR.

```
# The git SHA of the commit this build was made from. Baked into the Fly image at
# build time by `infra/deploy.sh`, which passes it as a Docker build argument
# (ADR-0027). `GET /health` reports it, which is how a deploy is identified.
#
# Required. Exactly 40 lowercase hex characters. The API refuses to boot without a
# value matching /^[0-9a-f]{40}$/ — there is no fallback and no default, because a
# health endpoint reporting `unknown` makes a deployed build unidentifiable and
# nothing else in the pipeline notices.
#
# For a local run, supply it the same way the deploy does:
#   GIT_COMMIT_SHA="$(git rev-parse HEAD)" pnpm --filter @shortkit/api start
GIT_COMMIT_SHA=
```

## Consequences

### Positive

- `apps/api/src/health/health.spec.ts` keeps `GIT_COMMIT_SHA` and needs no edit. The name is now a
  decision recorded where the implementer reads it rather than a default the spec fell into.
- The SHA and the image cannot disagree. Rollbacks, restarts and image reuse all report correctly.
- Three refusal layers turn a forgotten build argument into a failure at build time, and at worst
  into a deploy that aborts with the previous version still serving. F-225's ungated path stops being
  reachable.
- `infra/deploy.sh` removes the flag from human memory, which matters because no CI job deploys.

### The cost accepted

- `fly deploy` on its own now produces a broken build. Anyone who bypasses `infra/deploy.sh`,
  including a future GitHub Actions deploy job, gets a build failure with an explanatory message
  rather than a working deploy. That is the trade, taken knowingly.
- Local `pnpm --filter @shortkit/api start` fails until `GIT_COMMIT_SHA` is exported. `.env.example`
  documents the one-liner, and nothing loads it automatically.
- The dirty-tree refusal blocks a fast uncommitted hotfix. Commit first, or edit the script under
  protest.
- `/health` publishes the git SHA of a private repository to anyone who asks, unauthenticated,
  because the Fly health check is unauthenticated. AC-6 requires exactly this. The disclosure is a
  commit identifier with no repository access attached to it, and the cost is real but small.
- The 40-character rule has to change if a future build ever has only an abbreviated SHA. It is one
  regex in the Dockerfile, one in `main.ts`, and this ADR. `GITHUB_SHA` is a full 40-character SHA,
  so a later Actions deploy job stays compatible.
- Reading lazily means an unset variable produces a `500` on `/health` in any process that started
  without the boot check, such as a test harness that builds an app from `AppModule` directly. That
  is the price of keeping `app.module.spec.ts` and `exception-filter.spec.ts` green, and those two
  files are not TASK-003's to change.

### Follow-ups this creates

- TASK-003 writes `Dockerfile`, `fly.toml`, `infra/deploy.sh` and `apps/api/.env.example` with the
  content above, and lands the boot check in `main.ts` alongside F-116's.
- `README.md` should say that deploys go through `infra/deploy.sh`. TASK-001 is the README's sole
  producer (GC-13), so this needs routing rather than assuming.
- If a deploy workflow is ever added, it passes `--build-arg GIT_COMMIT_SHA=${{ github.sha }}` and
  the same guards apply unchanged.
- ~~`docs/architecture/migrations.md:120` already describes the Fly release command as an existing
  procedure. F-119 and F-142 own that; this ADR does not touch it.~~ **Closed 2026-08-10.** F-142's
  fix rewrote that section: it now says there is no Fly release command and describes
  `infra/deploy.sh`. ADR-0004's matching text is corrected in the same round. Nothing outstanding.

## What was verified, and what was inferred

Two normative claims in this initiative have already had to be struck as wrong-when-written, so the
line is drawn explicitly.

**Verified by running it, 2026-08-08, Docker Engine 29.7.1 with BuildKit:**

- An `ARG` declared only before the first `FROM` and not re-declared in a stage expands to the empty
  string. `ENV GIT_COMMIT_SHA=$GIT_COMMIT_SHA` then succeeds with an `UndefinedVar` warning, and
  `docker inspect` shows `GIT_COMMIT_SHA=` in the image config. This is the silent failure the guard
  exists to catch.
- `ARG` re-declared in the stage, with no `--build-arg` passed, also yields an empty value and a
  successful build.
- The exact `RUN` guard above fails the build for an absent argument, for `3d1f7a0`, for `unknown`
  and for an uppercase 40-character SHA, and passes for
  `3d1f7a0c94b25e68af31c07d5b8e4a2196fd0c7b`. Tested as a two-stage build with the guard in the
  runtime stage.
- After a successful build the image config carries
  `GIT_COMMIT_SHA=3d1f7a0c94b25e68af31c07d5b8e4a2196fd0c7b`, and a container started from it reads
  that value from the environment.
- `git rev-parse HEAD` in this repository returns 40 lowercase hex characters and
  `extensions.objectFormat` is unset.

**Verified by reading this repository:**

- No `Dockerfile`, `fly.toml` or `apps/api/.env.example` exists.
- `.github/workflows/ci.yml` defines `quality`, `integration` and `gate` and contains no deploy step.
- `app.module.spec.ts` and `exception-filter.spec.ts` compile `AppModule` with no `GIT_COMMIT_SHA`
  set.
- `apps/api/package.json` has `start` as `node dist/main.js` and no watch script.
- The Fly app hostname is `shortkit-api.fly.dev`, from `apps/web/.env.example`.

**Inferred from Fly's documentation and not observed.** `flyctl` is not installed here and there is
no Fly account attached to this environment, so nothing below was run:

- `fly deploy --build-arg NAME=VALUE` exists, accepts repeated use, and takes priority over
  `[build.args]` in `fly.toml`.
- Build arguments are not available in the runtime container, which is why the `ENV` promotion is
  required rather than optional.
- Fly injects no environment variable carrying a git SHA. The eleven documented variables are listed
  in Context.
- `[[http_service.checks]]` accepts `grace_period`, `interval`, `method`, `timeout` and `path`.
- A `release_command` failure aborts the deploy. **Moot since F-119's settlement: `fly.toml`
  carries no `release_command` and never will. Left here as the record of what was inferred, not
  as a claim about the shipped deploy. What blocks a deploy on a failed migration is `set -e` in
  `infra/deploy.sh`.**

TASK-003's implementer runs the first real `fly deploy` and is the first person able to confirm the
inferred items. Contradict any of them in the TASK report rather than working around them quietly.
