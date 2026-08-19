/**
 * Contract: docs/contracts/workspaces.md, error-envelope.md
 * ADR: adr-0024-domain-error-transport.md
 * Produced by: TASK-011
 *
 * Thrown by `WorkspaceRepository.rename` and `.archive` when the id names no workspace
 * THE CURRENT TENANT OWNS. A row belonging to another tenant is invisible under
 * row-level security and to the repository's own `tenant_id` qualification alike, so
 * "another tenant's workspace" and "no such workspace" are deliberately the same
 * answer: distinguishing them would tell a caller that an id exists somewhere.
 *
 * `not_found`, which ERROR_CODE_STATUS maps to 404. The message carries no id: the id
 * the caller supplied may be another tenant's, and a DomainError message is a promise
 * that it is safe to show a stranger (GC-9).
 */
import { DomainError } from '../common/errors/domain-error';

export class WorkspaceNotFoundError extends DomainError {
  constructor() {
    super('not_found', 'Workspace not found.');
  }
}
