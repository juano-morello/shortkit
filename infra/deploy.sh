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
# and the three costs of that settlement are in `fly.toml` beside the absent
# `release_command`.
#
# FIVE GUARDS, CHEAPEST FIRST, AND EVERY ONE OF THEM REFUSES RATHER THAN WARNS:
#
#   1. run from the repository root, whatever directory it was invoked from;
#   2. the working tree is clean, so HEAD describes what would ship;
#   3. DATABASE_MIGRATION_URL is set, and points somewhere that is not a local container;
#   4. the operator confirms the migration target by typing its host;
#   5. the image BUILDS from this tree, before any DDL is applied.
#
# Guards 3 to 5 exist because this script applies schema changes to production before it
# deploys the code that needs them (F-246). Order matters and it is not the natural one.

refuse() {
  printf 'refusing to deploy: %s\n' "$1" >&2
  shift
  for line in "$@"; do
    printf '  %s\n' "$line" >&2
  done
  exit 1
}

# 1. `git` and `pnpm` walk up to the repository root on their own; `docker build .` and
#    `flyctl` do not. Run from a subdirectory without this and the migration applies and
#    then the deploy fails — the exact broken state guard 5 exists to prevent, reached by
#    a likelier route.
cd "$(git rev-parse --show-toplevel)"

# 2. The dirty-tree refusal is deliberate. Deploying uncommitted work makes `commit` report
#    a SHA that does not describe the running code, which is the same lie AC-6 exists to
#    prevent, and it is harder to detect than an empty value because it looks right.
if [ -n "$(git status --porcelain)" ]; then
  refuse "the working tree is dirty, so HEAD does not describe what would ship"
fi

# 3. Presence, then TARGET. `docker-compose.test.yml` and `test/support/rls-fixture.ts` both
#    instruct the operator to export DATABASE_MIGRATION_URL pointing at a local container
#    for the integration suite. From that shell this script used to migrate localhost, see
#    success, and ship code to production against an unmigrated schema — while `/health`
#    answers 200 because it touches no database, so Fly's check passes and every DB-backed
#    request 500s. On the redirect path that is GC-8.
if [ -z "${DATABASE_MIGRATION_URL:-}" ]; then
  refuse "DATABASE_MIGRATION_URL is not set." \
    "It authenticates as shortkit_migrator, the role that owns the tables (ADR-0003)." \
    "Never DATABASE_URL: shortkit_app owns nothing and can run no DDL."
fi

# Best-effort DSN parse, and it is allowed to be best-effort because guard 4 prints what it
# parsed and makes the operator confirm it. A password containing an unencoded '/' is the
# one shape that misreads, and it misreads visibly.
dsn_rest="${DATABASE_MIGRATION_URL#*://}"
dsn_authority="${dsn_rest%%/*}"
dsn_hostport="${dsn_authority##*@}"
dsn_userinfo="${dsn_authority%"$dsn_hostport"}"
dsn_role="${dsn_userinfo%%:*}"
dsn_role="${dsn_role%@}"
dsn_path="${dsn_rest#"$dsn_authority"}"
dsn_database="${dsn_path#/}"
dsn_database="${dsn_database%%\?*}"

# IPv6 arrives as [::1]:5432; everything else as host or host:port.
case "$dsn_hostport" in
  \[*\]*) dsn_host="${dsn_hostport#\[}"; dsn_host="${dsn_host%%\]*}" ;;
  *)      dsn_host="${dsn_hostport%%:*}" ;;
esac

dsn_host_lower="$(printf '%s' "$dsn_host" | tr '[:upper:]' '[:lower:]')"

case "$dsn_host_lower" in
  '' | localhost | localhost.* | *.localhost | 127.* | 0.0.0.0 | ::1 | host.docker.internal)
    refuse "DATABASE_MIGRATION_URL points at '${dsn_host}', which is a local address." \
      "That is the integration suite's throwaway container (docker-compose.test.yml)," \
      "not the deployed database. Migrating it would report success and ship code to" \
      "production against an unmigrated schema."
    ;;
esac

# 4. Loopback is the shape this repository actually documents, so rejecting it catches the
#    likely accident. It does not catch a staging DSN, another project's DSN, or a replica.
#    Nothing but a human knows which database is the right one, so a human says so.
if [ ! -t 0 ]; then
  refuse "stdin is not a terminal, and the migration target needs confirming." \
    "This script applies DDL to a production database before it deploys; the" \
    "confirmation is the only guard that a human is choosing the target." \
    "A non-interactive deploy path needs its own decision, not a flag added here."
fi

printf 'about to migrate, as shortkit_migrator:\n' >&2
printf '  host:     %s\n' "$dsn_host" >&2
printf '  database: %s\n' "$dsn_database" >&2
printf '  role:     %s\n' "$dsn_role" >&2
printf '  commit:   %s\n' "$(git rev-parse HEAD)" >&2
printf 'type the host to confirm: ' >&2
read -r confirmation

if [ "$confirmation" != "$dsn_host" ]; then
  refuse "the confirmation did not match '${dsn_host}'."
fi

GIT_COMMIT_SHA="$(git rev-parse HEAD)"

# 5. PROVE THE IMAGE BUILDS BEFORE ANY DDL IS APPLIED (F-246). The Dockerfile COPYs an
#    explicit file list, so a commit that adds a file it does not name builds green under
#    `pnpm build` and fails inside `docker build`. Migrating first would leave that failure
#    with the DDL applied and the OLD image serving against a schema it does not match —
#    the one thing ADR-0004's `release_command` could not do, because Fly builds first and
#    runs the release command inside the built image.
#
#    This is a local build against the same Dockerfile and the same tree, not the artifact
#    that ships: `fly deploy` below builds again on Fly's builder. What it proves is that
#    the build inputs are complete. A failure that is specific to Fly's builder or its
#    registry is the residual gap, and `fly.toml` records it as accepted.
if ! command -v docker >/dev/null 2>&1; then
  refuse "docker is not available, and the image has to be proved buildable before any" \
    "DDL is applied. Without that proof a failed build leaves the schema ahead of the" \
    "code with the old image still serving."
fi

docker build \
  --build-arg "GIT_COMMIT_SHA=${GIT_COMMIT_SHA}" \
  --tag "shortkit-api:${GIT_COMMIT_SHA}" \
  .

# Before the deploy, not from application boot: one shell runs this once, so N machines
# starting together cannot race (ADR-0004). `set -e` means a failed migration stops here
# and never reaches `fly deploy`.
pnpm --filter @shortkit/api db:migrate

exec fly deploy \
  --build-arg "GIT_COMMIT_SHA=${GIT_COMMIT_SHA}" \
  "$@"
