/**
 * TASK-1b-04 — the two token-entry functions, the parts decidable without a database.
 *
 * Contract: docs/contracts/invitation-tokens.md ("Normative sequence", "404 is one body").
 * ADR-0021, ADR-0015 (D-04), GC-K, GC-L, D-17.
 *
 * Four things:
 *
 *   1. THE GREP RULE (GC-L). Over `apps/api/src/**` excluding specs, the files containing
 *      `parseCapabilityToken(` are exactly `tokens/capability-token.ts` and
 *      `capability-lookup.ts`; the files that import from `invitations/tokens/` AND call
 *      `withTenantTransaction(` are exactly `capability-lookup.ts`. File-level, and honest
 *      about it: a caller in wave 3 that imports `issueCapabilityToken` to mint is allowed;
 *      one that also opens a transaction from a token is not.
 *   2. THE CONFLICT IS DECIDED BEFORE ANY STATEMENT (D-04): with an active context for
 *      another tenant, both functions throw `InvitationTenantConflictError` and no
 *      transaction is opened; with a matching one they proceed and join it.
 *   3. THE SEQUENCE over a recording driver: malformed → no transaction; the first statement
 *      is the digest select on `invitations`, owner-qualified; a returned row whose digest
 *      differs from the computed one is `null` (the `timingSafeEqual` path, unreachable
 *      through a real index and so measured here); each state maps to its error with no
 *      further statement; find never writes; accept's consume carries `state = 'pending'`
 *      and `expires_at >= now()`, zero rows is 409, memberships go in `on conflict do
 *      nothing`, `'require'` and `'create'` end in the tenant-membership check.
 *   4. Every statement either function issues is owner-qualified.
 *
 * `withTenantTransaction`, `tenantDb` and `currentTenantId` are replaced by delegating
 * mocks: with no fake installed they call the real module.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { drizzle } from 'drizzle-orm/node-postgres';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../db/schema';
import type * as TenantContext from '../tenancy/tenant-context';
import type { TenantDb } from '../tenancy/tenant-context';

import {
  acceptInvitationByCapabilityToken,
  findInvitationByCapabilityToken,
} from './capability-lookup';
import {
  InvitationAlreadyAcceptedError,
  InvitationExpiredError,
  InvitationNotFoundError,
  InvitationRevokedError,
  InvitationTenantConflictError,
} from './errors';
import { digestOf, issueCapabilityToken } from './tokens/capability-token';

let installedDb: NodePgDatabase<typeof schema> | undefined;
/** The tenant a fake `withTenantTransaction` is currently "inside". */
let transactionTenantId: string | undefined;
/** A fake ambient context that exists BEFORE either function is called (the route case). */
let ambientTenantId: string | undefined;
let openedTransactions: string[] = [];

vi.mock('../tenancy/tenant-context', async (importOriginal) => {
  const actual = await importOriginal<typeof TenantContext>();

  return {
    ...actual,
    withTenantTransaction: async <T>(tenantId: string, fn: (db: TenantDb) => Promise<T>) => {
      if (installedDb === undefined) {
        return actual.withTenantTransaction(tenantId, fn);
      }

      openedTransactions.push(tenantId);
      if (ambientTenantId !== undefined && ambientTenantId !== tenantId) {
        throw new actual.TenantContextMismatchError(ambientTenantId, tenantId);
      }
      transactionTenantId = tenantId;
      try {
        return await fn(installedDb as unknown as TenantDb);
      } finally {
        transactionTenantId = undefined;
      }
    },
    currentTenantId: () => {
      if (transactionTenantId !== undefined) {
        return transactionTenantId;
      }
      if (ambientTenantId !== undefined) {
        return ambientTenantId;
      }

      return actual.currentTenantId();
    },
  };
});

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const INVITATION = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const WORKSPACE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const MEMBERSHIP = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const USER = 'inviteeUser01';
const AT = '2026-08-25T10:00:00.000Z';

const ISSUED = issueCapabilityToken(TENANT_A);

interface RecordedStatement {
  readonly text: string;
  readonly params: readonly unknown[];
}

/**
 * The first statement's projection, in order: id, tenant_id, email, token_digest, state,
 * expires_at, expired, invited_by_user_id, inviter_email.
 */
function invitationRow(overrides: { state?: string; expired?: boolean; digest?: Buffer } = {}): unknown[] {
  return [
    INVITATION,
    TENANT_A,
    'x@example.com',
    overrides.digest ?? ISSUED.digest,
    overrides.state ?? 'pending',
    AT,
    overrides.expired ?? false,
    'inviterUser01',
    'inviter@example.com',
  ];
}

