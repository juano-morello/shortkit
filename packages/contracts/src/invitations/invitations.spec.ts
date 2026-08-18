/**
 * STORY-1b-01 — AC-1b-1, AC-1b-2 (the contract half); STORY-1b-05 — AC-1b-23, AC-1b-28
 * (the shapes). TASK-1b-01.
 *
 * Contract: docs/contracts/workspace-authorization.md (wire rule), invitation-tokens.md
 *           (token format), error-envelope.md
 * ADR: adr-0005-contract-distribution.md, adr-0021-tenant-routing-capability-tokens.md,
 *      adr-0048-role-brands-are-applied-after-parsing.md
 *
 * AC-1b-2 is stated over `validation_failed` keying an issue under `workspaces` or `email`,
 * so every bound is asserted through the parse AND the flatten together, the way
 * `auth.spec.ts` asserts the password bounds: literal 0/1/20/21-entry arrays pin the
 * numbers, and the constant-derived lengths pin that the contract is built from the exported
 * values rather than from inline literals.
 *
 * ============================================================================
 * THE TOKEN AND THE ROLE ARE THE TWO SHAPES A LATER TASK COULD LOOSEN QUIETLY.
 * ============================================================================
 *
 * `capabilityTokenContract` is what `POST /api/invitations/lookup` and `/accept` parse
 * BEFORE `parseCapabilityToken` runs (invitation-tokens.md, "Normative sequence" step 1).
 * A contract that admitted a 79-character string, an upper-case tenant half, or a `+` in
 * the secret would hand the API a token it has to reject one layer later, so the exact
 * 36 + 1 + 43 shape is pinned here with each deviation refused in one table.
 *
 * `workspaceRole` on every wire shape sources from `WORKSPACE_ROLES`, the UNBRANDED array
 * (ADR-0048). The `@ts-expect-error` below is the compile-time half: it fails
 * `pnpm typecheck` with "Unused '@ts-expect-error' directive" the day an inferred type
 * starts carrying a brand. It does not run under `pnpm test` (vitest transpiles with swc
 * and never typechecks); it is an assertion against the typecheck gate.
 */
import { describe, expect, it } from 'vitest';

import { isZodError, toValidationDetails } from '../errors';
import type { WorkspaceRole } from '../roles';

import {
  CAPABILITY_TOKEN_LENGTH,
  INVITATION_EMAIL_MAX_LENGTH,
  INVITATION_STATES,
  INVITATION_TTL_SECONDS,
  MAX_INVITATION_WORKSPACES,
  acceptInvitationRequestContract,
  acceptInvitationResponseContract,
  capabilityTokenContract,
  createInvitationRequestContract,
  invitationContract,
  invitationEmailContract,
  invitationListResponseContract,
  invitationLookupRequestContract,
  invitationPreviewContract,
  invitationWorkspaceContract,
  invitationWorkspaceGrantContract,
  listInvitationsQueryContract,
} from './index';

const W1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const W3 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
/** Carries hex letters, so the upper-case row below is a real deviation. */
const TENANT_ID = 'ab111111-1111-4111-8111-111111111abc';

/** 43 base64url characters, the length `crypto.randomBytes(32)` encodes to (ADR-0021). */
const SECRET = 'Xk3_-abcdefghijklmnopqrstuvwxyzABCDEFGHIJKL';
const RAW_TOKEN = `${TENANT_ID}.${SECRET}`;

const WIRE_INVITATION = {
  id: '44444444-4444-4444-8444-444444444444',
  email: 'x@example.com',
  state: 'pending',
  workspaces: [
    { workspaceId: W1, workspaceName: 'Acme', workspaceRole: 'member' },
    { workspaceId: W3, workspaceName: 'Globex', workspaceRole: 'viewer' },
  ],
  expiresAt: '2026-08-25T09:00:00.000Z',
  createdAt: '2026-08-18T09:00:00.000Z',
  acceptedAt: null,
  revokedAt: null,
  invitedByUserId: 'nZ8kQpR2xLmT4vB6',
  acceptedByUserId: null,
} as const;

/** `n` distinct uuids, so a bound test fails for the bound and not for a duplicate. */
function grantsOfCount(n: number): Array<{ workspaceId: string; workspaceRole: 'member' }> {
  return Array.from({ length: n }, (_, index) => ({
    workspaceId: `aaaaaaaa-aaaa-4aaa-8aaa-${String(index).padStart(12, '0')}`,
    workspaceRole: 'member',
  }));
}

/** The messages a failed create parse flattens to under `key`; `[]` when the parse passed. */
function createIssues(body: unknown, key: string): string[] {
  const outcome = createInvitationRequestContract.safeParse(body);

  if (outcome.success) {
    return [];
  }

  expect(isZodError(outcome.error)).toBe(true);

  return toValidationDetails(outcome.error).fieldErrors[key] ?? [];
}

