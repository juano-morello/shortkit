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
 *
 * ============================================================================
 * THE STALE SET RACE, AND THE DELAYED SECOND DELETION THAT BOUNDS IT (TASK-2-07 review).
 * ============================================================================
 *
 * A redirect request that read the PRE-EDIT row from Postgres, before the editor's commit,
 * can write that record into Redis AFTER the deletion below has run. Nothing on the read path
 * corrects it, so the pre-edit or pre-deletion record would then serve with a fresh TTL:
 * up to `LINK_TTL_S` for a link with no window, on the one surface that is never rate
 * limited, and an editor cannot even observe it. That is GC-2's five seconds defeated by a
 * window nobody can close from the fill side without putting a check on the hot path, which
 * is the one thing the read-through card must not spend.
 *
 * So the deletion runs TWICE: once now, and once more after
 * `INVALIDATION_SECOND_PASS_DELAY_MS`, unconditionally rather than only on failure. It is
 * SCHEDULED AND NOT AWAITED, so it adds nothing to the mutation the operator is waiting on,
 * and its timer is `unref`ed so a pending pass never holds the process open. A second-pass
 * failure writes the same fixed line shape and stops; retrying it forever would be a per-
 * mutation log loop for a key the first pass already reported on.
 *
 * WHAT THIS DOES NOT CLOSE, STATED PLAINLY: a fill that lands after the SECOND deletion still
 * wins, and is then bounded only by the TTL. The race is narrowed from "any request in flight
 * across the commit" to "a request whose Postgres read predates the commit and whose cache
 * write lands more than a second after it", which is a request that spent longer between its
 * own two steps than the whole schedule. `redirect-cache.md` records the residual beside the
 * retry-exhaustion one.
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
 * How long after a SUCCESSFUL deletion the same key set is deleted again, to remove a record
 * a redirect filled from a pre-commit read (see the file docblock). The same 1000 ms as the
 * schedule's last step, and for the same reason it was chosen there: it is long enough to be
 * past an in-flight request's own round trip and short enough that 200 + 1000 + 1000 still
 * sits inside GC-2's five seconds, so the bound the contract promises holds even when the
 * first pass needed its whole retry schedule.
 */
export const INVALIDATION_SECOND_PASS_DELAY_MS = 1000;

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

/**
 * The second pass's own context string. SAME FIELDS, SAME `code` (an operator greps for one
 * thing), different sentence: what failed here is the sweep that removes a record a redirect
 * filled from a pre-commit read, so the first pass may well have succeeded and the key may
 * well be absent.
 */
const CACHE_INVALIDATION_SECOND_PASS_FAILED_MESSAGE =
  'the delayed second deletion failed, so a redirect that filled the cache from a pre-commit read may keep serving the pre-edit record until the key expires';

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
 * The second passes that have been scheduled and have not run yet. Held so a test can drop
 * them; shipped code never cancels one.
 */
const scheduledPasses = new Set<NodeJS.Timeout>();

/**
 * Drops every scheduled second pass. FOR TESTS, and for a reason the timers themselves
 * create: a pass scheduled by one test fires during the next one, where it would delete
 * against a cache that suite has already closed, or against a server another test has just
 * configured to refuse writes, and write a failure line into somebody else's assertion.
 * Shipped code never calls this: the whole point of the pass is that it runs.
 */
export function cancelScheduledInvalidationPasses(): void {
  for (const timer of scheduledPasses) {
    clearTimeout(timer);
  }

  scheduledPasses.clear();
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
    const keys = keysToInvalidate(mutation);
    let pending = keys;
    let attempts = 0;
    let failure: unknown;

    for (;;) {
      attempts += 1;

      const round = await this.deleteEach(pending);

      if (round.failed.length === 0) {
        // THE WHOLE KEY SET, not `pending`: the second pass is about a record a redirect
        // wrote after a deletion succeeded, so the keys that succeeded early are exactly the
        // ones it has to revisit. Scheduled, never awaited (see the file docblock).
        this.scheduleSecondPass(keys, mutation.linkId);

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
   * Schedules the one repeat deletion. Nothing is scheduled when the first pass exhausted its
   * retries: that path has already told the operator the key is still there, and a pass that
   * failed three times in 1.2 seconds against a refusing server has no better prospect a
   * second later than the line it already wrote.
   *
   * `unref` so a pending pass never keeps the process (or a test run) alive: the mutation is
   * committed and answered, and a sweep that a shutdown skips costs the TTL, which is the
   * bound this whole mechanism narrows rather than removes.
   */
  private scheduleSecondPass(keys: readonly InvalidatedLinkKey[], linkId: string): void {
    const timer = setTimeout(() => {
      scheduledPasses.delete(timer);

      void this.secondPass(keys, linkId);
    }, INVALIDATION_SECOND_PASS_DELAY_MS);

    timer.unref();
    scheduledPasses.add(timer);
  }

  /**
   * ONE more deletion of the same keys, with no retry schedule of its own. Deleting a key that
   * is not there is not a failure (Redis answers `0`), so the ordinary outcome of this pass is
   * a no-op that says nothing, and the interesting outcome is the one it exists for: a record
   * a redirect wrote between the commit and now is gone.
   */
  private async secondPass(keys: readonly InvalidatedLinkKey[], linkId: string): Promise<void> {
    const round = await this.deleteEach(keys);

    if (round.failed.length === 0) {
      return;
    }

    // The same three fields (`redirect-cache.md`, D-2-15): `LOGGABLE_FIELDS` names `link_id`
    // and `attempts` and nothing else, and a key, a hostname or a slug stays off the line.
    // `attempts: 1` is the truth here, since this pass makes exactly one.
    logger.error(
      {
        code: CACHE_INVALIDATION_FAILED_CODE,
        link_id: linkId,
        attempts: 1,
      },
      CACHE_INVALIDATION_SECOND_PASS_FAILED_MESSAGE,
    );
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
