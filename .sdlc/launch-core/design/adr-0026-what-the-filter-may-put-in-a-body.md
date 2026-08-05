---
id: ADR-0026
slug: launch-core
title: The exception filter emits only text and shapes it chose itself
status: accepted
supersedes: null
date: 2026-08-05
---

## Context

The filter shipped (TASK-007) and two paths through it put values into a response body
that the filter did not construct.

The framework-400 arm copies an `HttpException`'s own message into
`details.fieldErrors._form`, which `error-envelope.md` mandates. Nest 11 maps a
body-parser `SyntaxError` to `new BadRequestException(err.message)`
(`@nestjs/core/router/routes-resolver.js:94-100`, `mapExternalException`), and Node's
`JSON.parse` message quotes the input. Measured on Node 24.19:
`JSON.parse('{"password":"hunter2","token":"eyJhbGciOi","x":}')` gives
`Unexpected token '}', ..."ciOi","x":}" is not valid JSON`. The same arm receives express's
`URIError`, whose message router 2.2.0 rewrites to `Failed to decode param '<value>'`
(`router/lib/layer.js:227-228`), quoting the raw path segment. So an unauthenticated POST
with a malformed body gets 15 to 30 of its own bytes back inside a JSON envelope.
Invariant 8 says no error body contains a password or a token. The bytes are the sender's
own, so no privilege boundary is crossed, but the invariant is written as an absolute and
a fragment of a bearer token can land there.

`details` is the second path. ADR-0024 typed it `unknown` on `DomainError` and accepted
the cost: "The filter forwards it verbatim. Only review catches that." That was written
before the filter existed. The filter now imports from the package that declares
`validationDetailsContract`, so the check is one line, and `errorEnvelopeContract` types
`details` as `z.unknown().optional()`, which means every envelope assertion in every
downstream spec passes whatever a throw site attached. Fourteen TASKs write throw sites.
The tempting shape for `hostname_already_claimed` or `last_owner_protected` is the row
that conflicted, and that row belongs to another tenant.

The 404 arm already answers the question the right way. TASK-007's implementer replaced
the framework's `Cannot ${method} ${url}` with a fixed `NOT_FOUND_MESSAGE` because the
framework text reflects the request URL. The rest of the filter had no such rule.

## Decision

**The filter writes only strings and shapes it chose. Anything reaching it from
somewhere else is either validated against a shape this contract names, or dropped.**

Three parts, all normative in `error-envelope.md`.

**1. The framework-400 arm carries a fixed message.** `_form` gets
`FRAMEWORK_BAD_REQUEST_FORM_MESSAGE = 'The request could not be parsed.'`. The
`HttpException`'s own message never reaches the body. It goes to the log, through the
same helper branch 4 already uses. The wording covers both producers on that arm, a
malformed JSON body and a bad percent-encoding in a path segment.

**2. `details` is narrowed before the body is written, on every branch.**

```ts
// apps/api/src/common/errors/error-envelope.ts
export function narrowEnvelope(envelope: ErrorEnvelope): ErrorEnvelope;
```

- `details === undefined`: unchanged.
- `code === 'validation_failed'`: `validationDetailsContract.safeParse(details)`. On
  success the envelope carries `parsed.data`, which is the parse output, not the input.
  `z.object` strips unknown keys, so a sibling key attached beside `fieldErrors` does not
  survive (verified against zod 4.4.3). On failure `details` is dropped.
- Any other code: `details` is dropped. This contract names a shape for exactly one code.
- The filter compares the returned envelope against the one it had. When `details` was
  present and is now gone, it logs at `warn` with the `code` and **never the dropped
  value**. The value is the thing suspected of carrying another tenant's data, and a log
  is not a safe place to put it (GC-9).

`narrowEnvelope` is applied once, to the body the filter is about to write, so branch 1's
`toEnvelope()` output goes through it as well as branches 2 to 4. This is deliberately at
the boundary rather than inside `DomainError`: a subclass in a feature directory can
override `toEnvelope()`, and the filter is the last thing that runs either way.

**3. Message constants are pinned in the contract**, so a second implementer meeting the
same gap does not invent a third string. `NOT_FOUND_MESSAGE`, `VALIDATION_FAILED_MESSAGE`
and `FRAMEWORK_BAD_REQUEST_FORM_MESSAGE` are listed in `error-envelope.md` with their
exact values. Pinning the value is not a compatibility promise: invariant 3 still holds,
callers still must not branch on a message, and changing the wording is not a breaking
change.

**This reverses one accepted consequence of ADR-0024**, the last bullet under its
Negative section. ADR-0024 is otherwise unchanged and stays accepted; `details` is still
typed `unknown` on the class, and the throw site is still free to attach anything. What
changes is that attaching the wrong thing now produces a body without `details` and a log
line, instead of a body with another tenant's fields.

The filter still forwards a `DomainError`'s **message** verbatim. That promise stays
where ADR-0024 put it, on the throw site, and nothing here validates it. See Consequences.

## Alternatives considered

### For the framework-400 message

