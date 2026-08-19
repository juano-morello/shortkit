---
id: ADR-0057
slug: identity-membership
title: The jwks private key stays encrypted with BETTER_AUTH_SECRET, and wave 2 owes a coupling note rather than a mechanism
status: accepted
supersedes: null
amends: null
date: 2026-08-14
---

## Context

Read from the pinned `better-auth@1.6.26`:

`dist/plugins/jwt/utils.mjs:46` sets `privateKeyEncryptionEnabled =
!options?.jwks?.disablePrivateKeyEncryption`, so encryption is **on by default**. At `:51-54`
the private key is stored as `JSON.stringify(await symmetricEncrypt({ key:
ctx.context.secretConfig, data: stringifiedPrivateWebKey }))`. `dist/plugins/jwt/sign.mjs:34-39`
decrypts with the same key and, on failure, throws
`BetterAuthError("Failed to decrypt private key. Make sure the secret currently in use is
the same as the one used to encrypt the private key...")`.

So `BETTER_AUTH_SECRET` is not only the signing configuration. It is the symmetric key for
every `jwks` row. Changing it does not merely invalidate outstanding tokens; it makes the
existing rows undecryptable, and the failure surfaces at mint time rather than at boot.

Three things follow from where that failure lands.

It is a `BetterAuthError`, not an `APIError`, so it takes the path ADR-0055 traced: an empty
500 from `better-call`'s router and the message written to stdout by a `console.error` inside
`better-call`. ADR-0055 closes the two sites our code owns and explicitly leaves this one
open.

The bound pino line carries almost nothing. better-auth's `onError` reaches
`ctx.logger?.error(e.name, e)` for a non-`APIError` (`dist/api/index.mjs:202`), and ADR-0052
drops positional `args`. An operator sees `BetterAuthError` and no message, while the
sentence naming the exact cause and the exact remedy exists in `better-call`'s raw output.

And it is not a boot failure. The process starts, `/health` answers 200, sign-in works,
sessions are created, and only the mint fails. Every authenticated route is down and the
platform's health check is green.

`scripts/check-compose-stack.sh` already depends on this coupling in the other direction:
ADR-0051 property 3 requires one generated value for a whole run because a second value
mid-run produces exactly this error, and property 4 records that the per-run value is safe
only because `:418` runs `down -v` first and destroys the volume before a fresh secret meets
an old `jwks` row.

F-083 asked for a rotation runbook. It was routed out of wave 0 and has no owner in this
initiative.

## Decision

**Encryption stays on. Wave 2 writes the coupling into `auth.config.ts`'s docblock and ships
no mechanism. F-083's runbook is named as unowned rather than absorbed.**

Four parts.

**1. `jwks.disablePrivateKeyEncryption` is not set,** so the library's default stands and the
private key stays encrypted at rest. This is stated in `auth.config.ts` as a deliberate
non-setting, in the same style as `emailAndPassword`'s length bounds in `auth-tokens.md`, so
a later reader does not read the absent key as an oversight.

**2. The coupling is written where the key is passed.** The docblock above `secret:
betterAuthSecret()` states that this value encrypts `jwks.privateKey`, that changing it
breaks every existing row, that the symptom is a 500 on `GET /api/auth/token` with the
process otherwise healthy, and that the remedy is to delete the `jwks` rows and let the
plugin regenerate. It names ADR-0051 property 3 and this ADR.

**3. No boot assertion.** Reasoning below.

**4. The remediation is written down and is destructive, so it stays manual.** `DELETE FROM
"jwks"` as `shortkit_auth`, then the next mint calls `createJwk` and writes a fresh row
(`sign.mjs:33`). Every outstanding token stops verifying because the key set changed, which
is a forced sign-out for every active session and is correct after a secret rotation.
`auth-tokens.md`'s Versioning section describes the non-destructive rotation, publish the new
key and wait 600 seconds for JWKS caches to expire, and that procedure applies to rotating
the *signing key* and not to rotating the *secret that encrypts it*. The two are different
operations and the contract's sentence covers only the first.

### The two-factor claim, and the adversary it holds against

**Added 2026-08-16 after the wave-2 security pass, which found the claim stated
unqualified.** ADR-0051 closes with "the row is useless without the secret and the secret is
useless without the row, and the two decisions are what keep them apart", and the first
version of this ADR reused that sentence to reject `disablePrivateKeyEncryption`. It needs
its adversary named, because it is true for one and false for another.

**Against a database-only adversary it holds.** Someone with a `SELECT` on `jwks` and no
access to the API process has an encrypted blob and no key. That is the case ADR-0050's role
split and ADR-0051's binding were both written for, and encryption is what makes the stolen
row worthless.

**Against anything running inside the API process it does not hold, and cannot.**
`process.env.BETTER_AUTH_SECRET` and a handle on the auth pool are in the same process by
construction: the config needs the first to pass `secret` and the second to reach `jwks`. So
a file in `apps/api/src` that reaches the role, by the identifier or by ADR-0056's
`pg.Pool` bypass, holds both factors simultaneously and decrypts the signing key. Encryption
buys nothing there and is not meant to.

The rejection of `disablePrivateKeyEncryption` survives the qualification, because the
adversary it defends against is real and is the one a database backup, a read replica or a
misdirected `pg_dump` produces. What does not survive is using the sentence as though it
bounded every adversary. ADR-0056's caller list is the control for the in-process case, and
its accepted costs now say what that control does not reach.

