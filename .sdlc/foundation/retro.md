---
slug: foundation
date: 2026-08-12
merged: aa9c288
---

# Retro — foundation

Ten TASKs, 399 findings, 1,207 ledger entries, nine days. Merged as `aa9c288` on
2026-08-12 after 248 commits and one PR.

The primary source for this retro is `state.yaml`'s `log`. Roughly 300 of its entries
were written on the last two days in the first person by the orchestrator, and they
record its own errors with the same care as the agents'. The most useful material sits
where a claim was disproved.

## By the numbers

| Cut | Counts |
|---|---|
| Severity | 12 blocker, 132 major, 205 minor, 50 nit |
| Phase | implement 259, test 67, design 51, ship 21, retro 1 |
| Kind | behavior 76, implementation 68, design 67, contract 46, scope 38, test-coverage 37, security 32, docs 22, process 13 |
| Status at retro | fixed 247, open 89, routed 43, parked 17, escalated 2 |

**Source, solo filings.** `sdlc-security-auditor` 149, `sdlc-reviewer` 72,
`sdlc-test-architect` 37, `sdlc-architect` 33, `sdlc-implementer-backend` 24,
`sdlc-product-auditor` 19, orchestrator 16, `sdlc-integrator` 11, `sdlc-scout` 3,
`sdlc-implementer-frontend` 2, `sdlc-design-auditor` **0**. Another 30 were filed
jointly by two or three sources.

**Blockers.** Security auditor 8, product auditor 2, reviewer 1, reviewer and security
jointly 1.

**Rework.** TASK-004 six rounds, TASK-006 five, TASK-002 four, TASK-003 four, TASK-008
three, TASK-001 two, TASK-007 two. Seven of ten TASKs at two or more.

**Gates.** Refine and Test passed clean. Plan was re-gated on 2026-08-09 and failed the
shippability check on both signals, under a rule written after its approval. Design wave 2
reopened for the ADR-0028 completeness class and reapproved the same day. Implement wave 2
was requested with a note false in all three of its clauses and corrected before the gate.
Ship's acceptance auditor returned changes-requested. GitHub then rejected the push to main
and exposed F-399.

**Escalations.** 47 Juano rulings across the run. `escalations:` closes at `[]`, and
F-102 still reads `status: escalated`.

**Plan accuracy.** 6 EPICs / 21 STORIEs / 58 TASKs at the 2026-08-03 gate, re-scoped to
1 EPIC / 4 STORIEs / 8 TASKs on 2026-08-09. TASK-059 and TASK-060 were minted mid-Ship by
Amendments A-8 and A-9, both to give an orphaned obligation an owner.

## What the process got right

**Two auditors converged on one defect, blind, four times.** Reviewer and security auditor
independently made F-120 their headline major, both found F-277's door seven, both filed
F-306 with different cases, and both found the TASK-006 any-throw-is-a-pass pair. The log
calls this the strongest signal the workflow produces. Agreed.

**The design-mode security pass found three blockers before a line of code existed.**
F-002 is the sharpest: GDPR erasure denied by its own policy set, deleting nothing while
reporting success. Finding that in prose on day one costs an architect round. Finding it in
code costs a schema.

**Nine agents in a row reached green without touching a test.** Verified rather than taken
on report: `git diff` over spec files, numstat, and byte-identity through the green step.
TASK-008's rework ran 530 insertions and 0 deletions.

**Twelve agents rejected a proposed remedy on measurement.** An implementer refused
`nodenext` and proved Bundler closes the property the finding named. An implementer refused
F-303's ownerColumn fallback because `tenants.ownerColumn` is `id` and every table has one.
An architect rejected F-322's loopback refusal because the compose database and the test
database both sit on loopback, so the refusal rejects the legitimate case. An auditor argued
its own F-354 down after five rounds of arguing findings up. This is reproducible, and the
mechanism is identifiable. See "The three dispatch instructions" below.

**Red steps killed the cheapest wrong fix before anyone reached for it.** TASK-008's
mutation M-A is a plain `new Set` comparison, the obvious repair for F-306, and it passes
two of three tests. M-D, "drop the extras", fails all three while leaving the existing test
green, so it is a plausible fix rather than a strawman. TASK-006 ran five harness
self-mutations, each reddening exactly its intended test.

**The logger contract drift test paid for itself within a day of landing.** It went red
because the shipped logger moved ahead of the contract, which is F-249's exact shape,
caught mechanically instead of by an auditor two rounds later.

**Eleven negative controls ship in `apps/api/test/isolation/controls.ts`.** Every isolation
measurement an auditor made this week now runs on every CI run rather than once on the
afternoon someone thought of it.

