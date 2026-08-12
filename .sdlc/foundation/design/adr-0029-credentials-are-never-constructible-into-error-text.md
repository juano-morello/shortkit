---
id: ADR-0029
slug: foundation
title: A credential is never constructible into an error string
status: accepted
supersedes: null
date: 2026-08-10
---

> **Amended 2026-08-11 (F-310). One sentence in this ADR was measurably false and is now
> corrected, not reinterpreted.** The Decision said the resolved URL "exists in exactly one
> place: the argument to `fetch`", and the client's own docblock said caller values reach
> "the URL, the wire, and NOTHING ELSE". Under Node's `fetch` the rejection handed to
> `{ cause }` carries the resolved URL in its own message, and `util.inspect` prints it,
> which is what `console.error(err)` calls and what pino's `err` serialiser walks. The
> guarantee was stated over every channel while only two had been measured. The rule below
> did not change. What changed is that `cause` is now inside its scope for
> `NetworkError` and `ContractViolationError`, which no longer carry one, and the
> `RequestAbortedError` carve-out is narrowed to `signal.reason` read off the signal. See
> "The 2026-08-11 amendment" in Alternatives and Consequences.

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

### The 2026-08-11 amendment: what to do about `cause`

Two options, both real, both argued before the third was written.

**A. Keep `cause` and rule it out of scope for all four classes.** The ADR already carves
`RequestAbortedError.cause` out, so this extends an existing exception rather than inventing
one, and it keeps the platform rejection for debugging at zero cost.

- **Pros.** Nothing to implement. The most useful diagnostic on a transport failure stays
  reachable, which under Node is the difference between a bad hostname and a refused
  connection.
- **Cons.** It makes the guarantee conditional on every sink, and this ADR exists because
  per-surface rules do not bind surfaces written later. `util.inspect` is the default path
  through `console.error(err)` and pino's `err` serialiser, so the leak needs no code written
  to happen while the defence needs code written in thirteen consumer TASKs, any telemetry
  SDK added later, and the Next.js error overlay. The carve-out is also invisible to the
  obvious test: `cause` is non-enumerable, so the spread, `Object.keys` and `JSON.stringify`
  all report clean.
- **Why it lost.** It answers a finding about an unenforceable rule by writing another
  unenforceable rule.

**B. Replace `cause` with a sanitised projection the client constructs**, carrying the
rejection's `name` and no message.

- **Pros.** Keeps the one field worth keeping, and the value is a short platform token rather
  than an interpolated string.
- **Cons.** `name` fails this ADR's own eligibility test. It is not a literal in the source
  and not a member of a union declared in the source, so the module would be vouching for a
  platform value on the strength of having never seen it carry a URL. It also adds an
  exported shape that thirteen consumer TASKs must learn, to distinguish failures a browser
  reports as `TypeError('Failed to fetch')` uniformly.
- **Why it lost.** It buys back little real signal and pays for it with a new public shape
  and a weakened test.

**Chosen: `NetworkError` and `ContractViolationError` carry no `cause` at all**, and
`RequestAbortedError`'s comes from `req.signal.reason` rather than from the caught rejection.

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
is the template. ~~The resolved URL exists in exactly one place: the argument to `fetch`.~~
**Amended 2026-08-11 (F-310).** The resolved URL exists in two places, both inside
`client.ts`: the argument to `fetch`, and the return value of the exported `buildRequestUrl`.
It reaches no error object. The original sentence was wrong twice: `buildRequestUrl` was
exported during implementation and the sentence was not revisited, and the platform rejection
that `fetch` produces carries the resolved URL in its own message, which the client then
attached to `NetworkError` as `cause`. The normative construction, the ordered rejection
rules and the message constants are in `web-api-client.md`, "Request path construction".

**`cause` carries nothing this module chose.** Added 2026-08-11 (F-310).

