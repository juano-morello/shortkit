---
id: TASK-019
story: STORY-003
epic: EPIC-001
title: A generated development secret, so the compose stack still comes up once the published default is rejected
status: todo
owner_slot: sdlc-implementer-backend
depends_on: [TASK-018]
paths: ["scripts/generate-dev-secret.mjs", ".env.example", "README.md", "scripts/check-compose-stack.sh"]
contracts: []
test_files: ["scripts/check-compose-stack.sh (compose tier — this card adds the generation step it runs; TASK-017 extends the script's assertions in wave 9)"]
acceptance: []
rework_count: 0
---

<!--
CREATED 2026-08-14 by Juano's ruling at the wave-0 completion, owning F-081 and F-083.

WAVE 1, and the wave matters more than the size. The assertion that makes this card necessary
lands in TASK-003, wave 2. This card must precede it.

NO AC, for the same reason TASK-018 has none: this work descends from F-020 and F-074, both
raised long after the plan's 36 criteria were written. TASK-018 is the precedent — approved
knowingly at the Design gate, with plan.md recording that "36 ACs each claimed by exactly one
TASK" now describes seventeen of nineteen TASKs.
-->

## Intent

**Keep `docker compose up` working on a clean clone, once `assertBetterAuthSecretConfigured()`
starts rejecting the value compose currently supplies.**

## Why this card exists

ADR-0051 now rejects **two** constants by exact value: better-auth's published
`better-auth-secret-12345678901234567890`, and
`development-compose-better-auth-secret-not-a-real-value`, which TASK-018 introduced as the
compose default. The disqualifying property is **publication** — a value committed to a public
repository sits in a history nobody can rewrite — not its length or its shape.

That ruling has a cost nobody priced at the time, found by the architect while implementing it
and recorded as **F-081**. From wave 2:

- `docker-compose.yml` interpolates `${BETTER_AUTH_SECRET:-<the published default>}`;
- `assertBetterAuthSecretConfigured()` rejects that value;
- so `api` exits at boot, `check-compose-stack.sh:476`'s `AC-115.3` health assertion fails;
- and the `compose` CI job carries **no `env:` block by design** (F-315, F-316), so CI is not
  exempt.

A clean clone's `docker compose up` would go red. Juano's ruling: **a generation step writes a
random secret to the root `.env` before compose starts.**

## Approach

**The generator writes to the root `.env`, and that file is the hazard.** `.env` is gitignored
and is also where a developer puts rotated role passwords (`.env.example` is its template, and
TASK-018 just added `SHORTKIT_AUTH_PASSWORD` to it). **A generator that overwrites reverts every
rotated password to the published default** — F-075's hazard, mechanised, which is exactly what
F-083 names.

So: **create `BETTER_AUTH_SECRET` only when it is absent.** Never rewrite an existing value,
never rewrite the file wholesale, and leave every other line untouched. If the developer already
exported one, do nothing at all.

**It runs before compose, not inside it.** Compose interpolates at parse time from the project
root, so anything that runs as a container has already missed its moment.

**`check-compose-stack.sh` must run the same step**, or the gate measures a flow no developer
follows. That script is TASK-017's in wave 9 for its *assertions*; this card adds only the
generation call, and the two must not collide — keep the edit to the setup section and leave
every clause alone.

**`.env.example` gains the variable and the story** (F-083). It currently says the stack "works
with no `.env` at all — that is AC-115", which stops being true in wave 2. It should say what the
generation step does, that it will not overwrite, and that `BETTER_AUTH_SECRET` is a signing key
rather than a database password.

**`README.md`**: the documented start sequence gains the step. `docs.required: [README]` in
`config.yaml`, and every command listed there must exit 0 when run.

## Out of scope for this TASK

`assertBetterAuthSecretConfigured()` itself and the second rejected constant — **TASK-003, wave
2**. Any `environment:` block or compose service definition — TASK-018 owns the two wave-2-critical
declarations, TASK-009 owns the rest in wave 4. `check-compose-stack.sh`'s **assertions** and its
contaminant guard — TASK-017, wave 9 (F-037). Any application code. Any secret used outside local
development.

## Interfaces

**Consumes**

From TASK-018 (wave 0): the root `.env.example` carrying four passwords and its "works with no
`.env`" claim; `docker-compose.yml:287`'s `${BETTER_AUTH_SECRET:-…}` interpolation.

From ADR-0051: the four rejection conditions — unset, empty, under 32 characters, or either
published constant — that a generated value must clear.

**Produces**

- `scripts/generate-dev-secret.mjs` — writes `BETTER_AUTH_SECRET` to the root `.env` **only if
  absent**, with a value clearing all four of ADR-0051's rejections. Idempotent, and it never
  touches another line.
- `.env.example` — the variable, and the corrected claim about running with no `.env`.
- `README.md` — the step in the documented start sequence.
- `scripts/check-compose-stack.sh` — the same step in its setup, so the gate measures the
  documented flow.
