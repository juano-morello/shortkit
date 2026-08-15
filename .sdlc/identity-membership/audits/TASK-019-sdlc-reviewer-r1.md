# TASK-019 — sdlc-reviewer, round 1

Package: `.superpowers/sdd/plan/review-bff90b6..052834e.diff` (one commit, `052834e`, 8 files,
173 insertions / 51 deletions).
Reviewed against `TASK-019.md`, `adr-0051-better-auth-secret-is-a-declared-binding.md` (as
amended twice, the second reversing the first), the implementer's report, and GC-B / GC-J.

Verdict: **changes-requested**. No blocker. Two major, four minor, one nit. The substance of the
card — the `:?` line, the harness's generate-and-export, the contaminant guard left alone — is
correct. Every finding is in the documentation half, which is where three of this card's four
files live and where its `docs.required: [README]` obligation bites.

```yaml
verdict: changes-requested
findings:
  - severity: major
    kind: behavior
    file: README.md
    line: 99
    summary: >-
      The README offers a project-root `.env` as the persistent way to supply
      BETTER_AUTH_SECRET and never says that a root `.env` makes `pnpm test:compose` refuse to
      run, which TASK-019 and ADR-0051 both require it to say.
    failure_scenario: >-
      A developer reads README:99-100 ("set it in a project-root `.env` instead (see
      `.env.example`) if you want it to persist"), writes `BETTER_AUTH_SECRET=...` into
      `/.env`, and `docker compose up` works. Later they run `pnpm test:compose`, which
      README:62 lists in the Commands table and which CI's `compose` job runs on every push.
      `scripts/check-compose-stack.sh:193-198` fires: "cannot run the AC-115 check: there is a
      .env at the repository root ... Move it aside for the duration of this check." Exit 2,
      nothing measured. Neither README:99-100 nor `.env.example:14-17` mentions this;
      `.env.example:15-17` points the other way, saying the script "generates and exports its
      own value for the duration of its own run, so AC-115 as measured by that script needs
      nothing from you" - true only while no `.env` exists. TASK-019.md:80-81 states the
      requirement verbatim ("a root `.env` makes `pnpm test:compose` refuse until it is moved
      aside, and that cost is stated rather than hidden") and ADR-0051:531-533 repeats it
      ("`.env` is the persistent alternative and the README says what it costs").
    required_change: >-
      Wherever a project-root `.env` is offered - README's export section and
      `.env.example`'s "or set it below and copy this file to `.env`" - the reader learns
      before they act that a root `.env` makes `pnpm test:compose` exit 2 until it is moved
      aside, and `.env.example`'s claim that the harness "needs nothing from you" is scoped
      to the no-`.env` case.

  - severity: major
    kind: behavior
    file: README.md
    line: 94
    summary: >-
      The documented generation command requires `node` on the host, the section's premise
      sentence dropped "nothing else installed" without naming the replacement dependency, and
      a missing `node` sets the variable to the empty string instead of failing.
    failure_scenario: >-
      README:90 now reads "With Docker, this clone, and one exported variable" - the previous
      text was "With Docker and this clone, and nothing else installed", and the machine the
      whole section is about is AC-115's, "a machine with only Docker and a clone of this
      repository" (STORY-002:19, as narrowed today). On such a machine, pasting README:94
      prints `node: command not found` to stderr, but `export VAR="$(...)"` exits 0 and binds
      the EMPTY STRING. The next line, README:95 `docker compose up`, then fails with
      `required variable BETTER_AUTH_SECRET is missing a value: generate at least 32
      characters and export it, ...` - which is the error README:98 says appears "Without it",
      after the reader did exactly what the README told them to. The remedy the message prints
      is the command that just silently failed. `check-compose-stack.sh:167-170` refuses
      loudly for precisely this case ("node is not on PATH"); the README's own sequence has no
      equivalent and cannot fail closed, because a failed command substitution in an
      interactive shell is not an error.
    required_change: >-
      The section's premise names every dependency its own commands have - so either it states
      that `node` is required for the generation step, or it gives a form that needs only
      Docker (a `docker run --rm` one-liner, or `openssl rand -base64 32` with the same
      caveat), or the command is written so a missing generator fails visibly rather than
      exporting an empty value that Compose then rejects for the wrong stated reason.

  - severity: minor
    kind: behavior
    file: .env.example
    line: 19
    summary: >-
      `.env.example` says "ONE VARIABLE IS NOT BELOW AND HAS NO DEFAULT" and then puts that
      variable below, under a sentence asserting that every variable below has a default.
    failure_scenario: >-
      Line 6-7 asserts "Every variable below has a default in the compose file, so `docker
      compose up` on a fresh clone needs none of them." Line 9 asserts "ONE VARIABLE IS NOT
      BELOW AND HAS NO DEFAULT: BETTER_AUTH_SECRET". Line 19 is `# BETTER_AUTH_SECRET=`, below
      both. The file's other two commented placeholders - `# GIT_COMMIT_SHA=` at :62 and
      `# COMPOSE_PROJECT_NAME=` at :70 - genuinely do have defaults, so the shape at :19 is
      the shape of an optional override. A reader who skims :6-7, copies the file to `.env`
      and leaves :19 commented like the other two gets a parse-time failure on `docker compose
      up` from a file they just configured, having read a sentence saying they did not need
      to.
    required_change: >-
      The "every variable below" claim at :6-7 is scoped so it excludes the placeholder at
      :19, and :9's "IS NOT BELOW" stops contradicting the line that follows it - either by
      moving the placeholder above :6, or by rewording both so the reader can hold one story.

  - severity: minor
    kind: implementation
    file: scripts/check-compose-stack.sh
    line: 286
    summary: >-
      The new comment cites `docker-compose.yml:297` for the `:?` reference; it is at :289.
      The implementer's report says :292. Three numbers, none of them right except the file.
    failure_scenario: >-
      Not a runtime failure. `docker-compose.yml:297` is inside the `healthcheck` block's
      comment (:293-301), which is about `$$` escaping and has nothing to do with the secret.
      A maintainer following this pointer to check the claim "carries no default for
      BETTER_AUTH_SECRET any more" lands on the wrong block, and this repository leans on
      file:line pointers everywhere - `refuse` messages, `check-compose-stack.sh:180-189`,
      ADR-0051's own edit list. 297 is ADR-0051:527's number, written before the banner
      rewrite shortened the block; the implementer copied it forward.
    required_change: >-
      The pointer resolves to the `${BETTER_AUTH_SECRET:?...}` line, or carries no line number
      at all.

  - severity: minor
    kind: behavior
    file: docs/architecture/migrations.md
    line: 45
    summary: >-
      A fourth file quotes the pre-change premise. ADR-0051:264-267 enumerated three
      (`check-compose-stack.sh:4-9`, `.env.example:6-7`, `README.md:90`); this one was missed,
      and it documents `docker compose down -v` as the only repair for a class of failure.
    failure_scenario: >-
      `:45` says the development stack "applies its own migrations as part of `docker compose
      up` and needs none of the three exported" - about the three DATABASE_* variables, but it
      is the only statement in the file about what the dev stack needs exported, and it now
      reads as "nothing". `:89` prescribes, for an edited migration that was already applied,
      "development stack: `docker compose down -v`, then `docker compose up`", and `:200`
      repeats "`docker compose down -v` is then the only repair". A developer in a fresh shell
      who hits the timestamp trap follows :89, runs `docker compose down -v`, gets the parse
      error naming BETTER_AUTH_SECRET, and the volume is NOT destroyed - so the documented
      only repair silently does not happen. ADR-0051:441-445 records that `:?` breaks `down`,
      `ps`, `logs` and `config` as an accepted cost, but accepting the cost is not the same as
      leaving a repair procedure that no longer runs.
    required_change: >-
      The dev-stack rows in this file state that the variable is required for every compose
      subcommand, not only `up`, so the `down -v` repair procedure is executable as written.
      The file is outside TASK-019's `paths`; routing is the orchestrator's.

  - severity: nit
    kind: behavior
    file: README.md
    line: 167
    summary: >-
      The reset table and the build-provenance block document six compose subcommands that all
      now need the variable, and only the "Running the whole stack" section says so, only for
      `up`.
    failure_scenario: >-
      `:146-147` labels bare `docker compose up` "AC-115's command", which is no longer the
      whole command AC-115 describes. `:167-172` tabulates `restart`, `stop`/`start`, `down`
      and `down -v`; in a shell without the variable each is a parse error rather than the
      documented effect. ADR-0051:441-445 prices this deliberately and says the second failure
      "still reads as the tool being broken rather than as the same missing variable", so this
      is worth one sentence near the table, not a rework round. Filed as a nit so it is on the
      record rather than rediscovered.
    required_change: >-
      One sentence, at the reader's discretion, noting that every `docker compose` subcommand
      in this file parses the same file and needs the same export.

  - severity: minor
    kind: contract
    file: apps/api/test/tenancy/auth-role-provisioning.int-spec.ts
    line: 130
    summary: >-
      The TASK-019 commit modifies a file outside TASK-019's declared `paths`, and the only
      report supplied with the package states that this file was not modified.
    failure_scenario: >-
      `TASK-019.md:9` declares `paths: ["docker-compose.yml",
      "scripts/check-compose-stack.sh", ".env.example", "README.md"]`. Commit 052834e
      ("[TASK-019]") also changes `auth-role-provisioning.int-spec.ts` (+22). The implementer's
      report at :163-164 says of that exact file "Not modified - test file, and not
      TASK-019's", and at :139-147 explains why it refused to touch it. Per F-147's
      `resolved_by`, the edit was made by another slot after that report was written, so the
      report is stale rather than false - but nothing in the package says so, and 22 of 173
      lines arrive with no report covering them. A later reader reconciling the card's write
      surface against the commit finds a file that the card does not claim and the report
      disclaims.
      THE CODE ITSELF IS CORRECT and I found no defect in it: the override is scoped to the
      one `execFileSync` (`process.env` is never mutated, so no other spec in the run sees
      it), the spread is first so the literal wins over a developer's real export, `PATH` /
      `HOME` / `DOCKER_HOST` are inherited so `docker` still runs, and the docblock at
      :130-142 states what deleting the constant costs ("makes these tests fail wherever the
      variable is unset, which is how CI runs the integration job"), which is what makes it
      survive a reader who thinks it is cruft.
    required_change: >-
      Either TASK-019's `paths` records the int-spec edit, or the round's report does. What
      must be true afterwards: the write surface on record matches the commit, so no file in
      the package is unaccounted for.
```

