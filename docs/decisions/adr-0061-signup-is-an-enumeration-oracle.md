---
id: ADR-0061
slug: identity-membership
title: Sign-up does not auto-sign-in, which closes the status-code oracle and takes the credential out of the failure path
status: accepted
supersedes: null
amends: null
date: 2026-08-16
---

> **Reversed 2026-08-16 by Juano's ruling, between rounds.** The first version of this ADR
> accepted the oracle and escalated `autoSignIn: false` as the one change that closes it. He
> took it. The decision below is the change; the acceptance reasoning is kept in the
> Alternatives table as the option that lost, because it was the right call to escalate and
> the wrong call to make.

## Context

`auth-tokens.md` records the behaviour as a measured fact: a sign-up whose email already has
an account answers `422 USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL`, and it warns callers to branch
on `code` rather than status. It records it as an error shape. No artifact in this repository
recorded it as a disclosure until the wave-2 security pass.

The mechanism, read from `dist/api/routes/sign-up.mjs:162-163`:

```js
const shouldReturnGenericDuplicateResponse =
  ctx.context.options.emailAndPassword.requireEmailVerification ||
  ctx.context.options.emailAndPassword.autoSignIn === false;
const shouldSkipAutoSignIn =
  ctx.context.options.emailAndPassword.autoSignIn === false || shouldReturnGenericDuplicateResponse;
```

When the first is true, the handler hashes the password anyway to flatten the timing
difference, builds a **synthetic user** and returns 200, so a duplicate is indistinguishable
from a fresh signup. When it is false, the 422 goes out and an unauthenticated attacker reads
account existence off an address list.

Two more facts made the answer bigger than the oracle. `rateLimit: { enabled: false }`
(ADR-0013) removes the library's own brake, and its replacement is IP-keyed and lands in
TASK-004, where ADR-0040 records that no IP-keyed limit binds in any environment that exists
today. And with auto-sign-in on, the signup that fails tenant provisioning (ADR-0054) returns
its 500 **carrying a live session cookie**, measured.

## Decision

**`emailAndPassword: { enabled: true, autoSignIn: false }`. `requireEmailVerification` stays
unset.**

`enabled: true` is stated because it is not a default: `create-context.mjs` never sets it and
`sign-up.mjs:144` throws `400 EMAIL_PASSWORD_SIGN_UP_DISABLED` when it is falsy. Without it
there is no signup at all.

`autoSignIn: false` does four things, and they are why it wins:

1. **The status-code oracle closes.** A duplicate address returns 200 rather than 422, on a
   code path that hashes the password first so the timing does not disclose either.

   **Corrected 2026-08-16 after round 3: this closes the status code, not the disclosure.**
   The first version of this ADR said "the oracle closes", and that claimed more than the key
   buys. Measured on better-auth's in-memory adapter, the two 200s are not the same shape: for
   an address that already has an account the `user` object's keys are
   `["name","email","emailVerified","image","createdAt","updatedAt","id"]`, and for a fresh
   address they are the same minus `image`. **The `image` key is present if and only if the
   address exists**, deterministically, on every request, with no timing analysis. That is the
   same existence disclosure the 422 made, read from one JSON key instead of a status line.

   The mechanism is that one branch serialises a row and the other serialises the object it
   just built: `sign-up.mjs:198-202` passes `coreFields` to `buildSyntheticUserOutput`, and
   `coreFields` carries `image: image ?? null` unconditionally, while the fresh path returns
   what the adapter wrote.

   **Whether it survives the real adapter is undetermined and this design did not determine
   it.** `user.image` is a nullable column, so a row read back through the drizzle adapter
   plausibly carries `image: null` and the two shapes converge. The measurement was taken on
   the in-memory adapter and the question is adapter-dependent in exactly the direction that
   matters. See the integration test below, which is what decides it.

   The disclosure, if present, is **existence only**: `name` is the attacker's own value and
   `id` is freshly generated on the synthetic path, both checked, so the victim's data does
   not leak.
2. **Sign-up creates no `session` row.** ADR-0054's residue loses the live credential
   entirely: an orphaned account is a `user` row and an `account` row, and nothing else.
