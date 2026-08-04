# Design stubs

Sources at the paths they will occupy in the workspace. Signatures and types are
complete; bodies throw `not implemented`.

**These have not been compiled.** No `package.json` or `tsconfig.json` exists at the
time they were written (TASK-001 creates them), so no typecheck has been run against
them. Treat the shapes as normative and the syntax as unverified.

## Materialisation

| Stub root | Materialised by | Notes |
|---|---|---|
| `packages/contracts/src/**` | **TASK-001** scaffolds the workspace, **TASK-007** materialises and completes | TASK-001 needs at least `errors.ts` and `index.ts` present to satisfy AC-4's cross-workspace import |
| `apps/api/src/**` | the producing TASK named in each file's header | |
| `apps/web/src/**` | TASK-008, TASK-012 | |
| `apps/api/test/**` | TASK-006, TASK-056 | |
| `infra/loadtest/**` | TASK-035 | |

**TASK-001 and TASK-007 must verify these compile** and fix any syntax or import error
found. A fix at that point is expected, not a defect in the stub.

## Rules

- Do not change a signature or a type without amending the matching contract in
  `design/contracts/`.
- Replace a `throw new Error('not implemented')` body with an implementation. Do not
  delete and rewrite the declaration.
- Every file names its producing TASK and its contract at the top.

## Security-critical comments are load-bearing

Round 1 of the design security audit found three blockers and ten majors, and several of
them were things an implementer would have gotten wrong by taking the shortest path. The
capitalised warnings in these files record what the shortest path costs. Do not strip
them as noise.

The ones most likely to be "simplified" back into defects:

| File | Rule |
|---|---|
| `apps/api/src/tenancy/tenant-context.ts` | `set_config`, never `SET LOCAL`. `SET` takes no bind parameter (F-007) |
| `apps/api/src/invitations/tokens/capability-token.ts` | verify the digest before any statement acts on the tenant (F-001) |
| `apps/api/src/gdpr/tenant-scoped-tables.ts` | three transactions, and assert the census is non-empty (F-002) |
| `apps/api/src/redirect/db/redirect-read.ts` | `AND state = 'active'` is part of the query shape (F-003) |
| `apps/web/src/lib/api/client.ts` | never `new URL(path, base)` for the proxy upstream (F-008) |
| `apps/api/src/clicks/click-event.types.ts` | never the leftmost `X-Forwarded-For` (F-009) |
| `packages/contracts/src/roles.ts` | `member` is in both role enums and the compiler cannot tell them apart (F-012) |
