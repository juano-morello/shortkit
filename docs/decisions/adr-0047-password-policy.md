---
id: ADR-0047
slug: identity-membership
title: Adopt Better Auth's 8-character password floor, declared once in the contracts package
status: accepted
supersedes: null
amends: null
date: 2026-08-12
---

## Context

Plan decision 11 records that **no artifact in this repository states a password policy**.
Not the refinement, not an ADR, not a contract, not a TASK card. The system is about to
accept its first password.

`better-auth@1.6.26` has one whether we choose or not
(`dist/context/create-context.mjs:185-186`):

```js
minPasswordLength: options.emailAndPassword?.minPasswordLength || 8,
maxPasswordLength: options.emailAndPassword?.maxPasswordLength || 128
```

Both are enforced server-side on `/sign-up/email`, `/change-password`, `/reset-password`
and `/update-user`, before hashing, and each returns a 400 carrying
`PASSWORD_TOO_SHORT` or `PASSWORD_TOO_LONG` (`api/routes/sign-up.mjs:152-161`). Those are
Better Auth's own error codes, not `ErrorEnvelope`: the mount sits outside the Nest graph,
so nothing in `apps/api` maps them, and TASK-008 maps them at the web client boundary.

So the real question is not whether there is a policy but whether the repository states the
one it has, and where.

## Decision

**The policy is: at least 8 characters, at most 128, no composition rules. Adopted
deliberately, stated in two places that are one declaration.**

`packages/contracts/src/auth/` exports the values:

```ts
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;
```

`signUpRequestContract` reads them, so the web form rejects a short password before a
request is made. TASK-003's `auth.config.ts` reads the same constants:

```ts
emailAndPassword: {
  enabled: true,
  minPasswordLength: PASSWORD_MIN_LENGTH,
  maxPasswordLength: PASSWORD_MAX_LENGTH,
}
```

Both values are stated in the config rather than left to the `|| 8` and `|| 128` defaults,
so a future Better Auth release that changes a default cannot change this product's policy
silently. A unit test in TASK-003 asserts the composed config carries both, alongside the
`rateLimit.enabled === false` assertion ADR-0013 already requires there.

**Better Auth is the enforcer of record.** The zod check in the contract is a form-usability
check that happens to run in two places; it is not the control. A request that reaches
`/api/auth/sign-up/email` is validated by Better Auth whatever the contract says, because
the mount is outside the Nest pipeline and no Nest pipe sees the body.

**No composition rules**, and no maximum on character classes, no forced rotation, no
disallowed-substring list. NIST SP 800-63B is explicit that composition rules push users
toward predictable substitutions and should not be imposed; the measures it does recommend
are a length floor, a generous ceiling, and a breached-password check.

**128 is a real bound, not a formality.** Password hashing is deliberately expensive.
`authBodyCap` admits 32 KB, so without the ceiling a caller could submit a 32 KB password
and pay for it in the API's CPU rather than its own. Better Auth checks the length before
it hashes.

**No environment variable is introduced.** These are compile-time constants in a package
both deployables import, so GC-B's binding enumeration does not apply. There is nothing here
for an unset value to bind to.

## Alternatives considered

| Option | Pros | Cons | Why not |
|---|---|---|---|
| Say nothing and inherit the `\|\| 8` default | Zero code | The policy exists but no artifact states it, which is the state plan decision 11 filed. A Better Auth release changing the default changes the product's security posture in a lockfile bump, and no test would notice | The absence of a decision is what this ADR exists to end |
| 12 characters, with an uppercase/digit/symbol requirement | Reads stricter; matches what many compliance checklists ask for | Composition rules are the practice NIST SP 800-63B advises against: they produce `Password1!` and drive password reuse. A 12-character floor with no breach check is weaker in practice than 8 with one. It also puts a rule in the contract that Better Auth cannot enforce, so the web form and the API would disagree about what is valid | Stricter-looking and not stronger, and it splits enforcement |
| 8 characters plus Better Auth's `haveibeenpwned` plugin | The measure that actually raises the floor: rejects passwords already in a breach corpus, which is what a short password's real risk is | A third-party network call on the credential path, in a plugin, in an initiative whose refinement scopes out mail and every other outbound integration. It adds a failure mode to sign-up when the service is unreachable, and a decision about what to do when it is. ADR-0030 also means there is nothing deployed to protect yet | The right next step and not this initiative's. Named below as the trigger |
| Enforce the rule in a Nest pipe as well | Defence in depth | No Nest pipe sees `/api/auth/*`; the mount is ahead of the graph (ADR-0013, GC-C). A pipe would be dead code that reads like a control | Structurally impossible under the mount this repository already chose |

## Consequences

### Positive

- The policy is stated, in one place, and read by both deployables. `pnpm typecheck` breaks
  if one side drifts, because `apps/web` imports the contracts source directly (ADR-0005).
- A Better Auth default change cannot move it, and a unit test says so.
- The web form can show the rule before submitting, so the common failure is caught without
  a round trip.

### Negative / accepted cost

- **Eight characters with no breach check is a weak floor, and this ADR knows it.** An
  operator can register `password`. Nothing in this initiative stops them. That is the
  accepted cost, and it is accepted because there is no deployment and no user data yet
  (ADR-0030), not because the floor is adequate.
- Two enforcement points that must agree: a zod `.min()` in the contract and Better Auth's
  own check. They are fed from one constant, so they cannot disagree about the number, but
  they disagree about the error shape: the contract produces a `validation_failed`
  `ErrorEnvelope` with `fieldErrors`, and Better Auth produces
  `{ code: 'PASSWORD_TOO_SHORT' }`. A user who defeats the client check sees a different
  error body than one who does not, and TASK-008 is what makes the second one legible.
- `PASSWORD_MAX_LENGTH` is a value the web form must also enforce, or a paste of a long
  generated passphrase fails at the API with a body the form did not anticipate. 128 is
  above every common password manager's default, so this should be rare, and rare is the
  worst frequency for an error path.
- Changing the floor later does not re-check existing passwords. A raise applies to new
  passwords only, and there is no mechanism here to force a reset, because password reset is
  a mail path and mail is out of scope.

### What would raise the floor

- The first real deployment with accounts that are not developers'. ADR-0030 says there is
  none today.
- The `haveibeenpwned` plugin, or any breached-password check, becoming affordable, which
  means an initiative that already accepts outbound network I/O on a credential path and can
  decide what happens when it fails.

### Follow-ups this creates

- TASK-001 exports `PASSWORD_MIN_LENGTH` and `PASSWORD_MAX_LENGTH` and uses both in
  `signUpRequestContract`.
- TASK-003 states both in `emailAndPassword` and asserts them in `auth.config.spec.ts`.
- TASK-008 renders the rule in the signup form and maps `PASSWORD_TOO_SHORT` and
  `PASSWORD_TOO_LONG` onto `validation_failed` at the client boundary, alongside the 429
  mapping F-027 already requires there.
