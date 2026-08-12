---
id: ADR-0039
slug: foundation
title: Design stubs die at the design gate
status: accepted
supersedes: null
date: 2026-08-11
accepted_at: 2026-08-11
---

## Context

A design stub is a source file written before the code exists, at the path the code will
occupy, with signatures and types complete and bodies throwing `not implemented`. Its job is
narrow and it is a good job: during a wave, several TASKs need the same boundary to compile
against, and the stub is what lets them be written in parallel instead of in sequence. This
initiative has 29 of them under `design/stubs/`.

The job ends the moment the file exists. Once a TASK has materialised a stub into the
repository, the boundary is the source file, every consumer imports the source file, and the
stub is a second copy of the same declarations with nothing reading it. Two copies, one
reader, no gate between them.

What that has cost, measured on this initiative:

**F-288 was a blocker caused by exactly this.** The design stub for
`apps/web/src/lib/api/client.ts` carried `FORWARDED_REQUEST_HEADERS_MUTATING_ONLY = ['origin']`
under a docblock titled "F-233. Origin on mutating requests, and why dropping it breaks all of
auth". The shipped file did not. The predicted failure was every signup, sign-in and sign-out
answering 403 in production while every test passed, because the tests speak to the API
directly and never cross the proxy.

**A hand sweep on 2026-08-10 was the only thing that found it.** It read all 29 stubs against
`git show HEAD:<path>`, found 12 materialised and 17 unmaterialised, and confirmed F-288 was
the single structural divergence. Nothing keeps that result true. It was true for one commit.

**The sync ritual does not converge.** On 2026-08-11 the TASK-008 stub was hand-synced twice.
An implementer working the same file flagged three wording deltas and declined to propagate a
pre-existing stub omission it correctly judged was not its to fix. An architect asked to
touch the isolation stub declined and called it "a policy question about whether stubs live
past the design gate". Each of those calls was right. They are the cost of an artifact whose
correctness depends on people remembering it.

**Nothing gates stub-versus-source anywhere in this repository.** Verified 2026-08-10 and
again 2026-08-11. No test, no lint rule, no CI step. TASK-008's red step stood where that
gate should have been and said so. `isolation-coverage.md`'s new "Which copy of this is
normative" section says the same thing about a third artifact.

Three artifacts describe every boundary here: the source, the contract, and the stub. Two of
them have a reader and a reason. The third had a reason that expires.

## Alternatives

### 1. Keep the stubs and add a CI drift gate that compares exported shape, not text

The runner-up, and it lost on cost rather than on merit. A gate emits declarations from each
stub and from its materialised sibling, compares the exported name and signature sets, and
fails the build on a difference. Shape rather than text, so comments, ordering and
`not implemented` bodies do not trip it.

- **Pros.** It closes the F-288 class mechanically instead of procedurally, which is what
  every finding on this subject has actually asked for. It keeps a compiling reference alive
  for a deferred producer, which is the one thing retirement gives up. It is the only option
  that puts a machine where a human currently stands, and this repository has a strong record
  of preferring that: the logger drift test, `db:check-policies`, and the build-provenance
  check all exist for the same reason.
- **Cons.** The cost is real and lands now. The stub tree has no `package.json` and no
  `tsconfig.json`, so declaration emit needs a synthetic project built for the gate alone. The
  17 unmaterialised stubs have no sibling to compare against and are outside the gate's reach,
  so it defends 12 files and grows only as TASKs land. Deliberate divergences need an
  allowlist and there are already two of them, the superseded `logger.ts` and the five
  `coverage.ts` fields, so the gate ships with exceptions on day one and every future
  exception is a judgment someone has to encode. And the gate defends a copy that no build,
  no test and no import reads. It buys correctness for an artifact whose value at that point
  is zero.
- **Why it lost.** GC-14 is 25 hours a week, solo. This is a TASK-sized build with no
  acceptance criterion behind it, and its whole output is keeping a redundant file honest. The
  cheaper move is to delete the file, at which point the gate has nothing to check. Consistency
  with the repository's automate-the-check habit points the other way, and that is the reason
  this alternative is written first rather than dismissed: the habit is right, and it is right
  because those gates defend artifacts that something reads.

### 2. Delete every stub at the design gate, materialised or not

One sweep, no rule to remember, no divergence surface anywhere.

- **Pros.** The simplest rule in the set, and the only one with no ongoing judgment. It also
  removes the 17 stubs that will sit unread for however long EPIC-002 through EPIC-006 stay
  deferred, which on current sequencing is months.
