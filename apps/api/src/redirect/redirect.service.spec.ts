import { describe, expect, it, vi } from 'vitest';

import type { CachedHost, CachedLink, RedirectCache } from '../cache/redirect-cache';
import { logger } from '../observability/logger';

import { toCachedHost, toCachedLink } from './cache-records';
import type { RedirectBrandingPort } from './ports/branding.port';
import { RedirectService } from './redirect.service';
import type { RedirectReadRepository, RedirectRead } from './redirect-read.repository';
import type { ResolvedHost, ResolvedLink } from './redirect.types';

/**
 * TASK-2-06 (steps 0 to 7) and TASK-2-07 (the cache in front of steps 2 and 3).
 * AC-2-15, AC-2-16, AC-2-17, AC-2-26, AC-2-27, AC-2-29, and step 6's fallback branch.
 *
 * Contract: `docs/contracts/redirect-resolution.md` ("Decision order", steps 1 to 7),
 * `redirect-cache.md` ("Interface", the three read values), `branding.md` ("Rendering
 * rules"). ADR-0008, ADR-0009, ADR-0011; D-2-13, D-2-14.
 *
 * ============================================================================
 * THE REPOSITORY IS A STUB HERE AND A REAL POSTGRES READ IN THE INTEGRATION SUITE.
 * ============================================================================
 *
 * What this file measures is the DECISION, which is the part with seven ordered steps and
 * one 404 for six different reasons. Whether the two statements read the right rows is
 * `test/redirect/redirect.int-spec.ts`'s, against the shipped policies: a stub cannot
 * measure a policy and a live database cannot make `resolveHost` return a host with a
 * fallback URL, because no branding column exists in item 2.
 *
 * `calls` counts I/O. Step 0's whole claim is "before any I/O", and the only way to see
 * the difference between a 404 that queried and a 404 that did not is to count. From
 * TASK-2-07 it counts per METHOD as well, because "a miss costs what a cold resolve cost"
 * is a statement about WHICH read was issued and not only about how many.
 */

const HOST: ResolvedHost = {
  domainId: '00000000-0000-4000-8000-0000000000d1',
  tenantId: '00000000-0000-4000-8000-0000000000a1',
  workspaceId: '00000000-0000-4000-8000-0000000000b1',
  branding: null,
};

const LINK: ResolvedLink = {
  id: '00000000-0000-4000-8000-0000000000e1',
  destinationUrl: 'https://example.test/spring?utm_source=x&b=1',
  domainId: HOST.domainId,
  workspaceId: HOST.workspaceId,
  tenantId: HOST.tenantId,
  expiresAt: null,
  activatesAt: null,
};

const NOW = new Date('2026-08-19T12:00:00.000Z');

/**
 * The stream the shared logger was constructed with, reached the way
 * `request-log.interceptor.spec.ts` reaches it: `logger[Symbol('pino.stream')]` is an own
 * property of the root instance, so one spy sees every line the process would write.
 */
function pinoStreamOf(instance: object): { write(chunk: string): unknown } {
  const symbol = Object.getOwnPropertySymbols(instance).find(
    (candidate) => candidate.description === 'pino.stream',
  );

  if (symbol === undefined) {
    throw new Error('the pino stream symbol was not found on the shared logger; nothing below could capture a line');
  }

  return (instance as unknown as Record<symbol, { write(chunk: string): unknown }>)[symbol];
}

/** What each cached key answered. Absent is `'unavailable'`, which is the cold key. */
interface Seeded {
  readonly host?: CachedHost | 'miss' | 'unavailable';
  readonly link?: CachedLink | 'miss' | 'unavailable';
  /**
   * A binding that breaks its own contract by REJECTING. `redirect-cache.ts` answers
   * `'unavailable'` for every failure it can meet, so nothing shipped rejects here; the
   * cache is bound by another module all the same, and GC-O's "no visitor 5xx, and a Redis
   * problem never 404s a live link" has to hold against the implementation this module does
   * not own, which is why the controller guards `enqueue` too.
   */
  readonly rejects?: boolean;
}

interface CacheStub {
  readonly cache: RedirectCache;
  /** `'host'` then `'link'`, in the order they were asked for: step 2 precedes step 3. */
  readonly gets: string[];
  readonly writes: { key: 'host' | 'link'; value: CachedHost | CachedLink | 'miss' }[];
}

