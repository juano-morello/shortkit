# Contract: the `workspaces` table and `WorkspaceRepository`

- **Boundary:** `apps/api/src/db/schema/workspaces.ts` and
  `apps/api/src/workspaces/workspace.repository.ts`, between the TASK that creates the
  table and its repository (TASK-011) and the TASKs that read it through the repository
  (TASK-012, the endpoints) or attempt it in the isolation suite (TASK-014, TASK-015).
- **Normative form:** the DDL, the TypeScript signatures and the method table below.
- **Produced by:** TASK-011.
- **Consumed by:** TASK-012 (`packages/contracts` mirrors `Workspace`; the endpoints call
  the repository), TASK-013, TASK-014, TASK-015 (isolation), TASK-053 (export, through
  `tenantScopedTables()`), TASK-054 (erasure, through the cascade).
- **ADRs:** ADR-0002, ADR-0003, ADR-0004, ADR-0019, ADR-0020, ADR-0021, ADR-0024, ADR-0049.

## The table

```sql
CREATE TABLE workspaces (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,   -- TENANT_ID_COLUMN_SQL, verbatim
  name        text NOT NULL,
  archived_at timestamptz NULL,                                         -- null = active
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
-- plus, hand-appended to migration 0002: tenantScopedPolicies('workspaces'), unchanged.
```

Migration: `apps/api/drizzle/0002_*.sql`. Template-shaped, so it takes
`rls-policy-template.md`'s per-table template **unchanged** — `ENABLE`, `FORCE`,
`workspaces_tenant_isolation` (`FOR ALL`, matching `USING` and `WITH CHECK` on `tenant_id`
through the `nullif` wrapper), `workspaces_privileged_erase` (`FOR DELETE`), and
`workspaces_tenant_id_idx`. It is not a cascade root and carries none of `tenants`'
bespoke policies. `pnpm db:check-policies` reports it `ok` (AC-25);
`test/workspaces/workspace-repository.int-spec.ts` additionally holds the migration file
to `tenantScopedPolicies('workspaces')`'s output verbatim and the catalogue to the shape
above.

### Rulings, recorded here and in the schema file's docblock

| Question | Ruling | Why |
|---|---|---|
| Archive representation | `archived_at timestamptz NULL`; null means active | It is the observable AC-23 needs, it records **when**, and a third state later needs no enum migration. Not a boolean, not a status enum. |
| `id` | Database-generated, `gen_random_uuid()` | `tenants.id` is application-supplied because signup mints it and opens the tenant transaction under it before inserting (ADR-0021). A workspace is created inside an already-open tenant transaction, so that reason does not apply. |
| Uniqueness on `name` | None | No AC requires it, a duplicate is harmless, and a unique constraint would need an error code this contract does not have. |
| Name bounds | Not the table's concern; it stores `text` | Bounds are TASK-012's contract in `packages/contracts`. |
| `updated_at` | Set by the repository on every write, `now()` from Postgres | No trigger exists anywhere in the schema and this table is not where one starts. |

## The repository

```ts
export interface Workspace {
  readonly id: string;
  readonly tenantId: string;
  readonly name: string;
  readonly archivedAt: Date | null;   // null = active
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

@TenantScopedRepository()
@Injectable()
export class WorkspaceRepository {
  create(input: { name: string }): Promise<Workspace>;
  list(options: { includeArchived: boolean }): Promise<Workspace[]>;
  findById(id: string): Promise<Workspace | null>;
  rename(id: string, name: string): Promise<Workspace>;    // throws WorkspaceNotFoundError
  archive(id: string): Promise<Workspace>;                 // throws WorkspaceNotFoundError
}

export class WorkspaceNotFoundError extends DomainError { /* code 'not_found', 404 */ }
```

`Workspace` is the row shape; TASK-012's contract mirrors it field for field.

| Method | Statement | Qualification | Answer for a row the current tenant does not own |
|---|---|---|---|
| `create` | `INSERT ... (tenant_id, name) VALUES (currentTenantId(), $name) RETURNING *` | owner-qualified (`tenant_id` set explicitly) | n/a — the row lands under the current tenant, always |
| `list` | `SELECT * WHERE tenant_id = current [AND archived_at IS NULL] ORDER BY created_at, id` | owner-qualified | never returned |
| `findById` | `SELECT * WHERE id = $id AND tenant_id = current LIMIT 1` | owner-qualified | `null` |
| `rename` | `UPDATE SET name = $name, updated_at = now() WHERE id = $id AND tenant_id = current RETURNING *` | owner-qualified | throws `WorkspaceNotFoundError` |
| `archive` | `UPDATE SET archived_at = coalesce(archived_at, now()), updated_at = now() WHERE id = $id AND tenant_id = current RETURNING *` | owner-qualified | throws `WorkspaceNotFoundError` |

- `list` defaults to active only. `includeArchived: true` returns archived rows too, with
  `archivedAt` set (AC-23). Order is `created_at`, then `id`, so two rows created in one
  transaction — which share one `now()` — still list deterministically.
