---
id: TASK-012
story: STORY-004
epic: EPIC-001
title: Workspace contracts and endpoints — create, list, rename, archive
status: todo
owner_slot: sdlc-implementer-backend
depends_on: [TASK-001, TASK-011]
paths: ["packages/contracts/src/workspaces/**", "packages/contracts/src/index.ts", "apps/api/src/workspaces/workspaces.controller.ts", "apps/api/src/workspaces/workspaces.service.ts", "apps/api/src/workspaces/workspaces.module.ts", "apps/api/src/app.module.ts"]
contracts: [design/contracts/workspaces.md, design/contracts/error-envelope.md]
test_files: ["packages/contracts/src/workspaces/workspaces.spec.ts (unit)", "apps/api/src/workspaces/workspaces.service.spec.ts (unit)", "apps/api/test/workspaces/workspaces.int-spec.ts (integration)"]
acceptance: [AC-21, AC-22, AC-23, AC-24]
rework_count: 0
---

## Intent

The first authenticated endpoints shortkit has ever had: four operations on workspaces,
declared once in contracts both deployables read.

## Approach

**Four operations**, each authenticated, each running inside the caller's tenant transaction
opened by the interceptor (TASK-006):

| Operation | Shape |
|---|---|
| create | takes a name, returns the created workspace |
| list | returns the caller's tenant's workspaces; takes whether to include archived ones |
| rename | takes an id and a new name, returns the updated workspace |
| archive | takes an id, returns the archived workspace |

The HTTP method and path for each is Design's, in `design/contracts/workspaces.md`. Two
constraints on that choice are already fixed and are not Design's to reopen: every controller
answers under the `/api` global prefix (ADR-0006, and `main.ts` sets it with `GET /health`
excluded), and the route **pattern** — never a concrete path — is what may appear in a log
line.

**Contracts first, and they live in `packages/contracts/src/workspaces/`.** The barrel line
`// export * from './workspaces';` at `packages/contracts/src/index.ts:29` becomes real.
That package may import **`zod` and nothing else**: lint bans `node:*`, `@nestjs/*`,
`drizzle-orm`, `pg` and `react`, because `apps/web` imports the source directly with no
build step (ADR-0005), and a Node-only import breaks the Next.js build rather than this
package's own.

**This TASK and TASK-001 both edit `packages/contracts/src/index.ts`.** They are in different
waves for that reason. The file is re-exports only so that a wave conflict is one line, and
lines are inserted alphabetically.

**Validation failures render through the shipped envelope machinery.** `isZodError` and
`toValidationDetails` (`packages/contracts/src/errors.ts:102-196`) flatten a `ZodError` into
`ValidationDetails` keyed by the first path segment, through a `Map` rather than an object
literal — that is a deliberate defence against prototype-pollution keys like `constructor`
and must not be replaced with a plain object. The flatten is capped at
`MAX_VALIDATION_ISSUES = 100` and `MAX_MESSAGES_PER_FIELD = 10`. `ERROR_CODE_STATUS` is
normative: **nothing may return a code with a different status than it fixes**, and
`ERROR_CODES` is append-only — if a shape here appears to need a code that does not exist,
that is a finding, not an edit.

**Authorization in this initiative is tenancy, and nothing else.** A workspace has exactly
one human who can see it, so there is no workspace role to check and no `memberships` table
to check it against. **Do not add a `WorkspaceGuard`, a `RequireWorkspaceRole`, or a
membership lookup** — that is item 1b, and building half of it here is what the refinement's
scope cut exists to prevent. A caller reaching another tenant's workspace is stopped by
row-level security, which is what SC-4 measures.

**A request for a workspace id that exists in another tenant must be indistinguishable from
one that does not exist.** The policy makes the row invisible, so the repository returns
`null` either way — render that as the same not-found response in both cases rather than
branching on which it was, because branching would require a read that RLS forbids and would
be an existence oracle if it succeeded.

`app.module.ts` gains `WorkspacesModule` in `imports`. That is the file's only change here.

## Out of scope for this TASK

The `workspaces` table, its policies, its registration and `WorkspaceRepository` (TASK-011).
Any web code (TASK-013). Endpoint-level isolation controls (TASK-014, TASK-015). Workspace
membership, invitations, roles, branding fields, per-workspace anything (item 1b and roadmap
item 3). Adding an entry to `ERROR_CODES`.

## Interfaces

**Consumes**

From TASK-011:
- `WorkspaceRepository` with `create(input: { name: string }): Promise<Workspace>`,
  `list(options: { includeArchived: boolean }): Promise<Workspace[]>`,
  `rename(id: string, name: string): Promise<Workspace>`,
  `archive(id: string): Promise<Workspace>`,
  `findById(id: string): Promise<Workspace | null>`

From TASK-006:
- `TenantTransactionInterceptor` — already registered globally; this controller's handlers
  run inside `withTenantTransaction` without opening one themselves
- `Public(justification: string)`, `NoTenantTransaction(justification: string)` — **neither is used by any route this TASK ships**

From TASK-005: `AuthGuard`, registered globally, populating `RequestContext` with `userId`,
`tenantId` and `emailVerified` from claims.

From `packages/contracts/src/errors.ts` (shipped): `errorEnvelopeContract`, `ERROR_CODES`,
`ERROR_CODE_STATUS`, `isZodError`, `toValidationDetails`, `MAX_VALIDATION_ISSUES = 100`,
`MAX_MESSAGES_PER_FIELD = 10`.

From `packages/contracts/src/pagination.ts` and `slug.ts` (shipped): available if the list
shape or the name rules need them.

**Produces**

- `packages/contracts/src/workspaces/index.ts` exporting:
  - `workspaceContract` — zod schema for the workspace row shape returned to a client
  - `type Workspace = z.infer<typeof workspaceContract>`
  - `createWorkspaceRequestContract` — `{ name: string }`
  - `renameWorkspaceRequestContract` — `{ name: string }`
  - `listWorkspacesQueryContract` — `{ includeArchived?: boolean }`
  - `workspaceListResponseContract` — the list envelope
- `packages/contracts/src/index.ts` — `export * from './workspaces';` uncommented and live
- `apps/api/src/workspaces/workspaces.controller.ts` — the four authenticated routes,
  request bodies parsed through the contracts above
- `apps/api/src/workspaces/workspaces.service.ts` — the four operations over
  `WorkspaceRepository`; a not-found and a cross-tenant id render identically
- `apps/api/src/workspaces/workspaces.module.ts` exporting `WorkspacesModule`
- `apps/api/src/app.module.ts` — `WorkspacesModule` added to `imports`