function cacheStub(seed: Seeded): CacheStub {
  const gets: string[] = [];
  const writes: { key: 'host' | 'link'; value: CachedHost | CachedLink | 'miss' }[] = [];

  const refuse = (): never => {
    throw new Error('this cache binding rejects, which its contract forbids');
  };

  const cache: RedirectCache = {
    getHost: async () => {
      gets.push('host');

      return seed.rejects === true ? refuse() : (seed.host ?? 'unavailable');
    },
    setHost: async (_hostname, value) => {
      if (seed.rejects === true) refuse();
      writes.push({ key: 'host', value });
    },
    delHost: async () => undefined,
    getLink: async () => {
      gets.push('link');

      return seed.rejects === true ? refuse() : (seed.link ?? 'unavailable');
    },
    setLink: async (_hostname, _slug, value) => {
      if (seed.rejects === true) refuse();
      writes.push({ key: 'link', value });
    },
    delLink: async () => undefined,
  };

  return { cache, gets, writes };
}

interface Stub {
  readonly service: RedirectService;
  /** Every Postgres round trip, whichever repository method issued it. */
  readonly reads: () => number;
  /** The same count, split by method: which read a given cache state costs. */
  readonly calls: () => { byHostAndSlug: number; host: number; hostKeepingLink: number; linkOnDomain: number };
  readonly cache: CacheStub;
}

interface Options {
  readonly branding?: RedirectBrandingPort;
  readonly cached?: Seeded;
  /** What `resolveLinkOnDomain` finds, when it differs from `result.link`. */
  readonly linkOnDomain?: ResolvedLink | null;
}

function serviceWith(result: RedirectRead, options: Options = {}): Stub {
  const calls = { byHostAndSlug: 0, host: 0, hostKeepingLink: 0, linkOnDomain: 0 };
  const cache = cacheStub(options.cached ?? {});

  const repository = {
    resolveByHostAndSlug: vi.fn(async (): Promise<RedirectRead> => {
      calls.byHostAndSlug += 1;

      return result;
    }),
    resolveHost: vi.fn(async (): Promise<ResolvedHost | null> => {
      calls.host += 1;

      return result.host;
    }),
    /**
     * The shipped conditional: statement 2 is issued inside the same transaction only when
     * the resolved domain is not the one the caller's cached record names, and `link` is null
     * when it was never issued. Modelled here rather than stubbed flat, because the whole
     * point of the method is which statements it does and does not issue.
     */
    resolveHostKeepingLinkOn: vi.fn(async (_hostname: string, _slug: string, keptDomainId: string): Promise<RedirectRead> => {
      calls.hostKeepingLink += 1;

      if (result.host === null || result.host.domainId === keptDomainId) {
        return { host: result.host, link: null };
      }

      return {
        host: result.host,
        link: options.linkOnDomain === undefined ? result.link : options.linkOnDomain,
      };
    }),
    resolveLinkOnDomain: vi.fn(async (): Promise<ResolvedLink | null> => {
      calls.linkOnDomain += 1;

      return options.linkOnDomain === undefined ? result.link : options.linkOnDomain;
    }),
  } as unknown as RedirectReadRepository;

  return {
    service: new RedirectService(repository, cache.cache, options.branding ?? null),
    reads: () => calls.byHostAndSlug + calls.host + calls.hostKeepingLink + calls.linkOnDomain,
    calls: () => ({ ...calls }),
    cache,
  };
}

/** The cached forms of the two fixtures above, so a hit and a row cannot disagree. */
const CACHED_HOST = toCachedHost(HOST);
const CACHED_LINK = toCachedLink(LINK) as CachedLink;

