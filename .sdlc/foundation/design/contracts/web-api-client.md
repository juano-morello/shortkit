# Contract: the web API client and the BFF proxy

- **Boundary:** browser to Next.js, and Next.js to NestJS. Every frontend TASK calls the API through this.
- **Normative form:** `apps/web/src/lib/api/client.ts` (stub: `design/stubs/apps/web/src/lib/api/client.ts`).
- **Produced by:** TASK-008 (client), TASK-012 (proxy route, cookies, session).
- **Consumed by:** TASK-012, 015, 019, 022, 026, 028, 041, 044, 047, 050, 052, 055, 057.
- **ADRs:** ADR-0014, ADR-0005, ADR-0013, ADR-0029.

## Topology

```
browser --(same-origin, httpOnly cookies)--> Next.js /api/bff/* --(Bearer JWT)--> NestJS /api/*
server component ------------------------- serverApiClient() --(Bearer JWT)--> NestJS /api/*
```

The browser never holds a token and never calls Fly directly.

## Client

Amended 2026-08-10 (F-284, F-292, ADR-0029). `path` was `string` meaning the resolved API
path, and the error classes carried that string in `message` and as an own enumerable
property. It is now a **route template**; caller-supplied values move to `params`. Read
"Request path construction" below before implementing anything here.

```ts
export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';

export interface ApiRequest<TRes, TBody = unknown> {
  method: HttpMethod;
  /**
   * A ROUTE TEMPLATE, not a URL, and a string literal in the source (ADR-0029).
   * Literal segments are lowercase kebab; every caller-supplied value is a `:name`
   * placeholder resolved from `params`. '/links', '/links/:id', '/invitations/:token'.
   */
  path: string;
  /** Exactly one entry per placeholder in `path`. No extras, no omissions. */
  params?: Record<string, string | number>;
  contract: z.ZodType<TRes>;    // response schema; the response IS validated
  body?: TBody;
  query?: Record<string, string | number | boolean | undefined>;
  signal?: AbortSignal;
}

/** Literal segment, or `:name` placeholder. Nothing else. */
export declare const ROUTE_TEMPLATE_PATTERN: RegExp;
// /^(?:\/(?:[a-z0-9][a-z0-9-]{0,63}|:[a-zA-Z][a-zA-Z0-9]{0,29}))+$/

export declare function apiClient<TRes>(req: ApiRequest<TRes>): Promise<TRes>;
export declare function serverApiClient<TRes>(req: ApiRequest<TRes>): Promise<TRes>;

export class ApiError extends Error {
  readonly code: ErrorCode;
  /** The TRANSPORT status. Independent of `code`; see "status and code" below. */
  readonly status: number;
  readonly details?: unknown;
  readonly retryAfterSeconds?: number;   // present when code === 'rate_limited'
}

export class ContractViolationError extends Error {
  /** The ROUTE TEMPLATE. Never a resolved path, never a param value (ADR-0029). */
  readonly path: string;
  readonly issues: z.ZodIssue[];
}

export class NetworkError extends Error {
  /** The ROUTE TEMPLATE. */
  readonly path: string;
}

/**
 * A cancellation the CALLER initiated, through `req.signal`. Added 2026-08-10 (F-292).
 * It does NOT extend `NetworkError`: nothing failed, and a retry wrapper keyed on
 * `NetworkError` must not re-issue a request the caller deliberately cancelled.
 */
export class RequestAbortedError extends Error {
  /** The ROUTE TEMPLATE. */
  readonly path: string;
}
```

### Request path construction

Added 2026-08-10 (F-284, F-285, ADR-0029). Normative and ordered. This is the browser-leg
mirror of the upstream construction the proxy performs, and it exists for the same reason:
the previous rule was `` `${BFF_PATH_PREFIX}${path}` `` with no validation, so
`/links/../../auth/token` reached `/api/auth/token` — normalised by the browser **before the
request is sent**, so the proxy's own segment rejection never runs — and an unescaped `?` in
an interpolated segment appended attacker-chosen parameters to an authenticated call.

