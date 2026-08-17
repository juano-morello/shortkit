---
id: ADR-0058
slug: identity-membership
title: The secret assertion needs no database, so it takes none of precondition 2's machinery, and three rejections is the final count
status: accepted
supersedes: null
amends: null
date: 2026-08-14
---

## Context

ADR-0051 decided that `BETTER_AUTH_SECRET` is a declared binding asserted at boot without
consulting `NODE_ENV`, and F-033 moved `assertBetterAuthSecretConfigured()` and the new
`apps/api/src/auth/boot-assertions.ts` into TASK-003, wave 2. It did not decide how the
assertion fits `main.ts`'s existing boot structure, and there is exactly one precedent to
fit.

`main.ts` runs `assertBootPreconditions()` before `NestFactory.create`. It calls
`readBuildCommitSha()` (a regex over a string, no I/O), then `assertRuntimeRoleIsSafe()`,
which wraps `assertRuntimeRoleCannotBypassRls` in a retry loop bounded by
`DATABASE_REACHABLE_BUDGET_MS = 20_000` with doubling backoff. It carries three pieces of
machinery, and each exists for a stated reason:

- **`RLS_VERDICT_PREFIX = 'DATABASE_URL connect'`** (`main.ts:48`) separates a verdict the
  check reached on its own from a driver error. F-245's rule: "could not answer" is not
  "answered unsafely", and the two call for opposite responses.
- **The retry budget** exists because GC-3 pins Neon's free tier, whose compute scales to
  zero, and a cold wake used to exit the process.
- **`BootPrecondition`** (`main.ts:50`) is a union carried onto the log line as
  `boot_precondition`, so the two refusals are distinguishable by machine.

The secret assertion reads `process.env`. It has no I/O, cannot be slow, and always answers.

Two further constraints, and the second is the one that decides the file's shape.

**The rejection count.** ADR-0051 has been ruled on four times for this one variable. F-074
added this repository's compose default as a second by-value rejection; F-144 struck it,
conditional on TASK-019 deleting the literal from `docker-compose.yml` before TASK-003
starts. I checked the tree rather than the ADR. `docker-compose.yml:295` is
`'${BETTER_AUTH_SECRET:?generate at least 32 characters and export it, ...}'`, a required
reference with no fallback, and `development-compose-better-auth-secret-not-a-real-value`
does not occur anywhere outside `.sdlc/**`. TASK-019 landed. The condition is false.

**The module graph.** `boot-assertions.ts` is imported by `main.ts`. `auth.config.ts`
evaluates `betterAuth({ secret: betterAuthSecret(), ... })` at module scope. ES modules
evaluate before any statement in the importer runs, so if `boot-assertions.ts` imported
`auth.config.ts`, `main.ts`'s import would construct the auth instance before `bootstrap()`
is called, `betterAuthSecret()` would throw during module evaluation, and the assertion would
never run. The same happens in wave 3 from the other direction: TASK-004 adds
`toNodeHandler(auth)` to `main.ts`, so `main.ts` imports `auth.config.ts` directly and its
module-scope throw beats `assertBootPreconditions()` regardless of statement order. ADR-0051
did not name a home for `betterAuthSecret()` and TASK-003's `Produces` block does not list it.

## Decision

**`assertBetterAuthSecretConfigured` is a boot precondition with a `BootPrecondition` member
and no retry, no backoff and no verdict prefix. `betterAuthSecret()` lives in the same file,
shares one predicate and one error class with it, and `boot-assertions.ts` imports nothing
from `auth.config.ts`.**

### The three rejections, final

`betterAuthSecret()` and `assertBetterAuthSecretConfigured()` apply the same predicate:

1. unset or empty,
2. shorter than 32 characters,
3. exactly equal to `better-auth-secret-12345678901234567890`.

**Three, not four.** F-144's condition was checked against the tree and is false. TASK-003's
card is stale on this point; see the conflict note.

### What it takes from precondition 2, and what it does not