describe('RedirectService, step 0: the shape fast-reject (D-2-13, AC-2-17)', () => {
  /**
   * THE INVARIANT THIS FILE EXISTS FOR, AND IT IS A SECURITY PROPERTY RATHER THAN A
   * PERFORMANCE ONE. The cache builds its key from the slug WITHOUT normalising, by design
   * (`redirect-cache.md`: "this function does not normalise and must not start"), and
   * redirect traffic is never rate limited at any rate (AC-2-19, AC-86). A path segment
   * that reached the cache before it was validated would let a stranger mint one key per
   * request in the shared `sk:{namespace}:rdr:v1:` namespace, each holding a MISS sentinel
   * for 60 seconds, at whatever rate they can open sockets. Validating first bounds the
   * namespace to the strings a link could actually own.
   */
  it.each([
    ['favicon.ico', 'a dot is outside SLUG_PATTERN'],
    ['', 'shorter than SLUG_MIN_LENGTH'],
    ['-leading', 'a leading separator'],
    ['trailing-', 'a trailing separator'],
    ['has space', 'a space'],
    ['sl/ash', 'a separator character'],
    ['über', 'a non-ASCII letter'],
    ['a'.repeat(65), 'longer than SLUG_MAX_LENGTH'],
  ])('answers the default 404 for %s (%s) with no read at all', async (segment) => {
    const stub = serviceWith({ host: HOST, link: LINK });

    const decision = await stub.service.resolve('links.example.test', segment, NOW);

    expect(decision).toEqual({ kind: 'not-found', status: 404, host: null });
    expect(stub.reads()).toBe(0);
    // TASK-2-07: and no Redis call either, which is the half step 0 exists for.
    expect(stub.cache.gets).toEqual([]);
  });

  it('accepts a conforming slug and does read', async () => {
    const stub = serviceWith({ host: HOST, link: LINK });

    await stub.service.resolve('links.example.test', 'spring-sale-2026', NOW);

    expect(stub.reads()).toBe(1);
  });
});

describe('RedirectService, step 1: hostname normalisation', () => {
  it('lowercases and strips the port before the read (any Host casing, any port)', async () => {
    const repository = {
      resolveByHostAndSlug: vi.fn(async (): Promise<RedirectRead> => ({ host: HOST, link: LINK })),
      resolveHost: vi.fn(),
    } as unknown as RedirectReadRepository;
    // A cold cache, so the normalised hostname reaches the repository rather than a record.
    const service = new RedirectService(repository, cacheStub({}).cache, null);

    await service.resolve('Links.EXAMPLE.test:3001', 'abc1234', NOW);

    expect(repository.resolveByHostAndSlug).toHaveBeenCalledWith('links.example.test', 'abc1234');
  });

  it('answers the default 404 with no read when the Host header is absent', async () => {
    const stub = serviceWith({ host: HOST, link: LINK });

    expect(await stub.service.resolve(undefined, 'abc1234', NOW)).toEqual({
      kind: 'not-found',
      status: 404,
      host: null,
    });
    expect(stub.reads()).toBe(0);
    // TASK-2-07: and no Redis call either, which is the half step 0 exists for.
    expect(stub.cache.gets).toEqual([]);
  });

  it('answers the default 404 with no read when the Host header is not a hostname', async () => {
    const stub = serviceWith({ host: HOST, link: LINK });

    expect(await stub.service.resolve('not a host name', 'abc1234', NOW)).toEqual({
      kind: 'not-found',
      status: 404,
      host: null,
    });
    expect(stub.reads()).toBe(0);
    // TASK-2-07: and no Redis call either, which is the half step 0 exists for.
    expect(stub.cache.gets).toEqual([]);
  });
});

