---
id: STORY-003
epic: EPIC-001
title: An operator signs up and signs in in a browser
status: planned
tasks: [TASK-007, TASK-008, TASK-009, TASK-010]
depends_on: [STORY-001]
---

## User story

As an agency operator who has never used a terminal, I want to create my account and sign
back into it from a web page, so that shortkit is something I can actually use rather than
an API I would have to `curl`.

## Acceptance criteria

- [ ] AC-16: Given the signup screen in a browser, when the operator submits an email address that has no account and a password meeting the policy, then the browser ends on the workspace list screen and a subsequent page load without re-entering credentials still shows it.
- [ ] AC-17: Given the sign-in screen and an account that exists, when the operator submits the correct email address with a wrong password, then the screen shows a sign-in failure message, the operator stays on the sign-in screen, and no session cookie is set on the response.
- [ ] AC-18: Given a successful sign-in, when the `Set-Cookie` headers on the response are inspected, then every cookie carrying a session credential is marked `HttpOnly` and `SameSite=Lax`, and no credential value is present in any script-readable location in the returned document.
- [ ] AC-19: Given a browser holding no session, when the workspace list URL is requested, then the response redirects to the sign-in screen and no workspace data is present in the response body.
- [ ] AC-20: Given a machine with only Docker and a clone of this repository, when `docker compose up` is run at the repository root with no additional environment file authored by hand, then the API boots with the auth surface mounted, the migrations have been applied, and a signup request issued through the web app answers 200 — with no seed data and no manual step.
- [ ] AC-36: Given `pnpm assert:stub-drift`, when it runs after a source file exists at the path of a surviving stub under an enforced prefix, then it compares at least one gating pair, prints the number of pairs it compared, and exits 0.

## Definition of Ready

**PASS with one concern.** AC-16 through AC-19 are browser-observable; AC-20 is measured by
a shell check against the composed stack, the same instrument `scripts/check-compose-stack.sh`
already is; AC-36 is measured by running an existing script.

- [x] ACs are testable and unambiguous
- [x] Dependencies identified — needs STORY-001's auth surface
- [ ] Contracts it consumes exist in `design/contracts/` — Design has not run
- [x] No blocking open questions — `refinement.md` records the cookie-versus-bearer question as Design's and non-blocking

**Concern — this repository has no browser-driving test tier.** `config.yaml`'s `testing:`
block names three commands: `pnpm test` (unit, `*.spec.ts`), `pnpm test:integration`
(`*.int-spec.ts`) and `pnpm test:compose`. None of them opens a browser. AC-16 through AC-19
are therefore measured at the transport a browser uses — the web app's own routes and the
`Set-Cookie` headers they return — rather than by driving a real browser, and AC-20 is
measured over HTTP against the composed stack. **The residual is real and is stated rather
than closed**: nothing in this plan proves that a human with a mouse can complete the flow.
Whether to add a browser driver is a Design decision, listed in the plan.

## Definition of Done

- [ ] All ACs green as automated tests
- [ ] All auditors clear of blocker/major
- [ ] Docs updated (README / API / ADR consequences)
- [ ] Observability in place per config
- [ ] Traceable: commits reference TASK ids