| Machinery | Taken | Why |
|---|---|---|
| `BootPrecondition` member `'better_auth_secret'` | **yes** | One word, and it puts `boot_precondition` on the refusal line so the operator sees which of three preconditions refused rather than parsing prose. This is the half of F-245 that costs nothing |
| Retry budget and backoff | **no** | A `process.env` read cannot be transiently unavailable. Retrying it for twenty seconds delays a refusal that is already certain, which is the reasoning F-116 used to refuse retrying an unsafe verdict |
| Verdict prefix | **no** | The prefix separates "could not answer" from "answered unsafely". Every outcome here is an answer. A prefix with nothing to distinguish is a string match that can only drift, and `main.ts` already carries two of them by wave 3 |
| Refusal by throwing, caught in `bootstrap().catch`, exit 1 | **yes** | Unchanged from both existing preconditions |

### Where it runs

Third statement of `assertBootPreconditions()`, between `readBuildCommitSha()` and
`assertRuntimeRoleIsSafe()`:

```ts
async function assertBootPreconditions(): Promise<void> {
  readBuildCommitSha();
  assertBetterAuthSecretConfigured(process.env);
  await assertRuntimeRoleIsSafe();
}
```

`main.ts`'s own docblock fixes the ordering rule: preconditions run "in the order it is
cheapest to find out", which is why `readBuildCommitSha()` precedes the database check. A
string comparison over `process.env` is in that class. A misconfigured secret therefore
refuses before the process opens a connection, and it refuses in two milliseconds rather than
after a twenty-second database budget on a machine where the database is also down.

### One error class, because the accessor wins the race in wave 3

Both throw one class exported from `boot-assertions.ts`. `main.ts` maps it:

```ts
catch (error) {
  const precondition =
    error instanceof BootPreconditionError ? error.precondition
    : error instanceof AuthBindingError ? error.binding
    : undefined;
```

> **Generalised 2026-08-16 (ADR-0059).** This ADR first named the class
> `BetterAuthSecretError`. ADR-0059 adds `BETTER_AUTH_URL` and `WEB_APP_ORIGINS` as declared
> bindings on the same terms, so the class is `AuthBindingError` and carries a `binding`
> field whose three values are the `BootPrecondition` members. The reasoning below is
> unchanged and now applies three times rather than once. The normative signature is in
> `auth-config-surface.md`.

This is not tidiness. From wave 3, `main.ts` imports `auth.config.ts` for the mount, so
`betterAuthSecret()` throws during module evaluation and `assertBetterAuthSecretConfigured`
never executes. Without the shared class the refusal loses `boot_precondition` in exactly the
configuration ADR-0051 exists to protect. With it, the log line is identical either way and
the assertion's value degrades to redundancy rather than to nothing.

**`boot-assertions.ts` must not import `auth.config.ts`.** The dependency runs
`auth.config.ts` to `boot-assertions.ts` and never back. This is stated in both files'
docblocks because it is invisible in a diff.

### The message

Names the rule that was broken and nothing else. Never the value, never a prefix of it, never
its length. ADR-0051 fixes this, and it is the opposite of ADR-0045's user-id prefix, where a
prefix is useful and the value is not a credential. The message names the variable, the rule,
and the remedy, in the style `main.ts:294-297` records for boot refusals: the message is the
diagnosis, and `includeMessage: true` on that path is already the rule.

## Alternatives considered