describe('RedirectService, steps 2 to 6: the decision', () => {
  it('step 2: an unresolved hostname yields the DEFAULT 404, with no branding to reach for', async () => {
    const stub = serviceWith({ host: null, link: null });

    expect(await stub.service.resolve('unknown.example.test', 'abc1234', NOW)).toEqual({
      kind: 'not-found',
      status: 404,
      host: null,
    });
  });

  it('step 3: a hostname that resolved and a slug that did not yields a 404 carrying the host', async () => {
    const stub = serviceWith({ host: HOST, link: null });

    expect(await stub.service.resolve('links.example.test', 'abc1234', NOW)).toEqual({
      kind: 'not-found',
      status: 404,
      host: HOST,
    });
  });

  it('step 5: an active link yields a 302 whose location is the destination byte for byte', async () => {
    const stub = serviceWith({ host: HOST, link: LINK });

    expect(await stub.service.resolve('links.example.test', 'abc1234', NOW)).toEqual({
      kind: 'redirect',
      status: 302,
      location: LINK.destinationUrl,
      link: LINK,
    });
  });

  /**
   * ADR-0009 / AC-2-26: the window is evaluated on EVERY read from the shared
   * `isLinkActive`, never reimplemented here, and an inactive link does not fall through
   * to a second lookup.
   */
  it('step 4: an expired link yields the 404, from the record already read', async () => {
    const stub = serviceWith({
      host: HOST,
      link: { ...LINK, expiresAt: new Date(NOW.getTime() - 1) },
    });

    const decision = await stub.service.resolve('links.example.test', 'abc1234', NOW);

    expect(decision.kind).toBe('not-found');
    expect(stub.reads()).toBe(1);
  });

  it('step 4: a link that has not activated yet yields the 404, and the 302 once it has', async () => {
    const activatesAt = new Date(NOW.getTime() + 60_000);
    const early = serviceWith({ host: HOST, link: { ...LINK, activatesAt } });
    const late = serviceWith({ host: HOST, link: { ...LINK, activatesAt } });

    expect((await early.service.resolve('links.example.test', 'abc1234', NOW)).kind).toBe(
      'not-found',
    );
    expect((await late.service.resolve('links.example.test', 'abc1234', activatesAt)).kind).toBe(
      'redirect',
    );
  });

  it('step 4: both timestamps null is active', async () => {
    const stub = serviceWith({ host: HOST, link: LINK });

    expect((await stub.service.resolve('links.example.test', 'abc1234', NOW)).kind).toBe('redirect');
  });
});

describe('RedirectService, step 6: the branding port (ADR-0011, D-2-11)', () => {
  /**
   * The port is UNBOUND in item 2 and the constructor takes `null` for it, which is what
   * `@Optional()` hands over. Every 404 below is therefore the default page, and the
   * fallback branch is exercised with a stubbed port because no branding column exists to
   * plant a real one in (the branch ships tested rather than untested until item 3).
   */
  it('renders the default 404 with the port unbound, and never asks for branding on a 302', async () => {
    const port: RedirectBrandingPort = { getForDomain: vi.fn(async () => null) };
    const stub = serviceWith({ host: HOST, link: LINK }, { branding: port });

    expect((await stub.service.resolve('links.example.test', 'abc1234', NOW)).kind).toBe('redirect');
    expect(port.getForDomain).not.toHaveBeenCalled();
  });

  it('asks the port for branding only on the not-found arm, with the domain and tenant ids', async () => {
    const port: RedirectBrandingPort = { getForDomain: vi.fn(async () => null) };
    const stub = serviceWith({ host: HOST, link: null }, { branding: port });

    await stub.service.resolve('links.example.test', 'abc1234', NOW);

    expect(port.getForDomain).toHaveBeenCalledWith(HOST.domainId, HOST.tenantId);
  });

  it('yields the fallback 302 when branding carries a fallback URL (AC-76, Amendment A-4)', async () => {
    const branding = { logoUrl: null, brandColor: null, fallbackUrl: 'https://example.test/gone' };
    const port: RedirectBrandingPort = { getForDomain: vi.fn(async () => branding) };
    const stub = serviceWith({ host: HOST, link: null }, { branding: port });

    expect(await stub.service.resolve('links.example.test', 'abc1234', NOW)).toEqual({
      kind: 'fallback',
      status: 302,
      location: 'https://example.test/gone',
      host: { ...HOST, branding },
    });
  });

  it('yields the branded 404 when branding is present without a fallback URL', async () => {
    const branding = { logoUrl: 'https://cdn.example.test/l.png', brandColor: '#112233', fallbackUrl: null };
    const port: RedirectBrandingPort = { getForDomain: vi.fn(async () => branding) };
    const stub = serviceWith({ host: HOST, link: null }, { branding: port });

    expect(await stub.service.resolve('links.example.test', 'abc1234', NOW)).toEqual({
      kind: 'not-found',
      status: 404,
      host: { ...HOST, branding },
    });
  });

  /**
   * GC-O: no visitor 5xx. A port implementation is item 3's code and this module cannot
   * see it; a throw from it must degrade to the default page rather than reach the
   * controller's catch-all as an unexplained failure of the whole resolution.
   */
  it('degrades to the default 404 when the port throws, and says so on one line carrying no slug', async () => {
    const port: RedirectBrandingPort = {
      getForDomain: vi.fn(async () => {
        throw new Error('branding is down');
      }),
    };
    const stub = serviceWith({ host: HOST, link: null }, { branding: port });
    const written: string[] = [];
    const stream = pinoStreamOf(logger);
    const spy = vi.spyOn(stream, 'write').mockImplementation((chunk: string) => {
      written.push(chunk);

      return true;
    });

    try {
      expect(await stub.service.resolve('links.example.test', 'abc1234', NOW)).toEqual({
        kind: 'not-found',
        status: 404,
        host: HOST,
      });
    } finally {
      spy.mockRestore();
    }

    const line = JSON.parse(written.join('')) as Record<string, unknown>;

    expect(line.code).toBe('redirect_branding_unavailable');
    expect(line.route).toBe('/:slug');
    // GC-G: the message is withheld (`includeMessage: false`) and no request-derived value
    // is on the line, neither the slug nor the hostname.
    expect(line.err_message).toBeUndefined();
    expect(written.join('')).not.toContain('abc1234');
    expect(written.join('')).not.toContain('links.example.test');
  });
});