3. **The failed-provisioning 500 carries no `Set-Cookie`.** The response that says the account
   is unusable stops also handing over a working session token, which is the half of ADR-0054
   that mattered most.
4. **`token: null` is the response shape `auth-contracts.md` already types**, because
   `authSessionContract.token` is `z.string().nullable()` and its docblock names this exact
   case.

`requireEmailVerification` stays unset. It would close the oracle the same way and it makes
signup uncompletable while mail is out of scope and `MAIL_TRANSPORT` unset binds a no-op
sender. TASK-005's card already records that reasoning for `ev`.

**Sign-up and sign-in now agree about the status code.** `INVALID_EMAIL_OR_PASSWORD` is
returned for both a wrong password and an unknown address, which `auth-tokens.md` records as
deliberate and as what AC-20's 401 rests on. Sign-up no longer answers the existence question
in its status line.

### The response-shape channel, and what decides it

**The deciding assertion is an integration test against the real adapter, and it is the
decision rather than a check on it.**

> A duplicate-address sign-up response and a fresh-address sign-up response are
> **byte-identical after normalising `id`, `createdAt` and `updatedAt`**.

It goes in `apps/api/test/auth/signup-creates-tenant.int-spec.ts`, which already exercises the
real drizzle adapter against the migrated schema. Asserting equality of the whole normalised
body rather than the absence of one key is what makes it survive a library change to either
branch: `image` is today's divergence and the test is not about `image`.

**If it passes**, the shapes converge under the real adapter, the disclosure does not exist in
this product, and the test is what keeps it that way.

**If it fails**, the disclosure is real and is **accepted here, explicitly**: it is
existence-only, identical in kind to the 422 it replaced, and closing it means either
post-processing a response body on a mount that sits outside the Nest graph, or setting
`requireEmailVerification`, which is out of scope while mail is. In that case the test is
inverted to pin the known divergence, a finding is filed against the card that owns the
response boundary, and this ADR is superseded rather than quietly left claiming a closure it
does not have.

**Either way the key stays.** `autoSignIn: false` earns its place on the residue alone: it
removes a live 7-day session credential from the body of a 500 that reports the account is
unusable, which is measured and is not in dispute.

### What this costs the signup flow, stated because it is not a detail

**Signup no longer returns a session.** The user signs up and must then sign in. TASK-007's
BFF and TASK-012's `/signup` screen build against that, and both are in later waves. Juano
writes those cards.

**A person who forgot they already have an account sees success and then cannot sign in with
the password they just chose.** That is the standard cost of a generic duplicate response, and
the standard mitigation is an email saying "you already have an account", which
`onExistingUserSignUp` exists for and which mail being out of scope makes unavailable. **So
the mitigation is absent, not chosen against.** This is the sharpest edge of the decision and
it is a product-visible one.

## Alternatives considered

| Option | Pros | Cons | Why not |
|---|---|---|---|
| **Accept the oracle**, record it, and name the mitigations. The first version of this ADR | No change to the composed config. Keeps `auth-tokens.md`'s 422 row true and keeps TASK-008's mapping and TASK-012's copy as designed. Keeps a signup that signs you in, which is the flow the product wants | Leaves an unauthenticated caller able to test an address list against the product, with the only brake a limiter that ADR-0040 records does not bind. Leaves a live session credential in the residue of a failed signup and in the body of its 500 | **Reversed by Juano, 2026-08-16.** Escalating it was right; the escalation named a change that closes two findings with one key, and the contracts it falsifies are ones he can amend |
| `requireEmailVerification: true` | Closes the oracle identically, and is the mitigation the library documents. Also gives `ev` a meaning | Email verification is out of scope by a dated refinement decision, and an unset `MAIL_TRANSPORT` binds a no-op sender, so signup becomes uncompletable | Contradicts a scope decision and breaks signup outright |
| `onExistingUserSignUp` with a generic response, keeping `autoSignIn: true` | Closes the oracle without changing the signup flow the product wants | It is a hook on the duplicate path, not the switch that decides the response. `shouldReturnGenericDuplicateResponse` is computed from the two keys above and from nothing else, so the 422 still goes out | Does not reach the branch that decides the response |
| Keep `autoSignIn: true` and sign the user in from the BFF with the credentials it just posted | Closes nothing on its own, but would preserve the flow if the oracle were closed another way | Requires the BFF to hold a plaintext password for a second request, which is the one thing ADR-0014's cookie design exists to avoid | Reintroduces a plaintext credential to save a redirect |
| Close it at the BFF by mapping the 422 to look like a success | No API change | The oracle is on the API's unauthenticated surface and the BFF is not its only caller. A client-side mapping is not a control | Hides a disclosure from one client and leaves it on the wire |

