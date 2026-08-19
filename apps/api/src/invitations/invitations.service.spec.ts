/**
 * TASK-1b-08 — InvitationsService, the parts decidable without a database.
 *
 * Contract: docs/contracts/invitation-tokens.md, workspace-authorization.md (D-09, Form B),
 * mail-sender.md, error-envelope.md, tenant-context.md (invariant 6). GC-H, GC-K.
 *
 * The repository, the workspace repository, the authorizer and the sender are fakes that
 * record what they were asked; `withTenantTransaction` is a fake that runs the body and
 * queues `afterCommit` hooks for the test to fire; the two entry functions are mocked. The
 * database, the policy and the real transaction are the integration tier's. Decidable here:
 *
 *   1. CREATE ORDER. Form B on every grant, in the request's order, BEFORE any workspace read
 *      and before any write; the first refusal stops everything — no read, no create, no mail.
 *   2. What `create` hands the repository: the 32-byte digest and never the raw token,
 *      `expiresAt = now + INVITATION_TTL_SECONDS`, `invitedByUserId` and `inviterEmail` from
 *      the actor.
 *   3. THE MAIL LEAVES AFTER COMMIT. Nothing is sent while the body runs; once the queued hook
 *      fires, exactly one `workspace_invitation` message, whose fragment token digests to what
 *      the repository stored, with the workspace names in the request's order and the row's
 *      `expiresAt`. A body that throws queues nothing.
 *   4. NO TOKEN ON THE WIRE. The response satisfies `invitationContract`, which has no token
 *      field, and its bytes do not contain the raw token or its secret half.
 *   5. Archived → 400 `validation_failed` under `workspaces`; `expired` derived on read (D-11);
 *      revoke loads first, asserts every grant, then revokes; lookup and accept project the
 *      entry functions' results and pass `'require'`.
 */
import { createHash } from 'node:crypto';

import {
  acceptInvitationResponseContract,
  INVITATION_TTL_SECONDS,
  invitationContract,
  invitationListResponseContract,
  invitationPreviewContract,
} from '@shortkit/contracts';
import type { WorkspaceRole } from '@shortkit/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runAsActor } from '../common/authorization/actor-context';
import { InsufficientWorkspaceRoleError, WorkspaceAccessNotFoundError } from '../common/authorization/errors';
import type { WorkspaceAuthorizer } from '../common/authorization/workspace-authorizer';
import { DomainError } from '../common/errors/domain-error';
import type { MailSender, OutboundMail } from '../mail/mail-sender';
import type * as TenantContext from '../tenancy/tenant-context';
import type { RequestContext } from '../tenancy/tenant-context';
import { WorkspaceNotFoundError } from '../workspaces/workspace-not-found.error';
import type { Workspace as WorkspaceRow, WorkspaceRepository } from '../workspaces/workspace.repository';

import * as capabilityLookup from './capability-lookup';
import { InvitationAlreadyAcceptedError, InvitationNotFoundError, InvitationTenantConflictError } from './errors';
import type { CreateInvitationInput, InvitationRepository, InvitationRow } from './invitation.repository';
import { ARCHIVED_WORKSPACE_MESSAGE, InvitationsService, toClientInvitation } from './invitations.service';

vi.mock('./capability-lookup', () => ({
  findInvitationByCapabilityToken: vi.fn(),
  acceptInvitationByCapabilityToken: vi.fn(),
}));

const TENANT = '11111111-1111-4111-8111-111111111111';
const W1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const W2 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2';
const W3 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3';
const INVITATION = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CREATED_AT = new Date('2026-08-18T09:00:00.000Z');
const TENANT_NAME = 'Acme Agency';

const ACTOR: RequestContext = {
  userId: 'ownerUser0000001',
  tenantId: TENANT,
  email: 'owner@example.com',
  emailVerified: false,
};

/** Every call the fakes saw, in order — the ordering assertions read this. */
const trace: string[] = [];
const queuedHooks: Array<() => Promise<void> | void> = [];
let tenantNameRows: Array<{ name: string }> = [{ name: TENANT_NAME }];