**The Ship panel earned its dispatch.** Twenty-one findings after every per-TASK audit had
passed. The acceptance auditor filed two blockers no per-TASK lens could see: F-388, a README
describing what does not exist, and F-389, six obligations belonging to deferred work with no
carrier. The integrator filed F-392: no down-migration mechanism exists and no ADR accepts
its absence, mitigated today only by there being no production database, which is a
circumstance rather than an acceptance.

## Where it cost time

**TASK-004 spent six rework rounds and a cap exception on a control whose activator did not
exist.** F-156, F-161, F-171 and F-174 are all one control, and F-175 was authorised as a
cap exception to land it, on the assumption TASK-008 would activate it. TASK-008 then
disclosed that `apiClient` never reads `NEXT_PUBLIC_API_BASE_URL`: it is the authenticated
browser path and targets same-origin `/api/bff` relatively. The real consumer is TASK-012's
proxy, which left with EPIC-002. The control ships inactive at NOTICE.

**TASK-002 spent four rounds correcting one docblock.** The reviewer's diagnosis in F-211 is
the best any agent produced here: every sentence needing correction was an empirical claim
about a third party's behaviour, nothing in the repo could falsify it, the claims were
timing-dependent, and being wrong was consequence-free per instance. Three of round 4's four
documentation findings were created by round 3's corrections. The file carried roughly 190
lines of comment against 130 of code.

**TASK-003 absorbed every cross-cutting obligation nobody costed.** It added 4,817 lines.
AC-6's actual subject is 450 of them, 9%. The logging subsystem is 3,453, 72%. The product
auditor measured that about 91% is authorised by a finding, a ruling or a Global Constraint
and by no acceptance criterion. Nothing was smuggled. TASK-003 owns `main.ts`, so it became
the destination.

**The orchestrator caused six concurrency errors, two of them verbatim repeats of lessons it
had already written down.** `git add -A` swept a running agent's files into an unrelated
commit on 08-05 (F-083), again on 08-10 (ccaf918), and `git add .sdlc/` did it a third time
on 08-11. `git checkout --` on 08-11 reverted an uncommitted TASK-060 fix and needed a
re-dispatch to recover, because GC-11 forbids the main loop rebuilding it. Its own line:
"the ledger entry from yesterday did nothing to stop it, the fix is a habit, not a note."

**Six duplicate-key defects in the ledger.** Five in `findings.yaml` before the orchestrator
wrote `close_finding.py`, then a sixth in `state.yaml` an hour later, because the helper
covered only the file where the mistake had already happened.

**Two id collisions in one day.** Both from dispatching a reviewer and a security auditor
concurrently without giving either an id range. The second one arrived after the first had
been written up as a defect: "Writing a defect down is not the same as fixing it."

**Three collisions between a dispatch and an auditor's write permissions.** Two on 08-10
came from briefs that said "write to `.sdlc/`" and "do not write any file inside the
repository" in the same prompt. The third, on 08-11, is a genuine rule conflict: the
reviewer's operating rules are read-only and bar writing report files, and the dispatch said
the path was required. Every one of the three was handled correctly by the agent.

## Findings that should have been caught earlier, and by whom

| Finding | Caught at | Should have been caught at | Why it wasn't |
|---|---|---|---|
| F-001, F-002, F-003 (design blockers) | Design, security pass r1 | Design | No leakage. The pass fired in the right phase on its first use. |
| F-155 blocker: the AC-113 guard scans only `.next/static`, missing prerendered HTML and RSC payloads | Implement, TASK-004 r1 | Test. AC-113 was minted on 2026-08-05 and its text says "the built client bundle" | The AC was minted to close F-078 and nobody checked its wording against Next's output layout. Minting an AC is a design act with no design review. |
| F-183 blocker: the `gate` job has no `if:`, and GitHub counts a skipped check as satisfying a required one | Implement, TASK-002 r1 | Implement, one hour earlier | The orchestrator read a false claim in a code comment and turned it into branch protection. Invariant 9 covers whether an artifact exists, not whether a claim is true. |
| F-277 blocker: door seven, argument interpolation, a regression opened by the same day's ADR-0028 work | Implement, TASK-003 r6 | Design. ADR-0028 named F-260 and F-263 as its own preconditions | Nothing checked the preconditions at implementation. Same class as the four unenforced validity conditions below. |
| F-288 blocker: the design stub diverged from source and lost F-233's Origin block | Implement, TASK-008 r1 | Nowhere. There is no stub-versus-source gate for `apps/web` | The run named the absence four times and built the gate for one file, the logger drift test. |
| F-293, F-302, F-330 blockers: harness green while isolation broken | Implement, TASK-006 r1, r2, r3 | Nowhere honestly. AC-12 was ruled to need no tests-of-the-harness | That ruling was correct on its terms and left the harness with no adversary except the audit panel. The generative alternative is now on the roadmap. |
| F-388 blocker: README describes what does not exist | Ship acceptance | Implement, TASK-001, README's sole producer under GC-13 | GC-13 says README stays current. Nothing re-reads it after the TASK that wrote it closes. |
| F-389 blocker: six obligations belong to deferred work with no carrier | Ship acceptance | Plan, at the 2026-08-09 re-scope | The re-scope had no step for re-examining findings against the TASKs being deferred. The orchestrator names it: "That is a re-scope step nobody has written down." |
| F-392 major: no rollback posture, and no ADR accepting its absence | Ship integration | Design. ADR-0004 chose the migration tool and stated no rollback stance | `phases/design.md` does not require a rollback posture. `phases/ship.md` step 4 requires it stated. The requirement lives only in the phase that discovers it missing. |
| F-236 major: `PrivilegedTenantEraser.erase` erases nothing and reports success | Test, TASK-006 delivery | Design. F-002 fixed this class at the policy level in Design round 1 | The design fix was verified against the policy set and never against a statement issued under it. Still open on deferred TASK-054, and absent from `roadmap.md`. |
| F-399 major: a cost stated in a decision prompt without being measured | Ship, after the push failed | Ship, one command earlier | Nothing requires measuring a claim made inside a decision prompt. Every other claim in the run was measured. |

