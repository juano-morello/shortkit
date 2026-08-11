# Contract: short-code alphabet, validation, and reserved slugs

- **Boundary:** slug generation, slug validation on the API, and client-side pre-validation in the web app.
- **Normative form:** `packages/contracts/src/slug.ts`. The file exists; `validateSlug` is declared there and throws `not implemented` until TASK-024 fills it. The design stub was retired 2026-08-11 under ADR-0039, TASK-007 having closed.
- **Produced by:** TASK-024 (generator); the constants ship in `packages/contracts` from TASK-007.
- **Consumed by:** TASK-023 (unique index), TASK-025 (400/409 mapping), TASK-026 (inline validation).
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

export declare function validateSlug(input: string): SlugValidation;
```

Violation order is fixed so the reported message is deterministic: `too_short`,
`too_long`, `invalid_characters`, `leading_or_trailing_separator`, `reserved`.

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
transaction, so TASK-025 wraps each insert attempt in `SAVEPOINT slug_try` and
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
2. Two links on two different domains may hold the same slug (AC-39, SC-5).
3. Nothing about a generated slug reveals creation time, creation order, or how many
   links a domain holds.
4. A reserved slug can never shadow an application route. The structural entries match
   the surfaces in ADR-0006.

## What the implementer must guarantee

- The constants are imported from `@shortkit/contracts`. TASK-024 and TASK-026 do not
  redeclare the alphabet or the reserved list.
- `docs/architecture/short-codes.md` states the alphabet, length, exclusions and
  reserved list, which is what AC-40 tests against.
- Rejection sampling is implemented. Plain `byte % 57` is a defect.

## Versioning

Removing a symbol from `SLUG_ALPHABET` is safe; existing slugs stay valid because
`validateSlug` uses `SLUG_PATTERN`, not the alphabet. **Adding a reserved slug is
breaking**: an operator may already own it. Any addition needs a migration listing
conflicting links and a decision about them.
