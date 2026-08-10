# TASK-008 — security audit, round 1

- TASK: TASK-008 (STORY-004, EPIC-001) — web typed API client and error surface
- Auditor: `sdlc-security-auditor`, first audit of this TASK, `rework_count: 0`
- HEAD audited: `ecc9275`; files `apps/web/src/lib/api/client.ts`, `client.spec.ts`
- Date: 2026-08-10

> TRANSCRIPTION NOTE (orchestrator). The auditor could not write this file itself: its
> dispatch told it to write the report to this path AND not to write any file inside the
> repository. Those instructions contradict. It took the safe reading, wrote nothing, and
> returned the report inline. That is correct behaviour against a defective brief, and the
> brief was mine. Content below is the auditor's, transcribed verbatim in substance.

## verdict: changes-requested — 0 blocker, 2 major, 2 minor, 1 nit

### MAJOR — the caller-supplied path reaches Error.message and an enumerable own property
`apps/web/src/lib/api/client.ts:58` (also :60, :184, :193)

TASK-022's invitation-accept screen calls the only endpoint the design gives it,
`GET /api/invitations/:token` (`workspace-authorization.md:162`, `@Public()`,
"authorisation IS the capability token"), as ``apiClient({ path: `/invitations/${raw}` })``.
`raw` is `<tenantId>.<43-char base64url secret>` (`invitation-tokens.md`) — a bearer
credential granting workspace membership, whose own contract states: **"The raw token is
never stored, never logged, and never returned by any read."**

Any contract violation OR TRANSPORT FAILURE on that call constructs an error whose message is
`Response from /invitations/<tenantId>.<secret> did not match its contract.`

Measured on the real class: `String(e)` returns that string with the token intact, and
`JSON.stringify({...e})` yields `{"name":"ContractViolationError","path":"/invitations/<token>",...}`
— `path` is an OWN ENUMERABLE property, so it survives structured cloning and any telemetry
serialiser that spreads the error.

An unhandled rejection needs no code to reach a sink: the browser prints the message and the
expandable own properties by default, the Next.js error overlay renders the message, and any
error-reporting SDK added later captures `error.message` unconditionally. **A NetworkError on
a flaky connection (`client.ts:184`) is the highest-frequency trigger and needs no malformed
response at all.**

Attacker: anyone with read access to the invitee's console or client telemetry — a browser
extension with page access, a support screen-share, a shipped error-reporting backend, a
shared or kiosk browser — replays the token before expiry and joins the workspace as the
invitee.

Required change: keep the full caller-supplied path out of `Error.message` and off enumerable
own properties on `ContractViolationError` and `NetworkError`. Redact to a non-identifying
form (`/invitations/:param`) or require a static `label`. `ContractViolationError.path` is
frozen in `web-api-client.md`, so this needs a contract amendment in the same change — cheap
now, 13 call sites later.

### MAJOR — requestUrl concatenates the path raw; traversal and query injection
`apps/web/src/lib/api/client.ts:88`

``const url = `${BFF_PATH_PREFIX}${path}` `` with no validation, no encoding, no guard on `?`
or `#`. Measured against the WHATWG URL parser, origin `https://app.shortkit.dev`:

    /links/../../auth/token       -> https://app.shortkit.dev/api/auth/token
    /links/%2e%2e/%2e%2e/secret   -> https://app.shortkit.dev/api/secret
    /links?workspaceId=other      -> .../api/bff/links?workspaceId=other
    /links?a=b + query {limit:25} -> .../api/bff/links?a=b?limit=25

Two consequences. **(1)** Traversal is normalised by the browser BEFORE the request is sent,
so it never reaches `/api/bff/*` and the proxy's normative segment rejection
(`buildUpstreamUrl`, same file :246-259, F-008) NEVER RUNS — that defence guards the
Vercel-to-Fly hop; this is the browser-to-Vercel hop. Percent-encoding does not save a
defensive caller: `%2e%2e` normalises identically. **(2)** An unescaped `?` appends
attacker-chosen query parameters to an authenticated call, and corrupts any `query` object
the caller passed.

Attacker: an authenticated dashboard user, or anyone who gets a victim to open a crafted
dashboard URL whose route param is interpolated into `path`.

Required change: validate and encode at this boundary. Reject or encode any path whose
decoded segments contain `..`, `.`, empty, `/`, `\`, `:`, `?`, `#`; or take a template plus a
`params` record and `encodeURIComponent` each value. Assert the final URL still begins with
`/api/bff/` after normalisation — the browser-side mirror of the origin assertion this file
already calls load-bearing for the proxy.

### MINOR — neither `credentials` nor `redirect` is set
`apps/web/src/lib/api/client.ts:107`

Measured defaults: `credentials: same-origin`, `redirect: follow`. `credentials` is correct
today ONLY because the URL is relative — an invisible dependency with no test, which fails in
two directions: a future absolute URL silently drops the `sk_at` cookie, and the natural fix
for that symptom is `credentials: 'include'`, which sends cookies cross-origin.

`redirect: follow` is sharper: `UPSTREAM_FETCH_REDIRECT = 'manual'` at :270 of this same file
exists so a 3xx is "returned to the caller, never followed" — and the caller, this function,
then follows it automatically. A `Location` to another origin makes the victim's browser
issue that cross-origin request unprompted; the fetch rejects on CORS and surfaces as a
NetworkError, hiding that the request was made.