vi.mock('../tenancy/tenant-context', async (importOriginal) => {
  const actual = await importOriginal<typeof TenantContext>();

  /** The one statement the service issues itself: `select name from tenants where id = current`. */
  const chain = {
    select: () => chain,
    from: () => chain,
    where: () => chain,
    limit: async () => {
      trace.push('tenants.select');
      return tenantNameRows;
    },
  };

  return {
    ...actual,
    currentTenantId: () => TENANT,
    tenantDb: () => chain,
    withTenantTransaction: async <T>(
      tenantId: string,
      fn: (db: unknown) => Promise<T>,
      options?: TenantContext.TenantTransactionOptions,
    ): Promise<T> => {
      trace.push(`transaction:${tenantId}`);
      const result = await fn(chain);
      if (options?.afterCommit !== undefined) {
        trace.push('afterCommit queued');
        queuedHooks.push(options.afterCommit);
      }
      return result;
    },
  };
});

function workspaceRow(id: string, name: string, archivedAt: Date | null = null): WorkspaceRow {
  return { id, tenantId: TENANT, name, archivedAt, createdAt: CREATED_AT, updatedAt: CREATED_AT };
}

function invitationRow(overrides: Partial<InvitationRow> = {}): InvitationRow {
  return {
    id: INVITATION,
    tenantId: TENANT,
    email: 'x@example.com',
    state: 'pending',
    workspaces: [
      { workspaceId: W1, workspaceName: 'Design', workspaceRole: 'member' as WorkspaceRole },
      { workspaceId: W3, workspaceName: 'Ops', workspaceRole: 'viewer' as WorkspaceRole },
    ],
    expiresAt: new Date(CREATED_AT.getTime() + INVITATION_TTL_SECONDS * 1000),
    createdAt: CREATED_AT,
    acceptedAt: null,
    revokedAt: null,
    invitedByUserId: ACTOR.userId,
    inviterEmail: ACTOR.email,
    acceptedByUserId: null,
    ...overrides,
  };
}

class FakeInvitationRepository {
  readonly created: CreateInvitationInput[] = [];
  readonly revoked: string[] = [];
  readonly listed: string[] = [];
  constructor(
    private readonly answers: {
      readonly create?: (input: CreateInvitationInput) => InvitationRow;
      readonly findById?: InvitationRow | null;
      readonly list?: readonly InvitationRow[];
      readonly revoke?: InvitationRow | Error;
      readonly createThrows?: Error;
    } = {},
  ) {}

  async create(input: CreateInvitationInput): Promise<InvitationRow> {
    trace.push('repository.create');
    this.created.push(input);
    if (this.answers.createThrows !== undefined) {
      throw this.answers.createThrows;
    }
    return (this.answers.create ?? ((i) => invitationRow({ email: i.email, expiresAt: i.expiresAt })))(input);
  }

  async listForWorkspace(workspaceId: string): Promise<InvitationRow[]> {
    trace.push('repository.listForWorkspace');
    this.listed.push(workspaceId);
    return [...(this.answers.list ?? [])];
  }

  async findById(id: string): Promise<InvitationRow | null> {
    trace.push(`repository.findById:${id}`);
    return this.answers.findById === undefined ? invitationRow({ id }) : this.answers.findById;
  }

  async revoke(id: string): Promise<InvitationRow> {
    trace.push('repository.revoke');
    this.revoked.push(id);
    const answer = this.answers.revoke ?? invitationRow({ id, state: 'revoked', revokedAt: CREATED_AT });
    if (answer instanceof Error) {
      throw answer;
    }
    return answer;
  }
}

class FakeWorkspaceRepository {
  constructor(private readonly rows: readonly WorkspaceRow[]) {}
  async findById(id: string): Promise<WorkspaceRow | null> {
    trace.push(`workspaces.findById:${id}`);
    return this.rows.find((row) => row.id === id) ?? null;
  }
}

class FakeAuthorizer {
  readonly asserted: Array<{ workspaceId: string; min: string }> = [];
  constructor(private readonly refusals: Readonly<Record<string, Error>> = {}) {}
  async assert(workspaceId: string, min: WorkspaceRole): Promise<void> {
    trace.push(`assert:${workspaceId}`);
    this.asserted.push({ workspaceId, min });
    const refusal = this.refusals[workspaceId];
    if (refusal !== undefined) {
      throw refusal;
    }
  }
  async assertTenant(): Promise<void> {
    throw new Error('the service has no reason to call assertTenant');
  }
}

