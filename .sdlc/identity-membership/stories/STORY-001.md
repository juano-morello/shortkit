---
id: STORY-001
epic: EPIC-001
title: Signup creates an account, its tenant and its one membership
status: planned
tasks: [TASK-001, TASK-002, TASK-003, TASK-004]
depends_on: []
---

## User story

As an agency operator with no shortkit account, I want to create one with my email address
and a password, so that I have a tenant of my own to put client workspaces in.

## Acceptance criteria

- [ ] AC-1: Given a running API whose `user`, `tenants` and `tenant_memberships` tables are empty, when `POST /api/auth/sign-up/email` is sent a well-formed email, password and name, then the response status is 200, exactly one `user` row exists, exactly one `tenant_memberships` row exists for that user **across all tenants**, the `tenants` row it names exists, that membership's `user_id` is the new user's id, its `tenant_id` is that tenant's id, and its `role` is `owner`.

  > **CLAUSE AMENDED 2026-08-16 at the wave-2 Test phase, Juano's ruling.** It read "exactly
  > one `tenants` row exists". **No tier can measure that.** `tenants` is `FORCE ROW LEVEL
  > SECURITY` and `tenants_self_select` is `USING (id = nullif(current_setting('app.tenant_id',
  > true), '')::uuid)`, so one context sees at most its own row — and all three DSNs the
  > integration suite is given are `NOBYPASSRLS` by an explicit decision
  > (`docker-compose.test.yml:58-60`: a superuser "is exempt from every policy and would make
  > AC-8..AC-11 vacuous"). `SELECT count(*) FROM tenants` cannot be issued by any reader in
  > the suite.
  >
  > The membership clause now carries the weight: **one membership for that user across every
  > tenant**, read through `app.membership_lookup_user`, so a second membership under a second
  > tenant would show. **The residual is an orphaned `tenants` row with no membership pointing
  > at it, and nothing in the suite can see it.** The declined alternative was a fourth
  > `BYPASSRLS` DSN for counting, which contradicts the test stack's own stated reason for not
  > having one — a policy-exempt connection inside the suite that exists to prove policies work.
  >
  > Found by the test architect while writing the test, which is where test.md says it is free.
- [ ] AC-2: Given a user who already holds a `tenant_memberships` row, when a second `tenant_memberships` row naming that same `user_id` is inserted under any tenant, then Postgres rejects the statement with a unique violation on the `tenant_memberships_user_unique` constraint and the table still holds exactly one row for that user.
- [ ] AC-3: Given a session created by a successful sign-in, when a JWT is minted for it, then the decoded claim set carries `sub` equal to the user's id, `tid` equal to that user's `tenant_memberships.tenant_id`, `email` equal to the signup address, `ev` equal to the user's `emailVerified` value, `jti` equal to the Better Auth session id, and `exp` minus `iat` equal to 300 seconds.

  > **PREMISE AMENDED 2026-08-16 at the wave-2 Test phase, Juano's ruling.** It read "a
  > session created by a successful sign-up **or sign-in**". ADR-0061 sets
  > `emailAndPassword.autoSignIn: false` to close an enumeration oracle and to keep a live
  > credential out of the failure path, so **a successful sign-up no longer creates a
  > session** and that branch became unsatisfiable. The sign-in branch is unchanged and
  > every assertion above it stands, including `exp` minus `iat` equal to 300 — which is
  > the clause F-168 would have broken, and which the wave-2 security pass measured at
  > exactly 300 after the fix. Found while writing the tests, which is where it is free.

- [ ] AC-4: Given a `user` row that has no `tenant_memberships` row, when a JWT is minted for a session belonging to that user, then minting fails with `NoTenantMembershipError`, no JWT is returned, and the caller receives an error rather than a token with an absent `tid`.
- [ ] AC-5: Given the composed Better Auth configuration object, when a unit test reads it without starting a server, then `rateLimit.enabled` is exactly `false`.
- [ ] AC-6: Given the API mounted per ADR-0013, when `POST /api/auth/sign-up/email` is sent a JSON body over a request that also carries `Content-Type: application/json`, then Better Auth receives that body with its fields intact and the signup succeeds, which is the observable form of "no earlier body parser consumed the stream".
- [ ] AC-7: Given the API mounted per ADR-0013, when a request to any path under `/api/auth/` declares a `Content-Length` greater than 32768, then the response status is 413 and no `user` row is created.
- [ ] AC-8: Given the auth and membership contracts in `packages/contracts`, when a signup request body with no `password` field is parsed by the request contract, then the parse fails and `toValidationDetails` keys at least one issue under `password`; and when `pnpm typecheck` is run at the repository root with `apps/web` importing those contracts, it exits 0.
- [ ] AC-9: Given `CLIENT_TRUST_BOUNDARY` set to any value other than `proxy` or `direct`, when the API boots, then boot fails with a non-zero exit in every environment; and given `CLIENT_TRUST_BOUNDARY=proxy` with `TRUSTED_CLIENT_IP_HEADER` unset, boot fails; and given both `CLIENT_TRUST_BOUNDARY` and `BFF_TRUST_BOUNDARY` unset, the API boots and serves. The same three clauses hold for `BFF_TRUST_BOUNDARY` and `BFF_PROXY_SECRET`.

## Definition of Ready

**PASS with two named concerns.** Every AC above is measurable against the running system or
against a composed configuration object, and none of them quantifies over an empty set.

- [x] ACs are testable and unambiguous
- [x] Dependencies identified — this STORY depends on nothing; every other STORY depends on it
- [ ] Contracts it consumes exist in `design/contracts/` — **Design has not run.** `auth-tokens.md` and `rate-limit.md` exist under `.sdlc/foundation/design/contracts/` as history from the deferred 2026-08-03 breakdown; this initiative's Design phase produces its own, and TASK cards name them under `contracts:` before they exist. Expected on a `full` track.
- [x] No blocking open questions — `refinement.md` records three open questions and marks all three non-blocking

**Concern 1 — AC-3's `jti` depends on a Better Auth behaviour re-verified once.** ADR-0013
records that `definePayload` must return `jti` explicitly because `sign.mjs:49` only sets it
when the payload carries it, verified against the pinned `better-auth@1.6.26`. That
verification was performed on 2026-08-07 against the same pin this repository still holds
(`apps/api/package.json`, `"better-auth": "1.6.26"`). AC-3 asserts the outcome, so a
regression in that behaviour fails the AC rather than passing silently.

**Concern 2 — AC-4 has no producer for the orphan state through a supported path.**
An orphaned `user` row arises in ADR-0015's invited branch, which is out of scope here. The
test therefore has to construct the state directly (delete the membership row, then mint),
which is a fixture doing something no shipped code path does. That is stated rather than
hidden; the AC is still worth having, because `tenantIdForUser` throwing is the primary stop
ADR-0015 names and nothing else would exercise it.

## Definition of Done

- [ ] All ACs green as automated tests
- [ ] All auditors clear of blocker/major
- [ ] Docs updated (README / API / ADR consequences)
- [ ] Observability in place per config
- [ ] Traceable: commits reference TASK ids