- `archive` is idempotent: `archived_at` keeps the first archival's timestamp on a second
  call. `rename` does not consult the archive state; whether a route may rename an archived
  workspace is TASK-012's contract, not this class's.
- An `id` that is not a uuid is answered as not-found (`null` / `WorkspaceNotFoundError`)
  without reaching Postgres, so a malformed reference is a 404 and not a 22P02 turned 500.
  Route-level validation is TASK-012's; this is the repository's floor.
- "Another tenant's workspace" and "no such workspace" are **the same answer, on purpose**.
  Distinguishing them would tell a caller that an id exists somewhere.

## What the caller may assume

1. Every method runs against the ambient tenant transaction (`tenantDb()`) and throws
   `TenantContextMissingError` outside one. There is no client parameter and no
   unscoped path.
2. No method returns, renames, archives or creates a row belonging to any tenant but the
   one whose context is open — enforced twice, by the policy and by the statement's own
   `tenant_id` predicate.
3. `WorkspaceNotFoundError` is a `DomainError` with code `not_found`; the exception filter
   maps it to 404 with the standard envelope. Its message carries no id.
4. `create` returns the persisted row including its database-generated `id`, `createdAt`
   and `updatedAt`.

## What the implementer must guarantee

- **Every statement is owner-qualified even though the policy already scopes it.** Every
  `WHERE` names `tenant_id = currentTenantId()`; the insert sets `tenant_id` explicitly.
  PostgreSQL routes an owner-qualified write through the SELECT policy and reports zero
  rows however wide open the UPDATE policy is (F-302), so a repository relying on the
  policy alone issues statements whose refusal proves less than it appears to. The unit
  spec compiles every statement against a recording driver and asserts the qualification;
  a statement without `tenant_id` fails it.
- **`tenantDb()` and nothing else.** The repository never imports `databaseTransaction`
  from `db/client.ts` — that export has an enumerated caller list and a repository is
  not on it — and takes no connection argument.
- **The three obligations of a tenant-scoped table land in one commit** (GC-A, F-239):
  the `tenant_id` column via `TENANT_ID_COLUMN_SQL`, the hand-appended
  `tenantScopedPolicies('workspaces')` block, and the `registerTenantScopedSurfaces()`
  call in `apps/api/test/isolation/registrations.ts`. `ALTER DEFAULT PRIVILEGES` grants
  `shortkit_app` full DML from the moment the table exists.
- **The isolation registration is two subjects on one table** (the F-353 pattern):
  `WorkspacesTableAccess` runs the eight-shape statement battery, which is where the
  table's three unqualified writes and the owner-column theft attempt live;
  `WorkspaceRepository` attempts the five methods above through the class itself, in both
  directions, mapping `WorkspaceNotFoundError` — and no other throw — to zero rows
  affected. Every method there declares `qualification: 'owner-qualified'`, which is the
  property the unit spec proves. Removing the registration fails the run naming
  `workspaces` as unregistered (AC-26, `tenantScopedTableDrift()`).
- **`WorkspaceNotFoundError` is never wrapped.** The filter does not walk `cause`.
- Adding a column adds it to `Workspace` and to TASK-012's mirror in the same commit;
  the isolation suite's per-row digest already covers it.

## Error cases

| Situation | Answer |
|---|---|
| No tenant context | `TenantContextMissingError` (a plain `Error`; the filter answers 500, which is the intended crash) |
| `rename`/`archive` on an id the tenant does not own, or a non-uuid | `WorkspaceNotFoundError`, `not_found`, 404 |
| `findById` likewise | `null` |
| A row-level security refusal on any statement | propagates as the driver's error; the repository's own predicate makes it unreachable in practice, and the isolation suite would name it |

## Versioning

Adding a column is a new migration plus a field on `Workspace` and its mirror. Changing the
archive representation, the id strategy or the not-found semantics is a change to this
contract and to `apps/api/src/db/schema/workspaces.ts`'s docblock together.

## Endpoints

