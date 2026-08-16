# Design-mode security audit — identity-membership wave 2 (TASK-003), round 1

verdict: changes-requested

Every claim below marked **executed** was run against the pinned `better-auth@1.6.26` in
`node_modules` or against the live `shortkit_test` database in `shortkit-postgres-1`. Database
work was done inside `BEGIN … ROLLBACK` under `SET ROLE`, verified to leave zero rows; the
compose stack was found up and is left up. Library probes used better-auth's in-memory adapter
and touched no database. Probe scripts lived in `/tmp` and were deleted.

```yaml
findings:
  - task: TASK-003
    source: sdlc-security-auditor
    round: 1
    severity: major
    kind: design
    file: .sdlc/identity-membership/design/contracts/auth-config-surface.md
    line: 66
    summary: >-
      `baseURL` is absent from the config surface and `BETTER_AUTH_URL` is provisioned in no
      environment except the integration fixture, so `iss` and `aud` are taken from the
      request's Host header.
    failure_scenario: >-
      EXECUTED against 1.6.26. With `BETTER_AUTH_URL` unset, `create-context.mjs:63-86` sets
      `options.baseURL = ""`, and `auth/base.mjs:19-27` then re-derives the base URL per request
      from `getOrigin(request.url)` — i.e. the Host header. `sign.mjs:16-20` computes
      `defaultIss`/`defaultAud` from that value. One session, two requests: `GET /api/auth/token`
      with `Host: api.internal` returned a token with `iss="http://api.internal"`; the same
      cookie with `Host: evil.test` returned a token with `iss="http://evil.test"` and
      `aud="http://evil.test"` — same signature, same `kid`, same `tid`, both valid.
      `shortkitJwtClaimsContract` types `iss`/`aud` as `z.string().min(1)`, so an
      attacker-chosen issuer is a contract-conformant token. `BETTER_AUTH_URL` appears in
      `apps/api/test/support/auth-fixture.ts:85` and nowhere else — not in `docker-compose.yml`,
      not in `.env.example`, not in any ADR or card of this initiative. So the only tier that
      exercises the mount sets it and the developer stack does not: the suite is green on a
      configuration `pnpm dev` never runs.
    required_change: >-
      Pin the issuer and audience on the composed config rather than inheriting them from the
      request: add `jwt: { issuer, audience }` to the `jwt` plugin block of the config-surface
      table, fed by a declared binding, and state in the same table that `baseURL`/
      `BETTER_AUTH_URL` is a load-bearing key. Give `BETTER_AUTH_URL` an owner (an env-file entry
      plus a boot assertion beside `assertBetterAuthSecretConfigured`, which ADR-0058 already
      establishes the shape for). `auth.config.spec.ts` should assert a minted token's `iss` and
      `aud` equal the configured constant and do not change with the Host header.

  - task: TASK-003
    source: sdlc-security-auditor
    round: 1
    severity: major
    kind: design
    file: .sdlc/identity-membership/design/contracts/auth-config-surface.md
    line: 66
    summary: >-
      With `baseURL` unresolved the session cookie's `Secure` flag falls back to
      `NODE_ENV === 'production'`, and no artifact in this wave states a cookie attribute at all.
    failure_scenario: >-
      EXECUTED. `cookies/index.mjs:21` derives the secure flag as
      `advanced.useSecureCookies ?? (baseURLString ? baseURLString.startsWith('https://') :
      isProduction)`. With `BETTER_AUTH_URL` unset `baseURLString` is `""`, so the fallback is
      `NODE_ENV === 'production'`. The composed instance issued
      `better-auth.session_token=…; Max-Age=604800; Path=/; HttpOnly; SameSite=Lax` — no
      `Secure`, no `__Secure-` prefix — and a second cookie, `better-auth.session_data`, which no
      contract in this initiative mentions. An attacker on any network path between a client and
      the API reads the session token off a plaintext request; the same value is a full
      credential through the `bearer` plugin, which mints JWTs from it. The trigger is silent and
      environment-dependent: a deploy that terminates TLS at a proxy and speaks http inward, or
      one where `NODE_ENV` is anything but exactly `production`, gets a non-Secure session cookie
      with nothing failing.
    required_change: >-
      State the cookie attributes in the config-surface table and fix them explicitly rather than
      deriving them: `advanced.useSecureCookies` (or a resolved `baseURL`) so `Secure` does not
      depend on `NODE_ENV`, and record `httpOnly`/`sameSite`/`maxAge` as decided values.
      `auth.config.spec.ts` should assert the session cookie's attributes off `$context.authCookies`,
      which is the same silent-fact class as the other five it already asserts.

  - task: TASK-003
    source: sdlc-security-auditor
    round: 1
    severity: major
    kind: design
    file: .sdlc/identity-membership/design/contracts/auth-config-surface.md
    line: 70
    summary: >-
      `logger.level: 'error'` discards every `warn` from the dependency, including the one line
      that reports the misconfiguration in the two findings above.
    failure_scenario: >-
      EXECUTED. `create-context.mjs:64` emits
      `logger.warn('[better-auth] Base URL is not set … Without it the origin is derived from the
      incoming request')` when `baseURL` does not resolve. Composed with the exact logger the
      contract mandates, the bound `log` hook received **zero** lines: the warning was filtered at
      the source by `level: 'error'`. The same filter drops `secret-utils.mjs:40-41` (short and
      low-entropy secret), `rate-limiter/index.mjs:284` (cannot determine a client IP, which is
      the control TASK-004 depends on), and `internal-adapter.mjs:698`. The stated reason for
      `'error'` is `sign-up.mjs:168`'s "Sign-up attempt for existing email: ${email}" — read at
      the source, that call is `logger.info`, not `logger.warn`. `'warn'` suppresses it just as
      completely. I read every `logger.warn` call site in `dist/`: none interpolates an email,
      token, password or user id into the message, and ADR-0052's hook drops positional `args`,
      so the structured second arguments (`{ providerId }`, a caught error) never reach the line
      either. The stated goal is met at `'warn'` and the security-relevant warnings survive.
    required_change: >-
      Change the fixed value to `level: 'warn'` in the config-surface table and in ADR-0052, and
      state the audited basis: the PII line is `info`, and no `warn` call site in 1.6.26 carries a
      value. Keep the spec's assertion on the level, at the new value.

  - task: TASK-003
    source: sdlc-security-auditor
    round: 1
    severity: major
    kind: design
    file: .sdlc/identity-membership/design/adr-0056-better-auth-database-caller-list-is-asserted-in-wave-2.md
    line: 133
    summary: >-
      The caller-list control bounds one identifier, not access to the auth role; and the
      capability it bounds is larger than the ADR's accepted-cost section says.
    failure_scenario: >-
      Two gaps, both executed. (1) `DATABASE_AUTH_URL` is in the API process environment
      (`docker-compose.yml`), so any file under `apps/api/src` reaches the same role with
      `new pg.Pool({ connectionString: process.env.DATABASE_AUTH_URL })` and never writes the
      string `betterAuthDatabase`. The equality scan passes. ADR-0056 names the `test/**` and
      `scripts/**` residual and does not name this one, which needs no unscanned directory at
      all. (2) The capability is priced as reading "plaintext session tokens and password
      hashes". Measured on the migrated schema as `shortkit_auth`, in a rolled-back transaction:
      `INSERT INTO session (id, expires_at, token, created_at, updated_at, user_id) VALUES (…,
      'attacker-chosen-token', …, <another user's id>)` **succeeded** — the five tables carry no
      RLS (`relrowsecurity = false`, confirmed), so the handle also forges a session for any user,
      which is account takeover rather than disclosure. It also reads `jwks.private_key`, and
      `process.env.BETTER_AUTH_SECRET` is in the same process, so the holder decrypts the JWT
      signing key and mints any `tid` for any user. ADR-0057's closing claim — "the row is
      useless without the secret and the secret is useless without the row" — holds against a
      database-only adversary and does not hold against anything running in the API process,
      where both factors are in scope simultaneously. ADR-0057 states it unqualified and uses it
      to reject `disablePrivateKeyEncryption`.
    required_change: >-
      Add both to ADR-0056's accepted costs, in the words above: the control bounds an
      identifier, not the role, and `process.env.DATABASE_AUTH_URL` plus `pg.Pool` is a bypass
      inside the scanned tree. Restate the capability as read-and-write on five unprotected
      tables — forged session insert, password-hash rewrite, `jwks.private_key` read — not as
      read-only exposure. Qualify ADR-0057's two-factor sentence to name the adversary it holds
      against.

  - task: TASK-003
    source: sdlc-security-auditor
    round: 1
    severity: minor
    kind: design
    file: .sdlc/identity-membership/design/adr-0053-revocation-store-is-process-local.md
    line: 161
    summary: >-
      Eviction is priced as a capacity accident and is attacker-influenced, and insertion-order
      eviction drops the most recently re-revoked session first.
    failure_scenario: >-
      Two things in one accepted cost. (a) "Above 10,000 live entries the oldest is dropped"
      describes a load condition, but the entries are written by an attacker-reachable path:
      every session deletion writes one, and sign-in/sign-out is that path. An attacker holding a
      stolen token whose session has just been revoked can, in principle, flush the victim's
      entry by driving 10,000 session deletions inside the 300-second window and have the stolen
      token honoured again. TASK-004's IP-keyed limiter makes that expensive, which is the reason
      this is `minor` rather than `major` — but the ADR should say that eviction is a
      control-bypass primitive whose cost is set by a limiter in another card, not a memory
      accident. (b) The stated reason eviction is "the least bad choice available" — "the oldest
      is the closest to expiry" — is false for a re-revoked session. `Map.set` on an existing key
      keeps the original insertion position, and invariant 4 makes `revoke` idempotent with a
      refreshed TTL, so a session revoked twice has the newest expiry and the oldest position and
      is evicted first.
    required_change: >-
      Say in the ADR that the write path is attacker-reachable and that its cost is bounded by
      TASK-004's limiter, naming the coupling. Require the implementation to `delete` before
      `set` in `revoke` so insertion order tracks the current expiry, and have
      `revocation-store.spec.ts` assert that a re-revoked entry is not the first evicted.

  - task: TASK-003
    source: sdlc-security-auditor
    round: 1
    severity: minor
    kind: design
    file: .sdlc/identity-membership/design/adr-0054-signup-residue-repriced-across-two-roles.md
    line: 66
    summary: >-
      The residue table is wrong in two measurable ways: the session is 7 days, not 30, and the
      500 response carries the session cookie.
    failure_scenario: >-
      EXECUTED with the exact hook shape ADR-0054 decides — `databaseHooks.user.create.after`
      throwing `APIError('INTERNAL_SERVER_ERROR', { code: 'TENANT_PROVISIONING_FAILED' })`. The
      response was `500` with the intended body **and** a `Set-Cookie` header carrying a live
      `better-auth.session_token` plus an encrypted `better-auth.session_data`, both
      `Max-Age=604800`, neither `Secure`. The `user`, `account` and `session` rows all survived.
      So the caller is handed the credential in the same response that tells it the account is
      unusable — ADR-0054 says the browser holds a credential and does not say the error response
      is what delivers it, which matters because a client that treats a 500 as "nothing
      happened" still ends up authenticated. Separately, `sessionConfig.expiresIn` resolves to
      `604800` (7 days) — the library default, and nothing in the config surface sets it — so
      "a live 30-day session credential", stated twice, is off by 4x. `auth-tokens.md`'s cookie
      table gives `sk_rt` a 2592000-second max-age, which outlives the credential behind it by
      23 days.
    required_change: >-
      Correct the residue table to 7 days and add the `Set-Cookie`-on-500 fact. Put
      `session.expiresIn` in the config-surface table as a decided value rather than an inherited
      default, and reconcile it with `sk_rt`'s max-age.

  - task: TASK-003
    source: sdlc-security-auditor
    round: 1
    severity: minor
    kind: design
    file: .sdlc/identity-membership/design/contracts/auth-config-surface.md
    line: 78
    summary: >-
      Sign-up is an unauthenticated user-enumeration oracle and no ADR records it as a decision.
    failure_scenario: >-
      `sign-up.mjs:162` computes `shouldReturnGenericDuplicateResponse` from
      `emailAndPassword.requireEmailVerification || autoSignIn === false`. Neither is set by this
      design and email verification is explicitly out of scope, so the generic-response branch is
      off and a duplicate address answers `422 USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL` while a
      fresh one answers 200. An unauthenticated attacker tests an address list against
      `POST /api/auth/sign-up/email` and learns who has an account. `rateLimit: { enabled: false }`
      removes the library's own brake in this card and the replacement is IP-keyed and lands in
      TASK-004. ADR-0054 mentions the 422 as an inconvenience for the burned address and never as
      a disclosure.
    required_change: >-
      Record the enumeration property as an accepted cost with its mitigation named
      (`requireEmailVerification`, or `onExistingUserSignUp` with the generic response), so the
      next reader finds a decision rather than an omission. Add `emailAndPassword.autoSignIn` and
      `requireEmailVerification` to the config-surface table as deliberate values.

  - task: TASK-003
    source: sdlc-security-auditor
    round: 1
    severity: minor
    kind: design
    file: .sdlc/identity-membership/design/contracts/auth-config-surface.md
    line: 215
    summary: >-
      `trustedOrigins` is the CSRF control for the whole auth surface and no card owns it; the
      pressure-fix for its loud failure is a wildcard that nothing rejects.
    failure_scenario: >-
      Conflict 2 in this contract is correct and under-weighted. `WEB_APP_ORIGINS` occurs in no
      env file, no compose file and no card's `paths`; the contract assigns the obligation to
      TASK-003 "by elimination". The failure is loud — EXECUTED: `Host: api.internal` with
      `Origin: https://evil.test` and a cookie returned `403 INVALID_ORIGIN`, so browser CSRF is
      genuinely blocked and this is not a bypass today. The risk is the remedy. An implementer
      meeting a 403 on every local login reaches for the value that clears it, and
      `matchesOriginPattern` honours `*` as a bare host wildcard, which trusts every origin on
      the internet with no error anywhere.
    required_change: >-
      Give `WEB_APP_ORIGINS` an owner and an entry in the env files in this wave. Have the
      `trustedOrigins` unit test assert both directions: every configured origin is present, and
      no entry is `*` or a pattern whose host part is a bare wildcard.
```

## Notes

**What I attacked and could not break.** Browser CSRF on the auth surface holds even with
`baseURL` unresolved: the origin check compares `Origin` against the request's own origin, and a
browser cannot forge `Host`, so the cross-site case still answers `403 INVALID_ORIGIN` (executed).
The `bearer` plugin verifies the session-token HMAC with the configured secret before installing
it as a cookie, and the token itself is a high-entropy database value, so the absent
`requireSignature` costs nothing here. `rateLimit.enabled === false` was confirmed on the composed
context, and the mount plus its replacement limiter land together in TASK-004, so wave 2 opens no
window of its own. `definePayload` behaves exactly as the card and ADR-0055 describe: `jti` is
carried, `sub` is overwritten by the signer, `tid` survives.

**ADR-0056's escalation on the type widening is correct but priced too high, in one direction.**
`client.ts:259` does return `NodePgDatabase<typeof schema>` and ADR-0046's promised compile error
does not exist. But the runtime consequence is not a silent cross-tenant read: measured as
`shortkit_auth` against the migrated schema, `SELECT count(*) FROM tenants` and
`FROM tenant_memberships` both answer `permission denied for table …`. The revoke was not
symmetric and did not need to be — `shortkit_auth` never received a default privilege, so it holds
DML on exactly the five auth tables and nothing else (verified by enumerating
`role_table_grants`). The absent narrowing is a missing compile-time guard over a path the
database refuses anyway; the reach that actually matters is the five unprotected tables, which is
the finding filed above. Worth saying so before someone spends a blocker on the type.

**`jwt.expirationTime` confirmed.** `expirationTime: 300` produced `exp = 300`, i.e.
1970-01-01T00:05:00Z, on a real minted token. The config-surface contract's correction to
`` `${ACCESS_TOKEN_LIFETIME_SECONDS}s` `` is right and the three artifacts still instructing the
number form are still wrong. Not filed as a security finding — it fails closed — but it is now
measured rather than argued.

**ADR-0058, ADR-0053's port asymmetry, and ADR-0055's `APIError` rule I found no fault with.**
The three-rejection count is correct against the tree (the compose literal is gone). The
`boot-assertions.ts` → `auth.config.ts` one-way import rule is real and correctly reasoned; the
module-scope throw does beat the assertion in wave 3, and the shared error class is the right
answer. `revoke` never rejecting while `isRevoked` may is the correct asymmetry and the contract
states it enough times.
