/**
 * Contract: docs/contracts/link-mutation-events.md (NORMATIVE FORM: this file; the design
 *           stub it named is retired by this commit under ADR-0039)
 * ADR: adr-0008-redirect-cache-invalidation.md, adr-0002-tenant-context-binding.md
 * Produced by: TASK-2-05 (the card `link-mutation-events.md` still calls TASK-025)
 * Consumed by: TASK-2-08 (the cache invalidator, `after-commit`), item 4's TASK-048 (the
 *              audit writer, `in-transaction`)
 *
 * ============================================================================
 * THE HOOK EXISTS SO NEITHER SUBSCRIBER EVER EDITS A LINK HANDLER.
 * ============================================================================
 *
 * `links.service.ts` fires exactly one mutation per successful operation and knows nothing
 * about caches or audit rows. Cache invalidation (2-08) and the audit writer (item 4)
 * attach here. A card that reaches into `links.service.ts` to add a call has spent the
 * whole reason this file exists.
 *
 * ============================================================================
 * TWO PHASES, TWO OPPOSITE FAILURE POSTURES. NEITHER IS A DEFAULT.
 * ============================================================================
 *
 * `in-transaction` runs BEFORE COMMIT with the live `TenantDb` and a throw PROPAGATES:
 * the service is inside the request's tenant transaction, so the mutation rolls back with
 * it. That is AC-79/AC-80's shape: a committed change with no audit row must be
 * impossible.
 *
 * `after-commit` runs from `withTenantTransaction`'s `afterCommit` with `db: null` and a
 * throw is LOGGED AND SWALLOWED: the operator's write is already committed and answered,
 * and a Redis outage may not turn a successful PATCH into a 500 (invariant 5, AC-2-25).
 * Deleting a cache key before COMMIT would let a concurrent read repopulate it from the
 * pre-commit state, which is why the invalidator cannot simply move to the first phase.
 *
 * Within a phase, subscribers run IN REGISTRATION ORDER and one at a time. Serial rather
 * than `Promise.all`: the first phase's subscribers share one database connection (the
 * transaction's) and interleaving statements on it is not a thing a caller may do.
 *
 * ============================================================================
 * THE REGISTRY IS MODULE STATE, AND SUBSCRIBER NAMES ARE UNIQUE.
 * ============================================================================
 *
 * `onLinkMutated` is a free function rather than a Nest provider because both subscribers
 * register at module load, and `link-mutation-events.md` requires that neither touches the
 * link handlers, and an injected registry would put one in `LinksService`'s constructor.
 * A duplicate NAME is refused rather than accepted: two registrations of the invalidator
 * (a module imported twice, a test that forgot to clear) would delete the same key twice
 * and make the second failure invisible behind the first success.
 */
import { logger, errorLogFields } from '../observability/logger';
import type { TenantDb } from '../tenancy/tenant-context';

export type LinkMutationAction = 'created' | 'updated' | 'deleted';

/**
 * The fields any subscriber may need, as a PLAIN OBJECT. Never the Drizzle row: passing
 * one couples every subscriber to the schema, and a column rename then edits files that
 * have no business knowing there are columns.
 *
 * `hostname` is denormalised by the service (D-2-06, D-2-19) so the invalidator builds
 * `rdr:v1:{hostname}:{slug}` with no lookup: there is no domain read to make, and the
 * hot path may not have one.
 */
export interface LinkSnapshot {
  readonly id: string;
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly domainId: string;
  readonly hostname: string;
  readonly slug: string;
  readonly destinationUrl: string;
  readonly expiresAt: Date | null;
  readonly activatesAt: Date | null;
}

export interface LinkMutation {
  readonly action: LinkMutationAction;
  readonly linkId: string;
  /** `RequestContext.userId`. Nothing mutates a link outside a request (invariant 3). */
  readonly actorId: string;
  readonly tenantId: string;
  readonly occurredAt: Date;
  /** `null` when `action === 'created'`. */
  readonly before: LinkSnapshot | null;
  /** `null` when `action === 'deleted'`. */
  readonly after: LinkSnapshot | null;
}

export type LinkMutationPhase = 'in-transaction' | 'after-commit';

export interface LinkMutationSubscriber {
  readonly name: string;
  readonly phase: LinkMutationPhase;
  handle(mutation: LinkMutation, db: TenantDb | null): Promise<void>;
}

/** Registration order is dispatch order, so this is an array and not a map. */
const subscribers: LinkMutationSubscriber[] = [];

/** Registers `subscriber`. Called at module load by the subscriber's own module. */
export function onLinkMutated(subscriber: LinkMutationSubscriber): void {
  if (subscribers.some((registered) => registered.name === subscriber.name)) {
    throw new Error(
      `A link mutation subscriber named ${subscriber.name} is already registered. Two ` +
        'registrations of one subscriber run it twice per mutation and hide the second failure.',
    );
  }

  subscribers.push(subscriber);
}

/**
 * Empties the registry. FOR TESTS, and for nothing else: in production each subscriber
 * registers once at module load and stays for the life of the process.
 */
export function clearLinkMutationSubscribers(): void {
  subscribers.length = 0;
}

/**
 * The first phase. Runs inside the caller's tenant transaction, with its live handle, and
 * a throw is left to propagate so the mutation rolls back with the subscriber's work.
 */
export async function runInTransactionSubscribers(
  mutation: LinkMutation,
  db: TenantDb,
): Promise<void> {
  for (const subscriber of subscribers) {
    if (subscriber.phase === 'in-transaction') {
      await subscriber.handle(mutation, db);
    }
  }
}

/**
 * The second phase. Runs from `afterCommit`, so there is no transaction and `db` is `null`;
 * one subscriber's failure is logged and does not stop the ones registered after it.
 *
 * THE ERROR'S MESSAGE IS NOT ON THE LINE (`includeMessage: false`). A cache failure's
 * message names an internal host and a database one carries bound parameters; only a
 * `DomainError`'s message is a promise that it is safe to record (`observability/logger.ts`).
 * `code` is what an operator greps for, and the subscriber that has something specific to
 * say (`cache_invalidation_failed` with `link_id` and `attempts`, D-2-15) says it itself
 * before throwing.
 */
export async function runAfterCommitSubscribers(mutation: LinkMutation): Promise<void> {
  for (const subscriber of subscribers) {
    if (subscriber.phase !== 'after-commit') {
      continue;
    }

    try {
      await subscriber.handle(mutation, null);
    } catch (error: unknown) {
      logger.error(
        {
          code: 'link_mutation_subscriber_failed',
          ...errorLogFields(error, { includeMessage: false }),
        },
        'a link mutation subscriber failed after commit; the write already succeeded',
      );
    }
  }
}
