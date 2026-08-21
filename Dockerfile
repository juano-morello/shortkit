# syntax=docker/dockerfile:1
#
# The production image for `apps/api` (GC-7: one backend deployable).
# ADR: adr-0027-build-commit-provenance.md, adr-0005-contract-distribution.md,
#      adr-0030-no-deploy-target.md, adr-0033-compose-migrate-and-seed-services.md
# Produced by: TASK-003, extended by TASK-059
#
# NOTHING DEPLOYS THIS ANYWHERE. No deploy target is chosen (ADR-0030): this image is
# built by `docker compose` for the local stack and by the command in the README, and it
# runs on the machine that built it. The two invocations are:
#
#   docker build --build-arg GIT_COMMIT_SHA="$(git rev-parse HEAD)" -t shortkit-api .
#   docker compose up            # builds `runtime` for the `api` service
#
# `GIT_COMMIT_SHA` has no default here and the guard in the runtime stage fails the build
# without a 40-character hex SHA. `docker-compose.yml` supplies forty zeros for a local
# stack (ADR-0037), which is the ONLY build allowed to. Whatever builds an image that
# will serve a request supplies a real one.

FROM node:24-alpine AS base
ENV PNPM_HOME=/pnpm
ENV PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /repo

# Manifests only, and shared by the two stages that install. A source edit then leaves the
# dependency layers cached, which is most of what a rebuild costs.
#
# All four manifests, not just `apps/api`'s: `pnpm install --frozen-lockfile` validates
# `pnpm-lock.yaml` against every importer the workspace declares and fails when one is
# missing, whatever the `--filter` says.
FROM base AS manifests
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/contracts/package.json packages/contracts/

FROM manifests AS build
RUN pnpm install --frozen-lockfile --filter @shortkit/api...
COPY tsconfig.base.json tsconfig.json ./
COPY packages/contracts/src packages/contracts/src
COPY apps/api/tsconfig.json apps/api/tsup.config.ts apps/api/
COPY apps/api/src apps/api/src
# tsup bundles `@shortkit/contracts` into `dist/main.js` (ADR-0005: the package ships
# TypeScript source and has no build step), which is why the runtime stage needs no copy of
# it and no TypeScript loader.
RUN pnpm --filter @shortkit/api build

# NOT A DEPLOYABLE STAGE, and nothing enforces that but this comment (ADR-0033). It
# carries devDependencies, including `drizzle-kit` and the esbuild advisory accepted in
# `docs/security/known-advisories.md` on the stated grounds that no copy of `drizzle-kit`
# is deployed. It also inherits `build`'s root user, where `runtime` below sets
# `USER node`. Referenced only by docker-compose.yml's `migrate` and `seed` services,
# both of which exit.
#
# It declares no `ARG GIT_COMMIT_SHA` and runs no provenance guard: neither service
# serves a request and neither reports a commit (ADR-0037).
#
# `FROM build`, so it already has drizzle-kit from the dev install. It adds the three
# things the build stage has no reason to copy.
FROM build AS migrator
COPY apps/api/drizzle.config.ts apps/api/
COPY apps/api/drizzle apps/api/drizzle
COPY apps/api/scripts apps/api/scripts

FROM manifests AS runtime

# ADR-0027, layer 1 of the three that refuse a build with no commit provenance. The other
# two are `main.ts`'s boot check and `health/build-commit.ts`'s read.
#
# `ARG` HAS TO BE DECLARED INSIDE THIS STAGE. Verified 2026-08-08 on Docker 29.7.1 with
# BuildKit: an `ARG` declared only before the first `FROM` expands to the empty string in a
# later stage, the build SUCCEEDS with nothing worse than an `UndefinedVar` warning, and the
# image ships `GIT_COMMIT_SHA=`. That silent success is the whole reason this guard exists.
#
# The SHA appears in `docker history`. AC-6 requires `/health` to publish it unauthenticated
# anyway, so this is not a leak.
ARG GIT_COMMIT_SHA
RUN printf '%s' "$GIT_COMMIT_SHA" | grep -Eq '^[0-9a-f]{40}$' \
    || { echo "GIT_COMMIT_SHA must be a 40-character lowercase hex git SHA, got '${GIT_COMMIT_SHA}'" >&2; exit 1; }
ENV GIT_COMMIT_SHA=${GIT_COMMIT_SHA}

ENV NODE_ENV=production

# Production dependencies only. That is what keeps `drizzle-kit` and the esbuild advisory
# accepted in `docs/security/known-advisories.md` out of this image (the row's assessment
# says so in as many words), and it is why migrations cannot run inside it (F-119).
#
# So something outside this stage has to apply them, and it is the `migrator` stage above:
# `docker-compose.yml` runs `migrate` and `seed` as one-shot services before `api` starts
# (ADR-0033). Migrations never run from application boot either (ADR-0004), because two
# instances starting together would race. Any platform chosen later inherits both
# constraints; ADR-0030 lists the six that survive a platform choice.
RUN pnpm install --frozen-lockfile --prod --filter @shortkit/api...

COPY --from=build /repo/apps/api/dist apps/api/dist

USER node

# `main.ts` falls back to 3001 when `PORT` is unset, and `docker-compose.yml` publishes
# `127.0.0.1:3001:3001` against it. Documentation for a human reading `docker inspect`;
# nothing reads it to decide a port.
EXPOSE 3001

CMD ["node", "apps/api/dist/main.js"]
