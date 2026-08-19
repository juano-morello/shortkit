---
id: ADR-0041
slug: foundation
title: "\"Or any other logger\" is gated at the dependency list, and the import site fences the packages we have"
status: accepted
supersedes: null
date: 2026-08-11
accepted_at: 2026-08-11
---

## Context

AC-116 reads "no module constructs `Logger` from `@nestjs/common` **or any other logger** — and
a lint rule fails the build if one does". TASK-060 shipped that as a per-package name
enumeration: `Logger` and `ConsoleLogger` from `@nestjs/common`, value imports of `pino`,
`console.*`, and dynamic `import()`/`require()` of the first two in the enumeration spec. All
three clauses of the AC are met and were measured through the ESLint CLI at four paths across
five fixtures.

Two holes were then measured in that enumeration, one of them by emission.

**F-369, the subpath.** `@nestjs/common` 11.1.28 ships no `exports` field, so
`import { Logger } from '@nestjs/common/services'` resolves and yields the real class. The
reviewer constructed one and got the exact ANSI-coloured, locale-clocked line AC-116 exists to
eliminate. It lints clean, because `no-restricted-imports` `paths` entries match the specifier
exactly, and the enumeration spec misses it too, because `logging-opt-out.spec.ts:229` tests
`specifier === '@nestjs/common'`. Eight lines below, `:237` tests
`specifier === 'pino' || specifier.startsWith('pino/')`. The subpath family is covered for one
package and not the other inside the same function, which makes it an oversight rather than a
ruling.

**F-371, the next package.** A module that adds `winston` and calls `createLogger().info(…)`
passes the lint rule, and passes the enumeration's second assertion too if it also imports the
shared logger for anything else. It then writes lines that reach neither `LOGGABLE_FIELDS` nor
`serializers.err`, which is GC-9's exact failure.

Neither is live. No `@nestjs/common` subpath import exists in the tree, IDE auto-import resolves
to the package root, and no logging package other than `pino` is declared anywhere in the
repository. The clause is met today. This is a decision about the durable form.

What makes it worth a decision rather than a patch is that the rule's own comment already makes
the argument one level up. It justifies adding `ConsoleLogger` on the grounds that "listing
`Logger` alone is the enumeration weakness ADR-0028 rejected for the redact list, one package
export over" — and then leaves the identical weakness one package subpath over, and one package
over. ADR-0028 spent a migration replacing a 25-path denylist with an allowlist for exactly this
reason. Answering "why did the list stop where it stopped" with "those are the ones we thought
of" is what that migration was about.

The house pattern for this shape is settled and it is not a longer list. ADR-0019 derives
tenant-scoped tables from the Drizzle schema and cross-checks against `information_schema`.
ADR-0020 derives the isolation suite. `logging-opt-out.spec.ts` itself derives its subject set
by walking `apps/api/src` and proves on every run that its analyser can tell a violating module
from a compliant one. Derive the set from an artifact, assert over it, and prove the derivation
would notice.

## Alternatives

### 1. Keep the name enumeration and record it as the deliberate form

Add nothing. Write down that "any other logger" means the loggers this repository can actually
reach, and that a new one arrives as a `package.json` diff a human reviews.

- **Pros.** Zero new machinery and zero false positives. Every entry produces a precise error
  message that names the shared logger and the ADR, which a fail-closed rule cannot do. The
  human review it relies on is real: adding a dependency is a reviewed diff, and this
  repository has a security auditor and a product auditor on every round. It is also the
  cheapest thing consistent with what shipped yesterday, and consistency has value.
- **Cons.** The review that would catch `winston` is the same review that approved twenty-one
  dependencies without anyone asking whether any of them logs, which is not a criticism of the
  reviewers: nobody asks a question no artifact poses. The list also has no stated stopping
  rule, so the next person to extend it has to re-derive the argument, and the person who
  declines to extend it has no argument at all.
- **Why it lost.** The reasoning that added `ConsoleLogger` does not stop at `ConsoleLogger`.
  Refusing to carry it further needs a better reason than the list being long enough.

