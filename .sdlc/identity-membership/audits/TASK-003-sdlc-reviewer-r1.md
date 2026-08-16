# TASK-003 — code review, round 1

- **Reviewer:** `sdlc-reviewer`
- **Scope:** working tree against `HEAD` (`147d09e`). Five modified files, six new ones.
- **Excluded by dispatch:** F-200 (security-headers child boot), F-201 (`betterAuth<BetterAuthOptions>`).
- **Excluded as moving:** `apps/api/test/security/security-headers.int-spec.ts` (test architect, concurrent).
- **Not re-run:** unit 191/191, typecheck, lint, build — the implementer's report carries them.

```yaml
verdict: clear
findings:
  - severity: minor
    kind: behavior
    file: apps/api/src/auth/boot-assertions.ts
    line: 297
    summary: >
      `acceptedOrigin` routes every entry containing `*` or `?` down a branch that validates
      host labels only and returns the entry verbatim, so a wildcard entry is never checked
      for scheme, path, query, fragment or trailing slash the way a plain entry is.
    failure_scenario: >
      `WEB_APP_ORIGINS=https://shortkit-*.vercel.app/` — the documented preview form written
      with the trailing slash an address bar produces. Rule 1 and rule 2 both pass
      (`wildcardHost` strips at the first `/`), so boot succeeds and `trustedOrigins` carries
      the string with its trailing slash. `matchesOriginPattern`
      (`better-auth/dist/auth/trusted-origins.mjs:18-20`) then evaluates
      `wildcardMatch('https://shortkit-*.vercel.app/')(getOrigin(url))`, and `getOrigin` never
      returns a trailing slash — so no preview origin ever matches and every browser POST to
      `/api/auth/*` from a preview deployment answers `403 INVALID_ORIGIN`, with the boot
      assertion whose job is to catch bad entries having said nothing. Two neighbours in the
      same branch: `https://app.example.com/?next=1` is accepted because the `?` classifies it
      as a wildcard, bypassing the path/query/fragment refusal the plain branch applies at
      :306-319; and a scheme-less entry such as `shortkit-*.vercel.app` is accepted and matched
      by better-auth against the HOST alone, so `http:` and `https:` to that host are both
      trusted where the contract's table says entries are absolute origins.
    required_change: >
      A wildcard entry must be held to the same origin shape as a plain one — scheme present
      and `http:`/`https:`, no path, no query, no fragment, no trailing slash — with the
      wildcard permitted only inside the host (and, if intended, the port). Refuse anything
      else by name rather than passing it through verbatim. `auth-config-surface.md`'s wildcard
      section states rules 1 and 2 for the host; it does not license skipping the origin shape.

  - severity: minor
    kind: behavior
    file: apps/api/.env.example
    line: 3
    summary: >
      The header instructs a remedy that has no effect: nothing in this repository reads
      `apps/api/.env`, and there is no `pnpm dev` that starts the API.
    failure_scenario: >
      A developer runs the API, gets `BETTER_AUTH_URL is not set. … See apps/api/.env.example
      and ADR-0059`, opens the file, follows line 3 (`Copy to apps/api/.env … before pnpm
      dev`), copies it, and re-runs. The refusal is byte-identical. There is no `dotenv`
      dependency in `apps/api/package.json` or any workspace manifest, no `--env-file` in any
      script, and Node does not auto-load `.env`; `apps/api/package.json` declares
      `build/start/typecheck/test/test:integration/db:*` and no `dev`, and the root
      `package.json` declares no `dev` either — the only `dev` in the workspace is
      `apps/web`'s `next dev`, which starts the web app and reads nothing under `apps/api`.
      The second clause of the same sentence ("or read it and export what you need") does
      work, which is what makes the first one silently wrong rather than obviously wrong.
    required_change: >
      Either the copy-to-`.env` route is made real (an `--env-file=apps/api/.env` on an API
      dev/start script, or an explicit loader) or the header states export as the only route
      and drops the `pnpm dev` reference until a script by that name exists. ADR-0059:285-286
      carries the same claim and moves with whichever answer is taken.

  - severity: minor
    kind: behavior
    file: scripts/check-compose-stack.sh
    line: 188
    summary: >
      The diff adds two host-interpolated Compose variables; the compose check's contaminant
      list (:188) and its noisy-name list (:244) know about neither, so an exported value
      silently changes what `pnpm test:compose` measures.
    failure_scenario: >
      A developer with `export BETTER_AUTH_URL=https://staging.shortkit.app` in their shell
      runs `pnpm test:compose`. Compose interpolates it in place of the new default, the API
      boots with `advanced.useSecureCookies: true`, `__Secure-`-prefixed cookies and a
      different `iss`/`aud`, and the check reports green having measured a configuration that
      does not exist on "a machine with only Docker and a clone" — the exact substitution
      `NOISY_NAMES` exists to print a notice for (`GIT_COMMIT_SHA` is on that list for the
      same reason). Neither variable is credential-shaped, so the correct treatment is the
      notice, not the refusal.
    required_change: >
      `BETTER_AUTH_URL` and `WEB_APP_ORIGINS` join `NOISY_NAMES`. The script is outside
      TASK-003's `paths`, which were widened to two Compose entries and no more, so the
      implementer could not have made this edit — it needs an owner, not a rework of this card.
