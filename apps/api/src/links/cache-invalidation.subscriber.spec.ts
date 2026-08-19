/**
 * STORY-2-04's mechanism with no server and no database: which keys a mutation deletes (the
 * invalidation table in `redirect-cache.md`, row by row), the retry schedule, the one line a
 * still-failing deletion writes, and the deployment that declared no Redis. TASK-2-08.
 *
 * Contract: docs/contracts/redirect-cache.md ("Invalidation", "On failure" as amended
 *           2026-08-19), link-mutation-events.md ("Two phases"), logging-and-headers.md
 *           ("A field reaches a line only if it is named").
 * ADR: adr-0008 (deletion, not expiry), adr-0012; D-2-15 (what the failure line carries).
 *
 * WHAT IS HERE AND WHAT IS IN `test/links/cache-invalidation.int-spec.ts`. The table and the
 * schedule are decisions this file can settle against a fake in milliseconds, so it does;
 * what only a live Redis can answer (that the key Redis actually holds under the shipped TTL
 * of 3600 s is gone within 5 s of the commit, and that a server refusing writes produces this
 * failure path rather than a hang) is asserted there.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

import { RedirectCacheUnavailableError } from '../cache/redirect-cache';
import type { CachedHost, CachedLink, RedirectCache } from '../cache/redirect-cache';
import { UnavailableRedirectCache } from '../cache/unavailable-redirect-cache';
import { LOGGABLE_FIELDS, logger } from '../observability/logger';

import {
  CACHE_INVALIDATION_FAILED_CODE,
  CACHE_INVALIDATOR_NAME,
  CacheInvalidationSubscriber,
  forgetCacheInvalidatorRegistration,
  INVALIDATION_RETRY_DELAYS_MS,
  keysToInvalidate,
} from './cache-invalidation.subscriber';
import {
  clearLinkMutationSubscribers,
  onLinkMutated,
  runAfterCommitSubscribers,
} from './link-mutation.events';
import type { LinkMutation, LinkMutationAction, LinkSnapshot } from './link-mutation.events';

const HOSTNAME = 'localhost';

const SNAPSHOT: LinkSnapshot = {
  id: '11111111-1111-4111-8111-111111111111',
  tenantId: '22222222-2222-4222-8222-222222222222',
  workspaceId: '33333333-3333-4333-8333-333333333333',
  domainId: '44444444-4444-4444-8444-444444444444',
  hostname: HOSTNAME,
  slug: 'spring9',
  destinationUrl: 'https://example.test/a',
  expiresAt: null,
  activatesAt: null,
};

function mutation(
  action: LinkMutationAction,
  before: LinkSnapshot | null,
  after: LinkSnapshot | null,
): LinkMutation {
  return {
    action,
    linkId: SNAPSHOT.id,
    actorId: 'user_1',
    tenantId: SNAPSHOT.tenantId,
    occurredAt: new Date('2026-08-19T12:00:00.000Z'),
    before,
    after,
  };
}

/** What the subscriber calls, and the only method any test here drives. */
interface DeletionLog {
  readonly calls: Array<{ hostname: string; slug: string; at: number }>;
}

/**
 * A cache whose `delLink` fails for the first `failures` calls and resolves afterwards, and
 * that records WHEN each call happened. The timestamps are what turn "it retried" into "it
 * retried at 200 ms and at 1000 ms", which is the part of the contract a caller depends on:
 * a subscriber that retried immediately three times would satisfy every other assertion here
 * and would spend its whole schedule inside one failed round trip.
 */
function fakeCache(failures: number): RedirectCache & DeletionLog {
  const calls: Array<{ hostname: string; slug: string; at: number }> = [];
  let seen = 0;

  return {
    calls,
    async getHost(): Promise<CachedHost | 'miss' | 'unavailable'> {
      return 'unavailable';
    },
    async setHost(): Promise<void> {
      return undefined;
    },
    async delHost(): Promise<void> {
      return undefined;
    },
    async getLink(): Promise<CachedLink | 'miss' | 'unavailable'> {
      return 'unavailable';
    },
    async setLink(): Promise<void> {
      return undefined;
    },
    async delLink(hostname: string, slug: string): Promise<void> {
      calls.push({ hostname, slug, at: Date.now() });
      seen += 1;

      if (seen <= failures) {
        throw new RedirectCacheUnavailableError('the redirect cache is not connected');
      }
    },
  };
}

