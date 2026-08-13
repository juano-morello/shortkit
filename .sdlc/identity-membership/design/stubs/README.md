# Design stubs — identity-membership, wave 1

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

## A stub is not a normative form

ADR-0039: a stub is deleted when the TASK that materialised its file reaches
`status: done`. From that point the source file is the behaviour and the contract in
`design/contracts/` is normative for what it must do. There is no second copy to keep in
sync and nobody is asked to sync one.
