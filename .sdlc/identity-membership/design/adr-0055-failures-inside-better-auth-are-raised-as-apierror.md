---
id: ADR-0055
slug: identity-membership
title: Every failure our code raises inside Better Auth's call path is an APIError, because anything else is an empty 500 and a raw stack on stdout
status: accepted
supersedes: null
amends: null
date: 2026-08-14
---

## Context

AC-4 requires that when a user has no membership, no JWT is returned and the caller receives
an error rather than a token with an absent `tid`. `tenantIdForUser` throws
`NoTenantMembershipError`. It is called from `definePayload`, which runs inside the signer.
TASK-003's card asks where that failure is raised. The answer depends on what the pinned
library does with a throw from there, so this was read from the installed package rather
than inferred from the shape of the API.

**Where `definePayload` runs.** `dist/plugins/jwt/sign.mjs:53`:
`const payload = !options?.jwt?.definePayload ? ctx.context.session.user : await
options.jwt.definePayload(ctx.context.session);`, inside `getJwtToken`. A rejection
propagates out of `getJwtToken` unchanged.

**`getJwtToken` has two call sites, not one.** `dist/plugins/jwt/index.mjs:144` is the
`GET /token` endpoint handler. `dist/plugins/jwt/index.mjs:188` is an `after` hook matching
`context.path === "/get-session"`, which mints a token and sets it as the `set-auth-jwt`
response header unless `options.disableSettingJwtHeader` is true (`:185`). Nothing in the
card, in ADR-0013 or in `auth-tokens.md` mentions the second site. A throw from
`definePayload` therefore also breaks `GET /api/auth/get-session`, which is the call the BFF
makes to establish that a session exists at all.

**What happens to a throw that is not an `APIError`.** Traced through three packages:

1. `dispatchAuthEndpoint` catches the handler's rejection and rethrows unless
   `isAPIError(e)` (`dist/api/dispatch.mjs:231-238`). `runAfterHooks` does the same
   (`:117-126`).
2. better-auth's router `onError` logs and returns `undefined` (`dist/api/index.mjs:191-212`).
   It never returns a `Response`.
3. better-call's router falls through to `console.error("# SERVER_ERROR: ", error)` and
   `new Response(null, { status: 500, statusText: "Internal Server Error" })`
   (`better-call@1.3.7/dist/router.mjs:84-98`). `config.throwError` is not set by
   better-auth, checked.

So the caller gets **500 with a null body**, and the whole error including its stack is
written by a `console.error` **inside `better-call`**, one package below the logger ADR-0052
binds. `eslint.config.mjs`'s `no-console` ban does not reach `node_modules`, and ADR-0052
bound `betterAuth({ logger })`, which is better-auth's logger and not better-call's.

The bound logger sees almost nothing of it either. For a non-`APIError`, better-auth's
`onError` reaches `ctx.logger?.error(e.name, e)` (`dist/api/index.mjs:202`), and ADR-0052's
hook deliberately drops positional `args`. The pino line therefore carries the string
`NoTenantMembershipError` and nothing else. Not the message, not the stack, not the user.

**What happens to an `APIError`.** `dispatchAuthEndpoint` returns `{ response: e, status:
e.statusCode }`, and `toResponse` renders `e.body` as JSON with that status
(`better-call/dist/to-response.mjs:127-131`). That is the shape every row in
`auth-tokens.md`'s error table already has: `{ message, code }`, status from the constant.

## Decision

**No failure our code raises inside Better Auth's call path leaves it as anything other than
an `APIError`. `definePayload` is the first site; `databaseHooks.user.after` is the second.**

### The mint leg, AC-4

`definePayload` catches `NoTenantMembershipError` and rethrows:

```ts
throw new APIError('FORBIDDEN', {
  message: 'This account has no tenant membership, so no access token can be issued.',
  code: 'NO_TENANT_MEMBERSHIP',
});
```

Nothing else is caught. A `pg` failure inside `withMembershipLookup` is not a membership
absence and must not be reported as one; it falls through to the empty 500, which is the
correct answer for an unknown fault and is what `NoTenantMembershipError`'s existence as a
distinct class is for.