class FakeSender implements MailSender {
  readonly sent: OutboundMail[] = [];
  async send(message: OutboundMail): Promise<void> {
    trace.push('mail.send');
    this.sent.push(message);
  }
}

interface Harness {
  readonly service: InvitationsService;
  readonly repository: FakeInvitationRepository;
  readonly authorizer: FakeAuthorizer;
  readonly sender: FakeSender;
}

function harness(options: {
  readonly workspaces?: readonly WorkspaceRow[];
  readonly refusals?: Readonly<Record<string, Error>>;
  readonly repository?: FakeInvitationRepository;
} = {}): Harness {
  const repository = options.repository ?? new FakeInvitationRepository();
  const authorizer = new FakeAuthorizer(options.refusals);
  const sender = new FakeSender();
  const workspaces = new FakeWorkspaceRepository(
    options.workspaces ?? [workspaceRow(W1, 'Design'), workspaceRow(W2, 'Sales'), workspaceRow(W3, 'Ops')],
  );
  const service = new InvitationsService(
    repository as unknown as InvitationRepository,
    workspaces as unknown as WorkspaceRepository,
    authorizer as unknown as WorkspaceAuthorizer,
    sender,
  );

  return { service, repository, authorizer, sender };
}

function asActor<T>(work: () => Promise<T>): Promise<T> {
  return runAsActor(ACTOR, work);
}

async function fireQueuedHooks(): Promise<void> {
  for (const hook of queuedHooks.splice(0)) {
    await hook();
  }
}

