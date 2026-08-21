# Contract: short-code alphabet, validation, and reserved slugs

- **Boundary:** slug generation, slug validation on the API, and client-side pre-validation in the web app.
- **Normative form:** `packages/contracts/src/slug.ts`. **`validateSlug` and `isReservedSlug` are implemented there as of 2026-08-19 (TASK-2-01); neither throws any more.** The design stub was retired 2026-08-11 under ADR-0039, TASK-007 having closed. **The GENERATOR's normative form is `apps/api/src/links/codes/slug-generator.ts` (TASK-2-05, 2026-08-19): `RandomSource`, the `RANDOM_SOURCE` injection token, `cryptoRandomSource`, `SlugGenerator`, and `symbolForByte`, which is exported so the uniformity of the mapping is measured over all 256 byte values rather than inferred from samples.** It lives in `apps/api` rather than in `packages/contracts` because it needs `node:crypto`, which ADR-0005 forbids that package (`apps/web` imports its source with no build step).
- **Produced by:** TASK-2-01 (`validateSlug`, `isReservedSlug`), TASK-2-05 (the generator); the constants ship in `packages/contracts` from TASK-007.
- **Consumed by:** TASK-2-02 (unique index), TASK-2-05 (400/409 mapping), TASK-2-13 (inline validation in the web app).
- **Card ids:** item 2's plan renumbered the foundation's TASK-0xx cards. The originals appear below in quoted history; the live owners are TASK-2-01 (this file's functions), TASK-2-02 (schema), TASK-2-05 (generator and routes) and TASK-2-13 (web).
- **ADRs:** ADR-0007, ADR-0006.

## Normative constants

```ts
/** 57 symbols. 0, 1, I, O and l are removed; one member of each confusable group is kept. */
export const SLUG_ALPHABET =
  '23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export const GENERATED_SLUG_LENGTH = 7;          // 57^7 ≈ 1.95e12 per domain
export const SLUG_MIN_LENGTH = 1;
export const SLUG_MAX_LENGTH = 64;
export const SLUG_GENERATION_MAX_ATTEMPTS = 5;

/** Custom slugs. Wider than the generated alphabet: operators type words. */
export const SLUG_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,62}[A-Za-z0-9])?$/;

/** Compared case-insensitively. First six are structural; the rest are brand protection. */
export const RESERVED_SLUGS = [
  'api', 'health', 'robots.txt', 'favicon.ico', '.well-known', '_static',
  'admin', 'login', 'signup', 'verify', 'invite',
  'settings', 'support', 'status', 'terms', 'privacy',
] as const;
```

Slugs are **case-sensitive** for storage and lookup, matching the unique index.
`RESERVED_SLUGS` matching is case-insensitive, so `Admin` is rejected too.

## Validation result

```ts
export type SlugViolation =
  | 'too_short' | 'too_long' | 'invalid_characters' | 'leading_or_trailing_separator' | 'reserved';

export type SlugValidation =
  | { ok: true; slug: string }
  | { ok: false; violation: SlugViolation };

export function validateSlug(input: string): SlugValidation;
export function isReservedSlug(input: string): boolean;
```

Violation order is fixed so the reported message is deterministic: `too_short`,
`too_long`, `invalid_characters`, `leading_or_trailing_separator`, `reserved`.

`validateSlug` returns the input **verbatim** on the accepting branch (no trim, no
lower-casing, no normalisation) because the unique index is case-sensitive and a
normalising validator would store a value the operator did not type. Four `RESERVED_SLUGS`
entries never report `reserved`: `robots.txt`, `favicon.ico` and `.well-known` are
`invalid_characters` and `_static` is `leading_or_trailing_separator`, each refused a rung
earlier by the fixed order. All sixteen are refused.

## Generation

```ts
export interface RandomSource { bytes(out: Uint8Array): void; }

export interface SlugGenerator {
  /** Returns a candidate. Uniqueness is settled by the unique index, not by a pre-check. */
  next(): string;
}
```

Production binds `crypto.randomFillSync`. Tests bind a scripted source, which is how
collision handling gets a deterministic test.

Rejection sampling: 256 is not a multiple of 57, so a byte at or above 228 is discarded
and redrawn. Using modulo without it biases the first 28 symbols.

> **Shipped 2026-08-19 (TASK-2-05).** `RandomSource` is a Nest provider under the token
> `RANDOM_SOURCE`, bound to `cryptoRandomSource` in `links.module.ts`; the integration suite
> overrides that one token and nothing else, so `AC-2-10`'s collisions are real INSERTs
> meeting the real unique index rather than a stubbed error.
>
> **The reserved redraw is NOT charged to `SLUG_GENERATION_MAX_ATTEMPTS`.** That budget
> bounds DATABASE round trips (a `23505` costs a statement and a savepoint rollback), and
> spending one of the five on a purely local condition would make 500
> `slug_generation_exhausted` reachable with no collision anywhere. `next()` therefore loops
> on `isReservedSlug` under its own bound (`RESERVED_REDRAW_LIMIT`, 8), which exists only so
> a malfunctioning source (a scripted one, a stub returning a constant) throws loudly
> instead of hanging a request. `validateSlug(generator.next())` is `{ ok: true }`
> unconditionally as a result, which is what invariant 1 claims.

## Uniqueness and collision

```sql
CONSTRAINT links_domain_id_slug_unique UNIQUE (domain_id, slug)
```

Scoped `(domain_id, slug)`, **never global** (GC-6, AC-39).

On insert, `23505` on that constraint means:

- **generated slug:** draw again, up to `SLUG_GENERATION_MAX_ATTEMPTS`, then 500
  `slug_generation_exhausted`.
- **user-supplied slug:** 409 `slug_taken` (AC-38).

**The retry runs inside a savepoint.** A unique violation aborts the enclosing
transaction, so TASK-2-05 wraps each insert attempt in `SAVEPOINT slug_try` and
`ROLLBACK TO SAVEPOINT slug_try` before redrawing. Omitting this produces
`current transaction is aborted` on the second attempt.

**Reading `23505` here needs `postgresErrorCode`.** Added 2026-08-05 (F-120). This catch
sits inside the `fn` of a `withTenantTransaction`, so the caught value is drizzle's
per-statement `DrizzleQueryError` wrapper and **`error.code` is `undefined`**. Reading it
directly makes the loop miss every collision: a generated slug surfaces as a 500 instead
of redrawing, and a supplied slug surfaces as a 500 instead of AC-38's 409. Read both
facts through the accessors `apps/api/src/db/client.ts` exports:

```ts
if (
  postgresErrorCode(error) === '23505' &&
  postgresErrorConstraint(error) === 'links_domain_id_slug_unique'
) {
  // rollback to savepoint; redraw or 409 per the branches above
}
throw error;   // anything else, unchanged
```

**Never read `.message` off the caught error**, here least of all: the wrapper's message
is `Failed query: <the INSERT>\nparams: <every bound parameter>`, which on this statement
is the destination URL, the slug and the tenant id. See `tenant-context.md`, "Driver
errors inside `fn`", for the full rule and for the fields that stay unreadable even after
unwrapping.

## Error mapping

| Condition | Status | Code | Body |
|---|---|---|---|
| any `SlugViolation` | 400 | `validation_failed` | `details.fieldErrors.slug = ['<violation>']` (AC-40) |
| unique violation on a supplied slug | 409 | `slug_taken` | (AC-38) |
| attempts exhausted | 500 | `slug_generation_exhausted` | |

## Invariants a caller may rely on

1. `validateSlug(generateSlug())` is always `{ ok: true }`. The generated alphabet is a
   strict subset of `SLUG_PATTERN`'s and no generated slug can be reserved: every
   reserved slug contains a character outside `SLUG_ALPHABET` or a length other than 7.

   **Corrected 2026-08-19 (TASK-2-01). The second clause is false for two entries.**
   `support` and `privacy` are each exactly `GENERATED_SLUG_LENGTH` characters and drawn
   entirely from `SLUG_ALPHABET`, so a draw can produce either, at 2/57^7, roughly one in
   a trillion. The reasoning offered above ("every reserved slug contains a character
   outside `SLUG_ALPHABET` or a length other than 7") held for the other fourteen and was
   never checked against these two. The invariant is restored by the GENERATOR, not by the
   alphabet: **TASK-2-05 redraws while `isReservedSlug(candidate)` is true**, on the
   attempt loop it already runs for `23505`, and `slug.spec.ts` pins the drawable set to
   exactly `['support', 'privacy']` so a future reserved entry cannot grow it unnoticed.
   Without that redraw, one draw in a trillion puts a live link on a brand-protected slug
   that `validateSlug` then rejects.
2. Two links on two different domains may hold the same slug (AC-39, SC-5).
3. Nothing about a generated slug reveals creation time, creation order, or how many
   links a domain holds.
4. A reserved slug can never shadow an application route. The structural entries match
   the surfaces in ADR-0006.

## What the implementer must guarantee

- The constants are imported from `@shortkit/contracts`, root specifier only (F-045).
  TASK-2-05 and TASK-2-13 do not redeclare the alphabet or the reserved list.
- `docs/architecture/short-codes.md` states the alphabet, length, exclusions and
  reserved list, which is what AC-2-13 tests against. **Written 2026-08-19 (TASK-2-01).**
- Rejection sampling is implemented. Plain `byte % 57` is a defect. **Done 2026-08-19
  (TASK-2-05); `slug-generator.spec.ts` walks all 256 bytes and asserts the 228 accepted
  ones map four apiece onto the 57 symbols, with the other 28 redrawn.**
- The generator calls `isReservedSlug` on each candidate and redraws when it is true.
  see the correction under invariant 1. **Done 2026-08-19 (TASK-2-05); a scripted source
  that draws `support` and then `privacy` proves both are discarded.**

## Versioning

Removing a symbol from `SLUG_ALPHABET` is safe; existing slugs stay valid because
`validateSlug` uses `SLUG_PATTERN`, not the alphabet. **Adding a reserved slug is
breaking**: an operator may already own it. Any addition needs a migration listing
conflicting links and a decision about them.
