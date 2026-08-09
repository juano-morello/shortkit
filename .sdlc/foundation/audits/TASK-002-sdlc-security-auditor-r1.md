# TASK-002 — security audit, round 1

Auditor: `sdlc-security-auditor`. Date: 2026-08-06. Mode: code.
Scope audited: `.github/**`, `docs/security/**`, `docs/architecture/migrations.md` in
`49c9511..cbf5dab`. `apps/api/**` and `apps/web/**` in that range excluded per the coordinator
(TASK-005 / TASK-004, already audited). `apps/web/scripts/assert-no-inlined-secrets.mjs` was
re-read read-only to re-confirm item 5, not re-audited.

```yaml
verdict: changes-requested
findings:
  - severity: blocker
    kind: behavior
    file: .github/workflows/ci.yml
    line: 190
    summary: >-
      The `gate` job is skipped when `quality` or `integration` fails, and GitHub counts a
      skipped check run as satisfying a required status check. The sole required check
      therefore passes on every failed run.
    failure_scenario: >-
      The comment at ci.yml:188-189 states "A `needs` job that fails or is skipped leaves this
      job skipped, which is not success." GitHub's own reference says the opposite: a required
      status check is satisfied by a conclusion of `success`, `skipped` OR `neutral`, and a job
      skipped because a `needs` dependency failed publishes a check run named `gate` with
      conclusion `skipped`. Branch protection on `main` requires only `gate`. So: an outside
      contributor opens a PR on this public repo that aliases BFF_PROXY_SECRET behind a
      NEXT_PUBLIC_ name. `quality` goes red at "Assert no server-only value was inlined into the
      build" - exactly as AC-113 intends. `gate` is skipped, reports as passing, and branch
      protection raises no objection; the merge button is not blocked, because `quality` is not
      itself a required context. The same holds for every other control this job fans in:
      `pnpm audit --prod`, `db:check-policies`, the AC-114 collection assertion, lint,
      typecheck, test, build. None of them can block a merge today. The control is not weakened
      in the failure case, it is inoperative in the failure case, which is the only case it
      exists for. Filed blocker rather than major because the branch protection configuration
      was chosen on the strength of a claim that is factually false, so the repo's stated merge
      gate does not exist; downgrade to major if the orchestrator counts "a human still sees a
      red X in the checks list" as a control.
    required_change: >-
      Make `gate` run unconditionally and assert on the results rather than relying on `needs`
      propagation: `if: always()` plus a step that fails when `needs.quality.result != 'success'`
      or `needs.integration.result != 'success'` (this also catches `cancelled`, which
      `cancel-in-progress: true` can produce). Correct the comment at ci.yml:185-189, which is
      the artifact that will otherwise re-teach the wrong invariant. Re-verify by pushing a
      branch with a deliberately failing `quality` step and confirming the `gate` check run
      reports failure, not skipped.

  - severity: major
    kind: behavior
    file: .github/dependabot.yml
    line: 18
    summary: >-
      Dependabot-triggered runs receive no Actions secrets, so `secrets.BFF_PROXY_SECRET` is
      empty and the `quality` job fails at the AC-113 step on every Dependabot pull request -
      the one class of PR ADR-0018 depends on for security remediation.
    failure_scenario: >-
      GitHub treats workflow runs triggered by Dependabot from `push` and `pull_request` as if
      they came from a fork: read-only GITHUB_TOKEN, and the only secrets available are
      Dependabot secrets, never Actions secrets. `BFF_PROXY_SECRET` is registered as an Actions
      repo secret, so ci.yml:45 resolves to the empty string, `readRequiredValue` throws
      "BFF_PROXY_SECRET is not set", and `quality` exits 1. Both this workflow's triggers fire
      for Dependabot (it pushes its branch and opens the PR), so both runs are red. The
      consequence is not a broken bot: ADR-0018 makes Dependabot the *only* mechanism that
      raises a version ("detection with no remediation path, which is how a known advisory stays
      deployed for a quarter"), and every weekly minor-and-patch PR plus every security bump now
      arrives permanently red at the gate. With the blocker above, they are also permanently
      *mergeable*, so the steady-state outcome is that dependency bumps - including security
      patches - land having never had lint, typecheck, test, build, `pnpm audit` or the
      inlined-secret scan pass. Fix the blocker without fixing this and the outcome inverts: no
      dependency bump can ever merge without `enforce_admins: false` being used to bypass the
      gate, which trains bypassing the gate on exactly the PRs that carry security fixes.
      `.github/dependabot.yml:18` asserts the opposite of all of this ("Dependabot pull requests
      run `quality`, `integration` and `gate` like any other"), so the file that creates the
      condition is also the file that tells a reader it does not exist. Distinct from F-182:
      that finding is about external fork PRs on a solo repo and was ruled to have no security
      consequence because there are no external contributors. Dependabot is not an external
      contributor, it is required infrastructure, and it starts firing on the next Monday.
    required_change: >-
      Register `BFF_PROXY_SECRET` as a *Dependabot* secret in addition to the Actions secret
      (Settings > Secrets and variables > Dependabot), which makes `secrets.BFF_PROXY_SECRET`
      resolve for these runs with no workflow change. Verify against a real Dependabot PR rather
      than by inspection. Correct the claim at dependabot.yml:18 either way, and confirm the two
      `vars` (`NEXT_PUBLIC_API_BASE_URL`, `API_BASE_URL`) resolve on the same run before
      declaring it fixed.

  - severity: minor
    kind: behavior
    file: .github/workflows/ci.yml
    line: 31
    summary: >-
      No `timeout-minutes` on any of the four jobs, so each inherits the 6-hour default on a
      public repo that runs attacker-supplied `pnpm install` and `next build` on `pull_request`.
    failure_scenario: >-
      Anyone with a GitHub account forks this repo and opens a PR. `pull_request` runs the
      workflow from the PR head, so the attacker controls `pnpm-workspace.yaml` (including the
      `allowBuilds` allowlist that currently limits install scripts to `@swc/core` and
      `esbuild`), `pnpm-lock.yaml`, every package script and the composite action itself. That
      is arbitrary code execution on the runner by design, and it is accepted - the run gets no
      secrets and a read-only token. What is not bounded is duration: three jobs x 360 minutes
      of free compute per PR, repeatable, plus a hung `quality` job that sits on the merge queue
      and on the `concurrency` group. Runner minutes being free is what makes this attractive to
      abuse, not what makes it harmless.
    required_change: >-
      Add `timeout-minutes` to every job, set from observed duration with headroom (run
      31113561948 is the baseline). A wrong-but-present bound is strictly better than 360.

  - severity: minor
    kind: behavior
    file: .github/workflows/ci.yml
    line: 45
    summary: >-
      The only thing keeping `quality`'s job-level `BFF_PROXY_SECRET` from mattering is that its
      value is deliberately not production's, and that property is recorded in a comment rather
      than enforced anywhere.
    failure_scenario: >-
      Declared at job level (deliberately, F-156), the secret is in the environment of every
      step in `quality` - including `actions/checkout`, `actions/setup-node`, and
      `pnpm install --frozen-lockfile`, which executes the build scripts of `@swc/core` and
      `esbuild`. Today that reach is worth nothing: the CI value is a random base64url string
      used only as a search needle, and this is a genuinely good decision that should be kept.
      But the enforcement is one comment at ci.yml:42-43. The plausible sequence is the
      Dependabot/fork-secret problem above being "fixed" by pasting Vercel's real
      `BFF_PROXY_SECRET` into the CI secret so the values agree - a natural-looking repair that
      no test, no gate and no reviewer checklist rejects. At that point a compromised transitive
      build script, or a repointed `actions/checkout@v7` tag, reaches the live value the API
      trusts before honouring a forwarded `x-shortkit-client-ip`, which is the exact
      capability `assert-no-inlined-secrets.mjs`'s own header says publishing it would grant.
    required_change: >-
      Make the divergence checkable rather than asserted: either state the requirement where the
      secret is rotated (a line in `docs/security/` naming the CI secret as a distinct value
      that must never be set to the Vercel one), or narrow the exposure so the coincidence stops
      being load-bearing - the two steps that need it are "Build apps/web for the inlined-secret
      scan" and "Assert no server-only value was inlined", and a step-level `env:` on both plus
      a comment naming the pairing costs the structural guarantee F-156 bought, so state
      explicitly which of the two you are choosing.

  - severity: nit
    kind: behavior
    file: .github/scripts/provision-test-database.sql
    line: 47
    summary: >-
      The role-attribute guard asserts two of the four properties `rls-policy-template.md`
      forbids on `shortkit_app`: it checks `rolbypassrls` and `rolsuper`, not `CREATEROLE` and
      not table ownership.
    failure_scenario: >-
      `rls-policy-template.md:30-31` reads "`shortkit_app` must never hold `BYPASSRLS`,
      `SUPERUSER`, `CREATEROLE` or table ownership." This DO block is the only place in CI that
      enforces any of it, and its stated purpose is catching "a future edit that adds SUPERUSER
      'just for CI'". The same edit adding `CREATEROLE` passes. No attacker: under PostgreSQL 16+
      a CREATEROLE role cannot grant itself BYPASSRLS or SUPERUSER, so the escalation path is
      closed by the server, and this is a fixture database destroyed with the runner. Filed
      because the guard is the contract's only mechanical reader and it is two words short of
      matching it.
    required_change: >-
      Add `OR rolcreaterole` to the predicate at line 47. Table ownership for `shortkit_app` is
      already covered downstream by `check-policies.mts`'s `tables_owned_in_public` count
      (verified in the TASK-005 round 2 audit) - if you disagree, assert it here too rather than
      leaving it implied.

  - severity: nit
    kind: behavior
    file: .github/workflows/ci.yml
    line: 49
    summary: >-
      `actions/checkout` persists the GITHUB_TOKEN into `.git/config` by default, leaving it
      readable by every later step in the job including dependency build scripts.
    failure_scenario: >-
      `persist-credentials` defaults to true, so the token lands in `.git/config` as an
      `http.extraheader`. Reach is close to nil here and that is why this is a nit: the
      workflow-level `permissions: contents: read` means the token can clone a repository that
      is already public and do nothing else - no push, no issues, no packages, no Actions API.
      Recorded because the mitigation is entirely the `permissions:` block, so a future job that
      needs a write scope silently converts this into a real exposure.
    required_change: >-
      `with: { persist-credentials: false }` on all three `actions/checkout` steps. Nothing in
      either workflow runs git after checkout, so nothing breaks.
```