> No error this client raises carries a `cause`, with one exception.
> `NetworkError` and `ContractViolationError` are constructed with no `options` argument, and
> the `URIError` a rejected param value raises at step 3 is not chained either.
> `RequestAbortedError` is constructed with `{ cause: req.signal.reason }`, read off the
> signal rather than taken from the caught rejection, so an abort racing a transport failure
> cannot put a platform rejection there.

`signal.reason` stays outside the guarantee because the caller constructed it, holds it, and
can read it back off its own `AbortSignal`. The client is a pass-through for that one value
and cannot vouch for it. A caller must not pass a credential to `abort(reason)`.

The rule this ADR states did not change. `cause` was always inside its scope by the plain
reading of "any other string a default sink prints"; the ADR failed to say so because nobody
had measured `util.inspect`.

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
- ~~**`cause` is out of scope of the guarantee.** `RequestAbortedError.cause` carries the
  platform rejection or `signal.reason`, which is whatever the caller passed to `abort()`. The
  client cannot vouch for a value the caller constructed.~~ **Amended 2026-08-11 (F-310).**
  This bullet named the right exception for the wrong reason and drew its boundary in the
  wrong place. It carved out one class while three others were carrying a `cause` the client
  itself supplied, and it described that `cause` as possibly "the platform rejection", which
  is precisely the value that leaks. The carve-out now covers `signal.reason` only, and only
  on `RequestAbortedError`.
- **A transport failure carries no platform detail.** Cost accepted 2026-08-11 (F-310). A
  developer diagnosing one has the class, the method, the route template and whether the
  failure was on send or on read, and nothing else. In a browser that costs little, since
  `fetch` rejects with `TypeError('Failed to fetch')` for DNS, TLS, CORS and offline alike.
  Under Node it costs more, and Node is the leg the rule protects, so the cost falls exactly
  where the benefit does.
- **The client now discards information the platform gave it**, which is a shape that invites
  a future implementer to add `{ cause }` back as an obvious improvement. The defence is one
  bullet in `web-api-client.md`'s "What the implementer must guarantee" and the docblocks. No
  gate catches it, and a test asserting a clean `message` never will, because `cause` is
  non-enumerable.
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
- **A grep for the cross-cutting rule now has a second pattern to carry.** Added 2026-08-11
  (F-310). Alongside a template literal inside `new Error(` or `super(`, a gate would look for
  `{ cause` in `apps/web/src/lib/api/client.ts` and expect exactly the two abort branches.
  Both patterns belong to the same non-existent TASK.
- ~~**A measurement discipline this ADR should have applied to itself.** Every check that
  cleared the original claim is blind to a non-enumerable property. `util.inspect(err, {
  depth: 5 })` is what a Node log line actually prints and it is the check that found this.
  Any future claim about what an error does not carry is measured with `util.inspect` or it
  is not measured.~~ **Corrected 2026-08-11, same day, second try (F-339). The rule as first
  written had the defect it was written to fix**: it replaced one blind single-channel check
  with another. See "The measurement discipline" below.
- **The audit check is a union, its members are not interchangeable, and it is a floor.** See
  the section below, which is normative for anyone making a claim about what an error does not
  carry.
- **Adjacent rulings, recorded so a reader of this ADR is not misled.** On the same day, four
  questions that are not this ADR's were settled. Whether `OPTIONS` is mutating and whether
  `isMutatingMethod` normalises case are **ADR-0038** (F-305, F-311). Whether a route template
  may repeat a placeholder, and the text of `invalidParamValueMessage`, are normative sections
  of `web-api-client.md` (F-313, F-314). Only the last touches this ADR's subject, and it does
  so in the direction the ADR requires: the widened message still names no value.

## The measurement discipline

Added 2026-08-11 (F-339), replacing the single-check rule this ADR adopted earlier the same
day. Normative for any claim in this repository that an error does not carry a value.

### Why a single channel cannot be sufficient

Every serialiser is a **policy over an object graph**, and the policies differ on at least
five axes:

