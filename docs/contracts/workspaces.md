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
`rls-policy-template.md`'s per-table template **unchanged**: `ENABLE`, `FORCE`,
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

/** Added 2026-08-18 (TASK-1b-06): a `listForUser` row, the workspace and the user's role. */
export interface WorkspaceWithRole extends Workspace {
  readonly role: WorkspaceRole;       // branded, through `asWorkspaceRole`
}

@TenantScopedRepository()
@Injectable()
export class WorkspaceRepository {
  create(input: { name: string }): Promise<Workspace>;
  list(options: { includeArchived: boolean }): Promise<Workspace[]>;
  listForUser(userId: string, options: { includeArchived: boolean }): Promise<WorkspaceWithRole[]>;  // 2026-08-18, TASK-1b-06
  findById(id: string): Promise<Workspace | null>;
  rename(id: string, name: string): Promise<Workspace>;    // throws WorkspaceNotFoundError
  archive(id: string): Promise<Workspace>;                 // throws WorkspaceNotFoundError
}

export class WorkspaceNotFoundError extends DomainError { /* code 'not_found', 404 */ }
```

`Workspace` is the row shape; TASK-012's contract mirrors it field for field.

| Method | Statement | Qualification | Answer for a row the current tenant does not own |
|---|---|---|---|
| `create` | `INSERT ... (tenant_id, name) VALUES (currentTenantId(), $name) RETURNING *` | owner-qualified (`tenant_id` set explicitly) | n/a: the row lands under the current tenant, always |
| `list` | `SELECT * WHERE tenant_id = current [AND archived_at IS NULL] ORDER BY created_at, id` | owner-qualified | never returned |
| `listForUser` (2026-08-18, TASK-1b-06) | `SELECT w.*, m.role FROM workspaces w JOIN memberships m ON m.workspace_id = w.id AND m.tenant_id = w.tenant_id WHERE w.tenant_id = current AND m.tenant_id = current AND m.user_id = $user [AND w.archived_at IS NULL] ORDER BY w.created_at, w.id` | owner-qualified **on both tables** (the join pairs `(workspace_id, tenant_id)`, the WHERE names `tenant_id = current` on each) | never returned; a user with no `memberships` row lists nothing whatever the tenant holds |
| `findById` | `SELECT * WHERE id = $id AND tenant_id = current LIMIT 1` | owner-qualified | `null` |
| `rename` | `UPDATE SET name = $name, updated_at = now() WHERE id = $id AND tenant_id = current RETURNING *` | owner-qualified | throws `WorkspaceNotFoundError` |
| `archive` | `UPDATE SET archived_at = coalesce(archived_at, now()), updated_at = now() WHERE id = $id AND tenant_id = current RETURNING *` | owner-qualified | throws `WorkspaceNotFoundError` |

- `list` defaults to active only. `includeArchived: true` returns archived rows too, with
  `archivedAt` set (AC-23). Order is `created_at`, then `id`, so two rows created in one
  transaction (which share one `now()`) still list deterministically. `listForUser`
  (TASK-1b-06) keeps both rules and adds the membership filter; `list` stays for the isolation
  suite's repository subject and is no longer what a route calls (D-10).
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
   one whose context is open: enforced twice, by the policy and by the statement's own
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
  from `db/client.ts` (that export has an enumerated caller list and a repository is
  not on it) and takes no connection argument.
- **The three obligations of a tenant-scoped table land in one commit** (GC-A, F-239):
  the `tenant_id` column via `TENANT_ID_COLUMN_SQL`, the hand-appended
  `tenantScopedPolicies('workspaces')` block, and the `registerTenantScopedSurfaces()`
  call in `apps/api/test/isolation/registrations.ts`. `ALTER DEFAULT PRIVILEGES` grants
  `shortkit_app` full DML from the moment the table exists.
- **The isolation registration is two subjects on one table** (the F-353 pattern):
  `WorkspacesTableAccess` runs the eight-shape statement battery, which is where the
  table's three unqualified writes and the owner-column theft attempt live;
  `WorkspaceRepository` attempts the ~~five~~ six methods above (`listForUser` since
  2026-08-18, attempted for the target's seeded member under the actor's context) through
  the class itself, in both directions, mapping `WorkspaceNotFoundError` (and no other
  throw) to zero rows affected. Every method there declares `qualification: 'owner-qualified'`, which is the
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
- **Produced by:** TASK-012. Rulings are Design's, recorded here. **Amended 2026-08-18
  (TASK-1b-06, item 1b; D-07, D-10):** the routes learn roles: the param is `:workspaceId`,
  `GET /api/workspaces/:workspaceId` exists, `POST` writes the creator's membership, the list
  is membership-filtered, `workspaceRole` is on the wire.
- **ADRs:** ADR-0005, ADR-0006, ADR-0024, ADR-0025, ADR-0038, ADR-0062.

Every route answers under the `/api` global prefix (ADR-0006), is guarded by the global
`AuthGuard` and runs inside the tenant transaction the global `TenantTransactionInterceptor`
opens. None carries `@Public()` or `@NoTenantTransaction()`. The route **pattern** in the
first column is the log-safe form (`logging-and-headers.md`); a concrete path carries an id
and never appears on a log line.

> **Route table rewritten 2026-08-18 (TASK-1b-06).** The previous table had four rows, the
> param `:id`, no decorator column and no `GET` by id; `:id` → `:workspaceId` is a
> log-pattern-only rename (D-07: Form A resolves `params.workspaceId` first). The decorator
> column is `workspace-authorization.md`'s "Minimum role per surface", enforced by
> `WorkspaceAuthorizationInterceptor` inside the transaction, **before the handler**: 404
> `not_found` for no membership / another tenant's id / a non-uuid (the same body as the
> repository's `WorkspaceNotFoundError`, byte for byte; the oracle rule below), 403
> `insufficient_workspace_role` for a member below the minimum, 404 before 403.

| Route pattern | Minimum role (Form A decorator) | Request | Success | Errors |
|---|---|---|---|---|
| `POST /api/workspaces` | tenant `admin`, `@RequireTenantRole(TENANT_ROLE.admin)`; the signup `owner` passes, an invitee's tenant `member` does not | body `createWorkspaceRequestContract` `{ name }` | **201** `workspaceContract` with `workspaceRole: 'workspace_admin'`; **one `memberships` row (the creator, `workspace_admin`) is written in the same transaction** | 400 `validation_failed` (`details.fieldErrors.name`); 401 `unauthenticated`; 403 `insufficient_tenant_role`; 404 `not_found` (no `tenant_memberships` row) |
| `GET /api/workspaces` | none, **membership-filtered in the statement** (`listForUser`), not gated: a caller with no memberships gets `{ items: [] }` | query `listWorkspacesQueryContract` `?includeArchived=true\|false` (default `false`) | **200** `workspaceListResponseContract` `{ items: Workspace[] }`, each item carrying the caller's own `workspaceRole` | 400 `validation_failed` (`details.fieldErrors.includeArchived`); 401 |
| `GET /api/workspaces/:workspaceId` (**new**) | any membership, `@RequireWorkspaceRole(WORKSPACE_ROLE.viewer)` | no body | **200** `workspaceContract` with the caller's `workspaceRole` | 401; 404 `not_found` |
| `PATCH /api/workspaces/:workspaceId` | `@RequireWorkspaceRole(WORKSPACE_ROLE.workspace_admin)` | body `renameWorkspaceRequestContract` `{ name }` | **200** `workspaceContract` | 400 `validation_failed` (`name`); 401; 403 `insufficient_workspace_role`; 404 `not_found` |
| `POST /api/workspaces/:workspaceId/archive` | `@RequireWorkspaceRole(WORKSPACE_ROLE.workspace_admin)` | no body | **200** `workspaceContract`, idempotent | 401; 403 `insufficient_workspace_role`; 404 `not_found` |

There is no `DELETE`; archive is the retirement path. There is no member-management route in
1b (`workspace-authorization.md` lists them as not built); a second member arrives through
an invitation (`invitation-tokens.md`) and, in tests, through a seeded `memberships` row.

### What archiving stops, and what it does not (2026-08-19, TASK-2-05, AC-2-8)

**ARCHIVE GATES MANAGEMENT, NOT VISITORS. An archived workspace's existing links keep
serving.** `POST /api/links` naming an archived workspace and `PATCH /api/links/:linkId` on a
link inside one are both 400 `validation_failed`; the rows are untouched, and
`GET /:slug` resolves them exactly as before: the redirect reads `links` and `domains` and
consults no workspace at all (`redirect-resolution.md`'s decision order has no archive step,
and the hot path may not acquire one). An operator who wants a link to stop resolving deletes
the link.

`DELETE /api/links/:linkId` therefore stays OPEN on an archived workspace, deliberately: the
gate is on "create or edit" (AC-2-8's words), and closing the delete too would leave a live
redirect with no management path at all. Recorded here because the asymmetry looks like an
oversight from either side.

### Who sees and does what (2026-08-18, TASK-1b-06, D-10)

- **The creator becomes `workspace_admin`.** `POST` inserts the workspace and then the caller's
  `memberships` row (`WORKSPACE_ROLE.workspace_admin`) in the one tenant transaction the
  interceptor opened; a failure on the second statement rolls the first back. Without that row
  the workspace would be reachable by nobody, because:
- **There is no implicit tenant-owner bypass.** The status table in
  `workspace-authorization.md` is unconditional: a tenant `owner` with no `memberships` row in
  a workspace does not list it and gets 404 on it, like any non-member. Every tenant-level
  minimum in that contract is `admin` or `owner`; none reads "sees everything".
- **The list holds the caller's memberships**, each row with the caller's own role: a `member`
  sees `workspaceRole: 'member'` on the row an admin sees as `workspace_admin`. Order and
  `includeArchived` are unchanged from 1a.
- **Reachable gap, recorded (D-10):** a tenant `admin` (a role nothing in 1b grants) creating a
  workspace leaves the `owner` without a membership in it, and 1b has no add-member route to
  repair that.
- **Pre-1b volumes.** A workspace created before 1b has no `memberships` row; after 1b its
  creator cannot list, read, rename or archive it: the row is still there, invisible. **No
  backfill migration exists**, for the reason ADR-0062 records ("No backfill of
  `memberships`…": the migrator is `NOBYPASSRLS` under `FORCE`, so an `INSERT … SELECT` in a
  migration inserts zero rows and reports success, F-236's shape); ADR-0030 says there is no
  deploy target, and the compose stack seeds no workspaces, so the remedy is
  `docker compose down -v` (ADR-0032; README, TASK-1b-11).

### The client shape

```ts
export const workspaceContract = z.object({
  id: idContract,                              // uuid
  name: z.string(),
  archivedAt: z.string().datetime().nullable(), // null = active
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  workspaceRole: z.enum(WORKSPACE_ROLES).optional(), // 2026-08-18, TASK-1b-06: the CALLER's role in this workspace
});
export type Workspace = z.infer<typeof workspaceContract>;

