---
id: ADR-0035
slug: foundation
title: The web app gets its own multi-stage image, depends on nothing, and cannot reach the API from the browser
status: accepted
supersedes: null
date: 2026-08-11
---

## Context

`apps/web` has no image. The repository's one `Dockerfile` builds the API. Vercel builds the
web app from `apps/web/vercel.json`, which runs
`pnpm install --frozen-lockfile --filter @shortkit/web...` then `pnpm build && pnpm run
assert:no-secrets`. AC-115 requires the web app to reach a healthy state under
`docker compose up`.

What `apps/web` actually contains: `app/page.tsx`, which is static markup with no data
fetching, `app/not-found.tsx`, `app/layout.tsx`, and `src/lib/api/client.ts`. The client
targets the same-origin BFF proxy at `BFF_PATH_PREFIX = '/api/bff'`. **That proxy route does
not exist.** `apps/web/app/api/bff/[...path]/route.ts` is unwritten and its own source
comment records that it deferred with EPIC-002 and that no card's `paths` cover it. Nothing
under `apps/web` reads `process.env.NEXT_PUBLIC_API_BASE_URL` today either, which
`assert-no-inlined-secrets.mjs` states as a live condition of its positive control.

`apps/web/next.config.ts` is not in TASK-059's `paths`, so `output: 'standalone'` is not
available without a paths amendment.

## Alternatives considered

**Run the web app from a bare `node:24-alpine` with the repository bind-mounted, installing
and starting `next dev` at container start.** Pros: no new Dockerfile; edits are live. Cons:
`pnpm install` on every `up`, so `docker compose up` needs the network every time and is slow
on the first run and every rebuild; a pnpm `node_modules` symlink forest built inside a
container over a bind mount that may already hold the host's, which breaks in ways specific
to the host's platform; and it makes the compose stack a development server rather than the
stack. Why it lost: AC-115 is about a machine with a clone coming up from nothing, and this
option makes that depend on npm registry availability at `up` time.

**Add `output: 'standalone'` to `next.config.ts` and ship the standalone bundle.** Pros: the
runtime image is roughly a third of the size, and `node server.js` needs no `node_modules`
install in the runtime stage. Cons: `next.config.ts` is outside TASK-059's `paths`, and the
setting changes what Vercel builds as well, so a compose-driven change alters the production
frontend's build output. Why it lost: it is the better image and the wrong TASK. It is a
follow-up with its own paths and its own verification against Vercel.

**No web service at all; leave `apps/web` to Vercel.** Pros: nothing to build. Cons: AC-115
names the web app explicitly. Why it lost: the AC.

**Publish the API to the browser through a compose-level reverse proxy so `/api/bff` works.**
Pros: the client's same-origin assumption would hold end to end. Cons: it is a third service
with no consumer, since no screen calls `apiClient`, and GC-7 allows one backend deployable
and one frontend deployable. It would also make the compose stack's routing differ from
Vercel's, so a path that works locally would not work deployed. Why it lost: it builds the
BFF proxy in nginx to avoid writing the BFF proxy in Next, for zero current callers. That is
the shape the no-Redis ruling rejected.

## Decision

**`apps/web/Dockerfile`, multi-stage, built with the repository root as context**, so the
pnpm workspace resolves:

```yaml
web:
  build:
    context: .
    dockerfile: apps/web/Dockerfile
```

Stages mirror the API's, and for the same reasons: a `manifests` stage copying all four
`package.json` files plus `pnpm-lock.yaml` and `pnpm-workspace.yaml`, because
`--frozen-lockfile` validates the lockfile against every importer the workspace declares
whatever `--filter` says; a `build` stage running `pnpm --filter @shortkit/web build`; and a
runtime stage running `pnpm install --frozen-lockfile --prod --filter @shortkit/web...`
and `next start`, as `USER node`.

Two details the implementer will otherwise discover the hard way:

- The runtime stage needs `packages/contracts/src` present, not just its `package.json`.
  `@shortkit/contracts` is a `workspace:*` dependency and ADR-0005 has it ship TypeScript
  source with no build step, so the prod install creates a symlink whose target must exist.
  The built output under `.next` already has the code inlined; the install still fails
  without the directory.
- `next start` reads `next.config.ts` at boot, so the runtime stage copies it alongside
  `.next` and `apps/web/package.json`.

### The COPY list is explicit, and `COPY apps/web apps/web` is forbidden

Added 2026-08-11 (F-317). The build stage copies exactly these paths and nothing broader:

```dockerfile
COPY tsconfig.base.json tsconfig.json ./
COPY packages/contracts/src packages/contracts/src
COPY apps/web/next.config.ts apps/web/tsconfig.json apps/web/next-env.d.ts apps/web/
COPY apps/web/app apps/web/app
COPY apps/web/src apps/web/src
# apps/web/public when it exists; it does not today
```

