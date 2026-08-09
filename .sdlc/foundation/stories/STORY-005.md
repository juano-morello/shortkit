---
id: STORY-005
epic: EPIC-002
title: Signup, login, and email verification
status: deferred
tasks: [TASK-009, TASK-010, TASK-011, TASK-012, TASK-058]
depends_on: [STORY-003, STORY-004]
---

## User story

As an agency operator, I sign up with my work email, verify it, and log in, so that I have an account.

## Acceptance criteria

- [ ] AC-16: Given a visitor submits a valid, unused email and a password meeting the stated policy, when signup completes, then an account exists in an unverified state and exactly one verification email is dispatched to that address.
- [ ] AC-17: Given an existing unverified account, when it presents a valid session to any authenticated API endpoint, then the response is 403 with error `code` `email_not_verified`.
- [ ] AC-18: Given an unexpired verification token, when the verification link is opened, then the account becomes verified and a subsequent authenticated API call returns 200.
- [ ] AC-19: Given a verification token that has already been consumed or has expired, when the verification link is opened, then verification fails with a distinct error and the account's verified state is unchanged.
- [ ] AC-20: Given correct credentials for a verified account, when login is submitted, then a session/JWT is issued; given incorrect credentials, then the response is 401 and no session is issued.
- [ ] AC-21: Given an authenticated session, when logout is invoked, then a subsequent request using the prior credential is rejected with 401.

- [ ] AC-108 **(added 2026-08-04, Design F-025)**: Given six sign-in attempts for one email address arriving from six different client IPs, when the sixth is submitted, then it is rejected with 429 carrying `retryAfterSeconds`.
- [ ] AC-109 **(added 2026-08-04, Design F-025)**: Given those same six attempts with the address case-varied and whitespace-padded, when the sixth is submitted, then it is still rejected with 429 — the key normalises case and whitespace and nothing else.
- [ ] AC-110 **(added 2026-08-04, Design F-025)**: Given a different email address submitted from those same six IPs, when it is submitted, then it succeeds — the bucket is keyed on the address, not on the set of IPs.
- [ ] AC-111 **(added 2026-08-04, Design F-024)**: Given a request to `/api/auth/*` whose body exceeds the configured cap, when it is submitted, then it is rejected without the body having been parsed.
- [ ] AC-112 **(added 2026-08-04, Test F-050)**: Given `apps/api/package.json`, when its `better-auth` specifier is read, then it is an exact version carrying no range character (`^`, `~`, `>`, `<`, `*` or `x`); and given TASK-009's report, then it records the four Better Auth facts of ADR-0018 verified against that exact release.

AC-108 exists to convert an unverified framework assumption into a checked one:
if Better Auth's `ctx.path` is not base-path-relative, the hook's predicate never
matches and the email bucket silently does not exist. That is a fail-open, and no
other AC would notice.

Each AC is objectively verifiable. `sdlc-test-architect` turns these into tests
and `sdlc-product-auditor` verifies against them verbatim.

## Definition of Ready

**PASS with a design dependency.** The email provider is undecided and explicitly non-blocking: TASK-010's adapter is fakeable, so tests do not wait on it. Better Auth inside NestJS is a named risk in `refinement.md` — escalate to a timeboxed spike if it resists rather than improvising.

- [x] ACs are testable and unambiguous
- [x] Dependencies identified
- [ ] Contracts it consumes exist in `design/contracts/` — Design has not run yet
- [x] No blocking open questions

## Definition of Done
- [ ] All ACs green as automated tests
- [ ] All auditors clear of blocker/major
- [ ] Docs updated (README / API / ADR consequences)
- [ ] Observability in place per config
- [ ] Traceable: commits reference TASK ids

**AC-112 added 2026-08-04 (F-050, ruled by Juano).** F-040 moved the `better-auth`
exact pin and its four-fact re-verification from TASK-001 to TASK-009, but left the
obligation as prose in TASK-009's Approach. `sdlc-product-auditor` verifies ACs verbatim,
so nothing would have checked it: an implementer could write `"better-auth": "^1.x"`,
every AC would pass, and a transitive bump could weaken auth with no code change while
the four facts went unchecked. This AC is the gate that makes F-040's fix hold. STORY-005
now has 11 ACs.
