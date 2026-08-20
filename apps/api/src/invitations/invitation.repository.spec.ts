/**
 * TASK-1b-04 — InvitationRepository, the parts decidable without a database.
 *
 * Contract: docs/contracts/invitation-tokens.md, tenant-context.md invariant 4,
 * isolation-coverage.md ("qualification is derived from the statement"). The same three
 * things `workspace.repository.spec.ts` asserts, over the same recording driver:
 *
 *   1. the class carries `TENANT_SCOPED_REPOSITORY_METADATA`;
 *   2. every method throws `TenantContextMissingError` outside a tenant context (the real
 *      accessor, not a stub);
 *   3. every statement it compiles is owner-qualified — `tenant_id` in every WHERE, set on
 *      every INSERT — asserted over the SQL a real drizzle instance hands the driver;
 *
 * plus this class's own promises: no statement ever projects `token_digest`; no returned
 * row carries a digest; a malformed id reaches no statement; revoke's state rules.
 */
import 'reflect-metadata';

import { drizzle } from 'drizzle-orm/node-postgres';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../db/schema';
import type * as TenantContext from '../tenancy/tenant-context';
import type { TenantDb } from '../tenancy/tenant-context';
import {
  TENANT_SCOPED_REPOSITORY_METADATA,
  TenantContextMissingError,
} from '../tenancy/tenant-context';

import { WorkspaceNotFoundError } from '../workspaces/workspace-not-found.error';

import { InvitationAlreadyAcceptedError, InvitationNotFoundError } from './errors';
import { InvitationRepository } from './invitation.repository';

let installedDb: NodePgDatabase<typeof schema> | undefined;
let installedTenantId: string | undefined;

vi.mock('../tenancy/tenant-context', async (importOriginal) => {
  const actual = await importOriginal<typeof TenantContext>();

  return {
    ...actual,
    tenantDb: () =>
      installedDb === undefined ? actual.tenantDb() : (installedDb as unknown as TenantDb),
    currentTenantId: () =>
      installedTenantId === undefined ? actual.currentTenantId() : installedTenantId,
  };
});

const TENANT = '11111111-1111-4111-8111-111111111111';
const INVITATION = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const WORKSPACE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const DIGEST = Buffer.alloc(32, 0x5a);
const AT = '2026-08-18T10:00:00.000Z';

interface RecordedStatement {
  readonly text: string;
  readonly params: readonly unknown[];
}

/** The `ROW_COLUMNS` projection, in order, as the driver hands it back in array row mode. */
function invitationRow(state = 'pending', revokedAt: string | null = null): unknown[] {
  return [INVITATION, TENANT, 'x@example.com', state, AT, AT, null, revokedAt, 'inviterUser01', 'inviter@example.com', null];
}

const GRANT_ROW = [INVITATION, WORKSPACE, 'Acme', 'member'];

interface RowAnswers {
  readonly invitation?: unknown[][];
  readonly updated?: unknown[][];
  readonly stateOnly?: unknown[][];
  readonly grants?: unknown[][];
}

interface Answers extends RowAnswers {
  /** A driver error to raise on the `invitation_workspaces` insert, the way `pg` raises it. */
  readonly grantInsertError?: Error;
}

function classify(text: string): keyof RowAnswers | 'insert' {
  if (text.startsWith('insert into')) {
    return 'insert';
  }
  if (text.startsWith('update "invitations"')) {
    return 'updated';
  }
  if (text.startsWith('select "state" from "invitations"')) {
    return 'stateOnly';
  }

  const fromInvitations = text.indexOf('from "invitations"');
  const fromGrants = text.indexOf('from "invitation_workspaces"');

  if (fromGrants !== -1 && (fromInvitations === -1 || fromGrants < fromInvitations)) {
    return 'grants';
  }

  return 'invitation';
}

