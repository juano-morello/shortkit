/**
 * Debt sweep 2026-08-19 — ledger 1b-W1-11, the four unindexed foreign keys.
 *
 * Contract: docs/contracts/rls-policy-template.md (what a migration owes — and, here, why
 *           this one owes none of it), workspaces.md ("Repository": `listForUser`'s join).
 * ADR: adr-0004-schema-layout-and-migrations.md, adr-0062.
 *
 * Migration 0004 is INDEX-ONLY: the four leading-column indexes 1b-W1-11 recorded as
 * missing — `memberships.user_id`, `invitations.invited_by_user_id`,
 * `invitations.accepted_by_user_id`, `invitation_workspaces.workspace_id`. It creates no
 * table, so the GC-A / F-239 three-obligations rule does not bind it and there is no
 * hand-appended policy block to hold to `tenantScopedPolicies()`'s output — that is
 * `migration-0003.int-spec.ts`'s job, unchanged. What THIS file pins:
 *
 *   1. the migration file carries exactly the four CREATE INDEX statements and no other
 *      DDL kind — a policy, table or column smuggled into "the index migration" fails
 *      here before it fails review;
 *   2. the four indexes exist in the migrated catalogue with the intended leading column
 *      (asserted on the whole `indexdef`, so a silent column swap or a partial-index
 *      clause shows up);
 *   3. the three tables still have row security ENABLED and FORCED afterwards — the
 *      cheap in-suite echo of `db:check-policies`, which CI runs against the same
 *      database and which an index cannot disturb.
 *
 * Catalogue reads only, as the migrator role; no fixture rows, no app client, nothing to
 * close.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { querySql } from '../support/psql';
import { migrationDsn } from '../support/rls-fixture';

const DRIZZLE_DIR = fileURLToPath(new URL('../../drizzle/', import.meta.url));

/** table -> [index name, leading column], one row per 1b-W1-11 entry. */
const EXPECTED_INDEXES = [
  { table: 'memberships', name: 'memberships_user_id_idx', column: 'user_id' },
  { table: 'invitations', name: 'invitations_invited_by_user_id_idx', column: 'invited_by_user_id' },
  { table: 'invitations', name: 'invitations_accepted_by_user_id_idx', column: 'accepted_by_user_id' },
  { table: 'invitation_workspaces', name: 'invitation_workspaces_workspace_id_idx', column: 'workspace_id' },
] as const;

function migration0004(): string {
  const [file, ...others] = readdirSync(DRIZZLE_DIR).filter((entry) => /^0004_.*\.sql$/.test(entry));

  if (file === undefined || others.length > 0) {
    throw new Error(`expected exactly one 0004_*.sql migration, found ${String([file, ...others])}`);
  }

  return readFileSync(`${DRIZZLE_DIR}${file}`, 'utf8');
}

describe('migration 0004: the 1b-W1-11 foreign-key indexes, and nothing else', () => {
  it('the file carries the four CREATE INDEX statements, one per unindexed foreign key', () => {
    const migration = migration0004();

    for (const { table, name, column } of EXPECTED_INDEXES) {
      expect(migration).toContain(`CREATE INDEX "${name}" ON "${table}" USING btree ("${column}");`);
    }
  });

  it('the file is index-only: no policy, no row-security toggle, no table, no column — and no UNIQUE', () => {
    // SQL comments out (the header explains the absent policy block and must not trip
    // the scan that enforces it), then every remaining statement must be CREATE INDEX.
    const statements = migration0004()
      .replace(/^--.*$/gm, '')
      .split('--> statement-breakpoint')
      .map((statement) => statement.trim())
      .filter((statement) => statement.length > 0);

    expect(statements).toHaveLength(4);

    for (const statement of statements) {
      expect(statement).toMatch(/^CREATE INDEX "/);
    }
  });

  it.each(EXPECTED_INDEXES)(
    '$name exists on $table with $column as its one btree column',
    ({ table, name, column }) => {
      const rows = querySql<{ indexdef: string }>(
        migrationDsn(),
        `SELECT indexdef FROM pg_indexes
          WHERE schemaname = 'public' AND tablename = '${table}' AND indexname = '${name}'`,
      );

      // The whole definition, so a swapped column, an added clause or a partial index
      // cannot hide behind a name that still matches.
      expect(rows.map((row) => row.indexdef)).toEqual([
        `CREATE INDEX ${name} ON public.${table} USING btree (${column})`,
      ]);
    },
  );

  it('row security is still ENABLED and FORCED on all three tables: the index migration touched no policy state', () => {
    const rows = querySql<{ relname: string; row_security: boolean; force_row_security: boolean }>(
      migrationDsn(),
      `SELECT c.relname, c.relrowsecurity AS row_security, c.relforcerowsecurity AS force_row_security
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname IN ('memberships', 'invitations', 'invitation_workspaces')
        ORDER BY c.relname`,
    );

    expect(rows).toEqual([
      { relname: 'invitation_workspaces', row_security: true, force_row_security: true },
      { relname: 'invitations', row_security: true, force_row_security: true },
      { relname: 'memberships', row_security: true, force_row_security: true },
    ]);
  });
});
