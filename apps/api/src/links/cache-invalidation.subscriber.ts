/**
 * Contract: docs/contracts/redirect-cache.md ("Invalidation": the table this file
 *           implements row for row, "On failure" as amended 2026-08-19, and invariant 1),
 *           link-mutation-events.md ("Two phases"), logging-and-headers.md (the allowlist).
 * ADR: adr-0008-redirect-cache-invalidation.md (five seconds by DELETION, not by expiry),
 *      adr-0012 (the client's failure posture), adr-0009 (the TTL clamp is hygiene).
 * Produced by: TASK-2-08 (item 2, wave 3).
 * Consumed by: `links.module.ts`, which is the only file that registers it.
 *
 * ============================================================================
 * GC-2'S FIVE SECONDS ARE BOUGHT BY DELETING KEYS, AND THIS IS THE ONLY THING THAT DELETES
 * THEM.
 * ============================================================================
 *
 * `LINK_TTL_S` is 3600 in every environment, tests included, so nothing expires its way to
 * correctness: an edited link keeps serving its pre-edit record for an hour unless a
 * deletion arrives. The deletion arrives here, from `onLinkMutated`'s `after-commit` phase,
 * once per successful mutation, and `links.service.ts` knows nothing about it.
 *
 * ============================================================================
 * WHY THIS SHIPS A WAVE AHEAD OF THE READ IT PROTECTS.
 * ============================================================================
 *
 * Invalidation lands in wave 3; the redirect's read-through fill (TASK-2-07) lands in wave 4.
 * The order is deliberate and it is the only safe one: a cache that is filled before anything
 * deletes its keys serves a stale record for up to an hour, and that window would be open on
 * every branch of the wave in between. Filling second means there is never a positive record
 * in Redis that this subscriber was not already running to invalidate. Recorded in
 * `redirect-cache.md` under "Invalidation", because a wave table is not a place anyone reads
 * an invariant from.
 *
 * ============================================================================
 * AFTER COMMIT, AND THAT IS A CORRECTNESS CHOICE RATHER THAN A PERFORMANCE ONE.
 * ============================================================================
 *
 * Deleting the key BEFORE COMMIT would let a concurrent redirect miss, read the pre-commit
 * row from Postgres and write it straight back, a stale record with a fresh hour on it, put
 * there by the invalidation itself. `link-mutation-events.md` says so, and it is why this
 * subscriber cannot simply move to the phase where a throw would roll the mutation back.
 *
 * The cost of the phase is that a failure has nowhere to propagate to: the operator's write
 * committed and answered before this ran. So the failure path is a retry and a log line, and
 * NOT a 500 (invariant 5, AC-2-25).
 */
import { Inject, Injectable } from '@nestjs/common';
import type { OnModuleInit } from '@nestjs/common';

import { REDIRECT_CACHE } from '../cache/redirect-cache';
import type { RedirectCache } from '../cache/redirect-cache';
import { logger } from '../observability/logger';
import type { TenantDb } from '../tenancy/tenant-context';

import { onLinkMutated } from './link-mutation.events';
import type {
  LinkMutation,
  LinkMutationPhase,
  LinkMutationSubscriber,
} from './link-mutation.events';

/** The registry name. Unique by the registry's own rule, and the message it refuses with. */
export const CACHE_INVALIDATOR_NAME = 'cacheInvalidator';

/**
 * `redirect-cache.md`, "On failure": retry at 200 ms and 1000 ms. Two entries, so a deletion
 * is attempted three times in total before the line is written.
 *
 * The delays are what make the retry worth having: a Redis that rejects a command because the
 * socket dropped answers the next one on a reconnected client, and the reconnection is not
 * instant. Three attempts inside one event-loop turn would spend the whole schedule inside
 * the same failure.
 */
export const INVALIDATION_RETRY_DELAYS_MS: readonly number[] = [200, 1000];

/**
 * The `code` an operator greps for. It also stands in for the metric
 * `cache_invalidation_failures_total` the contract names: there is no metrics facility in
 * `apps/api/src`, and ADR-0053 records the same substitution for
 * `auth_revocation_degraded_total`.
 */