function subscriberOver(cache: RedirectCache): CacheInvalidationSubscriber {
  return new CacheInvalidationSubscriber(cache);
}

beforeEach(() => {
  clearLinkMutationSubscribers();
  forgetCacheInvalidatorRegistration();
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the invalidation table: which keys a mutation deletes (redirect-cache.md)', () => {
  it('created deletes the after key, which is what removes the negative entry a scan left', async () => {
    const cache = fakeCache(0);

    await subscriberOver(cache).handle(mutation('created', null, SNAPSHOT), null);

    expect(cache.calls.map(({ hostname, slug }) => ({ hostname, slug }))).toEqual([
      { hostname: HOSTNAME, slug: 'spring9' },
    ]);
  });

  it('a destination change deletes the one key, because the pair did not move', async () => {
    const cache = fakeCache(0);
    const after = { ...SNAPSHOT, destinationUrl: 'https://example.test/b' };

    await subscriberOver(cache).handle(mutation('updated', SNAPSHOT, after), null);

    expect(cache.calls.map(({ slug }) => slug)).toEqual(['spring9']);
  });

  it('a slug change deletes BOTH keys, old first', async () => {
    // The old key is the one a visitor is holding a URL for, so it goes first; without it the
    // pre-edit record answers that URL for the rest of the hour.
    const cache = fakeCache(0);
    const after = { ...SNAPSHOT, slug: 'summer7' };

    await subscriberOver(cache).handle(mutation('updated', SNAPSHOT, after), null);

    expect(cache.calls.map(({ slug }) => slug)).toEqual(['spring9', 'summer7']);
  });

  it('a hostname change deletes both keys too: the key is the PAIR, not the slug', async () => {
    // Nothing in item 2 moves a link between domains (every link sits on the seeded system
    // default), so this row is not reachable through the routes yet. It is asserted because
    // the rule is `(hostname, slug)` and item 3's multi-domain links reach it without
    // touching this file.
    const cache = fakeCache(0);
    const after = { ...SNAPSHOT, hostname: 'links.example.test' };

    await subscriberOver(cache).handle(mutation('updated', SNAPSHOT, after), null);

    expect(cache.calls.map(({ hostname, slug }) => `${hostname}:${slug}`)).toEqual([
      'localhost:spring9',
      'links.example.test:spring9',
    ]);
  });

  it('an expiry or activation change deletes the key, so the window is not waited out', async () => {
    const cache = fakeCache(0);
    const after = { ...SNAPSHOT, expiresAt: new Date('2026-08-19T11:00:00.000Z') };

    await subscriberOver(cache).handle(mutation('updated', SNAPSHOT, after), null);

    expect(cache.calls).toHaveLength(1);
  });

  it('a no-op PATCH still invalidates: the audit writer skips one, the invalidator does not', async () => {
    // `link-mutation-events.md`'s firing rule sends a mutation whose images are deep-equal.
    // Deleting a key that did not need deleting costs one Postgres query on the next request;
    // deciding not to delete it, on an equality this file computes rather than the database,
    // is how a stale record survives an edit that DID change something the images share.
    const cache = fakeCache(0);

    await subscriberOver(cache).handle(mutation('updated', SNAPSHOT, { ...SNAPSHOT }), null);

    expect(cache.calls).toHaveLength(1);
  });

  it('deleted deletes the before key, the only image a delete carries', async () => {
    const cache = fakeCache(0);

    await subscriberOver(cache).handle(mutation('deleted', SNAPSHOT, null), null);

    expect(cache.calls.map(({ slug }) => slug)).toEqual(['spring9']);
  });

  it('the key set is the deduplicated union of the two images', async () => {
    // The table above as one function, so a reader can check the rows without a fake.
    expect(keysToInvalidate(mutation('updated', SNAPSHOT, { ...SNAPSHOT, slug: 'summer7' }))).toEqual([
      { hostname: HOSTNAME, slug: 'spring9' },
      { hostname: HOSTNAME, slug: 'summer7' },
    ]);
    expect(keysToInvalidate(mutation('created', null, SNAPSHOT))).toEqual([
      { hostname: HOSTNAME, slug: 'spring9' },
    ]);
    expect(keysToInvalidate(mutation('deleted', SNAPSHOT, null))).toEqual([
      { hostname: HOSTNAME, slug: 'spring9' },
    ]);
  });
});

