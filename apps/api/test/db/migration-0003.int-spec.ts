/**
 * STORY-1b-06 — AC-1b-30's substrate: the three tables migration 0003 creates are
 * protected the way the template says, and the migration file holds the builder's output.
 *
 * Produced by: TASK-1b-03.
 * Contract: docs/contracts/rls-policy-template.md, invitation-tokens.md,
 *           workspace-authorization.md; ADR-0062.
 *
 * Integration only, by ADR-0001: row-level security cannot be faked, and every catalogue
 * assertion here reads the MIGRATED tables — `memberships`, `invitations`,
 * `invitation_workspaces`, created by `apps/api/drizzle/0003_*.sql` with the three
 * hand-appended `tenantScopedPolicies()` blocks. `pnpm db:check-policies` asserts the same
 * protection over EVERY table in the schema; this file asserts it for the three this TASK
 * adds, so a regression names the table in the suite that owns it, and it holds the
 * migration file to the function's output verbatim so the appended blocks cannot drift.
 *
 * WHAT ELSE THIS FILE PROVES, because it is the ADR-0062 property and a catalogue read
 * cannot show it: the composite foreign key `(workspace_id, tenant_id) -> workspaces (id,
 * tenant_id)` refuses a membership that names another tenant's workspace EVEN WHEN the
 * isolation policy admits the row. Referential checks run with row security bypassed, so
 * a plain `workspace_id -> workspaces(id)` would have found tenant B's workspace and
 * accepted the row; the composite one looks for (B's workspace, A's tenant) and finds
 * nothing. Measured through `withTenantTransaction` as `shortkit_app`.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { closeDatabase, postgresErrorCode, postgresErrorConstraint } from '../../src/db/client';
import { tenantScopedPolicies } from '../../src/db/rls';
import { withTenantTransaction } from '../../src/tenancy/tenant-context';
import { execSql, querySql } from '../support/psql';
import {
  assertAppRoleCannotBypassRls,
  createRlsFixture,
  dropRlsFixture,
  migrationDsn,
  TENANT_A,
  TENANT_B,
} from '../support/rls-fixture';

const DRIZZLE_DIR = fileURLToPath(new URL('../../drizzle/', import.meta.url));

/** The three tables, in the order the card fixes for the appended blocks. */
const TABLES = ['memberships', 'invitations', 'invitation_workspaces'] as const;

function migration0003(): string {
  const [file, ...others] = readdirSync(DRIZZLE_DIR).filter((entry) => /^0003_.*\.sql$/.test(entry));

  if (file === undefined || others.length > 0) {
    throw new Error(`expected exactly one 0003_*.sql migration, found ${String([file, ...others])}`);
  }

  return readFileSync(`${DRIZZLE_DIR}${file}`, 'utf8');
}

interface RelationState extends Record<string, unknown> {
  row_security: boolean;
  force_row_security: boolean;
}

interface PolicyRow extends Record<string, unknown> {
  policyname: string;
  cmd: string;
  qual: string | null;
  with_check: string | null;
}

interface ConstraintRow extends Record<string, unknown> {
  conname: string;
  contype: string;
  columns: string[];
  referenced_table: string | null;
  referenced_columns: string[] | null;
  on_delete: string;
}

function relationState(table: string): RelationState | undefined {
  return querySql<RelationState>(
    migrationDsn(),
    `SELECT c.relrowsecurity AS row_security, c.relforcerowsecurity AS force_row_security
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = '${table}'`,
  )[0];
}

function policiesOf(table: string): PolicyRow[] {
  return querySql<PolicyRow>(
    migrationDsn(),
    `SELECT policyname, cmd, qual, with_check
       FROM pg_policies
      WHERE schemaname = 'public' AND tablename = '${table}'
      ORDER BY policyname`,
  );
}

function constraintsOf(table: string): ConstraintRow[] {
  return querySql<ConstraintRow>(
    migrationDsn(),
    `SELECT con.conname,
            con.contype::text AS contype,
            (SELECT array_agg(a.attname ORDER BY k.ord)
               FROM unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord)
               JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum) AS columns,
            CASE WHEN con.confrelid = 0 THEN NULL ELSE con.confrelid::regclass::text END AS referenced_table,
            CASE WHEN con.confrelid = 0 THEN NULL ELSE
              (SELECT array_agg(a.attname ORDER BY k.ord)
                 FROM unnest(con.confkey) WITH ORDINALITY AS k(attnum, ord)
                 JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.attnum) END AS referenced_columns,
            con.confdeltype::text AS on_delete
       FROM pg_constraint con
       JOIN pg_class c ON c.oid = con.conrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = '${table}'
      ORDER BY con.conname`,
  );
}

