/**
 * TASK-1b-05 — MembershipRepository and TenantMembershipRepository, the parts decidable
 * without a database. The same three things `workspace.repository.spec.ts` asserts, for the
 * same reasons: the ADR-0020 marker; `TenantContextMissingError` outside a context through
 * the REAL accessor; and every compiled statement owner-qualified, asserted over the SQL a
 * real drizzle instance hands a recording driver. Plus the two brand boundaries: a row's
 * `role` reaches a caller branded, and an unknown role in a row throws rather than brands.
 *
 * Contract: docs/contracts/workspace-authorization.md ("Roles"), tenant-context.md invariant 4,
 * isolation-coverage.md ("qualification is derived from the statement"). ADR-0048, ADR-0062.
 */
import 'reflect-metadata';

import { drizzle } from 'drizzle-orm/node-postgres';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { WORKSPACE_ROLE } from '@shortkit/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../db/schema';
import type * as TenantContext from '../tenancy/tenant-context';
import type { TenantDb } from '../tenancy/tenant-context';
import { TENANT_SCOPED_REPOSITORY_METADATA, TenantContextMissingError } from '../tenancy/tenant-context';
import { MembershipRepository } from './membership.repository';
import { TenantMembershipRepository } from './tenant-membership.repository';

let installedDb: NodePgDatabase<typeof schema> | undefined;
let installedTenantId: string | undefined;

vi.mock('../tenancy/tenant-context', async (importOriginal) => {
  const actual = await importOriginal<typeof TenantContext>();

  return {
    ...actual,
    tenantDb: () => (installedDb === undefined ? actual.tenantDb() : (installedDb as unknown as TenantDb)),
    currentTenantId: () => (installedTenantId === undefined ? actual.currentTenantId() : installedTenantId),
  };
});

const TENANT = '11111111-1111-4111-8111-111111111111';
const WORKSPACE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const MEMBERSHIP = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const USER = 'user_7d3e2f1a0b9c8d7e';
const CREATED_AT = '2026-08-18T10:00:00.000Z';

interface RecordedStatement {
  readonly text: string;
  readonly params: readonly unknown[];
}

/**
 * The rows the fake driver answers, in drizzle's array row mode. `select({ role })` maps one
 * column by position; `select()` / `returning()` map the table's column order
 * (id, tenant_id, workspace_id, user_id, role, created_at). Timestamps arrive as text from
 * `pg` and drizzle's `timestamp` column maps them to `Date`.
 */
const FULL_ROW = [MEMBERSHIP, TENANT, WORKSPACE, USER, 'member', CREATED_AT];