export const workspaceListResponseContract = z.object({ items: z.array(workspaceContract) });
```

- **`tenantId` is not returned.** The caller is inside their own tenant (the guard put them
  there and the interceptor bound every statement to it), so the id tells them nothing they
  can act on, and it stays off the wire. The service maps the repository row through an
  explicit ~~five~~ six-field list; a column added to the table reaches the wire only when it
  is added to the contract and to that list.
- **`workspaceRole` (2026-08-18, TASK-1b-06)** is the caller's own role in that workspace:
  the literal `workspace_admin` on `POST`, the joined `memberships.role` per list item,
  `RequestContext.workspaceRole` (what the interceptor found) on the single-row routes. Named
  `workspaceRole`, never `role` (`workspace-authorization.md`: a wire field naming a role
  says which enum); unbranded on the wire (ADR-0048). **The API sends it on every response.**
  The schema admits its absence (`.optional()`) for the additive-versioning reason below: a
  client parsing the pre-1b shape (the web workspaces screen and its test fixtures, which
  TASK-1b-14 rewrites to render the role) must keep parsing until that card lands; removing
  the `.optional()` is that card's one-line tightening. A consumer that needs the brand goes
  through `asWorkspaceRole`.
- The three timestamps are ISO strings because they crossed JSON (`Date` in the row,
  `timestamptz` in the table).
- **No pagination in this initiative.** `{ items }` and nothing else: no cursor, no
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

> **Amended 2026-08-19 (debt sweep, ledger 1b-W1-09): control characters are refused.** A
> `.refine` after the bounds rejects any name containing a code point below U+0020 or U+007F
> (DEL), with the fixed message `NAME_CONTROL_CHARACTERS_MESSAGE` (`'Control characters are
> not allowed in a name.'`) keyed under `name` in `validation_failed` details like every
> other name issue. The finding: a newline in a stored name forges the console mail
> transport's block boundary. The refine runs on the TRIMMED value, so leading and trailing
> `\n`/`\t` never trip it (the trim already removed them); only interior control characters
> refuse. Ordinary unicode (accents, CJK, emoji) is untouched. The same rule and message
> apply to the signup `name` (`signUpRequestContract`, which also gained
> `SIGNUP_NAME_MAX_LENGTH = 200`), and through `on-user-created.ts`'s verbatim copy that
> covers `tenants.name`, the ledger's "workspace and tenant names" both. Rows written
> before this date may still hold control characters; nothing rewrites them, and the API
> refuses only new writes.

