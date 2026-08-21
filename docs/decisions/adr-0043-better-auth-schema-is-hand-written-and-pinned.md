---
id: ADR-0043
slug: identity-membership
title: Better Auth's Drizzle schema is hand-written and pinned by a getSchema drift test, not CLI-generated
status: accepted
supersedes: null
amends: ADR-0013
date: 2026-08-12
---

## Context

ADR-0013 says Better Auth's tables "are generated once with the Better Auth CLI, checked
into `apps/api/src/db/schema/auth.ts`, and owned from then on by drizzle-kit". The plan
names the consequence as the single edit most likely to redraw its wave table: the CLI
reads a Better Auth config, TASK-003 writes that config, and TASK-002 needs the schema file
one wave earlier.

Three facts about the pinned `better-auth@1.6.26`, read from the installed package rather
than from documentation:

- `@better-auth/cli` is **not installed** and is not a dependency of `better-auth`.
  `apps/api/node_modules/better-auth/package.json` declares no `bin`. Running the CLI means
  adding a package, or `npx`-ing an unpinned one, which ADR-0018 forbids.
- `better-auth/db` exports `getSchema(options: BetterAuthOptions)`. It takes a plain options
  object, opens no connection, and constructs no `betterAuth` instance. It returns every
  table, every field, each field's type, nullability, uniqueness and foreign key.
- The only option that changes the answer is `plugins`. Measured: `getSchema({})` and
  `getSchema({ emailAndPassword: { enabled: true } })` return identical table and field
  sets, and adding `[jwt(), bearer()]` adds exactly one table, `jwks`.

So the ordering problem is an artifact of the mechanism ADR-0013 named, not of the
dependency. The information TASK-002 needs is a pure function of the plugin list, and the
plugin list is four tokens.

There is a second, larger problem with generation that the ordering hid. A CLI run is a
one-time event. Nothing re-runs it, so a `better-auth` upgrade that adds a column produces a
checked-in schema that is silently one column short, and the failure surfaces as a runtime
`BetterAuthError` on a code path (`checkMissingFields` at
`@better-auth/drizzle-adapter/dist/index.mjs:298`) that only some requests reach.

## Decision

**`apps/api/src/db/schema/auth.ts` is hand-written Drizzle, and a unit test asserts it
against `getSchema()` on every run.**

TASK-002 writes the five tables by hand from the field table in
`docs/contracts/auth-schema.md`, which is transcribed from the `getSchema()` output
recorded there. It ships ~~`apps/api/src/db/schema/auth.spec.ts`~~
**`apps/api/src/db/auth-schema.spec.ts`**, a unit test (no database, no
network) that calls

```ts
getSchema({ plugins: [jwt(), bearer()] })
```

and asserts, for every table and every field:

| Property compared | Source of truth |
|---|---|
| table name | `getSchema()` key, against the Drizzle table's SQL name |
| field set | `getSchema()` field keys, against the Drizzle table's TS property names, plus `id` |
| nullability | `field.required`, against Drizzle `.notNull()` |
| uniqueness | `field.unique`, against Drizzle `.unique()` |
| foreign key target and `onDelete` | `field.references`, against Drizzle `.references()` |

**The spec lives beside the schema directory, not inside it. Corrected 2026-08-13 (F-045);
Juano ruled the move.** The original path put the spec under `apps/api/src/db/schema/`.
`apps/api/drizzle.config.ts:16` globs `./src/db/schema/*.ts` and drizzle-kit `require()`s
every match through its CJS transformer, so a vitest import inside that directory breaks
`pnpm db:generate`, the command TASK-002's implementer runs first, to produce migration
`0001`. Measured, not read. `pnpm db:migrate` is unaffected, which is why the failure only
shows up on generation.

`apps/api/src/db/auth-schema.spec.ts` keeps everything the original path was chosen for. It
is still under `src/**`, so `vitest.config.ts`'s `include: ['src/**/*.spec.ts']` picks it up
and it stays in the unit tier that CI's `quality` job runs. It is no longer under
`src/db/schema/`, so the glob does not see it. The subject it asserts against,
`apps/api/src/db/schema/auth.ts`, does not move.

**This ADR wrote down the hazard and then walked into it.** `auth-schema.md`'s guarantee 4
already warned that `drizzle.config.ts` evaluates every match of that glob, and gave it as
the reason `auth.ts` may not import `better-auth/plugins`. The spec was then placed inside
the same directory and imports `better-auth/db` and `better-auth/plugins` directly. The rule
was right and its scope was one file too narrow.

The test compares names, nullability, uniqueness and references. **It does not compare SQL
types**, because the SQL type is this repository's choice and not Better Auth's: `getSchema`
speaks `string`, `boolean` and `date`, and the mapping to `text`, `boolean` and
`timestamptz` is fixed in `auth-schema.md` and asserted separately by the integration test
against `information_schema`.

