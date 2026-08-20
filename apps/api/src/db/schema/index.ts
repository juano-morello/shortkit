/**
 * ADR: adr-0004-schema-layout-and-migrations.md
 *
 * Barrel that only re-exports, one line per table file, alphabetical. Drizzle Kit
 * reads a glob against this directory directly and does not import this file; this
 * barrel is for application code and `tenantScopedTables()`.
 *
 * A schema TASK adds both the table file and its `export * from './<table>';` line
 * here, alphabetically.
 */
export * from './auth';
export * from './invitation-workspaces';
export * from './invitations';
export * from './memberships';
export * from './tenant-memberships';
export * from './tenants';
export * from './workspaces';