**What the caller sees:** `403 {"message":"This account has no tenant membership, so no
access token can be issued.","code":"NO_TENANT_MEMBERSHIP"}` on `GET /api/auth/token`.

**403, not 401.** The session is valid and the credential is not the problem, so telling the
BFF to re-authenticate sends it into a loop that cannot terminate. `auth-tokens.md`'s
invariant 4 draws the same line between `token_expired` and `unauthenticated` for the same
reason: the status has to tell the client which of two opposite responses is correct.

**A Better Auth-native body, not an `ErrorEnvelope`.** The mount sits outside the Nest graph
so `ApiExceptionFilter` never sees it, `auth-tokens.md` records that these bodies are Better
Auth's native shape, and `auth-contracts.md` invariant 5 says `ERROR_CODES` is append-only
and a shape that appears to need a missing code is a finding rather than an edit. So the
code is a SCREAMING_SNAKE string in better-auth's own vocabulary, and TASK-008 maps it at
the web client boundary along with the other eight.

### `disableSettingJwtHeader: true`

The `jwt` plugin option is set. Three reasons, and the first decides it.

A membership-less account would otherwise fail `GET /get-session` as well as `GET /token`.
Those are opposite answers: "you have a session" is true and must be answerable, and "you
may have a token" is false. Failing both collapses the distinction and leaves the BFF unable
to tell a signed-out visitor from a broken account.

Second, nothing in this repository reads `set-auth-jwt`. Grepped `apps/web/src`: no
occurrence. `auth-tokens.md`'s endpoint table names `GET /api/auth/token` as the mint and
says nothing about a header on `get-session`.

Third, it removes a second, undocumented mint path from the surface. A token minted as a
side effect of a session read is a token nobody's test covers.

### The signup leg

`databaseHooks.user.after`'s failure is raised the same way, as
`APIError('INTERNAL_SERVER_ERROR', { message, code: 'TENANT_PROVISIONING_FAILED' })`.
ADR-0054 holds the reasoning and the message.

### The rule, stated for the appenders

Any `hooks.before` entry added later throws `APIError` and nothing else. ADR-0013 established
this for the rate-limit hook after F-228 (`dispatch.mjs:86-89` rethrows a non-`APIError`,
turning a `TypeError` into an unauthenticated 500 generator). This ADR extends it from that
one hook to every place our code runs inside the mount, and `auth-config-surface.md` states
it as a contract obligation on `AuthBeforeHook`.

## Alternatives considered

| Option | Pros | Cons | Why not |
|---|---|---|---|
| Let `NoTenantMembershipError` propagate; accept the empty 500 | No code. The primary stop ADR-0015 names still works: no token is issued, which is literally all AC-4 requires | AC-4's own words are "the caller receives an error rather than a token", and a body-less 500 is what `apiClient` maps to `internal_error` with nothing to branch on. The stack also reaches stdout raw through `better-call`'s `console.error`, outside every censoring mechanism ADR-0028 claims is the only one | It satisfies AC-4 on a technicality and violates ADR-0028 on the way |
| `onAPIError: { onError: (e, ctx) => ... }` on the betterAuth config, mapping errors centrally | One place, covers every error from every route including ones we did not write. Pre-empts better-auth's own logging branch (`api/index.mjs:194-197`) | It cannot change the response: better-auth's `onError` returns `void`, and better-call only uses a returned `Response`. So it fixes the logging and leaves the empty 500. It also puts every dependency-raised message, including `origin-check.mjs:110`'s attacker-controlled bytes, on a path we then have to censor, which ADR-0052 deliberately declined to widen | It is the right tool for the logging half and no tool at all for the response half. Named because it is the obvious next reach when the logging gap bites |
| `onAPIError: { throw: true }` so errors escape to Express | The mount's errors would reach an Express error handler we control, and could be shaped into `ErrorEnvelope` | It changes the behaviour of every error on the auth surface, including the eight bodies `auth-tokens.md` pins verbatim and TASK-008 already maps. Those are approved, measured shapes in a frozen contract | Rewrites a frozen contract's error table as a side effect of fixing one route |
| Return a payload with a sentinel `tid` and let `AuthGuard` reject it | No error inside the library at all. The guard's claim-shape check already exists as ADR-0015's backstop | It issues a signed token for an account with no tenant, which is the exact thing AC-4 forbids in as many words, and GC-D fixes the claim set so a sentinel is not in it. The token would also be valid to anything that verifies the signature without checking `tid` | Contradicts the acceptance criterion it is trying to satisfy |
| Leave `set-auth-jwt` on, and accept that `get-session` fails for membership-less accounts | One fewer option key. `get-session` failing is arguably honest: the account is broken | The BFF cannot then distinguish "no session" from "session, but broken account", and both render as signed-out. The header is also a mint path with no test and no contract row | Costs a distinction the client needs, to keep a feature nothing uses |

