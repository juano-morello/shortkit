---
id: ADR-0029
slug: foundation
title: A credential is never constructible into an error string
status: accepted
supersedes: null
date: 2026-08-10
---

## Context

TASK-003 spent five audit rounds on one class of defect: a value the caller controls
reaching a string nobody censors. F-093, F-106, F-108, F-242, F-260, F-274 and F-277 are all
that shape. The rule that ended those rounds is stated in `logging-and-headers.md` as a
bullet about pino: "never interpolate an error's message into a log message string", because
`msg` and `err_stack` are the only uncensored surfaces left.

That rule is written per surface. `invitation-tokens.md` says the raw token "never enters a
log line, a structured-log field, or an error message". `error-envelope.md` says constructing
a `DomainError` asserts its message is safe to show a stranger. ADR-0026 says the filter
emits only text it chose itself. Four statements of one rule, each binding one surface, none
binding a surface written later.

The browser client was written later. `apps/web/src/lib/api/client.ts:58` builds
`` `Response from ${path} did not match its contract.` `` and assigns `this.path = path`, and
`:184` builds `` `Request to ${req.path} could not be sent.` ``. The first specified consumer
is TASK-022's invitation-accept screen, which calls `GET /api/invitations/:token`
(`workspace-authorization.md:162`, `@Public()`, "authorisation IS the capability token") with
the only shape `path: string` allows: `` apiClient({ path: `/invitations/${raw}` }) ``. `raw`
is `<tenantId>.<43-char base64url secret>`, a bearer credential granting workspace
membership.

The security auditor measured it on the real class: `String(e)` returns the message with the
token intact, and `JSON.stringify({...e})` yields `{"path":"/invitations/<token>"}` because
`path` is an own enumerable property. A transport failure on a flaky connection triggers it
with no malformed response at all, and reaching a sink needs no code: the browser prints an
unhandled rejection's message and own properties by default, the Next.js error overlay
renders the message, and any error-reporting SDK added later captures `error.message`
unconditionally.

The same file already carries the mirror defence for the other hop. `buildUpstreamUrl`
rejects traversal segments and asserts the origin for the Vercel-to-Fly leg (F-008). The
browser-to-Vercel leg has neither. The threat model was written per hop, and the rule was
written per surface, and both gaps are the same gap.

Nothing is exploitable today: `apiClient` has no callers, the BFF route does not exist, and
`apps/web` has no error boundary or telemetry. This file is the frozen boundary thirteen
TASKs read, so the cost of the same defect found in Implement is a change at every call site.

## Alternatives

### 1. Redact the path at error construction

Detect the credential-shaped part of the resolved path and replace it, so
`/invitations/8f14e45f-....AbC` becomes `/invitations/:param`.

- **Pros.** No interface change, so no consumer TASK is touched. It also covers a caller who
  interpolates a value despite being told not to, which is the only alternative here that
  does.
- **Cons.** It is content detection, and this initiative already rejected content detection
  for this exact class. ADR-0028 alternative 4 lost on "false confidence on the class it
  cannot cover (credentials) in exchange for coverage of one class it can", and
  `logging-and-headers.md` states three times that no censoring scheme reaches inside a
  string. A redactor cannot tell a 43-character secret from a slug, a uuid from a link id, or
  `branding` from a token. Whatever pattern it uses is a guess that has to be right for
  thirteen consumer TASKs' endpoint shapes, including endpoints not yet designed.
- **Why it lost.** It re-adopts a mechanism this initiative rejected eleven findings ago, and
  it leaves the caller's mistake as the thing standing between a token and a console line.

### 2. A required static `label` beside `path`

`ApiRequest` gains `label: string`, the caller passes `'GET /invitations/:token'`, and the
error classes carry the label instead of the path.

- **Pros.** The smallest change that closes the finding. One field, and the path keeps its
  current type and meaning, so nothing else about the client moves.
- **Cons.** Two fields carry the same information and only one of them is load-bearing, so
  the label is documentation with a drift problem: rename a route, forget the label, and
  every error names the old endpoint. Nothing forces the label to be a literal, so a caller
  can build it by interpolation as readily as the path. And it leaves the raw concatenation
  at `client.ts:88` untouched, so F-285's traversal and query injection need a second,
  unrelated fix at the same boundary.
- **Why it lost.** It buys a safe error string with a field that can go stale, and it fixes
  one of two defects that share a root cause.

### 3. Carry no path on the error at all

Message becomes `The response did not match its contract.` with no identifying detail.

- **Pros.** Absolute. Nothing to get wrong, nothing to redact, nothing to review.
- **Cons.** Thirteen screens raise an indistinguishable failure. A support report reading
  "network error" names neither the endpoint nor the screen, and the client is the only place
  that knows.
- **Why it lost.** Debuggability at the boundary every screen calls is worth more than the
  residual it removes, and option 4 keeps both.

## Decision

**The rule, stated once and cross-cutting.**

