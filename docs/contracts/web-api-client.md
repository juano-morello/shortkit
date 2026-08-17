# Contract: the web API client and the BFF proxy

- **Boundary:** browser to Next.js, and Next.js to NestJS. Every frontend TASK calls the API through this.
- **Normative form:** `apps/web/src/lib/api/client.ts`. One file, no second copy. The design stub was retired 2026-08-11 under ADR-0039, TASK-008 having closed, and with it the standing instruction that the stub and the source "move in the same round". They cannot diverge because there is nothing left to diverge from. TASK-012 reads this document and the shipped file.
- **Precedence.** Added 2026-08-11 (F-305, F-313). When this document and the normative form
  disagree, **this document states the rule and the file is the defect**, fixed in the file.
  The file is normative for shape: exported names, signatures, and the exact message strings
  an implementer copies. It must also carry every rule a reader of the file alone could
  otherwise get wrong, because that reader does not open this document (F-288); a rule
  stated here and absent there is a defect in the file too.
- **Produced by:** TASK-008 (client), TASK-012 (proxy route, cookies, session).
- **Consumed by:** TASK-012, 015, 019, 022, 026, 028, 041, 044, 047, 050, 052, 055, 057.
- **ADRs:** ADR-0014, ADR-0005, ADR-0013, ADR-0029, ADR-0038.

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
  /**
   * Exactly one entry per placeholder in `path`. No extras, no omissions, and no
   * template that repeats a placeholder name: there is no key that could fill it
   * twice (F-306, F-313).
   */
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

### A route template names each placeholder once

Added 2026-08-11 (F-313). Normative, and a property of the **template**, not of `params`.

**A route template may not repeat a placeholder name.** `/a/:x/:x` is illegal whatever
`params` carries, and so is `/members/:id/workspace/:id`. `ROUTE_TEMPLATE_PATTERN` cannot
express the rule, because a regex reading segment by segment does not know which names it has
already matched, so the check runs at step 2 below and rejects with
`unresolvedParamsMessage(method, path)`. The template is safe to print: it is a source
literal, and it is the value the developer needs to see.

The rule is stated here rather than left implied by step 2's set comparison because a set
comparison does not express it. For `/a/:x/:x` with `{ x: 'v' }` the placeholder set `{x}`
and the key set `{x}` are equal, so the comparison alone accepts the call and builds
`/api/bff/a/v/v` from one supplied value. Step 2 rejects it (F-306, F-313).

**The rejected alternative is legal duplicates**, one supplied value substituted into every
segment naming it. It works, it needs no extra check, and it reads as the generous option. It
lost because the templates that would use it are typos. F-306's measured case is
`/members/:id/workspace/:id`, against a real endpoint spelled
`/members/:id/workspace/:workspaceId`, and under legal duplicates that typo sends a `DELETE`
at workspace `m1` with `w9` dropped and nothing said. A caller who genuinely wants one value
in two segments writes two placeholders and passes the value under both names, which costs
one key and states the intent.

**The cost accepted:** an endpoint that wants the same value twice cannot be written with one
placeholder, and the rejection is at runtime on the first call rather than in the editor. The
design's endpoint tables carry no template that repeats a name today; the closest is
`/members/:id/workspace/:workspaceId`, which names both.

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
   if req.path names any placeholder more than once            [F-313]
      -> throw new Error(unresolvedParamsMessage(method, path))
   if the SET of placeholders !== the key set of (req.params ?? {})
      -> throw new Error(unresolvedParamsMessage(method, path))
3. for each placeholder name:
      encoded := encodeURIComponent(String(params[name]))
      if that throws -- encodeURIComponent raises URIError on a lone surrogate --
         -> throw new Error(invalidParamValueMessage(method, path)).           [F-312]
            The URIError is NOT chained onto it: the value that threw is
            caller-supplied, and ADR-0029 keeps those off the error.
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
  `apiClient: a param value for ${m} ${p} is empty, '.', '..' or cannot be percent-encoded.`;