function installFakeDatabase(answers: Answers = {}): RecordedStatement[] {
  const recorded: RecordedStatement[] = [];
  const defaults: Required<RowAnswers> = {
    invitation: [invitationRow()],
    updated: [invitationRow('revoked', AT)],
    stateOnly: [],
    grants: [GRANT_ROW],
  };
  const client = {
    query: (config: { text: string }, params: readonly unknown[]) => {
      recorded.push({ text: config.text, params });
      if (answers.grantInsertError !== undefined && config.text.startsWith('insert into "invitation_workspaces"')) {
        return Promise.reject(answers.grantInsertError);
      }
      const kind = classify(config.text);
      const rows =
        kind === 'insert'
          ? config.text.startsWith('insert into "invitations"')
            ? [invitationRow()]
            : []
          : (answers[kind] ?? defaults[kind]);

      return Promise.resolve({ rows, rowCount: rows.length, fields: [] });
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

const repository = new InvitationRepository();

const CREATE_INPUT = {
  email: 'x@example.com',
  workspaces: [{ workspaceId: WORKSPACE, workspaceRole: 'member' as const }],
  invitedByUserId: 'inviterUser01',
  inviterEmail: 'inviter@example.com',
  digest: DIGEST,
  expiresAt: new Date(AT),
};

const EVERY_METHOD: ReadonlyArray<[string, () => Promise<unknown>]> = [
  ['create', () => repository.create(CREATE_INPUT)],
  ['listForWorkspace', () => repository.listForWorkspace(WORKSPACE)],
  ['findById', () => repository.findById(INVITATION)],
  ['revoke', () => repository.revoke(INVITATION)],
];

describe('InvitationRepository', () => {
  it('carries TENANT_SCOPED_REPOSITORY_METADATA for ADR-0020 discovery', () => {
    expect(Reflect.getMetadata(TENANT_SCOPED_REPOSITORY_METADATA, InvitationRepository)).toBe(true);
  });

  describe('outside a tenant context', () => {
    it.each(EVERY_METHOD)('%s throws TenantContextMissingError', async (_name, call) => {
      await expect(call()).rejects.toBeInstanceOf(TenantContextMissingError);
    });
  });

  describe('every statement is owner-qualified and none projects token_digest', () => {
    it('create sets tenant_id on both inserts, stores the digest, and returns a row with no digest', async () => {
      const recorded = installFakeDatabase();

      const created = await repository.create(CREATE_INPUT);

      expect(recorded.map((statement) => statement.text.split(' ').slice(0, 3).join(' '))).toEqual([
        'insert into "invitations"',
        'insert into "invitation_workspaces"',
        'select "invitation_workspaces"."invitation_id", "invitation_workspaces"."workspace_id",',
      ]);
      expect(recorded[0]?.text).toMatch(/^insert into "invitations" \("id", "tenant_id", "email", "token_digest"/);
      expect(recorded[0]?.params).toContain(TENANT);
      expect(recorded[0]?.params).toContain(DIGEST);
      // RETURNING never names the digest.
      expect(recorded[0]?.text.split('returning')[1]).not.toContain('token_digest');
      expect(recorded[1]?.text).toMatch(/^insert into "invitation_workspaces" \("id", "tenant_id", "invitation_id", "workspace_id", "role"\)/);
      expect(recorded[1]?.params).toEqual(expect.arrayContaining([TENANT, INVITATION, WORKSPACE, 'member']));
      expect(recorded[2]?.text).toMatch(/where \("invitation_workspaces"\."invitation_id" in \(\$1\) and "invitation_workspaces"\."tenant_id" = \$2\)/);

      expect(created).toEqual({
        id: INVITATION,
        tenantId: TENANT,
        email: 'x@example.com',
        state: 'pending',
        workspaces: [{ workspaceId: WORKSPACE, workspaceName: 'Acme', workspaceRole: 'member' }],
        expiresAt: new Date(AT),
        createdAt: new Date(AT),
        acceptedAt: null,
        revokedAt: null,
        invitedByUserId: 'inviterUser01',
        inviterEmail: 'inviter@example.com',
        acceptedByUserId: null,
      });
      expect(created).not.toHaveProperty('tokenDigest');
    });

    it('create maps a 23503 on the grant insert (composite FK to workspaces) to WorkspaceNotFoundError, and reads no grants', async () => {
      // A real `pg.DatabaseError`, since `postgresErrorCode` unwraps drizzle's wrapper and
      // answers only for the driver's own class (tenant-context.md, "Driver errors inside `fn`").
      const violation = new pg.DatabaseError(
        'insert or update on table "invitation_workspaces" violates foreign key constraint',
        0,
        'error',
      );
      violation.code = '23503';
      violation.constraint = 'invitation_workspaces_workspace_tenant_fk';
      const recorded = installFakeDatabase({ grantInsertError: violation });

      const failure = await repository.create(CREATE_INPUT).then(
        () => undefined,
        (error: unknown) => error,
      );

      expect(failure).toBeInstanceOf(WorkspaceNotFoundError);
      expect((failure as WorkspaceNotFoundError).code).toBe('not_found');
      expect(recorded).toHaveLength(2);
    });

    it('create lets any other driver error on the grant insert propagate untouched', async () => {
      const other = new pg.DatabaseError('deadlock detected', 0, 'error');
      other.code = '40P01';
      installFakeDatabase({ grantInsertError: other });

      const failure = await repository.create(CREATE_INPUT).then(
        () => undefined,
        (error: unknown) => error,
      );

      // drizzle wraps the driver's error; the original is the cause and nothing here mapped it.
      expect(failure).not.toBeInstanceOf(WorkspaceNotFoundError);
      expect((failure as Error).cause).toBe(other);
    });

    it('listForWorkspace qualifies the outer read AND the exists subquery on tenant_id, newest first', async () => {
      const recorded = installFakeDatabase();

      await repository.listForWorkspace(WORKSPACE);

      expect(recorded).toHaveLength(2);
      const [list, grants] = recorded as [RecordedStatement, RecordedStatement];
      expect(list.text).toMatch(/^select .* from "invitations" where \("invitations"\."tenant_id" = \$1 and exists \(select 1 from "invitation_workspaces" where \("invitation_workspaces"\."invitation_id" = "invitations"\."id" and "invitation_workspaces"\."workspace_id" = \$2 and "invitation_workspaces"\."tenant_id" = \$3\)\)\) order by "invitations"\."created_at" desc, "invitations"\."id" desc$/);
      expect(list.params).toEqual([TENANT, WORKSPACE, TENANT]);
      expect(list.text).not.toContain('token_digest');
      expect(grants.text).toMatch(/"invitation_workspaces"\."tenant_id" = \$2/);
    });

    it('findById qualifies on id AND tenant_id and reads no digest', async () => {
      const recorded = installFakeDatabase();

      const found = await repository.findById(INVITATION);

      expect(recorded[0]?.text).toMatch(/where \("invitations"\."id" = \$1 and "invitations"\."tenant_id" = \$2\)/);
      expect(recorded[0]?.params).toEqual([INVITATION, TENANT, 1]);
      expect(recorded[0]?.text).not.toContain('token_digest');
      expect(found).not.toBeNull();
      expect(found).not.toHaveProperty('tokenDigest');
    });

    it('findById returns null when the tenant owns no such row, without reading grants', async () => {
      const recorded = installFakeDatabase({ invitation: [] });

      await expect(repository.findById(INVITATION)).resolves.toBeNull();
      expect(recorded).toHaveLength(1);
    });

    it('revoke updates only a non-accepted row the tenant owns, keeps the first revoked_at, and returns state revoked', async () => {
      const recorded = installFakeDatabase();

      const revoked = await repository.revoke(INVITATION);

      expect(recorded[0]?.text).toMatch(/^update "invitations" set "state" = \$1, "revoked_at" = coalesce\("invitations"\."revoked_at", now\(\)\) where \("invitations"\."id" = \$2 and "invitations"\."tenant_id" = \$3 and "invitations"\."state" <> 'accepted'\) returning/);
      expect(recorded[0]?.params).toEqual(['revoked', INVITATION, TENANT]);
      expect(recorded[0]?.text.split('returning')[1]).not.toContain('token_digest');
      expect(revoked.state).toBe('revoked');
      expect(revoked.revokedAt).toEqual(new Date(AT));
    });

    it('revoke of an accepted row re-reads (owner-qualified) and throws InvitationAlreadyAcceptedError', async () => {
      const recorded = installFakeDatabase({ updated: [], stateOnly: [['accepted']] });

      await expect(repository.revoke(INVITATION)).rejects.toBeInstanceOf(InvitationAlreadyAcceptedError);
      expect(recorded).toHaveLength(2);
      expect(recorded[1]?.text).toMatch(/^select "state" from "invitations" where \("invitations"\."id" = \$1 and "invitations"\."tenant_id" = \$2\)/);
    });

    it('revoke of an id the tenant does not own throws InvitationNotFoundError', async () => {
      const recorded = installFakeDatabase({ updated: [], stateOnly: [] });

      await expect(repository.revoke(INVITATION)).rejects.toBeInstanceOf(InvitationNotFoundError);
      expect(recorded).toHaveLength(2);
    });

    it('no statement the repository issues lacks tenant_id, and none names token_digest outside the insert', async () => {
      const recorded = installFakeDatabase();

      for (const [, call] of EVERY_METHOD) {
        await call();
      }

      expect(recorded.length).toBeGreaterThanOrEqual(EVERY_METHOD.length);
      for (const statement of recorded) {
        expect(statement.text).toMatch(/^insert .*"tenant_id"|\bwhere\b.*"tenant_id"/);
        if (!statement.text.startsWith('insert into "invitations"')) {
          expect(statement.text).not.toContain('token_digest');
        }
      }
    });
  });

  describe('a malformed id', () => {
    it('is answered as not-found / empty without reaching the database', async () => {
      const recorded = installFakeDatabase();

      await expect(repository.findById('not-a-uuid')).resolves.toBeNull();
      await expect(repository.listForWorkspace('not-a-uuid')).resolves.toEqual([]);
      await expect(repository.revoke('not-a-uuid')).rejects.toBeInstanceOf(InvitationNotFoundError);

      expect(recorded).toEqual([]);
    });
  });
});
