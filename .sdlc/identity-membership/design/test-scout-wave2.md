# Test scout — identity-membership, wave 2 (TASK-003)

Grounds the Test phase for TASK-003 only. Read: TASK-003.md, test-strategy.md (waves 0-1),
test-scout.md (waves 0-1), contracts/auth-config-surface.md, contracts/revocation-store.md, the
three existing stubs under `design/stubs/apps/api/src/auth/` (`auth.config.ts`,
`boot-assertions.ts`, `revocation-store.ts` — `membership-lookup.ts` and `tenant-id-for-user.ts`
also live in that directory but belong to TASK-002, already shipped). Every claim below was
verified by opening the cited file or running the cited command in this session
(2026-08-16); nothing is carried over unread from the wave 0-1 report.

## 1. The suite as it stands today

**Unit tier**, `pnpm test` (root, fans to three workspace projects) — ran it:
`Test Files 25 passed (25)`, `Tests 236 passed (236)`, wall clock 2.2s.
`pnpm --filter @shortkit/api test` alone (the workspace TASK-003 writes into): **18 files, 137
tests, 1.4s**, all green. No red spec anywhere in the unit tier.

**Integration tier**, `pnpm --filter @shortkit/api test:integration` (ran it, against
`docker-compose.test.yml`'s postgres, migrated first with `db:migrate`): **6 files, 82 tests,
wall clock 298.66s (≈5 minutes)**, all green. `fileParallelism: false`
(`apps/api/vitest.integration.config.ts:70`) so this is a serial sum, not the slowest file. The
six files, in run order: `test/isolation/cross-tenant-isolation.int-spec.ts` (72KB, the bulk of
the wall clock — individual assertions ran 600ms-11.5s each), `test/tenancy/tenant-context.int-spec.ts`
(25 tests, 37s), `test/auth/tenant-memberships.int-spec.ts` (7 tests, 7s),
`test/tenancy/auth-role-provisioning.int-spec.ts` (9 tests, 5.2s),
`test/tenancy/warm-connection-no-context.int-spec.ts` (3 tests, 4.5s),
`test/security/security-headers.int-spec.ts` (8 tests, 1s).

Nothing under `apps/api/test/auth/` or `apps/api/src/auth/` matching TASK-003's `test_files` list
exists yet:
- `apps/api/src/auth/` today holds only `membership-lookup.ts`, `tenant-id-for-user.ts`,
  `tenant-id-for-user.spec.ts` (TASK-002). No `auth.config.ts`, `on-user-created.ts`,
  `revocation-store.ts`, `auth.module.ts`, `boot-assertions.ts`.
- `apps/api/test/auth/` today holds only `tenant-memberships.int-spec.ts` (TASK-002). No
  `signup-creates-tenant.int-spec.ts`, `mint-refuses-without-membership.int-spec.ts`.
- `apps/api/src/db/better-auth-database-callers.spec.ts` does not exist (`ls apps/api/src/db`
  confirmed).
- `apps/api/.env.example` does not exist (`ls` confirmed) — TASK-003 creates it, matches the card.
- `docker-compose.yml` has no `BETTER_AUTH_URL` or `WEB_APP_ORIGINS` keys yet (`grep` confirmed;
  only `BETTER_AUTH_SECRET` at `docker-compose.yml:295`, a required reference with no default).

## 2. `apps/api/test/support/auth-fixture.ts` — every export, verified against the file (375 lines)

- `POLICY_COMPLIANT_PASSWORD` (`:41`), `TOO_SHORT_PASSWORD` (`:52`), `SIGNUP_NAME` (`:60`) —
  string constants for signup bodies.
- `authServerEnv(baseUrl): Record<string, string>` (`:79-94`) returns exactly: `NODE_ENV: 'test'`,
  `DATABASE_URL` (via `dsnOrThrow`, role `shortkit_app`), `DATABASE_AUTH_URL` (via `dsnOrThrow`,
  role `shortkit_auth` — **already present**, contradicting wave-0-1 report's note that it was
  absent; TASK-018 added it since, confirmed at `:83`), `GIT_COMMIT_SHA` (fixed 40-hex value),
  `BETTER_AUTH_URL: baseUrl`, `BETTER_AUTH_SECRET` (a 55-char fixture string, `:86`),
  `BFF_PROXY_SECRET` (`:92`). **Does not set `WEB_APP_ORIGINS`** — TASK-003's boot assertion for
  that binding must tolerate it unset (the contract says unset is legal, resolves to `[]`).
- `dsnOrThrow(variable, role)` (`:104-118`) — one reader for both DSNs, no fallback between them,
  throws a remedy naming `docker compose -f docker-compose.test.yml up -d`, all three DSN exports,
  and which variable/role was missing.
- `authRequest(server, method, path, options)` (`:137-171`) — the one HTTP primitive. Sends
  `Origin: server.baseUrl` on every request (required, `better-auth` 403s a state-changing request
  with none). Reads body as text first, then attempts JSON parse, falls back to raw text on
  failure — never throws on a non-JSON body. Extracts cookies from `Set-Cookie` via
  `getSetCookie()`, strips attributes, drops any pair ending in `=` (empty value), joins with
  `; `. Returns `{ status, body, raw, cookie }`.
- `signUp` / `signIn` / `signOut` / `getSession` / `mintToken` (`:173-202`) — thin wrappers over
  `authRequest` for `/sign-up/email`, `/sign-in/email`, `/sign-out`, `/get-session`, `/token`.
- `jwtClaims(token): Record<string, unknown>` (`:205-216`) — **decodes only, does not verify the
  signature.** Splits on `.`, takes the middle segment, base64url-decodes, `JSON.parse`s. Its own
  docstring: "the tests assert on claims, not on trust."
- `columnMatching(table, pattern)` (`:222-242`) — private; reads `pg_attribute` (not
  `information_schema`, per F-213) to discover the real column name (`emailVerified` vs
  `email_verified`) rather than hard-coding it.
- `accountsFor(email)`, `markEmailVerified(email)`, `sessionsFor(email)`, `deleteSessionsFor(email)`,
  `countSessions()`, `bringSessionExpiryForward(seconds)`, `clearAuthTables()` (`:244-375`) —
  direct-SQL reads/writes against the four Better Auth tables via `migrationDsn()`
  (`shortkit_migrator`), bypassing the app entirely. `clearAuthTables()` is the between-case reset:
  a `DO $$` block that deletes from `session, account, verification, user` in that order, and is
  **deliberately tolerant of a table that does not exist yet** (checks `to_regclass` first) so a
  wave-2 test file does not fail on setup before TASK-003 has landed the schema dependency chain.

**Cookie attributes, response bodies, JWT claims — what's already asserted, what isn't:**
`authRequest`'s `cookie` field only carries `name=value` pairs (attributes stripped by the
`.split(';')[0]` in the mapper) — **nothing here reads `HttpOnly`, `Secure`, `SameSite` or
`Max-Age`.** TASK-003's contract obligation ("the session cookie's resolved attributes off
`$context.authCookies`") is **not** served by this fixture's `cookie` field; a test needing those
attributes must read the raw `Set-Cookie` header directly (`response.headers.getSetCookie()`,
not exposed by `authRequest` today — it would need the raw response or a new helper).
`AuthResponse.body` gives whole-body JSON for the body-equality assertion.
`jwtClaims` gives the claim set for the `iss`/`aud`/`exp`/`iat`/`tid` assertions. No existing
test in this fixture or elsewhere asserts on any of the three — `signup-creates-tenant.int-spec.ts`
and `mint-refuses-without-membership.int-spec.ts` are new files, first users of all three.