### 2. Fail closed at the import site: allow a fixed set of packages, ban the rest

One `no-restricted-imports` pattern with a negative-lookahead regex, so any specifier not on an
allowlist is an error under `apps/api/src`.

- **Pros.** The strongest available guarantee, and it lands at the exact point the hazard
  materialises: the import. It covers subpaths, it covers packages nobody has heard of, and it
  needs no second artifact to stay in sync with `package.json`.
- **Cons.** It is a general import policy wearing a logging AC's clothes. The allowlist has to
  enumerate every legitimate package, every `node:` builtin, every workspace package and every
  subpath spelling, and it has to be maintained by everyone rather than by whoever touches
  logging. Its error message cannot be specific, so a developer adding `date-fns` gets a
  failure that talks about loggers. False positives land on every import in the codebase, and
  the hazard lives in about one import in five hundred.
- **Why it lost.** It prices a repository-wide policy against a specific hazard and puts the
  friction on the wrong event. It would also almost certainly be switched off within a month,
  which is worse than not having it.

### 3. Gate at the dependency list, keep the name list as the fence

Derive the API package's dependency set from `apps/api/package.json` and require every entry to
carry a classification. Keep the import-site rule, and widen it to specifier families.

- **Pros.** Fail closed, derived from an artifact rather than remembered, and the friction lands
  once per dependency instead of once per import. It converts "somebody would have noticed" into
  "the suite does not go green until somebody says". It matches ADR-0019 and ADR-0020, and it
  reuses the non-vacuity control pattern `logging-opt-out.spec.ts` already carries. The
  import-site rule keeps its precise message for the packages we do have.
- **Cons.** It turns a spec red on every dependency addition, including the large majority that
  have nothing to do with logging, and the fix is a one-line classification that a hurried
  author will write without thinking. The classification is human judgement and can be wrong:
  `@nestjs/common` is the proof, a package any reasonable person classifies as "the framework"
  that happens to ship two loggers. It sees no transitive dependency and no package the source
  imports without declaring.
- **Why it won.** It puts the question in front of the person who is already deciding to add a
  dependency, at the moment they decide, and it does not depend on that person having read this
  ADR. The wrong-classification residual is real and is priced below; the alternative to a
  fallible judgement here is no judgement at all.

## Decision

**Two layers with two jobs. The dependency list decides which packages are loggers; the import
site fences the ones it names.**

### 1. The import-site rule covers specifier families, not exact specifiers

In `eslint.config.mjs`, the two logger entries move from `paths` to `patterns` so a subpath
cannot slip past them:

- `{ group: ['@nestjs/common', '@nestjs/common/**'], importNames: ['Logger', 'ConsoleLogger'], message: … }`
- `{ group: ['pino', 'pino/**'], allowTypeImports: true, message: … }`

Both shapes are supported by the installed toolchain and this was checked against the shipped
schemas rather than assumed: `eslint@9.39.5`'s `no-restricted-imports` accepts `importNames` on
pattern entries, and `@typescript-eslint/eslint-plugin@8.66.0` adds `allowTypeImports` to
pattern entries as well as path entries. The existing messages are unchanged.

**The implementer measures the glob rather than trusting this ADR's reading of it.** Fixtures at
`@nestjs/common`, `@nestjs/common/services` and `@nestjs/common/services/logger.service`, and at
`pino` and `pino/file`, each asserted through `ESLint#lintText` the way
`logger-lint-rule.spec.ts` already asserts the current rule. A `group` that silently fails to
match a depth is the same hole with a longer config.

### 2. The enumeration uses one predicate for both packages

`logging-opt-out.spec.ts` replaces its two hand-written specifier tests with a single
`isSpecifierFor(specifier, packageName)` returning
`specifier === packageName || specifier.startsWith(packageName + '/')`, applied to
`@nestjs/common` and to `pino`. The `pino`/`@nestjs/common` asymmetry inside `analyse()` is a
defect of that function and not a boundary, and it goes away rather than getting a comment. The
runtime `import()`/`require()` branch takes the same predicate.

### 3. The dependency list is classified, and the classification is asserted

