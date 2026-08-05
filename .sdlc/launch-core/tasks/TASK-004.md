---
id: TASK-004
story: STORY-002
epic: EPIC-001
title: Web deployable on Vercel
status: tests-red
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
