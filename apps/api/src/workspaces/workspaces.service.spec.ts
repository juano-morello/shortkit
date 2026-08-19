/**
 * TASK-012 — WorkspacesService, the parts decidable without a database.
 *
 * Contract: docs/contracts/workspaces.md ("Endpoints"), error-envelope.md.
 *
 * The repository is a fake that records what it was asked and answers a row; the database,
 * the policy and the tenant transaction are `test/workspaces/workspaces.int-spec.ts`'s.
 * Three things are decidable here:
 *
 *   1. the mapping from a repository row to the client shape — `Date` to ISO string, null
 *      `archivedAt` kept null, and NO `tenantId` on the way out;
 *   2. what each operation asks the repository, and that `list` passes `includeArchived`
 *      through and defaults it to false;
 *   3. that a `WorkspaceNotFoundError` from the repository propagates AS ITSELF, unwrapped:
 *      the filter does not walk `cause`, so a wrapper would turn the 404 into a 500.
 */
import { workspaceContract } from '@shortkit/contracts';
import { describe, expect, it } from 'vitest';

import { WorkspaceNotFoundError } from './workspace-not-found.error';
import type { Workspace as WorkspaceRow, WorkspaceRepository } from './workspace.repository';
import { WorkspacesService } from './workspaces.service';

const TENANT = '11111111-1111-4111-8111-111111111111';
const WORKSPACE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
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

type Call =
  | { readonly method: 'create'; readonly input: { name: string } }
  | { readonly method: 'list'; readonly options: { includeArchived: boolean } }
  | { readonly method: 'rename'; readonly id: string; readonly name: string }
  | { readonly method: 'archive'; readonly id: string };

/** Records every call; answers with the rows it was given, or throws what it was told to. */
class FakeRepository {
  readonly calls: Call[] = [];

  constructor(
    private readonly answers: {
      readonly create?: WorkspaceRow;
      readonly list?: readonly WorkspaceRow[];
      readonly rename?: WorkspaceRow | Error;
      readonly archive?: WorkspaceRow | Error;
    } = {},
  ) {}

  async create(input: { name: string }): Promise<WorkspaceRow> {
    this.calls.push({ method: 'create', input });
    return this.answers.create ?? row({ name: input.name });
  }

  async list(options: { includeArchived: boolean }): Promise<WorkspaceRow[]> {
    this.calls.push({ method: 'list', options });
    return [...(this.answers.list ?? [])];
  }

  async findById(): Promise<WorkspaceRow | null> {
    throw new Error('the service has no reason to call findById');
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

function serviceOver(fake: FakeRepository): WorkspacesService {
  return new WorkspacesService(fake as unknown as WorkspaceRepository);
}

describe('WorkspacesService.create', () => {
  it('asks the repository for exactly the name, and returns the row in the client shape', async () => {
    const fake = new FakeRepository();

    const created = await serviceOver(fake).create({ name: 'Acme' });

    expect(fake.calls).toEqual([{ method: 'create', input: { name: 'Acme' } }]);
    expect(created).toEqual({
      id: WORKSPACE,
      name: 'Acme',
      archivedAt: null,
      createdAt: '2026-08-17T09:00:00.000Z',
      updatedAt: '2026-08-17T09:05:00.000Z',
    });
  });

  it('never returns tenantId', async () => {
    const created = await serviceOver(new FakeRepository()).create({ name: 'Acme' });

    expect(Object.keys(created).sort()).toEqual(['archivedAt', 'createdAt', 'id', 'name', 'updatedAt']);
    expect('tenantId' in created).toBe(false);
  });

  it('what it returns validates against workspaceContract', async () => {
    const created = await serviceOver(new FakeRepository()).create({ name: 'Acme' });

    expect(workspaceContract.safeParse(created).success).toBe(true);
  });
});

describe('WorkspacesService.list', () => {
  it('passes includeArchived: true through', async () => {
    const fake = new FakeRepository();

    await serviceOver(fake).list({ includeArchived: true });

    expect(fake.calls).toEqual([{ method: 'list', options: { includeArchived: true } }]);
  });

  it('passes includeArchived: false through', async () => {
    const fake = new FakeRepository();

    await serviceOver(fake).list({ includeArchived: false });

    expect(fake.calls).toEqual([{ method: 'list', options: { includeArchived: false } }]);
  });

  it('defaults includeArchived to false when the query left it out', async () => {
    const fake = new FakeRepository();

    await serviceOver(fake).list({});

    expect(fake.calls).toEqual([{ method: 'list', options: { includeArchived: false } }]);
  });

  it('answers { items } in repository order, each row mapped, archived rows carrying their ISO archivedAt', async () => {
    const first = row({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', name: 'First' });
    const second = row({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2', name: 'Second', archivedAt: ARCHIVED_AT });
    const fake = new FakeRepository({ list: [first, second] });

    const listed = await serviceOver(fake).list({ includeArchived: true });

    expect(listed).toEqual({
      items: [
        {
          id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
          name: 'First',
          archivedAt: null,
          createdAt: '2026-08-17T09:00:00.000Z',
          updatedAt: '2026-08-17T09:05:00.000Z',
        },
        {
          id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2',
          name: 'Second',
          archivedAt: '2026-08-17T10:00:00.000Z',
          createdAt: '2026-08-17T09:00:00.000Z',
          updatedAt: '2026-08-17T09:05:00.000Z',
        },
      ],
    });
    // The list carries `items` and nothing else: no cursor, no `hasMore`, no tenant id.
    expect(Object.keys(listed)).toEqual(['items']);
  });

  it('an empty tenant lists as { items: [] }', async () => {
    await expect(serviceOver(new FakeRepository()).list({})).resolves.toEqual({ items: [] });
  });
});

describe('WorkspacesService.rename', () => {
  it('asks the repository to rename that id to that name, and returns the mapped row', async () => {
    const fake = new FakeRepository();

    const renamed = await serviceOver(fake).rename(WORKSPACE, { name: 'Acme Group' });

    expect(fake.calls).toEqual([{ method: 'rename', id: WORKSPACE, name: 'Acme Group' }]);
    expect(renamed).toMatchObject({ id: WORKSPACE, name: 'Acme Group' });
    expect('tenantId' in renamed).toBe(false);
  });

  it("propagates the repository's WorkspaceNotFoundError as itself, unwrapped", async () => {
    const notFound = new WorkspaceNotFoundError();
    const fake = new FakeRepository({ rename: notFound });

    await expect(serviceOver(fake).rename(WORKSPACE, { name: 'Acme Group' })).rejects.toBe(notFound);
  });
});

describe('WorkspacesService.archive', () => {
  it('asks the repository to archive that id, and returns the mapped row with archivedAt set', async () => {
    const fake = new FakeRepository();

    const archived = await serviceOver(fake).archive(WORKSPACE);

    expect(fake.calls).toEqual([{ method: 'archive', id: WORKSPACE }]);
    expect(archived).toMatchObject({ id: WORKSPACE, archivedAt: '2026-08-17T10:00:00.000Z' });
    expect('tenantId' in archived).toBe(false);
  });

  it("propagates the repository's WorkspaceNotFoundError as itself, unwrapped", async () => {
    const notFound = new WorkspaceNotFoundError();
    const fake = new FakeRepository({ archive: notFound });

    await expect(serviceOver(fake).archive(WORKSPACE)).rejects.toBe(notFound);
  });
});