## Cannot verify from diff

- **STORY-002's AC-115 amendment (F-145).** `.sdlc/foundation/stories/STORY-002.md` is not in
  this package. Read on disk: `:19` carries the narrowed text and `:169` records "Text amended
  2026-08-14 by `identity-membership` (F-145)". `check-compose-stack.sh:7-11` matches it in
  substance. Whether that amendment is recorded "from both sides" as TASK-019.md:49 claims, and
  whether `foundation`'s own ledger agrees, spans initiatives and is the orchestrator's.
- **`.github/workflows/ci.yml`'s `integration` job.** Not in the diff. Read on disk: its `env:`
  block (:193-206) sets only `DATABASE_URL`, `DATABASE_MIGRATION_URL` and `DATABASE_AUTH_URL`,
  so the spec-level constant is the only thing that makes that job pass after this change. That
  the whole suite is green in that shape is the implementer's evidence (82/82 with the variable
  unset and no root `.env`) and I did not re-run it, per dispatch.
- **ADR-0051's conditional retirement of the second rejected constant.** Verified the literal
  `development-compose-better-auth-secret-not-a-real-value` is gone from
  `docker-compose.yml`. Whether TASK-003's implementer applies the condition in wave 2 is future
  and cross-TASK.
- **`check-ledger.mjs` could not be run.** It is not in this repository (`scripts/` holds only
  `check-compose-stack.sh`) and I did not find it under `~/.claude/scripts/`. The
  `findings.yaml` and `state.yaml` changes in this package - F-108 moved `escalated` to `fixed`,
  `escalations:` emptied, F-147/F-148 added - are therefore unchecked by the tool the workflow
  expects before a gate summary. I read them by hand and found nothing inconsistent (see Notes).