## Notes

Answering the six items in the order asked.

### 1. Workflow supply chain, and what a malicious tag repoint actually gets

Four `uses:` references, three distinct targets:

| Reference | Where | Pinning |
|---|---|---|
| `actions/checkout@v7` | `ci.yml:49`, `ci.yml:133`, `dependencies.yml:44` | mutable major tag |
| `actions/setup-node@v7` | `setup-toolchain/action.yml:47` | mutable major tag |
| `./.github/actions/setup-toolchain` | all three jobs | local path, moves with the ref being built |

No third-party actions, no marketplace actions, no `docker://` images, no `actions/cache`, no
`actions/upload-artifact`. Two first-party GitHub-owned actions is about as small as this
surface gets, and the local composite is not a supply-chain edge at all.

**What a repoint of `actions/checkout@v7` or `actions/setup-node@v7` to malicious code would
reach, plainly:**

- **`BFF_PROXY_SECRET`: yes, and it is worth nothing.** Job-level `env:` puts it in scope for
  every step in `quality`, including both of these. The value is CI's own, deliberately not the
  one registered on Vercel, and it is used only as a search needle. An attacker gets a random
  base64url string that authenticates nothing. This is the single best decision in the diff and
  the reason the tag pinning is survivable. It is also exactly what the fourth finding above is
  about: nothing enforces it.