## Consequences

### Positive

- An unauthenticated caller can no longer determine whether an address has an account **from
  the status code** of either credential endpoint. The response-shape channel is bounded by
  the integration test above and is not claimed closed here.
- The orphaned account of ADR-0054's residue holds no session credential, and the 500 that
  reports it carries no `Set-Cookie`. One key closed both halves of a finding that took two
  rounds to describe.
- The password is hashed on the duplicate path, so the timing side channel closes with the
  status side channel rather than replacing it.
- `token: null` on signup is the shape `auth-contracts.md` already types and documents, so no
  contract in `packages/contracts` changes.

### Negative / accepted cost

- **A user who signs up with an address that already has an account is told it worked.** They
  then cannot sign in with the password they chose, and no email explains why, because mail is
  out of scope. This is a real, product-visible confusion and it has no mitigation in this
  initiative.
- **`auth-tokens.md`'s 422 row is now false**, and so is its invariant 8, "a signup that
  returns 200 created a user whose `name` is exactly the string the caller sent". Under the
  generic branch a 200 may describe a synthetic user that was never written. Juano is amending
  that contract; this ADR is why.
- **The signup flow changes for two cards in later waves.** TASK-007 must not expect a session
  from signup and TASK-012 must send the user to sign in. Both are Juano's to write, and
  neither has been built yet, which is the only reason this is affordable now.
- **TASK-008's mapping loses a case and gains nothing.** The 422 it was told to map no longer
  occurs, so the mapping is dead code until someone notices.
- **A synthetic-user 200 is a response nobody can distinguish from a real one, including us.**
  Support cannot tell a duplicate signup from a real one without reading the database, and the
  log line that would say so is `sign-up.mjs:168`'s, which is `info` and suppressed at
  ADR-0060's `'warn'`.
- **A key changed the status code and may not have changed the disclosure.** Added 2026-08-16.
  Closing an oracle by changing a status code is exactly the kind of fix that ships green, and
  this one needed a third audit round to find the body still answering. The integration test is
  the only thing that makes the claim checkable, and it did not exist until this round.
- **Two enumeration oracles remain and neither is closed here**: password reset and, once it
  exists, invitation acceptance. Both are out of scope, and closing sign-up while leaving them
  is the usual half-measure. Naming it so the next person does not assume the product is clean.

### Follow-ups this creates

- **Juano amends `auth-tokens.md`'s 422 row and its invariant 8**, and writes TASK-007's and
  TASK-012's cards. This design does not touch any of them.
- **TASK-008's Better Auth error mapping loses `USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL`** and
  gains nothing. It should be told, or it will map a case that cannot occur.
- **ADR-0054's residue table is corrected in this same revision**: no `session` row, no
  `Set-Cookie` on the 500.
- `auth.config.spec.ts` asserts `emailAndPassword.enabled === true` and
  `emailAndPassword.autoSignIn === false`. The second is a silent fact in the strongest sense:
  flipping it back re-opens the oracle, re-adds the credential to the 500, and fails no test
  that does not assert it.
- **`signup-creates-tenant.int-spec.ts` gains the byte-identity assertion** described above,
  plus the existing check that a duplicate signup returns 200 and writes no second `user` row.
  Without them, "the oracle is closed" is a claim about a config key. `test_files` is Juano's;
  the card text is in this design's return.
