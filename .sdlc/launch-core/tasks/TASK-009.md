---
id: TASK-009
story: STORY-005
epic: EPIC-002
title: Better Auth mounted in NestJS: signup, login, logout, session
status: todo
owner_slot: sdlc-implementer-backend
depends_on: [TASK-005, TASK-007]
paths: ["apps/api/src/auth/**", "apps/api/src/main.ts", "packages/contracts/src/auth/**", "apps/api/src/app.module.ts"]
contracts: [design/contracts/auth-tokens.md, design/contracts/rate-limit.md, design/contracts/tenant-context.md]
test_files: []
acceptance: [AC-16, AC-20, AC-21, AC-112]
rework_count: 0
---

## Intent

Stand up credential auth and JWT issuance inside the API.

## Approach

Better Auth mounted in NestJS (already decided); JWT for the web app; API keys are reserved for a future MCP server and are **not** built here; passwords never appear in logs (GC-9).

**If this integration resists, escalate for a timeboxed spike rather than improvising** — `refinement.md` names Better Auth inside NestJS as a risk with thinner public prior art than the Next.js pairing.

**Pinning step, added 2026-08-04 (F-040, ruled by Juano).** This TASK pins
`better-auth` to an **exact version**, not a caret range, and adds it to
`apps/api/package.json`. ADR-0018 requires the exact pin because ADR-0013 accepts that
a Better Auth release can break the hand-written mount, so a floating range lets a
transitive bump break authentication with no code change.

Pinning carries an obligation that travels with it. Before the pin lands, re-check
these four facts against the documentation **for the version you are pinning**, because
the design was written against current-latest docs rather than a pinned release:

1. `rateLimit` defaults to enabled-in-production. This is why this TASK sets
   `rateLimit: { enabled: false }` and owns the unit test asserting the composed
   `betterAuth` config carries `rateLimit.enabled === false`. If this default has
   changed, the disable is harmless and nothing else moves.
2. The `hooks.before` / `createAuthMiddleware` signature.
3. The `ctx.body.email` shape.
4. `ctx.path` being base-path-relative.

**If (2) or (3) has changed, stop and escalate** — ADR-0018 states that F-019's and
F-021's mechanisms need revisiting before the pin lands, and that is a design decision,
not something to improvise here. Record all four results in your report and in the
commit message.

This step was assigned to TASK-001 by ADR-0018 and ADR-0013. TASK-001 excludes auth by
name, had no such step, and its implementer had no way to fetch documentation, so the
requirement had no producer. It lands here because the implementer that mounts the
library is the one that needs these four facts to be true.

## Out of scope for this TASK

**Split 2026-08-04 on Juano's ruling:** the auth-surface protection — `authBodyCap`,
the IP rate-limit buckets, the `hooks.before` email bucket, `AUTH_RATE_LIMIT_PORT`
and `LocalAuthRateLimiter` — moved to **TASK-058**, which depends on this TASK.
Design roughly doubled this TASK's scope and it sits in wave 2 with most of the
initiative behind it. Mount the auth surface here; protect it there.

Email verification and email sending (TASK-010), the request guard and tenant binding (TASK-011), tenant creation on signup (TASK-013), any UI.

## Interfaces

**Consumes**

`db`, `withTenantTransaction` (TASK-005); `ErrorEnvelope`, `ErrorCode` (TASK-007).

**Produces**

Auth routes for signup, login, logout, and current-session; `AuthUser` — `{ id, email, emailVerified: boolean }`; JWT issuance with claims including the user id; `signupContract`, `loginContract`, `sessionContract` in `packages/contracts/src/auth`; `onUserCreated` hook point that TASK-013 attaches tenant creation to.


## ⚠ Parked design finding you must read (F-037)

`rate-limit.md`'s ownership table assigns `resolveRateLimitPrincipal` **and**
`assertBffProxySecretConfigured` to this TASK. That table was written before Juano split
this TASK, and its attribution is stale.

**What you keep:** `assertBffProxySecretConfigured()` and its call in
`apps/api/src/main.ts`. `main.ts` is in your `paths` and in nobody else's — TASK-058
cannot write it. This is the one auth-surface piece that stays yours.

It matters: without that assertion, production can boot with `BFF_PROXY_SECRET` unset, the
trusted-proxy branch disables itself, and every IP-keyed bucket collapses onto Vercel's
egress address. The collapse is signalled — `bff_proxy_auth_mismatch_total` fires, because
the BFF still sends the auth header — but the assertion is what catches it at boot instead
of in production traffic.

**What is not yours:** the resolver, the body cap, the IP buckets, the email hook, the
port and the local limiter all moved to **TASK-058**.
