---
id: TASK-060
story: STORY-002
epic: EPIC-001
title: Close the logging opt-out class and enforce it in lint
status: todo
owner_slot: sdlc-implementer-backend
depends_on: [TASK-003, TASK-005]
paths: ["apps/api/src/tenancy/tenant-context.ts", "apps/api/src/db/client.ts", "eslint.config.mjs", "apps/api/src/observability/**", "docs/architecture/**", "apps/api/package.json", "pnpm-lock.yaml"]
contracts: ["design/contracts/logging-and-headers.md", "design/contracts/tenant-context.md"]
test_files: ["apps/api/src/tenancy/tenant-context-logging.spec.ts", "apps/api/src/db/client-logging.spec.ts", "apps/api/src/observability/logging-opt-out.spec.ts", "apps/api/src/observability/logger-lint-rule.spec.ts"]
acceptance: [AC-116]
rework_count: 0
---

## Why this TASK exists

Minted 2026-08-11 under **Amendment A-9** on STORY-002, by Juano's ruling, to give **F-247**
an owner that can actually discharge it and to close the class **F-278** established.

F-247 sat open and ownerless for a day. `apps/api/src/tenancy/tenant-context.ts:247` is
surviving code; `tenancy/**` belongs to TASK-005, which is `done`; TASK-003 owns the logging
policy but not that path, and its card says so explicitly under "Not this TASK's, routed
away". The re-scope sweep re-routed it to TASK-003 anyway, which is where it stuck. Spending
TASK-003's one reserve round on a finding discovered after its count was set was the
alternative Juano rejected.

## Intent

Make `logging-and-headers.md`'s "every API TASK. Nothing may opt out" true, and make it stay
true without anyone remembering to check.

## The three known sites

Verified live at HEAD; confirm each still exists before changing it rather than trusting this
list.

1. **`apps/api/src/tenancy/tenant-context.ts:247`** — F-247, **major**. Logs
   `afterCommit hook failed: ${error.name}: ${error.message}` through Nest's `Logger`. Raw
   `error.message` is the exact field ADR-0028's policy makes default-deny everywhere else. A
   pg error there carries the DSN; an application hook's error can carry row data. The line
   has no `request_id`, no `level`, `service` or `env`, no timestamp and no redaction, and it
   is on a **per-request tenant path** rather than in a corner.
2. **`apps/api/src/tenancy/tenant-context.ts:136`** — F-278. `new Logger(...)` from
   `@nestjs/common`.
3. **`apps/api/src/db/client.ts:55`** — F-278. Same construction. This is the **benign half** —
   name and SQLSTATE only — and grading it together with site 1 is what made F-243 clause 3
   read as "two stale logger comments" for six days. Fix both; do not conflate them again.

## Read this before deciding the shape

**F-274 was filed against site 1 on a false premise, by the orchestrator, and corrected.** It
claimed the line interpolates `error.message` into `msg` "assembled by the call site before
pino sees it". The line never reaches pino at all. F-247 had the mechanism right the whole
time: outside pino and outside redaction, because it goes through Nest's own `Logger`. Three
findings landed on one line and two of them were wrong about why.

The reason that matters here: a fix that routes these lines through pino's `msg` argument
inherits the seven-door problem ADR-0028 exists to solve, and **door seven was a blocker
(F-277) closed only last round**. Route them through the field allowlist, not through message
interpolation.

## The lint rule is the half that makes this stick

**CORRECTED 2026-08-11 (F-358) — the premise below was mine and it was stale.** I wrote that
F-268's rule "says nothing about `Logger` from `@nestjs/common`". At HEAD it does: `eslint.config.mjs`
restricts that import, and then **`ignores` `db/client.ts` and `tenancy/tenant-context.ts` by
name**. Verified at `eslint.config.mjs:84-99`. The comment there calls them "ADR-0028's named,
bounded exemption" and states that "A THIRD `new Logger(…)` is a finding, not a precedent".

**So the lint work is removing two exemptions and widening `importNames`, not writing a rule.**
The red step measured it: the `Logger` fixture reports 1 error at an arbitrary new API path and
**0 at either exempted path**, so the rule works and the exemptions are the whole of what stands.

Widen `importNames` to cover `ConsoleLogger` as well — the other logger `@nestjs/common` exports,
and the test architect's reading of AC-116's "or any other logger". That reading is kept.

Do not simply delete the two `ignores` entries and stop: the comment above them explains that a
plain `ignores` would also switch off `no-console` and the `pino` restriction for those files,
"which is more than the exemption is for". Whatever replaces it must keep those two rules on.

The original text follows for the reasoning it carries about *why* the rule matters, which stands:
without it this TASK fixes three lines and the class reopens on the fourth.

The rule needs an escape hatch decided deliberately if `main.ts`'s pre-pino bootstrap path
needs one — say which, and why, in the rule's own comment.

## Out of scope

The pino instance itself, the field allowlist and the seven doors — all TASK-003's, all
shipped. `main.ts`. Anything under `apps/web/**`. Do not re-open ADR-0028; this TASK executes
it where it was not executed.

## Interfaces

**Consumes**

The pino logger instance registered at the composition root (TASK-003), and
`design/contracts/logging-and-headers.md` as normative.

**Produces**

Three call sites emitting through the sanctioned pipeline; one lint rule that fails the build
on a fourth.

## Definition of Done

- [ ] AC-116 green, including the lint rule failing on a deliberately added violation
- [ ] F-247 and F-278's code half both closed, verified by emitting a line from each site
- [ ] The benign and the leaking site fixed separately and both confirmed, not conflated
- [ ] `logging-and-headers.md`'s "nothing may opt out" is true at the time of the claim
- [ ] All auditors clear of blocker/major
- [ ] Traceable: commits reference `[TASK-060]`