- **Boundary:** `apps/api/src/workspaces/workspaces.controller.ts` and
  `packages/contracts/src/workspaces/index.ts`, between the API and every client
  (TASK-013's web screens through the BFF, and the isolation suite).
- **Normative form:** the schemas in `packages/contracts/src/workspaces/index.ts` and the
  route table below.
- **Produced by:** TASK-012. Rulings are Design's, recorded here.
- **ADRs:** ADR-0005, ADR-0006, ADR-0024, ADR-0025, ADR-0038.

Every route answers under the `/api` global prefix (ADR-0006), is guarded by the global
`AuthGuard` and runs inside the tenant transaction the global `TenantTransactionInterceptor`
opens. None carries `@Public()` or `@NoTenantTransaction()`. The route **pattern** in the
first column is the log-safe form (`logging-and-headers.md`); a concrete path carries an id
and never appears on a log line.

| Route pattern | Request | Success | Errors |
|---|---|---|---|
| `POST /api/workspaces` | body `createWorkspaceRequestContract` `{ name }` | **201** `workspaceContract` | 400 `validation_failed` (`details.fieldErrors.name`); 401 `unauthenticated` |
| `GET /api/workspaces` | query `listWorkspacesQueryContract` `?includeArchived=true\|false` (default `false`) | **200** `workspaceListResponseContract` `{ items: Workspace[] }` | 400 `validation_failed` (`details.fieldErrors.includeArchived`); 401 |
| `PATCH /api/workspaces/:id` | body `renameWorkspaceRequestContract` `{ name }` | **200** `workspaceContract` | 400 `validation_failed` (`name`); 401; 404 `not_found` |
| `POST /api/workspaces/:id/archive` | no body | **200** `workspaceContract`, idempotent | 401; 404 `not_found` |

### The client shape

```ts
export const workspaceContract = z.object({
  id: idContract,                              // uuid
  name: z.string(),
  archivedAt: z.string().datetime().nullable(), // null = active
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Workspace = z.infer<typeof workspaceContract>;

export const workspaceListResponseContract = z.object({ items: z.array(workspaceContract) });
```

- **`tenantId` is not returned.** The caller is inside their own tenant — the guard put them
  there and the interceptor bound every statement to it — so the id tells them nothing they
  can act on, and it stays off the wire. The service maps the repository row through an
  explicit five-field list; a column added to the table reaches the wire only when it is
  added to the contract and to that list.
- The three timestamps are ISO strings because they crossed JSON (`Date` in the row,
  `timestamptz` in the table).
- **No pagination in this initiative.** `{ items }` and nothing else — no cursor, no
  `hasMore`. A tenant holds a handful of workspaces and no AC asks for a page; adding one
  later is an additive change to this shape. `pagination.ts`'s `paginated()` remains the shape
  for lists that grow without bound. Order is the repository's: `created_at`, then `id`.

### The name rule

`workspaceNameContract = z.string().trim().min(1).max(100)`, exported with
`WORKSPACE_NAME_MIN_LENGTH = 1` and `WORKSPACE_NAME_MAX_LENGTH = 100`. **The trim runs before
the length check**, so a whitespace-only name is refused as empty, a hundred characters
wrapped in whitespace is accepted, and what is stored and returned is the trimmed value.
`create` and `rename` apply the same rule; the table stores `text` and enforces nothing
(the "Rulings" table above).

### `includeArchived`

Only the two query-string spellings `true` and `false` are parsed, explicitly, into the
boolean they name; a real boolean is accepted for a caller that builds the query as an
object. Anything else — `1`, `yes`, `TRUE`, a repeated parameter — is 400
`validation_failed` under `includeArchived`, so a typo does not silently list the wrong set.
Absent means `false`; the default is applied by the service, not the schema, so `z.infer`
keeps the field optional.

### Validation failures

Bodies and queries are parsed through the contracts inside the handler (no
`ZodValidationPipe` exists; ADR-0025 "Follow-ups"). A `ZodError` becomes a
`DomainError('validation_failed', …)` carrying `toValidationDetails(error)` as `details`, so
the body is `{ code: 'validation_failed', message, details: { fieldErrors } }` keyed by field
(AC-24: an invalid `name` keys at least one issue under `name`), at the status
`ERROR_CODE_STATUS.validation_failed` fixes. A body that is not JSON never reaches the
handler: the filter's framework-400 branch answers the same code with the issue under
`_form` and a fixed message (`error-envelope.md`, "Branch 3").

### Not found, and what it does not disclose

`:id` is **not** validated at the route. A malformed id, an id that was never issued and an
id that belongs to another tenant are **one answer**: 404 `not_found`, the same envelope,
the same message, no id in the body. The repository answers `WorkspaceNotFoundError` for a
non-uuid without reaching Postgres and for an unowned or missing row after the update matched
nothing; the service passes it through unwrapped and the filter renders it. Answering 400 for
a malformed id and 404 for a well-formed miss would let a caller tell the two apart, which
is a small oracle this contract rules out along with the larger one (`error-envelope.md`
invariant 5).

### Route policy on archived workspaces

- **Rename of an archived workspace is allowed.** The repository does not consult the archive
  state and neither does the route; the workspace keeps its `archivedAt`.
- **Archive is idempotent.** A second `POST …/archive` answers 200 with the first archival's
  timestamp (the repository's `coalesce(archived_at, now())`).
- There is no unarchive route in this initiative.

### What is deliberately absent

No `WorkspaceGuard`, no `RequireWorkspaceRole`, no membership lookup, no per-workspace role
(item 1b). Authorization in this initiative is tenancy: a caller reaching another tenant's
workspace is stopped by row-level security and by the repository's own `tenant_id`
predicate, and sees 404.

### Versioning

Adding a field to `workspaceContract` is additive and lands with the column (see
"Versioning" above). Changing a status, a code, the name bounds, the `includeArchived`
spellings or the not-found rule is a change to this section and to
`packages/contracts/src/workspaces/index.ts` together.
