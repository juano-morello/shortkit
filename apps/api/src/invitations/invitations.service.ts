/**
 * Contract: docs/contracts/invitation-tokens.md, workspace-authorization.md (the five
 *           invitation rows; Form B), mail-sender.md, error-envelope.md, tenant-context.md
 * ADR: adr-0021-tenant-routing-capability-tokens.md, adr-0015-user-tenant-cardinality.md,
 *      adr-0002-tenant-context-binding.md, adr-0024-domain-error-transport.md,
 *      adr-0029-credentials-are-never-constructible-into-error-text.md
 * Produced by: TASK-1b-08
 *
 * The five invitation operations: create (with the mail), list, revoke, the public lookup
 * and the authenticated accept. Every method runs inside the tenant transaction the
 * interceptor opened — except `lookup`, whose route is `@Public()` and which therefore runs
 * under NO ambient context: `findInvitationByCapabilityToken` opens the token's own.
 *
 * ============================================================================
 * CREATE: AUTHORISE EVERY GRANT, THEN READ, THEN WRITE, THEN QUEUE THE MAIL (D-09, GC-H).
 * ============================================================================
 *
 *   1. Form B on EVERY named workspace, `workspace_admin`, before any other statement. The
 *      first miss wins: no membership, another tenant's workspace and an id nobody issued
 *      are one 404 (`WorkspaceAccessNotFoundError`); a membership below the rank is 403.
 *      Nothing is disclosed about a workspace the caller cannot administer, and nothing is
 *      written before the whole list passes.
 *   2. Load each workspace for its name (the mail needs it) and its archive state: an
 *      archived workspace is 400 `validation_failed` under `workspaces`. Every named
 *      workspace is checked and every archived one is reported at once.
 *   3. Read the tenant's name — the mail needs it, the app role cannot read `user`
 *      (ADR-0050) and nothing else carries it. One owner-qualified read of `tenants`, which
 *      `tenants_self_select` bounds to the current context's row.
 *   4. `issueCapabilityToken(tenantId)`; `repository.create` with the DIGEST, `expires_at =
 *      now + INVITATION_TTL_SECONDS`, `invited_by_user_id` from the actor and
 *      `inviter_email` from the actor's `email` claim (D-06: the row is the only place the
 *      inviter's address is readable later, so it is denormalised at write time).
 *   5. `dispatchInvitationMailAfterCommit`: the send is enqueued on the ambient transaction
 *      and runs after COMMIT (invariant 6). The raw token is read into the message inside
 *      that hook and nowhere else; the response is `invitationContract`, which has no
 *      token field, and the row has none either.
 *
 * ============================================================================
 * THE TOKEN IS IN NO STRING THIS FILE BUILDS (GC-K).
 * ============================================================================
 *
 * `issued.raw` is captured by the mail closure and by nothing else: not the response, not
 * a log line, not an error. Every error this file throws is a `DomainError` with a fixed
 * message. `lookup` and `accept` receive the raw token as a string and hand it straight to
 * the two entry functions; they never parse it (GC-L; `capability-lookup.spec.ts` greps).
 *
 * ============================================================================
 * `expired` IS DERIVED ON READ (D-11).
 * ============================================================================
 *
 * The enum value is never written by 1b. `toClientInvitation` reports `expired` for a
 * `pending` row whose `expires_at` has passed, on the process clock, so the list matches
 * what the token functions would answer (they read Postgres's clock; the drift is the two
 * clocks', which is seconds, and the list is a view, not a decision).
 */
import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { asWorkspaceRole, INVITATION_TTL_SECONDS, WORKSPACE_ROLE } from '@shortkit/contracts';
import type {
  AcceptInvitationResponse,
  CreateInvitationRequest,
  Invitation,
  InvitationListResponse,
  InvitationPreview,
  ListInvitationsQuery,
  WorkspaceRole,
} from '@shortkit/contracts';