/* ========================================================================== *
 * TASK-2-07: the cache in front of steps 2 and 3.
 * ========================================================================== */

/**
 * ============================================================================
 * WHAT EACH CACHE STATE COSTS, IN READS AND IN WHICH READ.
 * ============================================================================
 *
 * `redirect-cache.md` invariant 4 is "a cache hit performs zero Postgres queries", and the
 * card's other half is that a MISS costs exactly what the cold resolve cost before the cache
 * existed and no more. Both are counts, so both are counted here rather than described, and
 * the integration suite then counts the same thing in STATEMENTS against a real Postgres
 * (`dbQueryCounter`): four for the combined read, three for either single one, zero for a
 * hit.
 *
 * The states and their answers:
 *
 *   host record + link record   -> 0 reads. The whole point.
 *   host record + link MISS     -> 0 reads, 404. A cached negative answers the request.
 *   host MISS                   -> 0 reads, 404, and the LINK KEY IS NEVER READ.
 *   host cold + link cold       -> ONE `resolveByHostAndSlug`: one transaction, two
 *                                 statements, which is wave 3's cost unchanged.
 *   host cold + link cached     -> `resolveHost` alone. The host TTL is 300 s against the
 *                                 link's 3600, so this is an ordinary state, not an edge.
 *   host record + link cold     -> `resolveLinkOnDomain` alone, on the cached domain id.
 */