async function rejectionOf(work: Promise<unknown>): Promise<unknown> {
  try {
    await work;
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to reject, but it resolved');
}

const CREATE_INPUT = {
  email: 'x@example.com',
  workspaces: [
    { workspaceId: W1, workspaceRole: 'member' as const },
    { workspaceId: W3, workspaceRole: 'viewer' as const },
  ],
};

/** The token out of the one place it may be: the mail's URL fragment. */
function tokenInFragment(message: OutboundMail): string {
  expect(message.template).toBe('workspace_invitation');
  const url = new URL((message as Extract<OutboundMail, { template: 'workspace_invitation' }>).data.inviteUrl);
  expect(url.hash.startsWith('#token=')).toBe(true);
  return url.hash.slice('#token='.length);
}

beforeEach(() => {
  vi.stubEnv('WEB_APP_ORIGINS', 'http://localhost:3000');
  tenantNameRows = [{ name: TENANT_NAME }];
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  trace.length = 0;
  queuedHooks.length = 0;
});

describe('create: Form B on every grant, before any read and any write (D-09)', () => {
  it('asserts workspace_admin on each named workspace in the request’s order, then reads the workspaces and the tenant, then creates, then queues the mail', async () => {
    const h = harness();

    const created = await asActor(() => h.service.create(CREATE_INPUT));

    expect(h.authorizer.asserted).toEqual([
      { workspaceId: W1, min: 'workspace_admin' },
      { workspaceId: W3, min: 'workspace_admin' },
    ]);
    expect(trace).toEqual([
      `assert:${W1}`,
      `assert:${W3}`,
      `workspaces.findById:${W1}`,
      `workspaces.findById:${W3}`,
      'tenants.select',
      'repository.create',
      `transaction:${TENANT}`,
      'afterCommit queued',
    ]);
    expect(invitationContract.parse(created)).toEqual(created);
  });

  it.each([
    ['no membership / another tenant’s / never issued', new WorkspaceAccessNotFoundError()],
    ['a membership below workspace_admin', new InsufficientWorkspaceRoleError()],
  ])('the first refusal (%s) propagates as itself: the later grant is not asserted, nothing is read, nothing is created, nothing is queued or sent', async (_label, refusal) => {
    const h = harness({ refusals: { [W1]: refusal } });

    const thrown = await rejectionOf(asActor(() => h.service.create(CREATE_INPUT)));

    expect(thrown).toBe(refusal);
    expect({ trace, created: h.repository.created.length, queued: queuedHooks.length, sent: h.sender.sent.length }).toEqual({
      trace: [`assert:${W1}`],
      created: 0,
      queued: 0,
      sent: 0,
    });
  });

  it('a refusal on the SECOND grant still writes nothing: every grant passes before any read', async () => {
    const h = harness({ refusals: { [W3]: new WorkspaceAccessNotFoundError() } });

    await rejectionOf(asActor(() => h.service.create(CREATE_INPUT)));

    expect({ trace, created: h.repository.created.length }).toEqual({ trace: [`assert:${W1}`, `assert:${W3}`], created: 0 });
  });
});

describe('create: what reaches the repository (GC-K)', () => {
  it('hands the repository a 32-byte digest and never the raw token, expiresAt = now + INVITATION_TTL_SECONDS, and the actor’s userId and email', async () => {
    const h = harness();
    const before = Date.now();

    await asActor(() => h.service.create(CREATE_INPUT));

    const [input] = h.repository.created;
    expect(input).toBeDefined();
    expect({
      email: input?.email,
      workspaces: input?.workspaces,
      invitedByUserId: input?.invitedByUserId,
      inviterEmail: input?.inviterEmail,
      digestIsBuffer: Buffer.isBuffer(input?.digest),
      digestBytes: input?.digest.length,
      keys: Object.keys(input ?? {}).sort(),
    }).toEqual({
      email: 'x@example.com',
      workspaces: CREATE_INPUT.workspaces,
      invitedByUserId: ACTOR.userId,
      inviterEmail: ACTOR.email,
      digestIsBuffer: true,
      digestBytes: 32,
      keys: ['digest', 'email', 'expiresAt', 'invitedByUserId', 'inviterEmail', 'workspaces'],
    });
    const ttlMs = (input?.expiresAt.getTime() ?? 0) - before;
    expect(ttlMs).toBeGreaterThanOrEqual(INVITATION_TTL_SECONDS * 1000 - 50);
    expect(ttlMs).toBeLessThanOrEqual(INVITATION_TTL_SECONDS * 1000 + 5_000);
  });
});

describe('create: the mail leaves after commit, once, and carries the token that digests to what was stored (GC-H, AC-1b-3)', () => {
  it('sends nothing while the body runs; the queued hook sends exactly one workspace_invitation whose fragment token digests to the stored digest', async () => {
    const h = harness();

    const created = await asActor(() => h.service.create(CREATE_INPUT));
    expect({ sentDuringBody: h.sender.sent.length, queued: queuedHooks.length }).toEqual({ sentDuringBody: 0, queued: 1 });

    await fireQueuedHooks();

    expect(h.sender.sent).toHaveLength(1);
    const [message] = h.sender.sent;
    const raw = tokenInFragment(message as OutboundMail);
    const [prefix, secret] = raw.split('.');
    const digest = createHash('sha256').update(secret ?? '', 'utf8').digest();

    expect({
      prefix,
      secretLength: secret?.length,
      digestMatches: h.repository.created[0]?.digest.equals(digest),
      to: message?.to,
      data: message?.template === 'workspace_invitation' ? { ...message.data, inviteUrl: '<checked above>' } : undefined,
    }).toEqual({
      prefix: TENANT,
      secretLength: 43,
      digestMatches: true,
      to: 'x@example.com',
      data: {
        inviteUrl: '<checked above>',
        inviterEmail: ACTOR.email,
        tenantName: TENANT_NAME,
        // The request's order, with the names the workspace rows carry.
        workspaces: [
          { name: 'Design', role: 'member' },
          { name: 'Ops', role: 'viewer' },
        ],
        expiresAt: new Date(created.expiresAt),
      },
    });
    // The response never carries the token — not the field, not the bytes.
    expect(created).not.toHaveProperty('token');
    const bytes = JSON.stringify(created);
    expect(bytes).not.toContain(raw);
    expect(bytes).not.toContain(secret ?? 'never');
  });

  it('a repository that throws leaves nothing queued and nothing sent (AC-1b-5)', async () => {
    const h = harness({ repository: new FakeInvitationRepository({ createThrows: new Error('insert failed') }) });

    const thrown = await rejectionOf(asActor(() => h.service.create(CREATE_INPUT)));

    expect((thrown as Error).message).toBe('insert failed');
    await fireQueuedHooks();
    expect({ queued: queuedHooks.length, sent: h.sender.sent.length, trace: trace.at(-1) }).toEqual({
      queued: 0,
      sent: 0,
      trace: 'repository.create',
    });
  });
});

describe('create: an archived workspace is 400 validation_failed under workspaces (AC-1b-2)', () => {
  it('reports the field once for however many archived grants, after every grant passed Form B, and writes nothing', async () => {
    const h = harness({
      workspaces: [workspaceRow(W1, 'Design', CREATED_AT), workspaceRow(W3, 'Ops', CREATED_AT)],
    });

    const thrown = await rejectionOf(asActor(() => h.service.create(CREATE_INPUT)));

    expect(thrown).toBeInstanceOf(DomainError);
    expect((thrown as DomainError).toEnvelope()).toEqual({
      code: 'validation_failed',
      message: 'The request could not be validated.',
      details: { fieldErrors: { workspaces: [ARCHIVED_WORKSPACE_MESSAGE] } },
    });
    expect({ created: h.repository.created.length, queued: queuedHooks.length, asserted: h.authorizer.asserted.length }).toEqual({
      created: 0,
      queued: 0,
      asserted: 2,
    });
  });

  it('a workspace Form B passed but the repository cannot read is the same 404 as the check gives, never a 500', async () => {
    const h = harness({ workspaces: [workspaceRow(W1, 'Design')] });

    const thrown = await rejectionOf(asActor(() => h.service.create(CREATE_INPUT)));

    expect(thrown).toBeInstanceOf(WorkspaceNotFoundError);
    expect(h.repository.created).toHaveLength(0);
  });
});

describe('toClientInvitation and list (D-11: expired is derived on read)', () => {
  it('maps a row to the contract shape with ISO dates and no tenantId, inviterEmail or digest', () => {
    const client = toClientInvitation(invitationRow(), CREATED_AT);

    expect(invitationContract.parse(client)).toEqual(client);
    expect(Object.keys(client).sort()).toEqual([
      'acceptedAt',
      'acceptedByUserId',
      'createdAt',
      'email',
      'expiresAt',
      'id',
      'invitedByUserId',
      'revokedAt',
      'state',
      'workspaces',
    ]);
    expect(client.state).toBe('pending');
  });

  it('a pending row whose expiresAt is behind now reads as expired; accepted and revoked rows keep their state whatever the clock says', () => {
    const late = new Date(CREATED_AT.getTime() + INVITATION_TTL_SECONDS * 1000 + 1);

    expect([
      toClientInvitation(invitationRow(), late).state,
      toClientInvitation(invitationRow({ state: 'accepted', acceptedAt: CREATED_AT }), late).state,
      toClientInvitation(invitationRow({ state: 'revoked', revokedAt: CREATED_AT }), late).state,
      toClientInvitation(invitationRow(), CREATED_AT).state,
    ]).toEqual(['expired', 'accepted', 'revoked', 'pending']);
  });

  it('list passes the workspaceId through and answers { items } in the repository’s order', async () => {
    const rows = [invitationRow({ id: 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1' }), invitationRow({ id: 'cccccccc-cccc-4ccc-8ccc-ccccccccccc2' })];
    const h = harness({ repository: new FakeInvitationRepository({ list: rows }) });

    const listed = await asActor(() => h.service.list({ workspaceId: W1 }));

    expect(invitationListResponseContract.parse(listed)).toEqual(listed);
    expect({ listedFor: h.repository.listed, ids: listed.items.map((item) => item.id) }).toEqual({
      listedFor: [W1],
      ids: rows.map((row) => row.id),
    });
  });
});

describe('revoke: load, then Form B on every named workspace, then revoke (D-09)', () => {
  it('a null findById is InvitationNotFoundError before any assert', async () => {
    const h = harness({ repository: new FakeInvitationRepository({ findById: null }) });

    const thrown = await rejectionOf(asActor(() => h.service.revoke(INVITATION)));

    expect(thrown).toBeInstanceOf(InvitationNotFoundError);
    expect({ asserted: h.authorizer.asserted, revoked: h.repository.revoked }).toEqual({ asserted: [], revoked: [] });
  });

  it('asserts workspace_admin on every workspace the invitation names, then revokes and answers the revoked row', async () => {
    const h = harness();

    const revoked = await asActor(() => h.service.revoke(INVITATION));

    expect(trace).toEqual([`repository.findById:${INVITATION}`, `assert:${W1}`, `assert:${W3}`, 'repository.revoke']);
    expect(revoked.state).toBe('revoked');
    expect(invitationContract.parse(revoked)).toEqual(revoked);
  });

  it('a refusal on any named workspace stops the revoke: workspace_admin of W1 only is the 404 the authorizer gives', async () => {
    const h = harness({ refusals: { [W3]: new WorkspaceAccessNotFoundError() } });

    const thrown = await rejectionOf(asActor(() => h.service.revoke(INVITATION)));

    expect(thrown).toBeInstanceOf(WorkspaceAccessNotFoundError);
    expect(h.repository.revoked).toEqual([]);
  });

  it('the repository’s 409 for an accepted invitation propagates as itself', async () => {
    const h = harness({ repository: new FakeInvitationRepository({ revoke: new InvitationAlreadyAcceptedError() }) });

    expect(await rejectionOf(asActor(() => h.service.revoke(INVITATION)))).toBeInstanceOf(InvitationAlreadyAcceptedError);
  });
});

describe('lookup: the public preview (AC-1b-28)', () => {
  it('null from the entry function is InvitationNotFoundError', async () => {
    vi.mocked(capabilityLookup.findInvitationByCapabilityToken).mockResolvedValue(null);
    const h = harness();

    expect(await rejectionOf(h.service.lookup('garbage'))).toBeInstanceOf(InvitationNotFoundError);
    expect(capabilityLookup.findInvitationByCapabilityToken).toHaveBeenCalledWith('garbage');
  });

  it('a verified invitation is projected onto invitationPreviewContract: no id, no tenantId, no invitedByUserId, no token', async () => {
    vi.mocked(capabilityLookup.findInvitationByCapabilityToken).mockResolvedValue({
      id: INVITATION,
      tenantId: TENANT,
      email: 'x@example.com',
      state: 'pending',
      expiresAt: CREATED_AT,
      workspaces: [{ workspaceId: W1, workspaceName: 'Design', workspaceRole: 'member' as WorkspaceRole }],
      invitedByUserId: ACTOR.userId,
      inviterEmail: ACTOR.email,
      tenantName: TENANT_NAME,
    });
    const h = harness();

    const preview = await h.service.lookup('a-token');

    expect(invitationPreviewContract.parse(preview)).toEqual(preview);
    expect(preview).toEqual({
      email: 'x@example.com',
      tenantName: TENANT_NAME,
      inviterEmail: ACTOR.email,
      workspaces: [{ workspaceName: 'Design', workspaceRole: 'member' }],
      expiresAt: CREATED_AT.toISOString(),
    });
  });

  it('the state errors propagate as themselves', async () => {
    vi.mocked(capabilityLookup.findInvitationByCapabilityToken).mockRejectedValue(new InvitationTenantConflictError());
    const h = harness();

    expect(await rejectionOf(h.service.lookup('a-token'))).toBeInstanceOf(InvitationTenantConflictError);
  });
});

describe('accept: the signed-in accept (D-04)', () => {
  it("passes the actor's userId with tenantMembership 'require' and projects the named workspaces", async () => {
    vi.mocked(capabilityLookup.acceptInvitationByCapabilityToken).mockResolvedValue({
      tenantId: TENANT,
      workspaces: [{ workspaceId: W1, workspaceRole: 'member' as WorkspaceRole }],
    });
    const h = harness();

    const accepted = await asActor(() => h.service.accept('a-token'));

    expect(capabilityLookup.acceptInvitationByCapabilityToken).toHaveBeenCalledWith('a-token', {
      userId: ACTOR.userId,
      tenantMembership: 'require',
    });
    expect(acceptInvitationResponseContract.parse(accepted)).toEqual(accepted);
    expect(accepted).toEqual({ workspaces: [{ workspaceId: W1, workspaceRole: 'member' }] });
  });

  it('the entry function’s errors propagate as themselves', async () => {
    vi.mocked(capabilityLookup.acceptInvitationByCapabilityToken).mockRejectedValue(new InvitationNotFoundError());
    const h = harness();

    expect(await rejectionOf(asActor(() => h.service.accept('a-token')))).toBeInstanceOf(InvitationNotFoundError);
  });
});
