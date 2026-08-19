---
id: ADR-0025
slug: foundation
title: The contracts package recognises and flattens its own ZodErrors
status: accepted
supersedes: null
date: 2026-08-05
---

## Context

`error-envelope.md` requires the filter to turn a `ZodError` into 400
`validation_failed` with `details.fieldErrors`. The filter lives in `apps/api`, and
`apps/api` declares no `zod` dependency: `require.resolve('zod')` from there fails
(verified, F-071). zod arrives only inlined through `@shortkit/contracts` at bundle
time, which gives the bundle the code and gives the source no importable name.

Juano ruled F-075 while this was being written: the consuming TASK owns its own workspace
manifest, so a TASK needing a dependency gains `apps/api/package.json` in its paths and
adds it in the same commit as the code. TASK-007 could therefore take the manifest and
depend on zod directly. The question is no longer who is allowed to add it. It is where
the code that reads a `ZodError` belongs.

The test architect proposed exporting the check from `packages/contracts/src/errors.ts`,
which is in TASK-007's paths and already owns the error vocabulary. It adds surface to
an isomorphic package that Next.js bundles into client components, and ADR-0005's
`sideEffects: false` means anything added there stays declaration-only.

One claim in that proposal needs correcting. zod 4's classes carry a trait check behind
`Symbol.hasInstance` rather than a prototype chain, so `instanceof z.ZodError` returns
true for an error produced by a different copy of zod 4. I read `core.js` in the
installed 4.4.3 to confirm it, and ran a `safeParse` error through both `instanceof
z.ZodError` and `instanceof Error`: both true, and the object `parse` throws is
`ZodRealError`, which does extend `Error`. Instance identity is therefore not the
argument for putting the check in contracts. The argument is ownership and resolvability.

## Decision

**`packages/contracts/src/errors.ts` exports `isZodError`, `toValidationDetails` and
`FORM_ERROR_KEY`.** The API filter imports those three from `@shortkit/contracts` and
imports zod nowhere.

```ts
export function isZodError(value: unknown): value is z.ZodError;
export function toValidationDetails(error: z.ZodError): ValidationDetails;
export const FORM_ERROR_KEY = '_form';
```

Every zod schema in the system is declared in this package (ADR-0005), so the package
that produces a `ZodError` is the one that reads it, and `ValidationDetails` is defined
eight lines above the function that builds one.

**`toValidationDetails` keys by the first path segment**, so `body.name` and
`body.name.first` both land under `name`, matching zod's own `flattenError` and the flat
map a form renders.

**An issue with an empty path lands under `_form`.** zod's `flattenError` puts root
issues in a separate `formErrors` array, and `ValidationDetails` has nowhere to put it,
so taking `fieldErrors` alone silently drops them. I confirmed the drop against 4.4.3: a
schema-level `.refine()` failure flattens to `{formErrors: ['a must match b'],
fieldErrors: {}}`. A form that renders `fieldErrors` and nothing else would show an empty
error list beside a submit button that keeps refusing. **No request contract may declare
a field named `_form`.**

**The accumulator is a `Map`, drained through `Object.fromEntries`. Added 2026-08-05
(F-086, F-087).** The first version of `toValidationDetails` accumulated into a `{}`
literal and read `fieldErrors[key] ?? []`. That reads through `Object.prototype`, so an
issue whose first path segment is `constructor`, `toString`, `valueOf` or
`hasOwnProperty` gets the inherited member instead of `undefined` and the next line
throws `TypeError: messages.push is not a function`. I reproduced it against the
installed zod 4.4.3: `z.record(z.string(), z.string()).safeParse(JSON.parse('{"constructor":
2}'))` yields an issue with `path: ["constructor"]`. The throw escapes the exception
filter, re-enters it as a TypeError, and the caller gets 500 with no field errors on the
path every consuming TASK inherits.

`issue.path[0]` is caller-controlled wherever a request schema puts a user key in the
first segment: a top-level `z.record`, a `catchall`, or a `superRefine` that sets its own
path. No schema in launch-core does that today, which is what made the defect ship.

A `Map` removes the prototype from the problem rather than guarding against it, so no
later edit has to remember `Object.hasOwn`. `Object.fromEntries` returns an ordinary
object, so `validationDetailsContract` accepts it and downstream readers get the
prototype they expect, while a `__proto__` key still lands as an own, JSON-visible
property because `Object.fromEntries` uses CreateDataProperty and ignores the setter
(verified on Node 24.19). A null-prototype accumulator fixes the crash equally well and
loses on that second point.

**The same shape is required of any reducer keyed by caller-supplied strings.** The
rule is not about `details`. It is about building an object whose keys come from a
request.

**`toValidationDetails` caps its output. Added 2026-08-05 (F-095).** At most
`MAX_VALIDATION_ISSUES` (100) issues are read and at most `MAX_MESSAGES_PER_FIELD` (10)
messages land under one key. If anything was dropped,
`VALIDATION_TRUNCATED_MESSAGE` is appended under `FORM_ERROR_KEY`. Without a cap, zod's
one-issue-per-element behaviour turns a 100 KB array body into a multi-megabyte response
assembled inside the filter, unauthenticated, at roughly 30x amplification.

