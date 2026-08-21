# Short codes

A short code (a slug) is the path segment a visitor types: the `x7Kq2mB` in
`http://localhost:3001/x7Kq2mB`. Two kinds exist and they share one validator. Generated
slugs are seven random characters. Custom slugs are whatever an operator types, within
the rules below. Both are stored case-sensitively and looked up on `(domain_id, slug)`.

`packages/contracts/src/slug.ts` is the one source. Every constant on this page is
declared there and imported by the API, the web app and the generator; nothing
redeclares an alphabet, a length or a reserved entry. This document is the working
version of `docs/contracts/slug.md` (normative) and ADR-0007 (why the alphabet is what
it is).

## The generated alphabet

```
23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz
```

57 symbols, seven characters long, which is 57^7 ≈ 1.95 × 10^12 codes per domain.

**Five characters are excluded: `0`, `1`, `I`, `O` and `l`.** They form two groups that
are hard to tell apart in most typefaces (`0`/`O`/`o` and `1`/`I`/`l`/`i`), and one
member of each group survives: lowercase `o` and lowercase `i`. So nobody reading a code
off a business card, a poster or a phone screen has to decide which character they are
looking at.

Separators (`-`, `_`) and dots are not in the generated alphabet either. A generated slug
is alphanumeric throughout.

**Rejection sampling is mandatory.** 256 is not a multiple of 57, so a random byte at or
above 228 is discarded and redrawn. Plain `byte % 57` biases the first 28 symbols by
about 1.8% each and is a defect, not a shortcut. Generation retries a collision up to
`SLUG_GENERATION_MAX_ATTEMPTS` (5) times inside a savepoint, then answers 500
`slug_generation_exhausted`.

## The custom slug rules

Deliberately wider than the generated alphabet, because operators type words:

| Rule | Value |
| --- | --- |
| Length | 1 to 64 characters |
| Characters | `A-Z`, `a-z`, `0-9`, `-`, `_` |
| First and last character | must be alphanumeric: no leading or trailing separator |
| Reserved | the 16 entries below, compared case-insensitively |

Expressed as one regex, `SLUG_PATTERN`:

```
/^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,62}[A-Za-z0-9])?$/
```

`validateSlug` reports the same rules as five ordered violations rather than one pass/fail,
because the violation is what reaches a form:

1. `too_short`
2. `too_long`
3. `invalid_characters`
4. `leading_or_trailing_separator`
5. `reserved`

**The order is fixed.** An input breaking several rules reports the first one on that
list, so `robots.txt` is `invalid_characters` (the dot is checked before the reserved
list) and a 65-character string of dots is `too_long`. Any violation maps to 400
`validation_failed` with `details.fieldErrors.slug = ['<violation>']`. The web runs the
same function before submit, so an operator sees the same message without a round trip.

**Slugs are case-sensitive.** `Spring-Sale` and `spring-sale` are two different links on
one domain. `validateSlug` returns the input verbatim (no trim, no lower-casing) because
the unique index is case-sensitive and a normalising validator would store something the
operator did not type.

## The reserved list

Sixteen entries, compared case-insensitively, so `Admin` and `ADMIN` are refused too.

| Entries | Why |
| --- | --- |
| `api`, `health`, `robots.txt`, `favicon.ico`, `.well-known`, `_static` | **Structural.** Each would shadow a real path or a platform convention. They match the surfaces ADR-0006 partitions. |
| `admin`, `login`, `signup`, `verify`, `invite`, `settings`, `support`, `status`, `terms`, `privacy` | **Brand protection.** A link on the platform's own hostname reading `/login` or `/support` is a phishing primitive, whoever created it. |

Four of the structural entries are refused before the reserved check ever runs:
`robots.txt`, `favicon.ico` and `.well-known` carry characters outside the allowed set,
and `_static` leads with a separator. They stay on the list anyway: the list is the
statement of intent, and a future widening of the character rules must not silently
un-reserve them.

**Adding an entry is a breaking change.** An operator may already own that slug. Any
addition needs a migration that lists the conflicting links and a decision about them.

## The generator must also skip reserved slugs

`docs/contracts/slug.md` invariant 1 claims that "no generated slug can be reserved"
because every reserved entry either contains a character outside the generated alphabet
or has a length other than seven. **That is false for two entries.** `support` and
`privacy` are each exactly seven characters and drawn entirely from the generated
alphabet, so a draw can produce one of them, at 2/57^7, roughly one in a trillion.

The consequence is small and real: such a draw would put a live link on a brand-protected
slug, and `validateSlug` on that same slug answers
`{ ok: false, violation: 'reserved' }`, contradicting the invariant callers are told to
rely on. **The generator therefore redraws while `isReservedSlug(candidate)` is true**, on
the attempt loop it already runs for `23505`. `packages/contracts/src/slug.spec.ts` pins
the drawable set to exactly `['support', 'privacy']`, so a future reserved entry cannot
grow it unnoticed.

## Uniqueness

```sql
CONSTRAINT links_domain_id_slug_unique UNIQUE (domain_id, slug)
```

Scoped to the domain, **never global**. Two tenants may hold the same slug on two
different domains, and that is the design, not a gap. On `23505` against that constraint:
a generated slug redraws, a supplied slug answers 409 `slug_taken` with a fixed message
and no `details`, one bit of information, which is what the operator needs to pick
another slug and all an attacker learns.

The retry runs inside a savepoint. A unique violation aborts the enclosing transaction, so
each insert attempt is wrapped in `SAVEPOINT slug_try` with a `ROLLBACK TO SAVEPOINT`
before the redraw; omitting it produces `current transaction is aborted` on the second
attempt. The `23505` is read through `postgresErrorCode`/`postgresErrorConstraint` from
`apps/api/src/db/client.ts`, never off `error.code` and never off `error.message`: inside
a `withTenantTransaction` the caught value is Drizzle's wrapper, `.code` is `undefined`,
and `.message` carries every bound parameter including the destination URL.

## What a generated slug does not reveal

Nothing about creation time, creation order, or how many links a domain holds. Seven
uniform draws from 57 symbols carry no structure to read.
