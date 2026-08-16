---
id: ADR-0059
slug: identity-membership
title: The composed config declares its origin, its cookie policy and its session lifetime, because every one of them is otherwise taken from the request or from NODE_ENV
status: accepted
supersedes: null
amends: ADR-0013
date: 2026-08-16
---

## Context

The wave-2 security pass executed four probes against the pinned `better-auth@1.6.26` and
the live database. Three of them found the same defect in three places: a security-relevant
value that this design never states, which the library then derives from the incoming
request or from `NODE_ENV`. Each was verified again here against the package.

**`baseURL` is unset, so the issuer is whatever the caller's Host header says.**
`create-context.mjs:63` computes `getBaseURL(options.baseURL, options.basePath)` and `:64`
warns when it does not resolve. `:85` then sets `options.baseURL` to `""`. Per request,
`auth/base.mjs:19-27` re-derives a base URL from the request when `ctx.options.baseURL` is
falsy, and `sign.mjs:16-20` computes `defaultIss` and `defaultAud` from it. The auditor
executed it: one session cookie, two requests, `Host: api.internal` returned a token with
`iss="http://api.internal"`, `Host: evil.test` returned `iss="http://evil.test"` and
`aud="http://evil.test"`, same signature, same `kid`, same `tid`, both valid.

`shortkitJwtClaimsContract` types `iss` and `aud` as `z.string().min(1)`, so an
attacker-chosen issuer is a contract-conformant token. `auth-tokens.md` step 4 has
`AuthGuard` compare `iss` and `aud` against "the configured API base URL", which is the
check that catches it, and nothing in this initiative configures that value on either side.

`BETTER_AUTH_URL` occurs in `apps/api/test/support/auth-fixture.ts:85` and nowhere else.
Not in `docker-compose.yml`, not in any `.env.example`, not in any ADR or card. So the one
tier that exercises the mount sets it, and `pnpm dev` and the compose stack do not. The
suite is green on a configuration the developer stack never runs.

**The session cookie's `Secure` flag falls back to `NODE_ENV`.** `cookies/index.mjs:21`
resolves the secure prefix as `advanced.useSecureCookies ?? (dynamic protocol) ?? (baseURL
starts with https://) ?? isProduction`. With `baseURL` unresolved the last operand decides,
and the composed instance issued `better-auth.session_token=...; Max-Age=604800; Path=/;
HttpOnly; SameSite=Lax` with no `Secure` and no `__Secure-` prefix. It also issued a second
cookie, `better-auth.session_data`, which no contract in this repository mentions.

That is GC-B's own hazard again, in the same shape ADR-0051 found it: a behavioural choice
keyed on `NODE_ENV`, inside `node_modules`, where the rule this project wrote for itself
cannot reach. The session token is a full credential through the `bearer` plugin, which
mints JWTs from it.

**`session.expiresIn` is inherited.** `create-context.mjs:52` and `:147` default it to
`3600 * 24 * 7`, 604800 seconds. `auth-tokens.md`'s cookie table gives `sk_rt` a `Max-Age`
of 2592000. The cookie outlives the credential behind it by 23 days.

**`WEB_APP_ORIGINS` has no owner.** `auth-tokens.md` requires `auth.config.ts` to pass
`trustedOrigins` from it and requires a unit test asserting it. The variable occurs in no
env file, no compose file and no card's `paths`. The auditor executed the failure and it is
loud, not silent: a cross-origin `POST` answers `403 INVALID_ORIGIN`, so browser CSRF is
genuinely blocked today. The risk is the remedy. An implementer who meets a 403 on every
local login reaches for the value that clears it, and `matchesOriginPattern`
(`auth/trusted-origins.mjs:18-23`) treats a pattern containing `*` with no `://` as a
wildcard over the **host**, so a bare `*` trusts every origin on the internet and nothing
anywhere reports it.

**Juano ruled on 2026-08-16 that `trustedOrigins` is TASK-003's this wave.**

## Decision

**Every value above is stated on the composed config and fed by a declared binding.
`BETTER_AUTH_URL` and `WEB_APP_ORIGINS` join `BETTER_AUTH_SECRET` as bindings asserted at
boot without consulting `NODE_ENV`.**

