/**
 * Contract: design/contracts/link-mutation-events.md
 * ADR: adr-0008-redirect-cache-shape.md, adr-0002-tenant-context-binding.md
 * Produced by: TASK-025
 * Consumed by: TASK-027, TASK-031 (cache invalidation), TASK-048 (audit)
 *
 * This hook exists so TASK-031 and TASK-048 do NOT modify the link handlers.
 */
import type { TenantDb } from '../tenancy/tenant-context';

export type LinkMutationAction = 'created' | 'updated' | 'deleted';

/** A plain snapshot, never the Drizzle row: subscribers must not couple to the schema. */
export interface LinkSnapshot {
  readonly id: string;
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly domainId: string;
  /** Denormalised so a subscriber can build a cache key with no query. */
  readonly hostname: string;
  readonly slug: string;
  readonly destinationUrl: string;
  readonly expiresAt: Date | null;
  readonly activatesAt: Date | null;
}

export interface LinkMutation {
  readonly action: LinkMutationAction;
  readonly linkId: string;
  readonly actorId: string;
  readonly tenantId: string;
  readonly occurredAt: Date;
  /** null when action === 'created' */
  readonly before: LinkSnapshot | null;
  /** null when action === 'deleted' */
  readonly after: LinkSnapshot | null;
}

/**
 * 'in-transaction': runs before COMMIT, receives the live TenantDb. A throw rolls the
 *                   mutation back. Used by auditWriter (TASK-048), so a committed
 *                   change without an audit row is impossible (AC-79, AC-80).
 * 'after-commit':   runs from withTenantTransaction's afterCommit, `db` is null.
 *                   A throw is logged and does not affect the committed mutation.
 *                   Used by cacheInvalidator (TASK-031): deleting a key before commit
 *                   would let a concurrent read repopulate it from the pre-commit state.
 */
export type LinkMutationPhase = 'in-transaction' | 'after-commit';

export interface LinkMutationSubscriber {
  readonly name: string;
  readonly phase: LinkMutationPhase;
  handle(mutation: LinkMutation, db: TenantDb | null): Promise<void>;
}

export function onLinkMutated(_subscriber: LinkMutationSubscriber): void {
  throw new Error('not implemented');
}

/**
 * Called by the link service. Exactly one mutation per successful operation.
 * A PATCH changing nothing still fires, with `before` deep-equal to `after`;
 * subscribers decide whether to act.
 */
export function emitLinkMutation(
  _mutation: LinkMutation,
  _db: TenantDb,
): Promise<void> {
  throw new Error('not implemented');
}