export const CACHE_INVALIDATION_FAILED_CODE = 'cache_invalidation_failed';

/** The fixed context string. It names what is now wrong, and no identifier of any kind. */
const CACHE_INVALIDATION_FAILED_MESSAGE =
  'the redirect cache still holds a key this link mutation should have deleted, so the redirect may serve the pre-edit record until the key expires';

/** A `rdr:` key as this file knows it: the pair, never the built string (GC-G). */
export interface InvalidatedLinkKey {
  readonly hostname: string;
  readonly slug: string;
}

/**
 * The contract's invalidation table, as one function: the DEDUPLICATED UNION of the two
 * images' `(hostname, slug)` pairs, in before-then-after order.
 *
 * Read against the table row by row: `created` carries no before, so it deletes the after key
 * (which is what removes a negative entry a scan of unknown slugs left behind, and without
 * which a new link is invisible for up to 60 s); `deleted` carries no after, so it deletes
 * the before key; an `updated` that moved neither the hostname nor the slug produces one key,
 * and one that moved either produces both. A no-op PATCH still fires a mutation and still
 * deletes its key: the audit writer is the subscriber that skips one, and deciding not to
 * delete on an equality computed here rather than by the database is how a record survives an
 * edit that changed something the two images happen to share.
 *
 * THE HOSTNAME IS THE SNAPSHOT'S, DENORMALISED BY THE SERVICE (invariant 1 of
 * `link-mutation-events.md`, D-2-06). There is no domain lookup here and there must not be
 * one: the system default domain's row belongs to the platform tenant and is invisible inside
 * a customer's transaction by design, and this phase has no transaction at all.
 */
