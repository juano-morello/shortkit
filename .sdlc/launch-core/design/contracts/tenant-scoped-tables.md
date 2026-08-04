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
export interface TenantCensus {
  readonly tenantId: string;
  /** Row count per table, taken BEFORE erasure, in ordinary tenant context. */
  readonly rowCounts: Readonly<Record<string, number>>;
  /** Member user ids. Always >= 1: the owner making the request is a member. */
  readonly userIds: readonly string[];
}

export interface EraseResult {
  /**
   * PostgreSQL reports rows affected by the issued statement only, never by a cascade,
   * so there is no per-table count to return here. Per-table completeness is asserted
   * by comparing the phase 1 census against the phase 3 residue check.
   */
  readonly tenantsDeleted: number;   // must be 1
  readonly usersDeleted: number;     // must equal census.userIds.length
}

export interface PrivilegedTenantEraser {
  /** Takes the census as input. It does not, and cannot, collect it itself. */
  erase(census: TenantCensus): Promise<EraseResult>;
}

export declare function collectTenantCensus(tenantId: string): Promise<TenantCensus>;
export declare function assertNoTenantResidue(census: TenantCensus): Promise<void>;
```

`privilegedTenantEraser` is **the single non-tenant-facing mutation surface on
`click_events` and `audit_entries`** (Amendment A-2). It lives in
`apps/api/src/gdpr/privileged-eraser.ts` and is reachable only from
`POST /api/gdpr/delete`.

### Three transactions, not one

Revised 2026-08-04 (F-002). The previous single-transaction sequence **deleted nothing
while reporting success**: it set only `app.privileged_erase`, so the opening
`SELECT user_id FROM tenant_memberships` was denied by `tenant_isolation` (which tests
the unset `app.tenant_id`) and not admitted by the erase policy (which is `FOR DELETE`).
`userIds` came back empty, the account delete hit nobody, and the residue check asserted
zero over an empty set and passed. `DELETE FROM tenants` was denied for the same reason.

`POST /api/gdpr/delete` carries `@NoTenantTransaction` (`tenant-context.md`) so it can
open all three itself.

**Phase 1, census. Ordinary tenant context.**

```sql
BEGIN;
SELECT set_config('app.tenant_id', $1, true);
SELECT user_id FROM tenant_memberships;                 -- RLS scopes it
SELECT count(*) FROM <each table in tenantScopedTables()>;
COMMIT;
```

Assertions, before anything is deleted:

- `census.userIds.length >= 1`, else throw. The owner issuing the request is a member of
  their own tenant, so an empty list means RLS denied the read and the erase would be a
  silent no-op.
- `census.rowCounts['tenant_memberships'] >= 1`, same reason.

**Phase 2, erase. Privileged context.**

```sql
BEGIN;
SELECT set_config('app.privileged_erase', $1, true);
DELETE FROM tenants WHERE id = $1;          -- cascades every tenant_id table
DELETE FROM "user"  WHERE id = ANY($2);     -- cascades session/account/verification
COMMIT;
```

Assertions:

- `DELETE FROM tenants` reports **rowCount 1**, else throw and roll back.
- `DELETE FROM "user"` reports **rowCount = census.userIds.length**, else throw and
  roll back.

`tenants_privileged_erase` (`rls-policy-template.md`) is the only `DELETE` policy on
`tenants`, so this statement is the only way that row can be removed. `"user"` has no
RLS, so it needs no policy.

The cascade relies on `ON DELETE CASCADE` on every `tenant_id` foreign key. PostgreSQL
runs referential actions with row security bypassed, so it reaches rows the erase policy
alone would not.

**Phase 3, verify. Ordinary tenant context again.**

`assertNoTenantResidue(census)` re-opens `withTenantTransaction(tenantId)`, iterates
`tenantScopedTables()` counting rows, iterates `authOwnedUserTables()` for
`census.userIds`, and asserts zero everywhere plus no orphan referencing a deleted
parent (AC-90). It reads under the ordinary `tenant_isolation` policy, which matches any
surviving row, so a missed cascade is visible.

**Why "zero before, zero after" can no longer pass:** phase 1 asserts the census is
non-empty, and phase 2 asserts the deleted counts match it. Both must be non-zero before
phase 3's zero means anything.

If the cascade ever misses a table, phase 3 fails and names it, and the fallback is an
explicit per-table `DELETE` in reverse dependency order driven by the same enumeration.

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
7. **An erasure that deletes nothing fails loudly.** Phase 1 asserts a non-empty census
   and phase 2 asserts deleted counts matching it, so a policy denial can no longer
   present as a completed erasure.
8. **No ordinary code path can delete a `tenants` row**, so the cascade is reachable
   only from this eraser (`rls-policy-template.md`).

## What the implementer must guarantee

- Every schema TASK declares `tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE`.
  Declaring the column without the foreign key produces orphans that only AC-90 finds.
- `authOwnedUserTables()` is genuinely hand-maintained. A test asserts its contents
  against Better Auth's generated schema file so an upgrade adding a table fails
  visibly.
- The export streams NDJSON. It holds a connection for its duration.
- **An integration test asserts non-zero deleted-row counts per table, not only zero
  residue.** Seed a tenant with rows in every table from `tenantScopedTables()`, erase,
  and assert each count went from `n > 0` to `0`. "Zero before, zero after" is the
  failure mode this contract exists to prevent.
- The three phases are three transactions. Do not collapse them: phase 2 needs a
  different context flag from phases 1 and 3, and nesting them holds two pooled
  connections.

## Versioning

`tenantScopedTables()` is derived, so it has no version. `manifest.json`'s
`schemaVersion` is the latest applied migration tag, which is how a consumer knows what
shape the NDJSON rows have.
