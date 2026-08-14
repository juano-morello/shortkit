---
id: TASK-004
story: STORY-001
epic: EPIC-001
title: Mount the auth surface on Express with the body cap, the IP buckets and the boot assertions
status: todo
owner_slot: sdlc-implementer-backend
depends_on: [TASK-003]
paths: ["apps/api/src/main.ts", "apps/api/src/auth/auth-body-cap.ts", "apps/api/src/auth/auth-rate-limit.ts", "apps/api/src/auth/resolve-rate-limit-principal.ts", "apps/api/src/auth/ports/auth-rate-limit.port.ts", "apps/api/src/auth/boot-assertions.ts", "apps/api/src/common/net/trusted-client-address.ts"]
# NOTE 2026-08-14, F-075. `apps/api/.env.example` does not exist ON DISK TODAY. THAT IS NOT AN
# ERROR IN THIS PATH LIST - TASK-009 CREATES IT as a deliverable in wave 4 ("does not exist and is
# owed by three separate ADR follow-ups. It lands here", TASK-009:37-39). An earlier version of
# this note called it a phantom path; that was MY inference from the file's absence without
# reading TASK-009's prose, and it was wrong. WHAT F-075 ACTUALLY FOUND is a different file: the
# ROOT `.env.example`, which DOES exist, is the credential-rotation template holding
# SHORTKIT_MIGRATOR_PASSWORD and SHORTKIT_APP_PASSWORD, and was in no card's paths. TASK-018 owns
# it from 2026-08-14 and adds the third password.
contracts: [design/contracts/auth-tokens.md, design/contracts/rate-limit.md, design/contracts/trusted-client-address.md]
test_files: ["apps/api/src/auth/auth-body-cap.spec.ts (unit)", "apps/api/src/auth/resolve-rate-limit-principal.spec.ts (unit)", "apps/api/src/common/net/trusted-client-address.spec.ts (unit)", "apps/api/src/auth/boot-assertions.spec.ts (unit)", "apps/api/test/auth/auth-mount.int-spec.ts (integration)"]
acceptance: [AC-6, AC-7, AC-9]
rework_count: 0
---

## Intent

Put the auth handler on the wire in the exact order ADR-0013 fixes, with the two middlewares
that pay for mounting outside the Nest graph, and refuse to boot on a malformed trust
declaration.

## Approach

**The mount is one registration in one file, and the ordering is the whole trick.**
ADR-0013's decision, reproduced because an implementer sees only this card:

```ts
// apps/api/src/main.ts
const app = await NestFactory.create(AppModule, { bodyParser: false });

const server = app.getHttpAdapter().getInstance();

// Must precede any body parser: Better Auth reads the raw request stream.
// NestJS 11 ships Express 5, whose wildcard syntax is {*splat}, not *.
server.all(
  '/api/auth/{*splat}',
  authBodyCap({ maxBytes: 32 * 1024 }),
  authRateLimit(authRateLimitPort),
  toNodeHandler(auth),
);

app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: true, limit: '100kb' }));

app.setGlobalPrefix('api', { exclude: [{ path: 'health', method: RequestMethod.GET }] });
```

`main.ts` already carries a boot sequence, a `helmet` registration and a global prefix. The
existing order is: boot preconditions, `NestFactory.create`, `helmet` **on the app and
before the global prefix**, `setGlobalPrefix`, `listen`. `bodyParser: false` moves into the
existing `NestFactory.create` call, and the auth mount goes in ahead of the body parsers.
**`helmet` must keep covering the auth mount** — its docblock says it runs for every
response the process writes, "anything mounted outside the Nest module graph (ADR-0013)"
included, and that sentence was written for this mount.

`bodyParser: false` is a global setting made for one route. Any middleware added before
`app.use(express.json())` afterwards silently receives an unparsed body, and the symptom is
`undefined` rather than an error. Say so in a comment above the line.

**`authBodyCap` does not parse.** `express.json({ limit })` would consume the stream Better
Auth needs, which is the entire reason for `bodyParser: false`. It rejects with 413 when
`Content-Length` exceeds 32768; for a chunked request with no or an understated
`Content-Length` it counts bytes as they pass and destroys the socket once the cap is
crossed, with no response body. A legitimate oversized upload therefore sees a connection
reset rather than a 413, which is an accepted cost recorded in ADR-0013.

