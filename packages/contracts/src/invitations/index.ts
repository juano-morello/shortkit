/**
 * Contract: docs/contracts/workspace-authorization.md (wire rule, minimum role per surface),
 *           docs/contracts/invitation-tokens.md (token format, state and error mapping),
 *           docs/contracts/error-envelope.md
 * ADR: adr-0021-tenant-routing-capability-tokens.md, adr-0015-user-tenant-cardinality.md,
 *      adr-0048-role-brands-are-applied-after-parsing.md, adr-0005-contract-distribution.md
 * Produced by: TASK-1b-01
 *
 * Every request and response shape item 1b puts on the wire, declared once and read by both
 * deployables:
 *
 *   POST   /api/invitations                 createInvitationRequestContract  -> 201 invitationContract
 *   GET    /api/invitations?workspaceId=    listInvitationsQueryContract     -> 200 invitationListResponseContract
 *   DELETE /api/invitations/:id             (no body)                        -> 200 invitationContract
 *   POST   /api/invitations/lookup          invitationLookupRequestContract  -> 200 invitationPreviewContract   (@Public())
 *   POST   /api/invitations/accept          acceptInvitationRequestContract  -> 200 acceptInvitationResponseContract
 *   POST   /api/auth/sign-up/email          { ...signUpRequestContract, invitationToken }  (Better Auth, hooks.before)
 *
 * THIS PACKAGE MAY IMPORT `zod` AND NOTHING ELSE (ADR-0005).
 *
 * ============================================================================
 * THE TOKEN TRAVELS IN A BODY, NEVER IN A PATH OR A QUERY (D-03, F-300/F-362).
 * ============================================================================
 *
 * The email link is `<WEB_APP_ORIGIN>/invitations/accept#token=<raw>` — a URL FRAGMENT,
 * which reaches no server, no `Referer` and no platform log. The page reads it and posts it
 * as `{ token }` to `lookup` and `accept`. `GET /api/invitations/:token` and
 * `POST /api/invitations/:token/accept` are NOT built, so no shape here names a token
 * parameter and no `apiClient` template carries one. `capabilityTokenContract` is the shape
 * a route parses BEFORE `parseCapabilityToken` runs (invitation-tokens.md, step 1); a
 * refusal here answers 400 `validation_failed`, one that passes it and fails the digest
 * answers 404 `not_found` with the same body as unknown and wrong-tenant.
 *
 * ============================================================================
 * NO RESPONSE SHAPE CARRIES THE TOKEN. NOT `invitationContract`, NOT THE PREVIEW.
 * ============================================================================
 *
 * The raw token exists in the rendered mail body and in the URL fragment of the accept
 * link, and nowhere else under this system's control (GC-K). `invitationContract` mirrors
 * the row MINUS `token_digest` and MINUS `tenant_id`; adding a `token` field to any shape
 * in this file is a defect, and `invitations.spec.ts` asserts the key is absent from the
 * two shapes a client renders.
 *
 * ============================================================================
 * EVERY ROLE ENUM SOURCES FROM `WORKSPACE_ROLES`, THE UNBRANDED ARRAY (ADR-0048).
 * ============================================================================
 *
 * No `z.infer` in this file carries a brand. A body arriving on the wire has been validated
 * nowhere; the service brands after parsing through `asWorkspaceRole` (`roles.ts`, the one
 * sanctioned cast). The wire field is `workspaceRole`, never a bare `role`
 * (workspace-authorization.md: a body carrying a role names which enum it is for). The API
 * accepts `viewer` here; the UI offers `INVITABLE_WORKSPACE_ROLES` (`roles.ts`).
 *
 * `email` on the REQUEST is normalised (trim, lower-case) and bounded; on the RESPONSE
 * shapes it is `z.string()`, because the server produced it from the row and a client-side
 * parse must not refuse a row the server already accepted.
 */
import { z } from 'zod';

import { idContract } from '../pagination';
import { WORKSPACE_ROLES } from '../roles';

/**
 * D-11: `pending | accepted | expired | revoked`. `expired` IS NEVER WRITTEN BY 1b — expiry
 * is derived from `expiresAt` at read time and answered 410 `invitation_expired`; a row
 * whose `expiresAt` has passed still reads `state: 'pending'`. The value is reserved for a
 * later sweeper, and is in the enum now so the wire type does not change when one lands.
 */