interface Answers {
  readonly invitation?: unknown[][];
  readonly tenant?: unknown[][];
  readonly grants?: unknown[][];
  readonly consumed?: unknown[][];
  readonly membershipInsert?: unknown[][];
  readonly tenantMembershipInsert?: unknown[][];
  readonly tenantMembership?: unknown[][];
}

function classify(text: string): keyof Answers {
  if (text.startsWith('update "invitations"')) {
    return 'consumed';
  }
  if (text.startsWith('insert into "memberships"')) {
    return 'membershipInsert';
  }
  if (text.startsWith('insert into "tenant_memberships"')) {
    return 'tenantMembershipInsert';
  }
  if (text.includes('from "tenant_memberships"')) {
    return 'tenantMembership';
  }
  if (text.includes('from "tenants"')) {
    return 'tenant';
  }
  if (text.includes('from "invitation_workspaces"')) {
    return 'grants';
  }

  return 'invitation';
}

function installFakeDatabase(answers: Answers = {}): RecordedStatement[] {
  const recorded: RecordedStatement[] = [];
  const defaults: Required<Answers> = {
    invitation: [invitationRow()],
    tenant: [['Tenant A']],
    grants: [[WORKSPACE, 'Acme', 'member']],
    consumed: [[INVITATION]],
    membershipInsert: [],
    tenantMembershipInsert: [[MEMBERSHIP]],
    tenantMembership: [[MEMBERSHIP]],
  };
  const client = {
    query: (config: { text: string }, params: readonly unknown[]) => {
      recorded.push({ text: config.text, params });
      const kind = classify(config.text);
      let rows = answers[kind] ?? defaults[kind];
      // Accept's grant read projects two columns; find's projects three.
      if (kind === 'grants' && config.text.startsWith('select "workspace_id", "role" from "invitation_workspaces"')) {
        rows = rows.map((row) => [row[0], row[2]]);
      }

      return Promise.resolve({ rows, rowCount: rows.length, fields: [] });
    },
  };

  installedDb = drizzle({ client: client as unknown as pg.Pool, schema });

  return recorded;
}

afterEach(() => {
  installedDb = undefined;
  transactionTenantId = undefined;
  ambientTenantId = undefined;
  openedTransactions = [];
});

async function rejectionOf(work: Promise<unknown>): Promise<unknown> {
  try {
    await work;
  } catch (error) {
    return error;
  }

  throw new Error('expected the call to reject, but it resolved');
}

const SRC_DIR = fileURLToPath(new URL('../', import.meta.url));

function sourceFiles(): ReadonlyArray<{ path: string; text: string }> {
  return readdirSync(SRC_DIR, { recursive: true, encoding: 'utf8' })
    .filter((entry) => entry.endsWith('.ts') && !entry.endsWith('.spec.ts') && !entry.endsWith('.d.ts'))
    .map((entry) => ({ path: entry, text: readFileSync(`${SRC_DIR}${entry}`, 'utf8') }));
}

describe('the grep rule (GC-L, D-17)', () => {
  it('parseCapabilityToken( is called from exactly tokens/capability-token.ts and capability-lookup.ts', () => {
    const callers = sourceFiles()
      .filter((file) => file.text.includes('parseCapabilityToken('))
      .map((file) => file.path)
      .sort();

    expect(callers).toEqual(['invitations/capability-lookup.ts', 'invitations/tokens/capability-token.ts']);
  });

  it('the only file that imports from invitations/tokens/ AND calls withTenantTransaction( is capability-lookup.ts', () => {
    const offenders = sourceFiles()
      .filter(
        (file) =>
          /from ['"][^'"]*\/tokens\/capability-token['"]/.test(file.text) &&
          file.text.includes('withTenantTransaction('),
      )
      .map((file) => file.path)
      .sort();

    expect(offenders).toEqual(['invitations/capability-lookup.ts']);
  });
});

describe('step 1: a malformed token opens no transaction', () => {
  it.each([
    ['empty', ''],
    ['no dot', 'abc'],
    ['bad uuid', `not-a-uuid.${ISSUED.raw.slice(37)}`],
    ['short secret', ISSUED.raw.slice(0, 79)],
    ['not a string', undefined as unknown as string],
  ])('%s → find null, accept InvitationNotFoundError, zero statements', async (_name, raw) => {
    const recorded = installFakeDatabase();

    await expect(findInvitationByCapabilityToken(raw)).resolves.toBeNull();
    await expect(
      acceptInvitationByCapabilityToken(raw, { userId: USER, tenantMembership: 'create' }),
    ).rejects.toBeInstanceOf(InvitationNotFoundError);

    expect(openedTransactions).toEqual([]);
    expect(recorded).toEqual([]);
  });
});

