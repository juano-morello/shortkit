---
id: ADR-0014
slug: launch-core
title: Next.js is a backend-for-frontend; tokens live in httpOnly cookies the browser never reads
status: accepted
supersedes: null
date: 2026-08-04
---

## Context

TASK-012 states the requirement flatly: never place a JWT or refresh token anywhere
client JavaScript can read it. That rules out `localStorage`, `sessionStorage`, a
JS-readable cookie, and any in-memory store a script on the page can reach.

The two deployables sit on different registrable domains. Vercel serves the dashboard
on `*.vercel.app`, Fly serves the API on `*.fly.dev`. A cookie cannot be shared across
them at any `SameSite` setting, and the apex domain that would let them share a parent
is an unresolved open question owned by Juano, blocking three TASKs. Whatever this
design is, it has to work before that question is answered.

The web app has to authenticate from three places: server components rendering on
Vercel, client components fetching after hydration, and route handlers. TASK-008's
`apiClient` is the one call path all of them use.

## Decision

**Next.js proxies every API call. The browser never talks to Fly.**

```
browser --(same-origin, httpOnly cookies)--> Next.js on Vercel --(Bearer JWT)--> NestJS on Fly
```

**Two cookies, both `httpOnly; Secure; SameSite=Lax; Path=/`, set on the Vercel
origin:**

| Cookie | Holds | Max-Age |
|---|---|---|
| `sk_at` | the Better Auth JWT | 300 s, matching the token |
| `sk_rt` | the Better Auth session token, used to mint a new JWT | 30 d |

`httpOnly` is what satisfies TASK-012. `SameSite=Lax` is available because the cookie
is same-origin with the page.

**`apps/web/app/api/bff/[...path]/route.ts`** forwards to
`${API_BASE_URL}/api/${path}`, attaching `Authorization: Bearer <sk_at>`. It copies
method, headers on an allowlist, and body. It never forwards cookies upstream.

**Sign-in flow.** The browser posts credentials to `/api/bff/auth/sign-in/email`. The
route handler calls Nest, receives the Better Auth session token, calls
`/api/auth/token` to mint a JWT, and sets both cookies with `Set-Cookie` on its own
response. Better Auth's own `Set-Cookie` for the Fly origin is dropped.

**Refresh.** Upstream 401 with `code: "token_expired"` makes the route handler mint a
new JWT from `sk_rt`, set `sk_at`, and retry the original request once. Two
consecutive failures clear both cookies and return 401, and `requireAuth()` sends the
user to `/login`. Refresh happens in the route handler, so a burst of parallel client
fetches can each trigger one; a per-request in-flight map collapses them.

**Server components skip the proxy.** `serverApiClient()` reads `sk_at` from
`cookies()` and calls Fly directly from the Vercel function. Same token, same
`Authorization` header, one hop instead of two. It cannot set cookies during render, so
on `token_expired` it throws a redirect to a route handler that refreshes and bounces
back.

**Sign-out.** The route handler calls Better Auth sign-out upstream, which revokes the
`jti` per ADR-0013, then clears both cookies with `Max-Age=0`. AC-21 passes on the
cookie clear alone; revocation closes the replay window.

**`useSession()` reads a non-sensitive projection.** A `GET /api/bff/session` returns
`{ user: { id, email, emailVerified }, status }`. The client never sees a token, only
who is signed in.

**CSRF.** The proxy accepts a mutating request only when `Origin` matches the
deployment's own origin. `SameSite=Lax` already blocks cross-site form posts; the
`Origin` check covers the rest.

