# Code-mode security audit — TASK-003 (identity-membership wave 2), round 1

verdict: changes-requested

Everything marked **EXECUTED** was run against the working tree and the pinned
`better-auth@1.6.26`, on a scratch database `sec_audit_t3` created in `shortkit-postgres-1`
with the role grants from `docker-compose.test.yml` applied in the right order, both
migrations applied, and **dropped afterwards**. Setup was verified before any refusal was
treated as meaningful: as `shortkit_auth`, `SELECT count(*) FROM "user"` succeeded and
`SELECT count(*) FROM tenants` answered `permission denied`. `shortkit_test` was never
connected to. Compose stack found up and left up. Scratch scripts lived in `/tmp/sk-audit`
and are deleted. Nothing in the repository was edited but this file.

F-200 and F-201 are not re-filed.

```yaml
findings:
  - task: TASK-003
    source: sdlc-security-auditor
    round: 1
    severity: major
    kind: behavior
    file: apps/api/src/auth/auth.config.ts
    line: 159
    summary: >-
      `advanced.disableOriginCheck` is unset, so better-auth decides whether the CSRF/origin
      check runs from `NODE_ENV === 'test'` **or from a `TEST` variable of any truthy shape**
      — the exact GC-B defect `useSecureCookies` was pinned to close, one key over.
    failure_scenario: >-
      EXECUTED. `create-context.mjs:210` is
      `skipOriginCheck: options.advanced?.disableOriginCheck !== undefined ?
      options.advanced.disableOriginCheck : isTest() ? true : false`, and
      `@better-auth/core/dist/env/env-impl.mjs:36` is
      `isTest = () => nodeENV === "test" || toBoolean(env.TEST)` with
      `toBoolean(v) = v ? v !== "false" : false`. The composed instance, measured through
      `auth.handler` with `POST /api/auth/sign-out`, `Origin: https://evil.test` and a cookie:

        NODE_ENV=production                skipOriginCheck=false  -> 403 INVALID_ORIGIN
        NODE_ENV=development               skipOriginCheck=false  -> 403 INVALID_ORIGIN
        NODE_ENV=test                      skipOriginCheck=true   -> 200 {"success":true}
        NODE_ENV=production TEST=0         skipOriginCheck=true   -> 200 {"success":true}
        NODE_ENV=production TEST=no        skipOriginCheck=true   -> 200 {"success":true}
        NODE_ENV=production TEST=false     skipOriginCheck=false  -> 403 INVALID_ORIGIN

      Two consequences, one certain and one conditional.

      **Certain.** `test/support/auth-fixture.ts:82` spawns the API child with
      `NODE_ENV: 'test'`, so from wave 3 the only tier that exercises the mount runs with the
      origin check OFF. `shouldSkipOriginCheck` also gates `validateURL` in
      `origin-check.mjs`, so `callbackURL`, `redirectTo`, `errorCallbackURL` and
      `newUserCallbackURL` are unvalidated there too — better-auth's open-redirect guard is
      off in the same tier. Everything this card ships around `trustedOrigins` — the
      `WEB_APP_ORIGINS` accessor, the two wildcard rules, `assertWebAppOriginsConfigured`, the
      compose entry, the `.env.example` paragraph — is never consulted by any test that issues
      a request. `auth-tokens.md:116-130`'s `403 MISSING_OR_NULL_ORIGIN` / `403 INVALID_ORIGIN`
      rows, `auth-config-surface.md`'s error-table row for the same, and `auth-fixture.ts`'s
      own decision 1 ("better-auth answers a state-changing auth request that has none with
      403") are all unverifiable by the suite as configured. This is the "control that cannot
      fail because it never runs" shape, on the CSRF control for the credential surface.

      **Conditional.** In production the check is on today — `Dockerfile:83` sets
      `NODE_ENV=production` — but it is one environment variable from being off, and the
      variable is named `TEST` and is truthy at `0`, `no` and every value but the literal
      `false`. A cross-site page against a signed-in user's browser then reaches every
      state-changing route under `/api/auth/*`. Not a blocker only because no environment that
      exists today sets it.

      GC-B is stated in this file's own header as "NO KEY HERE READS `NODE_ENV`". It holds for
      every key present and is defeated by the one that is absent — which is the same reason
      `useSecureCookies` and `rateLimit.enabled` are pinned two and five lines away.
    required_change: >-
      Set `advanced.disableOriginCheck: false` explicitly beside `useSecureCookies`, add it to
      `auth-config-surface.md`'s key-by-key table as a **silent** key with ADR-0059's
      reasoning, and assert it in `auth.config.spec.ts` off the RESOLVED
      `$context.skipOriginCheck` rather than off the option — the option is what the library
      overrides. VERIFIED to be the right remedy: with `disableOriginCheck: false` under
      `NODE_ENV=test`, `skipOriginCheck` is `false`, `https://evil.test` answers 403, and both
      `http://localhost:3001` (the API's own origin) and `http://localhost:3000` (a
      `WEB_APP_ORIGINS` entry) still answer 200 — so the integration fixture, which already
      sends the server's own origin for exactly this reason, stays green.

  - task: TASK-003
    source: sdlc-security-auditor
    round: 1
    severity: major
    kind: behavior
    file: apps/api/src/db/better-auth-database-callers.spec.ts
    line: 30
    summary: >-
      The exported `auth` is a second, more convenient handle on `shortkit_auth`, importable
      by any file under `apps/api/src`, and all four caller-list scans stay green on the file
      that uses it.
    failure_scenario: >-
      EXECUTED, and the scans were executed too rather than reasoned about. I mirrored
      `apps/api/src` to `/tmp` and planted five files, then ran the shipped spec against the
      mirror:

        evil-a  `import pg from 'pg'` + `process.env.DATABASE_AUTH_URL`   caught by scans 2,3,4
        evil-b  `drizzle(process.env['DATABASE_AUTH_URL'])`                caught by scans 2,3,4
        evil-c  destructured env + `await import('drizzle-orm/node-postgres')`  caught by 2,4
        evil-d  runtime-built env key + runtime-built specifier            CAUGHT BY NOTHING
        evil-e  `import { auth } from './auth/auth.config'`                CAUGHT BY NOTHING

      evil-d is ADR-0056's stated residual and I am not filing it. evil-e is not stated
      anywhere and needs no obfuscation at all — it is the natural way a future module would
      reach the Better Auth tables. Measured against the live scratch database through the
      shipped `auth.config.ts`, with `ctx = await auth.$context`:

        ctx.adapter.findMany({ model: 'session' }) -> 3 rows, plaintext `token` per row
        ctx.adapter.findMany({ model: 'account' }) -> the argon2 password hash
        ctx.adapter.findMany({ model: 'jwks' })    -> the encrypted `privateKey`
        ctx.adapter.create({ model: 'session', ... }) -> FORGED a session row for another
                                                         user's id, with an attacker-chosen
                                                         token (row deleted afterwards)

      That is precisely the capability the spec's own header prices as "account takeover, not
      disclosure", reached with none of the four scanned spellings in the file. The contract's
      guarantee — "`betterAuthDatabase()`'s result is not re-exported, not stored on a
      module-level binding another file can import" — is satisfied in the letter and defeated
      in substance, because `auth` itself is that binding and it has to be exported for
      TASK-004's mount. ADR-0056's accepted-cost list names the `test/**` and `scripts/**`
      residual, the runtime-built env key, and "the control does not bound what the handle
      does, only who holds it". It does not name a second handle inside the scanned tree.
    required_change: >-
      Either add a fifth scan bounding who may import `auth` from `auth/auth.config` — an
      equality whose permitted set is `main.ts` for the mount, `auth.module.ts` if TASK-005
      needs it, and nothing else — or record it in ADR-0056's accepted costs in the same
      words: `auth.$context.adapter` is a second unconstrained handle on `shortkit_auth`,
      importable from any file in the scanned tree, and the four scans do not see it. A fifth
      scan is cheap and is the same shape as the four; what must not happen is the spec
      continuing to claim it bounds "who may reach the shortkit_auth role" while this path is
      unnamed.

  - task: TASK-003
    source: sdlc-security-auditor
    round: 1
    severity: minor
    kind: design
    file: apps/api/src/auth/auth.config.ts
    line: 260
    summary: >-
      `GET /api/auth/get-session` returns the plaintext session token in the response body, so
      the `HttpOnly` flag in the cookie table protects nothing against same-origin script —
      and `bearer()`, added by this card, makes the exfiltrated value a complete credential.
    failure_scenario: >-
      EXECUTED. `GET /api/auth/get-session` with a session cookie answers
      `200 {"session":{"expiresAt":"…","token":"lCGHi3Sf2B6Ncm0Ddd7Y…",…},"user":{…}}`.
      `auth-tokens.md:50` lists that route as browser-reachable and notes it needs no
      `Origin`. An XSS anywhere on the origin that proxies it does
      `fetch('/api/auth/get-session', { credentials: 'include' })`, reads `session.token`, and
      holds a 604800-second credential that the `bearer` plugin accepts as
      `Authorization: Bearer <token>` from any client, which then mints JWTs at
      `GET /api/auth/token`. Cross-site reads are blocked — no CORS headers are configured —
      so the attacker needs script on the origin, which is why this is `minor` and not higher.
      What makes it worth a row is that `auth-config-surface.md`'s cookie table records
      `HttpOnly` as a decided value and this initiative has no artifact saying that the same
      credential is also handed out in a readable body.
    required_change: >-
      Record it in `auth-config-surface.md` beside the cookie table as an accepted cost, in
      those words, and give it an owner: either TASK-008's BFF strips `session.token` from any
      proxied `get-session` body, or the route is not proxied to the browser at all. The
      decision belongs in an artifact rather than in whichever card meets it first.

  - task: TASK-003
    source: sdlc-security-auditor
    round: 1
    severity: minor
    kind: behavior
    file: apps/api/src/auth/auth.config.ts
    line: 182
    summary: >-
      The audited basis for `level: 'warn'` covers better-auth's `warn` call sites only, and
      `'warn'` also passes `error` — where two call sites interpolate an unbounded,
      request-controlled string straight into the pino `msg`.
    failure_scenario: >-
      My own r1 basis for ADR-0060 was "no `warn` call site in 1.6.26 carries a value", and it
      is still true. Nobody extended it one band up. `origin-check.mjs` has
      `ctx.context.logger.error(`Invalid origin: ${originHeader}`)` and
      `ctx.context.logger.error(`Invalid ${label}: ${url}`)` for `callbackURL`, `redirectTo`,
      `errorCallbackURL` and `newUserCallbackURL`. EXECUTED against the composed instance with
      `NODE_ENV=production`:
      `{"level":"error",…,"code":"better_auth","msg":"Invalid origin: https://evil.test"}`.
      An unauthenticated attacker sends a request with any `Origin` header, or any
      `callbackURL` in the body, and writes a string of their choosing to the production log,
      once per request, bounded only by the header limit and by `authBodyCap` — which is
      TASK-004's and does not exist yet. pino JSON-escapes the message, so no line can be
      forged; the cost is log volume and a log that an attacker partly authors. It is also
      exactly the class ADR-0052's `args`-dropping rule exists for, arriving through the one
      channel that rule leaves open.
    required_change: >-
      Truncate `message` in the `log` hook to a fixed ceiling before it reaches pino, and
      extend ADR-0060's audited-basis paragraph to say that `'warn'` admits the `error` band
      too, naming those two call sites as the ones that carry request-controlled values. The
      basis sentence is the artifact a future upgrade re-reads; leaving it scoped to `warn`
      means the next reader re-audits the wrong half.

  - task: TASK-003
    source: sdlc-security-auditor
    round: 1
    severity: minor
    kind: behavior
    file: apps/api/src/main.ts
    line: 334
    summary: >-
      From wave 3 a boot refusal on any of the three auth bindings will NOT reach
      `bootstrap().catch`, so the claim in this comment, in ADR-0058 and in the contract that
      "the log line is identical either way" is false.
    failure_scenario: >-
      EXECUTED with wave 3's shape — a scratch `main` that statically imports
      `auth.config.ts` and registers the same `bootstrap().catch(...)`, run with
      `BETTER_AUTH_SECRET=''`. The accessor threw during module evaluation, the handler never
      ran, and the process printed a raw uncaught `AuthBindingError` stack to stderr and
      exited 1 — no pino line, no `boot_precondition`, no `service`/`env`/timestamp, and the
      refusal message crossed the boundary through Node's uncaught handler rather than through
      the one censoring mechanism ADR-0028 requires. The refusal still fails closed, which is
      why this is `minor`: what is lost is the labelled line, on the one boot precondition
      whose whole justification is that an operator must be able to tell which binding
      refused. `main.ts:113-125`'s "they throw the same `AuthBindingError`, which the handler
      below maps onto the same `boot_precondition`", `auth-config-surface.md:68-72` and
      ADR-0058 all state the opposite.
    required_change: >-
      Correct the claim in all three places, and give wave 3 the one-line shape that makes it
      true: TASK-004 reaches `auth.config.ts` through a dynamic `await import()` inside
      `bootstrap()`, after `assertBootPreconditions()`, rather than through a static import at
      module scope. That keeps the accessors' throw inside the handler and keeps the
      one-way import rule ADR-0058 established.

  - task: TASK-003
    source: sdlc-security-auditor
    round: 1
    severity: nit
    kind: implementation
    file: apps/api/.env.example
    line: 1
    summary: >-
      Two of the three `BETTER_AUTH_SECRET` refusals send the operator to a file that says
      nothing about `BETTER_AUTH_SECRET`.
    failure_scenario: >-
      `SECRET_UNSET` and `SECRET_TOO_SHORT` both end "See apps/api/.env.example and
      ADR-0051." The file this card creates carries `BETTER_AUTH_URL` and `WEB_APP_ORIGINS`
      and no mention of the secret, deliberately — TASK-009 owns the rest. So the operator
      most likely to be reading it is the one whose boot just refused on the one key it omits,
      and the remedy sentence is the part of a refusal that decides whether the next action is
      "generate a value" or "set `useSecureCookies: false`". The header also says "Copy to
      `apps/api/.env` … before `pnpm dev`", and nothing in `apps/api` loads a `.env` file —
      the "or read it and export what you need" clause is the only half that works.
    required_change: >-
      Either add a commented `BETTER_AUTH_SECRET=` block with the generation command and no
      value — the file already commits no credential and this would not be the first — or
      drop `apps/api/.env.example` from those two messages and point at ADR-0051 alone. Fix
      the copy-to-`.env` sentence in the same pass.
```

## What I attacked and could not break

Every design fact I was asked to verify by execution landed, and three of them were wrong in
the first shape they were written in, so this is not a formality.

- **`iss`/`aud` do not move with `Host`.** One session, two requests: `Host` of the API's own
  origin and `Host: evil.test` produced byte-identical claim sets, both
  `iss=aud="http://localhost:3001"`. **`exp - iat` is 300**, not `exp = 300`: the template
  literal is correct on a real minted token. Both are asserted in
  `signup-creates-tenant.int-spec.ts:254,298` — in the integration tier, which is the right
  tier for a minted token and is red until wave 3. I checked for their absence in the unit
  tier and found them present one tier up rather than missing.
- **The cookie follows the scheme, never `NODE_ENV`.** `https://app.example.com` →
  `__Secure-better-auth.session_token; … Secure`, all four cookies prefixed and `secure: true`.
  `http://localhost:3001` with `NODE_ENV=production` → no prefix, `secure: false`. The flag
  tracked the scheme in both directions and ignored `NODE_ENV` in both.
- **The loopback rule holds in both the accessor and the assertion**, and they agreed on all
  22 values I tried. Refused: `http://api.example.com`, `http://localhost.evil.test`,
  `http://127.0.0.1.evil.test`, `http://[::ffff:127.0.0.1]`, a path, a query, `ftp:`,
  `javascript:`, a bare `localhost:3001`. Accepted and correctly normalised:
  `http://2130706433`, `http://0177.0.0.1`, `http://127.1`, `HTTP://LOCALHOST:3001`,
  `http://user:pw@localhost:3001`.
- **The analogous narrowing for the origin wildcards landed.** `https://*.vercel.app` is
  refused by name; so are `*`, `https://*`, `https://?.example.com`, `https://shortkit-*.app`,
  `https://app.example.co?`, `*.example.com`, `https://a.b.*.example.com`.
  `https://shortkit-*.vercel.app` is admitted and, run through better-auth's own
  `matchesOriginPattern`, trusts only hosts ending `.vercel.app`. `https://ex*.co.uk` is
  admitted and trusts `https://exfil.co.uk` — the residual Juano parked in writing, not a new
  finding.
- **Signup residue is what ADR-0054 now says.** Success: `200`, `token: null`, **no
  `Set-Cookie`**, one user, one tenant, one membership. Duplicate address: `200`, the same key
  set, a **fresh** `id` and a **fresh** `createdAt`, and no second row anywhere — ADR-0061's
  convergence holds against the real drizzle adapter, as my r4 found. Provisioning failure,
  forced by revoking `INSERT ON tenants` from `shortkit_app` in the scratch database: `500`
  with the fixed body and code, **no `Set-Cookie`**, the `user` row surviving with zero
  memberships, and one `tenant_provisioning_failed` log line carrying a stack and no message,
  no email, no user id and no DSN.
- **AC-4's mint leg refuses correctly.** A user whose membership row I deleted got
  `403 {"code":"NO_TENANT_MEMBERSHIP"}` from `GET /token` and no token, while
  `GET /get-session` still answered 200 — exactly ADR-0055's two rows.
- **The revocation store.** TTL boundary exact: revoked at `t`, still revoked at
  `t+299.999s`, not revoked at `t+300s`. `revoke` resolved for `''`, `null`, `undefined`, a
  number and an object, and never rejected. The `session.delete.after` hook fires on a real
  sign-out and the minted token's `jti` is revoked immediately afterwards. The flush primitive
  is real and priced: 10,000 revocations inside the window drop a target entry, which is
  ADR-0053's stated cost coupled to TASK-004's limiter, not a new finding.
- **The four scans work for what they claim.** Three of five planted bypasses were caught, in
  the pattern ADR-0056's table predicts. Neither F-191 false positive fires: the anchored scan
  4 does not match the mandated `provider: 'pg'`, and the anchored scan 3 does not match
  `build-commit.ts:39`.
- **The `jwks` private key is stored encrypted** (hex ciphertext, not JWK JSON), so
  `disablePrivateKeyEncryption` being deliberately unset produced the intended default.
- **`logger[level]` cannot be handed a level pino lacks.** `@better-auth/core` maps `success`
  to `info` at the call site before the hook sees it, and at `'warn'` `success` is filtered
  anyway, so the four levels that reach the hook are all pino methods.

Two observations too small to file. `*://app.example.com` and `app*.example.com` clear both
wildcard rules and then trust the `http:` origin of the same host, because `wildcardHost`
strips the scheme before checking and better-auth matches a scheme-less pattern against the
host alone — an on-path attacker who can serve `http` on the dashboard's own host has already
won, so this is not worth a rule. And `tenants.name` is unbounded `text` written verbatim from
the signup body; the bound is `authBodyCap`, which is TASK-004's, so it is a wave-3
dependency rather than a gap here.

## Dependencies reviewed

None. The diff adds and bumps no dependency; `apps/api/package.json`, the root
`package.json` and the lockfile are unchanged. `better-auth` stays pinned at the exact
`1.6.26` every measurement above was taken against.