The reason is not tidiness. **`apps/web/.env.example` line 1 tells a developer to copy it to
`.env.local`**, that file holds `BFF_PROXY_SECRET`, and it sits inside this build context.
With `COPY apps/web apps/web` the secret's bytes land in an image layer readable by
`docker save`, `docker history` and `docker run --entrypoint sh`. Next loads `.env.local` in
every environment but test, so any `NEXT_PUBLIC_*` entry a developer added to it is also
inlined into `.next/static/**`.

**And the guard that would catch that is absent from this path.** The compose build runs
`next build` only, not `assert:no-secrets`, which is Vercel's build command and CI's check.
So the one thing in the repository that looks for `BFF_PROXY_SECRET` in build output does
not run on the build that just gained the exposure.

This is the same explicit-path discipline the API's `Dockerfile` uses and states a reason
for. The API got away with it because a bundled Node service has a short, obvious file list;
a Next app does not, which is exactly why the broad form is the natural thing to write here.

### `.dockerignore`'s secret patterns are root-anchored and must become recursive

Docker matches `.dockerignore` patterns against the context-relative path, so a pattern with
no `**/` prefix matches at the context root only. The file's own author knew this and wrote
both forms for build output, `node_modules` and `**/node_modules`, `dist` and `**/dist`,
`.next` and `**/.next`, then wrote only the root form for the secret block. So
`apps/web/.env.local`, `apps/api/.env` and `apps/*/*.pem` are uploaded into every build
context today.

`.gitignore` does not cover this and reading it is what makes the gap invisible: its
patterns **are** recursive, so the file is correctly never committed, and a reader assumes
the block two directories away does the same job.

TASK-059 already edits `.dockerignore` to drop the `infra` line. In the same edit the secret
block gains the recursive forms beside the root ones:

```
**/.env
**/.env.*
!**/.env.example
**/.npmrc
**/*.pem
**/*.key
```

Belt and braces, deliberately: the explicit COPY list is the guarantee and the ignore
patterns are the backstop, because the next Dockerfile over this context will be written by
someone who has not read this ADR. **Verify by inspecting the built image**, not by reading
the Dockerfile: create `apps/web/.env.local`, build, and confirm the file is absent from
the layer and its contents absent from `.next/static/**`.

**No `NEXT_PUBLIC_*` variable is set for this build, deliberately.** Next inlines those at
build time. The only value that could be inlined is either `http://api:3001/api`, which no
browser can resolve, or `http://localhost:3001/api`, which is the published port and would
be baked into an image that is then wrong anywhere else. Nothing under `apps/web` reads the
variable today, so setting it would bake a wrong value to satisfy no reader.

**`BFF_PROXY_SECRET` is not set either.** The compose build runs `next build` only, not
`assert:no-secrets`, which is Vercel's build command and CI's check. Nothing in the compose
build reads the secret.

**Nor does the `api` service set it at runtime, and that fact is now load-bearing twice.** Added
2026-08-11 (F-385). The paragraph above is about this file's build; the `api` service's
`environment` block carries `DATABASE_URL` and nothing else. ADR-0040 first cited that to
explain why the compose stack cannot test the trusted-header model. F-385 cites it again for a
different reason: `assertBffProxySecretConfigured` was specified to refuse boot when the secret
is unset under `NODE_ENV=production`, which `Dockerfile:83` sets in the image this stack runs, so
the assertion would have refused to boot `api` the day TASK-009 landed. That assertion now keys
on `BFF_TRUST_BOUNDARY`, which the stack also does not set, so `api` sets neither and boots.
**Adding a `BFF_PROXY_SECRET` to this service to satisfy a boot check is the alternative ADR-0040
rejected.** A future change that wants one needs a reason of its own.

**`web` declares no `depends_on`.** Nothing in `apps/web` calls the API, so a declared
dependency would assert a relationship that does not exist. That is the shape the no-Redis
ruling rejected on this same TASK. When the BFF proxy lands, `web` gains
`depends_on: api: service_healthy` in the same commit as the route.

### What works end to end, and what does not

Stated plainly because the difference is invisible from a running stack.

| Path | Result |
|---|---|
| `GET http://localhost:3000/` from a browser | 200, HTML. This is what AC-115 measures. |
| `GET http://localhost:3001/health` from a browser or curl | 200, `{"status":"ok","commit":"<40 hex>"}` |
| `http://api:3001/...` from inside the `web` container | reachable over the compose network |
| `http://localhost:3001/...` from inside the `web` container | **not** reachable; `localhost` there is the container |
| `http://api:3001/...` from a browser | **not** reachable; `api` is a compose-network name with no host DNS entry |
| Anything through `apiClient()`, which targets `/api/bff/<path>` | **404 from Next.** The BFF proxy route does not exist in this repository. |

The last row is the one that matters. No screen calls `apiClient` today, so nothing is
broken, and the compose file and README say so in those words rather than leaving a reader
to infer a working frontend-to-backend path from the fact that both containers are green.