| Option | Pros | Cons | Why not |
|---|---|---|---|
| Reuse the whole precondition-2 shape: verdict prefix, retry loop, budget | Uniform. Every boot check looks the same, so a reader learns one pattern. `main.ts` gains no third shape | The retry loop would spin twenty seconds over a value that cannot change during it, and the prefix would exist to separate two cases only one of which occurs. Machinery whose reason does not apply reads as though it does, and the next author copies it into a fourth check where it also does not apply | Uniformity purchased with two mechanisms that are inert here. Stating the asymmetry is worth more than hiding it |
| No `BootPrecondition` member; let it be an ordinary throw | Nothing added to `main.ts` at all. The message alone is a full diagnosis | Loses `boot_precondition` on the line, which is the field F-245 added so the two refusals are separable by machine and not only by prose. Three preconditions with two labelled is worse than three with three | One word, and F-245 already paid for the argument |
| Put `betterAuthSecret()` in `auth.config.ts` beside its caller | The accessor sits next to the `betterAuth({ secret })` call it feeds, which is where a reader looks | `boot-assertions.ts` would then import `auth.config.ts` to share the predicate, and `main.ts`'s import of the assertion would construct the whole auth instance before `bootstrap()` runs. ADR-0051's whole point is that the assertion runs before the process serves | Structurally impossible without duplicating the predicate, which ADR-0051's negative consequences already flag as the thing nothing makes agree |
| A third module, `better-auth-secret.ts`, imported by both | Neither file depends on the other. The narrowest possible dependency edge | A fourth file in `apps/api/src/auth` for one predicate and one constant, and it is not in TASK-003's `paths`, so the card widens again. ADR-0051 asks for "one shared predicate in the same module" and `boot-assertions.ts` is that module | Buys a graph nicety for a path widening and an extra file |
| Assert only that the variable is set, and let better-auth validate the value | One line. The library does have a check | The library's check returns early under `isTest()` and throws only under `isProduction`, which are the two environments that exist. ADR-0051's first alternative, already rejected | Settled |

## Consequences

### Positive

- A misconfigured secret refuses in milliseconds, before any connection is opened, with a
  line carrying `boot_precondition: "better_auth_secret"`.
- The refusal reads identically whether the accessor or the assertion raised it, so wave 3's
  import order cannot silently degrade the diagnosis.
- `main.ts` gains one union member and one `instanceof` branch. No new retry loop, no third
  prefix, no fourth constant.
- The rejection count is settled against the tree rather than against the fourth revision of
  an ADR.

### Negative / accepted cost

- **`main.ts`'s catch now branches on two error classes,** where F-245 designed it around one.
  A third class added later has no obvious home and the branch grows.
- **From wave 3 the assertion is mostly redundant,** because the accessor fires first through
  the mount's import. It still covers a process that imports `boot-assertions.ts` and not
  `auth.config.ts`, which is `main.ts` today and nothing else. The duplication is what
  ADR-0051 asked for; this ADR records that one of the two halves stops being the one that
  fires.
- **The three preconditions now have two different shapes,** and nothing enforces which shape
  a fourth should take. The rule is in this table and in no code.
- **`betterAuthSecret()` reads `process.env` directly while
  `assertBetterAuthSecretConfigured(env)` takes it as an argument.** The asymmetry is
  deliberate, the accessor is called from module scope where there is nothing to thread from,
  and it will still read as an inconsistency next to TASK-004's `assertBffProxySecretConfigured(env)`.
- **"Not the published default and at least 32 characters" remains a weak definition.** It
  admits thirty-two `a`s. ADR-0051 accepted that: it is a floor, not a judgement, and a
  heuristic that warns is a rule nobody obeys.
- **The by-value rejection goes stale silently** if better-auth changes its constant in a
  later release, and the check reverts to a length test with nothing failing. The version pin
  bounds it and the upgrade procedure has to re-read `create-context.mjs`. ADR-0051 recorded
  this and nothing here improves it.

### Follow-ups this creates

- **TASK-003's card is stale on the rejection count.** `TASK-003:131-140` says
  `betterAuthSecret()` throws "on **either** published constant" and that there are "now
  **two** rejected by exact value", carrying F-074's amendment. F-144 reversed F-074 and
  ADR-0051's follow-up asserts the card "already says" three, which is not what the card
  says. Verified against the tree: the literal is gone from `docker-compose.yml`, so the
  count is three and the card needs the F-144 correction its own source ADR assumed it had.
- `boot-assertions.spec.ts` covers one case per rejection plus one accepting case, asserting
  the throw rather than a return, and asserts that the accessor and the assertion refuse the
  same four inputs. Both are in TASK-003's declared `test_files`.
- TASK-004 adds three assertions to this file in wave 3 and inherits the no-`auth.config.ts`
  import rule. Its `assertAuthRoleSeparation` does carry a verdict prefix and a retry, because
  it opens a connection and precondition 2's reasoning applies to it in full.
- `main.ts` is written by TASK-003 for the call and the `instanceof` branch, and by TASK-004
  for the mount and `AUTH_VERDICT_PREFIX`. One wave apart, so no concurrent write.