## 3. How an existing integration spec asserts on a minted JWT

**None does.** `grep -rn jwtClaims apps/api` returns exactly one hit: the export itself at
`auth-fixture.ts:205`. **Zero callers anywhere in the repository today.** No integration spec
mints or decodes a token yet — `mintToken` (`auth-fixture.ts:200-202`) also has zero callers.
This is stated plainly rather than inferred: TASK-003's `signup-creates-tenant.int-spec.ts` and
`mint-refuses-without-membership.int-spec.ts` are the first specs to call either helper. The
decode-not-verify shape of `jwtClaims` (§2 above) is the only precedent to build from; there is no
real example to cite of an assertion on a minted token's claims.

## 4. The unit tier's boundary — can `auth.config.spec.ts` read composed config with no server?

**Yes, testable — via a documented, already-used pattern, not a novel one.**

Traced `betterAuthDatabase()` (`apps/api/src/db/client.ts:259-278`): it constructs a `pg.Pool`
lazily (`authDatabase === undefined` guard, `client.ts:260-274`) — **the constructor does not open
a TCP connection**, it only requires `authConnectionString()` (`:163-176`) to return a non-empty
`DATABASE_AUTH_URL`, or it throws synchronously. `client.spec.ts` (2 tests) already exercises this
module's pure accessors with no live database, confirming the module is import-safe without a DB
as long as the env vars it reads are set to *some* non-empty string.

