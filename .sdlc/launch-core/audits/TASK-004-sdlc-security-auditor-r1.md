# TASK-004 — sdlc-security-auditor, round 1

> Persisted by the orchestrator from the agent's return value. Third auditor today with no
> write path for report `.md` files — a harness-configuration constraint, not a tool failure.
> The directory exists and is writable.

Review package: `.superpowers/sdd/plan/review-97b6143..1581338.diff` (1 commit, 9599 bytes).

## Verdict: CHANGES-REQUESTED

Findings 1, 2 and 4 were each **reproduced by building this repo's actual `apps/web`**
(Next 16.3.0, turbopack, unmodified `next.config.ts`) in a scratch copy, running the delivered
script unchanged against the output, and serving the result with `next start` and curling it.
The real repository was not modified — confirmed independently by the orchestrator:
`git status --porcelain` shows only `.sdlc/` files.

```yaml
verdict: changes-requested
findings:
  - severity: blocker
    kind: behavior
    file: apps/web/scripts/assert-no-inlined-secrets.mjs
    line: 48
    summary: >-
      The guard scans only .next/static/**. A server-only value that reaches the browser
      through prerendered HTML or an RSC flight payload lands in .next/server/app/** and the
      guard exits 0.
    failure_scenario: >-
      Reproduced end to end. A server component reads process.env.BFF_PROXY_SECRET and passes
      it as a prop to a 'use client' component - the single most common Next.js server-data
      leak, and exactly the shape TASK-012 will create when serverApiClient() and the proxy
      start handling this secret. Build with BFF_PROXY_SECRET=PROBE-SECRET-9c1f2ae7:
        - value present in .next/server/app/index.html, index.rsc,
          index.segments/__PAGE__.segment.rsc, index.segments/_full.segment.rsc
        - value present nowhere under .next/static
        - `next start` + `curl -s http://host/` returns the secret in the HTML body to an
          unauthenticated client
        - the guard prints "OK: checked 10 file(s) under .next/static/, no server-only values
          found." and exits 0
      Attacker: anyone on the internet, one unauthenticated GET of the site root. What they
      get: BFF_PROXY_SECRET, the API's constant-time match for honouring x-shortkit-client-ip -
      forge that header and all four IP-keyed rate-limit buckets collapse into one shared
      bucket product-wide (ADR-0014 Consequences, web-api-client.md invariant 8). AC-113 says
      "no server-only value may appear in the built client bundle"; prerendered HTML and .rsc
      payloads are the built client bundle as much as the JS chunks are. The check is green on
      the leak it exists to stop.
      Rated blocker rather than major because the artifact under review IS the control, its
      stated scope is the shipped client bundle, and I demonstrated a build where the control
      passes while the secret is served to unauthenticated clients. The code change that
      triggers it has not landed yet (TASK-012) - but that change is precisely what this
      control was created to catch.
    required_change: >-
      Widen the scanned roots to include .next/server/app/** (at minimum *.html, *.rsc,
      *.segment.rsc, and the prerendered .meta/.segments trees) alongside .next/static/**.
      Report the root each hit came from. Do not silently skip a root that is missing - an
      absent .next/server/app must fail the same way an absent .next/static does today.

  - severity: major
    kind: behavior
    file: apps/web/scripts/assert-no-inlined-secrets.mjs
    line: 95
    summary: >-
      Checking API_BASE_URL by value guarantees a false positive, because .env.example
      prescribes the identical value for browser-visible NEXT_PUBLIC_API_BASE_URL.
    failure_scenario: >-
      Reproduced. .env.example lines 12 and 19 both read https://shortkit-api.fly.dev/api. Add
      the first legitimate client-side read of NEXT_PUBLIC_API_BASE_URL - which is what that
      variable is registered for - and Next inlines it into .next/static/chunks/*.js exactly as
      designed. The guard then fails naming API_BASE_URL. Nothing is wrong with that build. The
      message asserts a diagnosis that is false, and no code change in apps/web can clear it
      while both variables hold the same URL. The attacker here is REMEDIATION PRESSURE: a red
      CI on a correct build gets resolved by loosening the guard, and the cheapest loosening
      someone reaches for is "match only when the value is long enough / not a URL / skip
      chunks" - heuristics that then also apply to BFF_PROXY_SECRET. API_BASE_URL is not
      confidential in the first place: it is the public Fly hostname, committed in cleartext in
      .env.example, and discoverable from any redirect. Checking it buys no confidentiality and
      costs the guard's credibility.
    required_change: >-
      Decide deliberately and record the decision: either drop API_BASE_URL from the checked
      list (it is public, and ADR-0014 protects it as topology, not as a secret), or keep it
      and make .env.example set NEXT_PUBLIC_API_BASE_URL to a value that cannot equal
      API_BASE_URL. Whichever way, the check must not be able to red a correct build, and any
      leniency added must be scoped so it cannot apply to BFF_PROXY_SECRET.

  - severity: major
    kind: behavior
    file: apps/web/scripts/assert-no-inlined-secrets.mjs
    line: 94
    summary: >-
      The guard cannot tell whether the build it inspects was made with the values it is
      searching for, so a build/check environment mismatch is a permanent silent green.
    failure_scenario: >-
      The script reads the values at check time from its own environment; the file header
      instructs the caller to run it after build with the same real values the build ran with.
      That agreement is prose addressed to a different TASK (F-084 gives the CI wiring to
      TASK-002 under .github/**) and nothing enforces it. If TASK-002 builds apps/web without
      BFF_PROXY_SECRET exported and then runs assert:no-secrets with a placeholder - which is
      not hypothetical, it is literally what TASK-004-report.md documents doing - the search
      finds nothing and exits 0 forever, while the Vercel production build, which does have the
      real values, inlines them. The guard never inspects the artifact that is actually
      published: CI builds one copy, Vercel builds another. A secret published only by a Vercel
      dashboard-set variable (someone adding NEXT_PUBLIC_BFF_PROXY_SECRET in project settings,
      which never appears in the repo) is invisible to CI by construction.
    required_change: >-
      Close the gap where build and check share one environment by construction: invoke the
      assertion from vercel.json's buildCommand, e.g. `pnpm --filter @shortkit/web build &&
      pnpm --filter @shortkit/web assert:no-secrets`, so the check runs against the artifact
      that is deployed, with the real project variables, and a failure fails the deploy.
      vercel.json is inside this TASK's paths, so this does not cross the F-084 split.
      Additionally, have the guard refuse to pass vacuously: assert at minimum that
      NEXT_PUBLIC_API_BASE_URL's value IS present in the output (a positive control proving the
      build and the check saw the same environment), so an env mismatch shows up as red rather
      than green.

  - severity: major
    kind: behavior
    file: .sdlc/launch-core/tasks/TASK-004.md
    line: 44
    summary: >-
      No build-output scan can cover dynamic routes, which is where the authenticated surface
      will live. AC-113's guarantee is broader than any file scan can deliver.
    failure_scenario: >-
      Reproduced. Same server-component-prop leak with `export const dynamic = 'force-dynamic'`
      on the page: the value appears nowhere on disk under .next at all, the guard prints OK and
      exits 0, and `curl -s http://host/` returns the secret in the HTML body twice. Every
      dashboard route in ADR-0014 reads cookies() (sk_at) and is therefore dynamic by
      definition, so the ENTIRE AUTHENTICATED SURFACE - the one that will actually touch
      BFF_PROXY_SECRET and sk_at - is structurally invisible to this control even after the
      .next/server/app fix in the blocker above. The risk is the overclaim: AC-113 reads "no
      server-only value may appear in the built client bundle", a future implementer reads it as
      "we have a control for this", and ships a server-to-client prop on a dynamic route with a
      green CI.
    required_change: >-
      State the ceiling explicitly in the script header and on the card: this control covers
      build-time inlining and prerendered output only, not per-request server render. Then add a
      control that does cover it, owned wherever you route it (TASK-012 / ADR-0014 rather than
      necessarily here): React's experimental_taintUniqueValue applied to BFF_PROXY_SECRET and
      to the sk_at cookie value at their single read sites, which throws at render time when the
      value crosses into a client component on any route type. An `import 'server-only'` module
      boundary is a useful complement but does not stop the prop path.

  - severity: minor
    kind: behavior
    file: vercel.json
    line: 4
    summary: >-
      The unfiltered workspace install runs apps/api's native install scripts inside the Vercel
      build environment, where BFF_PROXY_SECRET is present.
    failure_scenario: >-
      `pnpm install --frozen-lockfile` at the repo root installs every workspace, including
      apps/api, even though buildCommand builds only @shortkit/web. pnpm-workspace.yaml's
      allowBuilds permits install scripts for @swc/core and esbuild; @swc/core is an
      apps/api-only devDependency (apps/api/package.json:28) that the web build never uses.
      Vercel exposes project environment variables to the install and build steps, so a
      compromised release of @swc/core executes with BFF_PROXY_SECRET and API_BASE_URL readable
      in process.env and outbound network available, on a deploy that had no reason to install
      it. Narrow - allowBuilds already blocks scripts for everything else, which is a good
      posture - but the exposure is avoidable at zero cost. --frozen-lockfile itself is the right
      call and packageManager is pinned with a sha512 integrity hash; no issue there.
    required_change: >-
      Scope the deploy install to the web workspace and its dependencies (`pnpm install
      --frozen-lockfile --filter @shortkit/web...`), or move @swc/core out of the allowBuilds set
      for deploy. Verify the filtered install still resolves @shortkit/contracts before adopting
      it - this is a change to make deliberately, not blindly.

  - severity: minor
    kind: behavior
    file: vercel.json
    line: 6
    summary: >-
      The web origin ships with no security headers, and no design artifact assigns them to it.
      ADR-0022 and logging-and-headers.md cover the API deployable only.
    failure_scenario: >-
      ADR-0022 and contracts/logging-and-headers.md specify helmet, HSTS, X-Frame-Options DENY,
      nosniff, Referrer-Policy and CSP - all registered in the API's main.ts, all scoped to
      NestJS responses. The Vercel origin, which will serve the login form and the dashboard and
      hold the sk_at/sk_rt cookies, gets whatever Next's defaults are, which is nothing.
      vercel.json is where headers would be configured and it sets none. Honest assessment of the
      two obvious attacks: clickjacking is largely defused already because SameSite=Lax means the
      cookies are not sent to a cross-site iframe, so a framed dashboard renders signed-out; and
      referrer leakage of workspace/link ids is defused by the modern browser default of
      strict-origin-when-cross-origin. So this is hardening and ownership, not a live exploit. It
      is worth recording because the gap is SILENT: nothing in the frozen artifacts says the web
      origin was considered, so no later TASK will notice it is missing.
    required_change: >-
      Record the decision somewhere an implementer will read - an ADR-0022 amendment or a
      TASK-004 note - covering what the Vercel origin sends: at minimum X-Frame-Options DENY (or
      CSP frame-ancestors 'none'), X-Content-Type-Options nosniff, and an explicit
      Referrer-Policy, plus HSTS once a custom apex replaces *.vercel.app (vercel.app is HSTS
      preloaded; a custom domain is not). Route the ownership; do not let it be invented ad hoc
      by whichever frontend TASK trips over it first.

  - severity: nit
    kind: behavior
    file: apps/web/scripts/assert-no-inlined-secrets.mjs
    line: 127
    summary: >-
      Plain substring matching can miss an escaped rendering of the value, and accepts a secret
      short enough to make the check meaningless.
    failure_scenario: >-
      `contents.includes(value)` compares against the raw value. A secret containing <, >, ", \
      or a non-ASCII character is emitted escaped in an RSC flight payload (<) or an HTML
      attribute, and the raw substring will not match. Conversely readSecret accepts any
      non-blank string, so BFF_PROXY_SECRET=dev either matches half the bundle or means nothing.
      Low likelihood - an `openssl rand -base64 32` secret contains only characters that survive
      verbatim - but the constraint currently lives nowhere.
    required_change: >-
      State the required secret format in .env.example (e.g. base64url, >= 32 bytes) and have
      readSecret reject values below a minimum length. Optionally also search the
      JSON.stringify'd form of the value alongside the raw form.
```

## Direct answers to the five questions posed

1. **Is the guard a guard?** It fires — but it looks in one of the three places the value can
   surface. Prerendered HTML and RSC payloads (`.next/server/app/**`) are browser-delivered and
   unscanned (blocker). Per-request server render produces no on-disk artifact at all and is
   unscannable in principle (finding 4). **Source maps are the one thing that is fine**:
   `productionBrowserSourceMaps` is unset, so no client maps are emitted, and if it were ever
   enabled the maps would land under `.next/static/chunks/**` and be scanned.
2. **Does `API_BASE_URL` false-positive?** Yes, guaranteed, reproduced with the exact values
   `.env.example` prescribes. It has **not** been made lenient — matching is a strict `includes`
   on the raw value, so the `BFF_PROXY_SECRET` case is not currently weakened. The risk is
   prospective and behavioural.
3. **`.gitignore` and committed secrets.** Clean. `git check-ignore` confirms
   `apps/web/.env.local`, `apps/web/.env`, `apps/web/.env.production.local`,
   `apps/web/.env.development` and root `.env.local` are all ignored, with `!.env.example`
   correctly re-including only the template. `git ls-files` shows `apps/web/.env.example` as the
   only tracked env file. `BFF_PROXY_SECRET=` is empty; `shortkit-api.fly.dev` is a public
   hostname. Next never loads `.env.example`, so the placeholder cannot leak into a build.
   **No finding.**
4. **`vercel.json` supply chain.** `--frozen-lockfile` is the right posture and `packageManager`
   is pinned with a sha512 integrity hash, so the pnpm binary itself is verified. `allowBuilds`
   restricting install scripts to `@swc/core` and `esbuild` is genuinely good. The one residual
   is the unfiltered install pulling apps/api into the deploy environment (minor, above).
5. **GC-9 / secrets in CI logs.** **Clean, confirmed by reading every output path.** The failure
   message prints `${name} in ${relative(file)}` and never the value; the unset-variable message
   prints only the variable name; the ENOENT message prints only a directory path; the success
   line prints only a file count. The only escaping `throw` produces a Node stack trace
   containing no secret.

**On AC-7.** Independently consistent — no `.vercel/`, no `.github/`, no credentials, `git
remote -v` empty. Not attempted, correctly. No finding.

## One consequence worth routing beyond this TASK

Finding 3's recommended fix (invoke `assert:no-secrets` from `vercel.json`'s `buildCommand`)
**partly reframes the F-084 split.** The split assumed the invocation must live under
`.github/**` and therefore in TASK-002. A second invocation inside `vercel.json` — which is in
TASK-004's paths — is strictly better positioned than the CI one, because it inspects the
artifact that is actually published, with the real project variables, and fails the deploy
rather than a build of a different copy. The CI invocation is still worth having as the earlier
signal; the point is that the deploy-side one is the load-bearing one and currently does not
exist.

## Dependencies reviewed

None. The diff adds no package, bumps nothing, and touches no lockfile. The script imports only
`node:fs/promises` and `node:path`. `pnpm-lock.yaml` is unmodified, correctly — the diff would
otherwise contradict its own `--frozen-lockfile`.
