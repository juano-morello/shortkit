# TASK-019 — security audit, round 1

Scope: `.superpowers/sdd/plan/review-bff90b6..052834e.diff` (`052834e`, "compose stops carrying a
signing key"). Design context: ADR-0051 as amended twice — the current decision is the F-144 text,
not the struck F-074 text.

```yaml
verdict: changes-requested
findings:
  - id: F-149
    severity: minor
    kind: security
    file: apps/api/test/tenancy/auth-role-provisioning.int-spec.ts
    line: 143
    summary: >-
      The diff deletes one committed BETTER_AUTH_SECRET literal and adds another. The new one is 51
      characters (measured), so it clears every rejection ADR-0051's wave-2 predicate applies.
    failure_scenario: >-
      Not exploitable today: nothing calls betterAuth() in apps/api/src (grepped), so no process
      reads this variable at runtime yet, and this constant is only handed to one execFileSync as an
      env override for `docker compose config` -- process.env is untouched and nothing reads the
      value back. The reachable path is the developer one F-056 named. From wave 1, `docker compose
      up` fails at parse until the developer supplies a value; the obvious way to find one is to
      grep the tree for BETTER_AUTH_SECRET, which now returns two committed literals that work:
      auth-fixture.ts:86 (53 chars) and this one (51 chars). Exported, either becomes that
      developer's dev signing key from wave 2, and it is a value everyone with a clone already has
      -- the exact property that made F-020 a blocker and the property this card exists to remove.
      ADR-0051 records auth-fixture.ts:86 explicitly and accepts it; nothing records this one, and
      the ADR's own accepted cost says the by-value check is "a floor against known-published
      values". This diff adds a published value that sits above the floor.
    required_change: >-
      Make the literal shorter than 32 characters. Compose's `:?` is satisfied by any non-empty
      string -- verified: `BETTER_AUTH_SECRET=x docker compose config -q` exits 0 -- so the render
      keeps working, and the value then fails betterAuthSecret()'s length rule by construction if
      anyone ever copies it. If the length is kept, ADR-0051 records it beside auth-fixture.ts:86
      as a second knowingly-accepted committed value.

  - id: F-150
    severity: minor
    kind: security
    file: docker-compose.yml
    line: 289
    summary: >-
      `docker compose config` and `docker inspect` now render a live signing key where they
      previously rendered a committed constant, and the file's own guidance still says everything
      those two printers show is a fixture.
    failure_scenario: >-
      Measured: `BETTER_AUTH_SECRET=<canary> docker compose config` prints the resolved value
      verbatim at `services.api.environment.BETTER_AUTH_SECRET`, once, in cleartext (it is not a
      build arg -- checked). It also survives into the api container's environment for its
      lifetime, readable by `docker inspect` and `/proc/1/environ`. Before this diff every value
      those printers showed was committed, and `docker-compose.yml:94-96` states that norm in the
      file -- "`docker inspect` and /proc/1/environ hold them for the container's lifetime.
      Fixtures, so that is fine; an override is a disclosure and this stack has no secret
      mechanism" -- as does `:177`. BETTER_AUTH_SECRET is now permanently an override, so by the
      file's own rule it is permanently a disclosure, and the new banner at `:274-288` does not say
      so. The attacker is a reader of a public artifact: this repository is public (`.env.example:21-22`)
      and its stated convention (F-379) is pasting tool output verbatim into committed reports. A
      developer who pastes `docker compose config` or `docker inspect api` output into an issue,
      a report or a scrollback shared for help discloses their JWT signing key, which from wave 2
      forges any `tid` claim on their stack.
    required_change: >-
      One line in the `:274-288` banner saying that `docker compose config` and `docker inspect`
      print the resolved value, so it is not output to paste anywhere -- the counterpart to the
      sentence `:94-96` already carries for the fixture passwords. The harness's own no-print rule
      (F-379) is intact and needs no change; this is the surface outside the harness.

  - id: F-151
    severity: minor
    kind: security
    file: scripts/check-compose-stack.sh
    line: 299
    summary: >-
      The harness asserts the generated secret is non-empty and nothing else. The 32-character
      floor ADR-0051 requires of every value of this variable is not checked on the one value this
      repository generates.
    failure_scenario: >-
      No attacker; this is defense-in-depth on a credential-generation path. The generator is
      correct today -- verified: `crypto.randomBytes(32).toString('base64url')` is a CSPRNG, 43
      characters over `[A-Za-z0-9_-]`, never empty, nothing to escape in YAML, a shell or a DSN.
      What is unguarded is its future: a well-meaning edit to `randomBytes(32)` (a smaller count, a
      `slice`, a different encoding) produces a short value that Compose's `:?` accepts, because
      `:?` is a presence check. From wave 2 the api container then exits on
      assertBetterAuthSecretConfigured(), and the harness reports `AC-115.3 FAIL service 'api' is
      'unhealthy'` -- naming the service, not the harness's own value, which is the one thing the
      run controls. The author already guarded the empty case at `:299`, so the class was
      considered; the floor the ADR names was not.
    required_change: >-
      Add the floor beside the existing emptiness check, e.g. `[ "${#BETTER_AUTH_SECRET}" -ge 32 ]
      || refuse 'the generated BETTER_AUTH_SECRET is shorter than the 32 characters ADR-0051
      requires.'`. Name only, no value (F-379).

  - id: F-152
    severity: minor
    kind: docs
    file: README.md
    line: 99
    summary: >-
      Both developer-facing routes offer a project-root `.env` as the persistent alternative, and
      neither states its cost. ADR-0051's follow-up requires that the README does.
    failure_scenario: >-
      `docker-compose.yml:289`'s parse-time message says "or put it in .env at the repository
      root", README:99-100 says "set it in a project-root `.env` instead ... if you want it to
      persist", and `.env.example:14` says "or set it below and copy this file to `.env`". None
      says that `scripts/check-compose-stack.sh:193-198` refuses to run at all when that file
      exists. A developer who takes the persistent option -- the one the error message itself
      offers first-hand -- gets `pnpm test:compose` exiting 2, "cannot run the AC-115 check",
      thereafter. Exit 2 means nothing was measured, and the thing that stops being measured
      locally is the harness carrying GUARD-1/GUARD-2, the only check for the F-315/F-316
      passwordless-roles defect. CI is unaffected (no `.env` on a runner), so this degrades local
      measurement rather than the gate. Secondary: the persistent option leaves a live signing key
      in a plaintext file in the working tree indefinitely. Verified gitignored -- `git check-ignore
      -v .env` resolves to `.gitignore:45 .env*` -- so there is no commit path, and `.env.example:21-22`
      already warns about what lands there.
      ADR-0051 states the requirement in as many words: "**The README's documented step exports the
      variable rather than writing `.env`**: a root `.env` makes `pnpm test:compose` refuse until it
      is moved aside (`:191-196`). `.env` is the persistent alternative and the README says what it
      costs." The README does not say what it costs.
    required_change: >-
      One clause at README:99-100 and at `.env.example:14`: a root `.env` makes `pnpm test:compose`
      refuse until it is moved aside. The compose message at `:289` cannot carry it (no room, and
      the mechanical constraints stand), which is why the two documents have to.

  - id: F-153
    severity: nit
    kind: security
    file: scripts/check-compose-stack.sh
    line: 366
    summary: >-
      `$TMPDIR_CHECK/config.json` holds the run's live secret. Measured and bounded; recorded so it
      is not re-derived.
    failure_scenario: >-
      ADR-0051 prices this ("a `SIGKILL` leaves it behind"). Measured: `mktemp -d` yields mode 0700,
      so the leftover is readable only by the same uid and root -- both of which can already read
      the harness's `/proc/<pid>/environ`. `cleanup` removes the directory on every EXIT path
      including `SHORTKIT_CHECK_KEEP_STACK=1`. The abandoned value corresponds to a stack whose
      volume `:436`'s `down -v --rmi local` destroys on the next run. No attacker gains anything
      they did not already have.
    required_change: >-
      None. Informational; drop it rather than carry it as an open item.

  - id: F-154
    severity: nit
    kind: behavior
    file: scripts/check-compose-stack.sh
    line: 309
    summary: >-
      Candidate sixth failure mode. `SHORTKIT_CHECK_KEEP_STACK=1` leaves a running stack whose
      generated secret died with the script, so every follow-up compose subcommand fails at parse.
    failure_scenario: >-
      The knob is documented at `:68` as "leave the stack up after the run". After it, the value
      exists nowhere: never written, never printed, the process gone. `docker compose ps`, `logs`,
      `down` and `config` against the kept stack all fail on the required variable, and the
      developer using the knob is by definition mid-investigation. Any value clears it, so the
      repair is one export -- but from wave 2 an export of a *different* value plus `docker compose
      up` against the kept volume meets `Failed to decrypt private key`, which is precisely the
      failure ADR-0051's property 3 exists to prevent, arriving across runs rather than within one.
      ADR-0051 states the general form ("`:?` breaks every compose subcommand, not just `up`") but
      not this instance, and this instance is the harness's own knob. Not a security finding: no
      attacker, no disclosure, no lost control.
    required_change: >-
      A sentence at the `:68` knob description, or in `cleanup`'s "tearing down" branch, saying the
      kept stack needs BETTER_AUTH_SECRET exported for any further compose subcommand and that a
      different value plus `up` will not decrypt the existing jwks rows. Nothing in code.
```

## Notes

**What the card gets right, verified by execution rather than read.**

- The committed literal is gone from the working tree. `grep -rn
  'development-compose-better-auth-secret-not-a-real-value'` outside `.git` returns only `.sdlc/**`
  prose (ADR-0051, TASK-003's card, three TASK-018 audit reports). Nothing under
  `docker-compose.yml`, no code, no `.env*`. **ADR-0051's condition for retiring its second rejected
  constant is met**, and TASK-003's implementer can apply the ADR's three-rejection form.
- The generated value is strong. `crypto.randomBytes(32).toString('base64url')` — CSPRNG, 43
  characters over `[A-Za-z0-9_-]` (sampled), never empty, no character that YAML, the shell,
  Compose's interpolation lexer or a DSN would have to escape. Failure of `node -e` is caught by
  `|| refuse` and emptiness by `:299`. The developer-facing command in README:94 and
  `.env.example:12` is byte-identical in shape, so the two paths generate the same thing.
- Ordering is correct. Export at `:300`, `trap cleanup EXIT` at `:316`, first file-reading compose
  call at `:366`. Nothing between `:154` and `:300` parses a compose file (`docker compose version`
  and `docker info` do not). ADR-0051's properties 1, 2, 5 and 6 hold as written: exported not
  written, one value for the whole run, unconditional override, and `BETTER_AUTH_SECRET` correctly
  absent from the contaminant list at `:182-191` and from `NOISY_NAMES` at `:237`.
- **The value has no print path.** I walked every string the harness emits: `refuse` bodies print
  literals, variable *names*, `$COMPOSE_FILE`, `$FOREIGN` and `$PROJECT_NAME`; clause reasons print
  psql stderr, `config.err` truncated to 300 characters, the `/health` body, row counts and the
  `INTERP_HINT` variable names extracted by `sed`. None can carry the value. `cleanup`'s `down`
  redirects to `/dev/null`. `config.json` goes to a file, never stdout, and is read for `.name`
  only. F-379's property survives this card.
- `:?` rejects unset **and** empty. Measured: `BETTER_AUTH_SECRET="" docker compose config -q` exits
  1 with the same message. That is slightly stronger than the ADR claims (`:?` versus `?`).

**Attacks I ran and dropped.**

- *Does the parse failure blind the F-315/F-316 escape diagnostic?* `docker-compose.yml:71-75`
  documents "run `docker compose config -q` in a shell with nothing exported and look for the
  ABSENCE of a warning", and that shell now exits 1. I expected the required-variable error to abort
  interpolation before the unset-variable warnings were emitted, which would have killed the manual
  counterpart to a control that catches two passwordless roles. **It does not.** Measured against a
  scratch copy of the real file with the `$$SHORTKIT_APP_PASSWORD` escape deliberately broken: with
  `BETTER_AUTH_SECRET` unset, Compose prints both `"SHORTKIT_APP_PASSWORD" variable is not set`
  warnings *and* the required-variable error, exit 1; with it set, the same two warnings, exit 0.
  The diagnostic is intact; only the exit code changed. Dropped.
- *Is the secret a build arg, or does it reach any service but `api`?* No. `docker compose config`
  with a canary value shows exactly one occurrence, at `services.api.environment`. Not in `build.args`,
  not in `configs.*.content`, not on any container's argv. Dropped.
- *Command injection or interpolation injection through the generated value?* The `node -e` script is
  a single-quoted literal with no shell interpolation, and base64url cannot contain `$`, a backtick
  or a brace. Dropped.
- *Compose printing the value in a validation error that a clause then reports?* `environment` values
  are unconstrained strings, so no validation error quotes them; `config.err` cannot carry it.
  Dropped.

**The sixth failure mode — what I checked, and what I did not find.**

I enumerated every site that parses, renders, inspects or starts either compose file. `grep` for
`execFileSync('docker'|execSync('docker|spawnSync('docker` across the tree returns three:
`auth-role-provisioning.int-spec.ts:161` (the F-147 site, fixed in this diff),
`scratch-postgres.ts:99` and `psql.ts:46` — the latter two are `docker run`, not `compose`, and read
no compose file. `.github/workflows/ci.yml` has three jobs: `quality` (no docker), `integration`
(runs the spec, now self-supplying), `compose` (`pnpm test:compose` only, no `env:` block, correct).
`dependencies.yml` runs `pnpm audit` and nothing else. No package script, no `.github/scripts/*.mjs`,
no Makefile, no devcontainer, no override file touches compose. **I did not find a sixth mechanism of
F-034/F-074/F-081/F-144/F-147's kind** — an executing surface that parses the file and is not
supplied. F-154 above is the nearest thing and it is a human path, not an automated one.

What is left is documentation whose commands now need the variable and do not say so:
`README.md:146-147` (the provenance forms), `README.md:169-172` (the reset ladder, including the
`docker compose down -v` a developer reaches for when the stack is broken),
`docs/architecture/migrations.md:87-92,200`, and `docker-compose.yml:8-10`'s own banner. ADR-0051
prices this class explicitly ("`:?` breaks every compose subcommand, not just `up`"), so I am not
filing it as security; it is correctness and belongs to `sdlc-reviewer`. F-152 is the one member of
that class I did file, because ADR-0051 names it as a required README sentence and because its
consequence is a gate that stops running.

**Two bookkeeping drifts, neither security.** `scripts/check-compose-stack.sh:286` cites
`docker-compose.yml:297`; the line is 289. `.sdlc/identity-membership/work/TASK-019-report.md:10`
cites 292. Also, that report's "Contradiction found" section states the implementer did not modify
`auth-role-provisioning.int-spec.ts` — the diff under review does modify it, under F-147's ruling,
after the report was written. The report is stale rather than wrong; flagging it because a later
reader taking it at face value would conclude the integration job is still red.

**One thing I could not verify and am not asserting.** I did not re-run `pnpm test:compose`,
`pnpm test:integration` or the unit/typecheck/lint/build gates — the dispatch states they were run
and told me not to. Everything I claim as measured above I measured myself, read-only, using
`docker compose config` (which creates nothing) and a scratch copy of the compose file under `/tmp`,
since removed. The `docker-compose.test.yml` stack on `127.0.0.1:55433` is still up and untouched;
the `shortkit` application database was not contacted.

## Dependencies reviewed

None. The diff adds no dependency, bumps none, and does not touch `package.json`, any workspace
manifest or `pnpm-lock.yaml`.
