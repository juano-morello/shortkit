---
id: TASK-008
story: STORY-003
epic: EPIC-001
title: Signup and sign-in screens
status: todo
owner_slot: sdlc-implementer-frontend
depends_on: [TASK-001, TASK-007]
paths: ["apps/web/app/(auth)/**", "apps/web/src/components/auth/**"]
contracts: [design/contracts/auth-tokens.md, design/contracts/error-envelope.md]
test_files: ["apps/web/app/(auth)/signup/signup.spec.tsx (unit)", "apps/web/app/(auth)/sign-in/sign-in.spec.tsx (unit)"]
acceptance: [AC-16, AC-17]
rework_count: 0
---

## Intent

Two screens an operator can complete without a terminal: create an account, and come back to
it.

## Approach

Two routes under a shared `(auth)` route group, each a form with an email field, a password
field and a submit control. Signup also takes the name Better Auth requires. On success the
operator lands on the workspace list; on failure they stay put with a message.

**`better-auth@1.6.26` requires `name` on `POST /api/auth/sign-up/email`** — a body without
it answers 400, measured and recorded at `apps/api/test/support/auth-fixture.ts:56-60`. The
signup form therefore has three fields, not two.

**Password policy: there is none stated in this repository, and the floor is the pinned
release's.** `apps/api/test/support/auth-fixture.ts:44-52` records that no artifact — not
ADR-0013, not any contract — states a password policy, and that probing `better-auth@1.6.26`
puts its own floor at 8 characters (7 answers `400 PASSWORD_TOO_SHORT`, 8 is accepted). The
screen must not invent a stricter policy in client-side validation than the contract states,
because a client rule the server does not share is a rule nobody can test at the boundary.
If Design states a policy, the contract carries it and this screen reads it from there.

**Error copy is driven by `code`, not by status.** The envelope is
`{ code: ErrorCode, message: string, details?: unknown }` and `ERROR_CODE_STATUS` is the
normative mapping. A wrong password, a rate limit and a validation failure are three
different codes and get three different messages. `mapBetterAuthError` (TASK-007) is what
turns Better Auth's native body into that envelope — this screen consumes envelopes only and
never parses a Better Auth body itself.

**No credential and no email address may be logged, echoed into a URL, or placed anywhere a
client script can read it.** SC-5 is about the API's log lines and this is its web-side
counterpart: a password in a query string or an email address in an analytics call would be
the same defect one deployable over.

**Do not make the sign-in failure distinguish "no such account" from "wrong password".**
ADR-0013 already accepts that the email-keyed bucket is an enumeration oracle; adding a
second one in the copy is a choice this initiative does not have to make.

A session landed by either screen is set by `setSessionCookies` (TASK-007) on the server.
This screen does not write a cookie and does not hold a token in component state.

## Out of scope for this TASK

The session module, `serverApiClient` and the proxy route (TASK-007). The workspace list and
create screens (TASK-013) — this TASK's success path navigates to the workspace list route,
which TASK-013 owns. Password reset, email verification, social sign-in, magic links. Any
change to `apps/web/app/layout.tsx`, `apps/web/app/page.tsx` or `apps/web/app/not-found.tsx`.

## Interfaces

**Consumes**

From TASK-007:
- `setSessionCookies(...)`, `clearSessionCookies()`, `useSession()`, `requireAuth()`
- `serverApiClient<TRes>(req: ApiRequest<TRes>): Promise<TRes>`
- `mapBetterAuthError(status: number, body: unknown): ApiError`

From TASK-001 (`@shortkit/contracts`):
- `signUpRequestContract` — `{ email: string; password: string; name: string }`
- `signInRequestContract` — `{ email: string; password: string }`
- `authSessionContract`, `type AuthSession`
- `errorEnvelopeContract`, `ERROR_CODES`, `ERROR_CODE_STATUS`
- `toValidationDetails(error: ZodError): ValidationDetails` — for keying a field-level message

From `apps/web/src/lib/api/client.ts` (shipped): `ApiError`, `NetworkError`, `CLIENT_MESSAGES`.

**Produces**

- `apps/web/app/(auth)/signup/page.tsx` — the signup screen, at the route TASK-013's
  "create your first workspace" path returns from and TASK-017's compose check drives
- `apps/web/app/(auth)/sign-in/page.tsx` — the sign-in screen, the redirect target
  `requireAuth()` sends an unauthenticated visitor to
- `apps/web/src/components/auth/credential-form.tsx` — the shared email/password form both
  screens render, with per-field validation messages keyed by `toValidationDetails`
