/**
 * Contract: design/contracts/tenant-scoped-tables.md
 * ADR: adr-0019-tenant-scoped-table-enumeration.md, adr-0003, adr-0015
 * Produced by: TASK-053 (enumeration, export), TASK-054 (eraser, residue check)
 *
 * Amendment A-2 governs erasure.
 * NEVER replace tenantScopedTables() with a hand-written array. A table added later
 * would be absent from it, escape both export and erasure, and nothing would fail.
 */
import type { PgTable } from 'drizzle-orm/pg-core';

export interface TenantScopedTable {
  readonly name: string;
  readonly table: PgTable;
}

/**
 * Derived at runtime from the Drizzle schema barrel: every exported PgTable having a
 * `tenant_id` column.
 *
 * THE COLUMN MUST BE NAMED EXACTLY `tenant_id`. A table using `owner_tenant_id` is
 * invisible to this filter AND to the SQL cross-check. The convention is load-bearing.
 */
export function tenantScopedTables(): TenantScopedTable[] {
  throw new Error('not implemented');
}

/** Every entry carries a justification. The cross-check subtracts these from both sides. */
export const TENANT_SCOPED_TABLE_EXCLUSIONS = [
  // cascade root: carries `id`, not `tenant_id`; handled explicitly by the eraser
  'tenants',
] as const;

/**
 * Better Auth's tables. No tenant_id, no RLS (ADR-0003, ADR-0015), so they are
 * deliberately NOT in tenantScopedTables().
 *
 * GENUINELY HAND-MAINTAINED. A test asserts this against Better Auth's generated
 * schema file so an upgrade adding a table fails visibly rather than escaping erasure.
 */
export function authOwnedUserTables(): string[] {
  throw new Error('not implemented');
}

/**
 * The independent second enumeration. Asserted set-equal to tenantScopedTables()
 * in the integration suite. Catches a table added by raw SQL, and a table added to
 * the schema but missing from the barrel.
 *
 *   SELECT table_name FROM information_schema.columns
 *   WHERE table_schema = 'public' AND column_name = 'tenant_id';
 */
export function tenantScopedTableNamesFromDatabase(): Promise<string[]> {
  throw new Error('not implemented');
}

/**
 * ============================================================================
 * Exclusion 2 of exactly 2 (TASK-056). Amendment A-2.
 * ============================================================================
 *
 * The single non-tenant-facing mutation surface on click_events and audit_entries.
 * Reachable ONLY from POST /api/gdpr/delete, under tenant `owner` plus the documented
 * confirmation (AC-92, AC-105, AC-106).
 *
 * THIS IS THE ONLY FILE THAT MAY CONTAIN THE STRING `app.privileged_erase`.
 * The flag names ONE tenant, so even the eraser cannot cross tenants.
 *
 * Sequence, one transaction:
 *   SET LOCAL app.privileged_erase = '<tenantId>'
 *   SELECT user_id FROM tenant_memberships WHERE tenant_id = ...
 *   DELETE FROM tenants WHERE id = ...        -- cascades every tenant_id table
 *   DELETE FROM "user" WHERE id = ANY(...)    -- cascades session/account/verification
 *
 * Step 3 relies on ON DELETE CASCADE. PostgreSQL runs referential actions with row
 * security bypassed. assertNoTenantResidue is what makes that safe to assume: if the
 * cascade misses a table it fails and names it, and the fallback is explicit per-table
 * DELETEs in reverse dependency order driven by the same enumeration.
 */
export interface PrivilegedTenantEraser {
  erase(tenantId: string): Promise<{ deletedUserIds: string[] }>;
}

/** AC-90. Zero rows for the tenant in every table, and zero orphans. */
export function assertNoTenantResidue(
  _tenantId: string,
  _deletedUserIds: string[],
): Promise<void> {
  throw new Error('not implemented');
}

export interface ExportManifest {
  tenantId: string;
  exportedAt: string;
  /** Latest applied migration tag: how a consumer knows the NDJSON row shape. */
  schemaVersion: string;
  tables: Array<{ name: string; rowCount: number; file: string }>;
}