## Consequences

### Positive

- AC-4's mint leg has a real, testable answer: a status, a code and a body, not the absence
  of a token.
- One rule covers `definePayload`, `databaseHooks.user.after` and every future `hooks.before`
  entry, so the appenders in item 1b inherit it from a contract rather than rediscovering
  F-228.
- `disableSettingJwtHeader: true` removes an undocumented second mint path, so `GET /token`
  is the only place a token is issued and the only place that needs coverage.
- A membership-less account can still be signed out, because `get-session` and `sign-out`
  keep working.

### Negative / accepted cost

- **`NO_TENANT_MEMBERSHIP` and `TENANT_PROVISIONING_FAILED` are two codes that are not in
  `auth-tokens.md`'s error table**, which is a frozen contract that says it records every
  shape. TASK-008 maps eight rows today and will need ten. The amendment is escalated below
  and is not made here.
- **The empty-500 path still exists for everything else.** A `pg` failure in the membership
  lookup, a decrypt failure in `signJWT` (ADR-0057), an adapter fault: all still answer with
  a null body and write their stack through `better-call`'s `console.error`. This ADR closes
  the two sites our code owns and leaves the class open, which is the honest bound on it.
- **`console.error` inside `better-call` is a log channel ADR-0052 does not bind and cannot
  reach.** ADR-0052's "one censoring mechanism becomes true again from the moment Better Auth
  mounts" is not quite true: it is true for better-auth's logger and false for better-call's
  fallback. Recorded here because ADR-0052 is where a reader will look and it does not say so.
- **`403` for a membership-less account is a status no screen renders.** TASK-012's signup
  and login screens have no copy for it, because the state is only reachable through
  ADR-0054's residue. The user sees a generic error until someone writes one.
- **A fixed message means the operator cannot tell which user hit it from the response.** The
  log line carries `code` and the error fields, and correlating them needs a timestamp,
  because nothing carries a request id across the mount.

### Follow-ups this creates

- **Escalated to Juano: `auth-tokens.md`'s "Error bodies, verbatim from 1.6.26" table needs
  two rows**, `403 NO_TENANT_MEMBERSHIP` on `GET /api/auth/token` and `500
  TENANT_PROVISIONING_FAILED` on `POST /api/auth/sign-up/email`. It is a frozen foundation
  contract and this ADR does not edit it.
- **TASK-003's card does not mention `disableSettingJwtHeader`.** Its `Approach` names only
  `expirationTime` and `definePayload` under the `jwt` plugin. The key is required by this
  decision and belongs in the card's plugin block.
- TASK-003's `mint-refuses-without-membership.int-spec.ts` asserts the status, the `code` and
  that the response body carries no `token` field. It should also assert that
  `GET /get-session` still answers 200 for the same user, which is what pins
  `disableSettingJwtHeader`.
- TASK-008 gains two rows in its Better Auth error mapping.
- Item 1b's hook authors are bound by `auth-config-surface.md`'s `AuthBeforeHook` obligation
  rather than by this ADR, because they will not read it.