### `includeArchived`

Only the two query-string spellings `true` and `false` are parsed, explicitly, into the
boolean they name; a real boolean is accepted for a caller that builds the query as an
object. Anything else (`1`, `yes`, `TRUE`, a repeated parameter) is 400
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

`:workspaceId` is **not** validated at the route. A malformed id, an id that was never issued,
an id that belongs to another tenant **and, since 2026-08-18, a same-tenant workspace the
caller holds no membership in** are **one answer**: 404 `not_found`, the same envelope, the
same message, no id in the body. On the decorated routes it is the authorization interceptor
that answers, before the handler: `MembershipRepository.roleFor` returns "no membership" for
a non-uuid without reaching Postgres and for a missing, foreign or unjoined row after the
lookup matched nothing, and `WorkspaceAccessNotFoundError` carries the **same body as
`WorkspaceNotFoundError`, byte for byte** (`workspace-authorization.md`, "Status rules" (a);
asserted in `workspace-authorizer.spec.ts` and again in `workspaces.int-spec.ts` against live
responses). The repository's own `WorkspaceNotFoundError` is the floor under it, unchanged.
Answering 400 for a malformed id and 404 for a well-formed miss, or 404 for "no such
workspace" and anything else for "a workspace you may not see", would let a caller tell the
cases apart, which is a small oracle this contract rules out along with the larger one
(`error-envelope.md` invariant 5).

