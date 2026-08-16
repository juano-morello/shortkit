# Scout report — wave 2 design grounding, TASK-003

## 1. The auth surface as it exists today

`apps/api/src/auth/` contains exactly three files, none of which TASK-003 creates:

- `apps/api/src/auth/membership-lookup.ts` — `withMembershipLookup` (ADR-0045's escape). Imports `databaseTransaction` from `../db/client` (`membership-lookup.ts:46`), calls it at `:118`.
- `apps/api/src/auth/tenant-id-for-user.ts` — `tenantIdForUser(userId): Promise<string>` (`:77-107`) and `NoTenantMembershipError` (`:49-61`). Its only database reach is `withMembershipLookup` (`:22`).
- `apps/api/src/auth/tenant-id-for-user.spec.ts` — unit spec for the above.

**Does NOT exist yet:** `auth.config.ts`, `auth.module.ts`, `boot-assertions.ts`, `on-user-created.ts`, `revocation-store.ts` — confirmed by `ls`, nothing else is in the directory.

`apps/api/src/app.module.ts` (24 lines, full file read) imports only `HealthModule` and registers `APP_FILTER` (`app.module.ts:20-23`). No `AuthModule` import exists.

`apps/api/src/main.ts` (328 lines, full file read) — bootstrap shape before `listen`:
1. `bootstrap()` (`:233`) calls `assertBootPreconditions()` (`:234`), which runs, in order: `readBuildCommitSha()` (`:159`), then `assertRuntimeRoleIsSafe()` (`:161`, wraps `assertRuntimeRoleCannotBypassRls` from `./db/rls` with retry/backoff up to 20s, `:168-213`).
2. `app = await NestFactory.create(AppModule)` (`:236`).
3. `app.use(helmet({...}))` (`:270-275`).
4. `app.setGlobalPrefix('api', { exclude: [{ path: 'health', method: RequestMethod.GET }] })` (`:279-281`).
5. `await app.listen(resolvePort(process.env.PORT))` (`:283`).

No call to any auth boot assertion exists yet — `boot-assertions.ts` does not exist and nothing imports it. `main.ts` imports `logger`/`errorLogFields` from `./observability/logger` (`:11`) and `assertRuntimeRoleCannotBypassRls` from `./db/rls` (`:9`) — these are the two precedents TASK-003's boot assertion has to fit alongside (see §9).

## 2. `apps/api/src/db/client.ts` (full file read, 388 lines)

Sanctioned-caller docblock, `client.ts:6-32`. Substance, verbatim structure: "THE ONLY FILE THAT CONSTRUCTS THE DRIZZLE CLIENT, AND IT DOES NOT EXPORT IT" (`:6`); sanctioned callers of `databaseTransaction` are `withTenantTransaction` (tenancy/tenant-context.ts), `withRedirectRead` (TASK-029), `privilegedTenantEraser` (TASK-054), `assertRuntimeRoleCannotBypassRls` (db/rls.ts) and `withMembershipLookup` (auth/membership-lookup.ts) — five, listed at `:11-14`. Fifth-entry note at `:23-26` names ADR-0045 explicitly. **This list is already current — it already includes `withMembershipLookup`.**

`betterAuthDatabase()` — `client.ts:259-278`. Exact signature: `export function betterAuthDatabase(): NodePgDatabase<typeof schema>`. Builds a second `pg.Pool` (`authPool`, `:261-266`) on `authConnectionString()` (reads `DATABASE_AUTH_URL`, throws if unset, `:163-176`), `max: AUTH_POOL_MAX` = 5 (`:88`, `:263`), `connectionTimeoutMillis: CONNECTION_TIMEOUT_MS` (2000ms, `:100`), `allowExitOnIdle: true`. Attaches both connection-error listeners with distinct labels (`:268-272`). `transaction: false` is NOT set here — that's a caller-side argument to `drizzleAdapter`, not a `betterAuthDatabase()` parameter; `betterAuthDatabase()` just returns a plain `NodePgDatabase<typeof schema>`.

**Current importers of `betterAuthDatabase`** (grep across `apps/api/src` and `apps/api/test`): only `client.ts` itself — the definition at `:259` and mentions in comments at `:60`, `:247`. **Zero external callers today.** TASK-003 is the first to import and call it (ADR-0046: "One caller, asserted by file name... may appear in exactly two files: `db/client.ts` and `auth/auth.config.ts`").

**Current importers of `databaseTransaction`** (grep, excluding comment-only hits): `apps/api/src/auth/membership-lookup.ts:46,118`; `apps/api/src/db/rls.ts:28,197`; `apps/api/src/tenancy/tenant-context.ts:45,211`. Three real callers today (plus `client.ts` itself, which defines it, `:287`). The docblock's five-entry list includes two not-yet-real callers (`withRedirectRead`, `privilegedTenantEraser` — both deferred TASKs), matching what the docblock already discloses.

`schema/auth.ts:129` — `betterAuthSchema = { user, session, account, verification, jwks }` — exists and matches ADR-0046's shape exactly (full file header read, `schema/auth.ts:1-40`).

## 3. `withTenantTransaction`, `tenant-context.ts` (full file read, 404 lines)

Signature (`tenant-context.ts:164-168`):
```ts
export async function withTenantTransaction<T>(
  tenantId: string,
  fn: (db: TenantDb) => Promise<T>,
  options?: TenantTransactionOptions,
): Promise<T>
```
`TenantTransactionOptions.afterCommit?: () => Promise<void> | void` (`:69-79`) — runs only after COMMIT (`:236-266`), on nested calls it is enqueued onto the outer context rather than run immediately (`:194-196`), a throw inside it is logged (`logger.error({ err: error }, 'afterCommit hook failed')`, `:264`) and never propagates.

Nesting: same `tenantId` reuses the outer transaction, no savepoint (`:180-198`); different `tenantId` throws `TenantContextMismatchError` (`:99-104`, `:181`); nesting inside an already-settled context throws `TenantContextMissingError` with the `CONTEXT_HAS_SETTLED` message (`:172-177`, `:94-97`).

`set_config` calls issued, in order, inside a fresh (non-nested) transaction (`:217-221`): `statement_timeout` (`:217`), `idle_in_transaction_session_timeout` (`:218-220`), `app.tenant_id` (`:221`, the only `app.`-prefixed flag this file sets). Flag name is always an inline SQL literal per file docblock (`:36-39`).

`CONTEXT_FLAG_OWNERS` lives in `apps/api/test/isolation/coverage.ts:1737-1746` — a `ReadonlyArray<{flag,file}>` with four rows today: `app.tenant_id` → `tenancy/tenant-context.ts`, `app.redirect_context` → `redirect/db/redirect-read.ts` (file does not exist, TASK-029), `app.privileged_erase` → `gdpr/privileged-eraser.ts` (file does not exist, TASK-054), `app.membership_lookup_user` → `auth/membership-lookup.ts` (exists). Consumed by exactly one spec: `apps/api/src/db/context-flag-owners.spec.ts:7` imports it and runs A1 (subset direction)/A4 checks (see §6 for the full shape — this is the file TASK-003's F-108 control must copy).

## 4. Pino instance and ADR-0028 allowlist

`apps/api/src/observability/logger.ts` (full file read, 999 lines). `logger` is constructed at `:152-180` via `pino({...})`. `LOGGABLE_FIELDS` allowlist at `:52-66` (a `ReadonlySet<string>`, append-only, one name per line). Enforcement mechanism: `formatters.log: (record) => fieldsCensored(record, 1)` (`:156-157`) — every key not in `LOGGABLE_FIELDS` is replaced with `REDACT_CENSOR = '[redacted]'` (`:704-735`, `:73`). `serializers.err` (`:159`) reduces any `Error` to `{err_name, err_message?, err_stack}` via `errorLogFields` (`:916-933`), with `includeMessage: false` by default. `logger.child`/`logger.setBindings` are wrapped and made non-writable/non-configurable (`:534-546`) so a caller cannot install its own `formatters.log`/`serializers`/`redact`.

**What a third-party `log(level, message, ...args)` hook must satisfy to route through it**: it is not a pino option itself — it is a plain function that calls `logger[level](...)` (or similar) internally, same as any other call site. ADR-0052 specifies the exact shape it should take (see §5). There is no special integration point; a hook just needs to call `logger.error(...)`/`.warn(...)`/etc. with a record object whose keys are all in `LOGGABLE_FIELDS`, or pass an `Error` under `err`.

**What bypasses it today**: nothing in `apps/api/src` bypasses pino — `eslint.config.mjs:98-124` bans `console.*` (`'no-console': 'error'`, `:101`) and `@nestjs/common`'s `Logger`/`ConsoleLogger` (`:113-120`) under `files: ['apps/api/src/**/*.ts']`, `ignores: ['apps/api/src/observability/logger.ts']` (`:98-99`). This rule does not reach `node_modules`, which is exactly ADR-0052's point about Better Auth's own logger — confirmed live in the installed package (§5).

## 5. better-auth as installed — version and the four claims

**Version: 1.6.26**, confirmed both ways:
- `pnpm-lock.yaml:1808` (`better-auth@1.6.26:`) and `apps/api/package.json` (`"better-auth": "1.6.26"`).
- `node_modules/.pnpm/better-auth@1.6.26_.../node_modules/better-auth/package.json` → `"version": "1.6.26"`.

Install path used below: `node_modules/.pnpm/better-auth@1.6.26_drizzle-kit@0.31.10_drizzle-orm@0.45.2_@types+pg@8.20.4_kysely@0.29._8cf625df5f12746bae1692ce838e3ed6/node_modules/better-auth`.

**(a) `jti` guard, `sign.mjs`.** `dist/plugins/jwt/sign.mjs:49`: `if (payload.jti) jwt.setJti(payload.jti);` — **line number holds exactly**, verified by reading the file.

**(b) `sub` overwrite.** `dist/plugins/jwt/sign.mjs:52-62` (`getJwtToken`): spreads `payload` (definePayload's return) at `:58`, then sets `sub: await options?.jwt?.getSubject?.(ctx.context.session) ?? ctx.context.session.user.id` at `:59`. TASK-003 cites `:53-61`; the effective statement is at `:56-59` — off by a few lines from the card's citation but the substance is exactly right: writing `sub` in `definePayload` has no effect.

**(c) `rateLimit.enabled` default.** `dist/context/create-context.mjs:171`: `enabled: options.rateLimit?.enabled ?? isProduction,` — **line number holds exactly.**

**(d) secret fallback chain and `DEFAULT_SECRET`.** `dist/context/create-context.mjs:70`: `const legacySecret = options.secret || env.BETTER_AUTH_SECRET || env.AUTH_SECRET || "";` — **line number holds exactly.** `:78`: `secret = legacySecret || "better-auth-secret-12345678901234567890";`. The published constant is also exported as `DEFAULT_SECRET` from `dist/utils/constants.mjs:2`: `const DEFAULT_SECRET = "better-auth-secret-12345678901234567890";` — literal value confirmed, 39 characters. `validateSecret` (referenced by ADR-0051 as `:38-45`) is at exactly `create-context.mjs:38-45` — confirmed: `isTest()` early-return (`:40`), default-secret-and-production throw (`:41`), empty-secret throw (`:42`, unreachable per the `||` chain above), length<32 warning (`:43`).

**`logger` option shape, installed.** `@better-auth/core/dist/env/logger.mjs` (full file read, 80 lines). `createLogger(options)` (`:55-76`): `levels = ['debug','info','success','warn','error']` (`:33-39`). The internal `LogFunc(level, message, args = [])` (`:59`) calls, when `options.log` is a function (`:62`): `options.log(level === "success" ? "info" : level, message, ...args)` (`:68`). **So the hook's exact call signature is `(level: 'debug'|'info'|'warn'|'error', message: string, ...args: unknown[]) => void`** — `success` is pre-mapped to `info` before the hook ever sees it, so the hook never needs to handle `'success'`. Confirms ADR-0052's `log: (level, message) => {...}` destructuring (dropping `args`) is a valid subset of this signature.

**JWKS storage and encryption.** `dist/plugins/jwt/adapter.mjs` (full file read): the adapter reads/writes model `"jwks"` — `findMany({ model: "jwks" })` (`:7,11`), `create({ model: "jwks", data: {...} })` (`:15-21`). `dist/plugins/jwt/utils.mjs` (full file read), `createJwk` (`:43-59`): `privateKeyEncryptionEnabled = !options?.jwks?.disablePrivateKeyEncryption` (`:46`, default **true**, i.e. encrypted unless explicitly disabled); when enabled, `privateKey: JSON.stringify(await symmetricEncrypt({ key: ctx.context.secretConfig, data: stringifiedPrivateWebKey }))` (`:51-54`) — **encrypted with the configured secret** (`ctx.context.secretConfig`, which derives from `betterAuthSecret()` once TASK-003 passes `secret` explicitly). `sign.mjs:34-39` decrypts the same way with `ctx.context.secretConfig` and throws `BetterAuthError('Failed to decrypt private key...')` on mismatch — this is the exact failure ADR-0051 cites for secret rotation.

## 6. Test tiers and conventions

`apps/api/vitest.config.ts` (full file, 14 lines): `include: ['src/**/*.spec.ts']` at **line 10** — matches TASK-003's citation exactly. Nothing else collects here.

`apps/api/vitest.integration.config.ts` (full file, 74 lines): `include: [INTEGRATION_SPEC]` where `INTEGRATION_SPEC = '**/*.int-spec.ts'` (`:17,51`). It also self-checks (`assertEveryIntegrationSpecRuns`, `:27-45`) that no `*.int-spec.ts`-shaped file sits outside the glob, and throws if one does. **A plain `*.spec.ts` under `apps/api/test/` matches neither `vitest.config.ts`'s `src/**` include nor `vitest.integration.config.ts`'s `**/*.int-spec.ts` include — confirmed it collects in neither tier**, exactly as TASK-003 states.

**A1/A4 control precedent (F-108's model to copy):** `apps/api/src/db/context-flag-owners.spec.ts` (full file read, 155 lines). Shape: reads `apiSource` via `readdirSync(..., { recursive: true })` filtering `.ts` and excluding `.spec.ts` (`:56,85-89`); regexes for `set_config\s*\(` calls (`:60`) and a permitted-first-argument pattern inherited verbatim from the frozen contract (`:72-73`); builds `{file, firstArgument}` pairs (`:78-113`); three `it()`s — a canary that the scan reaches the one real setter (`:123-128`), A4 (every first argument matches the permitted pattern, `:130-136`), and A1-subset (every `{flag, file}` pair is registered in `CONTEXT_FLAG_OWNERS`, `:138-154`). This is the shape TASK-003's `betterAuthDatabase` file-list control (F-108) is instructed to copy — same `readdirSync`/`.spec.ts`-exclusion/`toEqual([])` idiom, applied to `betterAuthDatabase` occurrences instead of `set_config` calls.

**`test/support/auth-fixture.ts`** (full file read, 376 lines) already exists — owned by `sdlc-test-architect`, not by any TASK's `paths` (file header, `:5-7`, "routing rule 0"). `authServerEnv(baseUrl)` (`:79-94`) sets on the spawned API child process: `NODE_ENV: 'test'`, `DATABASE_URL` (via `dsnOrThrow`, `:82`), `DATABASE_AUTH_URL` (`:83`), `GIT_COMMIT_SHA` (fixed 40-hex value, `:84`), `BETTER_AUTH_URL: baseUrl` (`:85`), `BETTER_AUTH_SECRET: 'integration-fixture-better-auth-secret-not-a-real-key'` (`:86` — **53 characters, confirmed by count**; ADR-0051 cites this as `:85`, one line off, value and length both correct), `BFF_PROXY_SECRET` (`:92`). Also provides `authRequest`, `signUp`, `signIn`, `signOut`, `getSession`, `mintToken`, `jwtClaims` (decodes JWT payload without verifying, `:205-216`), and Better-Auth-table readers (`accountsFor`, `sessionsFor`, `markEmailVerified`, `clearAuthTables`, etc.) that go through the migrator DSN via `psql`, not through the app.

## 7. `@shortkit/contracts` exports TASK-003 consumes

All confirmed present, `packages/contracts/src/auth/index.ts` and `packages/contracts/src/roles.ts`:

- `ACCESS_TOKEN_LIFETIME_SECONDS = 300` — `auth/index.ts:138`.
- `shortkitJwtClaimsContract` — `auth/index.ts:119-129`, exact field set: `sub: z.string().min(1)`, `tid: z.string().uuid()`, `email: z.string().email()`, `ev: z.boolean()`, `jti: z.string().min(1)`, `exp: z.number().int()`, `iat: z.number().int()`, `iss: z.string().min(1)`, `aud: z.string().min(1)`. Nine fields, `aud` is a **single string** not an array (docblock at `:116-117` states this explicitly, matching `sign.mjs:45`'s single `setAudience` call).
- `type ShortkitJwtClaims` — `auth/index.ts:131` (`z.infer` of the above).
- `asTenantRole<T extends string>(_value: Unbranded<T>): TenantRole` — `roles.ts:90-95`, throws `Error('not a tenant role: ...')` on a value outside `TENANT_ROLES`.
- `TENANT_ROLE.owner` — `roles.ts:63-67`, `TENANT_ROLE = { owner, admin, member }`.

Barrel: `packages/contracts/src/index.ts:22` re-exports `./auth`, `:20` re-exports `./roles`. Package may import only `zod` (`index.ts:9-11` header comment, lint-enforced).

## 8. Redis

**No Redis client anywhere in `apps/api/src`.** `grep -rli redis apps/api/src` matches only comment prose (`main.ts:89`, `exception-filter.ts:22`, `logger.ts:888`, `logger.spec.ts:56`) discussing a hypothetical Redis timeout as an example of an unlogged host — none are imports or clients. `grep -rn "from 'redis'|ioredis|createClient"` across `apps/api/src`: zero hits. **No `package.json` in the repo lists a `redis` dependency** (grepped every `package.json`, none matched, node_modules excluded).

**API process count.** `docker-compose.yml`'s `api` service (`:204` onward) has no `scale:`/`replicas:`/`deploy:` key — confirmed by grep over the service block. **Compose runs exactly one `api` container.** No `fly.toml` exists anywhere in the repository yet (searched, zero matches) despite `main.ts:25-27`'s comment referencing one — deploy is out of scope per ADR-0030 ("no deploy target"), so there is currently no multi-instance deploy topology to reason about either; the only concrete answer today is "one process, in compose and in CI's `compose` job." **A process-local revocation store's weakness is therefore latent, not live, on anything this repo currently runs** — but nothing enforces that stays true once a deploy target exists.

## 9. Prior art

**"Permitted file list" control:** `apps/api/src/db/context-flag-owners.spec.ts` (full shape in §6) is the only such control today, asserting A1 (subset)/A4 over `set_config` call sites against `CONTEXT_FLAG_OWNERS`. No existing spec greps for a bare function-name occurrence (e.g. `betterAuthDatabase`) the way TASK-003's F-108 control needs to — it has to be built fresh, following the same `readdirSync`/exclude-`.spec.ts`/`toEqual([])` idiom.

**Boot assertions before `listen()`:** exactly one exists today — `assertRuntimeRoleCannotBypassRls` (`db/rls.ts`), invoked from `main.ts:161` inside `assertBootPreconditions()`/`assertRuntimeRoleIsSafe()` (`:158-213`), before `NestFactory.create` (`:236`), with retry/backoff bounded by `DATABASE_REACHABLE_BUDGET_MS = 20_000` (`:29`) and a verdict-prefix scheme (`RLS_VERDICT_PREFIX = 'DATABASE_URL connect'`, `:48`) to distinguish "could not answer" from "answered unsafely" (F-245, documented at length `:96-157`). This is the pattern `boot-assertions.ts`'s `assertBetterAuthSecretConfigured()` has to fit alongside — ADR-0050 already names the parallel construction for `assertAuthRoleSeparation()` (`AUTH_VERDICT_PREFIX = 'DATABASE_AUTH_URL connect'`, a third `BootPrecondition` member), though that one is TASK-004's, wave 3, not this card's.

## 10. Gotchas

- **`betterAuthSchema` and the auth pool already exist and match ADR-0046/ADR-0050 exactly** — `client.ts:259-278` (`betterAuthDatabase`) and `schema/auth.ts:129` (`betterAuthSchema`) were both shipped by TASK-002 in wave 1. TASK-003 is purely a *consumer* of these two; nothing here needs building, only importing and calling once each.
- **`client.ts`'s sanctioned-caller docblock already lists all five `databaseTransaction` consumers**, including `withMembershipLookup`, and TASK-003 does not touch this file at all — it is not in TASK-003's `paths`.
- **`docker-compose.yml`'s `BETTER_AUTH_SECRET` no longer carries a committed default** — confirmed at `:295`, it's `${BETTER_AUTH_SECRET:?generate at least 32 characters...}`, a required reference with no fallback. The literal `development-compose-better-auth-secret-not-a-real-value` that ADR-0051's F-144 discusses as a conditional fourth rejection **is gone from the file** — grepped, zero matches. Per ADR-0051's own ruling, this means TASK-003 implements **only three rejections** (unset-or-empty, shorter than 32, equal to `better-auth-secret-12345678901234567890`), not four — the condition that would have required a fourth ("if the literal is still in `docker-compose.yml` when TASK-003 starts") is false.
- **`DATABASE_AUTH_URL` is already wired in `docker-compose.yml`** (`:273`) and in `auth-fixture.ts` (`:83`) — TASK-018/TASK-019 (wave 0/1) already landed this per ADR-0050's schedule. TASK-003 does not need to worry about the binding being absent in either compose or the integration fixture.
- **`auth-fixture.ts` already sets a compliant `BETTER_AUTH_SECRET`** for the integration tier (53 chars, not the default) — the integration suite needs no fixture change from TASK-003.
- **`app.module.ts`'s only change per the card is adding `AuthModule` to `imports`** — confirmed the file is currently minimal (24 lines, `HealthModule` + `APP_FILTER` only) so this is a small, low-risk diff exactly as scoped.
- **TASK-003's `contracts:` front-matter cites `design/contracts/auth-tokens.md` and `design/contracts/tenant-context.md`, both of which live under `.sdlc/foundation/design/contracts/`**, not under `.sdlc/identity-membership/design/contracts/` (which instead holds `auth-contracts.md`, `auth-schema.md`, `tenant-membership-lookup.md` — none of these three is listed in TASK-003's `contracts:` field). `auth-contracts.md` explicitly names TASK-003 as a consumer of `ACCESS_TOKEN_LIFETIME_SECONDS`, the password bounds and the claim shape (`auth-contracts.md:8-9`) — worth the architect's attention since it's the more directly relevant contract and isn't in the card's own field.
- **The frozen foundation contracts (`tenant-context.md`, `isolation-coverage.md`) already reflect ADR-0045's amendments** — five `databaseTransaction` consumers, three isolation exclusions — since TASK-002 shipped wave 1 (confirmed via grep, no stale "exactly two"/"exactly four" language found in the live contract text touched by that amendment).
- **No `fly.toml` exists in the repository at all** despite being referenced in `main.ts` comments (`:25-27`) — deploy topology is genuinely undecided/out of scope (ADR-0030), which is the basis for answering Q8 as "one process" with the caveat that nothing pins it there long-term.

## What I could not determine

- Whether any deploy target beyond `docker compose` will ever run more than one API process — there is no `fly.toml` or other deploy manifest in the repository to check against. This bounds only what's true *today* (compose, one `api` service, no scale key).
- Whether TASK-003's two-line discrepancy in citing `sign.mjs:53-61` for the `sub` overwrite (actual statement is `:56-59`, function spans `:52-62`) is something the card should correct — reported as observed, not adjudicated (that's a review/design call, not a scouting one).