**When the BFF proxy is written, it reads `API_BASE_URL=http://api:3001/api` server-side**,
without the `NEXT_PUBLIC_` prefix, at request time. That needs no rebuild and no browser
reachability, which is why the variable is named here rather than left to be guessed at
under time pressure. `apps/web/.env.example` documents that value for the compose stack, and
keeps the existing warning that `BFF_PROXY_SECRET` never takes the prefix.

**`apps/web/.env.example`'s head comment has to be rewritten, not just its two values.** It
currently explains at length that `NEXT_PUBLIC_API_BASE_URL` and `API_BASE_URL` are
"deliberately the same value", both pointing at the same Fly origin, and that this identity
is why F-154 ruled `API_BASE_URL` out of `assert:no-secrets`'s leak targets and why
`NEXT_PUBLIC_API_BASE_URL` is its positive control. ADR-0030 removes the Fly origin and this
ADR gives `API_BASE_URL` a compose-internal value, so the two are no longer identical and
the comment describes a hostname that is gone. Nothing breaks, because the script does not
compare them. **Do not re-open the F-154 ruling**, which Juano made; rewrite the comment to
say what is true now and leave `LEAK_TARGET_VAR` and `POSITIVE_CONTROL_VAR` alone. The same
applies to AC-113's text naming `API_BASE_URL` as a leak target while the ruled
implementation deliberately does not check it: that divergence predates this cluster and is
not TASK-059's to resolve.

## Consequences

### Positive

- `docker compose up` produces a web app from a fresh clone with no network access after the
  first build, and the image is built the same way the API's is.
- The stack does not bake a browser-unreachable API origin into a client bundle, which is
  the failure that would look correct until someone opened devtools.
- The gap between "both containers are healthy" and "the frontend can call the backend" is
  written down instead of discovered.
- No dependency is declared that does not exist, so the dependency graph stays readable as
  evidence.

### The cost accepted

- **The composed stack does not demonstrate the frontend calling the backend, and AC-115
  does not require it to.** A reader could reasonably expect a full stack to be full. It is
  not, and it cannot be until the BFF proxy exists.
- **The web image is larger than it needs to be**, because `next start` with a prod install
  ships `node_modules` where `output: 'standalone'` would ship a bundle. That is a follow-up
  with a paths amendment, not a defect here.
- **A second Dockerfile means two files that drift.** The API's Dockerfile already carries a
  hard-won note about `pnpm install --frozen-lockfile` needing every manifest; the web one
  repeats it, and a fix to one will not reach the other.
- **The explicit COPY list breaks when `apps/web` gains a directory.** Adding `public/`, a
  `middleware.ts` or a postcss config produces a build that succeeds and a page that is
  missing something, which is a worse failure than a build error. That is the price of not
  writing `COPY apps/web apps/web`, and it is the same price the API's Dockerfile already
  pays and records.
- **`assert:no-secrets` still does not run on the compose build.** The recursive ignore
  patterns and the explicit COPY list close the leak by construction; nothing checks that
  they stayed closed. Adding the check to the web image's build stage is a real option and it
  needs `BFF_PROXY_SECRET` set at build time, which reintroduces a secret into a build that
  currently needs none. Not taken here, and named so the trade is visible.
- **The compose build differs from Vercel's build.** Vercel runs `pnpm build && pnpm run
  assert:no-secrets`; compose runs `next build`. A build that passes locally can fail on
  Vercel's secret check, and the local stack will not say so.
- **`apps/web/.env.example` now documents two environments in one file**, the Vercel one and
  the compose one, and a developer copying it to `.env.local` gets values for a stack they
  may not be running.

### Dated note, 2026-08-18 — the `api` service declares `MAIL_TRANSPORT=console` (D-02, TASK-1b-11)

Item 1b put an invitation surface on this stack, and the invitation is a link that arrives
by mail. `docker-compose.yml`'s `api.environment` now carries
`MAIL_TRANSPORT: ${MAIL_TRANSPORT:-console}`: every message the API would send is written to
the container's stdout as one plain-text block, so a developer and `check-compose-stack.sh`
read the accept link out of `docker compose logs api` and no mailbox is involved. Ruled by
Juano on 2026-08-18 over the alternative of leaving the stack silent and giving the check a
test-only way at the token (a debug surface on the production image, rejected). The cost,
stated: a single-use bearer credential in a laptop's container log, which nothing else reads.
It changes nothing this ADR decided about `web`; the link's origin is the first entry of
`WEB_APP_ORIGINS`, `http://localhost:3000`, which is where `/invitations/accept` is served.
Unset stays `none` (ADR-0017): a production-shaped deployment never declares `console`, and
`MAIL_TRANSPORT=none docker compose up` is the silent stack.

### Follow-ups this creates

- TASK-059 writes `apps/web/Dockerfile` and updates `apps/web/.env.example`.
- `output: 'standalone'` is worth doing, with `apps/web/next.config.ts` in the TASK's paths
  and a Vercel build verified after the change.
- When the BFF proxy route lands it brings `depends_on: api: service_healthy`,
  `API_BASE_URL` in the `web` service's environment, and the removal of the 404 row above.