- **`GITHUB_TOKEN`: yes, and it is worth nothing.** `permissions: contents: read` at workflow
  level, no job overrides it. On a public repository that grants the ability to read a
  repository the whole internet can already read.
- **Write access to the repo: no.** `contents: read` cannot push, and branch protection on
  `main` sits behind it regardless.
- **Production: no.** Neither workflow holds Fly, Vercel, Neon or Upstash credentials, and
  neither deploys - Vercel deploys through its own git integration, not through Actions.
- **What it does get: the ability to make the gate lie.** A compromised `checkout` writes
  whatever tree it likes onto the runner, so `quality` and `integration` can be made to report
  green over code they never inspected. Given the blocker above, that capability is currently
  redundant, since the gate already passes on failure.

**Judgement on tag pinning.** Adequate, given the above. SHA-pinning `actions/checkout` and
`actions/setup-node` would harden against GitHub-owned-repo tag compromise and buy nothing else,
and with no bot watching the refs (F-180) it converts every update into archaeology, which is
the implementer's own reasoning and it is correct. I would not spend a finding on it. Note the
asymmetry F-180 does not state: SHA pinning without a watcher is *worse* than tag pinning
without a watcher, because a mutable major tag at least receives upstream security fixes to the
action itself. If F-180 is fixed by adding the `github-actions` Dependabot ecosystem, revisit
SHA pinning at that point and not before.

