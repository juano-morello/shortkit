/**
 * STORY-004 — AC-21 to AC-24, the contract half. TASK-012.
 * STORY-1b-04 — AC-1b-17/18, the `workspaceRole` field. TASK-1b-06.
 *
 * Contract: docs/contracts/workspaces.md ("Endpoints"), error-envelope.md
 * ADR: adr-0005-contract-distribution.md, adr-0025-zod-error-recognition-in-contracts.md
 *
 * AC-24 is stated over `toValidationDetails` keying an issue under `name`, so the bounds
 * are asserted through the parse and the flatten together, the way `auth.spec.ts` asserts
 * the password bounds: literal 0/1/100/101-character names pin the numbers, and the
 * constant-derived lengths pin that the contract is built from the exported values.
 *
 * The client shape is asserted against what a JSON round trip of the repository row looks
 * like: `Date` becomes an ISO string, `archivedAt` may be null, and there is no `tenantId`.
 */
import { describe, expect, it } from 'vitest';

import { isZodError, toValidationDetails } from '../errors';

import { WORKSPACE_ROLES } from '../roles';

import {
  WORKSPACE_NAME_MAX_LENGTH,
  WORKSPACE_NAME_MIN_LENGTH,
  createWorkspaceRequestContract,
  listWorkspacesQueryContract,
  renameWorkspaceRequestContract,
  workspaceContract,
  workspaceListResponseContract,
  workspaceNameContract,
} from './index';

const WIRE_WORKSPACE = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  name: 'Acme',
  archivedAt: null,
  createdAt: '2026-08-17T09:00:00.000Z',
  updatedAt: '2026-08-17T09:00:00.000Z',
} as const;

function nameOfLength(length: number): string {
  return 'a'.repeat(length);
}

/** The `name` messages a failed parse of `{ name }` flattens to; `[]` when the parse passed. */
function nameIssues(contract: typeof createWorkspaceRequestContract, name: unknown): string[] {
  const outcome = contract.safeParse({ name });

  if (outcome.success) {
    return [];
  }

  expect(isZodError(outcome.error)).toBe(true);

  return toValidationDetails(outcome.error).fieldErrors.name ?? [];
}

describe('workspaceNameContract', () => {
  it('trims before checking the bounds, and returns the trimmed value', () => {
    expect(workspaceNameContract.parse('  Acme  ')).toBe('Acme');
  });

  it('AC-24: an empty name is refused', () => {
    expect(workspaceNameContract.safeParse('').success).toBe(false);
  });

  it('AC-24: a whitespace-only name is refused, because it is empty once trimmed', () => {
    expect(workspaceNameContract.safeParse('   ').success).toBe(false);
  });

  it('a one-character name is accepted', () => {
    expect(workspaceNameContract.safeParse('a').success).toBe(true);
  });

  it('a hundred-character name is accepted', () => {
    expect(workspaceNameContract.safeParse(nameOfLength(100)).success).toBe(true);
  });

  it('AC-24: a hundred-and-one-character name is refused', () => {
    expect(workspaceNameContract.safeParse(nameOfLength(101)).success).toBe(false);
  });

  it('a hundred characters wrapped in whitespace is accepted: the trim runs before the length check', () => {
    expect(workspaceNameContract.safeParse(`  ${nameOfLength(100)}  `).success).toBe(true);
  });

  it('is built from the exported bounds', () => {
    expect(workspaceNameContract.safeParse(nameOfLength(WORKSPACE_NAME_MIN_LENGTH)).success).toBe(true);
    expect(workspaceNameContract.safeParse(nameOfLength(WORKSPACE_NAME_MIN_LENGTH - 1)).success).toBe(false);
    expect(workspaceNameContract.safeParse(nameOfLength(WORKSPACE_NAME_MAX_LENGTH)).success).toBe(true);
    expect(workspaceNameContract.safeParse(nameOfLength(WORKSPACE_NAME_MAX_LENGTH + 1)).success).toBe(false);
  });
});

