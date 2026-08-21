/**
 * STORY-2-08, AC-2-40's substrate: the three tables migration 0005 creates are protected
 * the way the template says, `domains` and `links` carry the FIRST APPLIED INSTANCES of
 * `redirectReadPolicy()`, and the migration file holds both builders' output verbatim.
 *
 * Produced by: TASK-2-02.
 * Contract: docs/contracts/rls-policy-template.md, domain-provisioning.md, slug.md,
 *           click-events.md, redirect-resolution.md; ADR-0063, ADR-0062, ADR-0049.
 *
 * Integration only, by ADR-0001: row-level security cannot be faked, and every catalogue
 * assertion here reads the MIGRATED tables `domains`, `links` and `click_events`, created by
 * `apps/api/drizzle/0005_*.sql` with five hand-appended policy blocks.
 * `pnpm db:check-policies` asserts ENABLE+FORCE and the wrapper count over EVERY table in
 * the schema; this file asserts the shape for the three this TASK adds, so a regression
 * names the table in the suite that owns it.
 *
 * WHAT ELSE THIS FILE PROVES, because a catalogue read cannot show it:
 *
 *  - `domains_hostname_owned_unique` is PARTIAL and its predicate is the contract's three
 *    states exactly. A plain UNIQUE would forbid item 3's concurrent pending claims
 *    (F-010), and the two shapes are indistinguishable in every test that only inserts
 *    `active` rows, which is every test item 2 has. So the predicate is read back from
 *    `pg_indexes` AND exercised: two `pending_verification` rows on one hostname coexist,
 *    and a second `active` row on that hostname is refused 23505 naming the index.
 *  - `links` names its domain as the PAIR `(domain_id, domain_tenant_id)`, keyed against
 *    `domains (id, tenant_id)` and narrowed by `links_domain_owner_check`. The compound
 *    regression suite at the bottom of this file is the whole of it: four refusals and two
 *    admissions, each issued as `shortkit_app` inside a real tenant transaction.
 *  - A FOREIGN KEY resolves against a row the inserting transaction CANNOT READ.
 *    Referential checks run with row security bypassed, which is what makes a customer
 *    tenant's link able to reference the platform tenant's domain, and equally what makes
 *    the pair unlieable. Measured here rather than asserted in prose, because ADR-0063
 *    rests on it in both directions.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { closeDatabase, postgresErrorCode, postgresErrorConstraint } from '../../src/db/client';
import {
  PLATFORM_TENANT_ID,
  PLATFORM_WORKSPACE_ID,
  SYSTEM_DEFAULT_DOMAIN_ID,
} from '../../src/db/platform';
import { redirectReadPolicy, tenantScopedPolicies } from '../../src/db/rls';
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
const TABLES = ['domains', 'links', 'click_events'] as const;

/** The two the redirect escape applies to, and the only two ADR-0003's approved set permits. */
const REDIRECT_READ_TABLES = ['domains', 'links'] as const;

