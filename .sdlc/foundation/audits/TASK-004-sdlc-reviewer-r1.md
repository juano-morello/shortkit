# TASK-004 — sdlc-reviewer, round 1

> Persisted verbatim by the orchestrator from the agent's return value. `sdlc-reviewer` is
> read-only and cannot write report files; the brief pre-empted it by asking for the body.

Review package: `.superpowers/sdd/plan/review-97b6143..1581338.diff` (1 commit, 9599 bytes).

## Overall verdict: CHANGES-REQUESTED

```yaml
findings:
  - severity: major
    kind: behavior
    file: apps/web/scripts/assert-no-inlined-secrets.mjs
    line: 204
    summary: >-
      The detector false-positives on API_BASE_URL as soon as any client code legitimately
      inlines NEXT_PUBLIC_API_BASE_URL, because this TASK's own .env.example gives both
      variables the identical value.
    failure_scenario: >-
      Verified empirically. Built apps/web with a client component reading only
      `process.env.NEXT_PUBLIC_API_BASE_URL` (set to `https://shortkit-api.fly.dev/api`, the
      exact value `.env.example` documents for it) - `API_BASE_URL` was never read anywhere in
      code. Ran assert-no-inlined-secrets.mjs with `API_BASE_URL` set to that same value (as
      `.env.example` prescribes) and `BFF_PROXY_SECRET` set to a distinct value. Output:
      `FAIL: API_BASE_URL in .next/static/chunks/2utktmc78r5j9.js`, exit 1 - even though
      API_BASE_URL was never touched by any code path; only the intentionally-public variable
      was inlined, which is exactly what NEXT_PUBLIC_* is for. The script does a raw substring
      search on values with no way to attribute a match to which variable's *read* produced it,
      so two variables sharing a value are indistinguishable to it. Since ADR-0006/ADR-0014
      route both the public and the server-only base URL to the same Fly origin with the same
      /api suffix, and this TASK's own .env.example sets them to the literal same string, this
      is not a contrived edge case - it is the documented, expected operational configuration.
      The moment TASK-008 lands and reads NEXT_PUBLIC_API_BASE_URL in client code (its entire
      purpose), every build will fail this check permanently, on a genuinely correct build,
      unless whoever debugs the red CI either gives the two vars different literal values
      (undocumented anywhere, contradicts the shipped .env.example) or weakens the check - the
      latter being exactly the kind of erosion that eventually lets a real BFF_PROXY_SECRET
      leak through unnoticed once someone stops trusting the check's output.
    required_change: >-
      The check must not report a leak solely because NEXT_PUBLIC_API_BASE_URL's legitimate,
      intended inlined value happens to match API_BASE_URL's value. This needs either: (a) a
      detection strategy that can distinguish "value present because the public var was read"
      from "value present because the server-only var was read" (e.g. by not treating
      API_BASE_URL as a bundle-leak target when its value is provably identical to the
      registered NEXT_PUBLIC_API_BASE_URL value, since in that case the string carries no
      information a browser could not already legitimately have), or (b) AC-113's scope itself
      needs re-examination for whether API_BASE_URL's raw value is actually the sensitive thing
      to search for, versus BFF_PROXY_SECRET which has no legitimate public counterpart and
      does not share this problem. This may need routing back through test-architect/product for
      AC-113 wording, not just an implementer patch.
```

No other findings met the bar for a concrete, verified failure scenario.

## Cannot verify from diff

- **`vercel.json`'s coherence against a real Vercel build.** No deployed project, no Root
  Directory setting, no way to exercise it from inside the repo. Reasoning traced
  independently: `framework: "nextjs"` plus repo-root-relative `installCommand` /
  `buildCommand` / `outputDirectory` (`apps/web/.next`) is a documented, valid Vercel monorepo
  pattern when Root Directory is left unset, and `pnpm --filter @shortkit/web build` run from
  the repo root does produce `apps/web/.next` (confirmed: `pnpm-workspace.yaml` lists `apps/*`,
  `apps/web/package.json`'s `build` is plain `next build`, and `@shortkit/contracts` has no
  build step per ADR-0005, so nothing else needs building first). No internal inconsistency
  found, but it cannot be confirmed against an actual Vercel build environment (corepack/pnpm
  version resolution, monorepo output detection). First real deploy is the actual test, exactly
  as the implementer's report and the card's `test_exempt_reason` state.
- **AC-7** — correctly not attempted; already dispositioned by the orchestrator.
- **Whether TASK-002's eventual CI invocation exports real values before calling
  `assert:no-secrets`** — outside this TASK's `paths` per F-084's split.

## Notes

- **The `/* global process, console */` directive is the right call, verified.**
  `eslint.config.mjs` applies `js.configs.recommended` (which enables `no-undef` with no Node
  globals declared) to all files, and only narrows `.mts`-adjacent handling through
  `typescript-eslint`'s recommended config, which turns `no-undef` off for TypeScript-recognised
  extensions — `.mjs` gets neither. Confirmed by reading `eslint.config.mjs` directly: there is
  no `languageOptions.globals` block for plain JS files anywhere in it. A file-scoped directive
  is the minimal, correctly-scoped fix given that file sits outside this TASK's `paths`.
- **The `/api` obligation (ADR-0006:112-113) is correctly encoded.** Both variables carry
  `/api`, with an inline comment explaining *why* (redirect controller registered outside the
  prefix) rather than just stating the rule.
- **AC-113's negative-test cleanup is genuinely complete.** Independently confirmed
  `apps/web/app/page.tsx` byte-identical to `HEAD` and no stray files, both before and after my
  own verification build (which I fully reverted the same way).
- The other false-negative shapes raised in the dispatch (short/common-substring values,
  percent-encoding, splitting across chunks) are plausible in the abstract but I found no
  concrete mechanism by which Next.js's `DefinePlugin`-style substitution would produce them for
  a typical secret string — a single literal replaces `process.env.X` at each use site, in
  whichever chunk that use site lands in. **I did not find a verifiable defect here and am not
  filing one speculatively.**