describe('migration 0003: the three 1b tables and their policy blocks (AC-1b-30, ADR-0062)', () => {
  it('carries every statement tenantScopedPolicies() produces for each table, verbatim, in the fixed order', () => {
    const migration = migration0003();

    let cursor = 0;

    for (const table of TABLES) {
      for (const statement of tenantScopedPolicies(table).statements) {
        const at = migration.indexOf(statement, cursor);

        // Present, and AFTER the previous block's last statement: memberships, then
        // invitations, then invitation_workspaces, each block internally in the
        // builder's order.
        expect(at, `${table}: ${statement.split('\n')[0] ?? statement}`).toBeGreaterThan(-1);
        cursor = at + statement.length;
      }
    }
  });

  it('touches workspaces with one constraint and no policy: migration 0002 still holds its block and 0003 adds no policy DDL for it', () => {
    const migration = migration0003();

    expect(migration).toContain(
      'ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_id_tenant_unique" UNIQUE("id","tenant_id");',
    );
    expect(migration).not.toMatch(/CREATE POLICY workspaces_/);
    expect(migration).not.toMatch(/ALTER TABLE workspaces (ENABLE|FORCE)/);
    // And the constraint precedes both composite foreign keys that reference it — the
    // hand reordering the migration file explains. PostgreSQL refuses a FOREIGN KEY whose
    // referenced columns are not yet unique, so the generator's order would not apply.
    const unique = migration.indexOf('"workspaces_id_tenant_unique"');

    expect(unique).toBeGreaterThan(-1);
    expect(migration.indexOf('"memberships_workspace_tenant_fk"')).toBeGreaterThan(unique);
    expect(migration.indexOf('"invitation_workspaces_workspace_tenant_fk"')).toBeGreaterThan(unique);
  });

  it.each(TABLES)('%s has row-level security enabled AND forced', (table) => {
    expect(relationState(table)).toEqual({ row_security: true, force_row_security: true });
  });

  it.each(TABLES)(
    '%s carries exactly the two template policies, with matching USING and WITH CHECK on tenant_id',
    (table) => {
      const policies = policiesOf(table);

      expect(policies.map((policy) => [policy.policyname, policy.cmd])).toEqual([
        [`${table}_privileged_erase`, 'DELETE'],
        [`${table}_tenant_isolation`, 'ALL'],
      ]);

      const [erase, isolation] = policies as [PolicyRow, PolicyRow];

      expect(isolation.qual).toBe(isolation.with_check);
      expect(isolation.qual).toMatch(
        /^\(tenant_id = \(NULLIF\(current_setting\('app\.tenant_id'::text, true\), ''::text\)\)::uuid\)$/,
      );
      expect(erase.with_check).toBeNull();
      expect(erase.qual).toMatch(
        /^\(\(tenant_id\)::text = NULLIF\(current_setting\('app\.privileged_erase'::text, true\), ''::text\)\)$/,
      );
    },
  );

  it.each(TABLES)('%s carries the tenant_id index', (table) => {
    const indexes = querySql<{ indexname: string }>(
      migrationDsn(),
      `SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND tablename = '${table}' ORDER BY indexname`,
    );

    expect(indexes.map((index) => index.indexname)).toContain(`${table}_tenant_id_idx`);
  });

  it('every tenant_id column references tenants(id) ON DELETE CASCADE, and workspaces carries UNIQUE (id, tenant_id)', () => {
    for (const table of TABLES) {
      const tenantFk = constraintsOf(table).find(
        (constraint) => constraint.contype === 'f' && constraint.columns.join() === 'tenant_id',
      );

      expect(tenantFk, table).toMatchObject({
        referenced_table: 'tenants',
        referenced_columns: ['id'],
        on_delete: 'c',
      });
    }

    expect(constraintsOf('workspaces')).toContainEqual(
      expect.objectContaining({
        conname: 'workspaces_id_tenant_unique',
        contype: 'u',
        columns: ['id', 'tenant_id'],
      }),
    );
  });

  it('memberships and invitation_workspaces reference workspaces through the COMPOSITE (workspace_id, tenant_id) key, cascading', () => {
    expect(constraintsOf('memberships')).toContainEqual(
      expect.objectContaining({
        conname: 'memberships_workspace_tenant_fk',
        contype: 'f',
        columns: ['workspace_id', 'tenant_id'],
        referenced_table: 'workspaces',
        referenced_columns: ['id', 'tenant_id'],
        on_delete: 'c',
      }),
    );
    expect(constraintsOf('invitation_workspaces')).toContainEqual(
      expect.objectContaining({
        conname: 'invitation_workspaces_workspace_tenant_fk',
        contype: 'f',
        columns: ['workspace_id', 'tenant_id'],
        referenced_table: 'workspaces',
        referenced_columns: ['id', 'tenant_id'],
        on_delete: 'c',
      }),
    );
    // And no plain single-column key to workspaces beside it, which would be the shape
    // the composite one exists to replace.
    for (const table of ['memberships', 'invitation_workspaces']) {
      expect(
        constraintsOf(table).filter(
          (constraint) =>
            constraint.referenced_table === 'workspaces' && constraint.columns.length === 1,
        ),
      ).toEqual([]);
    }
  });

  it('carries the uniqueness the schema decides on: (workspace_id, user_id), (invitation_id, workspace_id), and the token digest', () => {
    expect(constraintsOf('memberships')).toContainEqual(
      expect.objectContaining({
        conname: 'memberships_workspace_user_unique',
        contype: 'u',
        columns: ['workspace_id', 'user_id'],
      }),
    );
    expect(constraintsOf('invitation_workspaces')).toContainEqual(
      expect.objectContaining({
        conname: 'invitation_workspaces_invitation_workspace_unique',
        contype: 'u',
        columns: ['invitation_id', 'workspace_id'],
      }),
    );

    const digestIndex = querySql<{ indexdef: string }>(
      migrationDsn(),
      `SELECT indexdef FROM pg_indexes
        WHERE schemaname = 'public' AND tablename = 'invitations' AND indexname = 'invitations_token_digest_unique'`,
    );

    expect(digestIndex.map((row) => row.indexdef)).toEqual([
      'CREATE UNIQUE INDEX invitations_token_digest_unique ON public.invitations USING btree (token_digest)',
    ]);
  });

  it('stores the token digest as bytea and the states and roles as the two enums (invitation-tokens.md, D-11)', () => {
    const columns = querySql<{ table_name: string; column_name: string; udt_name: string; is_nullable: string; column_default: string | null }>(
      migrationDsn(),
      `SELECT table_name, column_name, udt_name, is_nullable, column_default
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND ((table_name = 'invitations' AND column_name IN ('token_digest', 'state', 'expires_at', 'inviter_email', 'accepted_by_user_id'))
            OR (table_name = 'memberships' AND column_name = 'role')
            OR (table_name = 'invitation_workspaces' AND column_name = 'role'))
        ORDER BY table_name, column_name`,
    );

    expect(columns).toEqual([
      { table_name: 'invitation_workspaces', column_name: 'role', udt_name: 'workspace_role', is_nullable: 'NO', column_default: null },
      { table_name: 'invitations', column_name: 'accepted_by_user_id', udt_name: 'text', is_nullable: 'YES', column_default: null },
      { table_name: 'invitations', column_name: 'expires_at', udt_name: 'timestamptz', is_nullable: 'NO', column_default: null },
      { table_name: 'invitations', column_name: 'inviter_email', udt_name: 'text', is_nullable: 'NO', column_default: null },
      { table_name: 'invitations', column_name: 'state', udt_name: 'invitation_state', is_nullable: 'NO', column_default: "'pending'::invitation_state" },
      { table_name: 'invitations', column_name: 'token_digest', udt_name: 'bytea', is_nullable: 'NO', column_default: null },
      { table_name: 'memberships', column_name: 'role', udt_name: 'workspace_role', is_nullable: 'NO', column_default: null },
    ]);

    const enums = querySql<{ typname: string; labels: string[] }>(
      migrationDsn(),
      `SELECT t.typname, array_agg(e.enumlabel ORDER BY e.enumsortorder) AS labels
         FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
        WHERE t.typname IN ('workspace_role', 'invitation_state')
        GROUP BY t.typname ORDER BY t.typname`,
    );

    expect(enums).toEqual([
      { typname: 'invitation_state', labels: ['pending', 'accepted', 'expired', 'revoked'] },
      { typname: 'workspace_role', labels: ['workspace_admin', 'member', 'viewer'] },
    ]);
  });
});

