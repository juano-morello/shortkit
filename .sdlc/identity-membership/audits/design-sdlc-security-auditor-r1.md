# Design-mode security audit — identity-membership, wave 1, round 1

- **Mode:** design. ADRs 0043–0049, three contracts, six stubs, and the two foundation
  contracts this wave amends. No code exists for this wave.
- **Method:** artifacts read against the shipped code they touch, then the policy set built
  and attacked in a scratch database (`audit_f020`, created and dropped; the `shortkit`
  application database was not touched). The pinned `better-auth@1.6.26` was read from
  `apps/api/node_modules` and one claim was confirmed by executing it.
- **Finding id range used:** F-020 … F-027.

```yaml
verdict: changes-requested
findings:
  - id: F-020
    severity: blocker
    kind: security
    claim_type: concrete runtime failure
    file: .sdlc/identity-membership/tasks/TASK-003.md
    line: 55
    summary: >-
      NOTHING IN THIS REPOSITORY BINDS `BETTER_AUTH_SECRET`, AND better-auth@1.6.26 FALLS
      BACK TO A PUBLISHED CONSTANT WITHOUT THROWING OR WARNING OUTSIDE PRODUCTION. Seven
      new ADRs, three contracts, seventeen TASK cards and ADR-0013 mention the variable
      only descriptively (ADR-0044 line 34, auth-schema.md line 102). No GC-B binding, no
      boot assertion, no `secret:` key in the composed config, no unit test.
    failure_scenario: >-
      `dist/context/create-context.mjs:70,78-80`:
      `legacySecret = options.secret || env.BETTER_AUTH_SECRET || env.AUTH_SECRET || ""`
      then `secret = legacySecret || "better-auth-secret-12345678901234567890"`.
      `validateSecret` (`:38-45`) returns immediately under `isTest()`, throws on the
      default value ONLY under `isProduction`, and the length and entropy warnings do not
      fire for the 39-character default. So in development and in the test tier — the only
      two environments that exist (ADR-0030) — the process boots on a constant published in
      the package, silently. EXECUTED, not read:
      `NODE_ENV=development node -e "betterAuth({baseURL:...}).$context"` with the variable
      unset returns `ctx.secret === "better-auth-secret-12345678901234567890"` and does not
      throw. That secret is the symmetric key for `jwks.privateKey`
      (`plugins/jwt/sign.mjs:34-39`, `symmetricDecrypt({ key: ctx.context.secretConfig })`).
      Attacker: anyone who obtains one `jwks` row — a database dump, a CI artifact, the
      `shortkit_app` DSN, or any of the SQL defects ADR-0044 accepts as its cost, since
      `jwks` carries no RLS and `shortkit_app` holds SELECT on it. They decrypt the JWT
      signing private key with a constant they already have and mint tokens with arbitrary
      `sub` and `tid`. Every downstream control in this initiative — the `tid` claim, the
      mint-time membership lookup, `app.tenant_id`, every RLS policy — is derived from a
      token that can now be forged for any user in any tenant. ADR-0044's line 104-105
      states the residual risk as "a process that can read the row can usually also read
      `process.env.BETTER_AUTH_SECRET`"; that sentence assumes the variable is set.
    required_change: >-
      Decide the binding in this wave rather than discovering it in wave 2. `BETTER_AUTH_SECRET`
      becomes a GC-B declared binding with a boot assertion in
      `apps/api/src/auth/boot-assertions.ts` (already TASK-004's file, which today asserts
      only `BFF_PROXY_SECRET`), TASK-003 passes `secret` explicitly into `betterAuth({...})`
      from that binding rather than letting the env lookup happen inside the library, and
      `auth.config.spec.ts` asserts the composed config carries a secret that is not the
      default — the same shape ADR-0013 already requires for `rateLimit.enabled === false`
      and for the same reason: it is the fact that degrades silently. Note in the ADR that
      `isTest()` skips validation entirely, so no test tier will ever catch this.

  - id: F-021
    severity: major
    kind: security
    claim_type: concrete runtime failure, conditional on a data state nothing constrains
    file: .sdlc/identity-membership/design/contracts/tenant-membership-lookup.md
    line: 56
    summary: >-
      `membershipLookupPolicy()` COMPARES A CONTEXT FLAG AS TEXT AND RELIES ON "NO `user`
      ROW HAS id ''" — A DATA PROPERTY, ASSERTED AS IF IT WERE A CONSTRAINT. ADR-0049's own
      Consequences name this hazard class ("a future text flag whose empty value is
      meaningful would be a fail-open with no cast to catch it", line 174-178) without
      noticing that ADR-0045, in the same commit, ships the first instance of it.
    failure_scenario: >-
      Built and measured in the scratch database, with `tenantScopedPolicies()` in the
      ADR-0049 `nullif` form and `membershipLookupPolicy()` verbatim. A transaction-local
      `set_config` leaves `app.membership_lookup_user` at `''` on every backend that has
      served one token mint, exactly as ADR-0049 established for `app.tenant_id`. With one
      `"user"` row whose `id` is `''` and one `tenant_memberships` row referencing it,
      as `shortkit_app` on a warm connection:
        - `SELECT tenant_id, user_id FROM tenant_memberships` with NO flag set at all
          returned that row. That falsifies invariant 1 of `rls-policy-template.md` — the
          invariant THIS WAVE amended in this round to read "affects zero rows — and returns
          rather than raising, on a reused pooled connection as well as a fresh one".
        - inside tenant A's ordinary `withTenantTransaction`, the same statement returned
          two rows: A's own, and the `''` row belonging to tenant B — `tenant_id`, `user_id`
          and `role` of a foreign tenant, through the permissive OR.
      `user.id` is `text PRIMARY KEY` with no CHECK and no non-empty constraint, in a table
      `shortkit_app` holds INSERT and UPDATE on (F-239, ADR-0044). I confirmed the row is
      NOT reachable through the sign-up route today — `dist/api/routes/sign-up.mjs:147,165`
      destructures `...rest` through `parseUserInput`, which drops `id`, and
      `ctx.context.generateId({model:'user'}) || generateId()` supplies it — so this is
      latent rather than live. It is one INSERT, one custom `advanced.database.generateId`,
      or one item-1b invitation-acceptance path away, and no test, control or constraint
      stands between here and there.
    required_change: >-
      Wrap the lookup flag the same way the cast flags are wrapped, in `membershipLookupPolicy()`
      in `rls.ts`, in `tenant-membership-lookup.md`'s normative SQL, and in ADR-0045:
      `USING (user_id = nullif(current_setting('app.membership_lookup_user', true), ''))`.
      Verified in the scratch database: the out-of-context read returns zero rows with the
      `''` row present, tenant A sees only its own row, the warm mint still resolves, and the
      plan is still `Index Scan using tenant_memberships_user_unique`. Widen ADR-0049's
      decision sentence from "every CAST of a context flag" to "every COMPARISON against a
      context flag", since the cast is not what makes `''` dangerous.

  - id: F-022
    severity: major
    kind: security
    claim_type: concrete runtime failure of a normative control
    file: .sdlc/identity-membership/design/adr-0049-context-flags-are-never-cast-directly.md
    line: 118
    summary: >-
      ADR-0049'S CAST CONTROL — "the mechanism the class needs... the control is what stops
      the fifth" — PASSES TWO POLICY FORMS THAT STILL RAISE `22P02` ON A WARM CONNECTION.
      The regex tests for a syntactic shape ("no cast applied directly to
      `current_setting`") which is a proxy for the property that matters ("the empty string
      never reaches a uuid cast"), and the proxy is not tight.
    failure_scenario: >-
      Four policy variants installed in the scratch database and their `pg_policies.qual`
      renderings run against ADR-0049's own predicate `/\(current_setting\([^)]*\)\)::/`.
      Warm-connection out-of-context read, as `shortkit_app`:
        | policy USING clause                                              | raises 22P02 | regex flags it |
        | current_setting(...)::uuid                                       | yes          | YES            |
        | CAST(current_setting(...) AS uuid)                               | yes          | YES            |
        | nullif(current_setting(...), 'x')::uuid                          | yes          | NO             |
        | (current_setting(...) || '')::uuid                               | yes          | NO             |
        | nullif(current_setting(...), '')::uuid  (the ADR-0049 form)      | no           | NO  (correct)  |
      The third row is the realistic one: a hand-appended migration — which ADR-0049 says is
      "the only way policy DDL enters this system" — copies the repaired pattern with a
      wrong sentinel. `pnpm db:check-policies` prints green, and the defect reappears as a
      `22P02` on the one path this product must never 5xx on (the redirect read) or on the
      token mint, on a warm backend only, which is the state no fixture creates
      (`rls-fixture.ts` seeds through the migrator DSN — F-004's own point). Attacker: not
      an external one. This is a control that will report a policy set as repaired when it
      is not, and the round that produced ADR-0049 exists because a policy claim was
      verified against the policy set and never against a statement issued under it. This is
      the same shape, one level up, inside the fix.
    required_change: >-
      Either tighten the predicate so it matches the decision — require that every
      `current_setting` reference reaching a cast is wrapped in `NULLIF(..., ''::text)`
      exactly, i.e. assert the safe form is PRESENT rather than asserting an unsafe form is
      absent — or, better, add a behavioural control beside it: for every policy in schema
      `public`, on a connection that has committed one transaction-local `set_config` of
      each declared flag, issue a no-context `SELECT` and require zero rows rather than a
      raise. That control cannot be evaded by rendering, and it is what F-004 already
      established the test tier must do. Record in ADR-0049 that a syntactic control over
      `pg_policies` is a proxy and which forms it does not see.

  - id: F-023
    severity: major
    kind: security
    claim_type: concrete runtime behaviour of a dependency this wave mounts
    file: .sdlc/identity-membership/tasks/TASK-003.md
    line: 55
    summary: >-
      BETTER AUTH SHIPS ITS OWN LOGGER, WRITING UNSTRUCTURED LINES THROUGH `console.error`
      AND `console.warn`, AND NO ARTIFACT IN THIS WAVE — OR ANYWHERE IN THE REPOSITORY —
      DECIDES ANYTHING ABOUT IT. That is the exact channel `no-console` and the
      `@nestjs/common` `Logger`/`ConsoleLogger` restriction in `eslint.config.mjs:97-124`
      exist to forbid under `apps/api/src`, and it arrives inside `node_modules` where
      neither rule reaches.
    failure_scenario: >-
      `@better-auth/core/dist/env/logger.mjs:55-69`: default level `warn`, no `options.log`
      hook, so `error` goes to `console.error` and `warn` to `console.warn`, formatted as
      `${ISO} ${LEVEL} [Better Auth]: ${message}` with ANSI colour when a TTY is detected.
      None of it passes through pino, `LOGGABLE_FIELDS`, `serializers.err` or
      `formatters.log`. Two reachable consequences:
        1. `dist/api/middlewares/origin-check.mjs:110`:
           `ctx.context.logger.error(\`Invalid origin: ${originHeader}\`)` where
           `originHeader = headers.get("origin") || headers.get("referer")`. Attacker: any
           unauthenticated caller. They POST to `/api/auth/sign-in/email` with any `Cookie:`
           header and a `Referer:` of up to Node's 16 KB header limit; the bytes land raw on
           the process's log stream, in a line no field allowlist ever sees. This is F-108's
           class (unbounded caller-controlled bytes in the log store, which the repository
           already refused to solve with truncation) reaching the store by a route ADR-0028's
           single censoring mechanism does not cover. CR/LF is rejected by Node's header
           parser, so this is pollution and allowlist bypass, not record forgery.
        2. `dist/api/routes/sign-up.mjs:168`:
           `ctx.context.logger.info(\`Sign-up attempt for existing email: ${email}\`)`. This
           is suppressed at the default `warn` level — and is one config key from being live.
           `logger: { level: 'info' }` is a plausible developer-friendliness choice with no
           rule anywhere against it, and it puts an email address on the log line, which is
           the single field GC-G names by name as forbidden. GC-G is enforced by an allowlist
           that this channel does not consult.
      There is no lint rule, no contract clause and no TASK card obligation covering it.
    required_change: >-
      TASK-003 states `logger` on the composed config, with the reason, and
      `auth.config.spec.ts` asserts it — same shape and same argument as
      `rateLimit.enabled === false`. `createLogger` honours `options.log`, so the two
      defensible choices are `{ disabled: true }` or a `log` hook that forwards into the
      shared pino instance under `msg` with a constant context string. Record in an ADR (or
      as an amendment to ADR-0013) that a dependency mounted into this process is a second
      log channel and that ADR-0028's "there is exactly one censoring mechanism,
      deliberately" is otherwise false from the moment Better Auth mounts.

  - id: F-024
    severity: major
    kind: documentation
    claim_type: documentation gap — a measured understatement of an accepted cost
    file: .sdlc/identity-membership/design/adr-0044-better-auth-tables-carry-no-rls.md
    line: 94
    summary: >-
      ADR-0044 PRICES ITS ACCEPTED COST IN READS ONLY. The Negative section says "any SQL
      defect anywhere in `apps/api` READS every session token, every password hash and every
      email address"; all three "What would force the role split" triggers are read-shaped
      ("a raw-SQL surface that takes caller input — a search endpoint, a reporting query");
      and the table at lines 29-35 is headed "What reading one row gives an attacker". The
      Context paragraph does say "readable and writable", and then the decision is priced
      against the read half alone. The write half is a strictly larger blast radius and it
      is what `ALTER DEFAULT PRIVILEGES` actually grants.
    failure_scenario: >-
      Measured in the scratch database, as `shortkit_app`, from inside a perfectly ordinary
      `withTenantTransaction` for tenant A with `app.tenant_id` set correctly:
        - `UPDATE "account" SET password='...' WHERE user_id='user-b'` → `UPDATE 1`.
          Password reset for a user in another tenant, with no mail, no token, no old
          password.
        - `INSERT INTO "session" (id,expires_at,token,...,user_id) VALUES
          ('forged', now()+'30 days', 'ATTACKER-CHOSEN-TOKEN', ..., 'user-b')` → `INSERT 0 1`.
          A session credential of the attacker's choosing, for another tenant's user,
          without ever knowing their password. `session.token` is the credential in
          plaintext (ADR-0044's own table).
        - `UPDATE "user" SET email='attacker@evil.test' WHERE id='user-b'` → `UPDATE 1`.
        - and, for contrast, in the same transaction:
          `SELECT count(*) FROM tenants WHERE id='<tenant B>'` → `0`. RLS held on the
          product table and nothing held on the auth tables.
      The premise is the same one the ADR already accepts (a SQL defect in `apps/api`), so
      this changes no probability. It changes the consequence from disclosure of every
      credential to silent takeover of every account, and none of the three stated triggers
      for the role split describes a write path. The row-split alternative is recorded as
      "the mitigation that exists and is not taken" — a reviewer approving that trade at the
      gate is entitled to see what it actually covers.
    required_change: >-
      Rewrite the Negative bullet and the trigger list against writes as well as reads:
      "any SQL defect anywhere in `apps/api` reads AND WRITES every session token, every
      password hash and every email address", and add a trigger for "any code path that
      issues DML against `user`, `session` or `account` outside Better Auth's own adapter"
      — which `privilegedTenantEraser` (ADR-0044's own line 111-113) already is, and which
      the current triggers do not name. State whether a per-table `REVOKE INSERT, UPDATE,
      DELETE ON session, account FROM shortkit_app` in migration `0001` is cheaper than the
      full role split it already rejected; Better Auth writes those tables as
      `shortkit_app`, so it probably is not, but the ADR should say so rather than leave the
      write half unconsidered.

  - id: F-025
    severity: major
    kind: documentation
    claim_type: documentation gap — a factual error about which controls execute
    file: .sdlc/identity-membership/design/adr-0045-token-mint-membership-lookup.md
    line: 196
    summary: >-
      ADR-0045 JUSTIFIES WIDENING THE POLICY SET ON THE TABLE THAT MAPS USERS TO TENANTS
      WITH "Four controls, THREE OF WHICH ALREADY EXIST". None of the four executes today,
      and the ADR separately understates what happens if they fail.
    failure_scenario: >-
      Checked against the shipped test tier:
        - Control 1 (clause A1, the flag is set in exactly one file):
          `CONTEXT_FLAG_OWNERS` is exported at `apps/api/test/isolation/coverage.ts:1718`
          and has NO consumer anywhere in `apps/api`. Nothing reads it, nothing greps.
        - Control 2 (clause A2, the string appears in exactly `rls.ts` and the setter): no
          test in the repository reads a source file for a flag string. The only
          `readFileSync` calls under `test/isolation/` are the `report.json` captures at
          `cross-tenant-isolation.int-spec.ts:205,1191,1235`.
        - Control 3 (the `databaseTransaction` file list): `tenant-context.md` says in its
          own text "TASK-056 asserts it". TASK-056 is deferred.
        - Control 4 (`withMembershipLookup` imported by exactly one file): ADR-0045 already
          says this one is TASK-056's.
      So the only mechanism that runs is `expect(ISOLATION_EXCLUSIONS).toHaveLength(2)` at
      `cross-tenant-isolation.int-spec.ts:1364`, which counts DECLARED exclusions and cannot
      detect an undeclared one. The ADR is honest about control 4 and about "there is no
      runtime guard"; the sentence a gate reviewer weighs — "three of which already exist" —
      is the one that is wrong.
      And the consequence if they fail is worse than stated. ADR-0045 line 264-267 says "if
      the file-level control ever fails, the leak is a routing identifier rather than tenant
      data". That is true in one direction only. Measured: in a transaction where BOTH
      `app.tenant_id` (tenant A) and `app.membership_lookup_user` (tenant B's user) are set,
      `SELECT tenant_id, user_id, role FROM tenant_memberships` returned two rows — A's own
      and tenant B's complete membership row. PostgreSQL ORs permissive policies and the
      `FOR SELECT` policy is permissive, so a second setter of the lookup flag anywhere in
      a request path is a cross-tenant read of tenant data, not of a routing identifier.
      (Verified in the same run that the `FOR SELECT` policy does NOT widen `UPDATE` or
      `DELETE`: both returned 0 rows under the same two flags. ADR-0045's "FOR SELECT and it
      stays FOR SELECT" is materially correct, and `SET TRANSACTION READ ONLY` does block a
      write to the RLS-exempt auth tables — `ERROR: cannot execute UPDATE in a read-only
      transaction`. Both claims stand.)
    required_change: >-
      Correct "three of which already exist" to name what executes today (the
      `ISOLATION_EXCLUSIONS` length assertion, and nothing else) and what is TASK-056's, and
      correct the "routing identifier rather than tenant data" sentence with the measured
      two-flag result. Then decide, in the ADR, whether wave 1 ships any executing control
      for the lookup flag at all — the cheapest honest one is a unit assertion that
      `CONTEXT_FLAG_OWNERS` is consumed by a grep over `apps/api/src/**/*.ts` for
      `set_config(` first arguments, which is clause A1 as a live test rather than a
      declaration, and which does not need TASK-056.

  - id: F-026
    severity: minor
    kind: documentation
    claim_type: documentation gap
    file: .sdlc/foundation/design/contracts/tenant-context.md
    line: 397
    summary: >-
      THE "Reach" COLUMN OF THE Deliberate exclusions TABLE — THE ONE PLACE A REVIEWER LOOKS
      TO SEE WHAT EACH ESCAPE CAN TOUCH — BECOMES FALSE FOR ALL THREE ROWS IN THIS WAVE, AND
      THE AMENDMENT ADDS A THIRD ROW WITH THE SAME UNDERSTATEMENT.
    failure_scenario: >-
      Every `databaseTransaction` consumer receives a `PgTransaction` over the whole
      `typeof schema`. Until this wave that schema held only `tenants`, so "on `domains` and
      `links` only" was nearly true. This wave adds five tables with no RLS and no
      predicate, so from this commit forward every escape handle reads all of them.
      Measured inside a `withMembershipLookup` transaction, with only
      `app.membership_lookup_user` set: `session` → 2 rows including `TOKEN-A`; `account` →
      2 rows including the password hash; `user` → 2 rows including both email addresses;
      `tenants` → 0 rows. The new row says "`SELECT` only, on `tenant_memberships` only",
      which is what the POLICY grants, not what the HANDLE reaches — ADR-0045 line 139-141
      states the wider reach correctly and the contract table does not carry it. The
      `privilegedTenantEraser` row is the one that matters later: it is not `READ ONLY`, so
      its row's "DELETE only, scoped to one `tenant_id` by policy" will be false for
      `user`, `session` and `account` from the moment TASK-054 exists. Both other escapes
      are deferred code, so nothing is live; the artifact is what is wrong.
    required_change: >-
      Add to each row, or as a note under the table, that every consumer's handle
      additionally reaches the five RLS-exempt Better Auth tables with no predicate, and
      that `SET TRANSACTION READ ONLY` — not policy — is what bounds two of the three to
      reads. Name explicitly that `privilegedTenantEraser` is the one with no such bound.

  - id: F-027
    severity: minor
    kind: documentation
    claim_type: documentation gap — a load-bearing justification that is false against shipped code
    file: .sdlc/identity-membership/design/contracts/tenant-membership-lookup.md
    line: 155
    summary: >-
      THE STATED REASON FOR TRUNCATING THE USER ID IS MEASURABLY FALSE, IN FOUR ARTIFACTS.
      ADR-0045:167-173, `tenant-membership-lookup.md`:155-160, and both stubs
      (`tenant-id-for-user.ts`:26-31, `membership-lookup.ts`:63-66) all say: "`serializers.err`
      reduces a logged error to `err_name` and `err_stack`, and `Error.stack` BEGINS WITH
      THE MESSAGE, so anything interpolated into the message reaches the log line whatever
      `LOGGABLE_FIELDS` says." The shipped logger was built specifically to make that
      untrue.
    failure_scenario: >-
      `apps/api/src/observability/logger.ts:159` binds
      `serializers: { err: (thrown) => errorLogFields(thrown, { includeMessage: false }) }`,
      and the policy block at `:880-884` states, as a measured result: "**`err_stack` carries
      frames only.** The `${name}: ${message}` header is stripped by prefix and then by
      shape". `errorLogFields` at `:917-928` emits `err_message` only when `includeMessage`
      is true, which `serializers.err` never passes. So an error's message does NOT reach a
      log line through `err`, and it did not before this wave either — F-090, F-093, F-108
      and F-111 are the findings that made it so.
      Consequence: the truncation rule is right and its recorded reason is not. A later
      reader who does what this repository asks — verify the premise — finds it false, and
      the only recorded justification for the rule evaporates. The rule should be kept on
      the real grounds: `includeMessage: true` is opt-in at two sanctioned call sites and
      `DomainError` is one of them, so a message is one subclass change from being logged;
      and Better Auth's own logger (F-023) prints error objects positionally through
      `console.error` (`dist/api/dispatch.mjs:72`, `dist/api/index.mjs:208`) with no such
      stripping, which is the channel a `NoTenantMembershipError` escaping `definePayload`
      would actually take.
      I also checked the other half and it is safe: `NoTenantMembershipError.userId` is an
      own enumerable property holding the FULL id, but `LOGGABLE_FIELDS` has no `userId`
      entry so any object carrying it renders `[redacted]`, and `serializers.err` builds a
      fixed field set rather than copying the error's properties (F-244). No change needed
      there.
    required_change: >-
      Replace the stated mechanism in all four artifacts with the one that is true. Keep the
      truncation. State that the channel is `includeMessage: true` at a sanctioned call site
      and the dependency's own console logger, not `err_stack`.
```

## Notes

**What I built and attacked.** A scratch database `audit_f020`, owned by `shortkit_migrator`,
with the compose stack's `ALTER DEFAULT PRIVILEGES` grant to `shortkit_app` reproduced, holding:
migration `0000`'s `tenants` in the ADR-0049 repaired form, the five Better Auth tables exactly
as `design/stubs/apps/api/src/db/schema/auth.ts` declares them (no RLS), and
`tenant_memberships` with `tenantScopedPolicies()` in the `nullif` form plus
`membershipLookupPolicy()` verbatim. Everything was issued as `shortkit_app` (`rolbypassrls =
f`, owns nothing, subject to `FORCE ROW LEVEL SECURITY`). The database was dropped; the
`shortkit_test` and `postgres` databases were not touched.

**Four load-bearing claims in this wave were verified rather than trusted, and all four hold.**

1. **ADR-0049's `nullif` repair is correct and necessary.** Cold backend: flags read NULL,
   out-of-context count `0`, mint returns tenant A's id. After one committed transaction-local
   `set_config`, both flags read `''` and never NULL again. Under the repaired predicate the
   warm out-of-context count is `0` on both `tenant_memberships` and `tenants`, the warm mint
   resolves, and `WITH CHECK` still rejects an insert with no context (`new row violates
   row-level security policy`) rather than raising. Under all four unrepaired variants the warm
   read raises `22P02 invalid input syntax for type uuid: ""`. The `AND`-guard alternative the
   ADR records as "measured wrong" is measured wrong here too.
2. **The index survives the `nullif`.** `EXPLAIN` on a tenant-scoped read shows `Bitmap Index
   Scan on tenant_memberships_tenant_id_idx` inside a `BitmapOr`; the mint path shows `Index
   Scan using tenant_memberships_user_unique`. ADR-0049's rejection of the compare-as-text
   alternative on index grounds is sound.
3. **`FOR SELECT` does not widen `UPDATE` or `DELETE`.** With both flags set, `UPDATE ... WHERE
   user_id='user-b'` and `DELETE ... WHERE user_id='user-b'` each affected 0 rows. PostgreSQL
   requires the UPDATE/ALL `USING` policy independently of SELECT visibility.
4. **`SET TRANSACTION READ ONLY` is doing the work ADR-0045 says it does.** A write to
   `account` inside a lookup transaction fails with `cannot execute UPDATE in a read-only
   transaction`. Without it the handle would have unconstrained DML on all five auth tables.

**Claims about `better-auth@1.6.26` that I re-read and that hold.** `sign.mjs:52-61` does
overwrite `sub` after spreading the payload, so `auth-contracts.md`'s note is correct.
`setAudience` takes one value, so `aud` is a single string. `sign-up.mjs:152-161` checks both
password bounds before `password.hash`, so ADR-0047's "128 is a real bound" argument against
`authBodyCap`'s 32 KB is correct. `create-context.mjs:171-173` matches ADR-0013's rate-limit
figures.

**Two things I decided not to file.**

- *`betterAuthDatabase()`'s runtime `db.query` surface is ambiguous in ADR-0046.* If it is a
  re-typed view of the shared `client()` instance, `db.query` is keyed by the Drizzle property
  names (`authUser`, `tenants`, …) and `db.query['user']` is `undefined`, so the adapter's
  `getQueryModel` falls through to the identity scan over `config.schema`
  (`@better-auth/drizzle-adapter/dist/index.mjs:300-320`) — which works, but contradicts
  ADR-0046's stated positive consequence that "neither the `db.query[model]` fallback nor the
  `config.schema` scan is exercised". If instead it constructs a second `drizzle(pool, { schema:
  betterAuthSchema })`, the consequence is true and the runtime `query` surface really is five
  tables. This is correctness, and the security property either way is the one ADR-0046 already
  states honestly (types erase; RLS is the protection), so it belongs to `sdlc-reviewer`.
- *`tenantMembershipContract` carries `role` and `tenantId` on a shape `auth-contracts.md`
  invites callers to build request bodies from.* That is a mass-assignment shape, but there is
  no membership-mutation endpoint in item 1a — memberships are written only by `onUserCreated`
  — so there is no reachable path and I am not filing it. It becomes real the moment item 1b
  adds an invitation-acceptance or role-change route, and ADR-0048's split is what will make
  the fix cheap.

**Rate limiting is not a finding.** ADR-0047 accepts an 8-character floor with no breach check,
which would be a concern under unbounded online guessing; TASK-004 (wave 4) ships
`auth-rate-limit.ts`, `resolve-rate-limit-principal.ts` and the port, so the path closes inside
this initiative. The wave-1-through-3 window exists but there is no deployment (ADR-0030).

**What I could not do.** Nothing was blocked. The one claim I could not settle by construction
is whether `user.id = ''` is reachable through any path outside sign-up — I read the sign-up
route and confirmed it is not reachable there, but `onUserCreated`, the invitation flow and any
future `advanced.database.generateId` are unwritten, so F-021's reachability is stated as
latent rather than proven either way.

## Dependencies reviewed

This wave adds no dependency. It configures `better-auth@1.6.26`, already pinned exactly
(ADR-0018, F-016), and `@better-auth/drizzle-adapter@1.6.26`. Two behaviours of the pinned
version are load-bearing and are the subject of F-020 and F-023: the default-secret fallback at
`dist/context/create-context.mjs:78` and the built-in `console`-based logger at
`@better-auth/core/dist/env/logger.mjs:55-69`. Neither is a CVE; both are defaults that this
repository has not yet overridden. The lockfile is unchanged by this wave.