import { currentActor } from '../common/authorization/actor-context';
import { WorkspaceAuthorizer } from '../common/authorization/workspace-authorizer';
import { DomainError } from '../common/errors/domain-error';
import { VALIDATION_FAILED_MESSAGE } from '../common/errors/parse-or-throw';
import { tenants } from '../db/schema';
import { MAIL_SENDER } from '../mail/mail-sender';
import type { MailSender } from '../mail/mail-sender';
import { currentTenantId, tenantDb } from '../tenancy/tenant-context';
import { WorkspaceNotFoundError } from '../workspaces/workspace-not-found.error';
import { WorkspaceRepository } from '../workspaces/workspace.repository';

import {
  acceptInvitationByCapabilityToken,
  findInvitationByCapabilityToken,
} from './capability-lookup';
import { InvitationNotFoundError } from './errors';
import { dispatchInvitationMailAfterCommit, renderInvitationMail } from './invitation-mail';
import { InvitationRepository } from './invitation.repository';
import type { InvitationRow } from './invitation.repository';
import { issueCapabilityToken } from './tokens/capability-token';

/** The one message an archived grant carries. Names no workspace: the caller named it. */
export const ARCHIVED_WORKSPACE_MESSAGE = 'An archived workspace cannot be invited to.';

/**
 * Row to client shape: `Date` to ISO string, `expired` derived for a pending row whose
 * `expiresAt` is behind `now`, no `tenantId`, no `inviterEmail` (the contract has no such
 * field), and — by construction of `InvitationRow` — no digest.
 */
export function toClientInvitation(row: InvitationRow, now: Date = new Date()): Invitation {
  const expired = row.state === 'pending' && row.expiresAt.getTime() < now.getTime();

  return {
    id: row.id,
    email: row.email,
    state: expired ? 'expired' : row.state,
    workspaces: row.workspaces.map((grant) => ({
      workspaceId: grant.workspaceId,
      workspaceName: grant.workspaceName,
      workspaceRole: grant.workspaceRole,
    })),
    expiresAt: row.expiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    acceptedAt: row.acceptedAt === null ? null : row.acceptedAt.toISOString(),
    revokedAt: row.revokedAt === null ? null : row.revokedAt.toISOString(),
    invitedByUserId: row.invitedByUserId,
    acceptedByUserId: row.acceptedByUserId,
  };
}

/**
 * The tenant's display name for the mail. One owner-qualified read under the ambient
 * context; `tenants_self_select` admits exactly that row, so an absent row is a broken
 * invariant (the actor's `tid` names a tenant that does not exist), not a caller condition.
 */
async function currentTenantName(): Promise<string> {
  const [row] = await tenantDb()
    .select({ name: tenants.name })
    .from(tenants)
    .where(eq(tenants.id, currentTenantId()))
    .limit(1);

  if (row === undefined) {
    throw new Error('The active tenant context names a tenant that could not be read.');
  }

  return row.name;
}

@Injectable()
export class InvitationsService {
  /** `@Inject(...)` written out for the reason `workspaces.service.ts` gives (`consistent-type-imports`). */
  constructor(
    @Inject(InvitationRepository) private readonly repository: InvitationRepository,
    @Inject(WorkspaceRepository) private readonly workspaces: WorkspaceRepository,
    @Inject(WorkspaceAuthorizer) private readonly authorizer: WorkspaceAuthorizer,
    @Inject(MAIL_SENDER) private readonly mail: MailSender,
  ) {}