## Root causes

Five that mattered.

### 1. The ledger has readers and no writer, and it survived Ship

**Twenty-one findings at major or blocker are not in a terminal state at retro time.**
Eighteen read `status: routed` with `resolved_by: null` on TASKs that are `done`, and the
log narrates every one of them as verdicted ADDRESSED by the auditor that raised it.
**F-155 is a blocker** in that set, while `gates.implement.note` reads "No open blocker"
and Juano approved Ship on that basis. F-102 reads `status: escalated` while `escalations:`
is `[]`.

The orchestrator diagnosed the mechanism correctly on 2026-08-11 after ten lagging fields
in two days: "I write the narrative in the same breath as the decision, and updating the
field is a separate act that competes with dispatching the next agent." It framed the
remedy as discipline. The evidence says procedure. `findings.yaml` has four statuses that
can mean "done" (`fixed`, `parked`, `routed`, and `open` carrying a ruling), and the only
mechanical check ever run on it was whether it parses.

This is F-O from `~/.claude/juano-sdlc-findings.md`, dated 2026-08-10, with three
recommended fixes. None was applied. The same run then produced ten more instances in its
last two days plus this residue at Ship. F-O's own fix 3, a consistency check before every
gate summary, is the one that would have caught it, and it is worth more than the other two
together.

Evidence: F-155, F-102, F-116, F-122, F-137, F-154, F-156, F-157, F-161, F-167, F-171,
F-175, F-178, F-195, F-199, F-200, F-204, F-205 (all `routed`); F-236, F-239, F-386 (all
`open`); `state.yaml:44` and `state.yaml:66`.

### 2. The security auditor is not one of four. It is the panel.

149 solo findings of 399, 8 of 12 blockers alone and 9 counting joint filings, 52 of 132
majors. It found F-155 by building the thing rather than reading it, after two other
auditors had read it and cleared it. It found F-183 and the reviewer confirmed it
independently. It found all three TASK-006 blockers.

The reviewer is a real second lens and not a duplicate: 72 solo findings, 17 solo majors,
one solo blocker (F-288), and the four blind convergences all pair it with security. Its
distinctive output is the failed attack written down, F-203, where it tried to construct a
case where a discriminator swallows a real finding, could not, and recorded why.

The product auditor filed 19, which looks weak until you check what they were: AC-6's
deployed half never having been true through five audit rounds, AC-7 verdicted not met and
refused to soften, GC-13 corrected against the orchestrator, `test_files: []` on TASK-060
after four specs shipped, and both Ship blockers. It verifies against a small artifact, the
AC list, rather than a large one, the diff. Volume is the wrong instrument for it.

**`sdlc-design-auditor` filed zero findings across 399.** One dispatch, TASK-001, returned
APPROVED with nothing, and it deliberately declined the one thing it could have raised
because `not-found.tsx` was acknowledged placeholder scaffolding owned by a deferred TASK.
Four skips, each with counted evidence of zero `.tsx`, `.css` or `apps/web` paths in the
diff. The workflow log already recorded on 2026-08-09 that it has fired once across
everything.

