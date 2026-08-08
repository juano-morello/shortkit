# syntax=docker/dockerfile:1
#
# The Fly image for `apps/api` (GC-7: one backend deployable).
# ADR: adr-0027-build-commit-provenance.md, adr-0005-contract-distribution.md
# Produced by: TASK-003
#
# Build it through `infra/deploy.sh`, never through bare `fly deploy`. The script is the
# only place `GIT_COMMIT_SHA` enters, and the guard in the runtime stage below fails the
# build without it.

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
# accepted in `docs/security/known-advisories.md` out of the deployed image — the row's
# assessment says so in as many words — and it is why `fly.toml` has no `release_command`
# (F-119; the reasoning is in `infra/deploy.sh`).
RUN pnpm install --frozen-lockfile --prod --filter @shortkit/api...

COPY --from=build /repo/apps/api/dist apps/api/dist

USER node

# `main.ts` falls back to 3001 when `PORT` is unset, and `fly.toml`'s `internal_port`
# matches. Documentation for a human reading `docker inspect`; Fly does not read it.
EXPOSE 3001

CMD ["node", "apps/api/dist/main.js"]