describe('ADR-0062: the composite foreign key refuses a grant naming another tenant\'s workspace even where the policy admits the row', () => {
  const WORKSPACE_A = 'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1';
  const WORKSPACE_B = 'c2c2c2c2-c2c2-4c2c-8c2c-c2c2c2c2c2c2';
  const USER = 'migration0003User01';

  beforeAll(() => {
    assertAppRoleCannotBypassRls();
  });

  // Tenants A and B re-seeded (cascading every workspace and membership away), then one
  // workspace per tenant and one "user" row — through the migrator, because shortkit_app
  // holds no privilege on "user" (ADR-0050) and the workspace inserts have to satisfy each
  // tenant's own WITH CHECK.
  beforeEach(() => {
    createRlsFixture();
    execSql(
      migrationDsn(),
      `DELETE FROM "user" WHERE id = :'user_id';
       INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
         VALUES (:'user_id', 'Migration 0003', :'email', false, now(), now());
       SELECT set_config('app.tenant_id', :'tenant_a', false) \\g /dev/null
       INSERT INTO workspaces (id, tenant_id, name) VALUES (:'workspace_a', :'tenant_a', 'A');
       SELECT set_config('app.tenant_id', :'tenant_b', false) \\g /dev/null
       INSERT INTO workspaces (id, tenant_id, name) VALUES (:'workspace_b', :'tenant_b', 'B');`,
      {
        variables: {
          user_id: USER,
          email: `${USER}@example.test`,
          tenant_a: TENANT_A,
          tenant_b: TENANT_B,
          workspace_a: WORKSPACE_A,
          workspace_b: WORKSPACE_B,
        },
      },
    );
  });

  afterAll(async () => {
    execSql(migrationDsn(), `DELETE FROM "user" WHERE id = :'user_id'`, {
      variables: { user_id: USER },
    });
    dropRlsFixture();
    await closeDatabase();
  });

  async function insertMembership(tenantId: string, workspaceId: string): Promise<unknown> {
    try {
      await withTenantTransaction(tenantId, async (db) => {
        await db.execute(
          sql`insert into memberships (tenant_id, workspace_id, user_id, role)
              values (${tenantId}::uuid, ${workspaceId}::uuid, ${USER}, 'member')`,
        );
      });

      return undefined;
    } catch (error) {
      return error;
    }
  }

  it('the positive control: tenant A grants a membership on its own workspace', async () => {
    expect(await insertMembership(TENANT_A, WORKSPACE_A)).toBeUndefined();
  });

  it('tenant A cannot see tenant B\'s workspace, so the policy alone would not stop a grant naming it', async () => {
    // What RLS answers: nothing. And referential checks do not consult RLS, which is why
    // the next test cannot rest on this one.
    const visible = await withTenantTransaction(TENANT_A, async (db) =>
      (await db.execute<{ id: string }>(sql`select id from workspaces where id = ${WORKSPACE_B}::uuid`)).rows,
    );

    expect(visible).toEqual([]);
  });

  it('a membership carrying tenant A\'s tenant_id and tenant B\'s workspace_id is refused by the composite foreign key, not by a policy', async () => {
    // The row satisfies `memberships_tenant_isolation`'s WITH CHECK — its tenant_id IS
    // the context's — so a plain FK to workspaces(id) would have admitted it: the
    // referential check bypasses row security and finds B's workspace. The composite key
    // looks for (B's workspace, A's tenant) in workspaces and finds nothing. 23503, and the
    // constraint is named.
    const refused = await insertMembership(TENANT_A, WORKSPACE_B);

    expect(postgresErrorCode(refused)).toBe('23503');
    expect(postgresErrorConstraint(refused)).toBe('memberships_workspace_tenant_fk');

    // Nothing landed, in either tenant's view.
    for (const tenant of [TENANT_A, TENANT_B]) {
      const rows = await withTenantTransaction(tenant, async (db) =>
        (await db.execute<{ id: string }>(sql`select id from memberships`)).rows,
      );

      expect(rows).toEqual([]);
    }
  });
});
