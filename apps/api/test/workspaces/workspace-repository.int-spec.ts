/**
 * STORY-004 — AC-25, and the repository behaviour AC-21 to AC-23 rest on.
 *
 * Produced by: TASK-011.
 * Contract: docs/contracts/workspaces.md, rls-policy-template.md, tenant-context.md.
 *
 * Integration only, by ADR-0001: row-level security cannot be faked, and every
 * assertion here runs against the MIGRATED `workspaces` table — created by
 * `apps/api/drizzle/0002_*.sql` with the hand-appended `tenantScopedPolicies('workspaces')`
 * block — as `shortkit_app`, which holds neither SUPERUSER nor BYPASSRLS. The fixture
 * refuses to run otherwise.
 *
 * WHAT THIS FILE PROVES AND WHAT IT LEAVES TO OTHERS.
 *
 * - AC-25's substance, read from the catalogue: RLS enabled and forced, exactly the two
 *   template policies with the qual/with_check shapes `rls.ts` emits, and the tenant_id
 *   index. `pnpm db:check-policies` is the gate that asserts the same thing over EVERY
 *   table; this file asserts it for the one this TASK adds, so a regression names the
 *   table in the suite that owns it. It also holds migration 0002 to the function's
 *   output verbatim, so the appended block cannot drift from `tenantScopedPolicies()`.
 * - The repository's behaviour under a tenant transaction: create, list (default and
 *   with archived), rename, archive (idempotent), findById.
 * - Cross-tenant, in BOTH directions and through the repository's own methods: the
 *   other tenant's workspace is invisible to list and findById, rename and archive answer
 *   not-found, and the row is unchanged afterwards. The eight-shape statement battery
 *   over the TABLE is the isolation suite's (`test/isolation/registrations.ts`); this
 *   file attempts the METHODS.
 * - Outside a context, every method throws `TenantContextMissingError` — decidable in
 *   the unit spec too, repeated here against the real accessor and a real pool because
 *   the guarantee is what makes an unscoped read a crash rather than a leak.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { closeDatabase } from '../../src/db/client';
import { tenantScopedPolicies } from '../../src/db/rls';
import { TenantContextMissingError, withTenantTransaction } from '../../src/tenancy/tenant-context';
import { WorkspaceNotFoundError } from '../../src/workspaces/workspace-not-found.error';
import { WorkspaceRepository } from '../../src/workspaces/workspace.repository';
import type { Workspace } from '../../src/workspaces/workspace.repository';
import { querySql } from '../support/psql';
import {
  assertAppRoleCannotBypassRls,
  createRlsFixture,
  dropRlsFixture,
  migrationDsn,
  TENANT_A,
  TENANT_B,
} from '../support/rls-fixture';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const repository = new WorkspaceRepository();

/** Runs `work` in its own committed tenant transaction, so persistence is what is asserted. */
function asTenant<T>(tenantId: string, work: () => Promise<T>): Promise<T> {
  return withTenantTransaction(tenantId, () => work());
}

async function rejectionOf(work: Promise<unknown>): Promise<unknown> {
  try {
    await work;
  } catch (error) {
    return error;
  }

  throw new Error('expected the call to reject, but it resolved');
}

const DRIZZLE_DIR = fileURLToPath(new URL('../../drizzle/', import.meta.url));