**The proxy forwards the browser's address, authenticated by a shared secret.** Added
2026-08-04, found while verifying F-030. Because the browser never talks to Fly, the API
sees Vercel's egress address for every user, so anything keyed on the client IP collapses
into one bucket for the whole product. The proxy adds `X-Shortkit-Client-IP` — sourced
from `x-vercel-forwarded-for` only, never a leftmost list entry (F-035,
`web-api-client.md`) — and `X-Shortkit-Proxy-Auth: <BFF_PROXY_SECRET>`. The API honours
the first only through `resolveRateLimitPrincipal` (F-031, the single trusted-proxy
decision site, normative in `rate-limit.md`): constant-time secret match, forwarded
value must parse as an IP, unset secret or absent header disables the branch outright
(F-033). A mismatch falls back to `Fly-Client-IP` **with signal**:
`bff_proxy_auth_mismatch_total` plus a once-per-minute warn. In production the API
asserts at boot that `BFF_PROXY_SECRET` is set — "set" is locally checkable, "matches"
is not, and failing boot on a mismatch would take down the redirect surface (GC-8).
Details and the reason this does not weaken F-009 are in `rate-limit.md`.

**The proxy forwards the browser's `Origin` on mutating requests, and the API trusts the
dashboard's origins explicitly.** Added 2026-08-08, found by TASK-009's red-test probes
(F-233). `better-auth@1.6.26` answers `403 MISSING_OR_NULL_ORIGIN` to a state-changing
request to `/api/auth/*` that carries no `Origin`, and a server-side `fetch` from a route
handler carries none. Under this topology every signup, sign-in and sign-out is such a
request. The whole credential surface would return 403 in production while every test
that speaks to the API directly passed, and the code names the auth library while the
cause is the proxy.

Two lines close it, one on each side.

The proxy adds `origin` to its forwarded-header allowlist **for mutating methods only**,
forwarding the inbound value verbatim. It already refuses a mutating request whose
`Origin` is not the deployment's own origin, so the value that reaches Fly is the
deployment origin or the request never left Vercel. The proxy never synthesises or
defaults the header. `GET` needs none: Better Auth skips the check on `GET`, which covers
the refresh path and `GET /api/auth/token`.

The API passes `trustedOrigins` from `WEB_APP_ORIGINS`, a comma-separated server-only
variable listing every origin the dashboard is served from. An array passed there extends
the default rather than replacing it, so the API's own origin stays trusted and the
integration suite keeps passing with the variable unset. Production and each preview host
are separate entries; a bare `https://*.vercel.app` is not acceptable because it trusts
every application on the platform.

Exact matching semantics, the resolved-list behaviour, the error bodies and the
verification record are in `auth-tokens.md`. The header rule is normative in
`web-api-client.md`.

**The signup form collects a name, because the library requires one.** Added 2026-08-08
(F-234). `better-auth@1.6.26` declares the sign-up body with `name: z.string()` inside the
endpoint's own schema, so a body without it returns 400 and no `betterAuth` option relaxes
it. Somebody has to supply the value. The signup screen does: TASK-012 adds a display-name
field to `/signup`, and the invitation-accept screen that also creates an account adds the
same field.

The alternative was a default invented inside the proxy, `name: ''` or the email's local
part. It keeps the form to the two fields AC-16 names, and `name: ""` is accepted by the
pin. It was rejected because it puts a value the user never entered into the user row, and
because a contract that says `name` is optional while the wire requires it is exactly the
divergence F-234 was filed against. Nothing in `launch-core` reads `user.name`:
`SessionUser` is `{ id, email, emailVerified }`. So this buys no feature today, and the
reason to do it is that the API contract and the library's real contract are the same
document.

## Alternatives considered

