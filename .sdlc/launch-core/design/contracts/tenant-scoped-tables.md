# Contract: table enumeration, GDPR export, and privileged erasure

- **Boundary:** the enumeration shared by export, deletion, and the isolation suite.
- **Normative form:** `apps/api/src/gdpr/tenant-scoped-tables.ts` (stub: `design/stubs/apps/api/src/gdpr/tenant-scoped-tables.ts`).
- **Produced by:** TASK-053 (`tenantScopedTables`, export), TASK-054 (eraser, residue check).
- **Consumed by:** TASK-054, TASK-055, TASK-056.
- **ADRs:** ADR-0019, ADR-0003, ADR-0015. Amendment A-2 governs erasure.

## Normative types

```ts
export interface TenantScopedTable {
  readonly name: string;
  readonly table: PgTable;
}

/** Derived from the Drizzle schema barrel at runtime. Never a hand-written array. */
export declare function tenantScopedTables(): TenantScopedTable[];

/**
 * Tables with a tenant_id column that are deliberately not in the list.
 * Every entry carries a justification comment.
 */
export const TENANT_SCOPED_TABLE_EXCLUSIONS = [
  'tenants',   // cascade root: carries `id`, not `tenant_id`; handled explicitly
] as const;

/** Better Auth's tables. No tenant_id, no RLS. Separately named on purpose. */
export declare function authOwnedUserTables(): string[];   // ['user','session','account','verification']
```

## Derivation and cross-check

Construction filters the Drizzle schema barrel for tables having a `tenant_id` column.

Verification is a separate, independent enumeration, asserted equal in the integration
suite:

```sql
SELECT table_name FROM information_schema.columns
WHERE table_schema = 'public' AND column_name = 'tenant_id';
```

Set inequality in either direction fails and names the offending table. That is what
catches a table added by raw SQL, and a table added to the schema but missing from the
barrel.

**The column must be named exactly `tenant_id`.** A table using `owner_tenant_id` is
invisible to both enumerations. The naming convention is load-bearing and only code
review enforces it.

## Export

| Method | Path | Role |
|---|---|---|
| `POST` | `/api/gdpr/export` | tenant **`owner`** (AC-105) |

Runs inside `withTenantTransaction`, so **RLS is the isolation mechanism** and AC-89
asserts an outcome rather than an intention.

Archive: a zip containing one NDJSON file per table from `tenantScopedTables()`, plus
member identity from `tenant_memberships` joined to `user`, plus:

```json
// manifest.json
{ "tenantId": "...", "exportedAt": "...", "schemaVersion": "<latest migration tag>",
  "tables": [{ "name": "links", "rowCount": 42, "file": "links.ndjson" }] }
```

Every category in AC-88 is present because the enumeration produces it: workspaces,
members, domains, links, click events, audit entries. `ip_hash` is exported; raw IPs do
not exist to export (GC-9).

## Erasure

| Method | Path | Role | Extra |
|---|---|---|---|
| `POST` | `/api/gdpr/delete` | tenant **`owner`** | body must carry `confirmation` equal to the tenant name, else 400 `confirmation_required` (AC-92) |

```ts
export interface PrivilegedTenantEraser {
  erase(tenantId: string): Promise<{ deletedUserIds: string[] }>;
}
export declare function assertNoTenantResidue(tenantId: string, userIds: string[]): Promise<void>;
```

`privilegedTenantEraser` is **the single non-tenant-facing mutation surface on
`click_events` and `audit_entries`** (Amendment A-2). It lives in
`apps/api/src/gdpr/privileged-eraser.ts` and is reachable only from `POST /api/gdpr/delete`.

Sequence, one transaction:

```sql
BEGIN;
SET LOCAL app.privileged_erase = '<tenantId>';       -- policy scopes DELETE to this tenant
-- 1. collect user ids
SELECT user_id FROM tenant_memberships WHERE tenant_id = '<tenantId>';
-- 2. cascade every tenant_id-bearing table
DELETE FROM tenants WHERE id = '<tenantId>';
-- 3. remove the accounts, cascading Better Auth's session/account/verification
DELETE FROM "user" WHERE id = ANY($userIds);
COMMIT;
```

Step 2 relies on `ON DELETE CASCADE` on every `tenant_id` foreign key. PostgreSQL runs
referential actions with row security bypassed, so the cascade reaches rows the erase
policy alone would not. **`assertNoTenantResidue` is what makes that assumption safe to
make:** if the cascade misses a table, the check fails and names it, and the fallback is
an explicit per-table `DELETE` in reverse dependency order driven by the same
enumeration.

`assertNoTenantResidue` iterates `tenantScopedTables()` counting rows for the tenant,
iterates `authOwnedUserTables()` for `userIds`, and asserts zero everywhere plus no
orphan referencing a deleted parent (AC-90).

## Invariants a caller may rely on

1. A table added later with a `tenant_id` column appears in export, in erasure, and in
   the isolation suite with no other edit (AC-88, AC-90).
2. An export contains zero rows belonging to another tenant, enforced by RLS (AC-89).
3. Rows are hard-deleted, not marked (AC-90).
4. After erasure the tenant's members cannot log in, because their `user` rows are gone
   (AC-91), and their links return the branded 404 rather than a 5xx.
5. No authenticated tenant-facing route invokes the eraser except `POST /api/gdpr/delete`
   (AC-106), asserted by TASK-056's route enumeration.
6. Even the eraser cannot cross tenants: the policy compares `tenant_id` to the flag.

## What the implementer must guarantee

- Every schema TASK declares `tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE`.
  Declaring the column without the foreign key produces orphans that only AC-90 finds.
- `authOwnedUserTables()` is genuinely hand-maintained. A test asserts its contents
  against Better Auth's generated schema file so an upgrade adding a table fails
  visibly.
- The export streams NDJSON. It holds a connection for its duration.

## Versioning

`tenantScopedTables()` is derived, so it has no version. `manifest.json`'s
`schemaVersion` is the latest applied migration tag, which is how a consumer knows what
shape the NDJSON rows have.