export const INVITATION_STATES = ['pending', 'accepted', 'expired', 'revoked'] as const;

/** Unbranded, like `WorkspaceRoleValue`: a storage column and this enum's source. */
export type InvitationStateValue = (typeof INVITATION_STATES)[number];

/** Seven days, in seconds. Fixed by ADR-0021 and invitation-tokens.md; not a knob. */
export const INVITATION_TTL_SECONDS = 604_800;

/**
 * `<tenantId>.<secret>`: a canonical lower-case uuid (36), the separator (1), and 32
 * random bytes as base64url with no padding (43). ADR-0021, invitation-tokens.md "Token
 * format". The left half ROUTES and the right half AUTHORISES; this contract admits the
 * shape and nothing about it is verified until the digest lookup runs under RLS.
 */
export const CAPABILITY_TOKEN_LENGTH = 80;

export const capabilityTokenContract = z
  .string()
  .length(CAPABILITY_TOKEN_LENGTH)
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[A-Za-z0-9_-]{43}$/,
  );

/** The inferred type is `string`; the name records which string this is at a call site. */
export type RawCapabilityToken = z.infer<typeof capabilityTokenContract>;

/**
 * The invited address, on the REQUEST. Trimmed and lower-cased BEFORE the format check, so
 * `'  X@Example.COM '` is accepted and stored as `x@example.com` (D-11: `email text NOT NULL`,
 * lower-cased, trimmed). 254 is RFC 5321's path length; it bounds what a row and a mail
 * envelope hold. Input and output types are both `string`.
 */
export const INVITATION_EMAIL_MAX_LENGTH = 254;

export const invitationEmailContract = z
  .string()
  .trim()
  .toLowerCase()
  .email()
  .max(INVITATION_EMAIL_MAX_LENGTH);

export type InvitationEmail = z.infer<typeof invitationEmailContract>;

/** D-13. One invitation names at most this many workspaces; the API refuses 21. */
export const MAX_INVITATION_WORKSPACES = 20;

/**
 * One `(workspace, role)` grant: what a create body names per workspace and what an accept
 * response reports per workspace. `workspaceRole`, per the wire rule; unbranded, per ADR-0048.
 */
export const invitationWorkspaceGrantContract = z.object({
  workspaceId: idContract,
  workspaceRole: z.enum(WORKSPACE_ROLES),
});

export type InvitationWorkspaceGrant = z.infer<typeof invitationWorkspaceGrantContract>;

/**
 * D-13: a repeated `workspaceId` is refused (`validation_failed` under `workspaces`), whatever
 * the roles. The refinement sits on the array field with NO `path` option: zod 4 appends a
 * refinement's `path` to the field's own, so `{ path: ['workspaces'] }` here would produce
 * `['workspaces', 'workspaces']`; the bare field path is already what `toValidationDetails`
 * keys by. Duplicates are checked after each element parsed, so an element that failed
 * `idContract` reports its own issue and not a spurious duplicate.
 */
function hasDistinctWorkspaceIds(
  workspaces: ReadonlyArray<{ readonly workspaceId: string }>,
): boolean {
  return new Set(workspaces.map((grant) => grant.workspaceId)).size === workspaces.length;
}

/** `POST /api/invitations`. `workspace_admin` on every named workspace (Form B, D-09). */
export const createInvitationRequestContract = z.object({
  email: invitationEmailContract,
  workspaces: z
    .array(invitationWorkspaceGrantContract)
    .min(1)
    .max(MAX_INVITATION_WORKSPACES)
    .refine(hasDistinctWorkspaceIds, {
      message: 'Each workspace may be named once.',
    }),
});

export type CreateInvitationRequest = z.infer<typeof createInvitationRequestContract>;

/**
 * One workspace on a stored invitation, as a client renders it: the id (so an admin's list
 * can link to it), the name (denormalised at read time), and the role. The name is
 * `z.string()`, not `workspaceNameContract`: it was validated on the way in.
 */
export const invitationWorkspaceContract = z.object({
  workspaceId: idContract,
  workspaceName: z.string(),
  workspaceRole: z.enum(WORKSPACE_ROLES),
});