- **Cons.** It destroys the thing stubs exist for before the thing has happened. All 17
  unmaterialised stubs name deferred producers, and their contracts were written assuming the
  stub carries the shape. Several carry security reasoning that exists in that form nowhere
  else: the injection-order argument in `auth-rate-limit.port.ts` (F-024), the trusted-proxy
  decision in `resolve-rate-limit-principal.ts` (F-031), the digest-before-tenant ordering in
  `capability-token.ts` (F-001), the three-transaction census in `tenant-scoped-tables.ts`
  (F-002), `AND state = 'active'` in `redirect-read.ts` (F-003), the leftmost
  `X-Forwarded-For` rule in `click-event.types.ts` (F-009), and the two-`member`-enums trap in
  `roles.ts` (F-012). ADR-0030 names six of these stubs by path as the inventory of Fly
  assumptions to revisit when a deploy target is chosen.
- **Why it lost.** It deletes the reference before its reader has been written. The problem
  being solved is a stale copy, and an unmaterialised stub has nothing to be stale against.

### 3. Regenerate every stub from its source when a TASK closes

Keep both copies, and make the copy a build output instead of a hand-maintained file. A script
strips bodies from the source and rewrites the stub.

- **Pros.** The stub can never be wrong, without a gate and without anyone remembering. It
  keeps the design-time browsing surface, which is a real convenience: one directory holding
  every boundary in the system.
- **Cons.** It makes the duplication permanent and the cost recurring, forever, per TASK. It
  also inverts the artifact's meaning without saying so: a stub regenerated from source is no
  longer a design decision, it is a view of the code, and a reader who opens it looking for
  the design gets the implementation. Two places to look remains two places to look even when
  they agree.
- **Why it lost.** It pays maintenance in perpetuity to preserve a file that is by
  construction redundant with the one beside it.

## Decision

**A stub is deleted when the TASK that materialised its file reaches `status: done`.**

Precisely:

1. **The materialising TASK is the one whose commit created the file at the workspace path**,
   not necessarily the one the stub header's `Produced by:` line names. Those differ in
   practice. `packages/contracts/src/domains/reserved-hostnames.ts` names TASK-038, which is
   deferred, and was materialised by TASK-007 in `09cb39a`. Resolve it from git, not from the
   header.
2. **A stub whose file does not exist in the repository stays**, however many TASKs its header
   names and whatever their statuses are. Its reason for existing still holds.
3. **A stub with several producers dies with the first `done` one that creates the file.** The
   later producers read the source and the contract. `packages/contracts/src/slug.ts` is the
   shape: TASK-007 shipped the constants and the throwing `validateSlug` declaration, and
   TASK-024 fills the body when it returns.
4. **Deleting a stub is not a licence to drop what it carried.** Before deletion, two things
   are checked and recorded: every exported declaration in the stub exists in the source, and
   every capitalised security rule in the stub exists in the source or in the contract. A
   missing one is a divergence to file, not a file to delete. This clause is what stops a
   retirement laundering away the next F-288.
5. **Contract headers stop naming a stub as a normative form.** `Normative form:` names
   workspace paths. Where a stub survives, the contract may point at it as a scaffold and must
   say it is derived and provisional.
6. **A `design/stubs/<path>` reference in an accepted ADR or an accepted contract resolves to
   `<path>` in the repository once the stub is retired.** ADR-0005, ADR-0024 and ADR-0030 all
   carry such references and none of them becomes false. The reference is redirected by this
   ADR rather than edited in place, because editing an accepted ADR to chase a path is how
   ADRs stop being a record of what was decided.

The precedence this settles, for every boundary in this initiative:

| Artifact | Standing |
|---|---|
| the source file | the behaviour. Where the contract and the code disagree, the code is the fact and one of the two is a defect, adjudicated by the contract's own precedence clause |
| the contract | normative for what the file must do, and the artifact a reimplementer builds from |
| the ADRs | the decisions, not the mechanism |
| the stub | a design-gate scaffold. Alive only while its file does not exist. Never normative |

The TASK-008 stub is the first file this rule deletes, on the same day it was hand-synced
twice. Both syncs were correct under the rule that existed that morning.

## Consequences

**Positive.**

- The F-288 class becomes unreachable for a retired stub. Divergence needs two copies and
  there is one. This is not a mitigation, it is the removal of the failure mode, for every
  boundary whose TASK has closed.
- The sync ritual has no successor. The two hand-syncs of 2026-08-11, the wording deltas an
  implementer had to triage, and the omission it had to decline all stop being possible on
  that file.
- The check is cheap enough that it can actually be automated later: "no stub path may have a
  materialised sibling created by a `done` TASK" is a path existence test and a git lookup, not
  a TypeScript declaration comparator.
