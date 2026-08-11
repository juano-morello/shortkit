---
id: ADR-0042
slug: foundation
title: "The API source tree means apps/api/src; the no-console rule follows the source tree and the logger rule follows the package"
status: accepted
supersedes: null
date: 2026-08-11
accepted_at: 2026-08-11
---

## Context

AC-116 says "the API source tree" and never says what that is. Both mechanisms that enforce it
are bounded to `apps/api/src`: the lint block's `files` is `apps/api/src/**/*.ts`, and
`logging-opt-out.spec.ts` walks `apps/api/src`. Neither bound was decided. Both were inherited
from the glob F-268's lint rule was written with, months before AC-116 existed.

Three `console` call sites live inside the API package and outside that bound, all confirmed by
the orchestrator:

- `apps/api/test/isolation/cross-tenant-isolation.int-spec.ts:342` prints an isolation coverage
  report to a developer's terminal.
- `apps/api/scripts/check-policies.mts` prints a per-table pass or fail report.
- `apps/api/scripts/seed.mts`, added by TASK-059, prints connection identity and progress.

Nothing outside `apps/api/src` imports `pino` or `@nestjs/common`'s `Logger` today. Measured by
grep across `apps/api/test` and `apps/api/scripts`: the only `@nestjs/common` import out there is
a test controller importing `Controller`, `Get` and `BadRequestException`.

Reading "the API source tree" as `src` is defensible, and a one-shot CLI writing progress to
stdout is not a server log line. So AC-116 is not failed by any of this, and both auditors said
so. What F-372 filed is that a boundary is being enforced that nobody chose, it now sits between
two TASKs, and it is recorded only in two audit reports nobody will read again.

The scripts matter more than the test does. `docker compose` runs `db:migrate` and `db:seed` as
services (ADR-0033), so a script's stdout is a container log rather than only a terminal. There
is no log shipper and no deploy target (ADR-0030), so nothing parses those bytes as NDJSON
today.

## Alternatives

### 1. Widen both mechanisms to the whole package

`files: ['apps/api/**/*.{ts,mts}']` for the lint block, and walk `apps/api` in the enumeration.

- **Pros.** One bound for one package, and no reader ever has to ask which files are covered.
  Every byte the package writes to a descriptor goes through one configured logger, so a compose
  log is uniformly parseable whichever service produced it. It is the reading of "the API source
  tree" that requires no interpretation.
- **Cons.** It breaks the three existing call sites, and both repairs are bad. An `ignores` list
  naming them reintroduces exactly the named-file exemption shape TASK-060 spent a card
  deleting, on the same rule. Converting them means a seed script that emits NDJSON to the
  developer running `pnpm db:seed`, and a script importing `observability/logger` drags the
  composition root, its `service` and `env` bindings and the field allowlist into a one-shot
  CLI, so `seed: connected as shortkit_app to shortkit` becomes a JSON line whose `msg` is that
  string and whose fields are censored unless someone adds `current_user` to `LOGGABLE_FIELDS`.
  The enumeration half is worse: its second assertion is "every module that emits imports the
  shared logger", which is false by design for a CLI, so the walk would go red on three files
  the day it widened.
- **Why it lost.** It applies the mechanism where the hazard is not, and charges readability
  where the audience is a human at a terminal.

### 2. Keep both at `src` and write the bound down

Change no code. Record that "the API source tree" means `apps/api/src`, with the reason.

- **Pros.** Zero risk, zero new lint surface on files TASK-059 and TASK-006 own, and it is
  literally what F-372 asked for: rule the boundary and record it. It respects GC-14, since the
  alternative buys a change to a config file in the middle of another TASK's audit.
- **Cons.** It documents the whole boundary including the part that carries real risk. Nothing
  stops a script or an integration test from calling `pino()` or `new Logger('Seed')`. That is
  the one shape out there that could put an unstructured or unallowlisted line onto a descriptor
  while looking to its author like it went through the shared logger, and it costs nothing to
  prevent, because no such import exists.
- **Why it lost.** Two of the three prohibitions have the same justification at `src` and
  outside it. Only `no-console` has a different one, and lumping them together is what made the
  boundary look arbitrary in the first place.

### 3. Split the bound by what each rule protects

`no-console` stays at `src`. The logger-import restriction follows the package.

- **Pros.** Each bound gets a reason a reader can check. Closes the part of the gap that carries
  risk, and the closure lands green today because there is nothing to fix. Leaves stdout
  available where stdout is the interface.