The real supply-chain surface in this diff is npm, not Actions, and it is well handled:
`--frozen-lockfile` on every job, exact pins across four manifests, integrity-hashed
`packageManager` actually verified by Corepack (F-064 obligation 1 is genuinely discharged - the
composite action pins Node to the `engines` floor specifically because Node 25 dropped Corepack,
and that reasoning checks out), and `allowBuilds` in `pnpm-workspace.yaml` limiting install
scripts to `@swc/core` and `esbuild`.

### 2. `GITHUB_TOKEN` permissions, per job

Both workflows declare `permissions: contents: read` at workflow level (`ci.yml:24`,
`dependencies.yml:36`). No job declares its own block, so all four jobs inherit exactly that.

| Job | Gets | Needs | Verdict |
|---|---|---|---|
| `quality` | `contents: read` | `contents: read` (checkout) | exact |
| `integration` | `contents: read` | `contents: read` (checkout) | exact |
| `gate` | `contents: read` | nothing - it checks out nothing and runs one `echo` | over-granted, trivially; `permissions: {}` would be exact |
| `dependencies` | `contents: read` | `contents: read` (checkout) | exact |

No job requests `packages:`, `id-token:`, `issues:`, `actions:` or `pull-requests:`. Nothing
writes. The repository default is irrelevant here because the explicit block overrides it - this
is the right shape and the implementer's "no `GITHUB_TOKEN` write scope" claim is accurate. The
`gate` over-grant is not worth a finding on its own; fold it into the blocker's fix if you are
editing that job anyway.

### 3. `pull_request_target`, `workflow_run`, and script injection

**Neither trigger is used.** `ci.yml` is `push: branches: ['**']` plus bare `pull_request`;
`dependencies.yml` is `schedule` plus `workflow_dispatch`. No `workflow_run`, no
`workflow_call`, no `repository_dispatch`, no `issue_comment`. The pwn-request class is not
present.

**Every `${{ }}` inside a `run:` block, enumerated - there are four, and none is
attacker-controlled:**

| Location | Expression | Source | Verdict |
|---|---|---|---|
| `ci.yml:147` | `job.services.postgres.id` | Actions runtime, a container ID | not attacker-reachable |
| `ci.yml:176` | `runner.temp` | Actions runtime, a runner path | not attacker-reachable |
| `ci.yml:183` | `runner.temp` | same | not attacker-reachable |
| `action.yml:49` | `steps.node.outputs.version` | a `with:` input, not a `run:` body | not a shell context |

There is **no** reference to `github.event.*` anywhere in `.github/**` - no PR title, no branch
name, no body, no commit message, no author, no label. That is the whole classic exfiltration
path on a public repo and it is absent. The other three interpolations (`ci.yml:28`, `45`, `46`,
`47`) are in `concurrency:` and `env:`, not in shell.

`actionlint`'s shellcheck rules being disabled therefore costs less than it sounds: the class it
would have caught most usefully - untrusted interpolation into shell - has nothing to catch
here. I read all six `run:` bodies by hand instead. The composite action's is the only
non-trivial one and it is correct: `floor` is quoted at every expansion, the `case` glob
constrains the shape before use, and the `>>` redirect targets a quoted `"$GITHUB_OUTPUT"`.

One thing I checked and am deliberately **not** filing: `echo "version=${floor#>=}" >>
"$GITHUB_OUTPUT"` can be made to inject an extra output line, because
`node -p "require('./package.json').engines.node"` prints a JSON string that may contain a real
newline and the `'>='[0-9]*` glob does not reject one. It is real and it is worthless. Nothing
reads an injected output; the sink is `GITHUB_OUTPUT`, not `GITHUB_ENV`, so there is no
`NODE_OPTIONS` escalation; and the only actor who can edit `package.json` on a run that has
secrets already has write access. On a fork PR the same actor already has arbitrary code
execution through their own lockfile, which is strictly more capability. Recorded so the next
round does not re-derive it.

### 4. `provision-test-database.sql`

