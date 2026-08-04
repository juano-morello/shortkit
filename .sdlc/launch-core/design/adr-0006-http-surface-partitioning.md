---
id: ADR-0006
slug: launch-core
title: One deployable serving three URL surfaces, split by an /api prefix
status: accepted
supersedes: null
date: 2026-08-04
---

## Context

GC-7 allows one backend deployable. That deployable serves three things that share a
hostname space: the management API, Better Auth's own routes, and the redirect's
`GET /:slug`. A catch-all single-segment route swallows every path the other two do
not claim, so `GET /health` and `GET /links` would resolve as slugs the moment the
redirect module registers.

AC-6 fixes `GET /health` at the root. TASK-024 has to publish a reserved-slug list and
AC-40 tests it. Every reserved word is a slug an operator cannot have, so the list
should be short for product reasons and complete for correctness reasons. Those pull
against each other, and the routing layout decides how hard.

Better Auth mounts at `/api/auth/*` by convention, and its JWKS and token endpoints
live under the same prefix.

## Decision

**A global prefix, with one exclusion.**

```ts
app.setGlobalPrefix('api', { exclude: [{ path: 'health', method: RequestMethod.GET }] });
```

Every controller in the application answers under `/api/...`. `GET /health` stays at
the root, which AC-6 requires. Better Auth mounts on the raw Express instance at
`/api/auth/*`, ahead of Nest (ADR-0013), so the global prefix does not apply to it and
its own path convention is preserved.

**The redirect controller opts out of the prefix.**

```ts
@Controller({ path: '/', version: VERSION_NEUTRAL })
export class RedirectController {
  @Public()
  @Get(':slug')
  resolve(...) {}
}
```

registered through a module whose routes are excluded from the prefix. It is the last
matching route in the stack, so `/api/*` and `/health` win by specificity.

**No host gating.** A request for `GET /abc` arriving on the API hostname reaches the
redirect controller, fails hostname resolution, and returns the default 404. That is
correct behaviour, costs one Redis lookup, and removes a whole class of configuration.

**The reserved-slug list is therefore short and fixed.** It lives in
`packages/contracts/src/slug.ts` as the single source of truth:

```
api  health  robots.txt  favicon.ico  .well-known  _static
admin  login  signup  verify  invite  settings  support  status  terms  privacy
```

The first six are structural: a slug matching one of them would shadow a real path or
a platform convention. The rest are brand protection, chosen once so that a later
marketing page at `shortkit.app/pricing` does not have to reclaim a slug an operator
already owns. Comparison is case-insensitive.

**The web app is a fourth surface on a different origin.** Vercel serves the
dashboard and the marketing page; it never serves a redirect and never serves `/api`
from Nest directly. See ADR-0014.

## Alternatives considered

| Option | Pros | Cons | Why not |
|---|---|---|---|
| No prefix; register the redirect route last and reserve every API top-level segment | Cleanest URLs (`/links` rather than `/api/links`) | The reserved list grows with every feature. Adding `POST /reports` in SP7 silently steals the slug `reports` from every operator who already owns it, and there is no migration for a slug that is already printed on a client's collateral | Couples the operator-visible slug namespace to internal route naming forever |
| Host-based routing: the redirect module only matches on a registered redirect hostname, the API only on `api.<apex>` | Complete separation; zero reserved words needed | Requires a registered apex domain, which is an unresolved open question blocking three TASKs. It also makes local development and CI need hostname aliasing, and it puts a hostname lookup in front of `/health` | Cannot be built or tested today, and the apex question is Juano's, not Design's |
| Two deployables, one for redirects and one for the API | Total isolation; independent scaling of the hot path | GC-7 forbids it | Ruled out by an approved constraint |
| Version the API at `/api/v1` from day one | Room to break contracts later | Nothing consumes the API except `apps/web`, shipped from the same repository at the same commit. A version segment now is a guess about a compatibility problem that does not exist | Speculative. ADR-0005's versioning stance covers this |

## Consequences

### Positive

- The reserved list is 16 entries and stops growing with the feature set. Adding
  `POST /api/reports` later steals nothing.
- Route precedence is decided by one prefix rule rather than by registration order
  across many modules, so a module registered in the wrong place in `AppModule`
  cannot shadow the redirect or be shadowed by it.
- `/health` at the root keeps AC-6 literal and keeps Fly's health check independent of
  the API surface.

### Negative / accepted cost

- Every API URL carries `/api`, including in the web client's base URL and in every
  error message and log line. It reads as redundant on a hostname that already only
  serves the API.
- `GET /api-something-i-made-up` on the API host returns a branded 404 from the
  redirect module rather than a 404 from the API. An operator debugging a typo in an
  endpoint name gets a confusing page.
- The exclusion list in `setGlobalPrefix` is a second place routing behaviour is
  configured. Someone adding a second root-level route has to know it exists.
- `.well-known` is reserved, so an operator cannot create a slug matching it. That is
  required for ACME and platform verification and cannot be given back.

### Follow-ups this creates

- TASK-001 sets the global prefix and the exclusion in `main.ts`.
- TASK-003 verifies `GET /health` resolves at the root after the prefix is set.
- TASK-004 and TASK-008 set `NEXT_PUBLIC_API_BASE_URL` and the server-side base URL to
  include `/api`.
- TASK-024 imports the reserved list from `packages/contracts`; it does not redeclare
  it.
- TASK-029 registers the redirect controller outside the prefix and asserts in a test
  that `GET /health` and `GET /api/links` do not reach it.
