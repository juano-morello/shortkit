/**
 * TASK-012 — WorkspacesService, the parts decidable without a database.
 * TASK-1b-06 — the creator's membership in one call, the list filtered by the caller, the
 * role on the wire, and the fail-closed `roleOf`.
 *
 * Contract: docs/contracts/workspaces.md ("Endpoints"), error-envelope.md,
 * workspace-authorization.md ("Minimum role per surface").
 *
 * Both repositories are fakes that record what they were asked and answer a row; the
 * database, the policy, the tenant transaction and the interceptor's rank check are
 * `test/workspaces/workspaces.int-spec.ts`'s. Decidable here:
 *
 *   1. the mapping from a repository row to the client shape — `Date` to ISO string, null
 *      `archivedAt` kept null, NO `tenantId` on the way out, and `workspaceRole` carried;
 *   2. `create` writes the workspace and then the creator's `workspace_admin` membership,
 *      naming the created id and the actor's user (D-10), and answers `workspace_admin`;
 *   3. `list` asks `listForUser` for the ACTOR's user, passes `includeArchived` through
 *      (defaulting it to false), and reports each row's joined role;
 *   4. `get`/`rename`/`archive` report `RequestContext.workspaceRole` and, with none on the
 *      context, throw a plain Error rather than answer — the route is missing its decorator;
 *   5. a `WorkspaceNotFoundError` from the repository propagates AS ITSELF, unwrapped: the
 *      filter does not walk `cause`, so a wrapper would turn the 404 into a 500.
 */
import { WORKSPACE_ROLE, workspaceContract } from '@shortkit/contracts';
import type { WorkspaceMembership, WorkspaceRole } from '@shortkit/contracts';
import { describe, expect, it } from 'vitest';

import type { CreateMembershipInput, MembershipRepository } from '../memberships/membership.repository';
import type { RequestContext } from '../tenancy/tenant-context';
import { WorkspaceNotFoundError } from './workspace-not-found.error';
import type { Workspace as WorkspaceRow, WorkspaceRepository, WorkspaceWithRole } from './workspace.repository';
import { WorkspacesService } from './workspaces.service';

const TENANT = '11111111-1111-4111-8111-111111111111';
const WORKSPACE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER = 'user_creator';
const CREATED_AT = new Date('2026-08-17T09:00:00.000Z');
const UPDATED_AT = new Date('2026-08-17T09:05:00.000Z');
const ARCHIVED_AT = new Date('2026-08-17T10:00:00.000Z');

function row(overrides: Partial<WorkspaceRow> = {}): WorkspaceRow {
  return {
    id: WORKSPACE,
    tenantId: TENANT,
    name: 'Acme',
    archivedAt: null,
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
    ...overrides,
  };
}

/** The `RequestContext` the guard writes, with the role the interceptor sets when asked. */
function actor(workspaceRole?: WorkspaceRole): RequestContext {
  return {
    userId: USER,
    tenantId: TENANT,
    email: 'creator@example.test',
    emailVerified: true,
    ...(workspaceRole === undefined ? {} : { workspaceRole, workspaceId: WORKSPACE }),
  };
}

type Call =
  | { readonly method: 'create'; readonly input: { name: string } }
  | { readonly method: 'listForUser'; readonly userId: string; readonly options: { includeArchived: boolean } }
  | { readonly method: 'findById'; readonly id: string }
  | { readonly method: 'rename'; readonly id: string; readonly name: string }
  | { readonly method: 'archive'; readonly id: string }
  | { readonly method: 'memberships.create'; readonly input: CreateMembershipInput };

/** Records every call; answers with the rows it was given, or throws what it was told to. */
class FakeRepository {
  readonly calls: Call[] = [];

  constructor(
    private readonly answers: {
      readonly create?: WorkspaceRow;
      readonly listForUser?: readonly WorkspaceWithRole[];
      readonly findById?: WorkspaceRow | null;
      readonly rename?: WorkspaceRow | Error;
      readonly archive?: WorkspaceRow | Error;
    } = {},
  ) {}

  async create(input: { name: string }): Promise<WorkspaceRow> {
    this.calls.push({ method: 'create', input });
    return this.answers.create ?? row({ name: input.name });
  }

  async list(): Promise<WorkspaceRow[]> {
    throw new Error('the service no longer calls the unfiltered list (D-10)');
  }

  async listForUser(userId: string, options: { includeArchived: boolean }): Promise<WorkspaceWithRole[]> {
    this.calls.push({ method: 'listForUser', userId, options });
    return [...(this.answers.listForUser ?? [])];
  }

  async findById(id: string): Promise<WorkspaceRow | null> {
    this.calls.push({ method: 'findById', id });
    return this.answers.findById === undefined ? row({ id }) : this.answers.findById;
  }

  async rename(id: string, name: string): Promise<WorkspaceRow> {
    this.calls.push({ method: 'rename', id, name });
    return this.answerOrThrow(this.answers.rename ?? row({ id, name }));
  }

