---
id: TASK-013
story: STORY-004
epic: EPIC-001
title: Workspace list, create, rename and archive in the browser
status: todo
owner_slot: sdlc-implementer-frontend
depends_on: [TASK-007, TASK-012]
paths: ["apps/web/app/(app)/**", "apps/web/src/components/workspaces/**"]
contracts: [design/contracts/workspaces.md, design/contracts/error-envelope.md]
test_files: ["apps/web/app/(app)/workspaces/workspaces.spec.tsx (unit)", "apps/web/src/components/workspaces/workspace-list.spec.tsx (unit)"]
acceptance: [AC-27]
rework_count: 0
---

## Intent

The screen an operator lands on after signup: their client workspaces, and a way to add one.

## Approach

One protected route under an `(app)` route group showing the caller's workspaces, with a
create control, a rename control per workspace and an archive control per workspace. It is
the redirect target of a successful **sign-in** (TASK-008) and the screen AC-19's
unauthenticated request must be bounced away from.

> **NO LONGER THE REDIRECT TARGET OF SIGNUP — corrected 2026-08-15, Design wave 2, Juano's
> ruling.** ADR-0061 sets `emailAndPassword.autoSignIn: false` to close an unauthenticated
> user-enumeration oracle, so signup no longer establishes a session and TASK-008's signup route
> lands on the sign-in screen with a confirmation instead. A new operator reaches this screen on
> their **second** step, not their first.
>
> **The empty state below is unaffected and still the first thing most operators see** — they
> arrive here right after signing in, with a tenant and no workspaces. What changes is only how
> they got here.

**Protection is server-side.** `requireAuth()` (TASK-007) redirects a visitor with no
session to the sign-in screen. **Do not render the page and hide it** — a page that renders
with workspace data and then hides it has already put another tenant's-worth of data in a
response body, which is the failure mode this whole initiative is measured on.

**The empty state is the first thing most operators will see**, because signup creates a
tenant with no workspaces. It has to say what a workspace is for and offer the create
control, not show an empty table.

**Archived workspaces are hidden by default** and reachable through an explicit control.
AC-23's API-side behaviour is that the default list excludes them and an explicit request
includes them; this screen exposes that switch rather than filtering client-side, so the two
sides agree about what "archived" means.

**AC-27 requires a newly created workspace to appear without a manual reload.** Whether that
is a router refresh, an optimistic insert, or a re-fetch is Design's call. If it is optimistic,
a failed create must remove the optimistic row and show the error, or the operator sees a
workspace that does not exist.

**Error copy is driven by `code`.** The envelope is `{ code, message, details? }` and
`details` is keyed by the first path segment of the failing field — so a name that violates
the contract shows its message against the name input rather than as a page-level banner.

**Nothing here may hold a token.** The session lives in `HttpOnly` cookies written on the
server (TASK-007); this screen reaches the API through the transport that TASK owns and never
reads a credential.

## Out of scope for this TASK

The signup and sign-in screens (TASK-008). The session module and transport (TASK-007). Any
`apps/api` or `packages/contracts` file. A workspace switcher, a workspace detail page,
per-workspace settings, member lists, invitations — all of that is item 1b or later. Any
change to `apps/web/app/layout.tsx`, `apps/web/app/page.tsx` or `apps/web/app/not-found.tsx`.

## Interfaces

**Consumes**

From TASK-007:
- `requireAuth()` — redirects to the sign-in screen when no session is held
- `useSession()`
- `serverApiClient<TRes>(req: ApiRequest<TRes>): Promise<TRes>`
- `mapBetterAuthError(status: number, body: unknown): ApiError`

From TASK-012 (`@shortkit/contracts`, imported as TypeScript source):
- `workspaceContract`, `type Workspace`
- `createWorkspaceRequestContract` — `{ name: string }`
- `renameWorkspaceRequestContract` — `{ name: string }`
- `listWorkspacesQueryContract` — `{ includeArchived?: boolean }`
- `workspaceListResponseContract`
- `errorEnvelopeContract`, `ERROR_CODE_STATUS`, `toValidationDetails`

From TASK-012 (over HTTP): the four authenticated workspace routes, under the `/api` global
prefix, at the paths `design/contracts/workspaces.md` fixes.

From `apps/web/src/lib/api/client.ts` (shipped): `apiClient`, `ApiError`, `NetworkError`,
`CLIENT_MESSAGES`.

**Produces**

- `apps/web/app/(app)/workspaces/page.tsx` — the workspace list screen; the redirect target
  of a successful signup and sign-in, and the route AC-19 and AC-27 are measured against
- `apps/web/src/components/workspaces/workspace-list.tsx` — the list, its empty state, and
  the archived-visibility switch
- `apps/web/src/components/workspaces/create-workspace-form.tsx` — the create control, with
  field-level validation messages keyed by `toValidationDetails`