```
1. ROUTE_TEMPLATE_PATTERN.test(req.path) === false
      -> throw new Error(invalidRouteMessage(method)). The request is NOT sent.
2. placeholders := the `:name` segments of req.path, without the ':'
   if that set !== the key set of (req.params ?? {})
      -> throw new Error(unresolvedParamsMessage(method, path))
3. for each placeholder name:
      encoded := encodeURIComponent(String(params[name]))
      if encoded is '' or '.' or '..' -> throw new Error(invalidParamValueMessage(method, path))
4. resolved := req.path with each ':name' replaced by its ENCODED value
5. url := BFF_PATH_PREFIX + resolved, then the query string appended from
   URLSearchParams, exactly as before; `undefined` values are omitted
6. assert new URL(url, ROUTE_ASSERTION_BASE).pathname startsWith `${BFF_PATH_PREFIX}/`
      -> throw new Error(invalidRouteMessage(method)) if it does not
```

Step 6 is unreachable given steps 1 and 3, and it is not redundant with them, in exactly the
sense step 3 of the upstream construction is not redundant with steps 1 and 2: it is the
assertion that makes any future change to the earlier steps safe. `ROUTE_ASSERTION_BASE` is a
fixed `.invalid` origin so the assertion does not depend on `location`, and it is used for the
assertion only. The string built at step 5 is what reaches `fetch`.

**Step 3 rejects `.` and `..` after encoding, not before.** `encodeURIComponent('..')` is
`'..'`, because dot is unreserved, so a param value of `..` would otherwise survive encoding
and be normalised away by the browser. `/` and `\` and `?` and `#` in a param value do not
need rejecting: they encode to `%2F`, `%5C`, `%3F`, `%23`, which the browser does not decode
in a path. `%2F` reaches the proxy, Next.js decodes route params, and the decoded segment
contains `/`, which `buildUpstreamUrl` step 1 rejects with a 400. That chain is intended.

**Message constants.** Normative values. Pinning them stops a second implementer inventing a
third string; it is not a compatibility promise, and no caller branches on any of them.

```ts
// apps/web/src/lib/api/client.ts. Module-private; `m` is `req.method` and `p` is
// `req.path`. They interpolate those two values and NOTHING ELSE: `method` is a closed
// union of four literals, and `path` is a source literal that has passed
// ROUTE_TEMPLATE_PATTERN by the time any builder but the first runs (ADR-0029).
const contractViolationMessage = (m: HttpMethod, p: string) =>
  `Response from ${m} ${p} did not match its contract.`;
const networkSendMessage = (m: HttpMethod, p: string) =>
  `Request to ${m} ${p} could not be sent.`;
const networkReadMessage = (m: HttpMethod, p: string) =>
  `Response from ${m} ${p} could not be read.`;
const requestAbortedMessage = (m: HttpMethod, p: string) =>
  `Request to ${m} ${p} was aborted by the caller.`;
const invalidRouteMessage = (m: HttpMethod) =>
  `apiClient: the ${m} path is not a route template.`;
const unresolvedParamsMessage = (m: HttpMethod, p: string) =>
  `apiClient: params do not match ${m} ${p}.`;
const invalidParamValueMessage = (m: HttpMethod, p: string) =>
  `apiClient: a param value for ${m} ${p} is empty, '.' or '..'.`;
```

`invalidRouteMessage` names the method and **not the offending path**, because at step 1 the
path is the value under suspicion: it is the only one of the seven builders whose path
argument has not passed the pattern, and a rejection that echoes the value it rejected is the
leak wearing a different hat. `invalidParamValueMessage` never names the value either — a
param value is caller-supplied by definition, and the invitation token is one.

Steps 1, 2, 3 and 6 throw a plain `Error`. They are programming defects, not runtime
conditions: no screen catches them, no retry layer inspects them, and none of the four
`ApiRequest` failure classes applies because no request was made.

## Response handling

Ordered. Normative.

1. Status 2xx: parse JSON, `contract.safeParse`. Failure throws
   `ContractViolationError` and **never returns the malformed data** (AC-15).