## Notes

- **The three ADR-0051 mechanical rules on the `:?` line all hold**, checked by extracting the
  message programmatically rather than by eye: no `$`, no backtick, no `{`, no `}`, and no
  apostrophe that would break the single-quoted YAML scalar; the scalar is single-quoted; the
  message does not repeat the variable name. The colon form `:?` rejects empty as well as unset,
  which is the right choice given `.env.example:19`'s `BETTER_AUTH_SECRET=` placeholder path.
- **The stale sentence at `docker-compose.yml:239-240` is repaired and the replacement is
  accurate.** It now says BETTER_AUTH_SECRET is "the same shape of binding: no fallback here
  either", which is true of the line at :289.
- **Comments containing `${...}` are safe.** `:280` writes `${VAR:?...}` inside a comment;
  Compose interpolates the parsed YAML tree, not the raw text, and `:234` has carried
  `${SHORTKIT_AUTH_PASSWORD:-auth}` in a comment since before this change.
- **All four orderings ADR-0051 requires of the export hold.** It lands at `:295-300`: after the
  `node` precondition (:167-170), after the contaminant guard (:182-191), after the `.env`
  refusal (:193-198), before `trap cleanup EXIT` (:316), and before the first command that
  parses the file (:366). The contaminant guard and the `.env` refusal are byte-identical to
  before. `BETTER_AUTH_SECRET` was not added to `NOISY_NAMES` (:237) either, which is right -
  the `*SECRET*` branch at :249 fails closed and would have refused the run.
