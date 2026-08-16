# Design stubs — identity-membership, waves 1 and 2

Sources at the paths they will occupy in the workspace. Signatures and types are complete;
function bodies throw `not implemented`. Schema declarations — zod contracts and Drizzle
tables — are complete, because a declaration has no body to stub and a partial one carries
no type information.

## These compile

Checked 2026-08-12 against the versions the repo pins, by copying `packages/` and `apps/`
into a scratch tree, dropping these files at their mirrored paths, adding the two barrel
lines each one owes, and running each workspace's own `tsc --noEmit -p tsconfig.json`:

| Workspace | Command | Result |
|---|---|---|
| `packages/contracts` | `tsc --noEmit -p tsconfig.json` with `export * from './auth';` and `export * from './members';` appended to `src/index.ts` | clean |
| `apps/api` | `tsc --noEmit -p tsconfig.json` with `export * from './auth';` and `export * from './tenant-memberships';` appended to `src/db/schema/index.ts` | clean |

This is stronger than the foundation stubs' position, which recorded that no typecheck had
been run. It is not a guarantee about lint: `eslint.config.mjs` was not run against them.

## What is here

| Stub | Materialised by | Consumed by |
|---|---|---|
| `packages/contracts/src/auth/index.ts` | TASK-001 | TASK-003, TASK-005, TASK-007, TASK-008 |
| `packages/contracts/src/members/index.ts` | TASK-001 | TASK-003, TASK-012 |
| `apps/api/src/db/schema/auth.ts` | TASK-002 | TASK-003, TASK-011, TASK-014, TASK-015, `test/support/auth-fixture.ts` |
| `apps/api/src/db/schema/tenant-memberships.ts` | TASK-002 | TASK-003, TASK-011, TASK-015 |
| `apps/api/src/auth/membership-lookup.ts` | TASK-002 | `tenant-id-for-user.ts` only, deliberately |
| `apps/api/src/auth/tenant-id-for-user.ts` | TASK-002 | TASK-003 (`definePayload`) |

## What is deliberately not here

`betterAuthDatabase()`, **the auth pool it is built on** and the fifth sanctioned-caller entry
are edits to `apps/api/src/db/client.ts`, a shipped file. A stub mirroring a shipped file
reads as a replacement for it, and ADR-0039 retired the last two stubs in that position. The
normative signature is in ADR-0046 and in the amended `tenant-context.md`; **the pool it runs
on is in ADR-0050, and ADR-0046 is superseded in part on that point (F-028)**. Reading
ADR-0046 alone produces one pool on `DATABASE_URL`, which cannot read `user` after migration
`0001`.

The same applies to `membershipLookupPolicy()` in `apps/api/src/db/rls.ts`: the normative
form is the SQL in `design/contracts/tenant-membership-lookup.md`.

## Wave 2, added 2026-08-14

| Stub | Materialised by | Consumed by |
|---|---|---|
| `apps/api/src/auth/revocation-store.ts` | TASK-003 | TASK-005 (`isRevoked`), TASK-030 (replaces the implementation) |
| `apps/api/src/auth/boot-assertions.ts` | TASK-003 | `main.ts` (TASK-003), TASK-004 (adds three assertions, wave 3) |
| `apps/api/src/auth/auth.config.ts` | TASK-003 | TASK-004 (`auth`, `beforeHooks`), item 1b (appends a hook) |

**These three were checked harder than the wave-1 set.** Dropped at their mirrored paths
under `apps/api/src/auth/` and run against the workspace's own toolchain:

| Command | Result |
|---|---|
| `pnpm exec tsc --noEmit -p apps/api/tsconfig.json` | clean |
| `pnpm exec eslint apps/api/src/auth/{revocation-store,boot-assertions,auth.config}.ts` | clean |

**Re-run 2026-08-16** after the wave-2 security pass revised `boot-assertions.ts` (three
bindings and three assertions instead of one of each, and `AuthBindingError` replacing
`BetterAuthSecretError`) and `revocation-store.ts` (the `delete`-before-`set` rule). Both
commands clean again, and the source tree was restored to its previous state.

**Re-run again 2026-08-16, round 2**, after `webAppOrigins`'s wildcard predicate was corrected
(two rules, and `?` counts as a metacharacter). Clean, tree restored. The stubs' docblocks are
where the wildcard rules and the one-way import rule are written for the implementer; the
normative form for every composed key is `contracts/auth-config-surface.md`, which wins on
conflict.

That is stronger than the wave-1 position, which recorded a typecheck in a scratch tree and
explicitly did not run lint.

### `auth.config.ts`'s `auth` is `declare const`, not a throwing body

The exported value is `betterAuth({ ... })`'s return, and its type comes from the argument. A
stub that constructs the config to obtain the type is an implementation rather than a stub,
which is the position ADR-0039 took on the last two stubs in that shape. So `auth` is an
ambient declaration typed as `better-auth`'s exported `Auth`, which is what
`toNodeHandler(auth)` needs and nothing more.

`beforeHooks` and `AuthBeforeHook` are complete, not stubbed: an empty array and a type alias
have no body to stub, and the "appended to, never assigned" comment above the array is the
only thing item 1b's authors will read, since they land after this initiative closes.

The composition itself is normative in `design/contracts/auth-config-surface.md`, key by key,
with the ADR that fixes each one.

## A stub is not a normative form

ADR-0039: a stub is deleted when the TASK that materialised its file reaches
`status: done`. From that point the source file is the behaviour and the contract in
`design/contracts/` is normative for what it must do. There is no second copy to keep in
sync and nobody is asked to sync one.