function migration0005(): string {
  const [file, ...others] = readdirSync(DRIZZLE_DIR).filter((entry) => /^0005_.*\.sql$/.test(entry));

  if (file === undefined || others.length > 0) {
    throw new Error(`expected exactly one 0005_*.sql migration, found ${String([file, ...others])}`);
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

function indexDefOf(table: string, index: string): string | undefined {
  return querySql<{ indexdef: string }>(
    migrationDsn(),
    `SELECT indexdef FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = '${table}' AND indexname = '${index}'`,
  )[0]?.indexdef;
}

describe('migration 0005: domains, links and click_events, and the first applied redirect_read policies', () => {
  it('carries every statement both builders produce, verbatim, in the order the card fixes', () => {
    const migration = migration0005();
    // The card's order, and it is the order the blocks must appear in: each table's
    // template block, then its redirect escape, then the next table.
    const expected = [
      ...tenantScopedPolicies('domains').statements,
      ...redirectReadPolicy('domains').statements,
      ...tenantScopedPolicies('links').statements,
      ...redirectReadPolicy('links').statements,
      ...tenantScopedPolicies('click_events').statements,
    ];

    let cursor = 0;

    for (const statement of expected) {
      const at = migration.indexOf(statement, cursor);

      expect(at, statement.split('\n')[0] ?? statement).toBeGreaterThan(-1);
      cursor = at + statement.length;
    }
  });

  it('gives click_events the template and NOTHING else: no redirect_read, no third policy', () => {
    const migration = migration0005();

    // The redirect never reads this table: it only ever writes it, off the request path,
    // inside withTenantTransaction. Click emission is not a GC-5 exclusion (AC-2-35).
    expect(migration).not.toMatch(/CREATE POLICY click_events_redirect_read/);
    expect(policiesOf('click_events').map((policy) => policy.policyname)).toEqual([
      'click_events_privileged_erase',
      'click_events_tenant_isolation',
    ]);
  });

  it('touches no table migration 0002/0003/0004 already policed', () => {
    const migration = migration0005();

    for (const table of ['tenants', 'workspaces', 'memberships', 'invitations', 'invitation_workspaces', 'tenant_memberships']) {
      expect(migration, table).not.toMatch(new RegExp(`CREATE POLICY ${table}_`));
      expect(migration, table).not.toMatch(new RegExp(`ALTER TABLE "?${table}"? (ENABLE|FORCE)`));
    }
  });

  it.each(TABLES)('%s has row-level security enabled AND forced', (table) => {
    expect(relationState(table)).toEqual({ row_security: true, force_row_security: true });
  });

  it.each(TABLES)('%s carries the two template policies with matching USING and WITH CHECK on tenant_id', (table) => {
    const policies = policiesOf(table);
    const erase = policies.find((policy) => policy.policyname === `${table}_privileged_erase`);
    const isolation = policies.find((policy) => policy.policyname === `${table}_tenant_isolation`);

    expect(erase?.cmd).toBe('DELETE');
    expect(isolation?.cmd).toBe('ALL');
    expect(isolation?.qual).toBe(isolation?.with_check);
    expect(isolation?.qual).toMatch(
      /^\(tenant_id = \(NULLIF\(current_setting\('app\.tenant_id'::text, true\), ''::text\)\)::uuid\)$/,
    );
    expect(erase?.with_check).toBeNull();
    expect(erase?.qual).toMatch(
      /^\(\(tenant_id\)::text = NULLIF\(current_setting\('app\.privileged_erase'::text, true\), ''::text\)\)$/,
    );
  });

  it.each(REDIRECT_READ_TABLES)(
    '%s carries the redirect escape as a THIRD policy: FOR SELECT, keyed on app.redirect_context, no WITH CHECK',
    (table) => {
      const policies = policiesOf(table);

      expect(policies.map((policy) => [policy.policyname, policy.cmd])).toEqual([
        [`${table}_privileged_erase`, 'DELETE'],
        [`${table}_redirect_read`, 'SELECT'],
        [`${table}_tenant_isolation`, 'ALL'],
      ]);

      const redirect = policies.find((policy) => policy.policyname === `${table}_redirect_read`);

      // FOR SELECT grants no write, so `with_check` is null and must stay null: a
      // WITH CHECK here would mean the flag could admit an INSERT or UPDATE.
      expect(redirect?.with_check).toBeNull();
      // ADR-0049's wrapper, on a policy that never casts (F-021): `''` is dangerous
      // because of the COMPARISON, not because of the cast, and `db:check-policies`
      // counts wrappers mechanically rather than exempting the safe-looking ones.
      expect(redirect?.qual).toMatch(
        /^\(NULLIF\(current_setting\('app\.redirect_context'::text, true\), ''::text\) = 'on'::text\)$/,
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

  it('every tenant_id column references tenants(id) ON DELETE CASCADE (ADR-0019 erasure cascade)', () => {
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
  });

  it('domains and links reach workspaces through a COMPOSITE key, and links reaches domains through a second one', () => {
    for (const table of ['domains', 'links']) {
      expect(constraintsOf(table), table).toContainEqual(
        expect.objectContaining({
          conname: `${table}_workspace_tenant_fk`,
          contype: 'f',
          columns: ['workspace_id', 'tenant_id'],
          referenced_table: 'workspaces',
          referenced_columns: ['id', 'tenant_id'],
          on_delete: 'c',
        }),
      );
      // No plain single-column key to workspaces beside it, the shape the composite
      // one exists to replace (ADR-0062).
      expect(
        constraintsOf(table).filter(
          (constraint) =>
            constraint.referenced_table === 'workspaces' && constraint.columns.length === 1,
        ),
        table,
      ).toEqual([]);
    }

    // AND THE DOMAIN REFERENCE IS A PAIR TOO, against `domains_id_tenant_unique` rather
    // than against `workspaces`. `(domain_id, tenant_id)` was impossible, because the
    // system default domain belongs to the PLATFORM tenant and that pair is not a row for
    // any customer link; `(domain_id, domain_tenant_id)` carries the claim in its own
    // column and the key makes the claim true (ADR-0063, amended).
    expect(constraintsOf('links')).toContainEqual(
      expect.objectContaining({
        conname: 'links_domain_tenant_fk',
        contype: 'f',
        columns: ['domain_id', 'domain_tenant_id'],
        referenced_table: 'domains',
        referenced_columns: ['id', 'tenant_id'],
        on_delete: 'c',
      }),
    );
    // And NO single-column key to `domains` beside it: that is the shape the pair replaces,
    // and leaving both would let a writer satisfy the weaker one.
    expect(
      constraintsOf('links').filter(
        (constraint) =>
          constraint.referenced_table === 'domains' && constraint.columns.length === 1,
      ),
    ).toEqual([]);
  });

  it('links_domain_owner_check admits exactly two owners: the row\'s own tenant, and the platform tenant', () => {
    // Read back as PostgreSQL rendered it, so the frozen uuid the schema file interpolates
    // through `sql.raw` cannot drift from the constant the API writes. A check that named
    // the wrong tenant would refuse every link on the system default domain, which is every
    // link item 2 creates.
    const rendered = querySql<{ conname: string; definition: string }>(
      migrationDsn(),
      `SELECT con.conname, pg_get_constraintdef(con.oid) AS definition
         FROM pg_constraint con
         JOIN pg_class c ON c.oid = con.conrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = 'links' AND con.contype = 'c'
        ORDER BY con.conname`,
    );

    expect(rendered).toEqual([
      {
        conname: 'links_domain_owner_check',
        definition: `CHECK (((domain_tenant_id = tenant_id) OR (domain_tenant_id = '${PLATFORM_TENANT_ID}'::uuid)))`,
      },
    ]);
  });

  it('carries the uniqueness the schema decides on: (domain_id, slug) and (id, tenant_id) on domains', () => {
    // slug.md: uniqueness is (domain_id, slug), NEVER global, and the NAME is what the
    // collision catch reads through postgresErrorConstraint (F-120). Renaming it turns
    // every collision into a 500.
    expect(constraintsOf('links')).toContainEqual(
      expect.objectContaining({
        conname: 'links_domain_id_slug_unique',
        contype: 'u',
        columns: ['domain_id', 'slug'],
      }),
    );
    // Unused in item 2; it is the target item 3's tenant-owned-domain composite key needs,
    // and `workspaces` had to gain exactly this constraint in a later migration (ADR-0062).
    expect(constraintsOf('domains')).toContainEqual(
      expect.objectContaining({
        conname: 'domains_id_tenant_unique',
        contype: 'u',
        columns: ['id', 'tenant_id'],
      }),
    );
    // And NO plain UNIQUE (hostname): that is the shape F-010 measured as trivially
    // squattable, and it is a constraint rather than the partial index below.
    expect(
      constraintsOf('domains').filter(
        (constraint) => constraint.contype === 'u' && constraint.columns.join() === 'hostname',
      ),
    ).toEqual([]);
  });

  it('domains_hostname_owned_unique is PARTIAL, over exactly the three owned states (domain-provisioning.md)', () => {
    expect(indexDefOf('domains', 'domains_hostname_owned_unique')).toBe(
      "CREATE UNIQUE INDEX domains_hostname_owned_unique ON public.domains USING btree (hostname) WHERE (state = ANY (ARRAY['verified'::domain_state, 'provisioning'::domain_state, 'active'::domain_state]))",
    );
  });

  it('carries the contract indexes on links and click_events, and a leading index for every foreign key', () => {
    const indexes = (table: string): string[] =>
      querySql<{ indexname: string }>(
        migrationDsn(),
        `SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND tablename = '${table}' ORDER BY indexname`,
      ).map((row) => row.indexname);

    expect(indexes('links')).toContain('links_workspace_created_idx');
    expect(indexes('click_events')).toContain('click_events_link_occurred_idx');
    // The 0004 debt sweep's rule (ledger 1b-W1-11) met at CREATION rather than three
    // migrations later: a foreign key whose leading column indexes nothing makes its
    // ON DELETE CASCADE walk a sequential scan.
    expect(indexes('domains')).toContain('domains_workspace_id_idx');
    expect(indexes('click_events')).toContain('click_events_domain_id_idx');
    expect(indexes('links')).toContain('links_domain_tenant_id_idx');
  });

  it('stores the shapes the contracts fix: the six-value domain_state enum, varchar(512) user_agent, and no default on click_events.id', () => {
    const columns = querySql<{
      table_name: string;
      column_name: string;
      udt_name: string;
      is_nullable: string;
      column_default: string | null;
      max_length: number | null;
    }>(
      migrationDsn(),
      `SELECT table_name, column_name, udt_name, is_nullable, column_default,
              character_maximum_length AS max_length
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND ((table_name = 'domains' AND column_name IN ('state', 'hostname', 'is_system_default'))
            OR (table_name = 'links' AND column_name IN ('slug', 'destination_url', 'expires_at', 'activates_at', 'domain_tenant_id'))
            OR (table_name = 'click_events' AND column_name IN ('id', 'occurred_at', 'ip_hash', 'user_agent')))
        ORDER BY table_name, column_name`,
    );

    expect(columns).toEqual([
      // `id` UUID v7 generated at enqueue, so NO database default. That is what makes the
      // flush retry idempotent under ON CONFLICT (id) DO NOTHING (ADR-0010).
      { table_name: 'click_events', column_name: 'id', udt_name: 'uuid', is_nullable: 'NO', column_default: null, max_length: null },
      { table_name: 'click_events', column_name: 'ip_hash', udt_name: 'text', is_nullable: 'NO', column_default: null, max_length: null },
      // The buffer records when the redirect was DECIDED, not when the batch landed.
      { table_name: 'click_events', column_name: 'occurred_at', udt_name: 'timestamptz', is_nullable: 'NO', column_default: null, max_length: null },
      // Truncated at enqueue; the column is the second floor (click-events.md invariant 8).
      { table_name: 'click_events', column_name: 'user_agent', udt_name: 'varchar', is_nullable: 'YES', column_default: null, max_length: 512 },
      { table_name: 'domains', column_name: 'hostname', udt_name: 'text', is_nullable: 'NO', column_default: null, max_length: null },
      { table_name: 'domains', column_name: 'is_system_default', udt_name: 'bool', is_nullable: 'NO', column_default: 'false', max_length: null },
      { table_name: 'domains', column_name: 'state', udt_name: 'domain_state', is_nullable: 'NO', column_default: null, max_length: null },
      // Both null is an always-active link; the window is evaluated on every READ
      // (ADR-0009), never by the database.
      { table_name: 'links', column_name: 'activates_at', udt_name: 'timestamptz', is_nullable: 'YES', column_default: null, max_length: null },
      { table_name: 'links', column_name: 'destination_url', udt_name: 'text', is_nullable: 'NO', column_default: null, max_length: null },
      // NOT NULL and no default: every writer states which tenant owns the domain it names,
      // and the composite key refuses the statement if the claim is false (ADR-0063).
      { table_name: 'links', column_name: 'domain_tenant_id', udt_name: 'uuid', is_nullable: 'NO', column_default: null, max_length: null },
      { table_name: 'links', column_name: 'expires_at', udt_name: 'timestamptz', is_nullable: 'YES', column_default: null, max_length: null },
      { table_name: 'links', column_name: 'slug', udt_name: 'text', is_nullable: 'NO', column_default: null, max_length: null },
    ]);

    // All six, in the contract's order, so item 3 adds no ALTER TYPE (D-2-07). Only
    // `active` is reachable in item 2, and only the seed reaches it.
    expect(
      querySql<{ typname: string; labels: string[] }>(
        migrationDsn(),
        `SELECT t.typname, array_agg(e.enumlabel ORDER BY e.enumsortorder) AS labels
           FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
          WHERE t.typname = 'domain_state'
          GROUP BY t.typname`,
      ),
    ).toEqual([
      {
        typname: 'domain_state',
        labels: [
          'pending_verification',
          'verified',
          'provisioning',
          'active',
          'verification_failed',
          'certificate_failed',
        ],
      },
    ]);
  });
});


describe('the partial index: the behaviour a catalogue read cannot show', () => {
  const WORKSPACE_A = 'd1d1d1d1-d1d1-4d1d-8d1d-d1d1d1d1d1d1';
  const WORKSPACE_B = 'd2d2d2d2-d2d2-4d2d-8d2d-d2d2d2d2d2d2';
  const DOMAIN_B = 'd3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d3d3';
  const DOMAIN_A = 'd5d5d5d5-d5d5-4d5d-8d5d-d5d5d5d5d5d5';
  const CLAIMED_HOSTNAME = 'claimed.example.test';

  beforeAll(() => {
    assertAppRoleCannotBypassRls();
  });

  // One workspace per tenant; tenant B holds an ACTIVE domain on the contested hostname, and
  // tenant A holds an unrelated one of its own for the cascade test below.
  beforeEach(() => {
    createRlsFixture();
    execSql(
      migrationDsn(),
      `SELECT set_config('app.tenant_id', :'tenant_a', false) \\g /dev/null
       INSERT INTO workspaces (id, tenant_id, name) VALUES (:'workspace_a', :'tenant_a', 'A');
       INSERT INTO domains (id, tenant_id, workspace_id, hostname, state)
         VALUES (:'domain_a', :'tenant_a', :'workspace_a', 'partial-a.example.test', 'active');
       SELECT set_config('app.tenant_id', :'tenant_b', false) \\g /dev/null
       INSERT INTO workspaces (id, tenant_id, name) VALUES (:'workspace_b', :'tenant_b', 'B');
       INSERT INTO domains (id, tenant_id, workspace_id, hostname, state, is_system_default)
         VALUES (:'domain_b', :'tenant_b', :'workspace_b', :'hostname', 'active', true);`,
      {
        variables: {
          tenant_a: TENANT_A,
          tenant_b: TENANT_B,
          workspace_a: WORKSPACE_A,
          workspace_b: WORKSPACE_B,
          domain_a: DOMAIN_A,
          domain_b: DOMAIN_B,
          hostname: CLAIMED_HOSTNAME,
        },
      },
    );
  });

  afterAll(async () => {
    dropRlsFixture();
    await closeDatabase();
  });

  it('two unverified claims on one hostname coexist, which a plain UNIQUE (hostname) would forbid (F-010)', async () => {
    // The whole reason the index is partial. Under a plain UNIQUE this insert is 23505 and
    // item 3's concurrent pending claims are impossible; under the partial index the
    // predicate excludes `pending_verification` and both rows live.
    const planted = await withTenantTransaction(TENANT_A, async (db) => {
      await db.execute(
        sql`insert into domains (tenant_id, workspace_id, hostname, state)
            values (${TENANT_A}::uuid, ${WORKSPACE_A}::uuid, ${CLAIMED_HOSTNAME}, 'pending_verification')`,
      );

      return (
        await db.execute<{ id: string }>(
          sql`select id from domains where hostname = ${CLAIMED_HOSTNAME}`,
        )
      ).rows;
    });

    // One row VISIBLE to A, its own. B's active row on the same hostname exists and is
    // invisible, which is the point: the index is enforced across the boundary the policy
    // hides, because a unique index is not policy filtered.
    expect(planted).toHaveLength(1);
  });

  it('a SECOND owned claim on that hostname is refused 23505 naming the index, across the tenant boundary', async () => {
    const refused = await withTenantTransaction(TENANT_A, async (db) => {
      try {
        await db.execute(
          sql`insert into domains (tenant_id, workspace_id, hostname, state)
              values (${TENANT_A}::uuid, ${WORKSPACE_A}::uuid, ${CLAIMED_HOSTNAME}, 'active')`,
        );

        return undefined;
      } catch (error) {
        return error;
      }
    }).catch((error: unknown) => error);

    // Read through the accessors, never off `.message`: inside `withTenantTransaction` the
    // caught value is drizzle's wrapper and `.code` is undefined (F-120), and the message
    // carries every bound parameter, the hostname and the tenant id among them.
    expect(postgresErrorCode(refused)).toBe('23505');
    expect(postgresErrorConstraint(refused)).toBe('domains_hostname_owned_unique');
  });

  it('deleting a link cascades its click events away (D-2-03, AC-2-7, the stated cost)', async () => {
    const CLICK_ID = 'd4d4d4d4-d4d4-4d4d-8d4d-d4d4d4d4d4d4';

    const remaining = await withTenantTransaction(TENANT_A, async (db) => {
      const [link] = (
        await db.execute<{ id: string }>(
          sql`insert into links (tenant_id, workspace_id, domain_id, domain_tenant_id, slug, destination_url)
              values (${TENANT_A}::uuid, ${WORKSPACE_A}::uuid, ${DOMAIN_A}::uuid, ${TENANT_A}::uuid, ${'cascade'}, ${'https://example.test/b'})
              returning id`,
        )
      ).rows;

      await db.execute(
        sql`insert into click_events (id, tenant_id, link_id, domain_id, occurred_at, ip_hash, user_agent)
            values (${CLICK_ID}::uuid, ${TENANT_A}::uuid, ${link?.id ?? ''}::uuid, ${DOMAIN_A}::uuid, now(), ${'aaaaaaaaaaaaaaaaaaaaaa'}, ${'probe'})`,
      );

      await db.execute(sql`delete from links where id = ${link?.id ?? ''}::uuid`);

      return (await db.execute<{ id: string }>(sql`select id from click_events`)).rows;
    });

    expect(remaining).toEqual([]);
  });
});

/**
 * ===========================================================================
 * THE COMPOUND REGRESSION: WHO MAY OWN THE DOMAIN A LINK NAMES (ADR-0063, amended
 * 2026-08-19 after review).
 * ===========================================================================
 *
 * WHAT WAS MEASURED, BECAUSE THIS SUITE EXISTS TO KEEP IT MEASURED. Under the earlier
 * schema, `links.domain_id` was a plain `REFERENCES domains(id)` and tenant A could insert
 * a link naming tenant B's `domains` row. The redirect's own two permitted queries then
 * served A's destination under B's hostname, and A could take a slug on B's domain and hold
 * it forever, because a unique index is never policy filtered. Item 2 was safe only because
 * no second domain exists yet. Item 3 is where the second domain arrives.
 *
 * THE TWO CONSTRAINTS, AND WHY NEITHER ALONE IS ENOUGH.
 *
 *   links_domain_tenant_fk    (domain_id, domain_tenant_id) -> domains (id, tenant_id)
 *   links_domain_owner_check  domain_tenant_id = tenant_id OR domain_tenant_id = <platform>
 *
 * The key alone still admits A pointing at B's domain while telling the truth about who owns
 * it. The check alone still admits A pointing at B's domain while claiming to own it. Each
 * test below names which constraint answered, so a future change that drops one is a red run
 * that says which.
 *
 * THE FIXTURE PLANTS THE PLATFORM ROWS, unlike the isolation harness, which deliberately
 * never mints the platform tenant as an actor. The legitimate cases cannot be measured
 * without them: a link on the system default domain is the ONLY shape item 2's create path
 * writes (D-2-12).
 *
 * EVERY STATEMENT RUNS AS `shortkit_app` INSIDE `withTenantTransaction`, so each refusal is a
 * refusal on the path production uses, under the policies production runs. Codes and
 * constraint names are read through `postgresErrorCode` / `postgresErrorConstraint`, never
 * off `.message` (F-120): inside the transaction the caught value is drizzle's wrapper,
 * `.code` is undefined, and the message carries every bound parameter.
 */
describe('links_domain_tenant_fk and links_domain_owner_check: one tenant cannot name another tenant\'s domain', () => {
  const WORKSPACE_A = 'e5e5e5e5-e5e5-4e5e-8e5e-e5e5e5e5e5e5';
  const WORKSPACE_B = 'e6e6e6e6-e6e6-4e6e-8e6e-e6e6e6e6e6e6';
  /** A domain tenant A really owns. The second legitimate case, and item 3's shape. */
  const DOMAIN_OWNED_BY_A = 'e7e7e7e7-e7e7-4e7e-8e7e-e7e7e7e7e7e7';
  /** A domain tenant B owns. Every refusal below is about this row. */
  const DOMAIN_OWNED_BY_B = 'e8e8e8e8-e8e8-4e8e-8e8e-e8e8e8e8e8e8';

  interface Attempt {
    readonly tenantId: string;
    readonly workspaceId: string;
    readonly domainId: string;
    readonly domainTenantId: string;
    readonly slug: string;
  }

  beforeAll(() => {
    assertAppRoleCannotBypassRls();
  });

  /**
   * Two customer tenants with a workspace and a domain each, plus the real platform tenant,
   * platform workspace and system default domain at their frozen ids. Through the migrator,
   * because every table here carries FORCE ROW LEVEL SECURITY and the inserts have to
   * satisfy each tenant's own WITH CHECK, one tenant at a time.
   */
  beforeEach(() => {
    createRlsFixture();
    eraseTenant(PLATFORM_TENANT_ID);
    execSql(
      migrationDsn(),
      `SELECT set_config('app.tenant_id', :'tenant_a', false) \\g /dev/null
       INSERT INTO workspaces (id, tenant_id, name) VALUES (:'workspace_a', :'tenant_a', 'A');
       INSERT INTO domains (id, tenant_id, workspace_id, hostname, state)
         VALUES (:'domain_a', :'tenant_a', :'workspace_a', 'owned-by-a.example.test', 'active');

       SELECT set_config('app.tenant_id', :'tenant_b', false) \\g /dev/null
       INSERT INTO workspaces (id, tenant_id, name) VALUES (:'workspace_b', :'tenant_b', 'B');
       INSERT INTO domains (id, tenant_id, workspace_id, hostname, state)
         VALUES (:'domain_b', :'tenant_b', :'workspace_b', 'owned-by-b.example.test', 'active');

       SELECT set_config('app.tenant_id', :'platform', false) \\g /dev/null
       INSERT INTO tenants (id, name) VALUES (:'platform', 'Shortkit platform');
       INSERT INTO workspaces (id, tenant_id, name) VALUES (:'platform_workspace', :'platform', 'Platform');
       INSERT INTO domains (id, tenant_id, workspace_id, hostname, state, is_system_default)
         VALUES (:'system_domain', :'platform', :'platform_workspace', 'localhost', 'active', true);`,
      {
        variables: {
          tenant_a: TENANT_A,
          tenant_b: TENANT_B,
          workspace_a: WORKSPACE_A,
          workspace_b: WORKSPACE_B,
          domain_a: DOMAIN_OWNED_BY_A,
          domain_b: DOMAIN_OWNED_BY_B,
          platform: PLATFORM_TENANT_ID,
          platform_workspace: PLATFORM_WORKSPACE_ID,
          system_domain: SYSTEM_DEFAULT_DOMAIN_ID,
        },
      },
    );
  });

  afterAll(async () => {
    eraseTenant(PLATFORM_TENANT_ID);
    dropRlsFixture();
    await closeDatabase();
  });

  /** The tenant's own rows go with it, so no per-test cleanup of links is needed. */
  function eraseTenant(tenantId: string): void {
    // Both flags. `<t>_privileged_erase` is FOR DELETE and grants no read, and a
    // `DELETE ... WHERE id = ...` references a column, so PostgreSQL applies the SELECT
    // policies too: with only the erase flag set the statement sees no row, reports
    // DELETE 0, and raises nothing (test/support/rls-fixture.ts measured this).
    execSql(migrationDsn(), `DELETE FROM tenants WHERE id = :'tenant'::uuid;`, {
      tenantId,
      flags: { 'app.privileged_erase': tenantId },
      variables: { tenant: tenantId },
    });
  }

  async function insertLink(attempt: Attempt): Promise<unknown> {
    try {
      return await withTenantTransaction(attempt.tenantId, async (db) =>
        (
          await db.execute<{ id: string }>(
            sql`insert into links (tenant_id, workspace_id, domain_id, domain_tenant_id, slug, destination_url)
                values (${attempt.tenantId}::uuid, ${attempt.workspaceId}::uuid, ${attempt.domainId}::uuid, ${attempt.domainTenantId}::uuid, ${attempt.slug}, ${'https://example.test/target'})
                returning id`,
          )
        ).rows,
      );
    } catch (error) {
      return error;
    }
  }

  it('(d) the two legitimate cases: a link on the system default domain, and a link on a domain the same tenant owns', async () => {
    // Case 1, and the ONLY shape item 2's create path writes (D-2-12): the two frozen
    // constants. Tenant A cannot read this `domains` row at all, and the key still resolves,
    // because referential checks run with row security bypassed.
    const invisible = await withTenantTransaction(TENANT_A, async (db) =>
      (
        await db.execute<{ id: string }>(
          sql`select id from domains where id = ${SYSTEM_DEFAULT_DOMAIN_ID}::uuid`,
        )
      ).rows,
    );

    expect(invisible).toEqual([]);

    const onSystemDefault = await insertLink({
      tenantId: TENANT_A,
      workspaceId: WORKSPACE_A,
      domainId: SYSTEM_DEFAULT_DOMAIN_ID,
      domainTenantId: PLATFORM_TENANT_ID,
      slug: 'systemDefault',
    });

    expect(onSystemDefault).toHaveLength(1);

    // Case 2, item 3's shape, already admitted by the schema: a domain this tenant owns.
    const onOwnDomain = await insertLink({
      tenantId: TENANT_A,
      workspaceId: WORKSPACE_A,
      domainId: DOMAIN_OWNED_BY_A,
      domainTenantId: TENANT_A,
      slug: 'ownDomain',
    });

    expect(onOwnDomain).toHaveLength(1);
  });

  it('(a) an insert naming another tenant\'s domain truthfully is refused by links_domain_owner_check', async () => {
    // A names B's domain AND writes B's tenant id beside it, so the pair is a real `domains`
    // row and the foreign key is satisfied. The check is what refuses it: `domain_tenant_id`
    // is neither the row's own tenant nor the platform.
    const refused = await insertLink({
      tenantId: TENANT_A,
      workspaceId: WORKSPACE_A,
      domainId: DOMAIN_OWNED_BY_B,
      domainTenantId: TENANT_B,
      slug: 'truthfulSquat',
    });

    expect(postgresErrorCode(refused)).toBe('23514');
    expect(postgresErrorConstraint(refused)).toBe('links_domain_owner_check');
  });

  it('(c) an insert naming another tenant\'s domain while CLAIMING to own it is refused by links_domain_tenant_fk', async () => {
    // The lie the check alone would miss: A names B's domain and writes its OWN tenant id,
    // which satisfies `domain_tenant_id = tenant_id`. The pair (B's domain, A) is not a row
    // in `domains`, and referential integrity is not policy filtered, so it cannot be made
    // one by any statement A is allowed to issue.
    const refused = await insertLink({
      tenantId: TENANT_A,
      workspaceId: WORKSPACE_A,
      domainId: DOMAIN_OWNED_BY_B,
      domainTenantId: TENANT_A,
      slug: 'lyingSquat',
    });

    expect(postgresErrorCode(refused)).toBe('23503');
    expect(postgresErrorConstraint(refused)).toBe('links_domain_tenant_fk');
  });

  it('(c, vice versa) a row claiming the platform tenant while naming a customer domain is refused by links_domain_tenant_fk', async () => {
    // The check's second arm is the escape hatch a writer would reach for: claim the
    // platform and the check waves it through. The key does not: (a customer domain,
    // PLATFORM_TENANT_ID) is not a row either. Both of B's domain and A's OWN domain are
    // refused, so this is not a boundary property that happens to hold in one direction.
    for (const domainId of [DOMAIN_OWNED_BY_B, DOMAIN_OWNED_BY_A]) {
      const refused = await insertLink({
        tenantId: TENANT_A,
        workspaceId: WORKSPACE_A,
        domainId,
        domainTenantId: PLATFORM_TENANT_ID,
        slug: `platformClaim-${domainId.slice(0, 4)}`,
      });

      expect(postgresErrorCode(refused), domainId).toBe('23503');
      expect(postgresErrorConstraint(refused), domainId).toBe('links_domain_tenant_fk');
    }
  });

  it('(c, and the reverse claim) a row naming the system default domain while claiming its own tenant is refused by links_domain_tenant_fk', async () => {
    // The remaining corner: the domain is the platform's, the claim is the tenant's own. The
    // check is satisfied by `domain_tenant_id = tenant_id`; the pair is not a `domains` row.
    const refused = await insertLink({
      tenantId: TENANT_A,
      workspaceId: WORKSPACE_A,
      domainId: SYSTEM_DEFAULT_DOMAIN_ID,
      domainTenantId: TENANT_A,
      slug: 'ownClaimOnPlatform',
    });

    expect(postgresErrorCode(refused)).toBe('23503');
    expect(postgresErrorConstraint(refused)).toBe('links_domain_tenant_fk');
  });

  it('(b) an UPDATE moving an existing link onto another tenant\'s domain is refused, both ways of writing it', async () => {
    // An insert-only guard is a guard the second statement walks around. The link starts on
    // the system default domain, the way every link item 2 creates does.
    const created = (await insertLink({
      tenantId: TENANT_A,
      workspaceId: WORKSPACE_A,
      domainId: SYSTEM_DEFAULT_DOMAIN_ID,
      domainTenantId: PLATFORM_TENANT_ID,
      slug: 'moveMe',
    })) as { id: string }[];

    expect(created).toHaveLength(1);

    const linkId = created[0]?.id ?? '';

    async function moveTo(domainId: string, domainTenantId: string): Promise<unknown> {
      try {
        return await withTenantTransaction(TENANT_A, async (db) =>
          (
            await db.execute(
              sql`update links
                     set domain_id = ${domainId}::uuid, domain_tenant_id = ${domainTenantId}::uuid
                   where id = ${linkId}::uuid`,
            )
          ).rowCount,
        );
      } catch (error) {
        return error;
      }
    }

    // Truthful move: the check refuses it.
    const truthful = await moveTo(DOMAIN_OWNED_BY_B, TENANT_B);

    expect(postgresErrorCode(truthful)).toBe('23514');
    expect(postgresErrorConstraint(truthful)).toBe('links_domain_owner_check');

    // Lying move: the key refuses it.
    const lying = await moveTo(DOMAIN_OWNED_BY_B, TENANT_A);

    expect(postgresErrorCode(lying)).toBe('23503');
    expect(postgresErrorConstraint(lying)).toBe('links_domain_tenant_fk');

    // And moving only `domain_id`, leaving the claim behind, is the same refusal: the pair
    // is what the key reads, so a partial update cannot desynchronise the two columns.
    const partial = await withTenantTransaction(TENANT_A, async (db) => {
      try {
        await db.execute(
          sql`update links set domain_id = ${DOMAIN_OWNED_BY_B}::uuid where id = ${linkId}::uuid`,
        );

        return undefined;
      } catch (error) {
        return error;
      }
    }).catch((error: unknown) => error);

    expect(postgresErrorCode(partial)).toBe('23503');
    expect(postgresErrorConstraint(partial)).toBe('links_domain_tenant_fk');

    // The row is where it started, in the only view that can see it.
    const after = await withTenantTransaction(TENANT_A, async (db) =>
      (
        await db.execute<{ domain_id: string; domain_tenant_id: string }>(
          sql`select domain_id, domain_tenant_id from links where id = ${linkId}::uuid`,
        )
      ).rows,
    );

    expect(after).toEqual([
      { domain_id: SYSTEM_DEFAULT_DOMAIN_ID, domain_tenant_id: PLATFORM_TENANT_ID },
    ]);
  });

  it('the slug squat is gone: A cannot take a slug on B\'s domain at all, so B\'s own create succeeds', async () => {
    // The second half of the reviewer's finding. `links_domain_id_slug_unique` is an index
    // and an index is never policy filtered, so under the old schema A took a slug on B's
    // domain and B met a permanent 409 with no support path. A can no longer write the row,
    // so the index has nothing of A's on B's domain to collide with.
    const squat = await insertLink({
      tenantId: TENANT_A,
      workspaceId: WORKSPACE_A,
      domainId: DOMAIN_OWNED_BY_B,
      domainTenantId: TENANT_B,
      slug: 'contested',
    });

    expect(postgresErrorCode(squat)).toBe('23514');

    const owner = await insertLink({
      tenantId: TENANT_B,
      workspaceId: WORKSPACE_B,
      domainId: DOMAIN_OWNED_BY_B,
      domainTenantId: TENANT_B,
      slug: 'contested',
    });

    expect(owner).toHaveLength(1);
  });

  it('what is still shared, and it is the contract: one slug per slug on the system default domain, across tenants', async () => {
    // NOT a residue of the defect. `slug.md` scopes uniqueness to `(domain_id, slug)` and
    // AC-2-3 says a slug already taken on the system default domain BY ANY TENANT answers
    // 409 `slug_taken`. Both tenants legitimately share that one domain, so first writer
    // wins, and the API maps the 23505 rather than hiding it.
    const first = await insertLink({
      tenantId: TENANT_A,
      workspaceId: WORKSPACE_A,
      domainId: SYSTEM_DEFAULT_DOMAIN_ID,
      domainTenantId: PLATFORM_TENANT_ID,
      slug: 'shared',
    });

    expect(first).toHaveLength(1);

    const second = await insertLink({
      tenantId: TENANT_B,
      workspaceId: WORKSPACE_B,
      domainId: SYSTEM_DEFAULT_DOMAIN_ID,
      domainTenantId: PLATFORM_TENANT_ID,
      slug: 'shared',
    });

    expect(postgresErrorCode(second)).toBe('23505');
    expect(postgresErrorConstraint(second)).toBe('links_domain_id_slug_unique');
  });
});