describe('constants', () => {
  it('AC-1b-1 (ADR-0021): the TTL is seven days in seconds', () => {
    expect(INVITATION_TTL_SECONDS).toBe(7 * 24 * 60 * 60);
  });

  it('the four invitation states, in the order the enum declares them', () => {
    expect(INVITATION_STATES).toEqual(['pending', 'accepted', 'expired', 'revoked']);
  });

  it('AC-1b-3 (ADR-0021): a token is 80 characters: 36 + the separator + 43', () => {
    expect(CAPABILITY_TOKEN_LENGTH).toBe(80);
    expect(RAW_TOKEN).toHaveLength(CAPABILITY_TOKEN_LENGTH);
  });
});

describe('capabilityTokenContract', () => {
  it('AC-1b-28: a well-formed token parses to itself', () => {
    expect(capabilityTokenContract.parse(RAW_TOKEN)).toBe(RAW_TOKEN);
  });

  it('AC-1b-28 (ADR-0021): every deviation from <uuid>.<43 base64url> is refused, in one table', () => {
    const cases: Record<string, string> = {
      'one character short': RAW_TOKEN.slice(0, -1),
      'one character long': `${RAW_TOKEN}A`,
      'upper-case tenant half': `${TENANT_ID.toUpperCase()}.${SECRET}`,
      'no separator': `${TENANT_ID}${SECRET}A`,
      'two separators': `${TENANT_ID}.${SECRET.slice(0, -1)}.`,
      // `+` and `/` are base64, not base64url; the secret alphabet excludes them.
      'base64 plus in the secret': `${TENANT_ID}.${SECRET.slice(0, -1)}+`,
      'base64 slash in the secret': `${TENANT_ID}.${SECRET.slice(0, -1)}/`,
      'padding in the secret': `${TENANT_ID}.${SECRET.slice(0, -1)}=`,
      'tenant half not a uuid shape': `${'g'.repeat(8)}-aaaa-4aaa-8aaa-aaaaaaaaaaaa.${SECRET}`,
      empty: '',
    };

    const outcomes = Object.fromEntries(
      Object.entries(cases).map(([label, value]) => [
        label,
        capabilityTokenContract.safeParse(value).success,
      ]),
    );

    expect(outcomes).toEqual(Object.fromEntries(Object.keys(cases).map((label) => [label, false])));
  });

  it('AC-1b-28: a non-string is refused', () => {
    expect(capabilityTokenContract.safeParse(42).success).toBe(false);
  });
});

describe('invitationEmailContract', () => {
  it('AC-1b-1: it trims and lower-cases before validating, and returns the normalised value', () => {
    expect(invitationEmailContract.parse('  X@Example.COM ')).toBe('x@example.com');
  });

  it('AC-1b-2: a malformed address is refused', () => {
    expect(invitationEmailContract.safeParse('x-at-example.com').success).toBe(false);
  });

  it('AC-1b-2: a 254-character address is accepted and a 255-character one is refused; the bound is the exported one', () => {
    const domain = '@example.com';
    const atBound = `${'a'.repeat(INVITATION_EMAIL_MAX_LENGTH - domain.length)}${domain}`;
    const overBound = `${'a'.repeat(INVITATION_EMAIL_MAX_LENGTH - domain.length + 1)}${domain}`;

    // Both rows, so the refusal is the length bound and not the address format: a format
    // check that happened to cap the local part would refuse both.
    expect(INVITATION_EMAIL_MAX_LENGTH).toBe(254);
    expect([atBound.length, overBound.length]).toEqual([254, 255]);
    expect([
      invitationEmailContract.safeParse(atBound).success,
      invitationEmailContract.safeParse(overBound).success,
    ]).toEqual([true, false]);
  });
});

describe('invitationWorkspaceGrantContract', () => {
  it('AC-1b-1: it names the enum on the wire: workspaceRole, never a bare role', () => {
    expect(
      invitationWorkspaceGrantContract.parse({ workspaceId: W1, workspaceRole: 'viewer' }),
    ).toEqual({ workspaceId: W1, workspaceRole: 'viewer' });

    // The wire rule in workspace-authorization.md: a body carrying a role names which enum it
    // is for. A `role` key is unknown to this shape and the required key is missing.
    expect(invitationWorkspaceGrantContract.safeParse({ workspaceId: W1, role: 'viewer' }).success).toBe(
      false,
    );
  });

  it('AC-1b-1: viewer is accepted by the API contract even though no UI offers it', () => {
    expect(
      invitationWorkspaceGrantContract.safeParse({ workspaceId: W1, workspaceRole: 'viewer' }).success,
    ).toBe(true);
  });

  it('AC-1b-1 (ADR-0023): a tenant role is not a workspace role, so owner is refused', () => {
    expect(
      invitationWorkspaceGrantContract.safeParse({ workspaceId: W1, workspaceRole: 'owner' }).success,
    ).toBe(false);
  });

  it('AC-1b-2: workspaceId must be a uuid', () => {
    expect(
      invitationWorkspaceGrantContract.safeParse({ workspaceId: 'W1', workspaceRole: 'member' })
        .success,
    ).toBe(false);
  });

  it('AC-1b-1 (ADR-0048): the inferred workspaceRole is unbranded, so it is not assignable to WorkspaceRole', () => {
    const wire = invitationWorkspaceGrantContract.parse({ workspaceId: W1, workspaceRole: 'member' });

    // @ts-expect-error a brand in an inferred contract type is what ADR-0048 refuses
    const laundered: WorkspaceRole = wire.workspaceRole;

    expect(laundered).toBe('member');
  });
});