describe('createWorkspaceRequestContract', () => {
  it('AC-21: `{ name: "Acme" }` parses to itself', () => {
    expect(createWorkspaceRequestContract.parse({ name: 'Acme' })).toEqual({ name: 'Acme' });
  });

  it('AC-24: an empty name fails the parse and keys at least one issue under name', () => {
    expect(nameIssues(createWorkspaceRequestContract, '').length).toBeGreaterThan(0);
  });

  it('AC-24: a 101-character name fails the parse and keys at least one issue under name', () => {
    expect(nameIssues(createWorkspaceRequestContract, nameOfLength(101)).length).toBeGreaterThan(0);
  });

  it('AC-24: a missing name keys an issue under name', () => {
    const outcome = createWorkspaceRequestContract.safeParse({});

    expect(outcome.success).toBe(false);

    if (!outcome.success) {
      expect(toValidationDetails(outcome.error).fieldErrors.name?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it('AC-24: a non-string name keys an issue under name', () => {
    expect(nameIssues(createWorkspaceRequestContract, 42).length).toBeGreaterThan(0);
  });

  it('a body that is not an object fails the parse', () => {
    expect(createWorkspaceRequestContract.safeParse('Acme').success).toBe(false);
    expect(createWorkspaceRequestContract.safeParse(null).success).toBe(false);
  });

  it('strips keys the contract does not declare', () => {
    expect(createWorkspaceRequestContract.parse({ name: 'Acme', tenantId: 'x' })).toEqual({ name: 'Acme' });
  });
});

describe('renameWorkspaceRequestContract', () => {
  it('AC-22: `{ name: "Acme Group" }` parses to itself', () => {
    expect(renameWorkspaceRequestContract.parse({ name: 'Acme Group' })).toEqual({ name: 'Acme Group' });
  });

  it('AC-24: applies the same name rule as create', () => {
    expect(nameIssues(renameWorkspaceRequestContract, '').length).toBeGreaterThan(0);
    expect(nameIssues(renameWorkspaceRequestContract, nameOfLength(101)).length).toBeGreaterThan(0);
  });
});

describe('listWorkspacesQueryContract', () => {
  it('an empty query parses, with includeArchived left undefined for the caller to default', () => {
    expect(listWorkspacesQueryContract.parse({})).toEqual({});
  });

  it("the query-string form 'true' parses to the boolean true", () => {
    expect(listWorkspacesQueryContract.parse({ includeArchived: 'true' })).toEqual({ includeArchived: true });
  });

  it("the query-string form 'false' parses to the boolean false", () => {
    expect(listWorkspacesQueryContract.parse({ includeArchived: 'false' })).toEqual({ includeArchived: false });
  });

  it('a boolean is accepted as it is', () => {
    expect(listWorkspacesQueryContract.parse({ includeArchived: true })).toEqual({ includeArchived: true });
    expect(listWorkspacesQueryContract.parse({ includeArchived: false })).toEqual({ includeArchived: false });
  });

  it.each(['maybe', '1', '0', 'TRUE', 'yes', '', ['true', 'true']])(
    '%j is refused, keyed under includeArchived',
    (value) => {
      const outcome = listWorkspacesQueryContract.safeParse({ includeArchived: value });

      expect(outcome.success).toBe(false);

      if (!outcome.success) {
        expect(toValidationDetails(outcome.error).fieldErrors.includeArchived?.length ?? 0).toBeGreaterThan(0);
      }
    },
  );
});

describe('workspaceContract', () => {
  it('AC-21: the five client fields survive a parse', () => {
    expect(workspaceContract.parse({ ...WIRE_WORKSPACE })).toEqual(WIRE_WORKSPACE);
  });

  it('AC-23: archivedAt is an ISO datetime when the workspace is archived', () => {
    const archived = { ...WIRE_WORKSPACE, archivedAt: '2026-08-17T10:00:00.000Z' };

    expect(workspaceContract.parse(archived)).toEqual(archived);
  });

  it('accepts what Date.prototype.toISOString produces', () => {
    const now = new Date();

    expect(
      workspaceContract.safeParse({
        ...WIRE_WORKSPACE,
        archivedAt: now.toISOString(),
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      }).success,
    ).toBe(true);
  });

  it('carries no tenantId: the caller is inside their tenant, and the id is not returned', () => {
    // A `tenantId` on the input is stripped rather than kept, and the parsed shape has no
    // such key — the endpoints map the repository row through an explicit field list and
    // this is the client-side statement of the same rule.
    const parsed = workspaceContract.parse({ ...WIRE_WORKSPACE, tenantId: '11111111-1111-4111-8111-111111111111' });

    expect(Object.keys(parsed).sort()).toEqual(['archivedAt', 'createdAt', 'id', 'name', 'updatedAt']);
  });

  it('refuses a non-uuid id, a missing archivedAt and a non-datetime createdAt', () => {
    expect(workspaceContract.safeParse({ ...WIRE_WORKSPACE, id: 'not-a-uuid' }).success).toBe(false);
    expect(workspaceContract.safeParse({ ...WIRE_WORKSPACE, archivedAt: undefined }).success).toBe(false);
    expect(workspaceContract.safeParse({ ...WIRE_WORKSPACE, createdAt: 'yesterday' }).success).toBe(false);
  });

  describe('workspaceRole (TASK-1b-06)', () => {
    it.each(WORKSPACE_ROLES)('AC-1b-17/18: %s parses and is kept, unbranded, under `workspaceRole`', (role) => {
      const parsed = workspaceContract.parse({ ...WIRE_WORKSPACE, workspaceRole: role });

      expect(parsed.workspaceRole).toBe(role);
      expect(Object.keys(parsed).sort()).toEqual(['archivedAt', 'createdAt', 'id', 'name', 'updatedAt', 'workspaceRole']);
    });

    it('is a workspace role and never a tenant role: `owner` and `admin` are refused', () => {
      expect(workspaceContract.safeParse({ ...WIRE_WORKSPACE, workspaceRole: 'owner' }).success).toBe(false);
      expect(workspaceContract.safeParse({ ...WIRE_WORKSPACE, workspaceRole: 'admin' }).success).toBe(false);
      expect(workspaceContract.safeParse({ ...WIRE_WORKSPACE, workspaceRole: '' }).success).toBe(false);
    });

    it('a bare `role` key is not the field: it is stripped and does not populate workspaceRole', () => {
      const parsed = workspaceContract.parse({ ...WIRE_WORKSPACE, role: 'workspace_admin' });

      expect('role' in parsed).toBe(false);
      expect(parsed.workspaceRole).toBeUndefined();
    });

    it('is admitted absent (additive versioning: the pre-1b shape still parses; TASK-1b-14 tightens it)', () => {
      expect(workspaceContract.parse({ ...WIRE_WORKSPACE })).toEqual(WIRE_WORKSPACE);
    });

    it('is carried by every item of the list response', () => {
      const item = { ...WIRE_WORKSPACE, workspaceRole: 'member' };

      expect(workspaceListResponseContract.parse({ items: [item] })).toEqual({ items: [item] });
    });
  });
});

describe('workspaceListResponseContract', () => {
  it('AC-21: `{ items: [workspace] }` parses', () => {
    expect(workspaceListResponseContract.parse({ items: [WIRE_WORKSPACE] })).toEqual({ items: [WIRE_WORKSPACE] });
  });

  it('an empty list parses', () => {
    expect(workspaceListResponseContract.parse({ items: [] })).toEqual({ items: [] });
  });

  it('carries no pagination fields: the list is unpaginated in this initiative', () => {
    expect(Object.keys(workspaceListResponseContract.parse({ items: [], nextCursor: null, hasMore: false }))).toEqual([
      'items',
    ]);
  });

  it('refuses a bare array', () => {
    expect(workspaceListResponseContract.safeParse([WIRE_WORKSPACE]).success).toBe(false);
  });
});
