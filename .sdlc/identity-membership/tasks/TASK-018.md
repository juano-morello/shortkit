---
id: TASK-018
story: STORY-003
epic: EPIC-001
title: Provision shortkit_auth across all three role-creation sites before any migration grants to it
status: todo
owner_slot: sdlc-implementer-backend
depends_on: []
paths: [".github/scripts/provision-test-database.sql", "docker-compose.yml", "docker-compose.test.yml", "apps/api/test/support/rls-fixture.ts", "apps/api/test/support/auth-fixture.ts", "apps/api/scripts/seed.mts"]
contracts: [design/contracts/rls-policy-template.md]
test_files: ["apps/api/test/tenancy/tenant-context.int-spec.ts (integration, existing — runs against a three-role database; not edited here)", "pnpm db:check-policies (quality gate, TASK-002 writes the grant-matrix assertion it will run)"]
acceptance: []
rework_count: 0
---

<!--
CREATED 2026-08-13 at the Design wave-1 gate, round 4, by Juano's ruling on F-032 and
ADR-0050's escalation of three unowned artifacts. WAVE 0 — a new wave ahead of the nine the
Plan gate approved, chosen over renumbering so that `design.wave_1` and every other recorded
wave reference keeps meaning what it means today.

THIS TASK CLAIMS NO AC, and that is a gap rather than a decision. The role split arrived from
F-024 after the plan's 36 ACs were written and there is no criterion that describes it. The
honest alternatives were an AC added to STORY-003 — which amends an approved artifact and is
Juano's call, not mine — or this. Flagged at the gate rather than papered over.

CORRECTED 2026-08-13, round-4 re-review: this card originally cited TASK-010 as the precedent
for a chore with no AC. THAT WAS WRONG — TASK-010 claims AC-36, and TASK-018 is the only card
of eighteen with an empty list. There is no precedent. The re-review judged the gap NOT
load-bearing on its own terms: a skipped TASK-018 fails loudly one wave later at the
migration's GRANT, and the widened CI guard plus assertAuthRoleSeparation catch the state it
would leave. Kept on that reasoning, not on a precedent that does not exist.

SCOPE IS WIDER THAN THE ESCALATION SAID. ADR-0050 and F-032 name three artifacts. Role
creation actually lives in THREE PLACES and two of them are neither of those:
docker-compose.yml:320 and docker-compose.test.yml:122 each carry their own inline CREATE ROLE
block. The escalation enumerated what was visible from the ADR; this card is written from the
repository.
-->

## Intent

**Marked config chore, and it is the one that has to land first.** Create `shortkit_auth`
everywhere `shortkit_app` and `shortkit_migrator` are created, so that TASK-002's migration
`0001` has a role to grant to. Nothing here reads or writes application data.

## Approach

**Ordering is the whole point of this TASK existing separately.** TASK-002's migration `0001`
issues `GRANT ... ON "user","session","account","verification","jwks" TO shortkit_auth`. If
the role does not exist at migration time that statement fails with `role "shortkit_auth"
does not exist`, and it fails inside a forward-only migration (ADR-0004) on a database that
has already applied `0000`. This TASK is wave 0 for that reason and for no other.

**Three creation sites, and they are not copies of one file.**

1. `.github/scripts/provision-test-database.sql` — the CI database. Add `CREATE ROLE
   shortkit_auth LOGIN PASSWORD ... NOBYPASSRLS` and `GRANT USAGE ON SCHEMA public TO
   shortkit_auth`.

   **Its two guards are hardcoded to a two-role model and both have to widen.** Verified
   directly: `:57` reads `WHERE rolname IN ('shortkit_app', 'shortkit_migrator')` in the
   BYPASSRLS/SUPERUSER/CREATEROLE check, and `:66` reads `count(*) <> 2`. Left as they are,
   the BYPASSRLS guard **never inspects `shortkit_auth`** — so an auth role provisioned with
   `BYPASSRLS` passes CI silently — and the cardinality guard goes on asserting a model the
   database no longer has. A guard that passes while describing something that no longer
   exists is worse than no guard, because it reads as coverage.

2. `docker-compose.yml:320` — the dev stack's inline init script, alongside the existing two
   `CREATE ROLE` lines. Roles only. **The `environment:` blocks and `DATABASE_AUTH_URL` are
   TASK-009's, in wave 4** — this card touches the same file in a different block, which is
   the `app.module.ts` pattern the plan already separates by wave.

3. `docker-compose.test.yml:122` — the test stack's inline init script, same treatment.

**Two fixtures, because the integration tier boots a real API child.**

- `apps/api/test/support/rls-fixture.ts` — role-and-grant preconditions extended to the
  third role.
- `apps/api/test/support/auth-fixture.ts` — `authServerEnv()` gains `DATABASE_AUTH_URL`.
  From wave 2 the spawned API child refuses to boot without it. **`BETTER_AUTH_SECRET` there
  is already correct** — `:85` sets a 53-character non-default value — and must not be
  touched; ADR-0051's round-3 follow-up claiming the integration tier has no owner for that
  value was struck in round 4 as false.

- `apps/api/scripts/seed.mts` — grant docblock only. The seed keeps running as
  `shortkit_app`; it never connects as `shortkit_auth`.