### Route policy on archived workspaces

- **Rename of an archived workspace is allowed.** The repository does not consult the archive
  state and neither does the route; the workspace keeps its `archivedAt`.
- **Archive is idempotent.** A second `POST …/archive` answers 200 with the first archival's
  timestamp (the repository's `coalesce(archived_at, now())`).
- There is no unarchive route in this initiative.

### What is now present (was "What is deliberately absent" until 2026-08-18)

Item 1a shipped these routes with authorization by tenancy alone: no guard, no
`RequireWorkspaceRole`, no membership lookup, no per-workspace role. TASK-1b-06 (item 1b)
supplied what that section deferred: `@RequireTenantRole` on create, `@RequireWorkspaceRole`
on the three single-row routes (read by `WorkspaceAuthorizationInterceptor`, the contract's
`WorkspaceGuard`), a `memberships` lookup inside the tenant transaction, the creator's
`workspace_admin` row, a membership-filtered list and `workspaceRole` on the wire. Tenancy is
still the outer boundary (row-level security and the repository's `tenant_id` predicate
answer another tenant's id with 404 before any role is read), and membership is now the
inner one, answered with the same 404.

What is still absent, and where it lives: member add/remove/role-change routes
(`workspace-authorization.md` lists them as not built in 1b); an unarchive route; a `DELETE`.

### Versioning

Adding a field to `workspaceContract` is additive and lands with the column (see
"Versioning" above). Changing a status, a code, the name bounds, the `includeArchived`
spellings or the not-found rule is a change to this section and to
`packages/contracts/src/workspaces/index.ts` together.