**The honest answer: the panel is not calibrated, and only one of the four miscalibrations
is a prompt problem.** Security carries blockers because it is the only slot that builds
and attacks. Reviewer carries breadth. Product carries the initiative-level lens and only
earns a full dispatch at Ship. Design auditor is a stack mismatch, not a vague prompt:
shortkit has four UI files. Sharpening its prompt would manufacture findings on placeholder
scaffolding, which is the outcome its own judgement avoided on TASK-001.

### 3. Nineteen instances of an artifact assigning work to a TASK that cannot do it

ADR follow-up lists, Produces blocks, contract prose and acceptance criteria all name an
owning TASK, and nothing checks the name against that TASK's `paths` glob. Design's
`contracts:` injection propagated to all 57 TASKs. Nobody treated ADR follow-ups as a second
propagation source.

The class produced F-038, F-039, F-040, F-054, F-056, F-057, F-060, F-068, F-074, F-075,
F-077, F-084, F-102, F-117, F-118, F-153 and more. Instance twelve arrived through a new
door: an AC minted five hours earlier to close a different instance of the same class.
Instance seventeen was the orchestrator's own, written an hour after it logged instance
sixteen. Its note is the right one: every actor in this workflow, planner, architect,
implementers and orchestrator, makes the substitution unprompted, because the TASK that is
conceptually right for a piece of work is not always the TASK whose paths reach it.

It also reached the plan level. TASK-059 and TASK-060 were both minted mid-Ship to give an
orphaned obligation an owner. F-247 had no owner able to discharge it for a full day:
`tenancy/**` is TASK-005's and TASK-005 is done, TASK-003 owns the logging policy and not
the path, and the re-scope sweep re-routed it to TASK-003 anyway.

The fix that worked ran once, by hand, in one dispatch prose block. The TASK-004 scout brief
asked it to check every deliverable the card names against its own paths glob and report the
unreachable ones as a first-class section. TASK-004 became the only TASK in the initiative
that was not an instance of the class.

### 4. The orchestrator's self-corrections stayed prose and never became mechanisms

Six concurrency errors, six duplicate-key defects, two id collisions, two
dispatch-versus-permission collisions from defective briefs, two stale-ledger re-dispatches
of completed work. Every one was found, diagnosed well, and written into the log. Three
recurred anyway.

The orchestrator names the failure twice, about two different defects: "Writing a defect
down is not the same as fixing it, the fix is a line in the dispatch template" and "the fix
is a habit, not a note." It is right both times, and neither line became a template edit.

The most generalisable rule the run discovered sits in one entry and nowhere else:
**disjointness is about what an agent writes, including temporarily, not what it owns.**
Three of the six concurrency errors were agents on "provably disjoint paths" whose methods
wrote outside what they owned: a test architect whose mutation harness builds a drop-mutant
in `logger.ts`, two auditors sharing one Postgres, and a scout reading a tree another agent
was rewriting. The run also found the fix, used it once, and left it in prose: a read-only
agent working beside a writer reads through `git show <sha>:<path>` and reports the sha.

### 5. The fix-round cap counts rounds. It needs to measure recurrence.

Three cap adjudications in one initiative, each resolved by a Juano ruling that the cap did
not fit the case.

- TASK-004 hit 5/5 with F-175 real and load-bearing, and needed a written cap exception.
- TASK-003's ADR-0028 implementation had to be ruled **outside** the rework counter, because
  the cap exists to stop a loop that is not converging and a design decision is the escape
  from the loop rather than another turn of it.
- TASK-006's cap was **held** at 5 rather than pre-authorised, because round 4's findings
  were defects in the round-3 fix rather than a new class of leak, which is the first
  evidence the loop was converging.

The question was already asked on 2026-08-04 and never answered: "should the trigger be
worded as recurrence rather than round count?" The evidence now answers it. It should, and
the ladder also needs a third outcome that neither "fix again" nor "adjudicate" covers.
TASK-006 produced three blockers of one form, every fix measured and holding, and what kept
failing was the method: enumerating statement shapes a human thought of. Juano routed the
generative alternative to `roadmap.md`. That outcome, "the method has met its ceiling", is
not in the ladder.

## Rework hotspots

