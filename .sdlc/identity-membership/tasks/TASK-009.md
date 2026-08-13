---
id: TASK-009
story: STORY-003
epic: EPIC-001
title: Compose stack and declared environment for the auth surface
status: todo
owner_slot: sdlc-implementer-backend
depends_on: [TASK-004]
paths: ["docker-compose.yml", "apps/api/.env.example", "apps/web/.env.example", "README.md"]
contracts: [design/contracts/trusted-client-address.md, design/contracts/rate-limit.md]
test_files: ["scripts/check-compose-stack.sh (compose tier, existing file — run, not edited here; TASK-017 extends it)"]
acceptance: [AC-20]
rework_count: 0
---

## Intent

Make `docker compose up` produce a stack where an operator can sign up, with every variable
the auth surface needs declared and none of them keyed on `NODE_ENV`.

## Approach

The `api` service's `environment:` block currently carries `DATABASE_URL` and nothing else
(`docker-compose.yml:227`, ADR-0035). Better Auth needs at least a signing secret and a base
URL, and ADR-0040 adds four declarations of which two exist only to say what the other two
are for.

**`apps/api/.env.example` does not exist and is owed by three separate ADR follow-ups.** It
lands here, and it carries every variable with the distinction between the two boundaries
written out rather than left to the names:

| Variable | Meaning | Compose value |
|---|---|---|
| `DATABASE_URL` | runtime role `shortkit_app`; owns nothing, cannot run DDL | already set |
| `DATABASE_MIGRATION_URL` | role `shortkit_migrator`; owns the tables | already set on `migrate` |
| `CLIENT_TRUST_BOUNDARY` | `proxy` \| `direct`; **unset is read as `direct`** | unset |
| `TRUSTED_CLIENT_IP_HEADER` | the header a hop in front sets **and strips**; required only when the boundary is `proxy` | unset |
| `BFF_TRUST_BOUNDARY` | `bff` \| `direct`; **unset is read as `direct`** | unset |
| `BFF_PROXY_SECRET` | required only when the boundary is `bff` | unset |

`CLIENT_TRUST_BOUNDARY` declares that a hop terminates client connections and strips a
header. `BFF_TRUST_BOUNDARY` declares that our own frontend forwards an address it
authenticates. **The two vary independently** — that is exactly why ADR-0040 rejected
collapsing them into one variable — and an operator who sets one and assumes the other
followed is the failure this table exists to prevent.

**The compose stack declares neither boundary, and that is correct rather than an
oversight.** No assertion fires, no principal is established, and IP-keyed buckets do not
bind. ADR-0040 states that cost: compose, CI and local dev all run with no IP-keyed limit,
and `trusted_client_ip_unresolved_total` is nonzero from the first request. `authBodyCap`
at 32 KiB still binds, so the credential surface is less protected rather than unprotected.

**Nothing added here may key on `NODE_ENV`.** `Dockerfile:83` sets `ENV NODE_ENV=production`
unconditionally in the image this stack runs. Under the F-386 ruling every binding in this
initiative goes on a declared variable. A fixture value that exists only to silence a
`NODE_ENV`-gated assertion is the alternative ADR-0040 explicitly rejected — "it buys the
boot back by giving up the rule".

**A signing secret is a fixture here, and it must look like one.** The compose file already
carries fixture credentials with comments saying they are fixtures; follow that pattern
exactly, including the comment. A secret that reads as real is one somebody copies into a
deployment.

**No seed data.** SC-2 requires signup to work against an empty database. The `seed` service
exists in the stack; whatever it seeds must not be a precondition for a new operator
completing signup, and AC-20 is measured with no account and no tenant present.

The `web` service needs whatever base URL its transport uses to reach `api`. Keep
`apps/web/.env.example` and the compose block in step: a variable in one and not the other
is the shape of failure this TASK exists to prevent.

`README.md` gains the commands and the variables an operator needs — `docs.required:
[README]` in `config.yaml`, and every command listed in it must exit 0 when run.

## Out of scope for this TASK

Any application code. The end-to-end flow assertion in `scripts/check-compose-stack.sh`
(TASK-017 — this TASK runs that script, and does not edit it). CI workflow changes. Adding a
reverse proxy in front of `api` to make the trust model testable — ADR-0040 records that as
"recorded, not scheduled". Any mail variable (`MAIL_TRANSPORT` belongs to item 1b).

## Interfaces

**Consumes**

From TASK-004:
- `assertTrustedClientIpHeaderConfigured(env: NodeJS.ProcessEnv): void` — fails boot on an
  invalid `CLIENT_TRUST_BOUNDARY` value in **every** environment, and on `proxy` with no
  `TRUSTED_CLIENT_IP_HEADER`
- `assertBffProxySecretConfigured(env: NodeJS.ProcessEnv): void` — same shape on
  `BFF_TRUST_BOUNDARY` and `BFF_PROXY_SECRET`

From the shipped stack: the `postgres`, `migrate`, `seed`, `api` and `web` services and
ADR-0036's ordering table; `scripts/check-compose-stack.sh`, whose exit code 2 means
**"could not run, nothing measured"** and is never a failure of the criterion.

**Produces**

- `docker-compose.yml` — the `api` service's `environment:` block carrying the Better Auth
  signing secret and base URL as commented fixtures, and the `web` service's block carrying
  the API base URL. Neither trust boundary is declared.
- `apps/api/.env.example` — the table above, with both boundaries' meanings written out
- `apps/web/.env.example` — the web-side variables, in step with the compose block
- `README.md` — the run instructions and the variable list
