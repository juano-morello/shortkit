---
id: TASK-019
story: STORY-003
epic: EPIC-001
title: A generated development secret, so the compose stack still comes up once the published default is rejected
status: in-progress
owner_slot: sdlc-implementer-backend
depends_on: [TASK-018]
paths: ["docker-compose.yml", "scripts/check-compose-stack.sh", ".env.example", "README.md"]
# REWRITTEN 2026-08-14 after F-144 and F-145. The card originally owned
# scripts/generate-dev-secret.mjs and wrote the root .env. IT NO LONGER NEEDS EITHER - the ADR-0051
# reversal means nothing writes a file, so there is no generator and no .env. docker-compose.yml
# joined the list because the ${VAR:?} change is the substance of this card.
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

**Stop `docker-compose.yml` carrying a signing key, and keep the compose gate able to run.**

## Why this card changed shape

Its first version generated a secret into the root `.env`. That cannot work:
`scripts/check-compose-stack.sh:191-196` **refuses to run at all when a root `.env` exists**, for
the same reason the contaminant guard beside it exists — `.env` masks the same defect an exported
variable masks and does not exist on a fresh clone. A generation step in that script's setup makes
the script refuse itself (F-144).

Underneath that collision was a real contradiction: **AC-115's premise and ADR-0051's assertion
could not both hold.** The gate proves the stack comes up on a clone with nothing supplied; from
wave 2 it cannot come up without a secret that is not the published default.

Juano ruled the reversal, and **AC-115's text was narrowed** to name the variable (F-145) — an
amendment reaching into `foundation`'s closed STORY-002, recorded there from both sides.

## Approach

**`docker-compose.yml` uses `${BETTER_AUTH_SECRET:?…}`.** A missing value then fails at **parse
time**, naming the variable, instead of as a container exiting on an assertion a wave later. Three
mechanical constraints from ADR-0051, all of which will bite if ignored: single-quote the YAML
scalar; **no `$`, backtick or braces inside the message**, which rules out putting a generation
command there; and do not repeat the variable name, because Compose already prints `required
variable BETTER_AUTH_SECRET is missing a value:`.

Delete the committed default outright. Its removal is what retires ADR-0051's second rejected
constant — and note the condition the ADR states: **if that literal is still in
`docker-compose.yml` when TASK-003 starts, this card did not land and the second rejection stands.**

**`check-compose-stack.sh` generates and exports one secret per run.** Seven properties are on
ADR-0051; three cannot be inferred from this card and will not survive being guessed:

- **One value for the whole run.** DOD-1's second `up` and DOD-3's `restart` share the volume, and a
  second value gives `Failed to decrypt private key`.
- **Export before the `trap cleanup EXIT` at `:298`**, not merely before the first `docker compose
  config` — cleanup itself runs `docker compose down -v`, which parses.
- **Override an inherited value**, the way the harness already pins `APP_PASSWORD='app'` at
  `:303-311`.

**Do not touch the contaminant guard at `:180-189`.** It is TASK-017's, and adding
`BETTER_AUTH_SECRET` to it would make the harness refuse the variable it deliberately exports —
F-144 a second time. ADR-0051 records this; so does TASK-017's card.

**`.env.example` and `README.md` carry the premise change.** Three files quote the old
"works with no `.env` at all" story: `check-compose-stack.sh:4-9`, `.env.example:6-7`,
`README.md:90`. The documented step **exports**, it does not write `.env` — a root `.env` makes
`pnpm test:compose` refuse until it is moved aside, and that cost is stated rather than hidden.

## Costs this card accepts, from ADR-0051

`:?` breaks `down`, `ps`, `logs` and `config`, not only `up`, so tidying up after the parse error
hits the same error. `BETTER_AUTH_SECRET` becomes the only variable in the file with no default,
which invites a well-meaning tidy-up. The harness now measures a path no developer walks, off by
exactly one step, and no clause runs the README's own command.

## Out of scope for this TASK

`assertBetterAuthSecretConfigured()` itself and the second rejected constant — **TASK-003, wave
2**. Any `environment:` block or compose service definition — TASK-018 owns the two wave-2-critical
declarations, TASK-009 owns the rest in wave 4. `check-compose-stack.sh`'s **assertions** and its
contaminant guard — TASK-017, wave 9 (F-037). Any application code. Any secret used outside local
development.

## Interfaces

**Consumes**

From TASK-018 (wave 0): the root `.env.example` carrying four passwords and its "works with no
`.env`" claim; `docker-compose.yml`'s `${BETTER_AUTH_SECRET:-…}` line, which this card replaces.

From ADR-0051, as amended twice: `betterAuthSecret()` throws on unset, empty, under 32 characters,
or **better-auth's own published constant**. The second rejected constant — the compose default —
retires when this card deletes the literal it referred to.

**Produces**

- `docker-compose.yml` — `${BETTER_AUTH_SECRET:?…}`, a required reference with **no default**, so
  the committed signing key is gone from the repository's working tree. Single-quoted scalar, no
  `$`/backtick/braces in the message, no repetition of the variable name.
- `scripts/check-compose-stack.sh` — one generated secret exported per run, before the
  `trap cleanup EXIT`, overriding anything inherited. **No file written**, so the script's own
  `.env` refusal never fires and its fresh-clone premise survives — now stated honestly as a fresh
  clone plus the one variable this harness supplies, with the reason.
- `.env.example` — the "works with no `.env` at all" claim corrected, and the export documented as
  the way to supply the secret rather than a file.
- `README.md` — the documented start sequence exports the variable before `docker compose up`.

**Explicitly NOT produced:** any generator script, and any write to the root `.env`. Both were in
this card's first version and both are what F-144 ruled out.
