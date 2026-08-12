---
id: TASK-004
story: STORY-002
epic: EPIC-001
title: Web deployable on Vercel
status: done
test_exempt: true
test_exempt_reason: >-
  AC-7 has no red step available. The tempting in-process proxy — render app/page.tsx and
  assert HTML — PASSES TODAY, because TASK-001 already shipped page.tsx and layout.tsx, and a
  test that cannot go red proves nothing. It would also report green through a 404 from a wrong
  monorepo root directory, a 500 from missing build-time env, or a 401 from Vercel deployment
  protection, which is on by default. test-strategy.md already lists deployment under
  "Deliberately not automated". Ruled by Juano 2026-08-05. AC-7 is verified by
  sdlc-product-auditor hitting the deployed URL; AC-113 is a CI build-output assertion.
owner_slot: sdlc-implementer-frontend
depends_on: [TASK-001]
paths: ["apps/web/**", "vercel.json"]
contracts: []
test_files: []
acceptance: [AC-7, AC-113]
rework_count: 0
---

## Intent

Get the Next.js deployable serving on the internet.

## Approach

One frontend deployable (GC-7); Vercel free tier (GC-3); App Router.

## Out of scope for this TASK

Apex-domain binding — blocked on the unresolved apex-domain question, so this ships on the Vercel-provided hostname and is rebound later. Landing page content (TASK-057), auth screens.

## Interfaces

**Consumes**

`apps/web` workspace (TASK-001).

**Produces**

Deployed web base URL; root layout at `apps/web/app/layout.tsx`; environment variable `NEXT_PUBLIC_API_BASE_URL`.

**Amended 2026-08-04 (Design round 5).** ADR-0014's backend-for-frontend topology adds two **server-only** variables this TASK must also register: `API_BASE_URL` (the Fly origin the proxy calls, never exposed to the browser) and `BFF_PROXY_SECRET` (shared with the Fly side; the API honours a forwarded client address only on a constant-time match). **Neither may carry the `NEXT_PUBLIC_` prefix** — that prefix inlines a value into the client bundle, which would publish the secret. `BFF_PROXY_SECRET` is never logged on the Vercel side.

## ⚠ AC-113 added 2026-08-05 (F-078, ruled by Juano)

**AC-113: no server-only value may appear in the built client bundle.** The check searches
`.next/static/**` for the values of `BFF_PROXY_SECRET` and `API_BASE_URL` and fails CI if
either is present.

### ⚠ Split 2026-08-05 (F-084, ruled by Juano) — this TASK owns the check, not the invocation

The pre-flight conflict scan found that AC-113 as minted was undeliverable by this TASK alone:
it says "fails the CI workflow", and every workflow lives under `.github/**`, which is
TASK-002's paths list. Ruled as a split.

**This TASK produces:**

- `apps/web/scripts/assert-no-inlined-secrets.mjs` — reads `BFF_PROXY_SECRET` and
  `API_BASE_URL` from the environment, searches `.next/static/**` for their **values**, and
  exits non-zero naming the file and the variable if either appears. It searches for values
  rather than variable names, because the `NEXT_PUBLIC_` inlining this guards against
  substitutes the value and leaves no name behind.
- an `assert:no-secrets` script in `apps/web/package.json` that invokes it.

**TASK-002 produces the workflow steps that build `apps/web` and run it.** Neither half fails
CI on its own. The variable list lives here, next to where this TASK registers the variables,
so a third server-only variable added later updates one file rather than a workflow in another
TASK's territory.

A guard on this TASK's own work: the script must exit non-zero when a secret **is** present.
Verify that directly by building once with the value deliberately inlined, rather than
reasoning it from a clean build that finds nothing — a check that never fires and a check that
cannot fire are indistinguishable from a green run.

The Design-round-5 amendment in this TASK's Produces block already forbids the
`NEXT_PUBLIC_` prefix on both variables, and `design/contracts/web-api-client.md` calls
`BFF_PROXY_SECRET` required and server-only — but STORY-002 contained no AC mentioning
environment variables at all, so a build inlining the secret into the client bundle satisfied
AC-7 and every other criterion. `sdlc-product-auditor` verifies ACs verbatim, so the
prohibition had nothing to attach to.

Why it is worth an AC rather than a code comment: `BFF_PROXY_SECRET` is what the API's
constant-time match trusts before honouring a forwarded client address. Published to every
browser, it lets anyone forge `X-Shortkit-Client-IP`, which collapses all four IP-keyed
rate-limit buckets — the same product-wide outage the architect self-found in Design round 4,
arrived at from the opposite direction.

## ⚠ Transcription gap closed 2026-08-05 — ADR-0006's `/api` obligation

`design/adr-0006-http-surface-partitioning.md:112-113` reads: "TASK-004 and TASK-008 set
`NEXT_PUBLIC_API_BASE_URL` and the server-side base URL to include `/api`." **That obligation
was never restated on this card.** Found by `sdlc-scout` and verified at source by the
orchestrator.

Recorded here as a transcription of a decision the Design gate already approved, not as a new
one — the F-053 / F-076 mechanical class. Both `NEXT_PUBLIC_API_BASE_URL` and `API_BASE_URL`
carry the `/api` suffix; the API sets that global prefix in `main.ts` (TASK-001) and TASK-029
registers the redirect controller *outside* it, so a base URL missing `/api` reaches the
redirect surface rather than the JSON one.

## ⛔ AC-7 IS BLOCKED — deployment needs Juano's account, not code

`sdlc-scout` checked and the orchestrator confirmed at source: **no `vercel.json`, no
`.vercel/`, no Vercel token, org id or project id anywhere in the repo, no `.github/`, and
`git remote -v` returns nothing — this repository has no remote at all.**

