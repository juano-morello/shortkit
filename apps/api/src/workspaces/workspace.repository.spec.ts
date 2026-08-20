/**
 * TASK-011: WorkspaceRepository, the parts decidable without a database.
 * TASK-1b-06: `listForUser`: the membership join is owner-qualified on BOTH tables.
 *
 * Contract: docs/contracts/workspaces.md ("What the implementer must guarantee"),
 * tenant-context.md invariant 4, isolation-coverage.md ("qualification is derived from
 * the statement").
 *
 * Three things, none of which needs Postgres:
 *
 *   1. the class carries `TENANT_SCOPED_REPOSITORY_METADATA`, read the way ADR-0020's
 *      discovery reads it;
 *   2. every method throws `TenantContextMissingError` outside a tenant context, because
 *      the only handle it holds is `tenantDb()`: the accessor is REAL here, not mocked,
 *      so this asserts the repository's dependency and not a stub's behaviour;
 *   3. every statement it compiles is owner-qualified (carries `tenant_id` in its WHERE,
 *      or sets it on INSERT) asserted over the SQL a real drizzle instance hands the
 *      driver. The driver is the fake: it records what it was asked and answers one row.
 *      Nothing about row-level security is claimed here; that is the integration suite's.
 *
 * `tenantDb()` and `currentTenantId()` are replaced by a delegating mock: with no fake
 * installed they call the real module, so test 2 exercises the genuine accessor; a test
 * that installs a fake gets it for that test only.
 */
import 'reflect-metadata';

import { drizzle } from 'drizzle-orm/node-postgres';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../db/schema';
import type * as TenantContext from '../tenancy/tenant-context';
import type { TenantDb } from '../tenancy/tenant-context';
import { TENANT_SCOPED_REPOSITORY_METADATA, TenantContextMissingError } from '../tenancy/tenant-context';

import { WorkspaceNotFoundError } from './workspace-not-found.error';
import { WorkspaceRepository } from './workspace.repository';

let installedDb: NodePgDatabase<typeof schema> | undefined;
let installedTenantId: string | undefined;

vi.mock('../tenancy/tenant-context', async (importOriginal) => {
  const actual = await importOriginal<typeof TenantContext>();

  return {
    ...actual,
    tenantDb: () => (installedDb === undefined ? actual.tenantDb() : (installedDb as unknown as TenantDb)),
    currentTenantId: () =>
      installedTenantId === undefined ? actual.currentTenantId() : installedTenantId,
  };
});

const TENANT = '11111111-1111-4111-8111-111111111111';
const WORKSPACE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER = 'user_01';

interface RecordedStatement {
  readonly text: string;
  readonly params: readonly unknown[];
}

/**
 * The row the fake driver answers, in drizzle's array row mode and in the table's column
 * order (id, tenant_id, name, archived_at, created_at, updated_at). Timestamps arrive as
 * text from `pg` and drizzle's `timestamp` column maps them to `Date`.
 */
const DRIVER_ROW = [
  WORKSPACE,
  TENANT,
  'Acme',
  null,
  '2026-08-17T10:00:00.000Z',
  '2026-08-17T10:00:00.000Z',
];

/** `listForUser` selects seven columns: the six above, then `memberships.role`. */
const DRIVER_ROW_WITH_ROLE = [...DRIVER_ROW, 'member'];

function installFakeDatabase(row: readonly unknown[] = DRIVER_ROW): RecordedStatement[] {
  const recorded: RecordedStatement[] = [];
  const client = {
    query: (config: { text: string }, params: readonly unknown[]) => {
      recorded.push({ text: config.text, params });

      return Promise.resolve({ rows: [row], rowCount: 1, fields: [] });
    },
  };

  installedDb = drizzle({ client: client as unknown as pg.Pool, schema });
  installedTenantId = TENANT;

  return recorded;
}

afterEach(() => {
  installedDb = undefined;
  installedTenantId = undefined;
});

const repository = new WorkspaceRepository();

const EVERY_METHOD: ReadonlyArray<[string, () => Promise<unknown>]> = [
  ['create', () => repository.create({ name: 'Acme' })],
  ['list', () => repository.list({ includeArchived: false })],
  ['list (includeArchived)', () => repository.list({ includeArchived: true })],
  ['listForUser', () => repository.listForUser(USER, { includeArchived: false })],
  ['listForUser (includeArchived)', () => repository.listForUser(USER, { includeArchived: true })],
  ['findById', () => repository.findById(WORKSPACE)],
  ['rename', () => repository.rename(WORKSPACE, 'Acme Group')],
  ['archive', () => repository.archive(WORKSPACE)],
];

