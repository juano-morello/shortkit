---
id: TASK-012
story: STORY-005
epic: EPIC-002
title: Web signup, login, and verification screens
status: todo
owner_slot: sdlc-implementer-frontend
depends_on: [TASK-008, TASK-009, TASK-010]
paths: ["apps/web/app/(auth)/**", "apps/web/src/lib/session/**"]
contracts: [design/contracts/auth-tokens.md, design/contracts/error-envelope.md, design/contracts/web-api-client.md]
test_files: []
acceptance: [AC-16, AC-18, AC-19, AC-20, AC-21]
rework_count: 0
---

## Intent

The operator's entry into the product.

## Approach

Token storage and refresh handled in one place; unverified users are shown what to do next rather than a raw 403; copy is human-facing prose (GC-12). **Never place a JWT or refresh token anywhere client JavaScript can read it.**

## Out of scope for this TASK

Invitation accept screen (TASK-022), workspace UI (TASK-015), landing page (TASK-057).

## Interfaces

**Consumes**

`apiClient`, `ApiError`, `<ErrorMessage />` (TASK-008); `signupContract`, `loginContract`, `sessionContract` (TASK-009); `verificationContract` (TASK-010).

**Produces**

Routes `/signup`, `/login`, `/verify`; `useSession()` → `{ user, status }`; `requireAuth()` route guard used by every authenticated screen.

## ⚠ F-157 routed here 2026-08-05 (ruled by Juano) — render-time secret containment is yours

`sdlc-security-auditor` reproduced, against this repo's actual `apps/web`, a leak that **no
build-output scan can ever catch**. TASK-004's AC-113 guard scans build output; with
`export const dynamic = 'force-dynamic'` on a page, a server component reading
`process.env.BFF_PROXY_SECRET` and passing it as a prop to a `'use client'` component puts the
value **nowhere on disk under `.next` at all** — the guard prints OK and exits 0 — while
`curl -s http://host/` returns the secret in the HTML body twice.

**This is not an edge case for you, it is your normal path.** Every dashboard route in ADR-0014
reads `cookies()` for `sk_at` and is therefore dynamic by definition. You own `serverApiClient()`
and the BFF proxy, so you own the read sites where `BFF_PROXY_SECRET` and `sk_at` actually enter
the render tree. The entire authenticated surface is invisible to TASK-004's control, and always
will be — that control's ceiling is now stated on its card rather than left implied.

**What you must land:** `experimental_taintUniqueValue` applied to `BFF_PROXY_SECRET` and to the
`sk_at` cookie value **at their single read sites**, so React throws at *render* time when either
value crosses into a client component, on any route type. `import 'server-only'` on the module is
a useful complement — it stops an accidental client import of the module — but it does **not**
stop the prop path, which is the one that was reproduced. Both, not either.

`sdlc-architect` is amending ADR-0014 to make this normative rather than one implementer's habit;
read the amendment before you start.

**Why it is worth this much prose on your card:** `BFF_PROXY_SECRET` is what the API's
constant-time match trusts before honouring `x-shortkit-client-ip`. Published to a browser, it
lets anyone forge that header and collapse all four IP-keyed rate-limit buckets into one shared
bucket product-wide. This is the third distinct route the initiative has found to that same
outage — ADR-0014's own Design-round-4 self-finding, then F-078, now F-157.