- The 17 stubs that still do work keep doing it, with their reason stated rather than assumed.
- Agents stop being asked to adjudicate stub content. The isolation architect's refusal today
  is the correct answer for every such request from now on.

**The cost accepted.**

- **A returning deferred TASK reads the contract rather than a compiling reference.** This is
  the real loss and it is not small. An implementer picking up TASK-024 in six months would
  rather open a file with the signature in it than a document with a fenced block in it. The
  mitigation has two halves. The source file is itself a compiling reference and a better one,
  because it is what the build actually sees; on this sweep the exported declaration sets of
  all ten retired stubs matched their sources exactly, so no TASK lost anything it could have
  used. And the contract has to be good enough to build from, which is defined below rather
  than left as a wish.
- **The load-bearing comments now live only in the source.** The stubs README kept a table
  naming eight files whose capitalised warnings must not be stripped as noise. For a retired
  stub that defence moves into the source file, which is edited by later TASKs that may not
  know a given comment is load-bearing. Clause 4 checks the comments survive the deletion. It
  does not check they survive the next refactor.
- **This ADR replaces a missing drift gate with a missing retirement gate.** Smaller and
  cheaper to check, and still nothing runs. Retirement is a human step at a TASK's close, and
  a human step is what every finding in this cluster was about. Stated plainly rather than
  presented as solved.
- **The design-time shape of a boundary stops being browsable.** An audit asking "what did
  this interface look like when it was designed, before four rework rounds" loses the flat
  answer. It is recoverable from git and the command is
  `git log --diff-filter=D --name-only -- .sdlc/foundation/design/stubs/`, which is a worse
  answer than a file sitting there.
- **The stub tree now shrinks over time and reads as incomplete.** Someone opening
  `design/stubs/` after several waves finds a partial map of the system and could conclude the
  missing boundaries were never designed. The README carries the correction, and a reader who
  does not open the README gets the wrong impression.

**What makes a contract good enough to build from.** This is the standard the mitigation above
rests on, so it is a list and not a sentiment. A contract whose stub has been retired must
carry, and a contract whose stub is about to be retired is checked against:

1. **The normative form in the stack's own language, in a fenced block, complete enough to
   paste.** Exported names, full signatures, every type they mention. Prose describing a type
   is not the type.
2. **Every error case and its exact string.** Verbatim, including the message text an
   implementer copies. This is the most-skipped item and the most expensive one.
3. **The invariants a caller may rely on**, written as claims that can be false, so a reviewer
   can test one.
4. **The rules a reader of the source file alone would otherwise get wrong.** F-288's lesson,
   already codified in `web-api-client.md`'s precedence clause: a rule stated in the contract
   and absent from the file's comments is a defect in the file. Retirement makes this clause
   load-bearing for every contract, not just that one.
5. **A ledger of what the contract claims that is not yet true**, with the owner of each.
   `isolation-coverage.md`'s "What this contract claims that is not yet true" section is the
   shape. Without it a returning implementer infers what is owed, and inference is how three
   of that contract's seven wrong statements survived.

**Follow-up work this creates.**

- **A retirement check with no owner today.** For every path under `design/stubs/`, if the
  workspace path exists and the commit that created it belongs to a `done` TASK, fail. Small,
  and it needs a TASK that does not exist. Noted here so the gap is on the record rather than
  assumed closed by this ADR.
- **TASK-006's close retires `design/stubs/apps/api/test/isolation/coverage.ts`**, and
  `isolation-coverage.md`'s row for the stub in "Which copy of this is normative" goes in the
  same commit. TASK-006 is in fix round 4 and the stub is already known stale, which is the
  cost of the rule being status-based rather than divergence-based, and it is the right
  trade: TASK-006 is still writing that file.
- **TASK-003's close retires `design/stubs/apps/api/src/observability/logger.ts`**, and the
  three sentences in `logging-and-headers.md` that describe the stub as superseded go with it.
  That stub is the strongest case for status-based retirement having a hole: its file shipped
  in `6a7200f`, it has been superseded since F-249, and it survives this sweep only because
  TASK-003 is in rework. The superseded banner is the standing mitigation until then.
- **Every contract in the "good enough to build from" audit, as each producer is undeferred.**
  Not now, and not all seventeen at once. The check belongs at the moment a deferred TASK is
  scheduled, when someone is about to read the contract for real.
- **ADR-0030's Fly inventory now resolves to source paths for two of its eight entries**,
  `apps/web/src/lib/api/client.ts` and `packages/contracts/src/domains/reserved-hostnames.ts`.
  Both carry their Fly references in the source, verified. ADR-0030 is not edited; clause 6
  redirects it.