describe('step 2: the tenant conflict is decided before any statement (D-04)', () => {
  it('an active context for another tenant → InvitationTenantConflictError from both, no transaction, no statement', async () => {
    const recorded = installFakeDatabase();
    ambientTenantId = TENANT_B;

    await expect(findInvitationByCapabilityToken(ISSUED.raw)).rejects.toBeInstanceOf(
      InvitationTenantConflictError,
    );
    await expect(
      acceptInvitationByCapabilityToken(ISSUED.raw, { userId: USER, tenantMembership: 'require' }),
    ).rejects.toBeInstanceOf(InvitationTenantConflictError);

    expect(openedTransactions).toEqual([]);
    expect(recorded).toEqual([]);
  });

  it('an active context for the SAME tenant → proceeds, joining it (invariant 5)', async () => {
    installFakeDatabase();
    ambientTenantId = TENANT_A;

    const found = await findInvitationByCapabilityToken(ISSUED.raw);

    expect(found?.id).toBe(INVITATION);
    expect(openedTransactions).toEqual([TENANT_A]);
  });

  it('no active context → proceeds under the token\'s tenant', async () => {
    installFakeDatabase();

    await findInvitationByCapabilityToken(ISSUED.raw);

    expect(openedTransactions).toEqual([TENANT_A]);
  });
});

describe('steps 4 and 5: the digest lookup is the first statement, and the compare is in code', () => {
  it('the first statement selects from invitations WHERE token_digest = $digest AND tenant_id = <current>, never projecting more than it needs', async () => {
    const recorded = installFakeDatabase();

    await findInvitationByCapabilityToken(ISSUED.raw);

    const first = recorded[0];
    expect(first?.text).toMatch(/^select .* from "invitations" where \("invitations"\."token_digest" = \$1 and "invitations"\."tenant_id" = \$2\) limit \$3$/);
    expect(first?.params[0]).toEqual(digestOf(ISSUED.raw.slice(37)));
    expect(first?.params[1]).toBe(TENANT_A);
    // The raw token and the secret are never a parameter.
    for (const statement of recorded) {
      expect(statement.params).not.toContain(ISSUED.raw);
      expect(statement.params).not.toContain(ISSUED.raw.slice(37));
    }
  });

  it('no row → find null / accept 404, and nothing else runs', async () => {
    const recorded = installFakeDatabase({ invitation: [] });

    await expect(findInvitationByCapabilityToken(ISSUED.raw)).resolves.toBeNull();
    await expect(
      acceptInvitationByCapabilityToken(ISSUED.raw, { userId: USER, tenantMembership: 'create' }),
    ).rejects.toBeInstanceOf(InvitationNotFoundError);

    expect(recorded).toHaveLength(2);
  });

  it('a row whose stored digest differs from the computed one is null (timingSafeEqual path), and nothing else runs', async () => {
    const recorded = installFakeDatabase({ invitation: [invitationRow({ digest: Buffer.alloc(32, 0x00) })] });

    await expect(findInvitationByCapabilityToken(ISSUED.raw)).resolves.toBeNull();
    await expect(
      acceptInvitationByCapabilityToken(ISSUED.raw, { userId: USER, tenantMembership: 'create' }),
    ).rejects.toBeInstanceOf(InvitationNotFoundError);

    expect(recorded).toHaveLength(2);
  });

  it('a stored digest of the wrong length is a mismatch, not a throw', async () => {
    installFakeDatabase({ invitation: [invitationRow({ digest: Buffer.alloc(31, 0x5a) })] });

    await expect(findInvitationByCapabilityToken(ISSUED.raw)).resolves.toBeNull();
  });
});