- **Cons.** Two bounds in one package, which is one more thing to know, and the config file has
  to explain itself. It also touches a rule whose `files` glob will now have to match `.mts`,
  which is a detail that can silently not work.
- **Why it won.** The two rules protect different things and the split says which is which.

## Decision

**"The API source tree" in AC-116 means `apps/api/src`. That is the normative reading.**

### `no-console` stays bounded to `apps/api/src/**/*.ts`

The prohibition exists to protect the integrity of the long-running server process's log
stream: one process, one descriptor, NDJSON, `service` and `env` on every line, a field
allowlist between a value and the bytes. `apps/api/scripts/*.mts` are one-shot CLIs whose
stdout is the product, read by a developer at a terminal or by whoever runs
`docker compose up`, with no shipper, no retention and no query behind it. `apps/api/test/**`
writes to a test reporter. Neither is the server's log stream, and making them JSON serves
nobody.

**Two obligations follow on the author instead of on a rule, and they are the price of this
half.** A script or test that writes to `console` must not print a connection string, a
password, an API key, or the contents of a tenant row. GC-9 binds the package, not the glob:
what changes outside `src` is which mechanism enforces it, and outside `src` the mechanism is
review.

### The logger-import restriction follows the package

The `no-restricted-imports` logger entries widen from `apps/api/src/**/*.ts` to
`apps/api/**/*.{ts,mts,cts}`, still with the single exemption
`apps/api/src/observability/logger.ts`. No file in the API package builds its own pino instance
or imports Nest's `Logger` or `ConsoleLogger`, wherever it lives. This is a fail-closed widening
that lands green: measured, no such import exists outside `src` today.

Whoever lands it **measures that the `files` glob actually matches `.mts`** with a fixture at
`apps/api/scripts/seed.mts`, rather than trusting the brace expansion. A glob that quietly
matches nothing is this decision with none of its effect.

### The enumeration stays at `apps/api/src`, deliberately

`logging-opt-out.spec.ts` asserts that every module which emits imports the shared `logger`.
That is false by design for a CLI, so widening the walk would fail three files for doing the
right thing. Its bound is the same `src` the `no-console` rule has, for the same reason, and
that is now a decision rather than an inheritance.

## Consequences

### Positive

- The bound is chosen and checkable. A reader asking why `seed.mts` may call `console.log` gets
  an answer instead of a glob.
- The one risky shape outside `src` is closed before anything does it, and closing it costs a
  glob edit because the tree is already clean.
- The named-file exemption shape does not come back. Whatever else happens to these rules, no
  path is ever listed in `ignores` again except the composition root.
- The three existing scripts stay readable, which is the property that makes
  `pnpm db:check-policies` worth running.

### The cost accepted

- **Two bounds in one package.** A contributor must know that `console` is legal in
  `apps/api/scripts` and illegal one directory over, and the only thing telling them is a
  comment in `eslint.config.mjs` and this ADR. The first time someone moves a helper from
  `scripts/` into `src/`, lint tells them; the reverse direction is silent.
- **Nothing checks what a script prints.** `seed.mts` runs inside compose with the database URL
  in its environment. If a future edit prints it on failure, no test goes red, no lint rule
  fires, and the value lands in a container log. Review is the only gate, and this ADR is what
  makes that explicit rather than accidental.
- **The integration test's `console.log` stays.** It prints an isolation coverage report, which
  is the correct thing for it to do, and it is now permanently outside the mechanism rather than
  temporarily.
- **`.mts` is a new surface for the lint config.** The root config's TypeScript block is
  `**/*.{ts,tsx}`, so `.mts` files have been carrying only the recommended rule sets. Widening
  the logger restriction to `.mts` is the first rule this repository aims at that extension, and
  it may surface unrelated findings in the two scripts when it lands.

### Follow-ups this creates

- **The glob widening does not ride TASK-060.** It touches lint behaviour for files TASK-059
  owns and two auditors are still reading that diff. It lands in a later card, after TASK-059 is
  done, alongside ADR-0041's pattern change to the same rule object, which is the same file and
  the same measurement pass.
- **F-372's documentation half is discharged here.** Its code half, the widened glob, closes
  with that card.
- `apps/api/.env.example` still does not exist, so nothing documents which variables a script
  reads. Unchanged by this decision and named because the "do not print a connection string"
  obligation is easier to keep when the variables are documented.