**Traced into the installed `better-auth@1.6.26` package** (not inferred) to answer whether
`betterAuth({...})` itself does synchronous I/O at construction:
`node_modules/.pnpm/better-auth@1.6.26.../dist/auth/full.mjs:24-26` → `createBetterAuth(options, init)`
(`dist/auth/base.mjs:7-8`) → `const authContext = initFn(options)`, where `init` is declared
`const init = async (options) => { const adapter = await getAdapter(options); ... }`
(`dist/context/init.mjs:7-8`). Because `init` is an `async function`, calling it returns a pending
promise immediately; `createBetterAuth` does **not** await it except inside the returned
`handler` (called only per-request). So constructing `auth` does not block synchronously on the
adapter. **However**: `options.database` — i.e. `drizzleAdapter(betterAuthDatabase(), ...)` — is
evaluated as a plain function-call argument *before* `betterAuth()` is even entered, so
**`betterAuthDatabase()` itself runs synchronously the instant `auth.config.ts`'s module body
evaluates**, which is exactly what the contract's caller-list control assumes ("you are the first
and only caller"). What I did **not** verify is whether `init()`'s unawaited async body performs
any actual network I/O against the pool as a side effect of import (i.e., whether an unhandled
promise rejection or a lingering open socket appears in a unit-test process with no reachable
Postgres) — tracing `getAdapter`/`getBaseAdapter` further was out of scope for this pass. **Flag
this as a thing to watch during implementation**, not a blocker: NOT VERIFIED beyond the two call
sites cited.

