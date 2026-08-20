/**
 * Contract: docs/contracts/invitation-tokens.md ("State and error mapping"), error-envelope.md
 * ADR: adr-0024-domain-error-transport.md, adr-0029-credentials-are-never-constructible-into-error-text.md,
 *      adr-0015-user-tenant-cardinality.md
 * Produced by: TASK-1b-04
 *
 * The five errors the invitation surface answers with. Every code already exists in
 * `ERROR_CODES` (GC-M: nothing is added), and every message is one fixed literal: no
 * invitation id, no token, no address, no tenant id. The value a caller supplied on the
 * two token legs is a bearer credential; the id on the revoke leg may be another tenant's.
 *
 * `InvitationNotFoundError` is ONE answer for three conditions (malformed token, unknown
 * digest, digest belonging to another tenant), and for an id nobody in the current tenant
 * owns. Distinguishing them would tell an anonymous caller which tenants and which tokens
 * exist (invitation-tokens.md, "404 is one body").
 *
 * `InvitationExpiredError` is DERIVED from `expires_at`, never from a stored `'expired'`
 * state (D-11: 1b never writes that value; the row stays `pending`).
 */
import { DomainError } from '../common/errors/domain-error';

export class InvitationNotFoundError extends DomainError {
  constructor() {
    super('not_found', 'Invitation not found.');
  }
}

export class InvitationAlreadyAcceptedError extends DomainError {
  constructor() {
    super('invitation_already_accepted', 'This invitation has already been accepted.');
  }
}

export class InvitationExpiredError extends DomainError {
  constructor() {
    super('invitation_expired', 'This invitation has expired.');
  }
}

export class InvitationRevokedError extends DomainError {
  constructor() {
    super('invitation_revoked', 'This invitation has been revoked.');
  }
}

/**
 * The accepting account belongs to a different tenant than the one the invitation names
 * (ADR-0015: one tenant per user, ever). Decided BEFORE any statement when a tenant
 * context is active (D-04), and again at the tenant-membership write when none was.
 */
export class InvitationTenantConflictError extends DomainError {
  constructor() {
    super(
      'invitation_tenant_conflict',
      'This account belongs to a different organisation. Accept the invitation from a different account.',
    );
  }
}