describe('step 6: state mapping, with no further statement', () => {
  it.each([
    ['accepted', { state: 'accepted' }, InvitationAlreadyAcceptedError],
    ['revoked', { state: 'revoked' }, InvitationRevokedError],
    ['expired (derived from expires_at < now())', { expired: true }, InvitationExpiredError],
    ['expired (stored state, reserved for a sweeper)', { state: 'expired' }, InvitationExpiredError],
    ['revoked AND past expiry → revoked wins', { state: 'revoked', expired: true }, InvitationRevokedError],
    ['accepted AND past expiry → accepted wins', { state: 'accepted', expired: true }, InvitationAlreadyAcceptedError],
  ])('%s', async (_name, overrides, expected) => {
    const recorded = installFakeDatabase({ invitation: [invitationRow(overrides)] });

    const fromFind = await rejectionOf(findInvitationByCapabilityToken(ISSUED.raw));
    const fromAccept = await rejectionOf(
      acceptInvitationByCapabilityToken(ISSUED.raw, { userId: USER, tenantMembership: 'create' }),
    );

    expect(fromFind).toBeInstanceOf(expected);
    expect(fromAccept).toBeInstanceOf(expected);
    expect(recorded).toHaveLength(2);
    expect(recorded.every((statement) => statement.text.startsWith('select'))).toBe(true);
  });
});

describe('find: reads the preview and never writes', () => {
  it('reads invitations, then tenants (id = current), then the grants joined to workspaces, all owner-qualified', async () => {
    const recorded = installFakeDatabase();

    const found = await findInvitationByCapabilityToken(ISSUED.raw);

    expect(recorded.map((statement) => statement.text.split(' from "')[1]?.split('"')[0])).toEqual([
      'invitations',
      'tenants',
      'invitation_workspaces',
    ]);
    expect(recorded[1]?.text).toMatch(/where "tenants"\."id" = \$1/);
    expect(recorded[1]?.params).toEqual([TENANT_A, 1]);
    expect(recorded[2]?.text).toMatch(/inner join "workspaces" on \("workspaces"\."id" = "invitation_workspaces"\."workspace_id" and "workspaces"\."tenant_id" = "invitation_workspaces"\."tenant_id"\)/);
    expect(recorded[2]?.text).toMatch(/where \("invitation_workspaces"\."invitation_id" = \$1 and "invitation_workspaces"\."tenant_id" = \$2\)/);
    expect(recorded.every((statement) => statement.text.startsWith('select'))).toBe(true);

    expect(found).toEqual({
      id: INVITATION,
      tenantId: TENANT_A,
      email: 'x@example.com',
      state: 'pending',
      expiresAt: new Date(AT),
      workspaces: [{ workspaceId: WORKSPACE, workspaceName: 'Acme', workspaceRole: 'member' }],
      invitedByUserId: 'inviterUser01',
      inviterEmail: 'inviter@example.com',
      tenantName: 'Tenant A',
    });
    expect(found).not.toHaveProperty('tokenDigest');
    expect(JSON.stringify(found)).not.toContain(ISSUED.raw.slice(37));
  });
});