| TASK | Rounds | Converging or thrashing | Root cause |
|---|---|---|---|
| TASK-004 | 6 | Converging on the wrong target | Five rounds hardened one control, each round finding the defect inside the previous round's fix. The r4 auditor's diagnosis is the whole story: "each round fixed the INSTANCES it enumerated rather than the MECHANISM they were instances of." Round 4 deleted the source scan outright and took two open findings with it. Then TASK-008 disclosed the control has no activator. |
| TASK-006 | 5 | Converging, late | Three blockers, all "harness green while isolation broken", each in a direction nobody had attempted. Not thrash: every fix was proven both ways against a live mutation on a real database. The method was the ceiling, not the fixes. |
| TASK-002 | 4 | Thrashing on prose, converged on code | F-211 measures it: three of round 4's four documentation findings were created by round 3's corrections. The reviewer's summary is the one to keep, "the code converged and the prose did not." |
| TASK-003 | 4 + a design excursion | Converging, and under-scoped from the start | Four fix rounds on one leak class through seven doors, then ADR-0028 replaced the denylist with an allowlist and closed three at once and measured 2.6 microseconds cheaper per line. The rework is a symptom: TASK-003 owns `main.ts` and absorbed 72% of its diff as logging work no AC asked for. |
| TASK-008 | 3 | Converging cleanly | Each round's findings were narrower than the last. The spec was never edited to reach green in any of them. |
| TASK-001, TASK-007 | 2 each | Converging | Ordinary rework. Both closed well inside the cap. |

Thrash appears once, on TASK-002's docblock, and its cause is not an unactionable finding.
The file sat outside every tsconfig program, no test imported it, and its claims were
timing-dependent empirical statements about Node and pnpm under signals. Nothing in the repo
could falsify them, so corrections accumulated.

## Routing accuracy

No slot-level misroutes, and the run had no real test of routing. `config.yaml` maps
`apps/api/**` and `packages/**` to `sdlc-implementer-backend`, and the `**` fallback goes to
the same slot, so a backend finding cannot land wrong. The one exposure the run found and
recorded: `apps/api/src/observability/**` appeared in no TASK's `paths` for six days while
carrying TASK-003's largest deliverable, so roughly forty observability findings resolved
through the `**` fallback and hit the correct slot by luck. A project whose fallback were a
different slot would have mis-routed all of them.

The real routing failures were at TASK level, not slot level. See root cause 3.

## Design ROI

Positive, and measurable in both directions.

**Implementers respected the contracts.** Nine declined to edit a test to reach green.
Three stopped at a contract conflict rather than resolving it, which is the F-118 dispatch
instruction working. The architect corrected a finding's premise rather than following it
literally at least six times, including F-071, where the finding argued from `instanceof`
identity and zod 4's own `Symbol.hasInstance` made the premise false.

**Where design cost money was duplication, not vagueness.** One logger configuration living
in three artifacts produced F-244, F-248, F-249 and F-250 in sequence. The answer the run
converged on is the one-copy rule: delete the third copy rather than sync it, plus a drift
test comparing the contract's fenced block to the shipped literal. ADR-0020 needed nothing
after two more attempt-semantics changes, because a previous pass had struck its
restatements and made it point at the contract.

**The stub programme is the clearest ROI story, and it runs both ways.** Stubs are the only
reason wave-1 red tests could fail on `not implemented` rather than on module resolution,
which is what made greenfield TDD possible at all. Stubs also produced the F-288 blocker
directly, cost two hand-syncs in one day, and needed ADR-0039 to retire them. A stub is
load-bearing during Design and Test and becomes a liability the moment its producer ships.
ADR-0039 says the honest thing about its own fix: it "replaces a missing drift gate with a
missing retirement gate, still nothing runs."

## Four decisions whose validity conditions nothing enforces

The run named three. There are four.

1. **F-390** records how to de-gate the `compose` CI job if its first run is red, and the
   fallback is wired into nothing.
2. **ADR-0039** admits it replaces a missing drift gate with a missing retirement gate.
3. **F-395**: the rollback posture is revert-and-migrate-forward, and its additive-only
   precondition is checked by nobody.
4. **ADR-0041** gates "any other logger" at the dependency manifest and states that a wrong
   classification is invisible, offering `@nestjs/common` as proof that a reasonable person
   files a logging package under "the framework".

Each is correct today and silently stops being correct when a precondition changes.

## Superpowers delegation

**Diffs handed over as paths: held.** Every review package was built as a `.diff` file
under `.superpowers/sdd/` and passed as a path so the diff never entered orchestrator
context. Two packaging defects, both caught by auditors rather than by the orchestrator:
TASK-059's package spanned `c50593c..04ae31a` and swept in a different TASK's design commit
when the base should have been `04ae31a^`, and TASK-003's round-5 package used a pathspec
that silently dropped 6 of 24 files, including the one holding F-268's lint rule that was in
the auditor's brief. The mechanism held. Nothing checks the package's construction.

