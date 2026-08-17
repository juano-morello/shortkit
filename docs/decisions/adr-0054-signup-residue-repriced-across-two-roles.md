---
id: ADR-0054
slug: identity-membership
title: ADR-0015's signup residue re-priced against the two-role model, and the ruling that survives it
status: accepted
supersedes: null
supersedes_in_part: ADR-0015
amends: null
date: 2026-08-14
---

> **This ADR supersedes ADR-0015 on its description of the residue, and on nothing else.**
> Ruled by Juano, 2026-08-16. ADR-0015's ruling stands untouched: the orphan is the accepted
> failure and a membership row in an unproven tenant is not. What is superseded is the
> sentence describing what the orphan consists of, which was written against a one-role,
> one-pool model and is measurably wrong under the current one. **The corrected residue is
> the table below.** ADR-0015 is a foundation ADR in a closed initiative; Juano writes the
> pointer into it and this design does not touch `.sdlc/foundation/`.
>
> The one thing this ADR decides for TASK-003 is what the caller sees when the second write
> fails.
>
> **Corrected 2026-08-16 after the wave-2 security pass**, which executed the exact hook
> shape decided below. Two facts in the first version were wrong: the session is 7 days and
> not 30, and the 500 response carries the session cookie. Both are in the table.

## Context

ADR-0015 ruled on a cost: `databaseHooks.user.after` runs after the `user` row commits, so
signup is not atomic, and the residue when the membership write fails is "a `user` row with
no `tenant_memberships` row". It called that account unusable and acceptable, and it refused
the alternative, a membership row in a tenant nobody proved access to. TASK-003's card
repeats the ruling and forbids a compensating delete without an amendment.

That pricing was done in August 2026 against a one-role, one-pool model. ADR-0050 replaced
the model. The `user` row is now written by **`shortkit_auth`** on the auth pool inside
Better Auth's own call path, and `createTenantForNewUser` writes `tenants` and
`tenant_memberships` as **`shortkit_app`** through `withTenantTransaction` on the
application pool. Nobody re-read ADR-0015 after that. This is F-024's shape and F-108's
shape a third time.

**What the sequence actually is, read from the pinned `better-auth@1.6.26` rather than
inferred.**

`dist/api/routes/sign-up.mjs:143` wraps the whole handler in
`runWithTransaction(ctx.context.adapter, ...)`. With `transaction: false` on the
drizzleAdapter (ADR-0046), `@better-auth/core`'s adapter factory substitutes
`createAsIsTransaction` (`dist/db/adapter/factory.mjs:404-408`), so `adapter.transaction(cb)`
calls `cb` with no database transaction. The handler's writes are separate autocommits.

`createWithHooks` (`dist/db/with-hooks.mjs:31-40`) does not call `user.create.after`
directly. It calls `queueAfterTransactionHook`, which pushes onto `store.pendingHooks`
(`@better-auth/core/dist/context/transaction.mjs:86-93`). `runWithTransaction` drains that
queue at `:74` with `for (const hook of pendingHooks) await hook();`, **after the handler
body has produced its result and before the endpoint returns**, and with no `try`/`catch`
around it.

Three consequences follow, and two of them contradict what the artifacts say.

1. **The hook is awaited before the sign-up response is written.** The 200 is not sent and
   then the tenant created. The tenant is created and then the 200 is sent.
2. **A throw from the hook propagates and replaces the successful result.** Signup returns an
   error rather than a 200. That is better than ADR-0015 implies.
3. **The `user`, `account` and `session` rows are already committed when it throws**, because
   `transaction: false` made them three autocommits. That is worse than ADR-0015 implies.

## What the residue actually is now

ADR-0015 says "a `user` row with no `tenant_memberships` row". Measured against the current
model, three rows survive, not one:

| Row | Written by | Survives a failed membership write |
|---|---|---|
| `user` | `shortkit_auth`, autocommit | yes |
| `account` (the password hash) | `shortkit_auth`, autocommit | yes |
| ~~`session` (a live credential, 7 days)~~ | ~~`shortkit_auth`, autocommit~~ | **NO ROW IS WRITTEN.** ADR-0061 sets `autoSignIn: false`, so sign-up creates no session |
| ~~`Set-Cookie` on the 500 response~~ | ~~the endpoint, after the hook threw~~ | **NOT SENT**, for the same reason |
| `tenants` | `shortkit_app`, inside `withTenantTransaction` | no |
| `tenant_memberships` | `shortkit_app`, same transaction | no |

`tenants` and `tenant_memberships` are in one transaction, so they cannot orphan separately.
That half of ADR-0015 holds exactly.

**The session row was the part nobody priced, and ADR-0061 has since removed it.** Recorded
in sequence because it is the clearest thing two audit rounds produced.