A new spec, `apps/api/src/observability/logging-dependencies.spec.ts`:

- reads `apps/api/package.json` and derives the subject set as the union of the `dependencies`
  and `devDependencies` keys;
- compares it for **equality** against a `PACKAGE_CLASSIFICATION` record declared in that file,
  mapping every package to exactly one of `'not-a-logger'`, `'the-shared-logger'` (`pino`, and
  only `pino`) or `'ships-a-logger'` (`@nestjs/common` today);
- asserts that every package classified `'the-shared-logger'` or `'ships-a-logger'` appears in
  `eslint.config.mjs`'s restricted patterns, so a package can be classified as a logger and left
  unfenced only by editing two files that disagree;
- carries the non-vacuity control this repository requires: before any assertion is read, the
  comparison runs over a synthetic manifest carrying `winston` and must report it as
  unclassified, and over the real manifest with one entry removed and must report that too.

`PACKAGE_CLASSIFICATION` is the single home of the classification. Nothing else lists it.

**Adding a dependency is therefore three lines in one commit**: the `package.json` entry, the
classification, and, if the classification is not `'not-a-logger'`, the import-site pattern. The
failure message says exactly that.

### What this does not claim

The gate reads the API package's own manifest. A logger arriving as a transitive dependency, a
package the source imports without declaring, or a logger written inside this repository are all
outside it. The first two are also outside every mechanism the repository has; the third is a
module under `apps/api/src` and is therefore inside the enumeration and `no-console`.

## Consequences

### Positive

- The stopping rule is stated. "Any other logger" means "every package this API declares", and
  the answer to "why does the list stop here" is "because the manifest does".
- F-369 and F-371 get one fix rather than two, and the fix for the first is smaller than the
  finding suggested: one predicate, applied twice.
- The asymmetry that produced F-369 cannot recur inside `analyse()`, because there is one
  predicate left to be asymmetric with.
- The judgement happens on the day the dependency is added, by the person who chose it, rather
  than during an audit six weeks later.
- A classified manifest is a cheap artifact for the next question of this shape. "Which of our
  dependencies opens a socket" is the same query with a different label.

### The cost accepted

- **Every dependency addition turns a spec red, and most of them have nothing to do with
  logging.** That is friction paid by unrelated work for a hazard that arrives once a year at
  most, and it is the main reason alternative 1 is defensible. The mitigation is that the
  failure message names the exact edit.
- **A wrong classification is invisible.** Nothing checks that `'not-a-logger'` is true.
  `@nestjs/common` is the standing proof that a reasonable person classifies a logging package
  as something else, and this gate would not have caught it: someone would have written
  `'not-a-logger'` beside the web framework. What the gate buys is that the question gets asked,
  not that it gets answered correctly.
- **A second artifact must track `package.json`.** The equality assertion is what keeps them
  together, and it is also what makes an unrelated dependency bump a two-file change.
- **The import-site rule gets harder to read.** `patterns` with `group` is less obvious than
  `paths` with `name`, and a reader now has to know that gitignore-style globs are in play.
  Whoever lands it comments the rule accordingly.
- **None of this exists yet.** Between this ADR and the card that implements it, F-369's hole is
  open exactly as measured, and the only thing holding it is that nobody writes deep subpath
  imports by hand.

### Follow-ups this creates

- **F-369's required change is now larger than its own text and it should stay with its
  implementer.** It was routed as "make the subpath fail the build". It becomes: move both
  entries to `patterns`, add the shared predicate to `logging-opt-out.spec.ts` for both
  packages, and add subpath fixtures to `logger-lint-rule.spec.ts` at two depths. Still one
  sitting, still one file plus two specs. Sections 1 and 2 above are the whole scope.
- **Section 3 needs its own card.** It is a new spec file and a new artifact convention, and it
  is not F-369's. It carries no urgency: it fires on a dependency that does not exist.
- **F-371 is ruled, not closed.** It closes when section 3 lands.
- `logging-and-headers.md` already points here from "What enforces 'nothing may opt out', and
  what it does not reach", and that section names both residuals until they close.