**The filter calls these three and imports zod nowhere**, value or type. TASK-007 needs
no entry in `apps/api/package.json` for the `validation_failed` path, so it does not
take the manifest under F-075's rule.

The scope of that is narrow on purpose. Recognising and flattening a `ZodError` lives
here, permanently. Whether `apps/api` ever declares zod for some other reason, a
validation pipe naming a schema type first among them, is a separate question that this
ADR does not close. Answering it either way leaves the filter calling these three
functions, because the shape they produce is defined eight lines above them.

## Alternatives considered

| Option | Pros | Cons | Why not |
|---|---|---|---|
| Add `zod` to `apps/api/package.json` and `instanceof ZodError` in the filter | Reads like every other Nest codebase. No new contracts surface. Available since the F-075 ruling | Puts the code that builds a `ValidationDetails` in a different package from the schema that defines one, so the `_form` rule and the first-segment rule live away from the contract stating them, and a change to the shape is a two-package edit. Adds a second exact pin of zod that has to be kept equal to the contracts pin by hand (ADR-0018), and a second copy in the graph when they drift | The mechanics work. The shape ends up defined in one package and constructed in another, which is the split that lets them disagree |
| Duck-type in the filter: `e.name === 'ZodError' && Array.isArray(e.issues)` | Needs nothing from anybody. Works this afternoon | Fails silently when zod changes internals, and the symptom is every malformed request body answering 500 instead of 400 with the field errors gone. `name` is a string any error can carry. It also hand-rolls the flatten, so `_form` and the first-segment rule get reinvented per reader | The failure is silent and lands on the most-hit validation path in the API |
| A shared `packages/errors` workspace owning both `DomainError` and the zod helpers | One home for error handling. `apps/api` gets a manifest entry it can own | A third package for two functions, plus a manifest, tsconfig, exports map and two `paths` entries in both apps. `DomainError` would then be importable from `apps/web`, which is the coupling ADR-0005 keeps out | Package overhead for two functions, and it drags a server error class toward the browser |
| Make the pipe convert, so the filter never sees a `ZodError` | The filter stays small. Conversion happens where the schema is known | No TASK owns a validation pipe today, and a `ZodError` reaches the filter from anywhere a handler parses a schema by hand. The filter still needs the branch | Narrows the source without removing the case |

## Consequences

### Positive

- TASK-007 ships the whole `validation_failed` path inside the paths it already has, and
  needs no manifest entry under F-075's rule.
- The function that builds a `ValidationDetails` sits beside the schema that defines
  one. Changing the shape changes both in one edit.
- One exact pin of zod in the workspace. A second pin in `apps/api` would have to be
  kept equal to it by hand, and ADR-0018's exact pinning makes the drift silent.
- Root-level refinement failures reach the user under `_form` instead of vanishing.

### Negative / accepted cost

- `packages/contracts` now carries two functions only the API calls, and both ship in
  the browser bundle unless the bundler drops them. `sideEffects: false` is what makes
  them droppable, and ADR-0005 already records that nothing checks the assertion.
- `_form` is a reserved field name enforced by review. A contract declaring a `_form`
  field would collide, and the collision reads as a mis-rendered form rather than an
  error.
- Recognition and flattening move to contracts, and nothing else does. The next thing
  wanting a zod type inside `apps/api`, a validation pipe first among them, meets this
  boundary again and gets no answer from here.
- `toValidationDetails` collapses nested paths to their first segment, so a field error
  on `branding.logoUrl` renders against `branding`. Every request body in launch-core is
  one level deep, and the day one is not, the shape of `ValidationDetails` changes.
- The `Map` costs a second allocation and one more line than the object literal, and it
  reads as defensive to anyone who has not met the crash. The comment above the function
  is what keeps it from being simplified back.
- The caps mean a request with more than 100 issues gets an incomplete answer. A form
  showing ten errors on one field and a truncation notice is worse than showing all of
  them, and it is the price of not letting a 100 KB body dictate the response size.
- Neither the crash nor the caps are visible to a reader of the wire shape.
  `validationDetailsContract` is unchanged, so nothing in the contract's types tells a
  second implementer that the accumulator has a required shape. `design/stubs/` and this
  ADR are the only carriers.

### Follow-ups this creates

- TASK-007 materialises the three exports and the filter branch that calls them.
- Nobody owns the `ZodValidationPipe` ADR-0005 names, and it is the producer of most
  `validation_failed` responses. Whoever gets it needs a way to name a zod schema type
  inside `apps/api`: either take `apps/api/package.json` under F-075's rule and depend on
  zod, or export a `ContractSchema<T>` alias from here. Both stay open. Picking one before
  the pipe has a signature would be guessing at it.
- `web-api-client.md` types `ApiError.details` as `unknown` and passes it through, so
  TASK-008 needs no change. Whichever TASK first renders field-level validation errors
  parses `details` with `validationDetailsContract` and puts the `_form` key somewhere
  other than beside a field.