### The bindings

| Variable | Values | Unset binds to | Assertion |
|---|---|---|---|
| `BETTER_AUTH_URL` | an absolute origin, no path, query or fragment. **`https:` for any host; `http:` only for a loopback host** | **nothing. Boot fails** | unconditional, every environment |
| `WEB_APP_ORIGINS` | comma-separated absolute origins. A `*` or `?` is permitted only inside a host label and never in the final two labels (rules below) | **the empty list, which is legal** | unconditional on entries that are present |

`BETTER_AUTH_URL` binds to nothing, for ADR-0051's reason: it is the value that decides both
the issuer and the cookie's `Secure` flag, and a default would be a default for both.

`WEB_APP_ORIGINS` unset is a legal state and is what the integration tier runs on: the
resolved trusted list always contains the API's own origin (`context/helpers.mjs:61-70`,
and `auth-tokens.md` records that an array here extends the default rather than replacing
it). So an unset value costs a local developer a 403 on the login screen and costs the test
suite nothing. It is not a boot failure, and the boot assertion applies only to the entries
that are present.

### On the composed config

```ts
baseURL: betterAuthUrl(),                       // never inherited from the request
trustedOrigins: webAppOrigins(),                // extends the API's own origin
advanced: { useSecureCookies: betterAuthUrl().startsWith('https://') },
session: { expiresIn: SESSION_LIFETIME_SECONDS },   // 604800, stated
plugins: [
  jwt({
    jwt: {
      issuer: betterAuthUrl(),
      audience: betterAuthUrl(),
      expirationTime: `${String(ACCESS_TOKEN_LIFETIME_SECONDS)}s`,
      definePayload: /* ... */,
    },
  }),
  bearer(),
],
```

**`baseURL` and `jwt.issuer`/`jwt.audience` are both set, which is deliberate redundancy.**
Setting `baseURL` alone fixes today's derivation, and `sign.mjs:18-20` would still fall back
to `baseURLOrigin` if a later release changed how `baseURL` resolves. Setting the two claim
keys alone leaves the cookie flag and the trusted-origin list on the request-derived value.
Each key closes a different path to the same value, and both are one identifier.

**`useSecureCookies` is derived from the declared URL, not from `NODE_ENV` and not from a
second binding.** One binding decides the scheme, and the cookie policy follows it. A second
binding could disagree with the first, and the disagreement would be a non-Secure cookie on
an https deployment with nothing failing.

**`session.expiresIn` is 604800, the library's default, stated rather than inherited.** The
value does not change; what changes is that it is decided. Making it longer to match
`sk_rt`'s 2592000 would lengthen a credential to fit a cookie, which is the wrong direction.
`sk_rt`'s max-age is in a frozen foundation contract and shortening it is escalated below.

### The boot assertions

Both go in `apps/api/src/auth/boot-assertions.ts` beside
`assertBetterAuthSecretConfigured`, in ADR-0058's shape: no database, so no retry budget, no
backoff and no verdict prefix, and one `BootPrecondition` member each.

```ts
export function assertBetterAuthUrlConfigured(env: NodeJS.ProcessEnv): void;
export function assertWebAppOriginsConfigured(env: NodeJS.ProcessEnv): void;
```

`assertBetterAuthUrlConfigured` refuses when the variable is unset or empty, when it does not
parse as a URL, when its scheme is neither `http:` nor `https:`, and when it carries a path,
a query or a fragment. A trailing slash is normalised rather than refused, because
`new URL('http://x').origin` drops it anyway and refusing it is a boot failure over a
character.

**And one rule about the host, which is the rule that makes this binding worth having.**
Added 2026-08-16 after round 3.

> **`https:` is permitted for any host. `http:` is permitted only when the host is a loopback
> literal: `localhost`, an address in `127.0.0.0/8`, or `[::1]`.**

Without it the binding permits exactly the state it was written to close. Executed:
`BETTER_AUTH_URL=http://api.example.com` yields `better-auth.session_token` with
`secure: false` and no `__Secure-` prefix, identical to the round-1 finding, **with every
assertion green**, because a value is set. `useSecureCookies` is derived from this one string,
so no other check can catch it.

