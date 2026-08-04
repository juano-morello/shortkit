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
 * REVISED 2026-08-04 (F-002). The original single-transaction sequence DELETED NOTHING
 * WHILE REPORTING SUCCESS: it set only app.privileged_erase, so the opening SELECT of
 * tenant_memberships was denied by tenant_isolation (which tests the unset
 * app.tenant_id) and not admitted by the erase policy (which is FOR DELETE). userIds
 * came back empty, no account was deleted, DELETE FROM tenants was denied the same way,
 * and the residue check asserted zero over an empty set and passed.
 *
 * THREE transactions now. POST /api/gdpr/delete carries @NoTenantTransaction so it can
 * open all three itself.
 *
 *  Phase 1  collectTenantCensus   ordinary tenant context   assert census NON-EMPTY
 *  Phase 2  erase                 privileged context        assert deleted counts MATCH
 *  Phase 3  assertNoTenantResidue ordinary tenant context   assert zero everywhere
 *
 * "Zero rows before, zero rows after" can no longer pass.
 */
export interface TenantCensus {
  readonly tenantId: string;
  /** Row count per table, taken BEFORE erasure, under tenant_isolation. */
  readonly rowCounts: Readonly<Record<string, number>>;
  /** Member user ids. ALWAYS >= 1: the owner making the request is a member. */
  readonly userIds: readonly string[];
}

/**
 * Phase 1. Runs inside withTenantTransaction(tenantId).
 * THROWS if userIds is empty or rowCounts['tenant_memberships'] is 0 — that means RLS
 * denied the read and the erase would be a silent no-op.
 */
export function collectTenantCensus(_tenantId: string): Promise<TenantCensus> {
  throw new Error('not implemented');
}

/**
 * Phase 2. Takes the census as INPUT; it does not, and cannot, collect it itself.
 *
 *   SELECT set_config('app.privileged_erase', $1, true);
 *   DELETE FROM tenants WHERE id = $1;        -- assert rowCount === 1
 *   DELETE FROM "user"  WHERE id = ANY($2);   -- assert rowCount === census.userIds.length
 *
 * tenants_privileged_erase is the ONLY DELETE policy on tenants (ADR-0003), so the
 * first statement is the only way that row can be removed anywhere in the system.
 * The cascade relies on ON DELETE CASCADE; PostgreSQL runs referential actions with
 * row security bypassed. "user" has no RLS so it needs no policy.
 */
export interface PrivilegedTenantEraser {
  erase(census: TenantCensus): Promise<{ deletedRowCounts: Record<string, number> }>;
}

/**
 * Phase 3. AC-90. Re-opens withTenantTransaction(tenantId) and reads under the ordinary
 * tenant_isolation policy, which matches any surviving row, so a missed cascade shows.
 * Zero rows for the tenant in every table, zero auth rows for census.userIds, zero
 * orphans referencing a deleted parent.
 */
export function assertNoTenantResidue(_census: TenantCensus): Promise<void> {
  throw new Error('not implemented');
}

export interface ExportManifest {
  tenantId: string;
  exportedAt: string;
  /** Latest applied migration tag: how a consumer knows the NDJSON row shape. */
  schemaVersion: string;
  tables: Array<{ name: string; rowCount: number; file: string }>;
}
