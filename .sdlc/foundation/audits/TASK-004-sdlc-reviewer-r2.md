# TASK-004 — sdlc-reviewer, fix round 1 re-review (scoped)

> Persisted verbatim by the orchestrator from the agent's return value; `sdlc-reviewer` has no
> write tool. Review package `.superpowers/sdd/plan/review-1581338..0f56cba.diff` (1 commit,
> 21933 bytes).

## Overall verdict: APPROVED

## F-154: ADDRESSED — proven by building, not by reading the rationale

Reproduced the exact original failure scenario against the **fixed** script: built `apps/web`
in a scratch clone of this exact commit with a client component reading only
`process.env.NEXT_PUBLIC_API_BASE_URL` (set to `https://shortkit-api.fly.dev/api`, the
`.env.example` value), `API_BASE_URL` set to the same value but never read by any code,
`BFF_PROXY_SECRET` set to a distinct random value. Result:

```
OK: checked 55 file(s) across .next/static, .next/server/app, no leaked value found;
positive control confirmed.
EXIT: 0
```

The build that previously produced `FAIL: API_BASE_URL in .next/static/chunks/...` now passes,
because `API_BASE_URL` is no longer a search target (`LEAK_TARGET_VAR = 'BFF_PROXY_SECRET'`,
singular) and `NEXT_PUBLIC_API_BASE_URL`'s presence is now the expected, required positive
control rather than a false leak.

**The reintroduction guard is recorded in three independent places a future reader would hit**:
the `LEAK_TARGET_VAR` comment in the script ("Do not re-add `API_BASE_URL` here without
reopening that ruling"), the `.env.example` comment on both variables, and TASK-004.md's
`AC-113 AMENDED` block. That satisfies the "survives a future reader" bar — it is not just
dropped silently; the omission explains itself at the point someone would go to restore it.

Test artifacts fully reverted; work happened entirely inside a scratch clone, never touching the
real repo.

## Findings on the fix diff itself

No new blocker or major findings.

```yaml
findings:
  - severity: nit
    kind: implementation
    file: apps/web/scripts/assert-no-inlined-secrets.mjs
    line: 166
    summary: >-
      collectFiles/matchesValue read every file under both scan roots as UTF-8 with no extension
      filter, which is correct for today's tiny scaffold but will do wasted work once
      .next/static/media starts holding binary assets that can never contain a text match.
    failure_scenario: >-
      Not a correctness defect - reading a binary file as 'utf8' cannot throw and cannot produce
      a false match; it decodes to replacement characters that .includes() correctly never
      matches. The cost is purely that once real static assets land (favicon, webfonts, OG
      images), the scan reads their full bytes on every CI run and every deploy for no benefit.
      At this app's current size (576K .next/static, 284K .next/server/app, ~55 files) this is
      unmeasurable; it is a scaling note, not a bug.
    required_change: >-
      None required now. Worth a follow-up once static/media assets exist: skip common binary
      extensions or cap the size read, WITHOUT narrowing the .html/.rsc/.segment.rsc/.meta
      coverage F-155 added.
```

## Answers to the three specific questions

1. **Positive control implementation, on its own terms.** Correct.
   `readRequiredValue(POSITIVE_CONTROL_VAR)` deliberately omits `minLength` — right, it is a URL,
   not a secret. The leak check runs and returns **before** the positive-control check, so a build
   with both a leak and a missing positive control reports the leak only, which is the correct
   priority. `matchesValue`'s `JSON.stringify`-escaped branch is a no-op for typical base64/URL
   values and costs nothing extra; verified it introduces no new false-positive path. **I found no
   other check in this diff with the "right in principle, unsatisfiable today" shape** besides the
   already-filed F-161 — `MIN_SECRET_LENGTH` and the widened `SCAN_ROOTS` are both satisfiable
   today and were exercised successfully in my build.

2. **`installCommand: --filter @shortkit/web...` does not break the build. Empirically tested.**
   Fresh `git archive HEAD` into a scratch directory (a true clean checkout, no residual
   `node_modules`), `pnpm install --frozen-lockfile --filter '@shortkit/web...'` ("Scope: 2 of 4
   workspace projects"), then `pnpm --filter @shortkit/web build && pnpm --filter @shortkit/web
   assert:no-secrets` exactly as `vercel.json` specifies. Build compiled, typechecked and
   generated pages; `@shortkit/contracts` resolved via the workspace `tsconfig.base.json` path
   mapping per ADR-0005 (no build step, source imported directly — matches ADR-0005:28-29,121).
   Root-only devDependencies (`eslint`, `typescript-eslint`, `@eslint/js`) were also present after
   the filtered install — **pnpm links the workspace root project's own dependencies regardless of
   `--filter` scope, contrary to my initial hypothesis that they would be excluded**, so no
   missing-tooling failure materialised. `assert:no-secrets` then failed exactly as F-161
   documents — the already-escalated finding, not new breakage from the install change.

3. **The widened, extension-filter-free walk.** Correctness: confirmed no crash on binary content
   (`readFile` as `'utf8'` on non-text produces non-matching decoded output, never throws). Cost:
   negligible at current size, see the nit. On "silently drops a root": the implementation
   explicitly does the **opposite** of silent — a missing `.next/server/app` (e.g. from a Next
   version that renames its output layout) fails loudly with a root-named error, per F-155's
   required_change, and each `SCAN_ROOTS` entry's `ENOENT` handler names `root.dir` and
   `root.name`. A *renamed-but-still-existing* alternate output root would not be caught — a real
   but unavoidable limitation of any statically-named scan, already implicitly acknowledged by the
   header's "KNOWN CEILING" framing for the adjacent F-157 gap. Not filed: no concrete mechanism
   today, only a hypothetical future Next internal rename.

## Cannot verify from diff

- Actual Vercel build container behaviour (corepack/pnpm binary resolution, Root Directory
  setting, project env var injection into install vs build steps). The scratch-clone reproduction
  is the closest available substitute inside this repo but is not a real Vercel deploy. Same
  caveat as round 1.
- Whether TASK-002's CI invocation of `assert:no-secrets` will export real values (F-084 split,
  outside this TASK's paths). Unchanged from round 1.

## Notes

- **F-161 independently reproduced** in my scratch build — confirms it is real and already
  correctly filed and escalated. Not re-filing.
- **F-155 independently re-reproduced** with a fresh server-to-client prop leak against the fixed
  script, confirming the widened scan catches it and correctly names the root in the failure
  output (`BFF_PROXY_SECRET in .next/server/app (...)`), then cleaned up and confirmed
  `page.tsx` byte-identical to `HEAD`.