The compose default is the thing that teaches the value's shape. An operator copying
`http://localhost:3001` to a real host keeps the scheme, and the session credential then
travels in the clear with the boot assertion green, the unit test green and the `compose` job
green. This rule turns that copy into a boot refusal naming the rule.

**It reads no `NODE_ENV`**, so GC-B holds: the discriminator is the host in the declared value,
not the environment. It leaves the compose default and every local flow working unchanged,
because `localhost` is a loopback literal.

**What it does not cover**, stated rather than implied: a host that resolves to a loopback
address without being a loopback literal, a reverse proxy terminating TLS and speaking `http`
inward to a non-loopback host, and any tunnelling setup pointing a public name at a local
process. The first two are the cases where an operator legitimately wants `http:` on a
non-loopback host, and both are a boot refusal under this rule. That is deliberate: the
correct value in a TLS-terminating deployment is the **public** `https:` origin, because that
is what the browser sees and what `iss`, `aud` and the cookie's `Secure` flag must describe.

`assertWebAppOriginsConfigured` refuses an entry that does not parse as an origin, and
applies two rules to wildcards. An empty list passes.

**Corrected 2026-08-16 after round 2. The first version of this rule admitted
`https://*.vercel.app`, which is the one entry the frozen contract names unacceptable.** It
said a wildcard is permitted "where a non-wildcard registrable host remains", and
`vercel.app` is not a wildcard, so the entry passed. `auth-tokens.md:158-162` rules it out in
as many words: "not an acceptable entry: it trusts every application on the platform", with
`https://shortkit-*.vercel.app` named as the supported preview form. Executed:
`matchesOriginPattern('https://evil.vercel.app', 'https://*.vercel.app')` is `true`, and
end-to-end a cross-origin `POST /api/auth/sign-up/email` from `Origin:
https://evil.vercel.app` returned **200**. The assertion added to close a wildcard hole
admitted a narrower one.

**The two rules, which are the frozen contract's rule rather than a paraphrase of it:**

1. **No host label may consist entirely of wildcard metacharacters.** This refuses `*`,
   `https://*`, `https://*.vercel.app` and `https://?.example.com`, and admits
   `https://shortkit-*.vercel.app`, where the wildcard is inside a label.
2. **No wildcard metacharacter may appear in the final two labels.** This forces the
   registrable domain to be literal, so an entry can widen the subdomain it trusts and can
   never widen the domain. It refuses `https://shortkit-*.app` and `https://app.example.co?`.

**The metacharacters are `*` and `?`, both of them.** `trusted-origins.mjs:18` enters
wildcard mode on `pattern.includes("*") || pattern.includes("?")`, and `?` is a
single-character wildcard: executed, `https://app.example.co?` trusts
`https://app.example.com`. The first version of the rule named only `*`.

**Rule 2 is an approximation and its limit is stated rather than hidden.** "The final two
labels" is a stand-in for "the registrable domain", which is only correct for single-label
public suffixes. Under a multi-label suffix it is wrong in the permissive direction:
`https://ex*.co.uk` has its wildcard outside the final two labels and passes, while matching
every registrable domain under `.co.uk`. Getting this right needs a public-suffix list, which
is a dependency and a data file that go stale, for a case this repository does not have.
The one wildcard entry this repository needs is `https://shortkit-*.vercel.app`.

**The unit test asserts the refusal of `https://*.vercel.app` by name**, not only of the bare
`*`. Naming the entry the contract names is what stops the rule drifting back to the version
that admitted it.

**`assertWebAppOriginsConfigured` is a boot assertion and not only a unit test**, which is
one step beyond what the audit asked for. The unit test proves the composed config is right
in CI. The boot assertion is what stops the value that clears a developer's 403 from
reaching a running process, and that value is written in a shell or an env file that no test
reads. Both exist; the audit's unit test is in the contract's spec obligations.

### Where the two bindings are declared

**Ruled by Juano, 2026-08-16: TASK-003 declares both, in wave 2, in the same wave as the
assertions that read them.** Same ruling shape as F-034 for TASK-018. The card's `paths`
widen to these two entries in `docker-compose.yml` and `apps/api/.env.example`; TASK-009
keeps every other entry in both files.