Round 1 measured it: with `autoSignIn` at the library default of true, sign-up wrote a
`session` row and the failed-provisioning **500 carried a `Set-Cookie`** with a live
`better-auth.session_token` and `better-auth.session_data`, both `Max-Age=604800`. So the
response that told the caller the account was unusable handed over a working credential in the
same message, and a client treating a 500 as "nothing happened" was authenticated anyway.

Round 2 named `autoSignIn: false` as the one key that removes it, and Juano took it
(ADR-0061). **Sign-up now creates no session at all**, so the orphan is a `user` row and an
`account` row, the 500 carries no cookie, and nothing in this residue is a credential.

What survives is the part ADR-0015 always described: an account that cannot obtain a `tid`
claim and therefore reaches no tenant-scoped route. That is the safety argument and it is
unchanged.

`auth-tokens.md`'s cookie table gives `sk_rt` a `Max-Age` of 2592000 against a 604800-second
session. It no longer bites on this path, because signup issues no session, and it still bites
after a sign-in. ADR-0059 escalates it.

**And the failure window has a new trigger that is correlated with load.** Under one pool,
an exhausted pool failed the `user` write too, so no orphan was produced. Under two pools
the auth pool can be healthy while the application pool is saturated: `POOL_MAX` is 10 and
`CONNECTION_TIMEOUT_MS` is 2000, so `withTenantTransaction` rejects after two seconds under
concurrency while sign-up itself proceeds normally on the auth pool's five connections. The
orphan is now most likely exactly when signups burst.

**A second new trigger has no owner.** `DATABASE_URL` and `DATABASE_AUTH_URL` are two
independent DSNs and nothing asserts they name the same database. Under one DSN this was
impossible. ADR-0050's `assertAuthRoleSeparation` checks privileges on each connection
separately and passes on two correctly-provisioned but different databases, on which every
signup produces an orphan and every gate stays green. That assertion is TASK-004's, wave 3,
and this ADR does not scope it. It is named in the follow-ups.

## Can a caller observe the intermediate state?

Yes, and worse than ADR-0015 assumed.

`createTenantForNewUser` throws a `pg` error or a `TenantContextMissingError`, neither of
which is an `APIError`. `dispatchAuthEndpoint`'s catch rethrows anything that is not one
(`dist/api/dispatch.mjs:231-238`), better-auth's router `onError` logs and returns
`undefined` (`dist/api/index.mjs:191-212`), and better-call's router then reaches
`console.error("# SERVER_ERROR: ", error)` and returns `new Response(null, { status: 500 })`
(`better-call@1.3.7/dist/router.mjs:94-98`).

So today's behaviour, unmodified, is: **HTTP 500 with an empty body**, the full error and its
stack written to stdout by a `console.error` inside `better-call` that ADR-0052's logger
binding does not reach, and a burned email address. A retry with the same address returns
`422 USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL`, so there is no self-service path back.

## Decision

**ADR-0015's ruling stands. Its description of the residue does not, and the correction is
escalated rather than applied. TASK-003 changes one thing: the failure is raised as an
`APIError` so the caller gets a body instead of an empty 500.**

Three parts.

**1. The ruling stands, unchanged.** The alternative ADR-0015 refused, a membership row in a
tenant nobody proved access to, is unaffected by the role split and is still worse than
every failure above. `createTenantForNewUser` still takes the tenant id from
`crypto.randomUUID()` on the uninvited branch, and TASK-003 still adds no compensating
delete. Nothing in the re-pricing touches the reasoning that produced the ruling.

**2. The hook does not swallow.** `createTenantForNewUser` lets its failure propagate, so
sign-up answers with an error rather than a 200 over a broken account. Swallowing would give
the caller a 200, a session cookie, and a `/token` call that fails seconds later with no
explanation.

**3. The failure is raised as an `APIError`.** `createTenantForNewUser`'s caller in
`auth.config.ts` catches whatever the hook threw and rethrows
`new APIError('INTERNAL_SERVER_ERROR', { message: 'Sign-up completed but tenant
provisioning failed. This account cannot be used; contact support.', code:
'TENANT_PROVISIONING_FAILED' })`. The mechanism and the reason are ADR-0055's; this is one
of its two sites.

The message is a fixed string. It never interpolates the caught error, the email, the user
id or the tenant id, because an `APIError`'s body is rendered to the caller verbatim
(`better-call/dist/to-response.mjs:127-131`).

The original error still reaches the log, once, through the same catch: `logger.error({
code: 'tenant_provisioning_failed', ...errorLogFields(error) }, 'tenant provisioning failed
after the user row committed')`. Both field names are already in `LOGGABLE_FIELDS`.

## Alternatives considered