> A value a caller supplies at runtime is never constructed into an `Error.message`, an own
> enumerable property of an `Error`, or any other string a default sink prints. Only values
> that are literal in the source, or drawn from a closed union declared in the source, may be
> interpolated into error text. This binds every surface in the repository, not only the ones
> whose contract repeats it. A surface that needs to identify the failing operation names it
> with a value that is static by construction.

The test to apply: if the value's origin is a route param, a form field, a header, a body, an
environment read or a database row, it is not eligible. If it is a string literal in the
source file, an enum member, or an HTTP method drawn from `'GET' | 'POST' | 'PATCH' |
'DELETE'`, it is.

**Materialisation at the web client.** `ApiRequest.path` becomes a route template and
caller-supplied values move to `params`:

```ts
export const ROUTE_TEMPLATE_PATTERN =
  /^(?:\/(?:[a-z0-9][a-z0-9-]{0,63}|:[a-zA-Z][a-zA-Z0-9]{0,29}))+$/;

apiClient({
  method: 'GET',
  path: '/invitations/:token',        // literal in the source; this is what errors carry
  params: { token: raw },             // encodeURIComponent'd into the URL, never into text
  contract: invitationContract,
});
```

`ContractViolationError`, `NetworkError` and `RequestAbortedError` carry `path`, and its value
is the template. The resolved URL exists in exactly one place: the argument to `fetch`. The
normative construction, the ordered rejection rules and the message constants are in
`web-api-client.md`, "Request path construction".

The template is checked at runtime against `ROUTE_TEMPLATE_PATTERN` before the request is
sent. The check exists because the type system cannot require a literal: a caller who
interpolates a token into `path` is caught by the pattern, since the invitation token's `.`
separator is not in the literal-segment alphabet and cannot be. The rejection throws a plain
`Error` whose message names the method and nothing else, because a rejection path that echoes
the offending value is the leak wearing a different hat.

## Consequences

**Positive.**

- The value that reaches `Error.message` and the value that reaches the wire are now
  different values with different types of origin. A credential is not expressible in the
  first.
- One change closes two findings. Templates plus `encodeURIComponent` per param remove the
  raw concatenation F-285 exploits, and the pattern rejects `..`, `%2e%2e`, `?`, `#`, `\` and
  the empty segment at the browser leg, which is the mirror of the segment rejection
  `buildUpstreamUrl` already performs at the Fly leg.
- The template is the label, so there is nothing to keep in sync.
- Thirteen consumer TASKs get one way to build a path, and it is the safe one.

**The cost accepted.**

- **A frozen field changes meaning.** `ContractViolationError.path` stays a `string` and stays
  present, so nothing breaks at compile time, but its value is now the template rather than
  the resolved path. A reader who remembers the old semantics reads a value that no longer
  identifies the individual request. That is the point, and it is still a silent semantic
  change to a field `web-api-client.md` had frozen.
- **The pattern is an allowlist, so it refuses legitimate paths that do not fit.** An endpoint
  with an uppercase or percent-encoded literal segment cannot be expressed and requires
  amending the pattern and this ADR. Every `/api` path in the design today is lowercase kebab.
- **A secret shaped like a lowercase-kebab segment still passes.** The pattern rejects the
  invitation token deterministically, on the `.` separator, and rejects any base64url secret
  containing an uppercase letter or `_`. It does not reject a hypothetical all-lowercase
  alphanumeric secret, which for a 43-character base64url string is roughly `(37/64)^43`. The
  rule is what forbids interpolation; the pattern is the backstop, not the guarantee.
- **`cause` is out of scope of the guarantee.** `RequestAbortedError.cause` carries the
  platform rejection or `signal.reason`, which is whatever the caller passed to `abort()`. The
  client cannot vouch for a value the caller constructed.
- **A fourth exported error class and a required-in-practice `params` field** raise the API
  surface of the module every screen imports.
- **A runtime check on every call**, for a defect the type system cannot see. It is one regex
  test and a small loop, and it runs before the network, so the cost is noise. The honest cost
  is the code, not the time.

**Follow-up work this creates.**

- Thirteen consumer TASKs build paths as templates. Any card whose `Approach` shows a
  concatenated path needs correcting when it is written.
- `apps/web` has **no fenced-source drift test**, verified: `.github/scripts/` holds only
  `assert-contract-drift.mjs` (AC-14, contract mutation versus typecheck),
  `assert-integration-collected.mjs` and a SQL provisioner, and `apps/web/scripts/` holds only
  `assert-no-inlined-secrets.mjs`. Nothing mechanically keeps `client.ts` and its design stub
  in agreement. That absence is the root of F-288 and this ADR adds surface to it. A gate
  belongs to a TASK that does not exist yet; naming it here so it is a known gap.
- No gate enforces the cross-cutting rule either. TASK-056 greps for a thrown `HttpException`
  subclass, which is the nearest existing precedent for a rule enforced by a grep. A grep for
  a template literal inside `new Error(` or `super(` is the shape a future gate would take.
- The rule belongs in the repository's own conventions, not only in this ADR. Where those live
  is a Ship-phase question.