describe('the failure path: retry at 200 ms and 1000 ms, then one line (D-2-15)', () => {
  it('the schedule is the contract’s two delays and nothing else', () => {
    expect(INVALIDATION_RETRY_DELAYS_MS).toEqual([200, 1000]);
  });

  it('a deletion that succeeds on the third attempt logs nothing and throws nothing', async () => {
    vi.useFakeTimers();
    const error = vi.spyOn(logger, 'error').mockReturnValue(undefined);
    const cache = fakeCache(2);
    const started = Date.now();

    const settled = subscriberOver(cache).handle(mutation('created', null, SNAPSHOT), null);

    await vi.advanceTimersByTimeAsync(1200);
    await expect(settled).resolves.toBeUndefined();

    expect(cache.calls.map(({ at }) => at - started)).toEqual([0, 200, 1200]);
    expect(error).not.toHaveBeenCalled();
  });

  it('still failing after the schedule: ONE line, carrying code, link_id and attempts and nothing else', async () => {
    vi.useFakeTimers();
    const error = vi.spyOn(logger, 'error').mockReturnValue(undefined);
    const cache = fakeCache(Number.POSITIVE_INFINITY);

    const settled = subscriberOver(cache).handle(mutation('updated', SNAPSHOT, SNAPSHOT), null);
    // The subscriber rethrows, and an unhandled rejection between here and the assertion
    // below would fail the run rather than this test. Attached before the timers move.
    const outcome = settled.then(
      () => 'resolved' as const,
      (thrown: unknown) => thrown,
    );

    await vi.advanceTimersByTimeAsync(1200);

    // THE THROW IS THE DESIGNED END OF THIS PATH, not an escape from it: the dispatcher
    // catches it, logs `link_mutation_subscriber_failed` with no message, and runs the
    // subscribers after this one (`link-mutation.events.ts`). The write already committed.
    expect(await outcome).toBeInstanceOf(RedirectCacheUnavailableError);

    expect(error).toHaveBeenCalledOnce();
    const [record] = error.mock.calls[0];

    expect(record).toEqual({
      code: CACHE_INVALIDATION_FAILED_CODE,
      link_id: SNAPSHOT.id,
      attempts: 3,
    });
  });

  it('the line names no key, no slug and no hostname, whatever the record is serialised by', async () => {
    // GC-G, and asserted on the BYTES of the record rather than on its keys: a nested
    // container, a stringified key, or a message interpolating the slug would all pass a
    // key-by-key check. `LOGGABLE_FIELDS` would censor an unnamed field on the way out, but
    // the field would be on the call, and this subscriber is the one call site the contract
    // wrote a sentence about.
    vi.useFakeTimers();
    const error = vi.spyOn(logger, 'error').mockReturnValue(undefined);
    const cache = fakeCache(Number.POSITIVE_INFINITY);

    const settled = subscriberOver(cache).handle(mutation('deleted', SNAPSHOT, null), null);
    const outcome = settled.catch(() => undefined);

    await vi.advanceTimersByTimeAsync(1200);
    await outcome;

    const [record, message] = error.mock.calls[0];
    const line = `${JSON.stringify(record)} ${String(message)}`;

    expect(line).not.toContain(SNAPSHOT.slug);
    expect(line).not.toContain(SNAPSHOT.hostname);
    expect(line).not.toContain(SNAPSHOT.destinationUrl);
    expect(line).not.toContain('rdr:v1');
    // A fixed context string, so the operator gets one human-written field (the contract's
    // "Always pass a fixed context string").
    expect(typeof message).toBe('string');
  });

  it('only the key that failed is retried, so a partial failure does not re-delete what is gone', async () => {
    vi.useFakeTimers();
    vi.spyOn(logger, 'error').mockReturnValue(undefined);

    // Fails the FIRST call of every round, which is the old key; the new key's deletion
    // succeeds on round one and must not be attempted again.
    const calls: Array<{ hostname: string; slug: string }> = [];
    let round = 0;
    const cache: RedirectCache = {
      ...fakeCache(0),
      async delLink(hostname: string, slug: string): Promise<void> {
        calls.push({ hostname, slug });

        if (slug === 'spring9' && round < 1) {
          round += 1;
          throw new RedirectCacheUnavailableError('the redirect cache is not connected');
        }
      },
    };

    const settled = new CacheInvalidationSubscriber(cache).handle(
      mutation('updated', SNAPSHOT, { ...SNAPSHOT, slug: 'summer7' }),
      null,
    );

    await vi.advanceTimersByTimeAsync(200);
    await expect(settled).resolves.toBeUndefined();

    expect(calls.map(({ slug }) => slug)).toEqual(['spring9', 'summer7', 'spring9']);
  });

  it('LOGGABLE_FIELDS names both fields, or the line ships as [redacted] with every gate green', () => {
    // Step 2 of "Logging a new field is three steps, and the third is the one people skip"
    // (`logging-and-headers.md`). Step 3 is the never-allowlist, which names neither: a link
    // id is an identifier the operator already holds from the API response, and `attempts` is
    // a small integer.
    expect({ link_id: LOGGABLE_FIELDS.has('link_id'), attempts: LOGGABLE_FIELDS.has('attempts') }).toEqual({
      link_id: true,
      attempts: true,
    });
  });
});