## Two `environment:` declarations — added 2026-08-13, Design round 5 (F-034)

**This card was provisioning-only for about an hour, and then the wave arithmetic caught up
with it.** `BETTER_AUTH_SECRET` and `DATABASE_AUTH_URL` are declared on `docker-compose.yml`'s
`api` service here, in wave 0.

**Corrected 2026-08-13, round 5: `docker-compose.test.yml` has NO `api` service** — verified,
it runs `postgres` alone. This card originally said "both compose files" and that was my
error. There is nothing to declare there beyond the role block and the header export lines.
**The integration tier gets both variables through `apps/api/test/support/auth-fixture.ts`,
which this card already owns.**

Why they cannot wait for TASK-009 in wave 4: `assertBetterAuthSecretConfigured()` is
unconditional and lands in TASK-003, **wave 2**, and the auth pool needs `DATABASE_AUTH_URL`
from the same wave. `docker-compose.yml:227-228` currently gives `api` exactly one variable,
`DATABASE_URL`. `.github/workflows/ci.yml:382-386` makes `compose` one of the three jobs the
required `gate` fans in, and `check-compose-stack.sh` asserts the API reaches a healthy
state — so waves 2 and 3 would ship a repository whose required check cannot go green.

**The redness is not the danger; the repair pressure is.** The two cheapest fixes available
to someone staring at a red `compose` job are deleting the boot assertion Juano moved into
wave 2 to close a one-wave window, or giving `DATABASE_AUTH_URL` a fallback to
`DATABASE_URL` — which ADR-0050 names by name as the change that "would silently restore
`shortkit_app` as the auth role and every gate would stay green". Declaring four lines early
costs nothing and removes the pressure entirely.

`DATABASE_AUTH_URL` connects as **`shortkit_auth`**, never as `shortkit_app`. If it points
at the wrong role, `assertAuthRoleSeparation` refuses the boot in its second direction from
wave 3 — the check working, not a bug.

**The new role's password variable is this card's too** (F-040). `docker-compose.yml:310-311`
passes the existing passwords into the init script as `-v app_password=
"$$SHORTKIT_APP_PASSWORD"`, and the script runs under `set -eu`. A `CREATE ROLE
shortkit_auth ... PASSWORD :'auth_password'` line with no `SHORTKIT_AUTH_PASSWORD` plumbed
through it fails initialisation outright. Whatever this card adds to the `CREATE ROLE` block,
it also adds the variable that block consumes — in both compose files and in the `-v` list.
An earlier draft of this card sent "every other `environment:` entry" to wave 4 and took that
variable with it; that was my error, not a decision.

**State `BETTER_AUTH_SECRET`'s compose default explicitly.** `betterAuthSecret()` throws on
unset, on empty, on under 32 characters, and on better-auth's published constant (ADR-0051),
and the assertion calling it is unconditional from wave 2. A compose default that trips any
of those four reproduces F-034 exactly — a required `compose` check that cannot go green —
so the value written here must clear all four, and it is a **development throwaway that signs
nothing real**, in the shape `apps/api/test/support/auth-fixture.ts:85` already uses.

**Two blocks, two `$` conventions, and they are not interchangeable** (F-043). The init
script is a `configs.*.content` body interpolated by Compose against the **host** environment
at parse time, so it requires `$$` escaping — F-315 and F-316 are what happens when a single
`$` gets through, and `check-compose-stack.sh:180`'s contaminant guard exists because of
them. The `environment:` block is ordinary `${VAR:-default}` interpolation. This card edits
both blocks in the same file; do not carry a convention across.

## Out of scope for this TASK

The migration `REVOKE`/`GRANT` itself, the grant-matrix assertion, and the second pool — all
TASK-002, wave 1. `assertAuthRoleSeparation` — TASK-004, wave 3. **`.env.example` and README
text, and every `environment:` entry other than `BETTER_AUTH_SECRET`, `DATABASE_AUTH_URL` and
the new role's password variable** — TASK-009, wave 4. Any application code, any schema, any
policy.

## Interfaces

**Consumes**

From the repository (shipped): `.github/scripts/provision-test-database.sql` and its two
guards at `:57` and `:66`; the inline init scripts at `docker-compose.yml:320` and
`docker-compose.test.yml:122`; `apps/api/test/support/auth-fixture.ts:85`.

From ADR-0050: the three-role model, and `shortkit_auth`'s required attributes — `LOGIN`,
`NOBYPASSRLS`, not superuser, owns nothing.

**Produces**

- A three-role database at every site that provisions one, with `shortkit_auth` holding
  `LOGIN`, `NOBYPASSRLS`, no superuser and no ownership.
- `.github/scripts/provision-test-database.sql` — both guards covering all three roles: the
  BYPASSRLS/SUPERUSER/CREATEROLE check inspects `shortkit_auth`, and the cardinality check
  asserts three.
- `apps/api/test/support/auth-fixture.ts` — `authServerEnv()` returning `DATABASE_AUTH_URL`.
- `docker-compose.yml` — the `api` service's `environment:` block carrying
  `BETTER_AUTH_SECRET` and `DATABASE_AUTH_URL`, the latter connecting as `shortkit_auth`
  (F-034). `docker-compose.test.yml` gets the role block and its header export lines only;
  it has no `api` service.
