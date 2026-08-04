---
id: ADR-0007
slug: launch-core
title: Seven random characters from a 57-symbol alphabet, collision resolved by unique-violation retry
status: accepted
supersedes: null
date: 2026-08-04
---

## Context

GC-6 scopes uniqueness to `(domain_id, slug)`, never globally. AC-39 requires two
workspaces on two domains to both own `summer`. AC-40 requires a documented allowed
character set and length bound so a rejection has a definition to test against.

Two properties matter beyond uniqueness. A code must not be enumerable, or anyone can
walk the space and read every agency's destinations, including campaign URLs that are
not yet public. And a code must not leak volume: sequential or counter-derived codes
tell a competitor how many links an agency created this week, which is exactly the
kind of thing an agency's client would rather not publish.

Codes are printed on collateral, read aloud, and typed from a phone screen. Characters
that look alike cost real support time.

## Decision

**Alphabet, 57 symbols.**

```
23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz
```

Removed: `0`, `1`, `I`, `O`, `l`. Each confusable group keeps one member, so `o`, `i`
and `L` survive and stay distinguishable from each other. Case-sensitive, matching the
unique index.

**Length 7.** 57^7 is about 1.95e12 codes per domain.

**Uniform random, from `crypto.randomInt`.** No counter, no hash of the destination,
no timestamp component. Given a domain holding one million links, the chance that a
guessed code hits one is about 1 in 1.95 million, and a scanner pays a Redis lookup
per guess against the negative cache (ADR-0008) rather than a Postgres query.

**Collision is resolved by the database, not by a pre-check.** `generateSlug` produces
a candidate; the insert runs; a `23505` on `links_domain_id_slug_unique` triggers a
fresh candidate. Five attempts, then throw `slug_generation_exhausted` (500). A
`SELECT` before the `INSERT` would be a race, and at these densities the expected
number of retries is effectively zero.

**Randomness is injectable.** `SlugGenerator` takes a `RandomSource` interface with
one method, `bytes(n: Uint8Array): void`. Production binds `crypto.randomFillSync`;
tests bind a scripted source, which is how collision handling gets a deterministic
test.

**Custom slugs use a wider set than generated ones.**

```
/^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,62}[A-Za-z0-9])?$/
```

1 to 64 characters, no leading or trailing `-` or `_`, no consecutive-separator rule.
Operators pick words like `spring-sale-2026`, so the generated alphabet's confusable
exclusions do not apply here. Reserved words are rejected case-insensitively against
the ADR-0006 list.

`validateSlug` returns a discriminated result naming the violation, so TASK-025 can
map it to a 400 whose `details.fieldErrors.slug` says which rule failed.

## Alternatives considered

| Option | Pros | Cons | Why not |
|---|---|---|---|
| Base62 encoding of a per-domain sequence | Shortest possible codes; zero collisions by construction; no retry path | Enumerable by definition, and the code's numeric value is the link count. Both properties this decision exists to prevent | Fails the two requirements that are not "unique" |
| Hashids or a Feistel permutation over a sequence | Non-obvious codes; still zero collisions; reversible to the id | Not a security boundary. The permutation is keyed but the space is dense, so a scan of short codes hits real links at a high rate. Volume also leaks, because the space fills in order | Looks random without being sparse, which is the property that actually matters |
| `nanoid` at its default length of 21 | Well-tested; effectively zero collision risk | 21 characters makes the short URL longer than most destinations, which defeats the product. Its default alphabet includes `-` and `_`, which are fine in a URL and bad when read aloud | Wrong shape for a shortener |
| Six characters instead of seven | Shorter; 57^6 is still 34 billion per domain | Guess probability per attempt rises by 57x for the same link count. Seven characters is one keystroke more and buys two orders of magnitude | The keystroke is cheaper than the scan resistance |
| UUID or ULID | No decision to make | Far too long, and ULID sorts by time, which leaks creation order | Unusable as a short code |

## Consequences

### Positive

- A scanner has no better strategy than random guessing against a 1.95e12 space per
  domain, and each guess costs them a request that the negative cache absorbs.
- Nothing about the code reveals when a link was made or how many exist.
- Collision handling has one code path, exercised deterministically in tests through
  the injectable random source rather than by hoping a collision occurs.

### Negative / accepted cost

- A `23505` retry means the create path can issue up to five inserts. Under
  `onLinkMutated` (ADR-0010's sibling hook) the retry happens inside the same
  transaction, so a failed attempt aborts it and the retry needs a savepoint. TASK-025
  has to use `SAVEPOINT`, which is easy to get wrong and produces a confusing
  "current transaction is aborted" error when missed.
- Excluding five characters costs about 8% of the space per position and means a
  human transcribing a code cannot rely on the full alphabet being valid, so
  `validateSlug` rejects some codes that look plausible.
- Case sensitivity means `AbC1234` and `abc1234` are different links. Someone typing a
  code from a printed page in the wrong case gets a 404, and there is no
  did-you-mean.
- Sixteen reserved words are permanently unavailable to operators, with no way to
  grant an exception.

### Follow-ups this creates

- TASK-023 declares `links_domain_id_slug_unique` on `(domain_id, slug)`.
- TASK-024 owns `SlugGenerator`, `RandomSource`, `validateSlug`, and
  `docs/architecture/short-codes.md`.
- TASK-025 wraps the insert in a savepoint so the retry does not abort the outer
  transaction, and maps `validateSlug` violations onto `details.fieldErrors.slug`.
- The alphabet, length and reserved list live in `packages/contracts/src/slug.ts`.
  `apps/web` uses them to validate a custom slug before submitting (TASK-026).