describe('a deployment that declared no Redis', () => {
  it('every deletion resolves under UnavailableRedirectCache, and no failure line fires', async () => {
    // The binding when `REDIS_URL` is unset. There is no cache to hold a stale key, so the
    // invalidation has genuinely succeeded; a `cache_invalidation_failed` line per mutation
    // here would report a condition that is not a failure, and the boot warn already said
    // the deployment has no cache, once.
    const error = vi.spyOn(logger, 'error').mockReturnValue(undefined);

    await expect(
      subscriberOver(new UnavailableRedirectCache()).handle(
        mutation('updated', SNAPSHOT, { ...SNAPSHOT, slug: 'summer7' }),
        null,
      ),
    ).resolves.toBeUndefined();

    expect(error).not.toHaveBeenCalled();
  });
});

describe('registration', () => {
  it('onModuleInit registers it after commit, under the name the registry refuses twice', async () => {
    const cache = fakeCache(0);
    const subscriber = subscriberOver(cache);

    expect({ name: subscriber.name, phase: subscriber.phase }).toEqual({
      name: CACHE_INVALIDATOR_NAME,
      phase: 'after-commit',
    });

    subscriber.onModuleInit();

    // Dispatched by the after-commit phase, which is the wiring `LinksModule` provides and
    // the reason the handler above is never called from `links.service.ts`.
    await runAfterCommitSubscribers(mutation('created', null, SNAPSHOT));

    expect(cache.calls).toHaveLength(1);
  });

  it('a second application context in one process rebinds the registration instead of doubling it', async () => {
    // THE SHAPE THAT FOUND THIS: `test/invitations/invitations-mail.int-spec.ts` boots two
    // applications from `AppModule` to compare two mail transports, so `onModuleInit` runs
    // twice in one process. Registering twice is what the registry refuses (each key would be
    // deleted twice and the second failure would hide behind the first success), and letting
    // that refusal through turned an unrelated suite red.
    //
    // The mutation dispatches ONCE, and it dispatches through the SECOND context's cache: the
    // first context's client may already be closed, and the requests now running belong to
    // the second.
    const first = fakeCache(0);
    const second = fakeCache(0);

    subscriberOver(first).onModuleInit();
    subscriberOver(second).onModuleInit();

    await runAfterCommitSubscribers(mutation('created', null, SNAPSHOT));

    expect({ first: first.calls.length, second: second.calls.length }).toEqual({
      first: 0,
      second: 1,
    });
  });

  it('the registry itself still refuses a duplicate name, which is the invariant above', () => {
    subscriberOver(fakeCache(0)).onModuleInit();

    // Registered by hand, past the dedupe: the guard this file relies on is the registry's own
    // and it is still armed. A dedupe that worked by swallowing the registry's throw would
    // pass every test above and leave nothing standing behind it.
    expect(() => {
      onLinkMutated({
        name: CACHE_INVALIDATOR_NAME,
        phase: 'after-commit',
        handle: () => Promise.resolve(),
      });
    }).toThrow(CACHE_INVALIDATOR_NAME);
  });
});
