---
id: TASK-007
story: STORY-003
epic: EPIC-001
title: Web session module and the server-side transport to the API
status: todo
owner_slot: sdlc-implementer-frontend
depends_on: [TASK-004]
paths: ["apps/web/src/lib/session/**", "apps/web/src/lib/api/client.ts", "apps/web/app/api/bff/**"]
contracts: [design/contracts/auth-tokens.md, design/contracts/trusted-client-address.md]
test_files: ["apps/web/src/lib/session/session.spec.ts (unit)", "apps/web/src/lib/api/client.spec.ts (unit, existing file — extended)"]
acceptance: [AC-18, AC-19]
rework_count: 0
---

## Intent

Give `apps/web` a session it holds on the server and a way to reach the API with it, so that
no credential is ever readable from client JavaScript.

## Approach

`apps/web/src/lib/api/client.ts` already ships `apiClient`, `buildRequestUrl`, the four
error classes, the header allowlists and the BFF constants. Three of its exports are
declared and throw or are unimplemented: `serverApiClient`, `mapBetterAuthError`, and the
proxy route that `BFF_PATH_PREFIX`, `buildUpstreamUrl`, `FORWARDED_REQUEST_HEADERS`,
`RETURNED_RESPONSE_HEADERS`, `UPSTREAM_FETCH_REDIRECT` and `PROXY_RESPONSE_CACHE_CONTROL`
were all written for. This TASK completes them.

**The session lives in HttpOnly cookies and never in client JavaScript.** The design stub at
`.sdlc/foundation/design/stubs/apps/web/src/lib/session/session.ts` fixes the cookie
contract: `sk_at` carrying the JWT with a 300-second lifetime and `sk_rt` carrying the
Better Auth session token with a 30-day lifetime, both `HttpOnly`, `Secure` and
`SameSite=Lax`. **That stub is normative for the exported shape**, because the moment this
source file lands, `.github/scripts/assert-stub-drift.mjs` starts comparing the two on
exported declarations and fails on a name or signature that differs (F-403 — that stub is
the gate's only enforced pair and it currently compares zero).

Whether the browser reaches the API through this app's proxy route or at the API's own
origin is a **Design decision** and is listed for the architect. Both are consistent with
ADR-0014 and ADR-0040 and they differ in what carries the client address:

- through the proxy, the API sees this app's egress address and the client address arrives
  in `BFF_CLIENT_IP_HEADER` authenticated by `BFF_PROXY_AUTH_HEADER`, which is why
  `resolveRateLimitPrincipal` tries the BFF branch first;
- at the API's own origin, the proxy route is not built and this TASK ships the session
  module and `serverApiClient` alone.

Build for whichever Design rules; the `paths` glob above reaches both.

**`mapBetterAuthError` exists because Better Auth's error bodies do not match
`ErrorEnvelope`.** The `/api/auth/*` mount sits outside the Nest module graph, so no Nest
filter applies to it (ADR-0013). Two specifics that are easy to miss and both were filed as
findings: a 429 from that surface may carry the seconds in a `retryAfterSeconds` **body**
field rather than in a `Retry-After` header (F-027), and its 429 body carries no
`code: "rate_limited"` — so an unmapped 429 renders as the generic error and the sign-in
screen shows the wrong thing.

**`better-auth@1.6.26` answers a state-changing auth request with no `Origin` header with
`403 MISSING_OR_NULL_ORIGIN`** (`dist/api/middlewares/origin-check.mjs:107`, reproduced
against the pin, recorded at `apps/api/test/support/auth-fixture.ts:9-17`). A browser always
sends one; server-side `fetch` does not. Any server-initiated auth request from this app
must send one.

**Nothing here may inline a secret into the client bundle.**
`apps/web/scripts/assert-no-inlined-secrets.mjs` scans build output and gates in CI. Its
known residual is F-157 — the scan is structurally blind to dynamic routes, and the proxy
route is exactly that — so the absence of a finding from that script is not evidence for
this TASK's route.

**Route protection** (AC-19) reads the session on the server and redirects to the sign-in
screen when there is none. It must not render the protected page and hide it.

## Out of scope for this TASK

The signup and sign-in screens themselves (TASK-008). The workspace screens (TASK-013).
Widening the stub-drift gate's enforced prefixes (TASK-010). Any `apps/api` file. Any
compose or environment file (TASK-009). Token refresh scheduling beyond what a 300-second
lifetime forces — ADR-0014 owns that traffic and this TASK implements
`refreshAccessToken` without adding a background scheduler.

## Interfaces

**Consumes**

From TASK-004 (over HTTP, not by import): the mounted `/api/auth/{*splat}` surface —
`POST /api/auth/sign-up/email`, `POST /api/auth/sign-in/email`, `GET /api/auth/jwks`, and
Better Auth's token-mint route.

From TASK-001 (`@shortkit/contracts`, imported as TypeScript source with no build step):
`signUpRequestContract`, `signInRequestContract`, `authSessionContract`,
`ACCESS_TOKEN_LIFETIME_SECONDS = 300`, `errorEnvelopeContract`, `ERROR_CODE_STATUS`.

From `apps/web/src/lib/api/client.ts` (shipped, same file this TASK edits):
`apiClient`, `buildRequestUrl`, `ApiError`, `ContractViolationError`, `NetworkError`,
`RequestAbortedError`, `BFF_PATH_PREFIX = '/api/bff'`, `buildUpstreamUrl`,
`UPSTREAM_FETCH_REDIRECT = 'manual'`, `FORWARDED_REQUEST_HEADERS`,
`RETURNED_RESPONSE_HEADERS`, `PROXY_RESPONSE_CACHE_CONTROL = 'no-store'`,
`FORWARDED_REQUEST_HEADERS_MUTATING_ONLY`, `isMutatingMethod`,
`VERCEL_CLIENT_IP_HEADER = 'x-vercel-forwarded-for'`,
`BFF_CLIENT_IP_HEADER = 'x-shortkit-client-ip'`,
`BFF_PROXY_AUTH_HEADER = 'x-shortkit-proxy-auth'`.

**Produces**

- `apps/web/src/lib/session/session.ts` exporting — names and signatures fixed by the surviving design stub, which the drift gate compares against:
  - `useSession()`
  - `requireAuth()` — redirects to the sign-in screen when no session is held
  - `setSessionCookies(...)` — writes `sk_at` (300 s) and `sk_rt` (30 days), both `HttpOnly`, `Secure`, `SameSite=Lax`
  - `clearSessionCookies()`
  - `refreshAccessToken()`
- `apps/web/src/lib/api/client.ts`:
  - `serverApiClient<TRes>(req: ApiRequest<TRes>): Promise<TRes>` — implemented; attaches the session credential server-side
  - `mapBetterAuthError(status: number, body: unknown): ApiError` — implemented; reads `retryAfterSeconds` from a 429 body when the `Retry-After` header is absent
- `apps/web/app/api/bff/[...path]/route.ts` — the proxy route, **if Design rules the browser
  reaches the API through this app**; otherwise not built, and that ruling is recorded in the
  design contract this TASK names