- **One value for the whole run, and it overrides.** A single unconditional assignment, exported
  once, never reassigned; the only `unset` in the file is `COMPOSE_FILE`. DOD-1's second `up`
  (:728) and DOD-3's `restart` (:762) read the same value, which is the `Failed to decrypt
  private key` property. Unconditional assignment is also the override, matching the
  `APP_PASSWORD='app'` idiom at :325-329.
- **The generation step's error handling is correct under `set -euo pipefail`.** An assignment's
  exit status is the command substitution's, `|| refuse` suppresses `set -e`, and the empty-result
  case is caught separately at :299. Both call `refuse`, which is exit 2 - "nothing was measured"
  - which is the right code for a precondition. `refuse` with a single argument is the file's
  existing pattern (:154, :158, :392), so the one-argument call at :299 is not new risk.
- **`composeInitScript` is the only site outside the harness that parses `docker-compose.yml`**,
  grepped repository-wide excluding `.sdlc/` and `node_modules`. The other `docker compose`
  strings in test files are message text naming `docker-compose.test.yml`, which has no `api`
  service and no `:?` reference, so nothing else inherits the requirement.
- **Ledger:** F-108 carries `round: 1` with `resolved_round: 0`, which reads backwards until you
  find F-081 (`round: 3`, `resolved_round: 0`) and F-083 with the same shape. Treating it as this
  ledger's convention for "closed by ruling rather than by a fix round" and not filing it. Worth
  a word if that is not the convention.
- **A second BETTER_AUTH_SECRET-shaped literal entered the tree in the commit that removed one.**
  `COMPOSE_RENDER_ONLY_BETTER_AUTH_SECRET` is 50 characters and is not better-auth's published
  constant, so it would pass all three of TASK-003's rejections if someone copied it into a real
  `.env`. Not filed - it never reaches `betterAuth()`, its docblock says "It is not a secret",
  and no path leads from it to a failure. Recorded only because ADR-0051:393-395 states "The one
  committed secret left is `apps/api/test/support/auth-fixture.ts:85`", and a reader counting
  strings in the tree will now find two.
- **GC-B:** clean. The change deletes the only NODE_ENV reasoning in the block and adds no
  environment-keyed behaviour; the harness generates unconditionally. **GC-J:** the commit
  carries no AI attribution trailer.