2. Status 4xx or 5xx with a body validating against `errorEnvelopeContract`: throw
   `ApiError` carrying `code`, `status`, `details`.
3. Status 401 with `code: 'token_expired'`: the **proxy** refreshes and retries once
   before the client sees anything. Two consecutive failures clear both cookies and
   return 401 `unauthenticated`.
4. Status 429: `ApiError` with `retryAfterSeconds` taken from the `Retry-After` header
   **and, when that header is absent, from a `retryAfterSeconds` field in the body**.
   `/api/auth/*` is mounted outside Nest, so a 429 from the email rate limiter carries
   the value in the body rather than the header (F-027, `rate-limit.md`). Normalising
   both here is what lets TASK-052's central rendering work on the login screen, which
   is the 429 a user is most likely to see. No screen reimplements it.
5. Body not matching the envelope, including Better Auth's native errors from
   `/api/auth/*` (ADR-0013): mapped to `ApiError` with `code: 'internal_error'` and the
   original status, except Better Auth's documented shapes which are mapped explicitly.
   **That mapping is deferred**, ruled 2026-08-10 under F-291 (`TASK-008.md`): its
   consumers are the auth screens, which left with EPIC-002. Until it lands, a wrong
   password arrives as `{ code: 'internal_error', status: 401 }` and AC-20's behaviour is
   unreachable. The eight probed Better Auth shapes are in `auth-tokens.md:180-193`, and
   the one open design question is in `error-envelope.md`, "Open: the code Better Auth's
   422 carries".
6. Transport failure: `NetworkError`. Both the `fetch` rejection and a rejection while
   reading the body are transport, and both carry the original on `cause`.
7. **Caller-initiated abort: `RequestAbortedError`.** Added 2026-08-10 (F-292). See below.

**No screen calls `fetch` directly.** Every request goes through one of the two clients.

### Abort is not a transport failure

Added 2026-08-10 (F-292). Normative. Step 6 was silent on abort, so a `fetch` rejected by
`req.signal` fell to the catch-all and surfaced as `NetworkError`. A screen that aborts the
in-flight request on each keystroke then renders a network-failure state for a cancellation
it initiated, and a retry wrapper keyed on `NetworkError` re-issues a request the caller
deliberately cancelled.

**The discriminator is the signal, not the rejection.** In both `catch` blocks:

```ts
if (req.signal?.aborted === true) {
  throw new RequestAbortedError(req.method, req.path, { cause });
}
throw new NetworkError(networkSendMessage(req.method, req.path), req.path, { cause });
```

`req.signal.aborted` is checked rather than `cause.name === 'AbortError'` because
`AbortController.abort(reason)` makes `fetch` reject with **`signal.reason`**, which is the
caller's value and has no guaranteed `name`. The default reason is an `AbortError`
`DOMException`; a caller passing anything else would defeat a name check. The signal is
authoritative and the rejection is not.

An abort observed at the same instant as a genuine transport failure raises
`RequestAbortedError`. The ambiguity is real and the tie goes to the signal, because the
caller asked for this outcome and cannot have asked for the other one.

**What a caller does with it.** Nothing, in the normal case: an aborted request is a
cancellation the screen performed, so it renders no error state, logs nothing, and retries
nothing. A caller that catches `NetworkError` and shows a failure banner now correctly does
not fire on cancellation.

`RequestAbortedError` extends `Error`, **not** `NetworkError`, so
`err instanceof NetworkError` is `false` for an abort. That is the whole point of the class;
a boolean flag on `NetworkError` was rejected because the retry wrapper the finding describes
keys on the class and would still fire.

`cause` carries the platform rejection or `signal.reason`. `signal.reason` is caller-supplied,
so it sits outside the redaction guarantee ADR-0029 gives the message and the `path` property.
A telemetry sink that serialises `cause` is serialising a value the caller constructed.

### `ApiError.status` and `ApiError.code` are independent