```

**`invalidParamValueMessage`'s text changed on 2026-08-11 (F-314).** It was
`` `apiClient: a param value for ${m} ${p} is empty, '.' or '..'.` ``, and F-312 gave it a
fourth condition without changing it, so a lone surrogate was rejected with a sentence naming
three conditions none of which had occurred. A developer reads that, checks the value is none
of the three, and has been sent away from the cause. The clause is `cannot be
percent-encoded` rather than a fifth message constant because step 3 has one outcome, the
value is unusable, and the four conditions differ only in why. The message still names no
value. Both step 2 conditions likewise share `unresolvedParamsMessage`: the template it
prints carries the repeated name in plain sight.

`invalidRouteMessage` names the method and **not the offending path**, because at step 1 the
path is the value under suspicion: it is the only one of the seven builders whose path
argument has not passed the pattern, and a rejection that echoes the value it rejected is the
leak wearing a different hat. `invalidParamValueMessage` never names the value either — a
param value is caller-supplied by definition, and the invitation token is one.

Steps 1, 2, 3 and 6 throw a plain `Error`. They are programming defects, not runtime
conditions: no screen catches them, no retry layer inspects them, and none of the four
`ApiRequest` failure classes applies because no request was made.

### The fetch options every request sets

Added 2026-08-11 (F-336), recording a rule that shipped on 2026-08-10 under F-286 and was
written down nowhere outside `apps/web`. Normative.

**Every request `apiClient` sends sets `credentials` and `redirect` explicitly**, rather than
leaving either to the runtime's default.

```ts
{ method, signal, credentials: 'same-origin', redirect: 'error' }
```

`credentials: 'same-origin'` states the rule the whole topology rests on: the session cookies
are `httpOnly` on the Vercel origin and go nowhere else. `include` would attach them to a
cross-origin request, and leaving the field unset makes cookie behaviour a property of the
runtime rather than of this file. The value is not a no-op that restates a default: it is the
line that keeps a future edit from turning `apiClient` into a cross-origin caller carrying the
session.

`redirect: 'error'` because the default is `follow`, and following a 3xx from the victim's
browser is the same hazard `UPSTREAM_FETCH_REDIRECT = 'manual'` refuses one hop later. Every
response this client expects is terminal, so a redirect out of `/api/bff/*` is a defect and
the request fails instead of being chased.

**Why this section exists.** The reviewer grepped the contract, the design stub and every ADR
and found neither setting recorded anywhere: the rule lived in the `requestInit` docblock and
one spec test, both inside `apps/web`. A security-relevant option set that no normative
artifact records is one refactor from being removed as noise, which is F-288's shape. The
stub carries it too.

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
   **That mapping was deferred** on 2026-08-10 under F-291 (`TASK-008.md`), its consumers
   having left with EPIC-002. **Materialised 2026-08-17 by identity-membership TASK-007**,
   which re-scoped the three F-291 deferrals: `mapBetterAuthError` is implemented in
   `client.ts`, and the BFF proxy applies it to **every non-2xx response on `/api/auth/*`**
   whose body is not already an `ErrorEnvelope` by `isErrorEnvelope`'s closed code enum
   (the Express limiters in front of the mount emit that shape and pass through). A wrong
   password now arrives as `{ code: 'unauthenticated', status: 401 }`. The eight probed
   Better Auth shapes are in `auth-tokens.md:180-193`; the 422 question in
   `error-envelope.md` ("Open: the code Better Auth's 422 carries") is answered in
   `mapBetterAuthError`'s docblock: `validation_failed`, status kept at 422.
6. Transport failure: `NetworkError`. Both the `fetch` rejection and a rejection while
   reading the body are transport. **Neither carries the platform rejection on `cause`.**
   Amended 2026-08-11 (F-310); see "`cause` is a channel, and it is closed" below.
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
  throw new RequestAbortedError(req.method, req.path, { cause: req.signal.reason });
}
throw new NetworkError(networkSendMessage(req.method, req.path), req.path);
```

Amended 2026-08-11 (F-310): both lines took `{ cause }` from the caught rejection. The
`NetworkError` no longer takes one at all, and the abort reads the signal.

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

`RequestAbortedError.cause` is `signal.reason` and nothing else. Amended 2026-08-11 (F-310):
it was "the platform rejection or `signal.reason`", and the platform rejection half is gone.
`signal.reason` is caller-supplied, so it sits outside the redaction guarantee ADR-0029 gives
the message and the `path` property, and it is the one `cause` this module sets. See below.

### `cause` is a channel, and it is closed

Added 2026-08-11 (F-310). Normative.

**No error this client raises carries a `cause`, except `RequestAbortedError`, whose `cause`
is `signal.reason`.** `NetworkError` on both legs and `ContractViolationError` are
constructed with no `options` argument at all.

The reason is measured, not theoretical. Under Node's `fetch` the rejection handed to
`{ cause }` carries the **resolved** URL in its own message, so
`util.inspect(err, { depth: 5 })` printed
`[cause]: [TypeError: Failed to parse URL from /api/bff/invitations/<full token>`.
`util.inspect` is what `console.error(err)` calls, and pino's `err` serialiser walks more
still, so the credential the route template kept out of `message`, `path`, the spread and the
stack arrived in a log body anyway (GC-9). That `inspect` call is quoted here as the
measurement that found the leak, and it is **not** the check to reuse: it is blind to getters
and to anything past its truncation limits (F-339, ADR-0029 "The measurement discipline"). A browser-shaped `TypeError('Failed to fetch')` carries
no URL and was checked, so the leak needs a Node runtime: `apiClient` during SSR, or reused
from a route handler, which is plausible today precisely because `serverApiClient` throws
`not implemented` and reaching for `apiClient` is the natural workaround.

**The rejected alternative is keeping `cause` and telling readers not to log it**, which is
what ADR-0029's carve-out did for `RequestAbortedError`. It preserves the platform detail for
free. It lost because it is a per-sink discipline, and ADR-0029 exists to replace per-sink
discipline with a value that cannot carry the credential in the first place. Nothing enforces
it, `util.inspect` is the default and needs no code written to fire, and the rule would have
to hold in every consumer TASK, every telemetry SDK added later, and the Next.js error
overlay.

**The second rejected alternative is a sanitised projection**, `cause` replaced by a
client-constructed object carrying the rejection's `name` and no message. It keeps the one
detail worth keeping. It lost on ADR-0029's own eligibility test: `name` is not a literal in
this source and not a member of a union declared here, so it is a platform value the module
would be vouching for, and the projection is a new exported shape thirteen consumer TASKs
would have to learn for a value the browser sets to `TypeError` on every transport failure
anyway.

**The cost accepted:** a transport failure carries no platform detail at all. A developer
diagnosing one has the class, the method, the route template and whether the failure was on
send or on read, and must reproduce with devtools open to learn more. Under Node the
underlying `TypeError` is not reachable from the error object. That cost is small in a
browser, where `fetch` rejects with `TypeError('Failed to fetch')` for DNS, TLS, CORS and
offline alike, and larger under Node, which is the leg this rule exists to protect.

**`RequestAbortedError` keeps its `cause` and the carve-out is now the only one.**
`signal.reason` is a value the caller constructed, holds, and can read back off its own
`AbortSignal`; the client is a pass-through and cannot vouch for it, which is why it is
carved out rather than sanitised. **A caller must not pass a credential to `abort(reason)`**,
and a telemetry sink that serialises `RequestAbortedError.cause` is serialising a value the
caller chose.

**It is constructed from the signal, not from the caught rejection:**

```ts
if (req.signal?.aborted === true) {
  throw new RequestAbortedError(req.method, req.path, { cause: req.signal.reason });
}
```

Same principle as the discriminator two sections up, and for the same reason. An abort
observed at the same instant as a genuine transport failure hands the `catch` a platform
rejection, and under Node that rejection is the one carrying the resolved URL. Passing the
caught value through would reopen the leak on exactly the race the tie-breaking rule already
covers. Reading `signal.reason` makes `cause` deterministic and caller-owned in every case.
The invariant is then checkable by reading one file: `cause` is set in `client.ts` only in
the two abort branches, and only from `req.signal.reason`.

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
| CSRF | mutating methods require `Origin` to equal the deployment origin, else 403. **Mutating means anything that is not `GET` or `HEAD`**, case-insensitively; see "Which methods are mutating" below |
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
if (isMutatingMethod(request.method)) {
  upstreamHeaders.set('origin', request.headers.get('origin')!);
}
```

The predicate is called, not re-derived. Amended 2026-08-11 (F-305): this line read
`method !== 'GET' && method !== 'HEAD'` while `isMutatingMethod` consulted a four-item
allowlist, so the same document answered the `OPTIONS` question both ways.

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

### Which methods are mutating

Added 2026-08-11 (ADR-0038; F-305, F-311). Normative, and it settles both the `OPTIONS`
contradiction and the case sensitivity, because they are the same three lines.

**A method is mutating unless it is `GET` or `HEAD`, compared after uppercasing.** The
predicate is a denylist and it defaults to mutating, so an unrecognised spelling gets the
CSRF check rather than skipping it.

```ts
/** The only methods the proxy neither CSRF-checks nor forwards `Origin` on. */
export const NON_MUTATING_METHODS = ['GET', 'HEAD'] as const;