describe('TASK-2-07: a cache hit costs no read at all (AC-2-15)', () => {
  it('answers the 302 from the two cached records, with no repository call of any kind', async () => {
    const stub = serviceWith(
      { host: HOST, link: LINK },
      { cached: { host: CACHED_HOST, link: CACHED_LINK } },
    );

    const decision = await stub.service.resolve('links.example.test', 'abc1234', NOW);

    expect(decision).toEqual({ kind: 'redirect', status: 302, location: LINK.destinationUrl, link: LINK });
    expect(stub.calls()).toEqual({ byHostAndSlug: 0, host: 0, hostKeepingLink: 0, linkOnDomain: 0 });
    expect(stub.cache.gets).toEqual(['host', 'link']);
  });

  /**
   * AC-2-15 names the click enqueue's tenant id explicitly, because it is the one field a
   * naive cached record would have left to a lookup. The decision carries the cached
   * record's `t`, `dm` and `id`, which is exactly what the controller hands the sink.
   */
  it('carries the ids the click sink needs, from the cached record and not from a lookup', async () => {
    const stub = serviceWith(
      { host: HOST, link: LINK },
      { cached: { host: CACHED_HOST, link: CACHED_LINK } },
    );

    const decision = await stub.service.resolve('links.example.test', 'abc1234', NOW);

    expect(decision.kind === 'redirect' ? decision.link : null).toMatchObject({
      id: LINK.id,
      domainId: LINK.domainId,
      tenantId: LINK.tenantId,
    });
    expect(stub.reads()).toBe(0);
  });

  /**
   * ADR-0009 AND AC-2-26. The window is decided from the CACHED record, and an inactive hit
   * does not fall through to Postgres for a second opinion. The TTL clamp is hygiene: this
   * is the mechanism, and deleting it on the reasoning that an expired record would have
   * expired in Redis anyway is the defect ADR-0009 was written to prevent.
   */
  it('decides the validity window from the cached record, and an expired hit reads nothing', async () => {
    const expired = toCachedLink({ ...LINK, expiresAt: new Date(NOW.getTime() - 1) }) as CachedLink;
    const stub = serviceWith(
      { host: HOST, link: LINK },
      { cached: { host: CACHED_HOST, link: expired } },
    );

    const decision = await stub.service.resolve('links.example.test', 'abc1234', NOW);

    expect(decision).toEqual({ kind: 'not-found', status: 404, host: HOST });
    expect(stub.reads()).toBe(0);
  });

  it('answers the 404 from a cached negative link, with no read', async () => {
    const stub = serviceWith(
      { host: HOST, link: LINK },
      { cached: { host: CACHED_HOST, link: 'miss' } },
    );

    expect(await stub.service.resolve('links.example.test', 'abc1234', NOW)).toEqual({
      kind: 'not-found',
      status: 404,
      host: HOST,
    });
    expect(stub.reads()).toBe(0);
  });

  /**
   * A cached negative HOST ends the request at step 2, so the link key is not even read: one
   * Redis call, no query, the default page. That ordering is what keeps a scan of unknown
   * hostnames from minting a `rdr:` key per request as well as a `hst:` one.
   */
  it('answers the default 404 from a cached negative host, without reading the link key', async () => {
    const stub = serviceWith({ host: HOST, link: LINK }, { cached: { host: 'miss' } });

    expect(await stub.service.resolve('links.example.test', 'abc1234', NOW)).toEqual({
      kind: 'not-found',
      status: 404,
      host: null,
    });
    expect(stub.reads()).toBe(0);
    expect(stub.cache.gets).toEqual(['host']);
  });
});