export function keysToInvalidate(mutation: LinkMutation): readonly InvalidatedLinkKey[] {
  const keys: InvalidatedLinkKey[] = [];

  for (const image of [mutation.before, mutation.after]) {
    if (image === null) {
      continue;
    }

    const held = keys.some(
      (key) => key.hostname === image.hostname && key.slug === image.slug,
    );

    if (!held) {
      keys.push({ hostname: image.hostname, slug: image.slug });
    }
  }

  return keys;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** What one round of deletions left undone, and the first failure it met. */
interface Round {
  readonly failed: readonly InvalidatedLinkKey[];
  readonly error: unknown;
}

/**
 * ============================================================================
 * ONE REGISTRATION PER PROCESS, AND THIS VARIABLE IS WHY IT IS NOT ONE PER NEST CONTEXT.
 * ============================================================================
 *
 * The registry admits one subscriber per NAME and throws on the second, deliberately, because
 * two registrations would delete each key twice and hide the second failure behind the first
 * success. Nest builds one instance of this provider per APPLICATION CONTEXT, and a process
 * may hold several: `test/invitations/invitations-mail.int-spec.ts` boots two applications
 * from `AppModule` to compare two mail transports, and TASK-2-08 found that shape by turning
 * that suite red. A production process builds exactly one.
 *
 * So the FIRST context registers and the ones after it hand the registration their own cache,
 * which is both the safe answer and the useful one: the registry keeps one subscriber (the
 * invariant its refusal protects), and the deletion goes through the binding of the context
 * whose requests are actually running rather than through a closed client from a context the
 * suite has moved on from.
 */
let registeredInvalidator: CacheInvalidationSubscriber | undefined;

/**
 * Forgets the registration above. FOR TESTS, and for the same narrow reason
 * `clearLinkMutationSubscribers()` exists: a suite that empties the registry has to be able to
 * put a subscriber back into it. Shipped code never calls this.
 */
export function forgetCacheInvalidatorRegistration(): void {
  registeredInvalidator = undefined;
}

/**
 * Registers `subscriber` when this process has registered none, and otherwise returns the
 * instance that IS registered, so its caller can hand that one its own cache.
 *
 * A free function rather than a branch inside `onModuleInit` because the alternative is
 * assigning `this` to a variable, which the lint rules refuse and which reads worse than this
 * does: the two outcomes are "you are the registration" and "here is the registration".
 */
function claimRegistration(
  subscriber: CacheInvalidationSubscriber,
): CacheInvalidationSubscriber | undefined {
  if (registeredInvalidator === undefined) {
    registeredInvalidator = subscriber;
    onLinkMutated(subscriber);

    return undefined;
  }

  return registeredInvalidator;
}

@Injectable()
export class CacheInvalidationSubscriber implements LinkMutationSubscriber, OnModuleInit {
  readonly name = CACHE_INVALIDATOR_NAME;
  readonly phase: LinkMutationPhase = 'after-commit';

  /** Not `readonly`: a second application context rebinds it. See `registeredInvalidator`. */
  private cache: RedirectCache;

  constructor(@Inject(REDIRECT_CACHE) cache: RedirectCache) {
    this.cache = cache;
  }

  /**
   * REGISTERED FROM THE MODULE'S LIFECYCLE, NOT FROM `links.service.ts`. That is what keeps
   * the five handlers from ever learning that a cache exists, and it is why this provider can
   * hold an injected cache at all: at file import there is no binding to inject.
   */
  onModuleInit(): void {
    claimRegistration(this)?.adopt(this.cache);
  }

  /**
   * Takes over a later application context's cache. Called only by the context that found the
   * registration already taken, one line above.
   */
  adopt(cache: RedirectCache): void {
    this.cache = cache;
  }

  /**
   * `_db` is `null` in this phase and this handler never wanted it: everything it needs is on
   * the snapshot, which is the whole reason the snapshot is a plain object and not a Drizzle
   * row. The parameter is named rather than dropped so the signature reads as the dispatcher
   * calls it.
   */
  async handle(mutation: LinkMutation, _db: TenantDb | null = null): Promise<void> {
    let pending = keysToInvalidate(mutation);
    let attempts = 0;
    let failure: unknown;

    for (;;) {
      attempts += 1;

      const round = await this.deleteEach(pending);

      if (round.failed.length === 0) {
        return;
      }

      pending = round.failed;
      failure = round.error;

      const delay = INVALIDATION_RETRY_DELAYS_MS[attempts - 1];

      if (delay === undefined) {
        break;
      }

      await sleep(delay);
    }

    // ONE LINE, AND IT CARRIES `code`, `link_id` AND `attempts` (D-2-15). Not the key, not
    // the hostname, not the slug: the key embeds the slug, and GC-G's posture is that an
    // identifier reconstructible from an id stays off the line. One line per MUTATION rather
    // than per key, because two lines carrying the same link id and no key would be
    // indistinguishable from each other.
    logger.error(
      {
        code: CACHE_INVALIDATION_FAILED_CODE,
        link_id: mutation.linkId,
        attempts,
      },
      CACHE_INVALIDATION_FAILED_MESSAGE,
    );

    // Rethrown after saying the specific thing, which is the shape `link-mutation.events.ts`
    // describes: the dispatcher adds `link_mutation_subscriber_failed` with the error's name
    // and no message, runs the subscribers registered after this one, and swallows it there.
    // The operator's write is already committed and already answered.
    throw failure;
  }

  /**
   * One round over the keys still to delete. Every key is attempted even after one fails: the
   * two keys of a slug change are independent, and abandoning the second because the first
   * rejected would leave a stale record no later round would revisit either.
   *
   * `delLink` REJECTS when the deletion did not happen. That is the one asymmetry in
   * `redirect-cache.ts`, deliberate, and this is the caller it exists for.
   */
  private async deleteEach(keys: readonly InvalidatedLinkKey[]): Promise<Round> {
    const failed: InvalidatedLinkKey[] = [];
    let error: unknown;
    let met = false;

    for (const key of keys) {
      try {
        await this.cache.delLink(key.hostname, key.slug);
      } catch (thrown: unknown) {
        failed.push(key);

        if (!met) {
          met = true;
          error = thrown;
        }
      }
    }

    return { failed, error };
  }
}