| Option | Pros | Cons | Why not |
|---|---|---|---|
| Move the membership write into a `before` hook so no `user` row exists on failure | Removes the residue entirely. ADR-0015 itself uses a `before` hook for invitation validation, for exactly this reason | The tenant id has to exist before the user does, and `tenant_memberships.user_id` is a foreign key to a `"user"` row that has not been written. A `before` hook can validate; it cannot write a row that references a row it is validating the creation of. Reordering the two writes puts a `tenants` row and a membership row in place for a signup that then fails password validation | The foreign key runs the other way. This is not implementable, and stating that is worth more than leaving the reader to discover it |
| Compensating delete: catch the failure and delete the `user` row | The address is reusable, so a retry works. No burned account | It is a second decision with its own failure mode: the delete is `shortkit_auth`'s, it cascades into `tenant_memberships` with row security bypassed (ADR-0050 measured this), and a delete that itself fails leaves the same residue plus a confusing log. ADR-0015 forbids it without an amendment and TASK-003's card repeats the prohibition | Ruled against by an accepted ADR. Adding it here would be exactly the silent contradiction this workflow forbids. **It is the strongest candidate if Juano reopens the pricing**, and it is named here for that reason |
| Swallow the hook's error and return 200 | Signup looks like it worked, which it half did. The user has an account | The caller gets a session cookie for an account that cannot authenticate anywhere, and finds out on the next request with a different error at a different layer. It also makes the failure invisible to the integration tier, which asserts on the signup response | Turns a loud failure into a quiet one, for a nicer status code |
| Leave the 500 empty and change nothing | No code. The failure is already loud in the log | The body is `null`, so `apiClient` maps it to `internal_error` with nothing to distinguish it from any other 500, and the stack reaches stdout through a `console.error` in `better-call` that no logger of ours binds. TASK-008 has nothing to branch on | An empty 500 is the one response shape this repository's error contracts exist to prevent |

## Consequences

### Positive

- The caller gets a body naming the state its account is in, instead of an empty 500.
- The original error reaches pino once, with the message under `err_message` and the stack
  under `err_stack`, rather than only reaching `better-call`'s raw `console.error`.
- ADR-0015's safety argument is re-verified rather than assumed: the orphan still cannot
  obtain a `tid` claim, because `tenantIdForUser` throws and ADR-0055 makes that a 403.
- The two triggers the role split introduced are named, so the next person to read ADR-0015
  finds them.

### Negative / accepted cost

- **The residue is two rows, `user` and `account`, and this ADR removes neither.** It
  re-describes the cost accurately and accepts it, which is strictly less than fixing it. The
  credential half is gone, and it was removed by ADR-0061 rather than by this ADR.
- **The address is still unusable, and under `autoSignIn: false` the caller is no longer
  told so.** A retry now returns 200 with a synthetic user instead of 422, so a person
  retrying a burned address sees success twice and can sign in with neither password. That is
  ADR-0061's accepted cost arriving on this path, and it makes the orphan quieter rather than
  rarer.
- **The address is permanently burned with no self-service recovery.** A user who hits this
  must sign up with a different address or contact a support channel that does not exist in
  this initiative. The error message tells them to do the second.
- **The load-correlated trigger is real and unmitigated.** Application-pool exhaustion under
  a signup burst produces orphans at exactly the moment the product is working. Nothing
  retries, nothing queues, and this ADR adds neither.
- **A fixed error message is less useful than the real one.** An operator has to correlate
  the response with the log line by time, because nothing carries a request id across the
  Better Auth mount. That gap is ADR-0013's, not this ADR's, and it bites here.
- **This is the fourth artifact describing one non-atomic signup**, after ADR-0013,
  ADR-0015 and ADR-0046's consequences. A fifth reader will find four descriptions and one
  of them, ADR-0015's, is the one their card points at and the one that is now wrong.

### Follow-ups this creates

- **Ruled 2026-08-16: ADR-0015 is superseded in part on its residue description**, and this
  ADR's table is the correction. Juano writes the pointer into foundation's ADR-0015; this
  design does not touch `.sdlc/foundation/`. The ruling ADR-0015 exists to protect is
  unaffected.
- ~~**TASK-007's BFF must not persist a session token from a non-2xx signup response.**~~
  **Closed 2026-08-16 by ADR-0061**: signup returns no session on any path, so there is no
  token to persist. TASK-007 instead has to send the user to sign in after a successful
  signup, which Juano is writing into that card.
- **`sk_rt`'s `Max-Age` of 2592000 outlives a 604800-second session.** Escalated in ADR-0059,
  which is where `session.expiresIn` is decided.
- **TASK-003's card repeats the same understatement** at its `databaseHooks.user.after`
  section and needs the same correction if ADR-0015 gets one.
- **Nothing asserts `DATABASE_URL` and `DATABASE_AUTH_URL` name the same database.** Two
  correctly-provisioned but different databases pass `assertAuthRoleSeparation` and produce
  an orphan on every signup. The cheapest check is comparing
  `current_setting('system_identifier')` or `pg_database.oid` across the two connections
  inside the assertion that already opens both. **That assertion is TASK-004's, wave 3.**
  Named here, not scoped here.
- TASK-003's `signup-creates-tenant.int-spec.ts` should assert the ordering this ADR read
  out of the library: the sign-up response arrives after both rows exist. If that inverts in
  a later release, the test is what catches it.