## Alternatives considered

| Option | Pros | Cons | Why not |
|---|---|---|---|
| `jwks: { disablePrivateKeyEncryption: true }` | Removes the coupling entirely. Rotating `BETTER_AUTH_SECRET` becomes what everyone assumes it is: outstanding tokens stop verifying, nothing else breaks. No `Failed to decrypt private key` failure mode exists at all | It puts the JWT signing key in plaintext in a table row. ADR-0050 keeps `shortkit_app` off `jwks` and ADR-0051 closes with "the row is useless without the secret and the secret is useless without the row". **That sentence holds against a database-only adversary and against nothing else** (see the qualification below). Against a database-only adversary, turning encryption off collapses the pair into one factor, so a database read alone forges any `tid` claim for any user in any tenant | It trades the property two accepted ADRs were written to establish for an operational convenience nobody has asked for. This is the alternative a reader will reach for when the failure bites, which is why it is first |
| A boot assertion: read the newest `jwks` row on the auth pool and try to decrypt it with the configured secret | Turns a mint-time outage into a refusal to boot, which is this repository's stated posture everywhere else. It answers definitively, no retry semantics needed beyond reachability | It needs the auth pool, so it belongs beside `assertAuthRoleSeparation` in TASK-004's half of `boot-assertions.ts`, wave 3, and TASK-004 is not this design's wave. It also has to reimplement `symmetricDecrypt` against a private path of the library, `ctx.context.secretConfig`, which is derived rather than equal to the string we pass and is not part of any published contract. And refusing to boot after a rotation takes the whole API down where today only the mint is down | Right instinct, wrong wave and wrong coupling. Deferred deliberately, not overlooked. Named in the follow-ups with the wave that could own it |
| Set `onAPIError.onError` so the `BetterAuthError` message reaches pino | Cheap. Closes the "operator sees `BetterAuthError` and nothing else" half, which is the part that actually costs an afternoon | Every message from the dependency then flows through a path we censor, including `origin-check.mjs:110`'s attacker-controlled `Origin` header, up to Node's 16 KB limit. ADR-0052 examined exactly that byte stream and declined to widen what reaches `msg`, and refused truncation as this repository's answer | It reopens ADR-0052's residual to fix a diagnostic. Named in the follow-ups because ADR-0052's trigger list is where it belongs |
| `BETTER_AUTH_SECRETS`, the library's array form, with rotation support | It is where rotation actually lives in the library and it would make the whole question go away | ADR-0051 already weighed and rejected it: rotation is a capability nothing in this initiative needs, `validateSecretsArray` is a second validation path, and it is the right shape for a system with a deploy target, which ADR-0030 says there is not | Settled by an accepted ADR three weeks ago and nothing has changed |
| Write the runbook here | F-083 gets an owner. One markdown file | A runbook for rotating a credential in a system with no deploy target, no production database and no operator is a document describing a procedure nobody can perform. ADR-0030 is why. It would also sit in `docs/` , which is in no TASK's `paths` in this wave | The procedure's preconditions do not exist yet. The four-line remediation in the docblock is what a developer with a local stack actually needs |

## Consequences

### Positive

- The `jwks` row and the secret stay two factors, which is what ADR-0050 and ADR-0051
  together bought and neither buys alone.
- The remedy is four lines away from the key it is about, so the person who rotated the
  secret finds it at the place they made the change.
- Wave 2 ships nothing it cannot test. A boot probe against a private library path would be
  a mechanism whose own correctness nothing in this repository verifies.

### Negative / accepted cost

- **A rotated secret takes down every authenticated route with the health check green.** The
  process boots, sign-in works, tokens do not mint. This is the cost, it is unmitigated in
  wave 2, and it is the reason the boot-assertion alternative is named rather than dismissed.
- **The one sentence that names the cause and the remedy never reaches pino.** It reaches
  `better-call`'s `console.error`, so it exists in a container's stdout as an unstructured
  line beside the JSON. An operator with only the structured stream sees `BetterAuthError`.
- **A docblock is not a control.** Nothing fails if the coupling is forgotten. The only
  executing thing that depends on it is `check-compose-stack.sh:418`'s `down -v`, and ADR-0051
  already records that if that line goes, the per-run secret meets a stale `jwks` row.
- **F-083 stays unowned.** This ADR names the gap and does not fill it, and naming a gap is
  worth less than filling one.
- **The remediation is destructive and is written in a docblock rather than gated.** Nothing
  stops someone running `DELETE FROM "jwks"` on a stack where the secret was not the
  problem, which signs every active user out for no reason.

### Follow-ups this creates

- **F-083's rotation runbook has no owner in this initiative and this ADR does not take it.**
  Its natural home is TASK-009, wave 4, which already owns `apps/api/.env.example` and the
  README and is where the generation command for this variable lives. Naming a candidate, not
  assigning one.
- **Unscheduled, TASK-004's neighbourhood: a boot-time decrypt probe** on the auth pool,
  beside `assertAuthRoleSeparation`. It is the mechanism this ADR declined for wave reasons
  rather than for correctness reasons, and it is the right answer once someone is prepared to
  depend on `ctx.context.secretConfig`.
- **ADR-0052's "what would force truncation or disabling" list gains a third entry in
  practice**: a dependency-owned error whose message is the only copy of a diagnosis. That is
  a note for whoever revisits ADR-0052, not an edit to it.
- TASK-003 states `disablePrivateKeyEncryption` as deliberately unset in the same comment.