**The ledger did not survive compaction. Twice.** On 2026-08-06 the orchestrator resumed
106 commits stale and dispatched a test architect to write red tests for F-120, F-121 and
F-123, already fixed and verdicted ADDRESSED by all three auditors. The agent measured
21/21 integration green, found the exact test the dispatch said would be red already passing
at `tenant-context.int-spec.ts:290`, and refused. The orchestrator filed F-221 against
itself, citing `superpowers-map.md` naming re-dispatch of completed work as the most
expensive observed failure mode. On 2026-08-10 the round-5 re-audit was dispatched precisely
because the ledger could not answer whether TASK-003's findings were resolved. Both are the
same root cause as root cause 1: the resume path reads structured fields, and the structured
fields lag.

**Fix rounds 4 and 5 are not ceremony, and the rung is under-exercised.** The ladder fired
by its own trigger exactly once, in Design. Round 5 with a fresh architect on a stronger
model closed all five findings and ran `tsc --noEmit --strict` on stubs that four prior
rounds had called uncompilable. The orchestrator recorded the round-4 deviation as wrong in
hindsight: "The escalation to a fresh architect resolved in one round what four resumes had
not." Every other fresh dispatch (TASK-003 r3, TASK-005 fix r1, TASK-008 r2) was forced by a
dead session rather than by the trigger, and each was recorded as a deviation.

**`systematic-debugging` was never reached for.** Zero mentions across 1,207 entries and
roughly 39 fix rounds. `writing-good-tests` was cited four times by agents, correctly, and
`superpowers-map.md` three times by the orchestrator. This one is worth stating without
inventing a cost: the run's default was already measure-then-claim, and TASK-006's three
blockers were not unknown causes but unattempted attacks. No round was visibly burned
guessing.

**One reviewer was pre-judged, disclosed, and the call was defensible.** The TASK-004
product-auditor brief instructed it to verdict AC-7 not met and not to soften it, because
its rubric verifies AC-7 by hitting a deployed URL and the likely outcomes were hunting for
a deployment or marking it met because configuration existed. Everywhere else the
orchestrator did the opposite and said so in the dispatch: auditors told they are free to
disagree with an accepted dispute, told to be willing to reach the opposite conclusion, told
the orchestrator's own read and told explicitly not to take it.

## The three dispatch instructions worth keeping

These are the highest-value transferable artifacts of the run, they have measured effects,
and none has a home outside dispatch prose.

1. **Stop on contradiction.** "A finding that contradicts a contract, an ADR or the plan
   stops on that finding and is reported, not resolved." Written into an implementer brief
   on 2026-08-05 after F-118, where a previous implementer resolved an unsatisfiable ADR
   constraint by making a design decision under time pressure and cost a full architect
   round. The next round, the implementer hit exactly that case: it implemented F-123's
   timeout control, hit isolation-coverage clause A4 forbidding it, reverted, and recorded
   the conflict in the file header. The log: "That is exactly the behaviour the F-118
   instruction in its brief asked for, on the first round it was asked." At least eleven
   more instances followed.

2. **Per-finding ship judgement.** "For each finding you raise, state whether you would ship
   this TASK with it open." Used at TASK-004's cap and again at TASK-002 round 2. Measured
   twice as converting adjudication from the orchestrator's inference about someone else's
   severity into their stated decision, with answers that were not uniform.

3. **Ask for the ruling, not the required_change.** At a cap: "write the ruling you would
   put in findings.yaml." Produced F-210, F-211 and F-212 in the auditor's own words.
   Motivated by F-208, where a paraphrase lost the substance F-203 existed to preserve.

## F-399, and the class it belongs to

The orchestrator told Juano that branching retroactively would rewrite history published on
2026-08-06 that hundreds of findings cite by sha. `origin/main` was 248 commits behind and a
strict ancestor of local HEAD. Pushing a branch creates a new ref and moves nothing. The
destructive part, resetting `origin/main`, was in the orchestrator's own option text and
nothing required it. `git merge-base --is-ancestor origin/main HEAD` settles it in one
command and ran only after the push was rejected.

Its own reading is right and is the rule to keep: **a cost stated inside a decision prompt
is a load-bearing claim and gets measured like any other.** The run measured everything else
and reasoned about this one, and this one had a ruling resting on it.

## Proposed changes

Nothing below has been applied. Global proposals carry a high bar and are marked with the
cross-project evidence that clears it.

### Global — `~/.claude/skills/juano-sdlc/**` and `~/.claude/agents/sdlc-*.md`

