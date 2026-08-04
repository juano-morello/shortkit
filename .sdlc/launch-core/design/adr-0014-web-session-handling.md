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

## Alternatives considered

| Option | Pros | Cons | Why not |
|---|---|---|---|
| Browser calls Fly directly with a cross-site cookie on a shared parent domain (`app.shortkit.app`, `api.shortkit.app`) | One hop; no proxy code; no Vercel function invocations | Needs the apex domain, which is unresolved and blocks three TASKs. It cannot be built or tested today, and `SameSite=None` cookies are the setting browsers keep tightening | Blocked on a question that is not Design's to answer |
| JWT in memory in a React context, refreshed on load | No cookie handling; token never persisted | A token in JS memory is readable by any script on the page, which is exactly what TASK-012 forbids. It also breaks server components, which have no access to client memory | Contradicts an explicit TASK constraint |
| Next.js server actions for every mutation, no proxy route | Idiomatic App Router; no manual header copying | Server actions cannot express arbitrary REST verbs cleanly and would need one action per endpoint, so the shared `apiClient` TASK-008 produces disappears and fifteen frontend TASKs each write their own | Discards the single call path the plan built |
| NextAuth or Auth.js in the web app, Better Auth in the API | Mature session handling on the Next side | Two auth systems and a mapping between them | Absurd complexity for the problem |
| Longer-lived JWT (24 h) with no refresh path | No refresh machinery at all | A stolen token is valid for a day and revocation becomes mandatory rather than best-effort | Trades the entire security posture for less code |

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
- TASK-052's 429 handling lives in `apiClient`, which sees the proxied response
  unchanged including `Retry-After`.
- Contract: `design/contracts/web-api-client.md`.