```

## Cannot verify from diff

- **AC-1, AC-3 and AC-4's mint leg.** `signup-creates-tenant.int-spec.ts` and
  `mint-refuses-without-membership.int-spec.ts` cannot run until TASK-004 mounts the handler,
  per Juano's ruling in the card. I read the code paths they cover and found nothing wrong;
  I cannot confirm behaviour without the mount.
- **`createTenantForNewUser`'s happy path.** `on-user-created.spec.ts` holds two tests, both on
  the failure path (propagation, GC-G message hygiene). Nothing green asserts that
  `tenants.name` is the operator-typed name verbatim, that the membership lands at
  `TENANT_ROLE.owner`, or that `withTenantTransaction` opens on the minted id. Reading the
  code, all three are correct. `signup-creates-tenant.int-spec.ts` covers them in wave 3.
- **The four caller-list scans against a wave-3 tree.** All four are correct and anchored as
  the card requires today (scan 3's bracket form carries a quoted literal key so
  `build-commit.ts:39` does not trip it; scan 4 anchors on `from`/`require(`/`import(` so
  `auth.config.ts`'s mandated `provider: 'pg'` does not trip it; scan 2 is
  `filter(...).toEqual([])` with the empty-read premise pinned by the fifth test). Whether they
  still hold once TASK-004 writes `DATABASE_AUTH_URL` into `main.ts` and `boot-assertions.ts`
  is a wave-3 question.

## Notes

Checked and found correct, listed because each is a trap the dispatch named and a later reader
should not have to re-derive:

- `expirationTime` is `` `${String(ACCESS_TOKEN_LIFETIME_SECONDS)}s` `` — a string.
  `toExpJWT` (`plugins/jwt/utils.mjs:15-19`) returns a number unchanged, so this is the one
  form that yields `iat + 300`. **Its only assertion is `signup-creates-tenant.int-spec.ts:264`,
  which is red by ruling this wave**, and `auth.config.spec.ts:76` declares `expirationTime` in
  its options type and never reads it — the shape of a half-written assertion. Not filed as a
  finding because the contract explicitly prefers the mint assertion over restating the option
  and the card pre-authorises the red tier; worth naming at the wave-3 implement gate, where
  that line turning green is the first and only proof.
- `definePayload` returns `jti`, `email`, `ev`, `tid` and no `sub`, and destructures
  `{ user, session }`, which matches `getJwtToken`'s `definePayload(ctx.context.session)`.
  Claim-shape coverage is also wave 3's (`signup-creates-tenant.int-spec.ts:254`).
- `advanced.useSecureCookies` derives from `baseUrl.startsWith('https://')` where `baseUrl` is
  `betterAuthUrl()`'s normalised origin. No `NODE_ENV` anywhere in the new files.
- The loopback rule is applied in both halves — one `acceptedUrl` predicate behind both
  `betterAuthUrl()` and `assertBetterAuthUrlConfigured`, so they cannot disagree.
- `revoke` prunes, then `delete`s, then `set`s, then evicts; never rejects; `''` writes nothing
  and logs `auth_revocation_degraded`; `isRevoked('')` resolves `false`. `pruneExpired`'s
  early return is sound because delete-before-set makes insertion order expiry order.
- `hooks.before` is one `createAuthMiddleware` iterating a module-level array created empty.
  Nothing assigns it.
- `auth.config.ts` sets neither password bound, and neither `requireEmailVerification` nor
  `jwks.disablePrivateKeyEncryption`.
- `createTenantForNewUser` writes `tenants.name` verbatim, opens `withTenantTransaction` on the
  minted id, inserts at `TENANT_ROLE.owner`, and adds no compensating delete. **Traced the
  failure path end to end rather than trusting the ADR:** the `create.after` hook is queued by
  `queueAfterTransactionHook`, `runWithTransaction` (`sign-up.mjs:143`) drains pending hooks
  *after* the write and rethrows, and `transaction: false` resolves to
  `createAsIsTransaction` rather than an undefined `adapter.transaction` — so the throw
  becomes `500 TENANT_PROVISIONING_FAILED` over a committed `user` row, which is ADR-0054's
  stated shape and not a 200.
- The `logger.log` hook is safe against `logger[level]`: `createLogger`
  (`@better-auth/core/dist/env/logger.mjs:68`) maps `success` to `info` before calling the
  hook and `shouldPublishLog` at `level: 'warn'` admits only `warn` and `error`, all of which
  pino has.
- The `membership === undefined` branch in `on-user-created.ts` is unreachable against the
  migrated policies (a filtered write raises `42501`). It is one documented branch with no
  behavioural cost; I am not asking for its removal, and it is the one place in this diff where
  a control that cannot fail is stated as such rather than believed to work.
