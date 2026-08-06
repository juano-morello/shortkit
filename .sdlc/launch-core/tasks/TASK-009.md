---
id: TASK-009
story: STORY-005
epic: EPIC-002
title: Better Auth mounted in NestJS: signup, login, logout, session
status: todo
owner_slot: sdlc-implementer-backend
depends_on: [TASK-005, TASK-007]
paths: ["apps/api/src/auth/**", "apps/api/src/main.ts", "packages/contracts/src/auth/**", "apps/api/src/app.module.ts", "apps/api/test/auth/**"]
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

**Composition constraint, added 2026-08-04 (F-054, from ADR-0013).** You create
`apps/api/src/auth/auth.config.ts` including `const beforeHooks: AuthBeforeHook[] = []`,
**empty**. TASK-058 appends the email rate-limit hook and TASK-013 appends invitation
validation; neither replaces the array. You own the mount, plugin config,
`tenantIdForUser`, JWKS caching, `rateLimit: { enabled: false }` with the comment saying
why, and the unit test asserting the composed config carries `rateLimit.enabled === false`.
That test stays yours even though TASK-058 owns the three integration tests that pin
`ctx.path`. Note that TASK-058 also writes `auth.config.ts` — `depends_on` sequences you
ahead of it, so create the shape it appends to.

**Contracts import rule (ADR-0005, F-045).** Import from `@shortkit/contracts`, never a
subpath. The subpath map was removed; a subpath import will not typecheck. If a symbol is
missing from the root barrel, add its re-export line to `packages/contracts/src/index.ts`.

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

## ⚠ Test path added 2026-08-04 (F-057, ruled by Juano)

`paths` gained `apps/api/test/auth/**`. ADR-0013 assigns you an e2e test asserting
`POST /api/auth/sign-up/email` receives a parsed body; that needs a live server, so
`design/test-strategy.md` puts it in the integration layer, and your paths previously
reached no test directory at all. The test stays with the mount it verifies rather than
migrating to TASK-058, which would ship your mount one wave without its acceptance signal.

You now share `apps/api/test/auth/**` with TASK-058, as you already share `auth.config.ts`.
`depends_on` sequences you first. Create the directory; TASK-058 adds its three rate-limit
integration tests beside yours.

## ⚠ F-169 — `BFF_PROXY_SECRET` has an ENFORCED format now, and it is documented on the other side

Applied by the orchestrator 2026-08-05 from `sdlc-security-auditor`'s round-3 audit of TASK-004.
`design/**` and `tasks/**` are outside an implementer's paths, so this is recorded rather than
routed.

You configure the **Fly half** of `BFF_PROXY_SECRET` (`rate-limit.md:129`,
`assertBffProxySecretConfigured()`). As of TASK-004's fix round 2, the **Vercel half is
format-enforced**: `apps/web/scripts/assert-no-inlined-secrets.mjs` rejects the value unless it is
**base64url — `A-Z a-z 0-9 - _`, no padding — and at least 32 characters**, and that check is
chained into `vercel.json`'s `buildCommand`, so a nonconforming value **fails the deploy**.

`rate-limit.md:104` and ADR-0014:89 still say only "set and non-empty", and there is **no
`apps/api/.env.example`** — so nothing on your side documents a generator.

**Generate it with the same line `apps/web/.env.example` gives:**

```
openssl rand 24 | base64 | tr '+/' '-_' | tr -d '='
```

**Why this is on your card rather than in the ledger.** The obvious default is
`openssl rand -base64 32` — which is what this repo itself recommended until TASK-004's round-2
commit, and which is still one `git log -p` away. Roughly 74% of those values contain a `+` or `/`.
That produces a secret that is correct, secure, and accepted by every consumer *except* the Vercel
build check — and by the time it fails, the value is shared across two deployables, so the correct
repair (rotate both sides, redeploy) costs more than the wrong one (delete the check). This is the
same remediation-pressure shape that has now cost TASK-004 three fix rounds.

base64url is already the house convention for every other secret in the design —
`invitation-tokens.md`, `domain-provisioning.md`, ADR-0021 — so the constraint is right. It was
simply recorded in the one place the person generating the value would not be reading.

## ⚠ F-213 — fix `check-policies.mts` BEFORE you create the auth tables

`sdlc-integrator` found this during wave 1's integration pass, and the orchestrator reproduced it
independently. **You are the TASK that makes it reachable**, because you create `user`, `session`,
`account` and `verification` — the exact four tables the exemption list names.

F-147 hardened `apps/api/scripts/check-policies.mts` so an exemption must **assert** the relation
carries no `tenant_id` rather than trusting the name. The hardening queries
`information_schema.columns`. **Postgres filters that view by privilege**, and the check connects as
`shortkit_app` deliberately (F-122 — checking as the migrator would prove nothing about the DSN the
API actually uses). So a table the app role cannot see returns **zero rows**, and the gate concludes
the column is absent.

Reproduced, twice, independently:

```
create session with tenant_id, RLS off, REVOKE ALL ON session FROM shortkit_app

as shortkit_app:  information_schema.columns → 0      pg_attribute → 1

gate output:  skip  session — exempt: Better Auth. No tenant_id … (confirmed: no tenant_id column)
              OK: 2 table(s) in schema public, all protected or exempt.
              EXIT 0
```

**That is the exact scenario F-147's hardening was written to prevent** — an auth table landing
*with* a `tenant_id` and being waved through — and the hardening introduced the blind spot by
choosing a privilege-filtered catalog. The word "confirmed" in that output is a false claim.

**The fix: query `pg_attribute` instead.** It is not privilege-filtered and returned the column
where `information_schema` returned nothing. **Keep the runtime-role connection** — that part is
correct and is what F-122 ruled.

It is not a merge blocker today only because the four tables do not exist; the gate reported three
of them as "not evaluated" in the orchestrator's run. **The moment you create them, it is.**
