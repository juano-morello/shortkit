/**
 * Contract: design/contracts/rls-policy-template.md
 * ADR: adr-0003-rls-policy-template-and-roles.md, adr-0004-schema-layout-and-migrations.md
 * Produced by: TASK-005
 *
 * Drizzle Kit does not generate policy DDL. Each schema file exports its policy SQL
 * built from here, and the producing TASK appends it to the generated migration BY HAND
 * in the same commit. `pnpm db:check-policies` asserts the result against pg_policies.
 */

export interface PolicySet {
  readonly table: string;
  readonly statements: string[];
}

/**
 * The four statements every tenant-scoped table applies, plus the tenant_id index.
 *
 * FORCE ROW LEVEL SECURITY matters: without it the table owner bypasses every policy,
 * producing an RLS configuration that looks correct and enforces nothing.
 */
export function tenantScopedPolicies(_table: string): PolicySet {
  throw new Error('not implemented');
}

/**
 * The redirect read escape. Applied to `domains` and `links` ONLY.
 * FOR SELECT only. Set only by withRedirectRead, which additionally issues
 * SET TRANSACTION READ ONLY.
 *
 * Exclusion 1 of exactly 2 recorded by the SC-1 suite.
 */
export function redirectReadPolicy(_table: 'domains' | 'links'): PolicySet {
  throw new Error('not implemented');
}

/** Column definition every tenant-scoped table declares. The cascade is load-bearing for AC-90. */
export const TENANT_ID_COLUMN_SQL =
  'tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE';

/**
 * Boot-time guard. Exits non-zero when the runtime role could bypass RLS.
 * TASK-005 calls this before the app accepts traffic.
 */
export async function assertRuntimeRoleCannotBypassRls(): Promise<void> {
  throw new Error('not implemented');
}