**The precedent for stubbing module-scope env before import already exists in this repo**, doing
exactly what `auth.config.spec.ts` needs: `apps/api/src/health/health.spec.ts:62-69` —
`vi.stubEnv(COMMIT_SHA_ENV, BUILD_COMMIT_SHA)` called *before* a **dynamic** `await import('../app.module')`
(a static import would be hoisted above the stub and read the wrong value), then
`vi.unstubAllEnvs()` in `afterAll`. This is the template: `auth.config.spec.ts` stubs
`BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `WEB_APP_ORIGINS` (or leaves it unset, which is legal),
and `DATABASE_AUTH_URL` to fixture values, then dynamically imports `./auth.config`, and asserts
on the resulting `auth` object's `options` (or whatever surface `betterAuth`'s return exposes —
`base.mjs:9-33` shows the returned object carries `options` verbatim). Two other precedents for
env/module-boundary control in unit specs: `vi.resetModules()` at
`exception-filter.spec.ts:246` and `domain-error.spec.ts:127`. **AC-5 is testable as written**,
using this three-part pattern (stub env → reset modules if re-importing across tests → dynamic
import), not a novel mechanism.

## 5. Source-scanning spec precedent — `context-flag-owners.spec.ts`

**This file already exists and already passes** (155 lines, 3 tests, confirmed by running
`pnpm --filter @shortkit/api test` — `src/db/context-flag-owners.spec.ts (3 tests)`). It is
TASK-002's wave-1 deliverable, shipped and green, not a TASK-003 artifact — read here because
TASK-003's four-scan `better-auth-database-callers.spec.ts` is instructed to copy its shape.

**The regex-anchoring idiom** (`:72-76`):
```ts
const PERMITTED_FIRST_ARGUMENT =
  /^(['"`])(statement_timeout|idle_in_transaction_session_timeout|app\.[^'"`]*)\1$/;
const QUOTED_APP_FLAG = /^(['"`])(app\.[^'"`]*)\1$/;
```
Full-string anchors (`^...$`), a captured quote character re-matched by backreference `\1` so a
mismatched-quote literal fails, and the permitted set is an **enumeration** of exact alternatives
plus one open-ended `app.` prefix — deliberately not a loose character-class pattern, because (per
the file's own comment, `:66-70`) a loose pattern would also admit `role`,
`session_authorization`, `search_path`. This is the anchoring shape F-191 (TASK-003's card,
`:335-339`) warns the four new scans must copy exactly, since a bare unanchored `/'pg'/` or
`/process\.env\[/` will false-positive on `auth.config.ts`'s own mandated `provider: 'pg'` and on
`build-commit.ts:39`'s existing bracket-form access respectively.

**Scan structure** (`:85-113`): `scanSet()` walks `readdirSync(apiSource, { recursive: true })`
filtered to `.ts` files excluding `*.spec.ts`; `setConfigCalls()` does a `matchAll` for the call
token, then reads forward to the next comma (or line end) for "the first argument", not a
balanced-paren parse — justified because no flag name contains a comma. Assertions are
`expect(rejected).toEqual([])` shape (empty array = clean), with one **positive control**
asserting the scan actually found the one real site it should (`:123-128`) — guards against a
scan that silently walks nothing and passes vacuously.

**Tier trap, confirmed independently**: `apps/api/vitest.config.ts:10` is `include: ['src/**/*.spec.ts']`
only; `apps/api/vitest.integration.config.ts:17` is `include: ['**/*.int-spec.ts']` only. A file
under `apps/api/test/**` named `*.spec.ts` (not `*.int-spec.ts`) matches neither glob and
`assertEveryIntegrationSpecRuns()` (`vitest.integration.config.ts:27-45`) only catches the
opposite near-miss (`*.int.spec.ts`-shaped names), not this one. Confirmed by reading both config
files directly this session — this is why `better-auth-database-callers.spec.ts` must live under
`src/**` exactly as its own filename (already) states.

## 6. Pre-committed assertions — what exists today

**(a) Whole-body HTTP comparison with normalisation: nothing exists.** Grepped
`apps/api/test/**/*.int-spec.ts` for normalisation helpers (`omit(`, key-deletion patterns,
`structuredClone`) and for any two-response comparison (`bodyA`/`bodyB`/`responseA`/`responseB`
naming) — zero hits both ways. `signup-creates-tenant.int-spec.ts`'s whole-body-equality-after-
normalising-three-keys assertion is the first of its kind in this codebase; there is no helper to
reuse and none to imitate.

**(b) A test asserting a process refuses to boot: the mechanism exists and is documented, but
no test currently exercises it.** `apps/api/test/support/api-server.ts:211-217,223-229` —
`startApiServer()` polls for a TCP accept; if the child's `exit` event fires first, or the
deadline passes, it **rejects** with an `Error` whose message names the exit code, the signal, and
the full captured stdout+stderr (`captured`, accumulated at `:182-184`). The docblock
(`:48-84`) documents the `beforeAll`-kick/`beforeEach`-await idiom specifically so a boot
rejection surfaces as a per-test failure rather than a Vitest "skipped" report, and names
`test/auth/credential-auth.int-spec.ts` as "the reference implementation" — **that file does not
exist yet** (`ls apps/api/test/auth/` confirmed only `tenant-memberships.int-spec.ts`). The only
current consumer of `startApiServer` is `security-headers.int-spec.ts`, which always expects a
successful boot — it never exercises the rejection branch. So: the capture mechanism (exit
code + signal + output, via a rejected promise) is real and ready to use, but there is **no
executed precedent** for a test that deliberately supplies a bad env and asserts on the refusal —
NOT VERIFIED as an existing pattern in practice, only as documented capability. TASK-003's own
`boot-assertions.spec.ts` is unit-tier and does not need this at all — it calls
`assertBetterAuthSecretConfigured`/`assertBetterAuthUrlConfigured` directly and asserts they
throw `AuthBindingError`, no process spawn involved.

## 7. Timers and fake time

**No fake-timer usage anywhere in the repo.** `grep -rn "useFakeTimers\|FakeTimer"` across
`apps/` and `packages/` returned zero hits. No convention exists to inherit, and nothing bans it
either — it is simply unprecedented. The `revocation-store.ts` stub's own docblock
(`:94-98` in the stub) states the implementation is deliberately timer-free: "No timers: one
`setTimeout` per revocation keeps the event loop alive unless every one of them is `unref`ed... A
lazy sweep costs a walk of the map on write and nothing on read" — meaning TTL expiry is judged by
comparing a stored expiry timestamp against `Date.now()` (or equivalent) at read/write time, not
by a scheduled callback. **This means `revocation-store.spec.ts`'s 300-second-TTL assertion cannot
simply "wait" real time** and has no `setTimeout` to fast-forward past with `vi.advanceTimersByTime`
in the usual sense — it needs either (a) `vi.useFakeTimers()` plus `vi.setSystemTime`/
`vi.advanceTimersByTime` to move whatever clock source the implementation reads, or (b) the
implementation accepting an injectable clock the spec can control directly. Neither the contract
nor the stub commits to which; this is a real, first-of-its-kind decision for whoever writes this
spec, flagged rather than assumed.

## 8. Gotchas

- **The F-084 two-DSN fix in `security-headers.int-spec.ts` is already shipped**, and predates
  TASK-003's card text asking for it. `git log` shows it landed in commit `86c6b2b`
  ("feat(api): auth tables, tenant_memberships, the role split and the flag wrapper [TASK-002]",
  2026-08-14), which is *before* the card's "WIDENED A FOURTH TIME 2026-08-16" paragraph was
  written. Read the file (§ above, `:68-83,144-163`) before touching it: it already checks both
  `DATABASE_URL` and `DATABASE_AUTH_URL` and its remedy message already names all three DSN
  exports. Nothing to change here; re-doing this "fix" would be redundant work against a file that
  is not red.
- **`authServerEnv()` already carries `DATABASE_AUTH_URL`.** The wave 0-1 test-scout report
  (`design/test-scout.md:86-88`) states it is absent — that was true when that report was
  written; TASK-018 added it since (confirmed live at `auth-fixture.ts:83`). Do not trust that
  older report's fixture inventory without re-checking; this report supersedes it for that claim.
- **`authServerEnv()` does not set `WEB_APP_ORIGINS`.** Silence there is legal per the contract
  (resolves to `[]`), but a test asserting `trustedOrigins` behaviour against the spawned child
  needs to know the fixture leaves it unset rather than assume a default.
- **`authRequest`'s `cookie` field strips every attribute.** A test needing `Secure`,
  `HttpOnly`, `SameSite` or the `__Secure-` prefix must read `response.headers.getSetCookie()`
  directly (not currently exposed by any exported helper) rather than trust `AuthResponse.cookie`,
  which is name=value pairs only, built for round-tripping a session back to the server, not for
  asserting on.
- **`jwtClaims` never verifies a signature.** Any assertion phrased as "the token is valid" is
  wrong; only "the token carries claim X" is what this helper supports. A signature-verification
  assertion (if TASK-003 ever wanted one, it does not per its scope) would need a different tool.
- **`packages/contracts/src/auth/index.ts:133-138`'s docblock still instructs the numeric
  `expirationTime` form** — TASK-003's card (`:16-20`) makes this card the one and only carrier of
  the one-docblock correction; not verified against the file directly in this pass since it is
  out of this report's read list, but the card is explicit that the correction has "no live
  carrier" otherwise, so treat the docblock there as stale until TASK-003 lands.
- **`revocation-store.spec.ts` is not in TASK-003's originally-declared `test_files`** per the
  contract's own admission (`revocation-store.md:149,159-161`, "not in TASK-003's declared
  test_files and needs to be added") — but the TASK card as read *does* list it
  (`test_files:` line, "revocation-store.spec.ts (unit — NEW, wave 2...)"), so this has already
  been reconciled at the card level; the contract's sentence is stale relative to the card. Not a
  live gap, flagged only so it isn't rediscovered as one.
- **`apps/api/src/db/better-auth-database-callers.spec.ts` must live under `src/**`, matching its
  own path in TASK-003's `paths:` list** (`.../src/db/better-auth-database-callers.spec.ts`) —
  confirmed correct already; the trap (§5) is real but this path is not mis-placed.
- **Integration tier is a genuine ~5-minute wall clock today**, serial (`fileParallelism: false`).
  Two new `.int-spec.ts` files add to that serially, not in parallel — budget accordingly for
  local iteration during implementation.

## What I could not determine

- Whether `betterAuth()`'s unawaited `init()` promise performs any actual network I/O as a side
  effect of importing `auth.config.ts` in a process with no reachable `DATABASE_AUTH_URL` target
  (i.e., whether it produces an unhandled rejection or a lingering socket in the unit-test
  process). Traced two call frames deep into the installed package (`auth/base.mjs`,
  `context/init.mjs`) and stopped at `getAdapter`/`getBaseAdapter`; going further was out of
  scope for this pass. Flagged in §4, not resolved.
- The exact shape `auth.config.spec.ts` should assert against — whether `betterAuth()`'s returned
  object's `.options` is the composed config verbatim (it appears to be, per `base.mjs:9-33`
  spreading `options` onto the return value) or whether some keys are defaulted/mutated by
  `init()` before assertions could see them. Not traced past `createBetterAuth`'s synchronous
  return path.
- Whether CI already runs the integration tier the same way this session did (same DSNs, same
  migrate-then-test order) — not read `.github/workflows/ci.yml` in this pass.