/**
 * True when the proxy must require `Origin` to equal the deployment origin (403 otherwise)
 * and then forward it upstream. Anything not in NON_MUTATING_METHODS is mutating, including
 * OPTIONS and including a method this design does not use. Fails CLOSED.
 *
 * It uppercases: `new Request(u, { method: 'patch' }).method` stays lowercase, because
 * PATCH is absent from the Fetch spec's normalise list, and PATCH is one of the four
 * methods ApiRequest.method allows. Normalising HERE and not at the call site is the
 * point: a docblock telling the caller to uppercase is a rule enforced by nobody (F-288).
 */
export function isMutatingMethod(method: string): boolean {
  return !(NON_MUTATING_METHODS as readonly string[]).includes(method.toUpperCase());
}
```

`MUTATING_METHODS` stays exported and stays `['POST', 'PATCH', 'PUT', 'DELETE']`, and its
role changes: it **describes** the mutating methods this design uses and **no longer defines
the predicate**. `isMutatingMethod` does not read it. Adding a method to it changes no
behaviour, and leaving a method out of it changes no behaviour either, which is what makes
the two safe to hold apart.

**`OPTIONS` is therefore mutating**, which is the reading the `Origin` section always had.
It costs nothing in practice: `/api/bff/*` is same-origin, so browsers do not preflight it,
and a Next.js route handler answers `405` to any method it does not export. If TASK-012 ever
exports `OPTIONS`, that handler requires `Origin` to equal the deployment origin, which is
the correct answer on a surface that runs no CORS.

**The reasoning is ADR-0038's and is not repeated here**: the asymmetry between the two
failure directions, the two rejected alternatives, the browser measurement behind the
uppercasing, and the cost accepted. In one line: a method wrongly called non-mutating loses
its `Origin` and gets F-233's 403 in production with every test green, while a method wrongly
called mutating gets a CSRF check that has already pinned the header to the deployment
origin. A rule restated in two documents is a rule that can diverge in two documents, which
is what F-305 was.

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
  `x-shortkit-client-ip` entirely. It never substitutes another header.
  **Corrected 2026-08-11 (F-320):** this bullet said the API then falls back to
  `Fly-Client-IP`. It falls back to the header `TRUSTED_CLIENT_IP_HEADER` declares, and to
  no principal at all where none is declared, which in local `next dev` is the case. The
  Vercel side is unchanged by that; nothing here moves. `trusted-client-address.md` is
  normative and ADR-0040 is the decision.
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
export declare function requireAuth(): Promise<SessionUser>;   // redirects to /sign-in (amended 2026-08-17, see below)

export interface SessionUser { id: string; email: string; emailVerified: boolean; }
```

`useSession` reads `GET /api/bff/session`, which returns the projection above. **No
token is ever exposed to the client**, in any form.

**Amended 2026-08-17 (identity-membership TASK-007).** `requireAuth` redirects to
**`/sign-in`**, not `/login`. This block and ADR-0014 were written before the sign-in screen
had a route; identity-membership fixed it at `apps/web/app/(auth)/sign-in/page.tsx`
(TASK-008, STORY-003 AC-19 "the sign-in screen"), and `session.ts` carries the target as
`SIGN_IN_ROUTE`. `useSession` lives in `apps/web/src/lib/session/use-session.ts` (a `'use
client'` module, re-exported from `session.ts`); `GET /api/bff/session` and the
refresh-and-bounce `GET /api/bff/session/refresh` (invariant 5) are static routes beside the
`[...path]` catch-all, both shipped by TASK-007.

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
10. **No error this client raises carries a caller-supplied value in `message`, in an own
    enumerable property, or on `cause`.** Added 2026-08-10 (F-284, ADR-0029), amended
    2026-08-11 (F-310). `path` on `ContractViolationError`, `NetworkError` and
    `RequestAbortedError` is the route template, and every message is built from the
    template and the method. A caller may put a bearer credential in a param value, and
    TASK-022's invitation token is one. The resolved URL that carries it exists in two
    places, both inside this module: the argument to `fetch`, and the return value of the
    exported `buildRequestUrl`. It is on no error object.
    The one exception, named because it is one: `RequestAbortedError.cause` is
    `signal.reason`, a value the caller constructed and can read off its own signal.
    **The 2026-08-10 version of this invariant said "reaches the URL, the wire and nothing
    else", and that was false through `cause`** under Node's `fetch`, which puts the
    resolved URL in the rejection's own message. The check that produced the claim,
    `JSON.stringify({...e})` and `Object.keys`, cannot see a non-enumerable property. The
    check that replaced it could not see a getter or anything past a truncation limit, which
    is F-339; the union that stands is in ADR-0029, "The measurement discipline".
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
14. **A request the proxy does not CSRF-check is a `GET` or a `HEAD`.** Added 2026-08-11
    (F-305, F-311). `isMutatingMethod` defaults to mutating and uppercases before comparing,
    so no spelling and no method added later can skip the check by not being recognised.
15. **A route template names each placeholder at most once, and `params` has exactly one
    entry per placeholder.** Added 2026-08-11 (F-313). No supplied value is dropped, and no
    supplied value is substituted into a segment that means something else.
16. **No request this client sends can carry the session cookies off the Vercel origin, and
    none follows a redirect.** Added 2026-08-11 (F-336), shipped 2026-08-10 (F-286).
    `credentials: 'same-origin'` and `redirect: 'error'` are set on every request, so neither
    behaviour depends on a runtime default.

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
  2026-08-10 (F-288), extended 2026-08-11 (F-305). `apps/web/src/lib/api/client.ts` must
  export `FORWARDED_REQUEST_HEADERS`, `FORWARDED_REQUEST_HEADERS_MUTATING_ONLY`
  (`['origin']`), `NON_MUTATING_METHODS` (`['GET', 'HEAD']`), `MUTATING_METHODS` and
  `isMutatingMethod`. This document is not what the proxy
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
- **`cause` is set only in the two abort branches, and only to `req.signal.reason`.** Added
  2026-08-11 (F-310). Chaining a caught rejection onto `NetworkError`,
  `ContractViolationError` or the step 3 `URIError` re-opens the leak, because under Node
  the rejection's own message carries the resolved URL. A test asserting a clean `message`
  does not see it: `cause` is non-enumerable, so the spread, `Object.keys` and
  `JSON.stringify` all miss it.
- **A claim that an error does not carry a value is measured with the union check, never with
  one serialiser.** Added 2026-08-11 (F-339). The check, what each member catches that the
  others do not, and why one channel can never be sufficient are in ADR-0029, "The
  measurement discipline". In short: `util.inspect`'s defaults truncate strings at 10000
  characters and arrays at 100, skip getters, and honour a lying `[util.inspect.custom]`,
  while `JSON.stringify` runs `toJSON` and never sees a non-enumerable property. Pino's `err`
  serialiser walks more than `console.error` does, so "it prints what `console.error` prints"
  is true and is exactly why it is not enough. `client.spec.ts`'s `deepErrorSurface` helper is
  a regression net against known shapes, not the audit check, and no guarantee in this
  document rests on it alone.
- **`isMutatingMethod` normalises its own input and defaults to mutating.** Added 2026-08-11
  (F-305, F-311). The proxy passes `request.method` straight in. An implementation that
  compares verbatim, or that derives the answer from `MUTATING_METHODS`, is a defect.

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

**The 2026-08-11 amendment (F-305, F-310, F-311, F-313, F-314) is breaking in one place and
narrowing in three**, and it lands in the same window: `apiClient` still has no callers, and
the only file importing it is its own spec.

- `NON_MUTATING_METHODS` is a new export. `MUTATING_METHODS` keeps its name and value and
  loses its authority over `isMutatingMethod`. Nothing consumes either yet.
- `isMutatingMethod` answers `true` for strictly more inputs than before. Every input the
  spec asserts today answers as it did.
- `NetworkError` and `ContractViolationError` lose `cause`. This is the breaking one, and it
  breaks nothing today: no test reads `cause` on either, and no consumer exists. The window
  closes at the first consumer that logs an error, the same window ADR-0029 named.
- `invalidParamValueMessage`'s text widens. Message constants are pinned so a second
  implementer cannot invent a third string; they were never a compatibility promise and no
  caller branches on one. The spec asserts this string literally and changes with it.
- A template that repeats a placeholder was already rejected by the shipped client. The
  amendment makes the document say so, so this narrows the document, not the code.
