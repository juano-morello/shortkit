#!/usr/bin/env bash
set -euo pipefail

# The deploy. ADR-0027, and F-119's settlement.
# Produced by: TASK-003
#
# The deployed image has to be able to say which commit it is (AC-6, ADR-0027).
# `fly deploy` passes no git metadata of its own, so this script is the only place
# the SHA enters the build. Deploy through it, not through bare `fly deploy`.
#
# It also runs the migration, which `fly.toml` deliberately does not do through a
# `release_command`: the release command executes inside the deployed image, and that image
# installs production dependencies only, so it has no `drizzle-kit` binary. The reasoning
# and the alternatives are in `fly.toml` beside the absent `release_command`.

if [ -n "$(git status --porcelain)" ]; then
  echo "refusing to deploy: the working tree is dirty, so HEAD does not describe what would ship" >&2
  exit 1
fi

# The dirty-tree refusal above is deliberate. Deploying uncommitted work makes `commit`
# report a SHA that does not describe the running code, which is the same lie AC-6 exists to
# prevent, and it is harder to detect than an empty value because it looks right.

if [ -z "${DATABASE_MIGRATION_URL:-}" ]; then
  echo "refusing to deploy: DATABASE_MIGRATION_URL is not set." >&2
  echo "It authenticates as shortkit_migrator, the role that owns the tables (ADR-0003)." >&2
  echo "Never DATABASE_URL: shortkit_app owns nothing and can run no DDL." >&2
  exit 1
fi

GIT_COMMIT_SHA="$(git rev-parse HEAD)"

# Before the deploy, not from application boot: one shell runs this once, so N machines
# starting together cannot race (ADR-0004). `set -e` means a failed migration stops here
# and never reaches `fly deploy`.
pnpm --filter @shortkit/api db:migrate

exec fly deploy \
  --build-arg "GIT_COMMIT_SHA=${GIT_COMMIT_SHA}" \
  "$@"