describe('TASK-2-07: a miss costs the cold resolve and no more', () => {
  it('both keys cold: ONE combined read, and both records written back', async () => {
    const stub = serviceWith({ host: HOST, link: LINK });

    expect((await stub.service.resolve('links.example.test', 'abc1234', NOW)).kind).toBe('redirect');
    expect(stub.calls()).toEqual({ byHostAndSlug: 1, host: 0, hostKeepingLink: 0, linkOnDomain: 0 });
    expect(stub.cache.writes).toEqual([
      { key: 'host', value: CACHED_HOST },
      { key: 'link', value: CACHED_LINK },
    ]);
  });

  it('the host key expired under a live link key: one transaction, and the record is kept', async () => {
    const stub = serviceWith(
      { host: HOST, link: LINK },
      { cached: { host: 'unavailable', link: CACHED_LINK } },
    );

    expect((await stub.service.resolve('links.example.test', 'abc1234', NOW)).kind).toBe('redirect');
    expect(stub.calls()).toEqual({ byHostAndSlug: 0, host: 0, hostKeepingLink: 1, linkOnDomain: 0 });
    expect(stub.cache.writes).toEqual([{ key: 'host', value: CACHED_HOST }]);
  });

  it('the host key expired under a cached NEGATIVE: the host statement alone', async () => {
    const stub = serviceWith(
      { host: HOST, link: LINK },
      { cached: { host: 'unavailable', link: 'miss' } },
    );

    expect((await stub.service.resolve('links.example.test', 'abc1234', NOW)).kind).toBe('not-found');
    expect(stub.calls()).toEqual({ byHostAndSlug: 0, host: 1, hostKeepingLink: 0, linkOnDomain: 0 });
    expect(stub.cache.writes).toEqual([{ key: 'host', value: CACHED_HOST }]);
  });

  /**
   * THE SIX-STATEMENT SHAPE THAT MUST NOT EXIST. A cold host key under a cached record naming
   * another domain needs statement 1 to decide and statement 2 to replace the record, and both
   * go inside ONE transaction: resolving the host and then reading the link through a second
   * call would pay the two-statement preamble twice, which is the outcome reading both cache
   * keys up front exists to avoid. Unreachable while a link's domain cannot change, and
   * reachable the day domain reassignment ships, so it is measured now.
   */
  it('the host key expired under a record naming another domain: still ONE transaction', async () => {
    const elsewhere = toCachedLink({
      ...LINK,
      domainId: '00000000-0000-4000-8000-0000000000d9',
      destinationUrl: 'https://other.example.test/not-this-one',
    }) as CachedLink;
    const stub = serviceWith(
      { host: HOST, link: LINK },
      { cached: { host: 'unavailable', link: elsewhere } },
    );

    const decision = await stub.service.resolve('links.example.test', 'abc1234', NOW);

    expect(decision).toEqual({ kind: 'redirect', status: 302, location: LINK.destinationUrl, link: LINK });
    expect(stub.calls()).toEqual({ byHostAndSlug: 0, host: 0, hostKeepingLink: 1, linkOnDomain: 0 });
    // The row that replaced the stale record is written back over it.
    expect(stub.cache.writes).toEqual([
      { key: 'host', value: CACHED_HOST },
      { key: 'link', value: CACHED_LINK },
    ]);
  });

  it('the link key gone under a live host record: the link statement alone, on the cached domain', async () => {
    const stub = serviceWith({ host: HOST, link: LINK }, { cached: { host: CACHED_HOST } });

    expect((await stub.service.resolve('links.example.test', 'abc1234', NOW)).kind).toBe('redirect');
    expect(stub.calls()).toEqual({ byHostAndSlug: 0, host: 0, hostKeepingLink: 0, linkOnDomain: 1 });
    expect(stub.cache.writes).toEqual([{ key: 'link', value: CACHED_LINK }]);
  });

  it('caches the negative when the slug resolves to nothing', async () => {
    const stub = serviceWith({ host: HOST, link: null });

    expect((await stub.service.resolve('links.example.test', 'abc1234', NOW)).kind).toBe('not-found');
    expect(stub.cache.writes).toEqual([
      { key: 'host', value: CACHED_HOST },
      { key: 'link', value: 'miss' },
    ]);
  });

  /**
   * A hostname that resolves to no ACTIVE domain caches its negative at `hst:` and NOTHING at
   * `rdr:`. The host record is what the next request reads first, so a link key written under
   * a hostname that serves nothing would be a key nothing ever looks at, held for an hour.
   */
  it('caches the negative host and writes no link key for a hostname that resolves to nothing', async () => {
    const stub = serviceWith({ host: null, link: null });

    expect(await stub.service.resolve('links.example.test', 'abc1234', NOW)).toEqual({
      kind: 'not-found',
      status: 404,
      host: null,
    });
    expect(stub.cache.writes).toEqual([{ key: 'host', value: 'miss' }]);
  });

  /**
   * F-003's cache half. `resolveHost` is the only writer of a positive `hst:` record, and the
   * only host it can be handed is one statement 1 returned, a domain in state `active`,
   * because `AND state = 'active'` is part of the permitted statement shape. A domain in any
   * other state reaches this method as `null` and caches as MISS.
   */
  it('never writes a positive host record for a host that did not resolve', async () => {
    const stub = serviceWith({ host: null, link: null }, { cached: { link: CACHED_LINK } });

    await stub.service.resolve('links.example.test', 'abc1234', NOW);

    expect(stub.cache.writes.filter((write) => write.key === 'host')).toEqual([
      { key: 'host', value: 'miss' },
    ]);
  });

  /**
   * A bound that cannot be read is never cached. `isLinkActive` fails closed on it, so the
   * link 404s either way; what this avoids is a key holding a record whose own decoder
   * rejects it (`ea: NaN`), which would read back `'unavailable'` for an hour and cost a
   * query per request while looking like a warm cache.
   */
  it('does not cache a record whose timestamp could not be read', async () => {
    const unreadable: ResolvedLink = { ...LINK, expiresAt: new Date('not a timestamp') };
    const stub = serviceWith({ host: HOST, link: unreadable });

    expect((await stub.service.resolve('links.example.test', 'abc1234', NOW)).kind).toBe('not-found');
    expect(stub.cache.writes).toEqual([{ key: 'host', value: CACHED_HOST }]);
  });
});