1. **Which keys it walks.** Own or inherited, enumerable or not, string-keyed or
   symbol-keyed.
2. **How deep it walks.** `util.inspect` stops at `depth`, default 2, and prints `[Object]`.
3. **How much of a value it prints.** `maxStringLength` defaults to 10000 and
   `maxArrayLength` to 100. Past those it prints `... N more characters` and
   `... N more items`.
4. **Whether it runs the object's own code.** Getters, `toJSON`, `[util.inspect.custom]`.
   `inspect` skips getters by default and never calls `toJSON`; `JSON.stringify` always calls
   `toJSON` and never sees a non-enumerable property.
5. **How it renders a value it declines to walk.** A class instance prints as `X {}` under
   `inspect` while `String(x)` runs its `toString`.

Two serialisers either differ on one of those axes or one of them is redundant. A check is a
claim about one policy. **A guarantee is a claim about every sink, and the sinks are chosen
later by people not reading this document.** So the check has to be a union that covers the
axes, not a single call, however good the single call is.

"`util.inspect` prints what `console.error(err)` prints" is true, and it is exactly what makes
it insufficient: **pino walks more than `console.error` does.** Measured on Node 24.19.0
against `pino-std-serializers@7.1.0`, the version this repo resolves, four shapes report clean
under `inspect(err, { depth: 5 })` while pino's `err` serialiser emits the secret: an
enumerable getter, an own string longer than 10000 characters with the secret past the cut, an
own array of 150 entries with the secret at `[149]`, and `AggregateError.errors` past the same
limit. A fifth, a `toJSON()` returning the secret, is `inspect`-clean and leaks through
`JSON.stringify`. Ten evasion shapes were tried and the mandated check caught one.

The first rule was not even a superset of the checks it dismissed: the getter and the `toJSON`
shapes are both caught by `JSON.stringify({ ...err })`, which the amendment had called
inadequate. It traded one partial view for a different partial view and described the trade as
a fix, which is the same error it had just diagnosed.

### The check

```js
import { inspect } from 'node:util';

/**
 * The audit surface of an error. Scratch-harness code; nothing ships importing this.
 *
 * EVERY MEMBER IS WRAPPED. Three of the four throw on shapes that occur in real errors,
 * and a check that dies is a check whose next reader deletes a member to make it run.
 * A throw is recorded, and a recorded throw is NOT a clean result.
 */
function errorSurface(err) {
  const members = [
    () =>
      inspect(err, {
        depth: Infinity,
        maxStringLength: Infinity,
        maxArrayLength: Infinity,
        getters: true,
        showHidden: true,
        customInspect: false,
      }),
    () => JSON.stringify(err),
    () => JSON.stringify({ ...err }),
    () => Object.getOwnPropertyNames(err).map((k) => String(err[k])).join('\n'),
  ];

  return members
    .map((run) => {
      try {
        return String(run());
      } catch (e) {
        return `<member threw: ${e.name}> INCONCLUSIVE`;
      }
    })
    .join('\n');
}
```

### What each member catches, measured

Measured 2026-08-11 on Node 24.19.0 by the architect, per member, rather than transcribed
from the finding: eighteen shapes across two harnesses, then the function exactly as written
above against sixteen of them, which it caught 16 of 16 with no member throwing.
`inspect(err, { depth: 5 })` caught one of the same set. The rows:

| shape | `inspect` all-lifted | `JSON.stringify(err)` | `JSON.stringify({...err})` | names + `String` |
|---|---|---|---|---|
| enumerable getter | catch | catch | catch | catch |
| own string past 10000 chars | catch | catch | catch | catch |
| own array past 100 entries | catch | catch | catch | catch |
| `AggregateError.errors[149]` | catch | miss | miss | catch |
| own `toJSON()` returning the secret | **miss** | catch | catch | miss |
| `toJSON()` on the **prototype** hiding an own prop | catch | **miss** | catch | catch |
| lying `[util.inspect.custom]` | catch | catch | catch | catch |
| non-enumerable data property | catch | miss | miss | catch |
| non-enumerable getter | catch | miss | miss | catch |
| `cause` chain 7 deep | catch | miss | miss | miss |
| symbol-keyed property | catch | miss | miss | miss |
| value whose `toString()` returns the secret | **miss** | miss | miss | catch |
| circular own property | catch | **throws** | **throws** | catch |
| `BigInt` own property | catch | **throws** | **throws** | catch |
| throwing getter | catch | throws | throws | throws |
| null-prototype object property | catch | catch | catch | **throws** |

What that buys, stated as the unique contributions rather than as a claim per member:

- **`inspect` with every limit lifted** is the only member that reaches a `cause` chain past
  the default depth and the only one that sees a symbol-keyed property. Every option on it is
  load-bearing: `depth` covers axis 2, `maxStringLength` and `maxArrayLength` axis 3,
  `getters: true` and `customInspect: false` axis 4, `showHidden: true` the non-enumerable half
  of axis 1. It is also the most robust: it threw on nothing.
- **`JSON.stringify(err)`** is the only member that runs a `toJSON()`. `inspect` never calls
  one, at any depth, with any options.
- **`getOwnPropertyNames(...).map(String)`** is the only member that reads each value through
  the coercion a template literal performs, so `class X { toString() { return secret; } }`,
  which `inspect` prints as `X {}`, is caught here and nowhere else. That coercion is the one
  the original F-284 defect used.
- **`JSON.stringify({ ...err })` caught nothing in eighteen shapes that the other three missed,
  and it is kept anyway.** Two reasons, both stated because a redundant member has to earn its
  place out loud. It makes this union a strict superset of the round-1 checks, which was half
  of F-339's complaint about the rule it replaces. And it is one of the three members that run
  unchanged in jsdom, where `node:util` is not available.

Two corrections to the check as the finding specified it, both found by measuring it. A
prototype-level `toJSON` is what `{ ...err }` bypasses; an **own** `toJSON` is copied by the
spread and runs again, so the spread does not bypass that one. And `AggregateError.errors` is
caught by the names member as well as by `inspect`, not by `inspect` alone.

### The residual, named rather than implied

**This is a floor, not a proof.** It models the sinks that exist today: `console.error`, pino's
`err` serialiser, `JSON.stringify`, and string coercion. A sink that walks the graph by some
other policy is not covered, and the honest examples are a telemetry SDK's own normaliser, a
future serialiser version with different defaults, and anything reading through a `Proxy`. The
four members were chosen because they span the five axes above, so a new sink is likely to be
a combination of policies already covered. Likely is not proven, and the next agent to widen
this check should say what it added and which axis it belongs to.

**A member that throws has measured nothing.** Three of the four throw on shapes that occur in
ordinary errors: a circular own property, a `BigInt`, a getter that throws, a null-prototype
object. `<member threw>` is an inconclusive result for that member, never a clean one, and a
check reported as clean while a member threw is the third instance of this ADR's own defect.

**The union is measured on Node, and the browser leg is inferred.** Every number above is Node
24.19.0. No claim here has been checked against Chrome, Safari or Firefox, and the browser's
own error rendering is a fifth policy nobody in this initiative has measured.

**The spec helper is deliberately narrower.** `apps/web/src/lib/api/client.spec.ts` runs under
jsdom in the web package, where importing `node:util` is awkward and off-platform for a
browser-leg test. Its `deepErrorSurface` helper is a **regression net against known shapes**,
not the audit check, and no claim in this repository rests on it alone. Three of the four
members above need no `node:util` and work unchanged in jsdom: `JSON.stringify(err)`,
`JSON.stringify({ ...err })`, and the `getOwnPropertyNames` read. Whether the helper takes
them is the test architect's call. If it does not, this paragraph is why, and the harm
assertions written against it are pinning the shapes they name and nothing wider.