**Both carry a compose default, and that is the difference from `BETTER_AUTH_SECRET`.**

```yaml
# docker-compose.yml, the api service environment block
BETTER_AUTH_URL: ${BETTER_AUTH_URL:-http://localhost:3001}
WEB_APP_ORIGINS: ${WEB_APP_ORIGINS:-http://localhost:3000}
```

`127.0.0.1:3001:3001` and `127.0.0.1:3000:3000` are the published ports, so those two values
are the correct ones for the stack and both are loopback origins.

**The loopback rule is what makes the default safe wherever it goes, not just where it is.**
Added 2026-08-16 after round 3. The confidentiality argument below is sound and it is not the
argument that matters: `BETTER_AUTH_URL`'s risk is not that its value is published, it is that
its **scheme silently decides whether the session cookie is `Secure`**. A committed
`http://localhost:3001` is a template, and the rule above is what stops the template being
copied to `http://api.example.com`. With the rule, the default is inert outside a loopback
stack. Without it, this ruling reverses the sentence three sections up, "a default would be a
default for both", and buys back nothing.

**Neither is a credential, which is the whole reason they may carry a default where
`BETTER_AUTH_SECRET` may not.** ADR-0051 removed the secret's default because publication is
disqualifying for a signing key. Publishing `http://localhost:3001` discloses nothing and
grants nothing. The file already carries fixture defaults for four role passwords, so a
loopback URL is strictly less dangerous than what is committed beside it, and
`BETTER_AUTH_SECRET` stays the only variable in the file with no default, which is a sentence
ADR-0051 relies on.

**This dissolves the sequencing problem this ADR escalated.** With defaults,
`docker compose up` on a fresh clone still works and the `compose` job goes green the day
TASK-003 lands, with no export and no `.env`. The wave-2 declaration is a compose edit and a
documentation edit, not a new parse-time failure. Only `pnpm dev` requires the developer to
act.

**`apps/api/.env.example` does not exist yet.** It is a TASK-009 wave-4 deliverable, so
TASK-003 creates it with these two entries and nothing else, and TASK-009 fills in the rest in
wave 4. The alternative, putting them in the repository-root `.env.example`, is wrong: that
file is Compose's interpolation source and holds role passwords, and these two are read by the
API process rather than by Compose.

**What a developer who has set neither is told.** Compose users are told nothing, because the
defaults are correct for the stack. A `pnpm dev` user gets the boot refusal, which names the
variable, the rule and the remedy, and exits before the process serves:

```
BETTER_AUTH_URL is not set. It is the origin this API issues and verifies tokens for, and
it decides whether the session cookie is Secure. Unset, better-auth derives both from the
incoming request's Host header. Export BETTER_AUTH_URL=http://localhost:3001 for local
development. See apps/api/.env.example and ADR-0059.
```

And the refusal a copied default produces:

```
BETTER_AUTH_URL is http: on a non-loopback host. http: is permitted only for localhost,
127.0.0.0/8 or [::1], because this value decides whether the session cookie carries Secure,
and a non-Secure session cookie is the credential in cleartext. Use the https: origin the
browser sees, even when TLS terminates at a proxy. See ADR-0059.
```

**The README tells them to export rather than to write a root `.env`**, which is ADR-0051's
established rule for this class of variable: `scripts/check-compose-stack.sh:191-196` refuses
to run while a root `.env` exists. `apps/api/.env.example` is a template to copy to
`apps/api/.env` or to read and export from; it is not read by Compose.

### What the spec asserts

`auth.config.spec.ts` gains three assertions to the five it already carried:

- a minted token's `iss` and `aud` equal `BETTER_AUTH_URL`, **and do not change when the
  request carries a different `Host`**. The second half is the one that would have caught
  this.
- the session cookie's resolved attributes off `$context.authCookies`: `httpOnly`,
  `sameSite: 'lax'`, `path: '/'`, and `secure` following the configured scheme.
- `trustedOrigins` contains every entry of `WEB_APP_ORIGINS`, and no entry is `*` or a
  pattern whose host part is a bare wildcard.

## Alternatives considered