  async archive(id: string): Promise<WorkspaceRow> {
    this.calls.push({ method: 'archive', id });
    return this.answerOrThrow(this.answers.archive ?? row({ id, archivedAt: ARCHIVED_AT }));
  }

  private answerOrThrow(answer: WorkspaceRow | Error): WorkspaceRow {
    if (answer instanceof Error) {
      throw answer;
    }

    return answer;
  }
}

/** Records the one call the service makes of it, into the same log as the workspace fake. */
class FakeMembershipRepository {
  constructor(
    private readonly calls: Call[],
    private readonly failWith?: Error,
  ) {}

  async create(input: CreateMembershipInput): Promise<WorkspaceMembership> {
    this.calls.push({ method: 'memberships.create', input });

    if (this.failWith !== undefined) {
      throw this.failWith;
    }

    return {
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      tenantId: TENANT,
      workspaceId: input.workspaceId,
      userId: input.userId,
      role: input.role,
      createdAt: CREATED_AT.toISOString(),
    };
  }
}

function serviceOver(fake: FakeRepository, membershipFailure?: Error): WorkspacesService {
  return new WorkspacesService(
    fake as unknown as WorkspaceRepository,
    new FakeMembershipRepository(fake.calls, membershipFailure) as unknown as MembershipRepository,
  );
}

const CLIENT_KEYS = ['archivedAt', 'createdAt', 'id', 'name', 'updatedAt', 'workspaceRole'];

describe('WorkspacesService.create', () => {
  it('AC-1b-17: creates the workspace, then the creator’s workspace_admin membership naming the created id and the actor’s user, in that order', async () => {
    const fake = new FakeRepository();

    const created = await serviceOver(fake).create(actor(), { name: 'Acme' });

    expect(fake.calls).toEqual([
      { method: 'create', input: { name: 'Acme' } },
      {
        method: 'memberships.create',
        input: { workspaceId: WORKSPACE, userId: USER, role: WORKSPACE_ROLE.workspace_admin },
      },
    ]);
    expect(created).toEqual({
      id: WORKSPACE,
      name: 'Acme',
      archivedAt: null,
      createdAt: '2026-08-17T09:00:00.000Z',
      updatedAt: '2026-08-17T09:05:00.000Z',
      workspaceRole: 'workspace_admin',
    });
  });

  it('a membership insert that throws propagates as itself: the ambient transaction rolls the workspace back with it', async () => {
    const failure = new Error('23505 or whatever the driver said');
    const fake = new FakeRepository();

    await expect(serviceOver(fake, failure).create(actor(), { name: 'Acme' })).rejects.toBe(failure);
    // The workspace insert was issued before the membership failed — the rollback is the
    // interceptor's, not a compensating action here.
    expect(fake.calls.map((call) => call.method)).toEqual(['create', 'memberships.create']);
  });

  it('never returns tenantId', async () => {
    const created = await serviceOver(new FakeRepository()).create(actor(), { name: 'Acme' });

    expect(Object.keys(created).sort()).toEqual(CLIENT_KEYS);
    expect('tenantId' in created).toBe(false);
  });

  it('what it returns validates against workspaceContract', async () => {
    const created = await serviceOver(new FakeRepository()).create(actor(), { name: 'Acme' });

    expect(workspaceContract.safeParse(created).success).toBe(true);
  });
});

