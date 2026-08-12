/**
 * ADR: adr-0004-schema-layout-and-migrations.md
 * Produced by: TASK-005
 *
 * The schema is a glob over the directory, not the barrel: a TASK that adds a table
 * and forgets its `export *` line still gets a correct migration, and ADR-0019's
 * cross-check against information_schema is what catches the missing export.
 *
 * `db:migrate` runs as DATABASE_MIGRATION_URL (shortkit_migrator), the role that owns
 * the tables. It is never DATABASE_URL: shortkit_app owns nothing and can run no DDL.
 */
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema/*.ts',
  out: './drizzle',
  dbCredentials: {
    // `generate` needs no connection; `migrate` does, and drizzle-kit reads this
    // field for both, so the empty fallback keeps generation working offline.
    url: process.env.DATABASE_MIGRATION_URL ?? '',
  },
});