**`authRateLimit` is IP-keyed only: headers, never the body.** Reading the email from
Express middleware would consume the same stream. ADR-0013's limits:

| Route | Key | Limit |
|---|---|---|
| `POST /api/auth/sign-in/email` | IP | 10 / 5 min |
| `POST /api/auth/sign-up/email` | IP | 3 / hour |
| everything else under `/api/auth/*` | IP | 60 / min |

The email-keyed bucket is a `hooks.before` middleware inside Better Auth and is **out of
scope here** — it belongs with invitations and the wider auth-surface protection in item 1b,
and `beforeHooks` is deliberately empty (TASK-003). Recording it as absent rather than
silently omitting it: an attacker across many addresses is bounded here only by the IP
buckets.

Both middlewares reach their store through `AUTH_RATE_LIMIT_PORT` rather than through a
Redis client directly (F-024). The port is **required at boot rather than `@Optional()`**:
an unbound token fails startup, because a missing limiter opens the credential surface. The
implementation bound here is process-local, since no Redis client exists in this repository.

**A null principal is a real state and the buckets must handle it.** ADR-0040:
`resolveRateLimitPrincipal(headers): string | null`. Where no address is established the
result is **no principal, never a client-supplied one**, the bucket does not run, the
request proceeds, and `trusted_client_ip_unresolved_total` counts it. In every environment
that exists today — compose, CI and local dev — no header is declared, so **no IP-keyed
limit binds anywhere**. That is stated in ADR-0040 as an accepted cost; `authBodyCap` still
binds and is what keeps the credential surface from being unprotected.

`readTrustedClientAddress(headers, env)` returns a string `net.isIP` accepts, or `null`. It
**never throws** and **never reads `X-Forwarded-For` or `Forwarded` in any position**.

**Two boot assertions, and neither may key on `NODE_ENV`.** `Dockerfile:83` sets
`ENV NODE_ENV=production` unconditionally in the image `docker compose` runs, so a
`NODE_ENV` gate refuses to boot `api` on a developer's laptop. This is the F-386 ruling and
ADR-0040's F-380/F-385 amendments, and it is the single most repeated trap in this
repository's history.

```
CLIENT_TRUST_BOUNDARY = proxy | direct      # unset is read as direct
BFF_TRUST_BOUNDARY    = bff   | direct      # unset is read as direct
```

- The **value's validity is asserted unconditionally**: `Proxy`, `true`, `prod` and any
  other unrecognised value fail boot in every environment, because `direct` is the permissive
  branch and a typo must not reach it silently.
- The **requirement is conditional**: `proxy` requires `TRUSTED_CLIENT_IP_HEADER` set,
  non-empty, a valid lowercase header name and not a hop-by-hop forwarding header; `bff`
  requires `BFF_PROXY_SECRET` set and non-empty. `direct` and unset require nothing.
- The call sites in `main.ts` are **unconditional; the gating lives inside the functions.**

## The auth-role separation assertion — added 2026-08-13, Design rounds 3 and 4

**`boot-assertions.ts` is created by TASK-003 in wave 2, not here.** Juano moved the secret
assertion there at the Design gate (F-033) so it lands with the config it guards. This TASK
**adds to** that file rather than creating it, and the secret assertion has left this card.

**`assertAuthRoleSeparation()`** proves the negative that ADR-0050's role split rests on. Get
its shape right, because round 4 measured three ways the obvious version fails (F-031):

- Assert the **whole privilege set**, not `SELECT`. The attack this closes is an `INSERT`.
  A check that reads `SELECT` only passes green while `shortkit_app` inserts a forged session
  row for another tenant's user — measured, `INSERT 0 1`, both directions green. That is
  ADR-0044's original error reproduced inside the ADR written to correct it.
- Assert over the **whole exempt list** in both directions — all five as `shortkit_app`,
  and the tenant-scoped tables as `shortkit_auth`. `account` (password hashes) and `jwks`
  (the signing key) were unchecked in the first draft.
- `has_table_privilege` alone **misses a column-level grant**: `GRANT SELECT (email) ON
  "user"` leaves the table-level call `false` while `SELECT email` returns the row. OR in
  `has_any_column_privilege`, whose list is **three** — it raises `unrecognized privilege
  type` on `DELETE`.