describe('accept: the consume and the writes', () => {
  it("'create': consume, grants, memberships on conflict do nothing, tenant_memberships on conflict do nothing — in that order", async () => {
    const recorded = installFakeDatabase();

    const accepted = await acceptInvitationByCapabilityToken(ISSUED.raw, {
      userId: USER,
      tenantMembership: 'create',
    });

    expect(recorded.map((statement) => statement.text.split(' ').slice(0, 3).join(' '))).toEqual([
      'select "id", "tenant_id",',
      'update "invitations" set',
      'select "workspace_id", "role"',
      'insert into "memberships"',
      'insert into "tenant_memberships"',
    ]);

    const consume = recorded[1];
    expect(consume?.text).toMatch(/^update "invitations" set "state" = \$1, "accepted_by_user_id" = \$2, "accepted_at" = now\(\) where \("invitations"\."id" = \$3 and "invitations"\."tenant_id" = \$4 and "invitations"\."state" = \$5 and "invitations"\."expires_at" >= now\(\)\) returning "id"$/);
    expect(consume?.params).toEqual(['accepted', USER, INVITATION, TENANT_A, 'pending']);

    const membership = recorded[3];
    expect(membership?.text).toMatch(/^insert into "memberships" \("id", "tenant_id", "workspace_id", "user_id", "role", "created_at"\) values \(default, \$1, \$2, \$3, \$4, default\) on conflict \("workspace_id","user_id"\) do nothing$/);
    expect(membership?.params).toEqual([TENANT_A, WORKSPACE, USER, 'member']);

    const tenantMembership = recorded[4];
    expect(tenantMembership?.text).toMatch(/^insert into "tenant_memberships" \("id", "tenant_id", "user_id", "role", "created_at"\) values \(default, \$1, \$2, \$3, default\) on conflict \("user_id"\) do nothing returning "id"$/);
    expect(tenantMembership?.params).toEqual([TENANT_A, USER, 'member']);

    expect(accepted).toEqual({
      tenantId: TENANT_A,
      workspaces: [{ workspaceId: WORKSPACE, workspaceRole: 'member' }],
    });
  });

  it("'require': verifies the tenant membership BEFORE the consume and writes no tenant_memberships row", async () => {
    const recorded = installFakeDatabase();

    await acceptInvitationByCapabilityToken(ISSUED.raw, { userId: USER, tenantMembership: 'require' });

    expect(recorded.map((statement) => statement.text.split(' ').slice(0, 3).join(' '))).toEqual([
      'select "id", "tenant_id",',
      'select "id" from',
      'update "invitations" set',
      'select "workspace_id", "role"',
      'insert into "memberships"',
    ]);
    expect(recorded[1]?.text).toMatch(/where \("tenant_memberships"\."tenant_id" = \$1 and "tenant_memberships"\."user_id" = \$2\)/);
    expect(recorded[1]?.params).toEqual([TENANT_A, USER, 1]);
  });

  it("'require' with no membership in this tenant → InvitationTenantConflictError, nothing consumed or written", async () => {
    const recorded = installFakeDatabase({ tenantMembership: [] });

    await expect(
      acceptInvitationByCapabilityToken(ISSUED.raw, { userId: USER, tenantMembership: 'require' }),
    ).rejects.toBeInstanceOf(InvitationTenantConflictError);

    expect(recorded).toHaveLength(2);
    expect(recorded.every((statement) => statement.text.startsWith('select'))).toBe(true);
  });

  it("'create' whose insert conflicts with a row in ANOTHER tenant → InvitationTenantConflictError", async () => {
    const recorded = installFakeDatabase({ tenantMembershipInsert: [], tenantMembership: [] });

    await expect(
      acceptInvitationByCapabilityToken(ISSUED.raw, { userId: USER, tenantMembership: 'create' }),
    ).rejects.toBeInstanceOf(InvitationTenantConflictError);

    expect(recorded.at(-1)?.text).toMatch(/from "tenant_memberships"/);
  });

  it("'create' whose insert conflicts with THIS tenant's own row is idempotent", async () => {
    installFakeDatabase({ tenantMembershipInsert: [], tenantMembership: [[MEMBERSHIP]] });

    await expect(
      acceptInvitationByCapabilityToken(ISSUED.raw, { userId: USER, tenantMembership: 'create' }),
    ).resolves.toEqual({ tenantId: TENANT_A, workspaces: [{ workspaceId: WORKSPACE, workspaceRole: 'member' }] });
  });

  it('the consume returning zero rows (the concurrent-accept race) → InvitationAlreadyAcceptedError and no insert', async () => {
    const recorded = installFakeDatabase({ consumed: [] });

    await expect(
      acceptInvitationByCapabilityToken(ISSUED.raw, { userId: USER, tenantMembership: 'create' }),
    ).rejects.toBeInstanceOf(InvitationAlreadyAcceptedError);

    expect(recorded).toHaveLength(2);
    expect(recorded.some((statement) => statement.text.startsWith('insert'))).toBe(false);
  });

  it('two named workspaces → two membership inserts, and the response lists both', async () => {
    const other = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    const recorded = installFakeDatabase({
      grants: [
        [WORKSPACE, 'Acme', 'member'],
        [other, 'Beta', 'viewer'],
      ],
    });

    const accepted = await acceptInvitationByCapabilityToken(ISSUED.raw, {
      userId: USER,
      tenantMembership: 'require',
    });

    expect(recorded.filter((statement) => statement.text.startsWith('insert into "memberships"'))).toHaveLength(2);
    expect(accepted.workspaces).toEqual([
      { workspaceId: WORKSPACE, workspaceRole: 'member' },
      { workspaceId: other, workspaceRole: 'viewer' },
    ]);
  });
});

describe('every statement either function issues is owner-qualified', () => {
  it('names tenant_id in every WHERE, or sets it on every INSERT (tenants: id = current)', async () => {
    const recorded = installFakeDatabase();

    await findInvitationByCapabilityToken(ISSUED.raw);
    await acceptInvitationByCapabilityToken(ISSUED.raw, { userId: USER, tenantMembership: 'create' });
    await acceptInvitationByCapabilityToken(ISSUED.raw, { userId: USER, tenantMembership: 'require' });

    expect(recorded.length).toBeGreaterThanOrEqual(3 + 5 + 5);
    for (const statement of recorded) {
      expect(statement.text).toMatch(
        /^insert .*"tenant_id"|\bwhere\b.*"tenant_id"|\bwhere "tenants"\."id" = \$1/,
      );
    }
  });
});