**Drizzle property names are camelCase and database column names are snake_case.** This was
the open question at `apps/api/test/support/auth-fixture.ts:19-27`. Both halves are now
measured rather than guessed. The adapter indexes the Drizzle table object by Better Auth's
field key (`schema[fieldName]`, `drizzle-adapter/dist/index.mjs:298`), which is a TS property
name, so the property must be `emailVerified`. The column name is free, and the adapter's own
`camelCase` option documents its default as "snake case is used for table and field names",
so `email_verified` is what the CLI would have written and it is what `tenants.ts` already
does. The fixture's `pg_attribute` discovery will find `email_verified`.

**TASK-003 owes the second half of the pin.** `auth.config.ts` ships a unit test asserting
`getSchema(auth.options)` (the composed instance's own options) equals
`getSchema({ plugins: [jwt(), bearer()] })`. TASK-002's test pins the schema against a
literal; TASK-003's pins the literal against the real config. Without the second test, a
later `user.additionalFields` or a sixth plugin changes the required schema and nothing
notices.

## Alternatives considered

| Option | Pros | Cons | Why not |
|---|---|---|---|
| Add `@better-auth/cli` as a devDependency and run `generate` in TASK-002 against a throwaway config | The mechanism ADR-0013 named; output is what upstream expects | Needs a config file, which is the ordering problem, and a throwaway config is a second declaration of the plugin list that can drift from the real one. Adds an unpinned-at-design-time package to the graph for one run. The result is still a snapshot nothing re-checks | Solves the ordering by duplicating the input, and leaves the drift problem untouched |
| Merge TASK-002 and TASK-003 into one TASK, run the CLI after the config exists | No duplicated plugin list; the CLI reads the real config | Merges a migration TASK with the auth-mount TASK, so one implementer owns the schema, the migration, the policies, `tenantIdForUser`, the plugin config, the hooks and the revocation write in one session. Redraws waves 1 through 3 | The plan's own risk note; the cost is four waves of replanning to avoid writing forty lines of Drizzle |
| Swap the order: TASK-003 writes a config-only file first, TASK-002 generates from it | Keeps the CLI | `auth.config.ts` is the file the plan says nothing else may touch while TASK-003 holds it, so this splits it into a config half and a mount half and creates the file-ownership conflict wave 2 exists to prevent | Trades a wave-table redraw for a file-ownership one |
| Generate the schema at build time from `getSchema()` into a checked-in file | No hand transcription; always current | A codegen step in a repository that has none (ADR-0005 is explicit that `packages/contracts` has no codegen), and generated Drizzle needs `text` vs `varchar` decisions the generator would have to be told anyway. The generated file still has to be reviewed and committed, so the drift window is identical | The test gives the same guarantee without a generator to own |

## Consequences

### Positive

- TASK-002 stays in wave 1 and TASK-003 stays in wave 2. The plan's wave table is unchanged.
- Drift is caught on every `pnpm test` run rather than never. A `better-auth` upgrade that
  adds a field fails a unit test in CI's `quality` job, before the integration job and long
  before a request path finds it.
- No new package, no `npx`, nothing unpinned. ADR-0018 holds.
- The schema file is readable Drizzle written to this repository's conventions, so
  `tenants.ts` and `auth.ts` look like the same codebase.

### Negative / accepted cost

- **Forty-odd column declarations are transcribed by hand, and a transcription error in a
  property the test does not compare ships.** The test covers names, nullability, uniqueness
  and references. It does not cover the SQL type, the timezone flag on a timestamp, or a
  default. Those are covered by `auth-schema.md` and by review, which is weaker.
- **This ADR amends ADR-0013's "generated once with the Better Auth CLI" clause.** That
  sentence is now wrong and a reader of ADR-0013 who does not reach this file will run a CLI
  that is not installed.
- **The plugin list is declared twice**: once in TASK-002's spec and once in TASK-003's
  `auth.config.ts`. TASK-003's test is what keeps them equal, so the guarantee depends on a
  test in a different TASK in a different wave landing. Between wave 1 and wave 2 the pin is
  one-sided.
- `getSchema` is not part of Better Auth's documented public API surface in the sense the
  mount is; it is an export from `better-auth/db`. A minor release could move it, and the
  symptom is a failing unit test rather than a broken product, which is the right failure
  but is still a maintenance edge the CLI would not have had.
- The test reads `better-auth` internals to assert against our own schema, so a
  `better-auth` bug that reports the wrong schema makes the test agree with the bug.

### Follow-ups this creates

- TASK-002: writes `auth.ts` and `auth.spec.ts`; the spec is a new test file the card's
  `test_files` does not list.
- TASK-003: writes the second-half pin in `auth.config.spec.ts`, alongside the
  `rateLimit.enabled === false` assertion ADR-0013 already requires there.
- ADR-0013's Better Auth paragraph should be read with this file. The amendment is recorded
  here and not made in ADR-0013, which is frozen.