describe('createInvitationRequestContract', () => {
  const VALID_BODY = {
    email: 'x@example.com',
    workspaces: [
      { workspaceId: W1, workspaceRole: 'member' },
      { workspaceId: W3, workspaceRole: 'viewer' },
    ],
  };

  it('AC-1b-1: a body naming two workspaces at two roles parses, with the email normalised', () => {
    expect(createInvitationRequestContract.parse({ ...VALID_BODY, email: ' X@Example.com' })).toEqual(
      VALID_BODY,
    );
  });

  it('AC-1b-2: an empty workspaces array is refused and keys an issue under workspaces', () => {
    expect(createIssues({ ...VALID_BODY, workspaces: [] }, 'workspaces').length).toBeGreaterThan(0);
  });

  it('AC-1b-2: one workspace is accepted', () => {
    expect(createIssues({ ...VALID_BODY, workspaces: grantsOfCount(1) }, 'workspaces')).toEqual([]);
  });

  it('AC-1b-2: twenty workspaces are accepted', () => {
    expect(createIssues({ ...VALID_BODY, workspaces: grantsOfCount(20) }, 'workspaces')).toEqual([]);
  });

  it('AC-1b-2: twenty-one workspaces are refused and key an issue under workspaces', () => {
    expect(createIssues({ ...VALID_BODY, workspaces: grantsOfCount(21) }, 'workspaces').length).toBeGreaterThan(
      0,
    );
  });

  it('AC-1b-2 (D-13): the exported bound is the bound the contract enforces', () => {
    expect(MAX_INVITATION_WORKSPACES).toBe(20);
    expect([
      createIssues({ ...VALID_BODY, workspaces: grantsOfCount(MAX_INVITATION_WORKSPACES) }, 'workspaces'),
      createIssues({ ...VALID_BODY, workspaces: grantsOfCount(MAX_INVITATION_WORKSPACES + 1) }, 'workspaces')
        .length,
    ]).toEqual([[], 1]);
  });

  it('AC-1b-2 (D-13): a repeated workspaceId is refused and keys an issue under workspaces, even at different roles', () => {
    const issues = createIssues(
      {
        ...VALID_BODY,
        workspaces: [
          { workspaceId: W1, workspaceRole: 'member' },
          { workspaceId: W1, workspaceRole: 'viewer' },
        ],
      },
      'workspaces',
    );

    expect(issues.length).toBeGreaterThan(0);
  });

  it('AC-1b-2: a malformed email keys an issue under email and none under workspaces', () => {
    const body = { ...VALID_BODY, email: 'not-an-address' };

    expect([createIssues(body, 'email').length > 0, createIssues(body, 'workspaces')]).toEqual([
      true,
      [],
    ]);
  });

  it('AC-1b-2: a bad element keys its issue under workspaces (the first path segment)', () => {
    expect(
      createIssues(
        { ...VALID_BODY, workspaces: [{ workspaceId: 'W1', workspaceRole: 'member' }] },
        'workspaces',
      ).length,
    ).toBeGreaterThan(0);
  });

  it('AC-1b-2: a missing workspaces field is refused', () => {
    expect(createInvitationRequestContract.safeParse({ email: 'x@example.com' }).success).toBe(false);
  });
});