| Option | Pros | Cons | Why not |
|---|---|---|---|
| Set `baseURL` only, and let `iss`/`aud`/`useSecureCookies` derive from it | One key. Every derived value follows automatically, and the library is designed for exactly this | Three security properties then depend on one derivation staying the same across releases, and `sign.mjs:18-20`'s `?? baseURLOrigin` fallback is the kind of line that changes. It also leaves nothing in the config naming the issuer, so a reader checking what `AuthGuard` compares against has to trace three files | Correct today and undefended against a minor release. The redundancy costs one identifier |
| Set `jwt.issuer`/`jwt.audience` only, leaving `baseURL` unset | Fixes the executed finding exactly. Smallest diff | Leaves `useSecureCookies` on the `NODE_ENV` fallback and leaves the trusted-origin list derived per request from the Host header. Two of the three findings survive | Closes one path to the value and leaves two |
| `useSecureCookies: true`, unconditionally | Never a plaintext session cookie, in any environment, with no binding to get wrong | `Secure` cookies over `http://localhost` work in current Chrome and Firefox and are not guaranteed by the cookie spec, so a local stack's login depends on browser behaviour rather than on configuration. It also renames the cookie: `useSecureCookies` drives the `__Secure-` **name** prefix (`cookies/index.mjs:20,30`), so flipping it invalidates every outstanding session cookie by name | Right instinct, and it makes local development depend on a browser's tolerance rather than on a declared value |
| A second binding, `COOKIE_SECURE=true\|false` | Explicit. No derivation at all, and an operator can force it | Two bindings that can disagree, and the disagreement is a non-Secure cookie on an https deployment with every check green. ADR-0050 refused a fallback for `DATABASE_AUTH_URL` on the same reasoning: a second way to say the same thing is a way to say it wrong | One binding, one answer |
| Leave `session.expiresIn` inherited and change `sk_rt`'s max-age to 604800 instead | One number in one place, and `auth-tokens.md` becomes true | `auth-tokens.md` is a frozen foundation contract and its cookie table is ADR-0014's. Editing it is Juano's, and this ADR would then depend on an edit it cannot make | Both are needed. This ADR does the half it owns and escalates the other |
| Make `WEB_APP_ORIGINS` a required binding like `BETTER_AUTH_URL` | Symmetric. Nobody meets a 403 without having been told to set it | The integration tier runs with it unset and passes, because the API's own origin is always trusted, so requiring it breaks a green suite to protect against a value nobody has set yet. It also fails a developer's boot for a variable that only affects a browser flow | Unset is a real, safe, tested state. The refusal belongs on bad entries, not on absence |
| Reject wildcards in `WEB_APP_ORIGINS` entirely | No pattern to get wrong. Every entry is an exact origin | `auth-tokens.md` records that production and preview need two entries and that `https://shortkit-*.vercel.app` is the supported preview form. Banning `*` outright bans the documented deployment shape | The contract already fixes the safe pattern; the assertion enforces its boundary rather than removing it |

## Consequences

### Positive

- A token's `iss` and `aud` are fixed by configuration, so `AuthGuard` step 4 has a constant
  to compare against and a caller cannot choose the issuer by choosing a Host header.
- The session cookie's `Secure` flag stops depending on `NODE_ENV`, which is the rule GC-B
  states and the third place this initiative has found the library breaking it.
- Four values that were inherited are now decided and asserted, and the spec's silent-fact
  list grows from five to eight.
- The wildcard that would trust the internet fails boot rather than passing review.
- `session.expiresIn` and `sk_rt` are reconciled in the direction that does not lengthen a
  credential.

### Negative / accepted cost

- **Two more required environment variables in one initiative, making four.** A developer who
  pulls gets two new boot failures on top of `DATABASE_AUTH_URL` and `BETTER_AUTH_SECRET`,
  and every one of them reads as a regression before it reads as a protection. `BETTER_AUTH_URL`
  is the third variable with no default in `docker-compose.yml`.
- **`BETTER_AUTH_URL` is a fourth thing that must be right for tokens to verify**, alongside
  the secret, the `jwks` row and the DSN. Setting it to the wrong origin mints tokens that
  `AuthGuard` rejects at step 4 with `unauthenticated`, and the symptom is a login loop
  rather than a boot failure.
