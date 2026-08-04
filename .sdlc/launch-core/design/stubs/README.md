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