- The comma list is **ANY-of**, so the negated form is the one that holds.
- **One catalogue query per direction**, reading `pg_class`, not one call per table name:
  `has_table_privilege` on an absent table raises `42P01`, and a missing table means
  "migrations have not run", which is a different verdict from "privileges are wrong".
- Also assert `shortkit_auth`'s three role attributes — `NOBYPASSRLS`, not superuser, owns
  nothing.

**`main.ts` gains `AUTH_VERDICT_PREFIX = 'DATABASE_AUTH_URL connect'`** and a third
`BootPrecondition`, `'auth_role_separation'`, with the reachability half retried on the
existing budget. The prefixes were checked not to collide: `'DATABASE_AUTH_URL connects as
x'.startsWith('DATABASE_URL connect')` is `false`.

**Explicitly NOT this TASK:** parameterising `assertRuntimeRoleCannotBypassRls` or touching
`RLS_VERDICT_PREFIX`. Round 4 ruled that function stays parameterless and `DATABASE_URL`-only
(F-030); the auth role's posture is asserted by `assertAuthRoleSeparation`, which already
holds an auth-pool connection.

## Out of scope for this TASK

The Better Auth instance and its plugins (TASK-003 — this TASK imports `auth` and does not
edit `auth.config.ts`). `AuthGuard` (TASK-005). The email-keyed `hooks.before` bucket and any
`@Public()` route bucket (item 1b). Any Redis binding. `apps/api/.env.example` and the
compose environment block (TASK-009). Changing `helmet`'s options or the global prefix's
`exclude` list.

## Interfaces

**Consumes**

From TASK-003:
- `auth` — the composed Better Auth instance
- `beforeHooks: AuthBeforeHook[]`

From `better-auth/node`: `toNodeHandler(auth)`.

From `apps/api/src/health/build-commit.ts` and `apps/api/src/db/rls.ts` (shipped, already
called by `main.ts`): `readBuildCommitSha()`, `assertRuntimeRoleCannotBypassRls()`.

From `apps/api/src/observability/logger.ts` (shipped): `logger`,
`errorLogFields(thrown: unknown, options?: { includeMessage?: boolean })`.

**Produces**

- `apps/api/src/auth/auth-body-cap.ts` exporting
  `authBodyCap(options: { maxBytes: number }): RequestHandler` — 413 on an oversized
  `Content-Length`; destroys the socket without a response body on a chunked overflow;
  **never consumes the stream on the accepted path**
- `apps/api/src/auth/ports/auth-rate-limit.port.ts` exporting
  `AUTH_RATE_LIMIT_PORT` (injection token) and
  `interface AuthRateLimitPort { check(bucket: string, key: string): Promise<void> }` —
  rejects with a 429-mapping error when the bucket is exhausted
- `apps/api/src/auth/auth-rate-limit.ts` exporting
  `authRateLimit(port: AuthRateLimitPort): RequestHandler` and
  `LocalAuthRateLimiter implements AuthRateLimitPort` — a process-local bucket store
- `apps/api/src/auth/resolve-rate-limit-principal.ts` exporting
  `resolveRateLimitPrincipal(headers: IncomingHttpHeaders, env: NodeJS.ProcessEnv): string | null`
  — BFF branch first, then the declared header, then `null`. **Never a client-supplied value.**
- `apps/api/src/common/net/trusted-client-address.ts` exporting
  `readTrustedClientAddress(headers: IncomingHttpHeaders, env: NodeJS.ProcessEnv): string | null`
  — never throws; never reads `X-Forwarded-For` or `Forwarded` in any position
- `apps/api/src/auth/boot-assertions.ts` — **added to, not created here** (TASK-003 creates
  it in wave 2) — gaining
  `assertTrustedClientIpHeaderConfigured(env: NodeJS.ProcessEnv): void`,
  `assertBffProxySecretConfigured(env: NodeJS.ProcessEnv): void` and
  `assertAuthRoleSeparation(): Promise<void>` — all throw on refusal, and none reads
  `NODE_ENV`. `assertBetterAuthSecretConfigured` is **not** here; it is TASK-003's.
- `apps/api/src/main.ts` — the ADR-0013 mount, `bodyParser: false`, both assertions called