describe('WorkspaceRepository', () => {
  it('carries TENANT_SCOPED_REPOSITORY_METADATA for ADR-0020 discovery', () => {
    expect(Reflect.getMetadata(TENANT_SCOPED_REPOSITORY_METADATA, WorkspaceRepository)).toBe(
      true,
    );
  });

  describe('outside a tenant context', () => {
    it.each(EVERY_METHOD)('%s throws TenantContextMissingError', async (_name, call) => {
      await expect(call()).rejects.toBeInstanceOf(TenantContextMissingError);
    });
  });

  describe('every statement is owner-qualified', () => {
    it('create sets tenant_id explicitly from the context', async () => {
      const recorded = installFakeDatabase();

      const created = await repository.create({ name: 'Acme' });

      expect(recorded).toHaveLength(1);
      expect(recorded[0]?.text).toMatch(/^insert into "workspaces" \("id", "tenant_id", "name"/);
      expect(recorded[0]?.params).toContain(TENANT);
      expect(created).toEqual({
        id: WORKSPACE,
        tenantId: TENANT,
        name: 'Acme',
        archivedAt: null,
        createdAt: new Date('2026-08-17T10:00:00.000Z'),
        updatedAt: new Date('2026-08-17T10:00:00.000Z'),
      });
    });

    it('list qualifies on tenant_id and, by default, on archived_at is null', async () => {
      const recorded = installFakeDatabase();

      await repository.list({ includeArchived: false });
      await repository.list({ includeArchived: true });

      expect(recorded).toHaveLength(2);
      for (const statement of recorded) {
        expect(statement.text).toMatch(/where .*"workspaces"\."tenant_id" = \$1/);
        expect(statement.params).toEqual([TENANT]);
      }
      expect(recorded[0]?.text).toMatch(/where \(.*"workspaces"\."archived_at" is null\)/);
      expect(recorded[1]?.text).not.toMatch(/where .*archived_at/);
    });

    it('listForUser joins memberships on (workspace_id, tenant_id) and qualifies on tenant_id of BOTH tables and on user_id', async () => {
      const recorded = installFakeDatabase(DRIVER_ROW_WITH_ROLE);

      const listed = await repository.listForUser(USER, { includeArchived: false });
      await repository.listForUser(USER, { includeArchived: true });

      expect(recorded).toHaveLength(2);
      for (const statement of recorded) {
        expect(statement.text).toMatch(/^select .* from "workspaces" inner join "memberships" on \("memberships"\."workspace_id" = "workspaces"\."id" and "memberships"\."tenant_id" = "workspaces"\."tenant_id"\)/);
        expect(statement.text).toMatch(/where \(.*"workspaces"\."tenant_id" = \$1 and "memberships"\."tenant_id" = \$2 and "memberships"\."user_id" = \$3/);
        expect(statement.text).toMatch(/order by "workspaces"\."created_at" asc, "workspaces"\."id" asc/);
        expect(statement.params).toEqual([TENANT, TENANT, USER]);
      }
      expect(recorded[0]?.text).toMatch(/"workspaces"\."archived_at" is null/);
      expect(recorded[1]?.text).not.toMatch(/archived_at is null/);

      // The row comes back with the role branded, beside the six workspace columns.
      expect(listed).toEqual([
        {
          id: WORKSPACE,
          tenantId: TENANT,
          name: 'Acme',
          archivedAt: null,
          createdAt: new Date('2026-08-17T10:00:00.000Z'),
          updatedAt: new Date('2026-08-17T10:00:00.000Z'),
          role: 'member',
        },
      ]);
    });

    it('findById qualifies on id AND tenant_id', async () => {
      const recorded = installFakeDatabase();

      await repository.findById(WORKSPACE);

      expect(recorded).toHaveLength(1);
      expect(recorded[0]?.text).toMatch(
        /where \("workspaces"\."id" = \$1 and "workspaces"\."tenant_id" = \$2\)/,
      );
      // The third parameter is `limit 1`.
      expect(recorded[0]?.params).toEqual([WORKSPACE, TENANT, 1]);
    });

    it('rename qualifies on id AND tenant_id, and bumps updated_at', async () => {
      const recorded = installFakeDatabase();

      await repository.rename(WORKSPACE, 'Acme Group');

      expect(recorded).toHaveLength(1);
      expect(recorded[0]?.text).toMatch(/^update "workspaces" set "name" = \$1, "updated_at" = now\(\)/);
      expect(recorded[0]?.text).toMatch(
        /where \("workspaces"\."id" = \$2 and "workspaces"\."tenant_id" = \$3\)/,
      );
      expect(recorded[0]?.params).toEqual(['Acme Group', WORKSPACE, TENANT]);
    });

    it('archive qualifies on id AND tenant_id, and keeps the first archived_at', async () => {
      const recorded = installFakeDatabase();

      await repository.archive(WORKSPACE);

      expect(recorded).toHaveLength(1);
      expect(recorded[0]?.text).toMatch(
        /^update "workspaces" set "archived_at" = coalesce\("workspaces"\."archived_at", now\(\)\), "updated_at" = now\(\)/,
      );
      expect(recorded[0]?.text).toMatch(
        /where \("workspaces"\."id" = \$1 and "workspaces"\."tenant_id" = \$2\)/,
      );
      expect(recorded[0]?.params).toEqual([WORKSPACE, TENANT]);
    });

    it('no statement the repository issues lacks tenant_id', async () => {
      const recorded = installFakeDatabase(DRIVER_ROW_WITH_ROLE);

      for (const [, call] of EVERY_METHOD) {
        await call();
      }

      expect(recorded).toHaveLength(EVERY_METHOD.length);
      for (const statement of recorded) {
        // An INSERT names the column; everything else names it in a WHERE clause.
        expect(statement.text).toMatch(/^insert .*"tenant_id"|\bwhere\b.*"tenant_id"/);
      }
    });
  });

  describe('a malformed id', () => {
    it('is answered as not-found without reaching the database', async () => {
      const recorded = installFakeDatabase();

      await expect(repository.findById('not-a-uuid')).resolves.toBeNull();
      await expect(repository.rename('not-a-uuid', 'x')).rejects.toBeInstanceOf(
        WorkspaceNotFoundError,
      );
      await expect(repository.archive('not-a-uuid')).rejects.toBeInstanceOf(
        WorkspaceNotFoundError,
      );

      expect(recorded).toEqual([]);
    });
  });

  describe('WorkspaceNotFoundError', () => {
    it('is a DomainError with code not_found and a message carrying no id', () => {
      const error = new WorkspaceNotFoundError();

      expect(error.code).toBe('not_found');
      expect(error.status).toBe(404);
      expect(error.message).not.toMatch(/[0-9a-f]{8}-/);
    });
  });
});