| Option | Pros | Cons | Why not |
|---|---|---|---|
| Browser calls Fly directly with a cross-site cookie on a shared parent domain (`app.shortkit.app`, `api.shortkit.app`) | One hop; no proxy code; no Vercel function invocations | Needs the apex domain, which is unresolved and blocks three TASKs. It cannot be built or tested today, and `SameSite=None` cookies are the setting browsers keep tightening | Blocked on a question that is not Design's to answer |
| JWT in memory in a React context, refreshed on load | No cookie handling; token never persisted | A token in JS memory is readable by any script on the page, which is exactly what TASK-012 forbids. It also breaks server components, which have no access to client memory | Contradicts an explicit TASK constraint |
| Next.js server actions for every mutation, no proxy route | Idiomatic App Router; no manual header copying | Server actions cannot express arbitrary REST verbs cleanly and would need one action per endpoint, so the shared `apiClient` TASK-008 produces disappears and fifteen frontend TASKs each write their own | Discards the single call path the plan built |
| NextAuth or Auth.js in the web app, Better Auth in the API | Mature session handling on the Next side | Two auth systems and a mapping between them | Absurd complexity for the problem |
| Longer-lived JWT (24 h) with no refresh path | No refresh machinery at all | A stolen token is valid for a day and revocation becomes mandatory rather than best-effort | Trades the entire security posture for less code |

Four more, all for the `Origin` question (F-233):

| Option | Pros | Cons | Why not |
|---|---|---|---|
| Proxy sets `Origin: <API_BASE_URL>`, its own upstream target | No new environment variable at all: the API's own origin is trusted by default, so this works with zero configuration. Verified 200 against the pin | The proxy asserts an origin that is not the request's. Better Auth's check then validates a value the proxy invented, so it stops being an independent check and degrades to "trust whatever the proxy says". A bug in the proxy's CSRF check would no longer be caught anywhere | Forwarding the real value costs one environment variable and keeps a second, genuine check |
| `advanced.disableCSRFCheck: true` on the mount | One line, no header plumbing, no variable | Turns the origin check off for **every** caller, not just the proxy, including anything that reaches `/api/auth/*` directly. It removes a framework security default rather than configuring it, and ADR-0013's own standard for that is a four-reason argument | Disabling a check is not the same as satisfying it, and here satisfying it is two lines |
| `trustedOrigins` as a function of the request, echoing back whatever `Origin` arrives | Preview deployments need no configuration and never break | Trusts every origin, which is the disable above wearing a configuration's clothes | Same objection, less visibly |
| Proxy sends `Origin` on every method including `GET` | One rule, no method branch to get wrong | The proxy's CSRF check does not run on `GET`, so a `GET` would forward an unvalidated attacker-chosen `Origin`. Better Auth ignores it today, which makes it a header we forward for no reason and that a future release may start reading | Forwarding an unchecked value upstream is the shape F-009 exists to forbid |

## Consequences

### Positive

- No script on the page can read a credential, at any point in the lifecycle. TASK-012's
  constraint holds structurally rather than by review.
- The design works today on `*.vercel.app` and `*.fly.dev` and needs no change when the
  apex domain is registered. The apex question stops blocking auth entirely.
- The API stays a plain bearer-token REST service, which is the shape the future MCP
  server needs, so nothing here has to be undone for it.
- Server components authenticate through the same token and the same guard as client
  fetches, so there is one authorization story rather than two.

### Negative / accepted cost

- **Every client-initiated API call crosses Vercel then Fly.** That is one extra
  network hop and a Vercel function invocation per call, adding roughly 20 to 80 ms to
  dashboard requests. The redirect path is untouched, so GC-1 is unaffected, but the
  operator's dashboard is measurably slower than a direct call.
- Vercel function invocations and their bandwidth count against the free tier. At
  portfolio traffic this is comfortable; a real customer base would need watching
  against GC-3's $25 ceiling.
- The proxy route is code nobody else maintains: header allowlisting, body streaming,
  status passthrough, and the refresh-collapse map. A bug there breaks every screen at
  once.
- A 5-minute token means a refresh roughly every 5 minutes per active session, each
  costing an extra upstream round trip. An idle tab open for an hour makes twelve.
- Two cookies and two token lifetimes are two things to get right in the browser
  devtools when debugging a login problem.
- `sk_rt` holds the Better Auth session token, so anyone who obtains it has a 30-day
  credential. `httpOnly` and `Secure` are the whole defence.
