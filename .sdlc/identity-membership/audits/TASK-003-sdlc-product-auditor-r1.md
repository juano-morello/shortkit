verdict: clear

ac_verification:
  - id: AC-5
    status: met
    evidence: apps/api/src/auth/auth.config.spec.ts::"AC-5: rateLimit.enabled is exactly false, read without starting a server" — asserts `expect(options.rateLimit).toEqual({ enabled: false })`, whole-key equality (catches a half-restored limiter, not just `.enabled`). Config: apps/api/src/auth/auth.config.ts:198 `rateLimit: { enabled: false }`. Re-ran `pnpm --filter @shortkit/api exec vitest run src/auth src/db/better-auth-database-callers.spec.ts` myself: 6 files, 58 tests, all green. The "without starting a server" premise is independently measured in the spec's own header comment (pg.Pool opens no socket at import, `$context` resolves in 2ms, zero unhandledRejections in 500ms) rather than assumed — this is a real check, not a restated option.
  - id: AC-1
    status: untestable
    note: >-
      By ruling, correctly — the mount is TASK-004's and both auth routes 404 today, so
      test/auth/signup-creates-tenant.int-spec.ts cannot run. Reviewed the code path this
      wave ships against the AC and the integration test that will exercise it: databaseHooks
      .user.create.after -> createTenant -> createTenantForNewUser mints the tenant id, opens
      withTenantTransaction on it, writes tenants then tenant_memberships at TENANT_ROLE.owner,
      and only resolves after commit; the schema (tenants.id uuid, name text not null;
      tenant_memberships.id uuid default random) matches what the function writes and what the
      int-spec reads back. Found no defect that would fail this AC for a reason other than the
      missing mount.
  - id: AC-3
    status: untestable
    note: >-
      Same wave-boundary reason. definePayload returns exactly {jti: session.id, email,
      ev, tid} and never sub, matching the amended premise (sign-in only, autoSignIn: false
      confirmed at auth.config.ts:218). expirationTime is the corrected template-string form
      `${String(ACCESS_TOKEN_LIFETIME_SECONDS)}s` (auth.config.ts:245), so exp - iat resolves
      to 300 rather than the F-168 defect. baseURL/issuer/audience all read from the same
      betterAuthUrl() accessor, so iss/aud won't drift with a spoofed Host. No independent
      defect found against test/auth/signup-creates-tenant.int-spec.ts's claim-set assertion.
  - id: AC-4
    status: untestable
    note: >-
      Same wave-boundary reason. tenantIdForClaim wraps tenantIdForUser, catches
      NoTenantMembershipError specifically (not a bare catch), and raises `APIError('FORBIDDEN',
      {code: 'NO_TENANT_MEMBERSHIP', message: NO_TENANT_MEMBERSHIP_MESSAGE})` before
      definePayload returns, so no payload is ever signed for a membership-less user.
      Confirmed 'FORBIDDEN' maps to 403 in better-call@1.3.7's status table (dist/error.mjs:59),
      matching what test/auth/mint-refuses-without-membership.int-spec.ts expects
      ({status: 403, code: 'NO_TENANT_MEMBERSHIP'}). No independent defect found.

findings: []

## Shipped but not asked for

- `apps/api/src/auth/on-user-created.ts:74-83` — `createTenantForNewUser` throws when
  `tenant_memberships` `INSERT ... RETURNING` gives back no row. Neither the card's Approach
  section nor `auth-config-surface.md` asks for this branch; it's the implementer's own
  addition, disclosed in the implementation report as "one branch nothing asked for" and
  stated to be unreachable against the migrated policies (a filtered `WITH CHECK` write raises
  `42501` rather than returning empty). No test exercises it. Low cost — one unreachable branch,
  already flagged by the implementer for a reviewer to keep or cut — but it is behavior beyond
  the card as written, so recording it here rather than letting it pass silently as "the code
  looks fine."

## Out-of-scope items that got built

None found. The diff's file set is exactly TASK-003's declared `paths:` list (auth.config.ts,
on-user-created.ts, revocation-store.ts, auth.module.ts, app.module.ts, boot-assertions.ts,
main.ts, better-auth-database-callers.spec.ts [pre-existing, untouched], packages/contracts/src
/auth/index.ts, docker-compose.yml, apps/api/.env.example). The contracts package edit is
exactly the one docblock the card authorizes — the exported `ACCESS_TOKEN_LIFETIME_SECONDS`
value is unchanged (still `300`, a number), confirmed by diff. `docker-compose.yml` gained
exactly the two declared entries (`BETTER_AUTH_URL`, `WEB_APP_ORIGINS`), both with compose
defaults per ADR-0059; `BETTER_AUTH_SECRET` remains the file's only variable with no default.
`AuthModule` is empty and deliberately does not import `auth.config.ts` (avoids forcing every
`AppModule`-built unit test to require the auth bindings) — that's the card's own `Produces`
block, not scope creep. `apps/api/test/security/security-headers.int-spec.ts` shows as modified
in the working tree but per the dispatch this is `sdlc-test-architect`'s concurrent edit for
F-200, not part of this diff's authorship; I did not evaluate it.

## Notes

AC-5 is the only claimed AC actually verifiable this wave, and it is verified: a real,
whole-object assertion against the composed config, matching the exact value in
`design/contracts/auth-config-surface.md`'s table. AC-1, AC-3 and AC-4 are correctly marked
`untestable` rather than met or not-met — a vacuous-pass reading does not apply here, since
the integration tests exist, are wired to the right endpoints/assertions, and are red only
because the mount (TASK-004, wave 3) doesn't exist yet, not because they'd pass on an empty
set. Reading `auth.config.ts`, `on-user-created.ts`, `revocation-store.ts` and
`boot-assertions.ts` line by line against `auth-config-surface.md` and `revocation-store.md`
(both normative on conflict), I found every "silent" key from the contract's table present
with the correct value, and no discrepancy that would make wave 3's implement gate fail for a
second, hidden reason once the mount lands. `revocation-store.spec.ts`'s eviction-order and
delete-before-set assertions, and `boot-assertions.spec.ts`'s loopback-http-accepted /
non-loopback-http-refused pair, are real behavioral checks (re-ran them; verified they'd fail
without the corresponding code, by reading the implementation against each assertion) rather
than restatements. F-200 and F-201 are already filed and correctly routed; not re-filed here.