**Test-only, and nothing in it can reach a real database.** The file has exactly one consumer:
`ci.yml:145-149`, which pipes it on stdin into `psql` running *inside* the service container via
`docker exec`, addressed as `127.0.0.1:5432` from that container's own network namespace. It
takes no DSN parameter, reads no environment for its target, and is referenced by nothing else
in the repository (`grep`-confirmed across the tree). The literal passwords - `migrator`, `app`,
and `postgres` via `PGPASSWORD` on the step - are fixtures for a container destroyed with the
runner, matching `docker-compose.test.yml`'s already-audited posture, and the file carries the
same delimited "TEST-ONLY. DO NOT ADAPT INTO A PRODUCTION DATABASE" header that TASK-005 gained
under F-131. The one way this file could reach a real database is a human copying it, and the
header addresses that directly. Confirmed test-only.

**The two properties the tenancy guarantee rests on:**

- **The API's role must not hold `BYPASSRLS`.** Asserted, at lines 39-53, over both roles, on
  `rolbypassrls OR rolsuper` - covering the migrator too, which matters because `FORCE ROW LEVEL
  SECURITY` does not constrain an exempt owner either. This is stronger than
  `docker-compose.test.yml`, which states `NOBYPASSRLS` and relies on it being the default. The
  implementer proved the guard fires by forcing the condition (`ALTER ROLE shortkit_app
  BYPASSRLS`, psql exit 3), which is the right kind of evidence - a guard nobody has seen fail
  is not a guard. It also cannot be defeated later in the run: `db:migrate` connects as
  `shortkit_migrator`, which holds neither SUPERUSER nor CREATEROLE, so no subsequent step can
  grant BYPASSRLS to anything. Fails closed. The nit above is that the same block is two words
  short of the contract's full four-attribute list.
- **The migrator must own the schema.** Asserted, at lines 60-64, via
  `pg_get_userbyid(datdba)` on `shortkit_test`. Ownership of schema `public` follows from
  database ownership through `pg_database_owner` on PostgreSQL 15+, and the image is
  `postgres:17-alpine`, so the inference holds. This assertion is also load-bearing for the two
  `ALTER DEFAULT PRIVILEGES FOR ROLE shortkit_migrator` statements below it, exactly as the
  comment says: scoped to that identity, a differently-owned database silently grants
  `shortkit_app` nothing and the failure surfaces as a confusing permission denied inside the
  suite rather than here.

Checked against `design/contracts/rls-policy-template.md`'s "Roles" section line by line: both
`CREATE ROLE` statements, the `GRANT USAGE ON SCHEMA public`, and both `ALTER DEFAULT
PRIVILEGES` statements reproduce the contract exactly, with `:'migrator_password'` /
`:'app_password'` substituted by fixture literals. No extra grant, no `GRANT ALL`, no
`PUBLIC` grant, no `SUPERUSER`, no `CREATEDB`, no `CREATEROLE`, no `REPLICATION`. `shortkit_app`
owns nothing. The two-copies-can-drift problem the implementer flagged is real and unenforced,
but it is a correctness risk between two fixture databases, not a security one, and both files
carry the pointer.

### 5. Secret hygiene in logs, on a public repo

Re-confirmed for the CI path specifically, on every branch.

`ci.yml:45` is the only place `secrets.*` appears in either workflow. GitHub registers that
value for masking, and run 31113561948 shows `***` holding while the two `vars` render in full,
which is the expected and correct split - the two base URLs are public by design (F-154's
ruling) and `known-advisories.md`, `.env.example` and any redirect response already carry them.

Masking is substring-based, so the question is whether anything transforms the value before it
reaches a log. Walking every step in `quality`:

- `pnpm audit`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build` - none reads
  `BFF_PROXY_SECRET`, none dumps its environment. Next's build banner prints variable *names*
  loaded, never values.
- `assert-contract-drift.mjs` - its verbose failure branch prints `output`, the combined
  stdout+stderr of `pnpm -r --no-bail typecheck`. That is compiler diagnostics over TypeScript
  sources; the secret is not in any source file and `tsc` does not read the environment into its
  output. Clean.
- `assert-no-inlined-secrets.mjs` - I re-read all seven exit branches. **No branch prints the
  value.** The leak branch (`:378-392`) prints `name`, `root` and a `path.relative` file path.
  The two `readRequiredValue` throws print the variable name and, on the length branch, the
  integer length - and the base64url branch, which is the only one that could have quoted the
  offending characters, prints the alphabet instead of the value. The positive-control failure
  branch (`:481-490`) prints `positiveControlValue.length`, and that variable is
  `NEXT_PUBLIC_API_BASE_URL`, which is public. The `OK` branches print counts and root names.
  Confirmed: names, paths, counts and one length; never a value, on any branch.
- The one transformation in the script is `matchesValue`'s
  `JSON.stringify(value).slice(1, -1)` (`:302`), and it is only ever used for comparison, never
  printed. It is also identity for this value: `readRequiredValue` enforces
  `BASE64URL_PATTERN` on `BFF_PROXY_SECRET` before the scan runs, and no base64url character
  requires JSON escaping. So there is no base64/JSON/URL-encoded form of the secret produced
  anywhere in the CI path for masking to miss.
- No step splits, slices, reverses, hashes or re-encodes the secret. No `echo` of it. No
  `env | sort`. No `set -x`. No `actions/upload-artifact`, so `.next/**` never leaves the runner
  even on the branch where the guard has just proven the secret is inside it - which is the one
  place a leak-detection tool most commonly leaks.

Conclusion: masking is not the load-bearing control here; the absence of any print path is, and
masking is the backstop. That is the right order.

### 6. `docs/security/known-advisories.md`

Diffed against ADR-0018's register. Both rows are transcribed with the advisory ID, severity,
package-and-path, assessment and clearing condition **intact and unaltered** - I compared the
assessment prose word for word. The `--prod` versus whole-tree table is reproduced faithfully,
including the "**every dev-only advisory, at every severity**" blind-spot row, which is the
sentence a reader most needs and the one most likely to get softened in a copy.

**No suppression mechanism, confirmed by search rather than by reading the doc's claim about
itself.** `grep` across every `.json`, `.yaml` and `.yml` in the tree returns no
`auditConfig`, no `ignoreCves`, no `ignoreGhsas`, and no `--ignore` outside a comment in
`dependencies.yml:53` saying there is none. There is no committed `.npmrc` (it is gitignored,
for the good reason recorded in `pnpm-workspace.yaml`), no `pnpm.overrides`, and no `audit`
script in any `package.json` that could carry hidden flags. Both audit commands are literal:
`pnpm audit --prod --audit-level moderate` and `pnpm audit --audit-level moderate`. The register
is a document, as designed.

The assessments match mine. `GHSA-67mh-4wv8-2f99` is attributed to `sdlc-security-auditor` and
that is my assessment, reproduced correctly (esbuild dev-server only, `@esbuild-kit/core-utils`
uses the transform API, `drizzle-kit` never listens, devDependency so `--prod` is blind to it).
`GHSA-g7r4-m6w7-qqqr` is attributed to `sdlc-architect` and labelled "not reviewed by the
security auditor" - accurate as to who performed it, and now slightly understated: I read and
concurred with it in the TASK-005 round 2 audit (`tsup` bundles rather than serves, nothing here
is Windows). Not worth a finding; worth a sentence if anyone edits the row.

One behaviour to expect rather than debug: the weekly `dependencies` run will fail on its first
execution, on `GHSA-67mh-4wv8-2f99`, by design. The step name carries the register's path so the
failure email points at it. That is the intended mechanism working, not a defect.

### Confirmed clean, so the next round does not re-derive it

- No `pull_request_target`, no `workflow_run`, no `issue_comment`, no `repository_dispatch`.
- No `github.event.*` interpolation anywhere in `.github/**`.
- No third-party or marketplace actions. No `docker://` steps.
- No `continue-on-error`, no `|| true`, no `set +e`, no `if: always()` masking a failure
  (AC-5's prohibition holds - `grep`-confirmed across both workflows).
- No caching, so no cache-poisoning surface between fork PRs and `main`.
- No artifact upload, so no build output escapes the runner.
- No `GITHUB_ENV` writes anywhere.
- No secret, token, key or credential committed in `.github/**` or `docs/**` beyond the
  fixture passwords covered above. `.env.local` and `.vercel/` are both gitignored
  (`git check-ignore` confirmed); the only tracked env file is `apps/web/.env.example`.
- The `docs/architecture/migrations.md` change is a documentation correction with no security
  content of its own. It is accurate, and the added CI-ordering paragraph correctly records why
  `db:check-policies` must run before the suite - which is a real integrity property, since the
  RLS fixture leaves schema `public` holding either an unprotected `tenants` or nothing.