Required change: set `credentials: 'same-origin'` and `redirect: 'error'` explicitly. Both
one-line and behaviour-preserving today.

### MINOR — RETURNED_RESPONSE_HEADERS omits `cache-control`
`apps/web/src/lib/api/client.ts:278`

This constant is what TASK-012 will build the proxy's response-header allowlist from. An API
response carrying `Cache-Control: no-store` for tenant data arrives with no cache directive,
and the decision falls to browser heuristics on a 200 GET. Attacker: someone with later
filesystem access to the same browser profile reading another tenant's data out of the HTTP
cache after the session cookie expired. `web-api-client.md`'s response-header row owns this
list; decide it here rather than inside TASK-012.

### NIT — no response size cap, no default timeout
`apps/web/src/lib/api/client.ts:190`. Self-inflicted DoS only; the same-origin proxy is the
only reachable peer.

## The four questions

**1. Error leakage.** THE FLAGGED HAZARD IS NOT PRESENT, MEASURED. zod 4.4.3's `finalizeIssue`
(`zod/v4/core/util.js:565-570`) destructures `input` out of every issue and re-attaches it only
when the parse context sets `reportInput`; `client.ts:213` calls `safeParse(body)` with no
second argument. Probed: a body containing `sk_live_51H8xQ2SECRETTOKEN` produced one issue
carrying `{origin, code, format, pattern, path, message}` and NOT the value; the same parse
with `{reportInput: true}` DID surface it. Mechanism confirmed in both directions.

The diff contains no `console.*`, no logger, no telemetry, no `process.env` read, no
cookie/localStorage/sessionStorage/Authorization access. The leak that exists is the request
path, not the body.

Two residual channels to constrain in the contract before a response schema uses them (no
finding today, no such contract exists): `issue.path` carries input-derived object keys for
`z.record` (measured: a key of `victim@example.com` lands in `path`), and
`unrecognized_keys` carries input key names under `.strict()`.

**2. BFF topology.** Clean where it matters most. `apiClient` names no origin, reads no base
URL, touches no token — the F-174 trap is ABSENT rather than avoided. It cannot be pointed
off-origin: because the concatenation always begins with the literal `/api/bff`, the result is
always path-absolute; `//evil.example/x` becomes `/api/bff//evil.example/x` (same origin, not
protocol-relative) and `https://evil.example/x` becomes `/api/bffhttps://evil.example/x`. What
does reach the browser leg is prefix escape and query injection — major 2.

**3. `credentials` and CSRF.** The httpOnly cookie is sent: relative URL, same-origin request,
default `credentials: same-origin` (measured). Nothing opens a cross-origin path. The proxy's
CSRF rule will function: `Origin` is a forbidden header name that fetch sets itself on every
non-GET/HEAD request including same-origin, so a proxied mutation always carries the
deployment origin and cannot be forged from JS. The gap is that NONE of this is asserted by a
test — every spec stubs `fetch` and none inspects the `RequestInit`.

**4. Dependencies.** The implementer's statement is CORRECT, verified. Lockfile unmodified,
`git status` empty. `apps/web/package.json` declares `"zod": "4.4.3"`, byte-identical to
`packages/contracts`. Exactly one zod resolves: a single `zod@4.4.3` directory in
`node_modules/.pnpm/` (`better-call@1.3.7_zod@4.4.3` is a peer-suffixed better-call, not a
second copy), and both workspace symlinks resolve to the same real path. `apps/api` has no
zod, as ADR-0025 requires.

## Notes

- **Nothing in this diff is exploitable today.** `apiClient` has no callers, the BFF route does
  not exist, and there is no error boundary or telemetry in `apps/web`. Both majors are
  reachable only through consumers that are specified but unbuilt. Filed at `major` anyway
  because this file is the frozen boundary 13 TASKs read, the endpoint shapes that make them
  exploitable are already normative, and the same defect found in Implement costs a change at
  every call site instead of one.
- **Both majors are the browser-leg mirror of defences this file already declares for the
  Vercel-to-Fly leg** (F-008 traversal rejection at :246-259, `redirect: 'manual'` at :270).
  The design got the second hop right and left the first hop bare. RETRO: the threat model was
  written per-hop rather than per-request.
- **Major 1 is the exact mirror of TASK-003's five rounds on the API side.** The rule that
  emerged there — a credential must not be constructible into a message string, because every
  sink downstream is a default — was not carried across to the browser client. State it once,
  cross-cutting, rather than re-deriving it per surface.
- `error-envelope.md`'s Versioning section requires `<ErrorMessage />` to fall back to a
  generic message for an unknown `code`. Until it exists, any screen rendering
  `ApiError.message` renders a server-supplied string — safe under React's default escaping,
  unsafe the moment anyone reaches for `dangerouslySetInnerHTML`.

## What I could not verify

- **Real browser behaviour.** All measurements of `credentials`, `redirect` and URL
  normalisation were made against Node 24.19's WHATWG URL parser and `Request` constructor,
  which implement the same specs — not against Chrome or Firefox. No test in the repo
  exercises a real fetch.
- **That the leak sinks in major 1 fire.** No error boundary, telemetry or proxy route exists,
  so the token reaching a console line was reasoned, not observed.
- **Better Auth's native error bodies.** No contract states their shape, so it is unconfirmed
  that none coincidentally validates as an `ErrorEnvelope`.
- **Whether any consumer TASK other than invitations puts a secret in `path`.** Checked the
  invitation and auth surfaces; did not read all 13 consumer cards.