function installFakeDatabase(rows: readonly (readonly unknown[])[]): RecordedStatement[] {
  const recorded: RecordedStatement[] = [];
  const client = {
    query: (config: { text: string }, params: readonly unknown[]) => {
      recorded.push({ text: config.text, params });

      return Promise.resolve({ rows: [...rows], rowCount: rows.length, fields: [] });
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

const memberships = new MembershipRepository();
const tenantMemberships = new TenantMembershipRepository();

const EVERY_METHOD: ReadonlyArray<[string, () => Promise<unknown>]> = [
  ['roleFor', () => memberships.roleFor(WORKSPACE, USER)],
  ['workspaceIdsFor', () => memberships.workspaceIdsFor(USER)],
  ['create', () => memberships.create({ workspaceId: WORKSPACE, userId: USER, role: WORKSPACE_ROLE.member })],
  ['listForWorkspace', () => memberships.listForWorkspace(WORKSPACE)],
  ['TenantMembershipRepository.roleFor', () => tenantMemberships.roleFor(USER)],
];

describe('MembershipRepository and TenantMembershipRepository', () => {
  it('both carry TENANT_SCOPED_REPOSITORY_METADATA for ADR-0020 discovery', () => {
    expect(Reflect.getMetadata(TENANT_SCOPED_REPOSITORY_METADATA, MembershipRepository)).toBe(true);
    expect(Reflect.getMetadata(TENANT_SCOPED_REPOSITORY_METADATA, TenantMembershipRepository)).toBe(true);
  });

  describe('outside a tenant context', () => {
    it.each(EVERY_METHOD)('%s throws TenantContextMissingError', async (_name, call) => {
      await expect(call()).rejects.toBeInstanceOf(TenantContextMissingError);
    });
  });

  describe('every statement is owner-qualified', () => {
    it('roleFor qualifies on tenant_id AND workspace_id AND user_id, and brands the role', async () => {
      const recorded = installFakeDatabase([['workspace_admin']]);

      const role = await memberships.roleFor(WORKSPACE, USER);

      expect(role).toBe(WORKSPACE_ROLE.workspace_admin);
      expect(recorded).toHaveLength(1);
      expect(recorded[0]?.text).toMatch(
        /where \("memberships"\."tenant_id" = \$1 and "memberships"\."workspace_id" = \$2 and "memberships"\."user_id" = \$3\)/,
      );
      // The fourth parameter is `limit 1`.
      expect(recorded[0]?.params).toEqual([TENANT, WORKSPACE, USER, 1]);
    });

    it('roleFor answers null for no row, without inventing a role', async () => {
      installFakeDatabase([]);

      await expect(memberships.roleFor(WORKSPACE, USER)).resolves.toBeNull();
    });

    it('roleFor throws rather than brands a role outside WORKSPACE_ROLES', async () => {
      installFakeDatabase([['owner']]);

      await expect(memberships.roleFor(WORKSPACE, USER)).rejects.toThrow(/not a workspace role/);
    });

    it('workspaceIdsFor qualifies on tenant_id AND user_id, and brands each role', async () => {
      const recorded = installFakeDatabase([
        [WORKSPACE, 'member'],
        ['bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'viewer'],
      ]);

      const entries = await memberships.workspaceIdsFor(USER);

      expect(entries).toEqual([
        { workspaceId: WORKSPACE, role: WORKSPACE_ROLE.member },
        { workspaceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', role: WORKSPACE_ROLE.viewer },
      ]);
      expect(recorded).toHaveLength(1);
      expect(recorded[0]?.text).toMatch(/where \("memberships"\."tenant_id" = \$1 and "memberships"\."user_id" = \$2\)/);
      expect(recorded[0]?.params).toEqual([TENANT, USER]);
    });

    it('create sets tenant_id explicitly from the context and returns the branded row', async () => {
      const recorded = installFakeDatabase([FULL_ROW]);

      const created = await memberships.create({ workspaceId: WORKSPACE, userId: USER, role: WORKSPACE_ROLE.member });

      expect(recorded).toHaveLength(1);
      expect(recorded[0]?.text).toMatch(/^insert into "memberships" \("id", "tenant_id", "workspace_id", "user_id", "role", "created_at"\)/);
      expect(recorded[0]?.params).toEqual([TENANT, WORKSPACE, USER, 'member']);
      expect(created).toEqual({
        id: MEMBERSHIP,
        tenantId: TENANT,
        workspaceId: WORKSPACE,
        userId: USER,
        role: WORKSPACE_ROLE.member,
        createdAt: CREATED_AT,
      });
    });

    it('listForWorkspace qualifies on tenant_id AND workspace_id', async () => {
      const recorded = installFakeDatabase([FULL_ROW]);

      const rows = await memberships.listForWorkspace(WORKSPACE);

      expect(rows).toHaveLength(1);
      expect(rows[0]?.role).toBe(WORKSPACE_ROLE.member);
      expect(recorded).toHaveLength(1);
      expect(recorded[0]?.text).toMatch(/where \("memberships"\."tenant_id" = \$1 and "memberships"\."workspace_id" = \$2\)/);
      expect(recorded[0]?.params).toEqual([TENANT, WORKSPACE]);
    });

    it('TenantMembershipRepository.roleFor qualifies on tenant_id AND user_id, and brands the role', async () => {
      const recorded = installFakeDatabase([['owner']]);

      const role = await tenantMemberships.roleFor(USER);

      expect(role).toBe('owner');
      expect(recorded).toHaveLength(1);
      expect(recorded[0]?.text).toMatch(/from "tenant_memberships"/);
      expect(recorded[0]?.text).toMatch(
        /where \("tenant_memberships"\."tenant_id" = \$1 and "tenant_memberships"\."user_id" = \$2\)/,
      );
      expect(recorded[0]?.params).toEqual([TENANT, USER, 1]);
      // It reads under the ordinary tenant policy: no lookup flag is set by any statement.
      expect(recorded[0]?.text).not.toMatch(/set_config|membership_lookup/);
    });

    it('TenantMembershipRepository.roleFor answers null for no row', async () => {
      installFakeDatabase([]);

      await expect(tenantMemberships.roleFor(USER)).resolves.toBeNull();
    });

    it('no statement either repository issues lacks tenant_id', async () => {
      const recorded = installFakeDatabase([FULL_ROW]);

      for (const [, call] of EVERY_METHOD) {
        // The one answer shape does not fit every projection (a `select({ role })` reads the
        // id as its role and the brand refuses it); the statement is recorded before that.
        await call().catch(() => undefined);
      }

      expect(recorded).toHaveLength(EVERY_METHOD.length);
      for (const statement of recorded) {
        expect(statement.text).toMatch(/^insert .*"tenant_id"|\bwhere\b.*"tenant_id"/);
      }
    });
  });

  describe('a malformed workspace id', () => {
    it('is answered as no membership / no rows without reaching the database', async () => {
      const recorded = installFakeDatabase([FULL_ROW]);

      await expect(memberships.roleFor('not-a-uuid', USER)).resolves.toBeNull();
      await expect(memberships.listForWorkspace('not-a-uuid')).resolves.toEqual([]);

      expect(recorded).toEqual([]);
    });
  });
});