- **`WEB_APP_ORIGINS` is a deploy-time list that has to be kept in step with where the
  dashboard is served from.** Get it wrong and every signup and sign-in returns 403
  `INVALID_ORIGIN` while the redirect surface, the API and the dashboard's read paths all
  look healthy. There is no boot assertion on it, unlike `BFF_PROXY_SECRET`, because an
  unset `BFF_PROXY_SECRET` degrades **silently** into one shared rate-limit bucket while
  an unset `WEB_APP_ORIGINS` fails loudly on the first login. Failing boot would take the
  redirect surface down for a fault the login screen already announces, which GC-8 exists
  to prevent. The cost accepted is that the announcement happens in production rather
  than at startup. A boot log of the resolved list and a unit test on the composed config
  are what narrow the gap.
- **Vercel preview deployments each have their own origin, so each needs an entry or a
  prefix wildcard.** Anyone opening a preview and trying to sign in without one gets a
  403. This is new operational work that did not exist when the browser talked to Fly
  directly, and it is a direct cost of the proxy topology.
- **Better Auth's origin check no longer protects `/api/auth/*` against anything the
  proxy lets through.** The proxy validates `Origin` and then forwards it, so the two
  checks read the same value and the proxy's is the one that decides. It is still a real
  second check against a request that reaches Fly by some other route, which is why the
  value is forwarded rather than synthesised, but nobody should count it twice.
- **The signup form has a third field that no acceptance criterion asks for**, and the
  invitation-accept screen has it too. That is scope TASK-012 and TASK-014 carry so the
  contract can match the library exactly.
- **The BFF hides every user behind one address**, so anything the API wants to key on
  the client has to be forwarded and authenticated explicitly. Rate limiting is the case
  this design found; any future per-client control inherits the same problem. A
  `BFF_PROXY_SECRET` mismatch still degrades into one shared bucket rather than failing
  the deploy, but no longer silently: it shows on `bff_proxy_auth_mismatch_total` and a
  once-per-minute warn (F-033), and an unset variable on the Fly side fails boot in
  production.

### Follow-ups this creates

- TASK-008 owns `apiClient` targeting `/api/bff/...`, `serverApiClient()`, `ApiError`,
  `ContractViolationError`, and the mapping of Better Auth's native error bodies onto
  `ErrorEnvelope`.
- TASK-012 owns the proxy route handler, both cookies, the refresh path, `useSession()`,
  and `requireAuth()`.
- TASK-004 keeps `NEXT_PUBLIC_API_BASE_URL` for anything genuinely public and adds
  server-only `API_BASE_URL` **and server-only `BFF_PROXY_SECRET`** (required
  configuration on both deployables; never `NEXT_PUBLIC_*`, never logged). Nothing
  authenticated uses the public one.
- TASK-004 also registers **`WEB_APP_ORIGINS` on the API deployable**, comma-separated,
  server-only, not a secret, listing the production dashboard origin, every preview
  origin or a prefix wildcard covering them, and `http://localhost:3000` in local
  development. Added 2026-08-08 (F-233).
- **TASK-009 passes `trustedOrigins` from `WEB_APP_ORIGINS`** in `auth.config.ts`, logs
  the resolved list once at boot, and owns a unit test asserting the composed config's
  `trustedOrigins` contains every configured entry. It sets neither
  `emailAndPassword.minPasswordLength` nor `maxPasswordLength`; the contract states the
  library's defaults and the mount leaves them alone (F-235).
- **TASK-012 forwards `origin` on mutating proxied requests** and owns a test asserting a
  proxied `POST` arrives upstream with it set and a proxied `GET` does not. It also adds
  the display-name field to `/signup` (F-234), and the password field's client-side
  validation states the policy in `auth-tokens.md`: 8 to 128 characters, no composition
  requirement.
- **TASK-014's invitation-accept screen carries the same name field**, because it creates
  an account through the same endpoint (F-234).
- TASK-052's 429 handling lives in `apiClient`, which sees the proxied response
  unchanged including `Retry-After`.
- Contract: `design/contracts/web-api-client.md`.