- **The cookie name depends on the scheme.** Moving a deployment from http to https renames
  `better-auth.session_token` to `__Secure-better-auth.session_token`, so every outstanding
  session is signed out by the rename. That is correct and it is a migration nobody will
  expect.
- **`better-auth.session_data` is a second cookie no contract describes** and this ADR does
  not remove it. It is set when `session.cookieCache` is enabled and carries an encrypted
  copy of the session; it is recorded in the config-surface contract and left alone, because
  turning it off is a performance decision this wave has no basis for.
- **`assertWebAppOriginsConfigured` refuses values that are legal in the library.** A bare
  `*` and `https://*.vercel.app` are both supported patterns upstream and we refuse both, so
  a future legitimate need for one is a boot failure and an ADR rather than a config change.
  That is the intent and it is still a divergence from the dependency.
- **Rule 2 is unsound under a multi-label public suffix.** `https://ex*.co.uk` passes and
  matches every registrable domain under `.co.uk`. Closing it needs a public-suffix list,
  which is a dependency and a data file that goes stale, for a case this repository does not
  have. Stated rather than closed, and it is the residual most likely to matter if this
  product ever deploys under a country-code suffix.
- **Two committed default values now sit in `docker-compose.yml` for the auth surface.**
  Neither is a credential and both are loopback, so the exposure is nil, but the file's
  pattern of "fixture defaults for everything except the signing key" now has two more
  entries and the next variable's author has one more precedent for adding a default.
- **The loopback rule refuses a configuration some deployments legitimately want.** A reverse
  proxy terminating TLS and speaking `http` to a non-loopback backend cannot set
  `BETTER_AUTH_URL` to its internal address, and the refusal message is the only thing telling
  the operator that the public `https:` origin is the right value. That is correct and it will
  read as the tool being wrong the first time someone meets it.
- **"Loopback literal" is a string test, not a resolution test.** A hostname that resolves to
  127.0.0.1 is refused under `http:`, and a public name tunnelled to a local process is
  refused too. Resolving the host at boot would be a DNS call on the boot path with a failure
  mode ADR-0058 deliberately kept off it.
- **The Host-header assertion in the spec is the only thing keeping this closed.** If a later
  author removes `baseURL` because "the library derives it", the two claim keys still hold
  and the cookie flag silently reverts. Only the cookie assertion catches that half.
- **TASK-003's surface grows for the fifth time**, gaining two boot assertions, two bindings
  and three spec assertions.

### Follow-ups this creates

- **TASK-003's card needs `baseURL`, `trustedOrigins`, `advanced.useSecureCookies`,
  `session.expiresIn` and `jwt.issuer`/`jwt.audience` in its plugin and config block**, plus
  the two new assertions in `boot-assertions.ts`. Card text is Juano's this round.
- **Closed 2026-08-16 by Juano's ruling: TASK-003 declares both bindings in wave 2**, in
  `docker-compose.yml`'s `api` service and in a new `apps/api/.env.example`. See "Where the
  two bindings are declared" above for the exact entries. Because both carry a compose
  default, the sequencing problem this bullet escalated does not arise: the `compose` job goes
  green with nothing exported.
- **`apps/api/.env.example` is created by TASK-003 with two entries.** TASK-009 owns the rest
  of the file in wave 4 and will add to a file it did not create, which is the same shape
  TASK-004 already has with `boot-assertions.ts`.
- **Escalated to Juano: `auth-tokens.md`'s cookie table gives `sk_rt` a `Max-Age` of
  2592000 against a 604800-second session.** The BFF holds a cookie for 23 days after the
  credential inside it dies. It is ADR-0014's table in a frozen contract.
- **Escalated to Juano: `auth-tokens.md`'s claim table and `shortkitJwtClaimsContract` type
  `iss` and `aud` as free strings.** Now that both are configured constants, the contract
  could pin them, which would make an attacker-chosen issuer fail parsing as well as failing
  step 4. Not changed here: it is `packages/contracts`' shape and TASK-001's.
- TASK-005's `AuthGuard` step 4 compares against `BETTER_AUTH_URL`. Its card says "the
  configured API base URL" and now has a binding to name.