describe('TASK-2-07: the cache is never load-bearing for correctness (GC-O, AC-2-29)', () => {
  /**
   * `'unavailable'` IS NOT `'miss'`, AND THIS IS THE PAIR THAT PROVES IT. The same slug, the
   * same repository, one cache state apart: a cached negative answers 404 with no read, and
   * an unavailable cache answers the 302 the row supports. Collapsing the two would 404 every
   * live link for the length of a Redis outage.
   */
  it('serves the 302 from Postgres when the cache is unavailable, where a cached negative 404s', async () => {
    const unavailable = serviceWith({ host: HOST, link: LINK });
    const negative = serviceWith(
      { host: HOST, link: LINK },
      { cached: { host: CACHED_HOST, link: 'miss' } },
    );

    expect({
      unavailable: (await unavailable.service.resolve('links.example.test', 'abc1234', NOW)).kind,
      unavailableReads: unavailable.reads(),
      negative: (await negative.service.resolve('links.example.test', 'abc1234', NOW)).kind,
      negativeReads: negative.reads(),
    }).toEqual({
      unavailable: 'redirect',
      unavailableReads: 1,
      negative: 'not-found',
      negativeReads: 0,
    });
  });

  /**
   * Nothing shipped rejects: `redirect-cache.ts` answers `'unavailable'` for a rejection, a
   * timeout, a disconnected client and an undecodable value. The binding arrives from another
   * module all the same, and the invariant a visitor cares about is that a broken cache
   * cannot 404 a live link. The guard is the one the controller puts around `enqueue`, for
   * the same stated reason.
   */
  it('serves the 302 from Postgres when the cache binding rejects instead of degrading', async () => {
    const stub = serviceWith({ host: HOST, link: LINK }, { cached: { rejects: true } });

    expect(await stub.service.resolve('links.example.test', 'abc1234', NOW)).toEqual({
      kind: 'redirect',
      status: 302,
      location: LINK.destinationUrl,
      link: LINK,
    });
    expect(stub.calls()).toEqual({ byHostAndSlug: 1, host: 0, hostKeepingLink: 0, linkOnDomain: 0 });
  });

  /**
   * INVARIANT 5, THROUGH THE CACHE. A `rdr:` key is keyed on the hostname, and a cached
   * record names the domain it was read on. If a hostname changed hands between two domain
   * rows while its link key survived, serving that record would hand one tenant's destination
   * to another tenant's hostname, which is the defect the composite key and the statement
   * ordering close on the Postgres side. The record is refused and the link is read on the
   * domain that actually resolved.
   */
  it('refuses a cached link that names a different domain than the host resolved to', async () => {
    const elsewhere = toCachedLink({
      ...LINK,
      id: '00000000-0000-4000-8000-0000000000e9',
      domainId: '00000000-0000-4000-8000-0000000000d9',
      destinationUrl: 'https://other.example.test/not-this-one',
    }) as CachedLink;
    const stub = serviceWith(
      { host: HOST, link: LINK },
      { cached: { host: CACHED_HOST, link: elsewhere } },
    );

    const decision = await stub.service.resolve('links.example.test', 'abc1234', NOW);

    expect(decision).toEqual({ kind: 'redirect', status: 302, location: LINK.destinationUrl, link: LINK });
    expect(stub.calls()).toEqual({ byHostAndSlug: 0, host: 0, hostKeepingLink: 0, linkOnDomain: 1 });
  });

  /**
   * ADR-0011: the port is asked on a cache MISS only, and `CachedHost.b` is what makes that
   * true. Item 2 binds no port and has no branding column, so the branch is exercised with a
   * stub and a hand-built record, the same reason the fallback branch above is.
   */
  it('renders a cached hosts branding without asking the port (ADR-0011)', async () => {
    const port: RedirectBrandingPort = { getForDomain: vi.fn(async () => null) };
    const branded = toCachedHost({
      ...HOST,
      branding: { logoUrl: null, brandColor: null, fallbackUrl: 'https://example.test/gone' },
    });
    const stub = serviceWith(
      { host: HOST, link: null },
      { branding: port, cached: { host: branded, link: 'miss' } },
    );

    const decision = await stub.service.resolve('links.example.test', 'abc1234', NOW);

    expect(decision).toMatchObject({ kind: 'fallback', status: 302, location: 'https://example.test/gone' });
    expect(port.getForDomain).not.toHaveBeenCalled();
    expect(stub.reads()).toBe(0);
  });
});