describe('WorkspacesService.list', () => {
  it('asks listForUser for the ACTOR’s user (never a body field) and passes includeArchived: true through', async () => {
    const fake = new FakeRepository();

    await serviceOver(fake).list(actor(), { includeArchived: true });

    expect(fake.calls).toEqual([{ method: 'listForUser', userId: USER, options: { includeArchived: true } }]);
  });

  it('passes includeArchived: false through', async () => {
    const fake = new FakeRepository();

    await serviceOver(fake).list(actor(), { includeArchived: false });

    expect(fake.calls).toEqual([{ method: 'listForUser', userId: USER, options: { includeArchived: false } }]);
  });

  it('defaults includeArchived to false when the query left it out', async () => {
    const fake = new FakeRepository();

    await serviceOver(fake).list(actor(), {});

    expect(fake.calls).toEqual([{ method: 'listForUser', userId: USER, options: { includeArchived: false } }]);
  });

  it('AC-1b-18: answers { items } in repository order, each row mapped with ITS joined role, archived rows carrying their ISO archivedAt', async () => {
    const first: WorkspaceWithRole = { ...row({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', name: 'First' }), role: WORKSPACE_ROLE.member };
    const second: WorkspaceWithRole = {
      ...row({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2', name: 'Second', archivedAt: ARCHIVED_AT }),
      role: WORKSPACE_ROLE.viewer,
    };
    const fake = new FakeRepository({ listForUser: [first, second] });

    const listed = await serviceOver(fake).list(actor(), { includeArchived: true });

    expect(listed).toEqual({
      items: [
        {
          id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
          name: 'First',
          archivedAt: null,
          createdAt: '2026-08-17T09:00:00.000Z',
          updatedAt: '2026-08-17T09:05:00.000Z',
          workspaceRole: 'member',
        },
        {
          id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2',
          name: 'Second',
          archivedAt: '2026-08-17T10:00:00.000Z',
          createdAt: '2026-08-17T09:00:00.000Z',
          updatedAt: '2026-08-17T09:05:00.000Z',
          workspaceRole: 'viewer',
        },
      ],
    });
    // The list carries `items` and nothing else: no cursor, no `hasMore`, no tenant id.
    expect(Object.keys(listed)).toEqual(['items']);
  });

  it('a caller with no memberships lists as { items: [] }', async () => {
    await expect(serviceOver(new FakeRepository()).list(actor(), {})).resolves.toEqual({ items: [] });
  });
});

describe('WorkspacesService.get', () => {
  it('asks findById for that id and returns the mapped row with the role the interceptor put on the context', async () => {
    const fake = new FakeRepository();

    const got = await serviceOver(fake).get(actor(WORKSPACE_ROLE.viewer), WORKSPACE);

    expect(fake.calls).toEqual([{ method: 'findById', id: WORKSPACE }]);
    expect(got).toMatchObject({ id: WORKSPACE, name: 'Acme', workspaceRole: 'viewer' });
    expect(Object.keys(got).sort()).toEqual(CLIENT_KEYS);
  });

  it('a null from the repository is WorkspaceNotFoundError — the same 404 the interceptor gives a non-member', async () => {
    const fake = new FakeRepository({ findById: null });

    await expect(serviceOver(fake).get(actor(WORKSPACE_ROLE.viewer), WORKSPACE)).rejects.toBeInstanceOf(WorkspaceNotFoundError);
  });

  it('with no workspaceRole on the context it throws a plain Error before any read: the route is missing @RequireWorkspaceRole', async () => {
    const fake = new FakeRepository();

    await expect(serviceOver(fake).get(actor(), WORKSPACE)).rejects.toThrow(/RequireWorkspaceRole/);
    expect(fake.calls).toEqual([]);
  });
});

describe('WorkspacesService.rename', () => {
  it('asks the repository to rename that id to that name, and returns the mapped row with the context’s role', async () => {
    const fake = new FakeRepository();

    const renamed = await serviceOver(fake).rename(actor(WORKSPACE_ROLE.workspace_admin), WORKSPACE, { name: 'Acme Group' });

    expect(fake.calls).toEqual([{ method: 'rename', id: WORKSPACE, name: 'Acme Group' }]);
    expect(renamed).toMatchObject({ id: WORKSPACE, name: 'Acme Group', workspaceRole: 'workspace_admin' });
    expect('tenantId' in renamed).toBe(false);
  });

  it("propagates the repository's WorkspaceNotFoundError as itself, unwrapped", async () => {
    const notFound = new WorkspaceNotFoundError();
    const fake = new FakeRepository({ rename: notFound });

    await expect(serviceOver(fake).rename(actor(WORKSPACE_ROLE.workspace_admin), WORKSPACE, { name: 'Acme Group' })).rejects.toBe(notFound);
  });

  it('with no workspaceRole on the context it throws before writing', async () => {
    const fake = new FakeRepository();

    await expect(serviceOver(fake).rename(actor(), WORKSPACE, { name: 'Acme Group' })).rejects.toThrow(/RequireWorkspaceRole/);
    expect(fake.calls).toEqual([]);
  });
});

describe('WorkspacesService.archive', () => {
  it('asks the repository to archive that id, and returns the mapped row with archivedAt set and the context’s role', async () => {
    const fake = new FakeRepository();

    const archived = await serviceOver(fake).archive(actor(WORKSPACE_ROLE.workspace_admin), WORKSPACE);

    expect(fake.calls).toEqual([{ method: 'archive', id: WORKSPACE }]);
    expect(archived).toMatchObject({ id: WORKSPACE, archivedAt: '2026-08-17T10:00:00.000Z', workspaceRole: 'workspace_admin' });
    expect('tenantId' in archived).toBe(false);
  });

  it("propagates the repository's WorkspaceNotFoundError as itself, unwrapped", async () => {
    const notFound = new WorkspaceNotFoundError();
    const fake = new FakeRepository({ archive: notFound });

    await expect(serviceOver(fake).archive(actor(WORKSPACE_ROLE.workspace_admin), WORKSPACE)).rejects.toBe(notFound);
  });

  it('with no workspaceRole on the context it throws before writing', async () => {
    const fake = new FakeRepository();

    await expect(serviceOver(fake).archive(actor(), WORKSPACE)).rejects.toThrow(/RequireWorkspaceRole/);
    expect(fake.calls).toEqual([]);
  });
});