AC-7 requires a *deployed* Vercel URL that `sdlc-product-auditor` verifies by hitting it.
That cannot be produced from inside the repository under any implementation. It needs Juano's
Vercel account and a git remote to deploy from, and deploying is an outward-facing action that
is his to authorise regardless.

**Consequence for this TASK:** the buildable half ships and is auditable now — `vercel.json`,
the three environment-variable registrations, `apps/web/scripts/assert-no-inlined-secrets.mjs`
and its `assert:no-secrets` entry. **AC-7 stays open and TASK-004 cannot reach `done`** until
the deployment exists. AC-113 is fully verifiable now and must be, including the negative case
the card already demands: build once with the value deliberately inlined and confirm the script
exits non-zero, because a check that never fires and a check that cannot fire look identical on
a green run.

**The same blocker reaches further than this TASK.** With no git remote, TASK-002's CI workflow
also has nothing to run on. That is a launch-core-wide prerequisite, not a TASK-004 detail.

## ⚠ AC-113 AMENDED 2026-08-05 (F-154, ruled by Juano) — `API_BASE_URL` is no longer a target

AC-113 as minted by F-078 said the check searches for the values of **both**
`BFF_PROXY_SECRET` and `API_BASE_URL`. **It now searches for `BFF_PROXY_SECRET` only.**

**Why the original wording could not stand.** `sdlc-reviewer` and `sdlc-security-auditor`
independently reproduced the same failure by building: `.env.example` gives
`NEXT_PUBLIC_API_BASE_URL` and `API_BASE_URL` the identical value — ADR-0006 and ADR-0014 route
both to the same Fly origin with the same `/api` suffix, so that is the documented operational
configuration, not an accident. The check does a raw substring search with no way to attribute a
match to which variable's *read* produced it. So the moment TASK-008 reads
`NEXT_PUBLIC_API_BASE_URL` in client code — that variable's entire purpose — Next inlines it
exactly as designed and the check reports `API_BASE_URL` as leaked, on a build with nothing
wrong with it, permanently, with no code change in `apps/web` able to clear it.

**Why dropping it rather than working around it.** `API_BASE_URL` **is not confidential**. It is
the public Fly hostname, committed in cleartext in `.env.example` and discoverable from any
redirect. Checking it buys no confidentiality. What it costs is the guard's credibility: an
unfixable red on a correct build gets resolved by loosening the check, and the cheapest loosening
anyone reaches for — match only if the value is long enough, or not a URL, or skip chunks — then
applies to `BFF_PROXY_SECRET` too. `BFF_PROXY_SECRET` has no legitimate public counterpart and
does not share this problem.

**Consequence for the script:** `BFF_PROXY_SECRET` is the sole leak target, and F-156's positive
control becomes coherent — asserting `NEXT_PUBLIC_API_BASE_URL`'s value **is** present is now the
proof that build and check saw the same environment, with nothing contradicting it. The script
header must record *why* `API_BASE_URL` is excluded, or a future reader will "fix" it back and
reintroduce the permanent red.

## ⚠ F-157 ROUTED OUT 2026-08-05 (ruled by Juano) — the render-time half is TASK-012's

`sdlc-security-auditor` reproduced a leak that **no build-output scan can ever catch**: with
`export const dynamic = 'force-dynamic'`, a server-component-prop leak puts the secret nowhere on
disk under `.next` at all, while `curl` returns it in the HTML body. Every dashboard route in
ADR-0014 reads `cookies()` for `sk_at` and is therefore dynamic by definition — so the **entire
authenticated surface**, the one that will actually handle `BFF_PROXY_SECRET`, is structurally
invisible to this control even after F-155's widening lands.

**TASK-004 owns the ceiling statement, not the remedy.** The script header and this card must say
plainly that this control covers **build-time inlining and prerendered output only, not
per-request server render** — because the danger the auditor named is the overclaim: an
implementer reads AC-113 as "we have a control for this" and ships a server-to-client prop on a
dynamic route with green CI.

**The remedy is TASK-012's, with an ADR-0014 amendment making it normative:**
`experimental_taintUniqueValue` applied to `BFF_PROXY_SECRET` and to the `sk_at` cookie value at
their single read sites, which throws at *render* time when either crosses into a client
component on any route type. `import 'server-only'` is a useful complement but does not stop the
prop path. TASK-012 owns `serverApiClient()` and the proxy, so it owns those read sites.

## ⚠ F-166 — the three variables must be registered for Preview and Development too

Recorded by the orchestrator 2026-08-05 from `sdlc-security-auditor`'s round-2 audit, because
nothing in the repo said it and `tasks/**` is not an implementer's path.

`vercel.json`'s `buildCommand` now chains `assert:no-secrets`, and that check **hard-fails when
`BFF_PROXY_SECRET` is unset** — the correct posture, and what F-156 asked for. But Vercel scopes
project environment variables **per environment**, and the common default is to register a secret
for Production only. Every preview deploy then dies at `BFF_PROXY_SECRET is not set` in the build
step, on a branch with nothing wrong with it.

**Register all three — `NEXT_PUBLIC_API_BASE_URL`, `API_BASE_URL`, `BFF_PROXY_SECRET` — for
Production, Preview and Development.** Preview may use a distinct throwaway `BFF_PROXY_SECRET`
as long as the Fly side accepts it.

Worth stating why this is on the card rather than in the ledger: it is the **same
remediation-pressure shape as F-154 and F-161**, which between them cost two fix rounds. The
person unblocking previews reaches for the cheapest cut in reach, and the cheapest cut is deleting
the `&& assert:no-secrets` chain. Three findings on this TASK have now had that identical shape —
a control that is correct, that reds something the operator urgently wants green, and whose
removal is one edit away.
