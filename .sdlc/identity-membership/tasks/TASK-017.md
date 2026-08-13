---
id: TASK-017
story: STORY-004
epic: EPIC-001
title: Signup, sign-in and workspace creation end to end in the compose stack
status: todo
owner_slot: sdlc-implementer-backend
depends_on: [TASK-009, TASK-013]
paths: ["scripts/check-compose-stack.sh"]
contracts: []
test_files: ["scripts/check-compose-stack.sh (compose tier — `pnpm test:compose`, the `compose` gating job in CI)"]
acceptance: [AC-28]
rework_count: 0
---

## Intent

Measure SC-2's sentence end to end: an operator completes signup, sign-in and workspace
creation against `docker compose up`, with no seed data and no manual step.

## Approach

`scripts/check-compose-stack.sh` already brings the stack up and asserts, clause by clause,
that Postgres, the API and the web app reach a healthy state, that the migrations applied,
that the seed ran, and that `GET /health` returns 200 with `status` equal to `"ok"`. This
TASK adds the flow clauses on top of that same instrument, because it is the only one this
repository has that can hold a running stack — `vitest` cannot.

**Each phrase gets its own clause with its own id and its own reason string.** That is the
script's existing discipline and the reason it is worth extending rather than replacing:
"the stack is broken" tells an implementer nothing, while `signup returned 400`,
`sign-in set no session cookie` and `the workspace list did not contain the created
workspace` are three different failures printed as three different lines.

Three new clauses, in order, each against the **web app** rather than against the API
directly, because SC-2's subject is an operator using a browser:

1. sign up with an address that has no account, against a database with **no seed data**;
2. sign in with the same credentials and receive a session;
3. create a workspace and see it in the list.

**No manual step between them**, and no fixture inserted by the script into the database.
The only inputs are HTTP requests of the kind a browser makes.

**Exit code 2 means "could not run, nothing measured" and is never a criterion failure.** The
distinction is written into both the workflow and the script, and a red `compose` job needs
its exit code read before it is diagnosed. No Docker, no node, or a machine that is not the
machine this check describes are all 2, not 1.

**If the first run is red environmentally, do not weaken the script.** The recorded repair is
to remove `compose` from `gate`'s **three** lists — `needs`, `env:`, and the assertion loop —
and leave the job visible. A job named in fewer than all three blocks nothing, so all three
move together or the change is a no-op that reads like a fix. This check has never been
observed on a GitHub runner; disk for four cold-built images is the item that could least be
verified locally.

**It does not assert the `commit` field of `/health`**, and this TASK must not add that: a
bare `docker compose up` builds with `GIT_COMMIT_SHA` defaulted to the git null object id
under ADR-0037, which is accepted and correct.

**`better-auth@1.6.26` answers a state-changing auth request with no `Origin` header with
`403 MISSING_OR_NULL_ORIGIN`.** A browser always sends one; `curl` does not. Clause 1 will
fail with a 403 that looks like an auth defect unless the request carries one.

**The residual, stated rather than closed: this is not a browser.** No tier in this
repository drives one — `config.yaml` names unit, integration and compose, and none of them
opens a page. These clauses measure the transport a browser uses. Whether to add a browser
driver is a Design decision, listed in the plan, and until one exists AC-28 is the strongest
evidence available for SC-2.

## Out of scope for this TASK

The compose file and the environment declarations (TASK-009 — this TASK reads that stack and
does not edit it). Any application code. Any `.github/workflows/ci.yml` change, including
adding a job. Weakening any existing clause. Asserting the `commit` field. Adding a browser
driver or a new test tier.

## Interfaces

**Consumes**

From TASK-009: `docker-compose.yml` with the `api` service's auth environment declared, the
`web` service's API base URL, and **neither trust boundary declared**; `apps/api/.env.example`
and `apps/web/.env.example`.

From TASK-013 (over HTTP): the workspace list screen and its create control, at the routes
that TASK owns.
From TASK-008 (over HTTP): the signup and sign-in screens.
From TASK-012 (over HTTP): the four authenticated workspace routes.

From the shipped script: its clause table, its three exit codes, its service-name list from
ADR-0036's ordering table, and `pnpm test:compose` as the root-level entry point.

**Produces**

- `scripts/check-compose-stack.sh` — three added clauses, each with its own id and reason
  string: signup against an empty database succeeds; sign-in with those credentials returns a
  session; a workspace created through the web app appears in the list. Exit codes unchanged:
  0 all clauses passed, 1 at least one clause red, 2 nothing measured.