  async create(input: CreateInvitationRequest): Promise<Invitation> {
    const actor = currentActor();

    // 1. Form B on every grant, before any read of the workspaces and before any write.
    for (const grant of input.workspaces) {
      await this.authorizer.assert(grant.workspaceId, WORKSPACE_ROLE.workspace_admin);
    }

    // 2. Names for the mail; archive state for the 400.
    const named: Array<{ readonly name: string; readonly role: WorkspaceRole }> = [];
    let archived = 0;

    for (const grant of input.workspaces) {
      const workspace = await this.workspaces.findById(grant.workspaceId);

      if (workspace === null) {
        // Form B passed, so a membership row names this workspace; the composite FK on
        // `memberships` means the workspace exists in this tenant. Unreachable in the
        // shipped graph; answered as the same 404 the check gives, never a 500.
        throw new WorkspaceNotFoundError();
      }

      if (workspace.archivedAt !== null) {
        archived += 1;
      }

      named.push({ name: workspace.name, role: asWorkspaceRole(grant.workspaceRole) });
    }

    if (archived > 0) {
      throw new DomainError('validation_failed', VALIDATION_FAILED_MESSAGE, {
        details: { fieldErrors: { workspaces: [ARCHIVED_WORKSPACE_MESSAGE] } },
      });
    }

    // 3.
    const tenantName = await currentTenantName();

    // 4. The digest is what the repository stores; `issued.raw` goes to step 5 and nowhere else.
    const issued = issueCapabilityToken(actor.tenantId);
    const row = await this.repository.create({
      email: input.email,
      workspaces: input.workspaces,
      invitedByUserId: actor.userId,
      inviterEmail: actor.email,
      digest: issued.digest,
      expiresAt: new Date(Date.now() + INVITATION_TTL_SECONDS * 1000),
    });

    // 5. After COMMIT, through the port. The message is built inside the hook.
    await dispatchInvitationMailAfterCommit(actor.tenantId, this.mail, () =>
      renderInvitationMail({
        raw: issued.raw,
        invitationId: row.id, // 2026-08-19 (1b-W1-08): the mail's Idempotency-Key
        to: row.email,
        inviterEmail: row.inviterEmail,
        tenantName,
        workspaces: named,
        expiresAt: row.expiresAt,
      }),
    );

    return toClientInvitation(row);
  }

  /**
   * Form A (`@RequireWorkspaceRole(workspace_admin)` on the route) has already decided the
   * caller administers `query.workspaceId`; the repository lists every invitation naming it,
   * all states, newest first.
   */
  async list(query: ListInvitationsQuery): Promise<InvitationListResponse> {
    const rows = await this.repository.listForWorkspace(query.workspaceId);
    const now = new Date();

    return { items: rows.map((row) => toClientInvitation(row, now)) };
  }

  /**
   * Form B on every workspace the invitation names, after the row is loaded (RLS makes
   * another tenant's id and an unissued one the same null → 404) and before the write.
   * `repository.revoke` is idempotent on `revoked` and refuses `accepted` with 409.
   */
  async revoke(id: string): Promise<Invitation> {
    const row = await this.repository.findById(id);

    if (row === null) {
      throw new InvitationNotFoundError();
    }

    for (const grant of row.workspaces) {
      await this.authorizer.assert(grant.workspaceId, WORKSPACE_ROLE.workspace_admin);
    }

    return toClientInvitation(await this.repository.revoke(id));
  }

  /**
   * The `@Public()` route's body. No ambient context: the function opens the token's own
   * transaction, verifies the digest as its first statement and answers `null` for
   * malformed, unknown and wrong-tenant alike — one 404. The state errors propagate.
   */
  async lookup(rawToken: string): Promise<InvitationPreview> {
    const verified = await findInvitationByCapabilityToken(rawToken);

    if (verified === null) {
      throw new InvitationNotFoundError();
    }

    return {
      email: verified.email,
      tenantName: verified.tenantName,
      inviterEmail: verified.inviterEmail,
      workspaces: verified.workspaces.map((grant) => ({
        workspaceName: grant.workspaceName,
        workspaceRole: grant.workspaceRole,
      })),
      expiresAt: verified.expiresAt.toISOString(),
    };
  }

  /**
   * The signed-in accept (D-04). Inside the interceptor's transaction on the caller's `tid`:
   * a token naming another tenant is 409 before any statement; a matching one joins the
   * transaction, consumes the token and writes the workspace memberships — `'require'`
   * because the caller's tenant membership is what minted the token they arrived with, and
   * only workspace rows are written.
   */
  async accept(rawToken: string): Promise<AcceptInvitationResponse> {
    const actor = currentActor();
    const accepted = await acceptInvitationByCapabilityToken(rawToken, {
      userId: actor.userId,
      tenantMembership: 'require',
    });

    return {
      workspaces: accepted.workspaces.map((grant) => ({
        workspaceId: grant.workspaceId,
        workspaceRole: grant.workspaceRole,
      })),
    };
  }
}