| Target file | Change | Rationale and evidence |
|---|---|---|
| `references/routing.md` finding schema, plus `phases/implement.md` step 5 | Split the status vocabulary. Add `deferred-minor` and `parked` as first-class statuses carrying their ruling. Make `routed` mean "dispatched, outcome unknown" and forbid it as a terminal state on a `done` TASK. At the end of every fix round, write `status`, `resolved_by` and `resolved_round` for every finding the round addressed, in the same step that appends to `state.yaml`. | F-O's fixes 1 and 2, recommended 2026-08-10, not applied. This run shipped with 21 major-or-blocker findings not in a terminal state, including blocker F-155, while `gates.implement.note` read "No open blocker". |
| `references/state-machine.md` | Add a mechanical ledger consistency check before every gate summary: (a) no finding on a `done` TASK is `open`, `routed` or `escalated`; (b) `state.yaml`'s `escalations:` equals the set of findings with `status: escalated`; (c) every `major` or `blocker` finding whose `task` is deferred or null appears in `roadmap.md`; (d) every `.sdlc/**` YAML and every TASK front-matter parses, not only the ones edited this session. | The highest-value single change here. F-O's fix 3. Would have caught F-155, F-102, F-222 (TASK-009's front matter had never parsed and survived because validation ran only on edited cards), and the four obligations F-389's prose sweep missed. |
| `phases/implement.md` step 5 and the four `sdlc-*-auditor` definitions | Resolve the auditor write conflict, one way. Either grant each auditor `Write` scoped to `audits/<TASK>-<slot>-r<n>.md`, following the F-A precedent for `sdlc-scout`, or state in `implement.md` that auditors return the body and the orchestrator persists it. Today the phase file and the definitions disagree. | Three of four auditor slots ship read-only. First costed 2026-08-04, twice more on TASK-005, and by 2026-08-06 every brief opened with a workaround. Three dispatch collisions followed. Two initiatives, at least five wasted agent turns. |
| `phases/implement.md` and `phases/design.md` dispatch templates | Add the three instructions above: stop-on-contradiction, per-finding ship judgement, and ask-for-the-ruling at a cap. | Each has a measured effect and lives only in dispatch prose. Stop-on-contradiction produced twelve remedy rejections on measurement, the most valuable agent behaviour in the run. |
| `SKILL.md`, the concurrency invariant | Replace "disjoint paths" with "disjoint **write surfaces**, including temporary ones". Add: a read-only agent working beside a writer reads through `git show <sha>:<path>` and reports the sha. Add a template line requiring an explicit finding-id range per concurrent auditor. | Six orchestrator concurrency errors, three from "provably disjoint" agents whose methods wrote outside what they owned. Two id collisions in one day, the second after the first was written up. |
| `phases/implement.md` fix-round ladder | Reword the escalation trigger as **recurrence**, not round count. Add a third cap outcome beside fix-again and adjudicate: "the method has met its ceiling", which routes to `roadmap.md` rather than to another round. | Asked as an open question 2026-08-04, never answered. Three cap adjudications in this initiative each needed a Juano ruling that the cap did not fit: TASK-004's exception, TASK-003's out-of-counter ruling, TASK-006's held cap. |
| `phases/design.md` step 5 and the `sdlc-scout` brief | Require a reachability check. At the end of Design, every TASK id named in an ADR follow-up, a Produces block or a contract must resolve to a TASK whose `paths` reach the named file. In the scout brief, check every deliverable the card names against its own paths glob and report the unreachable ones as a first-class section. | Nineteen instances of the class in one initiative, including one the orchestrator produced an hour after logging the previous one. The scout check ran once by hand and made TASK-004 the only TASK that was not an instance. |
| `phases/plan.md` step 7 | Add a deferral sweep to the split procedure. Re-examine every finding whose `task` is being deferred, **including those marked `fixed`**, and every obligation those TASKs carried for surviving work. Carry survivors onto `roadmap.md` before the gate. | F-288 and F-296 were both found by accident a day apart by auditors looking at something else. F-247 was ownerless for a day. The hand-run sweep found 11 `fixed` findings on deferred owners. Four major-or-blocker findings still have no roadmap carrier. |
| `references/config.md` git section, plus `phases/ship.md` | Give the commit convention a finding-id slot beside the TASK-id slot. State the initiative-branch requirement at the **first TASK dispatch**, not at Ship. | GC-10 has no form for a fix belonging to a finding, so Ship-gate fixes improvised `[F-399]` and read as orphans. `ship.md` rule 51 fired at Ship after all 248 commits had landed on `main`, and GC-10's `feat/` prefix went unmet for the whole initiative. |
| `references/artifacts.md` | Add `deferred` to the artifact status enum and say which of `cancelled` and `deferred` a step-7 split uses. | Already filed as F-M on 2026-08-09, still open. Used on 72 cards here. |
| `SKILL.md` invariant 3 | Carve out rename and move fallout: the orchestrator may update a path reference it broke, in any file, provided the edit changes no behaviour and is recorded in `state.yaml`. | Already filed as F-N on 2026-08-09, still open. It fired here when the initiative rename broke a hardcoded path in a test-architect-owned drift spec. |
| `phases/design.md` | Require every ADR to name the enforcer of its validity conditions, or record that nothing enforces them. | Four instances here: F-390, ADR-0039, F-395, ADR-0041. **Weakest of the global proposals**: the evidence is single-initiative. Consider it project-scoped until a second initiative repeats it. |

### Project — `.sdlc/config.yaml` or a local agent override

| Target file | Change | Rationale and evidence |
|---|---|---|
| `.sdlc/config.yaml` auditors block | Drop `sdlc-design-auditor` from the default panel. Dispatch it only when a diff touches a rendered surface. Revisit when roadmap item 3 (white-label branding) or item 5 (public marketing surface) opens. | Zero findings across 399. One dispatch, APPROVED with nothing. Four evidenced skips. The workflow log already recorded on 2026-08-09 that it has fired once across everything. This is stack fit, not prompt quality: shortkit has four UI files, and sharpening the prompt would manufacture findings on placeholder scaffolding. |
| `.sdlc/config.yaml` `ownership:` | Add explicit entries for `apps/api/src/observability/**` and `.sdlc/**`, and record in a comment that the `**` fallback is a safety net rather than a router. | `apps/api/src/observability/**` sat in no TASK's `paths` for six days while holding TASK-003's largest deliverable. About forty findings hit the right slot through the fallback by luck. |
| `.sdlc/config.yaml` `testing:` | Set `coverage_gate`, or replace the 2026-08-04 comment with a current reason for leaving it null. | The recorded reason, "no coverage tooling installed and no threshold chosen", is stale after 189 unit and 62 integration tests. |
| `.sdlc/config.yaml`, plus a follow-up on ADR-0039 | Add a stub-versus-source gate for `apps/web`, or record the residual explicitly. The logger contract drift test is the working pattern. | Named as absent four times: F-288 (a blocker), TASK-008's red typecheck standing where the gate should be, and two hand-syncs in one day. ADR-0039 admits it leaves the gap. |

### Codebase — follow-up STORY or `CLAUDE.md`

| Target | Change | Rationale and evidence |
|---|---|---|
| `.sdlc/foundation/findings.yaml` | Close the 21-finding residue before roadmap item 1 opens. Eighteen are bookkeeping: verdicted ADDRESSED in the log, statuses never written. Four are real carried obligations. | Blocker F-155 reads `routed` while the Ship gate note says no open blocker. F-102 reads `escalated` while `escalations:` is `[]`. |
| `.sdlc/roadmap.md`, carried-forward block | Add F-102, F-157, F-236 and F-239. | F-389 exists to prevent exactly this and its sweep was prose-driven. **F-236 is the one that matters**: `PrivilegedTenantEraser.erase` erases nothing and reports success, which is F-002's class at the statement level, sitting open on deferred TASK-054 and unreferenced by the roadmap. F-157's remedy was ruled into TASK-012, deferred. |
| `CLAUDE.md` | No change proposed. | The repo, git history and the existing `CLAUDE.md` already carry the conventions this run relied on. |

## Memory writes

Proposed, not written. Durable and not recorded by the repo, git history or `CLAUDE.md`.

- **Juano clears an unsatisfiable criterion by changing the criterion, and requires the
  record to say so.** AC-6 kept its id and lost its Fly clause under Amendment A-8, and the
  ledger states "the escalation is cleared by changing the criterion, not by satisfying it."
  Same move on AC-113 under F-154 and on AC-115.
- **He prefers one rule to two exceptions.** F-385: "one reader should learn one rule rather
  than two exceptions." Same reasoning on F-250 (delete the third copy, do not sync it) and
  F-380 (word the precondition against the property, not against the proxy).
- **He holds a cap rather than pre-authorising an exception, and rules the classification
  instead.** TASK-006's cap held at 5 because the loop was converging and pre-approving an
  exception would remove the forcing function. TASK-003's ADR-0028 work was ruled outside
  the counter because a design decision is the escape from a loop.
- **He accepts an incomplete verification when the limit is named, and rejects a
  complete-sounding one that is not.** The strongest pattern across the whole run and the
  least obvious.
- **An escalation restated in prose is not an open prompt.** The existing memory note covers
  omission. The new failure mode is burial: F-320 was reported open in prose across roughly
  fifteen turns and never re-prompted. An item stays his until he rules, so it goes back into
  an `AskUserQuestion` every message it is still open.
- **Constraint:** `main` on `github.com/juano-morello/shortkit` is protected with
  `enforce_admins: true`, strict mode, and one required check, `gate`. A direct push is
  rejected. Work reaches main through a branch and a PR.
