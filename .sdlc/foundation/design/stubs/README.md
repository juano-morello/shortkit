# Design stubs

Sources at the paths they will occupy in the workspace. Signatures and types are
complete; bodies throw `not implemented`.

**These have not been compiled.** No `package.json` or `tsconfig.json` exists at the
time they were written (TASK-001 creates them), so no typecheck has been run against
them. Treat the shapes as the design-gate shape and the syntax as unverified.

Exception, 2026-08-07 (F-227, F-228): `apps/api/src/auth/auth-claims.ts`,
`apps/api/src/auth/ports/auth-rate-limit.port.ts` and
`apps/api/src/auth/resolve-rate-limit-principal.ts` were typechecked together under
`tsc --strict --module nodenext` at the versions the repo pins. They compile.

## A stub is not a normative form, and it does not outlive its TASK

**ADR-0039, accepted 2026-08-11.** A stub is deleted when the TASK that materialised its
file reaches `status: done`. From that point the source file at the same path is the
behaviour and the contract in `design/contracts/` is normative for what the file must do.
There is no second copy to keep in sync, and nobody is asked to sync one.

The materialising TASK is the one whose commit created the file, resolved from git, not
necessarily the one this file's `Produced by:` header names. Those have differed.

**This directory therefore shrinks.** A boundary missing from it was not left undesigned;
its stub was retired. The contract is where its design lives. Ten stubs were retired on
2026-08-11 and are recoverable with
`git log --diff-filter=D --name-only -- .sdlc/foundation/design/stubs/`.

Retired 2026-08-11, with the TASK that closed:

| Stub | Materialised by |
|---|---|
| `packages/contracts/src/errors.ts` | TASK-001 |
| `packages/contracts/src/index.ts` | TASK-001 |
| `packages/contracts/src/pagination.ts` | TASK-007 |
| `packages/contracts/src/roles.ts` | TASK-007 |
| `packages/contracts/src/slug.ts` | TASK-007 |
| `packages/contracts/src/domains/reserved-hostnames.ts` | TASK-007, ahead of its TASK-038 header |
| `apps/api/src/common/errors/domain-error.ts` | TASK-007 |
| `apps/api/src/db/rls.ts` | TASK-005 |
| `apps/api/src/tenancy/tenant-context.ts` | TASK-005 |
| `apps/web/src/lib/api/client.ts` | TASK-008 |

Two stubs whose file already exists are still here, and both go when their TASK closes:
`apps/api/src/observability/logger.ts` (TASK-003, in rework; superseded since F-249 and
unsafe to copy) and `apps/api/test/isolation/coverage.ts` (TASK-006, in fix round 4;
derived and stale, per `design/contracts/isolation-coverage.md`).

## Materialisation

| Stub root | Materialised by | Notes |
|---|---|---|
| `apps/api/src/**` | the producing TASK named in each file's header | |
| `apps/web/src/**` | TASK-012 | |
| `apps/api/test/**` | TASK-006, TASK-056 | |
| `infra/loadtest/**` | TASK-035 | |

Every surviving stub names a deferred producer except the two above.

## Rules

- Do not change a signature or a type without amending the matching contract in
  `design/contracts/`.
- Replace a `throw new Error('not implemented')` body with an implementation. Do not
  delete and rewrite the declaration.
- Every file names its producing TASK and its contract at the top.
- **Delete the stub in the commit that takes its TASK to `done`.** Before deleting, check
  two things and record them: every exported declaration in the stub exists in the source,
  and every capitalised rule in the stub exists in the source or in the contract. A missing
  one is a divergence to file, not a file to delete (ADR-0039, clause 4).

## Security-critical comments are load-bearing

Round 1 of the design security audit found three blockers and ten majors, and several of
them were things an implementer would have gotten wrong by taking the shortest path. The
capitalised warnings in these files record what the shortest path costs. Do not strip
them as noise. This applies to the source file just as much once the stub is retired,
where nothing marks a comment as load-bearing.

The ones most likely to be "simplified" back into defects:

| File | Rule |
|---|---|
| `apps/api/src/invitations/tokens/capability-token.ts` | verify the digest before any statement acts on the tenant (F-001) |
| `apps/api/src/gdpr/tenant-scoped-tables.ts` | three transactions, and assert the census is non-empty (F-002) |
| `apps/api/src/redirect/db/redirect-read.ts` | `AND state = 'active'` is part of the query shape (F-003) |
| `apps/api/src/clicks/click-event.types.ts` | never the leftmost `X-Forwarded-For` (F-009) |

Four more rules moved into shipped source when their stubs were retired. They are listed
here because the source is now the only place they live:

| Shipped file | Rule |
|---|---|
| `apps/api/src/tenancy/tenant-context.ts` | `set_config`, never `SET LOCAL`. `SET` takes no bind parameter (F-007). `tenantStorage` stays module-private: exporting it is a way to hold a tenant context that never set `app.tenant_id` (F-067) |
| `apps/api/src/common/errors/domain-error.ts` | The code travels on the error. Anything else is 500 `internal_error` with a fixed message, on purpose (ADR-0024) |
| `apps/web/src/lib/api/client.ts` | never `new URL(path, base)` for the proxy upstream (F-008) |
| `packages/contracts/src/roles.ts` | `member` is in both role enums and the compiler cannot tell them apart (F-012) |
