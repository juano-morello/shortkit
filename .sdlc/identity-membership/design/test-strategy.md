# Test strategy — identity-membership, waves 0 and 1

Written 2026-08-13 at the start of the Test phase, from `design/test-scout.md` (grounding) and
the wave 0–1 cards. Covers **TASK-018, TASK-001 and TASK-002 only**. Waves 2–9 are undesigned.

## The three tiers, and the one that silently swallows a file

| Tier | Command | Collected by | Where |
|---|---|---|---|
| unit | `pnpm test` | `src/**/*.spec.ts` | `apps/api/vitest.config.ts:10`, `packages/contracts/vitest.config.ts:7` |
| integration | `pnpm test:integration` | `**/*.int-spec.ts` relative to `apps/api/` | `apps/api/vitest.integration.config.ts:17` |
| isolation | (inside the integration run) | one file: `test/isolation/cross-tenant-isolation.int-spec.ts` | — |

**A `test/**` file named `*.spec.ts` collects in neither tier and passes by never running.** The
unit config globs `src/**` only; the integration config wants `*.int-spec.ts`. This is not
hypothetical — it is why `context-flag-owners.spec.ts` must live under `src/**`, and it is the
single most likely way this wave ships a control that is green because it is absent.

The near-miss case is guarded: `assertEveryIntegrationSpecRuns()`
(`vitest.integration.config.ts:27-45`) throws **at config-eval time** and names any file matching
an integration-ish pattern with the wrong suffix (`foo.int.spec.ts`). It does **not** catch a
`test/**` file named `*.spec.ts`. Do not rely on it for that case; rely on placement.

## What each TASK gets, and in which tier

**TASK-001 — contracts (AC-8).** Unit, in `packages/contracts`. Zod shapes, the brand step
applied after parsing (ADR-0048), and the password bounds as exported values (ADR-0047). No
database. The brand test's point is that a contract's *inferred* type never carries a brand and
branding is a separate named step — a test that asserts the inferred type is branded would pass a
wrong implementation.

**TASK-002 — schema, lookup, policies (AC-2, AC-4).** Split across all three:

- *unit* — `src/db/schema/auth.spec.ts` (ADR-0043: hand-written schema pinned against
  `getSchema()`), `src/auth/tenant-id-for-user.spec.ts`, and `src/db/context-flag-owners.spec.ts`
  (clauses A1/A4 over the wave-1 scan set — see below).
- *integration* — `test/auth/tenant-memberships.int-spec.ts` for `UNIQUE (user_id)` rejecting a
  second membership, and `test/tenancy/warm-connection-no-context.int-spec.ts` for ADR-0049's
  behavioural control.
- *isolation* — registration only. The assertions in `cross-tenant-isolation.int-spec.ts` belong
  to TASK-015 and are **not** written here.

**TASK-018 — provisioning (no AC, not exempt).** Integration, one new file
`test/tenancy/auth-role-provisioning.int-spec.ts`. Juano declined a `test_exempt` marker: the
wave-0 role split is what the F-024 ruling bought, and without tests nothing asserts it landed
until TASK-002's grant matrix runs a wave later. Four assertions, each of which is a failure this
repository has actually had rather than a hypothetical:

1. three roles exist at every site that provisions one;
2. `shortkit_auth` holds `LOGIN`, `NOBYPASSRLS`, not superuser, owns nothing;
3. the **widened BYPASSRLS guard fires** on a `shortkit_auth` provisioned with `BYPASSRLS` —
   left at its two-role form (`provision-test-database.sql:57`) it never inspects the new role,
   so this assertion is the difference between a guard and a guard-shaped comment;
4. the **widened cardinality guard fires** on a two-role database (`:66`, `count(*) <> 2`).

## The two controls, and why they are specified rather than invented

Both were added by the Design phase after F-025 and F-032, and both have a contract or ADR that
fixes their form. Neither is the test architect's to redesign.

**`src/db/context-flag-owners.spec.ts`** runs clauses **A1 and A4** of
`.sdlc/foundation/design/contracts/isolation-coverage.md` over the wave-1 scan set. Read
`:487-537` before writing it. It **inherits A4's permitted list** — do not write an `app.` prefix
filter, that was deleted by F-044 — matches on the `{ flag, file }` **pair**, and asserts the
**subset** direction only. A1's exactly-one direction is TASK-056's, gated on TASK-029 and
TASK-054 landing the other two setters; the contract says A1 "is not runnable earlier".

**It is a text scan and must stay one.** The contract states at `:527-532` that none of the four
clauses parses TypeScript or distinguishes code from a comment, deliberately: a commented-out
setter is one uncomment from real and A2 is built to fire on it.
`src/observability/logging-opt-out.spec.ts` uses the TypeScript compiler for a **different**
assertion — do not take it as the pattern here.

**`test/tenancy/warm-connection-no-context.int-spec.ts`** — a warm, no-context `SELECT` returns
zero rows. Scope it to
`has_table_privilege(current_user, c.oid, 'SELECT') OR has_any_column_privilege(current_user,
c.oid, 'SELECT')`, matching ADR-0050's grant matrix. Not "every table in `public`": after
migration `0001` the five exempt tables answer `permission denied` (42501) to `shortkit_app`, so
the naive form fails on the day the role split lands.

## Fixtures

`test/support/rls-fixture.ts` gives `appDsn()` / `migrationDsn()`, seeds and erases `tenants`
through the real production policies, and gates on a migrated, protected `tenants` table.
`auth-fixture.ts` builds on it for `authServerEnv()`, which today returns `NODE_ENV`,
`DATABASE_URL`, `GIT_COMMIT_SHA`, `BETTER_AUTH_URL`, `BETTER_AUTH_SECRET` (53 chars, non-default,
above ADR-0051's 32 floor) and `BFF_PROXY_SECRET` — and **not** `DATABASE_AUTH_URL`, which
TASK-018 adds.

`fileParallelism: false` (`vitest.integration.config.ts:70`, F-134) — one shared live Postgres,
so integration tests must not assume an empty database or a private one.

**Fixture edits belong to TASK-018.** A test architect working STORY-001 that finds it needs a
fixture change reports it rather than making it; two agents editing `test/support/**` in the same
wave is the collision the wave table exists to prevent.

## Deliberately not automated

- **Anything requiring a browser.** No tier drives one; SC-2 was reworded at the Plan gate to be
  discharged by transport-level measurement, with rendering and client-side navigation named on
  the criterion itself as unmeasured.
- **The compose end-to-end flow** — `scripts/check-compose-stack.sh`, TASK-017, wave 9.
- **Coverage thresholds.** `coverage_gate: null`, re-justified 2026-08-12: a threshold against a
  substrate whose consumers are all deferred measures the fixtures, not the system.

## Red means red for the right reason

Every new test must fail as an **assertion** or a `not implemented`, never an import error, a
missing fixture or a syntax error. A test that cannot load proves nothing, and on this wave the
most likely wrong-red is a missing `shortkit_auth` role making TASK-018's file error rather than
assert. Name the production change that would make each test pass before writing it.