describe('invitationContract', () => {
  it('AC-1b-1: the response shape survives a parse, and carries no token field', () => {
    const parsed = invitationContract.parse({ ...WIRE_INVITATION, token: RAW_TOKEN });

    expect(parsed).toEqual(WIRE_INVITATION);
    // A plain z.object strips unknown keys, so even a service that leaked the token onto the
    // object would have it removed by a client-side parse; the shape declares no such key.
    expect('token' in parsed).toBe(false);
    expect('token' in invitationContract.shape).toBe(false);
  });

  it('AC-1b-23: acceptedAt, revokedAt and acceptedByUserId accept null and a value', () => {
    expect(
      invitationContract.safeParse({
        ...WIRE_INVITATION,
        state: 'accepted',
        acceptedAt: '2026-08-19T09:00:00.000Z',
        acceptedByUserId: 'u_2',
      }).success,
    ).toBe(true);
    expect(
      invitationContract.safeParse({
        ...WIRE_INVITATION,
        state: 'revoked',
        revokedAt: '2026-08-19T09:00:00.000Z',
      }).success,
    ).toBe(true);
  });

  it('AC-1b-23: a state outside INVITATION_STATES is refused', () => {
    expect(invitationContract.safeParse({ ...WIRE_INVITATION, state: 'cancelled' }).success).toBe(false);
  });

  it('AC-1b-1: expiresAt and createdAt must be ISO datetimes', () => {
    expect(invitationContract.safeParse({ ...WIRE_INVITATION, expiresAt: '2026-08-25' }).success).toBe(
      false,
    );
  });

  it("AC-1b-1: invitedByUserId is Better Auth's non-uuid id, not a uuid", () => {
    expect(invitationContract.parse(WIRE_INVITATION).invitedByUserId).toBe('nZ8kQpR2xLmT4vB6');
    expect(invitationContract.safeParse({ ...WIRE_INVITATION, invitedByUserId: '' }).success).toBe(false);
  });

  it('AC-1b-1: each workspace entry carries id, name and workspaceRole', () => {
    expect(
      invitationWorkspaceContract.parse({ workspaceId: W1, workspaceName: 'Acme', workspaceRole: 'member' }),
    ).toEqual({ workspaceId: W1, workspaceName: 'Acme', workspaceRole: 'member' });
  });
});

describe('invitationListResponseContract and listInvitationsQueryContract', () => {
  it('AC-1b-23: the list is { items } and unpaginated', () => {
    expect(invitationListResponseContract.parse({ items: [WIRE_INVITATION] })).toEqual({
      items: [WIRE_INVITATION],
    });
    expect('nextCursor' in invitationListResponseContract.shape).toBe(false);
  });

  it('AC-1b-23 (Form A): the query requires a uuid workspaceId', () => {
    expect(listInvitationsQueryContract.parse({ workspaceId: W1 })).toEqual({ workspaceId: W1 });
    expect(listInvitationsQueryContract.safeParse({}).success).toBe(false);
    expect(listInvitationsQueryContract.safeParse({ workspaceId: 'W1' }).success).toBe(false);
  });
});

describe('the token-carrying request bodies', () => {
  it('AC-1b-28 (D-03): lookup carries the token in the body, validated by capabilityTokenContract', () => {
    expect(invitationLookupRequestContract.parse({ token: RAW_TOKEN })).toEqual({ token: RAW_TOKEN });
    expect(invitationLookupRequestContract.safeParse({ token: 'nope' }).success).toBe(false);
  });

  it('AC-1b-13 (D-03): accept carries the token in the body, validated the same way', () => {
    expect(acceptInvitationRequestContract.parse({ token: RAW_TOKEN })).toEqual({ token: RAW_TOKEN });
    expect(acceptInvitationRequestContract.safeParse({ token: `${RAW_TOKEN}A` }).success).toBe(false);
  });
});

describe('invitationPreviewContract', () => {
  const PREVIEW = {
    email: 'x@example.com',
    tenantName: 'Acme Agency',
    inviterEmail: 'owner@example.com',
    workspaces: [
      { workspaceName: 'Acme', workspaceRole: 'member' },
      { workspaceName: 'Globex', workspaceRole: 'viewer' },
    ],
    expiresAt: '2026-08-25T09:00:00.000Z',
  };

  it('AC-1b-28: the preview carries names and roles and no ids and no token', () => {
    expect(invitationPreviewContract.parse({ ...PREVIEW, token: RAW_TOKEN })).toEqual(PREVIEW);
    expect('token' in invitationPreviewContract.shape).toBe(false);
  });

  it('AC-1b-28: a preview workspace with an id key is stripped, because the anonymous caller gets names only', () => {
    const parsed = invitationPreviewContract.parse({
      ...PREVIEW,
      workspaces: [{ workspaceId: W1, workspaceName: 'Acme', workspaceRole: 'member' }],
    });

    expect(parsed.workspaces).toEqual([{ workspaceName: 'Acme', workspaceRole: 'member' }]);
  });
});

describe('acceptInvitationResponseContract', () => {
  it('AC-1b-13: the accept response lists the granted workspaces as grants', () => {
    const body = { workspaces: [{ workspaceId: W1, workspaceRole: 'member' }] };

    expect(acceptInvitationResponseContract.parse(body)).toEqual(body);
    expect(acceptInvitationResponseContract.safeParse({ workspaces: [{ workspaceId: W1 }] }).success).toBe(
      false,
    );
  });
});
