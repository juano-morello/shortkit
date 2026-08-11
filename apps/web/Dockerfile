# syntax=docker/dockerfile:1
#
# The image for `apps/web` (GC-7: one frontend deployable).
# ADR: adr-0035-compose-web-service.md, adr-0005-contract-distribution.md
# Produced by: TASK-059
#
# Built by `docker compose` for the local stack. Vercel does NOT use this file: it builds
# from `apps/web/vercel.json`, which runs `pnpm build && pnpm run assert:no-secrets`. This
# build runs `next build` only, so a build that passes here can still fail Vercel's secret
# check, and the local stack will not say so.
#
# Context is the REPOSITORY ROOT, not `apps/web`, so the pnpm workspace resolves.
#
# The stages mirror the API's `Dockerfile` and for the same reasons. It is two files that
# will drift; the note on `--frozen-lockfile` below is the one worth keeping in sync.

FROM node:24-alpine AS base
ENV PNPM_HOME=/pnpm
ENV PATH=/pnpm:$PATH
# Next phones home on `build` and on `start` unless this is set. AC-115 describes a
# machine with Docker and a clone; nothing in the build should need the network after the
# install layer.
ENV NEXT_TELEMETRY_DISABLED=1
RUN corepack enable
WORKDIR /repo

# Manifests only, and shared by the two stages that install. A source edit then leaves the
# dependency layers cached, which is most of what a rebuild costs.
#
# All four manifests, not just `apps/web`'s: `pnpm install --frozen-lockfile` validates
# `pnpm-lock.yaml` against every importer the workspace declares and fails when one is
# missing, whatever the `--filter` says.
FROM base AS manifests
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/contracts/package.json packages/contracts/

FROM manifests AS build
RUN pnpm install --frozen-lockfile --filter @shortkit/web...

# THE COPY LIST IS EXPLICIT, AND `COPY apps/web apps/web` IS FORBIDDEN (ADR-0035, F-317).
#
# `apps/web/.env.example` line 1 tells a developer to copy it to `.env.local`. That file
# holds `BFF_PROXY_SECRET` and it sits inside this build context. The broad form puts its
# bytes in an image layer readable by `docker save`, `docker history` and
# `docker run --entrypoint sh`, and Next loads `.env.local` in every environment but test,
# so any `NEXT_PUBLIC_*` a developer added to it is inlined into `.next/static/**` as well.
# `assert:no-secrets` — the repository's one guard against that — does not run on this
# build. `.dockerignore`'s recursive `**/.env.*` is the backstop; this list is the
# guarantee.
#
# The price is that this breaks when `apps/web` gains a directory: adding `public/`, a
# `middleware.ts` or a postcss config produces a build that succeeds and a page that is
# missing something. That is a worse failure than a build error and it is the accepted
# cost of not writing the broad form. The API's Dockerfile pays the same price.
COPY tsconfig.base.json tsconfig.json ./
COPY packages/contracts/src packages/contracts/src
COPY apps/web/next.config.ts apps/web/tsconfig.json apps/web/next-env.d.ts apps/web/
COPY apps/web/app apps/web/app
COPY apps/web/src apps/web/src
# apps/web/public when it exists; it does not today.

# No `NEXT_PUBLIC_*` and no `BFF_PROXY_SECRET` are set for this build, deliberately
# (ADR-0035). Next inlines the former at build time, and the only two candidate values are
# `http://api:3001/api`, which no browser can resolve, and `http://localhost:3001/api`,
# which would bake the published port of this machine into the image. Nothing under
# `apps/web` reads the variable today.
RUN pnpm --filter @shortkit/web build

FROM manifests AS runtime
ENV NODE_ENV=production

RUN pnpm install --frozen-lockfile --prod --filter @shortkit/web...

# `@shortkit/contracts` is a `workspace:*` dependency and ships TypeScript source with no
# build step (ADR-0005), so the prod install above leaves a symlink whose target has to
# exist. `.next` already has the code inlined and `next start` never reads these files;
# the install is what needs them.
COPY packages/contracts/src packages/contracts/src

# `next start` reads `next.config.ts` at boot, so it travels with the build output.
COPY apps/web/next.config.ts apps/web/
COPY --from=build /repo/apps/web/.next apps/web/.next

USER node
WORKDIR /repo/apps/web

# Documentation for a human reading `docker inspect`; nothing reads it to decide a port.
# `next start` defaults to 3000 on 0.0.0.0, and `docker-compose.yml` publishes
# `127.0.0.1:3000:3000` against it.
EXPOSE 3000

# The binary rather than `pnpm start`, so the Node process is PID 1 and takes the stop
# signal directly instead of through a package-manager shim.
CMD ["node_modules/.bin/next", "start"]