Added 2026-08-10 (F-289). `status` is the transport status of the response, verbatim. `code`
comes from the envelope, or from step 5's fallback, or from the Better Auth mapping. **A
caller must never assume `ERROR_CODE_STATUS[err.code] === err.status`.** Step 5 already
breaks the pairing by design: it emits `internal_error` with the original status, so a 502
from an interposed proxy arrives as `{ code: 'internal_error', status: 502 }`.

This is what makes Better Auth's statuses expressible without touching the registry. 422 has
no row in `ERROR_CODE_STATUS` and needs none: `USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL` arrives
as `{ code: <undecided>, status: 422 }`. **Which code it carries is an open question**, owned
by whichever TASK builds `mapBetterAuthError`; the constraints on the answer are recorded in
`error-envelope.md`, "Open: the code Better Auth's 422 carries".

## The proxy route

`apps/web/app/api/bff/[...path]/route.ts`

| Behaviour | Rule |
|---|---|
| upstream URL | see the normative construction below |
| auth | `Authorization: Bearer <sk_at cookie>` |
| cookies upstream | **never forwarded** |
| request headers forwarded | `content-type`, `accept`, `x-request-id`, and **`origin` on mutating methods only** (see below). **Two allowlists, read together**: `FORWARDED_REQUEST_HEADERS` is not the whole set, and building the upstream headers from it alone breaks every auth mutation (F-288). **Inbound `x-shortkit-*` headers are never forwarded**; the proxy sets both of its own afresh on every request |
| headers the proxy **adds** | `x-shortkit-client-ip` (the browser's address — see the rule below), `x-shortkit-proxy-auth` (`BFF_PROXY_SECRET`) upstream, and `cache-control: no-store` on **every** response it returns (see below) |
| response headers returned | `content-type`, `retry-after`, `x-request-id` only. `cache-control` is **not** in the allowlist: upstream's value is dropped and the proxy sets its own |
| CSRF | mutating methods require `Origin` to equal the deployment origin, else 403 |
| redirects | `redirect: 'manual'` on the upstream fetch. A 3xx is returned to the caller, never followed |
| refresh | on upstream 401 `token_expired`, mint from `sk_rt`, set `sk_at`, retry once |
| concurrent refresh | collapsed by an in-flight map keyed on the session |

### Upstream URL construction

Normative. Revised 2026-08-04 (F-008): the rule was `${API_BASE_URL}/api/${path}` with
`path` the decoded `[...path]` catch-all. Next.js decodes route params, so
`%2e%2e%2f` yielded `../` and escaped the `/api` prefix; and an implementer reaching for
`new URL(path, API_BASE_URL)` would let a path beginning `//evil.example/` resolve
protocol-relative, sending `Authorization: Bearer` with a live tenant credential to an
attacker-chosen origin, from a same-origin request the victim's browser makes.

```ts
const base = new URL(API_BASE_URL);                    // server-only env var

// 1. Reject any unsafe segment AFTER Next.js has decoded it.
for (const seg of segments) {
  if (seg === '' || seg === '.' || seg === '..') return badRequest();
  if (/[/\\:]/.test(seg)) return badRequest();
}

// 2. Re-encode and join. Never interpolate the raw catch-all.
const upstream = new URL(`/api/${segments.map(encodeURIComponent).join('/')}`, base);

// 3. Assert the origin. This is the load-bearing line.
if (upstream.origin !== base.origin) return badRequest();

// 4. Query string is rebuilt from the parsed searchParams, never concatenated.
```

Step 1 runs on the **decoded** segments, because that is the form traversal arrives in.
Step 3 is not redundant with steps 1 and 2; it is the assertion that makes any future
change to them safe.

### The `Origin` header the proxy forwards

Added 2026-08-08 (F-233). Normative.

**On a mutating method the proxy forwards the inbound `Origin` verbatim. On `GET` and
`HEAD` it forwards none.**

```ts
// after the CSRF check below has already run and passed
if (method !== 'GET' && method !== 'HEAD') {
  upstreamHeaders.set('origin', request.headers.get('origin')!);
}
```

The CSRF row above already refuses any mutating request whose `Origin` is not the
deployment's own origin, so the value forwarded is the deployment origin or the request
never left Vercel. The proxy does not synthesise, rewrite, or default this header. There
is exactly one place `Origin` is decided, and it is the browser.

**Why the header is needed at all.** `better-auth@1.6.26` answers
`403 {"code":"MISSING_OR_NULL_ORIGIN"}` to a state-changing request to `/api/auth/*` that
carries no `Origin`, and a server-side `fetch` from a Vercel route handler carries none.
Without this rule every signup, sign-in and sign-out through the proxy returns 403 in
production while every test that speaks to the API directly passes. Mechanism, the
matching API-side `trustedOrigins` configuration, and the verification record are in
`auth-tokens.md`.

`GET` requests need no `Origin`; Better Auth skips the check on `GET`. That covers the
refresh path, `GET /api/auth/token`, and `GET /api/auth/get-session`.

**`serverApiClient` sends no `Origin`** and therefore must not be used for a `POST` to
`/api/auth/*`. Server components read; sign-in, sign-up and sign-out go through the proxy
route handler. An implementer who routes a server-side mutation at the auth surface
directly to Fly gets a 403 whose code names the origin and whose cause is the call site.

### Caching of proxied responses

Added 2026-08-10 (F-287). Normative.

**The proxy sets `Cache-Control: no-store` on every response it returns, without exception,
and does not forward upstream's `cache-control`.**

```ts
/** F-287. Written on every proxied response, whatever the upstream said. */
export const PROXY_RESPONSE_CACHE_CONTROL = 'no-store' as const;
```

`RETURNED_RESPONSE_HEADERS` omitted `cache-control`, so an API response carrying `no-store`
for tenant data arrived at the browser with no cache directive and the decision fell to
browser heuristics on a 200 GET. Someone with later filesystem access to the same browser
profile — a shared or kiosk machine, a recovered disk — could read another tenant's link,
member or domain data out of the HTTP cache after the session cookie expired.

**The rejected alternative is adding `cache-control` to `RETURNED_RESPONSE_HEADERS`.** It
forwards whatever the API chose, which is correct when the API chose correctly, and silently
falls back to heuristic caching for any route that forgets. That makes the browser cache of
every authenticated response depend on every present and future `/api` route setting one
header, enforced by nothing. Twenty-odd routes have to be right; one has to be wrong. Setting
it at the proxy fails closed and depends on one line in one file.

**The cost accepted:** no response through `/api/bff/*` can ever be cached by the browser,
including one that safely could be. Nothing in this design wants that today — everything
crossing this boundary is authenticated tenant JSON — so the cost is a future option, not a
present loss. Taking that option means amending this section, not adding a special case at a
call site.

This does not cover the API's own responses reaching any other client. `Cache-Control` on the
`/api` surface itself is `logging-and-headers.md`'s, and the redirect surface's caching is
`redirect-cache.md`'s. This rule is about what the browser is allowed to keep.

### The browser address the proxy forwards

Added 2026-08-04 (F-035). The source of `x-shortkit-client-ip` is normative:
**`x-vercel-forwarded-for`**, read whole. It is set by Vercel to the connecting
client's public address, a client cannot spoof it because Vercel overwrites inbound
forwarding headers on non-Enterprise plans, and unlike `x-forwarded-for` it is not
rewritten by a proxy stacked on top of Vercel.

- **Never** `x-forwarded-for` split on commas, and **never the leftmost entry of any
  multi-valued list** — that is the construct F-009 exists to forbid, moved one hop
  upstream.
- When the header is absent (local `next dev`), the proxy **omits**
  `x-shortkit-client-ip` entirely; the API then falls back to `Fly-Client-IP`
  (`rate-limit.md`). It never substitutes another header.
- **This assumption holds only while requests reach Vercel directly.** Putting any
  proxy in front of Vercel (Cloudflare, a corporate gateway, a Vercel Enterprise
  trusted-proxy configuration) changes who controls the client address and invalidates
  it; that change requires revisiting this section, not just DNS.

`BFF_PROXY_SECRET` is a **required, server-only** environment variable on Vercel,
registered by TASK-004 alongside `API_BASE_URL` (never `NEXT_PUBLIC_*`). Its value is
**never logged on the Vercel side** — not in route-handler logs, not in error paths
that serialise headers — mirroring the API-side redaction (`logging-and-headers.md`,
F-032). On the Fly side the variable is required at boot in production
(`rate-limit.md`, F-033).

## Cookies

Set by the proxy on the Vercel origin. Both `HttpOnly; Secure; SameSite=Lax; Path=/`.
Details in `auth-tokens.md`. **Client JavaScript can read neither** (TASK-012's
constraint).

## Session

```ts
export declare function useSession(): { user: SessionUser | null; status: 'loading' | 'authenticated' | 'unauthenticated' };
export declare function requireAuth(): Promise<SessionUser>;   // redirects to /login

export interface SessionUser { id: string; email: string; emailVerified: boolean; }
```

`useSession` reads `GET /api/bff/session`, which returns the projection above. **No
token is ever exposed to the client**, in any form.

## Invariants a caller may rely on

1. A resolved `apiClient` promise carries data that validated against `contract`.
   Malformed data throws (AC-15).
2. An incompatible change in `packages/contracts` breaks `pnpm typecheck` because
   `apps/web` compiles the contract source (AC-14, ADR-0005).
3. 429 handling and `Retry-After` are applied centrally. Form state survives a 429;
   the client throws rather than resetting anything (AC-87).
4. Token refresh is invisible to the caller. A screen never sees `token_expired`.
5. `serverApiClient` cannot set cookies during render, so on `token_expired` it throws a
   redirect to a refresh route handler that bounces back.
6. **The proxy never sends `Authorization` to any origin other than `API_BASE_URL`'s.**
   No path, query string, header or upstream redirect can cause it to. The origin
   assertion runs on every request, and `redirect: 'manual'` stops an upstream 3xx from
   carrying the header somewhere else.
7. The proxy cannot reach any upstream path outside `/api/`. Traversal segments are
   rejected before the URL is built.
8. **The API sees the browser's address, not Vercel's.** The proxy adds
   `x-shortkit-client-ip` — sourced from `x-vercel-forwarded-for` only, never a
   leftmost list entry (F-035) — and authenticates it with `x-shortkit-proxy-auth`.
   Without this every IP-keyed rate limit would collapse into one bucket shared by
   every user (`rate-limit.md`). A client-supplied `x-shortkit-client-ip` arriving
   without a valid secret is ignored, so this does not reintroduce F-009's trust
   problem, and inbound `x-shortkit-*` headers are never forwarded upstream.
9. **A mutating request that reaches Fly carries an `Origin` equal to the deployment
   origin.** The CSRF check runs before the header is forwarded, so no other value can
   reach the API and the header is never absent on a mutating proxied request. This is
   what keeps `/api/auth/*` from answering 403 `MISSING_OR_NULL_ORIGIN` (F-233). The API's
   `WEB_APP_ORIGINS` must list that origin; production and each preview host are separate
   entries (`auth-tokens.md`).
10. **No error this client raises carries a caller-supplied value in `message` or in an own
    enumerable property.** Added 2026-08-10 (F-284, ADR-0029). `path` on
    `ContractViolationError`, `NetworkError` and `RequestAbortedError` is the route
    template, and every message is built from the template and the method. A caller may put
    a bearer credential in a param value — TASK-022's invitation token is one — and it
    reaches the URL, the wire and nothing else. The exception, named because it is one:
    `RequestAbortedError.cause` is `signal.reason`, which the caller constructed.
11. **A caller-initiated abort raises `RequestAbortedError` and is not an instance of
    `NetworkError`.** Added 2026-08-10 (F-292). Retry and error-state logic keyed on
    `NetworkError` does not fire for a cancellation.
12. **A browser request cannot leave `/api/bff/`.** Added 2026-08-10 (F-284, F-285). The
    route template is validated before the request is built, param values are
    percent-encoded and may not be `.`, `..` or empty, and the resolved URL is asserted to
    still be under the prefix after WHATWG normalisation. Traversal that the browser
    normalises before sending — which never reaches the proxy and so never meets
    `buildUpstreamUrl`'s rejection — is refused here instead.
13. **No response returned through `/api/bff/*` may be stored by the browser.** Added
    2026-08-10 (F-287). Every proxied response carries `Cache-Control: no-store`, set by
    the proxy and not inherited from upstream.

## What the implementer must guarantee

- The header allowlists are allowlists. Forwarding `cookie` upstream, or returning
  `set-cookie` from upstream, leaks the Fly origin's session into the Vercel origin.
- **Tests for the URL construction, not just the happy path.** At minimum:
  `/api/bff/x/%2e%2e%2f%2e%2e%2fhealth` returns 400; `/api/bff//evil.example/x` returns
  400; and a stubbed upstream returning a 302 to another origin does not cause a second
  request carrying `Authorization`.
- Do not replace the construction with `new URL(path, base)`. It looks equivalent and
  resolves protocol-relative paths off-origin.
- Workspace scoping in the UI is display context, never a security control. The API is
  the enforcement point (TASK-015).
- `NEXT_PUBLIC_API_BASE_URL` is not used for anything authenticated. Authenticated
  traffic uses the same-origin `/api/bff` path or the server-only `API_BASE_URL`.
- **A test that a proxied `POST` arrives upstream with `Origin` set.** Assert against a
  stubbed upstream, and assert the `GET` case sends none. Without it the `Origin` line is
  one an implementer can drop while every other proxy test still passes, and the symptom
  appears only against a real Better Auth mount (F-233).
- **The normative form exports both request-header allowlists, by these names.** Added
  2026-08-10 (F-288). `apps/web/src/lib/api/client.ts` must export
  `FORWARDED_REQUEST_HEADERS`, `FORWARDED_REQUEST_HEADERS_MUTATING_ONLY` (`['origin']`),
  `MUTATING_METHODS` and `isMutatingMethod`. This document is not what the proxy
  implementer reads — the file is, because this document names it as the normative form —
  and a file offering one allowlist under a docblock enumerating what is deliberately
  absent states, to that reader, that the set is complete. It is not: building
  `upstreamHeaders` from `FORWARDED_REQUEST_HEADERS` alone answers
  `403 MISSING_OR_NULL_ORIGIN` to every signup, sign-in and sign-out in production while
  every test that speaks to the API directly passes. **No gate catches this.** The drift
  gate is AC-14, contract mutation versus typecheck; there is no stub-versus-source check
  in `apps/web`, verified 2026-08-10.
- **Every `Error` this module constructs interpolates only `method` and a route template**
  (ADR-0029). Adding an interpolation of a param value, a query value, a response body, a
  header or a resolved URL to any message in this file is a defect, including on a path
  that rejects the value as invalid.

## Versioning

The `/api/bff/*` surface is internal to `apps/web` and shipped from the same commit as
its callers, so it has no compatibility obligation. `ApiError` and
`ContractViolationError` are public to every frontend TASK; adding a field is additive,
changing `code`'s type is not.

**The 2026-08-10 amendment (F-284, ADR-0029) is additive in shape and breaking in meaning,
and that distinction is the whole of its compatibility story.** No field was removed and no
type changed: `ApiRequest.path` is still `string`, `ContractViolationError.path` is still a
present `string`. What changed is the value each holds — a route template, not a resolved
path — so nothing fails to compile and a caller written against the old semantics is wrong at
runtime rather than at build time. That is normally the worse kind of change. It is
acceptable here for one reason, checked rather than assumed: `apiClient` has no callers.
`apps/web/src` contains two files, `client.ts` and `client.spec.ts`, and every one of the
thirteen consumer TASKs is unwritten. The window in which this costs nothing closes at the
first consumer.

`params` and `RequestAbortedError` are additive outright. `PROXY_RESPONSE_CACHE_CONTROL`,
`ROUTE_TEMPLATE_PATTERN` and `ROUTE_ASSERTION_BASE` are new exports.