| Option | Pros | Cons | Why not |
|---|---|---|---|
| Keep the pass-through (the contract as written) | The caller learns what was actually wrong with its request, which is the single most useful thing on a malformed body. No code change | Ships caller bytes into a JSON body from an unauthenticated request, against invariant 8's absolute wording. Inconsistent with the 404 arm in the same function, which was fixed for the same reason | The invariant is stated without exception and 17 TASKs consume it. An invariant with one undocumented exception is not one anybody can rely on |
| Truncate the message to N characters | Keeps some diagnostic value. Bounded output | Does not work. The raw bytes sit in the middle of the JSON.parse message and at the front of `Failed to decode param '<value>'`, so no prefix or suffix cut reliably removes them. N would be arbitrary | Solves the size problem, not the disclosure problem, and the disclosure problem is the finding |
| Allow-list: pass through only messages matching known-safe framework patterns | Keeps the diagnostic for the shapes we have checked | A per-version list of framework message formats across Nest, express, router and body-parser. It fails open: a new shape not on the list is either dropped anyway or passed through unchecked | Maintenance against three upstream packages for a message a client is forbidden to branch on |

### For `details`

| Option | Pros | Cons | Why not |
|---|---|---|---|
| Keep forwarding verbatim (ADR-0024's accepted cost) | Nothing to build. A throw site that wants to hand the client extra structure can | The leak it permits is silent end to end: the type is `unknown`, the envelope contract accepts anything, and no downstream spec fails. The reviewer that was supposed to catch it is one human reading one of fourteen diffs | The cost was accepted when the alternative was a design mechanism. The alternative is now one line in a file that already imports the schema |
| Type `details` per code on `DomainError`, e.g. `DetailsFor<C> = C extends 'validation_failed' ? ValidationDetails : never` | Compile-time, so the mistake never reaches runtime. Strictly earlier than a filter check | Changes `DomainError`'s constructor signature after it shipped with frozen tests, and ripples to fourteen throw sites. Degrades to `never` when the code is a variable of type `ErrorCode`, which subclass constructors produce. Does not cover a value cast to `unknown` upstream | Better in principle, more expensive now, and it still leaves the boundary unchecked. Worth revisiting the day a second code gains a `details` shape |
| Validate `details` inside `DomainError.toEnvelope()` | Close to the throw site. Covers branch 1, which is the branch that carries caller-supplied `details` | A subclass may override `toEnvelope()`, and branches 2 to 4 do not go through it, so the check has holes exactly where a future TASK adds code | The filter is the one place every body passes through, and that is the property worth having |
| Widen `errorEnvelopeContract.details` to a discriminated union in `packages/contracts` | The wire contract itself would state the rule, and `apps/web` would get the narrow type | The union has one member today, so it buys typing that only one code uses, and it puts a per-code table in the shared barrel that every future code edits. That is the contended-file shape ADR-0024 rejected for the error registry | Cost now for a benefit that arrives if a second code ever names a shape |

## Consequences

### Positive

- Every value in an error body was either written in `apps/api`'s own source or validated
  against a schema in `packages/contracts`. That is a property a reader can check by
  reading the filter, not by auditing fourteen throw sites.
- The `hostname_already_claimed` and `last_owner_protected` leak paths are closed before
  TASK-018 and TASK-040 are dispatched, which is the cheapest moment.
- The 400 arm and the 404 arm now answer the same way, so the next reader does not have
  to work out why they differed.
- The drop is observable. A TASK that attaches `details` to a 409 sees a log line rather
  than nothing.

### Negative / accepted cost

- **A malformed request body gets no diagnostic.** The most common integration error in
  the API answers `The request could not be parsed.` and nothing else. Finding out which
  byte was wrong means finding the log line, and whether that line is readable depends on
  F-090's ruling. This is a real developer-experience cost on the path most likely to be
  hit by someone integrating for the first time.
- **The drop is silent to the client.** A TASK that attaches useful `details` to a 409
  ships a body without it, and the only signal is a log line nobody reads during
  development. A test asserting the body catches it; nothing else does.
- **`message` is still unvalidated.** A throw site that pastes another tenant's data into
  a `DomainError` message still ships it. The `details` check makes the more likely
  mistake, attaching a structured row, impossible, and leaves the less likely one open.
  Anyone reading this ADR as "the filter now prevents leaks" is reading it wrong.
- **A `__proto__` field key disappears from validation output.** zod's record parse drops
  `__proto__` from its output (verified against 4.4.3), so a field literally named
  `__proto__` loses its errors on the way through `narrowEnvelope`, even though
  `toValidationDetails` takes care to keep it as an own key. No contract declares such a
  field, and the alternative is forwarding the unparsed input.
- **One more thing to keep in step.** Adding a code with a `details` shape now means
  editing `error-envelope.md`, the contract's schema, and `narrowEnvelope`. Forgetting the
  third means the shape is dropped at runtime while every type checks.

### Follow-ups this creates

- TASK-007's implementer, in this fix round: `FRAMEWORK_BAD_REQUEST_FORM_MESSAGE` on the
  400 arm, `narrowEnvelope` in `error-envelope.ts`, and the filter applying it once
  before writing.
- `apps/api/src/common/errors/exception-filter.spec.ts` asserts the framework-400 arm's
  `_form` value, and it asserts the old pass-through. That test has to change with this
  decision. It belongs to `sdlc-test-architect`, not to the implementer.
- Whichever TASK first wants `details` on a code other than `validation_failed` amends
  this contract before it writes the throw site. Attaching it and hoping is now a
  guaranteed drop rather than a maybe.