export type InvitationWorkspace = z.infer<typeof invitationWorkspaceContract>;

/**
 * The client shape of one invitation. `POST /api/invitations` (201), each item of the list,
 * and `DELETE /api/invitations/:id` (200, `state: 'revoked'`) answer this.
 *
 * NO TOKEN FIELD, EVER (see the header). No `tenantId` either: the caller is inside their
 * own tenant. `invitedByUserId` and `acceptedByUserId` are Better Auth ids, not uuids, the
 * same fact that makes `tenant_memberships.user_id` a `text` column. The four timestamps
 * are ISO strings because they crossed JSON; `acceptedAt` and `revokedAt` are null until
 * that transition happens. `expiresAt` is `createdAt + INVITATION_TTL_SECONDS` (AC-1b-1).
 */
export const invitationContract = z.object({
  id: idContract,
  email: z.string(),
  state: z.enum(INVITATION_STATES),
  workspaces: z.array(invitationWorkspaceContract),
  expiresAt: z.string().datetime(),
  createdAt: z.string().datetime(),
  acceptedAt: z.string().datetime().nullable(),
  revokedAt: z.string().datetime().nullable(),
  invitedByUserId: z.string().min(1),
  acceptedByUserId: z.string().min(1).nullable(),
});

export type Invitation = z.infer<typeof invitationContract>;

/**
 * `GET /api/invitations?workspaceId=<uuid>` answers this: every invitation naming that
 * workspace, all states, newest first (D-09). Unpaginated, `{ items }`, for the reason
 * `workspaces/index.ts` gives: a workspace holds a handful, no AC asks for a cursor, and a
 * cursor later is additive.
 */
export const invitationListResponseContract = z.object({
  items: z.array(invitationContract),
});

export type InvitationListResponse = z.infer<typeof invitationListResponseContract>;

/**
 * The list query. Form A resolves `query.workspaceId` (workspace-authorization.md), so it is
 * REQUIRED here: a missing one is the interceptor's 400 `workspace_id_required` and a
 * non-uuid is 400 `validation_failed` from this parse.
 */
export const listInvitationsQueryContract = z.object({
  workspaceId: idContract,
});

export type ListInvitationsQuery = z.infer<typeof listInvitationsQueryContract>;

/** `POST /api/invitations/lookup`, the one `@Public()` route. Token in the body (D-03). */
export const invitationLookupRequestContract = z.object({
  token: capabilityTokenContract,
});

export type InvitationLookupRequest = z.infer<typeof invitationLookupRequestContract>;

/**
 * What the anonymous lookup answers for a pending, unexpired token: enough to render the
 * accept page and nothing an anonymous caller could act on. NAMES, NOT IDS — a workspace id
 * is a tenant-scoped identifier and the caller has proven nothing but possession of the
 * link. `email` is the invited address (a prefill; D-01 rules the link is the capability
 * and the address is not checked on accept). `inviterEmail` comes from the row's
 * denormalised `inviter_email` (D-11): the app role cannot read `user` (ADR-0050).
 */
export const invitationPreviewContract = z.object({
  email: z.string(),
  tenantName: z.string(),
  inviterEmail: z.string(),
  workspaces: z.array(
    z.object({
      workspaceName: z.string(),
      workspaceRole: z.enum(WORKSPACE_ROLES),
    }),
  ),
  expiresAt: z.string().datetime(),
});

export type InvitationPreview = z.infer<typeof invitationPreviewContract>;

/** `POST /api/invitations/accept`, authenticated. Token in the body (D-03, D-04). */
export const acceptInvitationRequestContract = z.object({
  token: capabilityTokenContract,
});

export type AcceptInvitationRequest = z.infer<typeof acceptInvitationRequestContract>;

/**
 * What accept answers: the workspaces the invitation NAMED, whether or not each membership
 * row was new (D-12: an existing membership wins, `ON CONFLICT DO NOTHING`, and the response
 * still lists the workspace).
 */
export const acceptInvitationResponseContract = z.object({
  workspaces: z.array(invitationWorkspaceGrantContract),
});

export type AcceptInvitationResponse = z.infer<typeof acceptInvitationResponseContract>;