function migration0002(): string {
  const [file, ...others] = readdirSync(DRIZZLE_DIR).filter((entry) => /^0002_.*\.sql$/.test(entry));

  if (file === undefined || others.length > 0) {
    throw new Error(`expected exactly one 0002_*.sql migration, found ${String([file, ...others])}`);
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

describe('workspaces: the migrated table (AC-25)', () => {
  it('migration 0002 carries every statement tenantScopedPolicies(\'workspaces\') produces, verbatim', () => {
    const migration = migration0002();

    for (const statement of tenantScopedPolicies('workspaces').statements) {
      expect(migration).toContain(statement);
    }
  });

  it('the table has row-level security enabled AND forced', () => {
    const [state] = querySql<RelationState>(
      migrationDsn(),
      `SELECT c.relrowsecurity AS row_security, c.relforcerowsecurity AS force_row_security
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = 'workspaces'`,
    );

    expect(state).toEqual({ row_security: true, force_row_security: true });
  });

  it('carries exactly the two template policies, with matching USING and WITH CHECK on tenant_id', () => {
    const policies = querySql<PolicyRow>(
      migrationDsn(),
      `SELECT policyname, cmd, qual, with_check
         FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'workspaces'
        ORDER BY policyname`,
    );

    expect(policies.map((policy) => [policy.policyname, policy.cmd])).toEqual([
      ['workspaces_privileged_erase', 'DELETE'],
      ['workspaces_tenant_isolation', 'ALL'],
    ]);

    const [erase, isolation] = policies as [PolicyRow, PolicyRow];

    // The FOR ALL policy: the same predicate on both halves, keyed on the tenant flag
    // through the nullif wrapper ADR-0049 requires.
    expect(isolation.qual).toBe(isolation.with_check);
    expect(isolation.qual).toMatch(/^\(tenant_id = \(NULLIF\(current_setting\('app\.tenant_id'::text, true\), ''::text\)\)::uuid\)$/);

    // The privileged-erase policy: FOR DELETE, no WITH CHECK, keyed on the erase flag.
    expect(erase.with_check).toBeNull();
    expect(erase.qual).toMatch(/^\(\(tenant_id\)::text = NULLIF\(current_setting\('app\.privileged_erase'::text, true\), ''::text\)\)$/);
  });

  it('carries the tenant_id index', () => {
    const indexes = querySql<{ indexname: string }>(
      migrationDsn(),
      `SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'workspaces' ORDER BY indexname`,
    );

    expect(indexes.map((index) => index.indexname)).toContain('workspaces_tenant_id_idx');
  });
});

describe('WorkspaceRepository under a tenant transaction', () => {
  beforeAll(() => {
    assertAppRoleCannotBypassRls();
  });

  // Re-seeds tenants A and B; the cascade on workspaces.tenant_id takes every workspace
  // row a previous test (or a previous failure) left behind.
  beforeEach(() => {
    createRlsFixture();
  });

  afterAll(async () => {
    dropRlsFixture();
    await closeDatabase();
  });

  it('create returns the row with a database-generated id, and list returns exactly it', async () => {
    const created = await asTenant(TENANT_A, () => repository.create({ name: 'Acme' }));

    expect(created.id).toMatch(UUID);
    expect(created.tenantId).toBe(TENANT_A);
    expect(created.name).toBe('Acme');
    expect(created.archivedAt).toBeNull();
    expect(created.createdAt).toBeInstanceOf(Date);
    expect(created.updatedAt).toBeInstanceOf(Date);

    const listed = await asTenant(TENANT_A, () => repository.list({ includeArchived: false }));

    expect(listed).toEqual([created]);
  });

  it('list orders by creation, then id, and includeArchived changes nothing while none is archived', async () => {
    const first = await asTenant(TENANT_A, () => repository.create({ name: 'First' }));
    const second = await asTenant(TENANT_A, () => repository.create({ name: 'Second' }));

    const active = await asTenant(TENANT_A, () => repository.list({ includeArchived: false }));
    const all = await asTenant(TENANT_A, () => repository.list({ includeArchived: true }));

    expect(active.map((workspace) => workspace.id)).toEqual([first.id, second.id]);
    expect(all).toEqual(active);
  });

  it('rename changes the name, keeps the id, and bumps updated_at', async () => {
    const created = await asTenant(TENANT_A, () => repository.create({ name: 'Acme' }));

    const renamed = await asTenant(TENANT_A, () => repository.rename(created.id, 'Acme Group'));

    expect(renamed.id).toBe(created.id);
    expect(renamed.name).toBe('Acme Group');
    expect(renamed.updatedAt.getTime()).toBeGreaterThanOrEqual(created.updatedAt.getTime());

    const listed = await asTenant(TENANT_A, () => repository.list({ includeArchived: false }));
    expect(listed.map((workspace) => [workspace.id, workspace.name])).toEqual([[created.id, 'Acme Group']]);
  });

  it('archive sets archived_at, removes the workspace from the default list, and keeps it in the archived list', async () => {
    const created = await asTenant(TENANT_A, () => repository.create({ name: 'Acme' }));
    const kept = await asTenant(TENANT_A, () => repository.create({ name: 'Kept' }));

    const archived = await asTenant(TENANT_A, () => repository.archive(created.id));

    expect(archived.id).toBe(created.id);
    expect(archived.archivedAt).toBeInstanceOf(Date);

    const active = await asTenant(TENANT_A, () => repository.list({ includeArchived: false }));
    const all = await asTenant(TENANT_A, () => repository.list({ includeArchived: true }));

    expect(active.map((workspace) => workspace.id)).toEqual([kept.id]);
    expect(all.map((workspace) => [workspace.id, workspace.archivedAt !== null])).toEqual([
      [created.id, true],
      [kept.id, false],
    ]);
  });

  it('archive is idempotent: a second call keeps the first archived_at', async () => {
    const created = await asTenant(TENANT_A, () => repository.create({ name: 'Acme' }));

    const first = await asTenant(TENANT_A, () => repository.archive(created.id));
    const second = await asTenant(TENANT_A, () => repository.archive(created.id));

    expect(second.archivedAt).toEqual(first.archivedAt);
  });

  it('findById returns the row, and null for an id nobody owns', async () => {
    const created = await asTenant(TENANT_A, () => repository.create({ name: 'Acme' }));

    await expect(asTenant(TENANT_A, () => repository.findById(created.id))).resolves.toEqual(created);
    await expect(
      asTenant(TENANT_A, () => repository.findById('00000000-0000-4000-8000-000000000000')),
    ).resolves.toBeNull();
  });

  it('rename and archive of an id nobody owns throw WorkspaceNotFoundError', async () => {
    const missing = '00000000-0000-4000-8000-000000000000';

    await expect(asTenant(TENANT_A, () => repository.rename(missing, 'x'))).rejects.toBeInstanceOf(
      WorkspaceNotFoundError,
    );
    await expect(asTenant(TENANT_A, () => repository.archive(missing))).rejects.toBeInstanceOf(
      WorkspaceNotFoundError,
    );
  });

  describe.each([
    ['A owns, B attempts', TENANT_A, TENANT_B],
    ['B owns, A attempts', TENANT_B, TENANT_A],
  ])('cross-tenant, %s', (_direction, owner, other) => {
    let owned: Workspace;

    beforeEach(async () => {
      owned = await asTenant(owner, () => repository.create({ name: 'Owned' }));
    });

    it("the other tenant's list is empty and findById answers null", async () => {
      await expect(asTenant(other, () => repository.list({ includeArchived: true }))).resolves.toEqual(
        [],
      );
      await expect(asTenant(other, () => repository.findById(owned.id))).resolves.toBeNull();
    });

    it('rename and archive by the other tenant answer not-found and change nothing', async () => {
      const renameFailure = await rejectionOf(asTenant(other, () => repository.rename(owned.id, 'Taken')));
      const archiveFailure = await rejectionOf(asTenant(other, () => repository.archive(owned.id)));

      expect(renameFailure).toBeInstanceOf(WorkspaceNotFoundError);
      expect(archiveFailure).toBeInstanceOf(WorkspaceNotFoundError);

      const afterwards = await asTenant(owner, () => repository.findById(owned.id));
      expect(afterwards).toEqual(owned);
    });

    it("the other tenant's create lands under the other tenant, never under the owner", async () => {
      const theirs = await asTenant(other, () => repository.create({ name: 'Theirs' }));

      expect(theirs.tenantId).toBe(other);

      const ownersView = await asTenant(owner, () => repository.list({ includeArchived: true }));
      expect(ownersView.map((workspace) => workspace.id)).toEqual([owned.id]);
    });
  });

  it('a raw unfiltered read inside a tenant transaction sees only that tenant\'s workspaces (the policy, not the WHERE)', async () => {
    await asTenant(TENANT_A, () => repository.create({ name: 'A' }));
    await asTenant(TENANT_B, () => repository.create({ name: 'B' }));

    const seenByA = await withTenantTransaction(TENANT_A, async (db) => {
      const result = await db.execute<{ tenant_id: string }>(sql`select tenant_id from workspaces`);

      return result.rows.map((row: { tenant_id: string }) => row.tenant_id);
    });

    expect(seenByA).toEqual([TENANT_A]);
  });
});

describe('WorkspaceRepository outside a tenant context', () => {
  afterAll(async () => {
    await closeDatabase();
  });

  it.each([
    ['create', () => repository.create({ name: 'Acme' })],
    ['list', () => repository.list({ includeArchived: false })],
    ['findById', () => repository.findById('00000000-0000-4000-8000-000000000000')],
    ['rename', () => repository.rename('00000000-0000-4000-8000-000000000000', 'x')],
    ['archive', () => repository.archive('00000000-0000-4000-8000-000000000000')],
  ] as ReadonlyArray<[string, () => Promise<unknown>]>)(
    '%s throws TenantContextMissingError',
    async (_name, call) => {
      await expect(call()).rejects.toBeInstanceOf(TenantContextMissingError);
    },
  );
});
