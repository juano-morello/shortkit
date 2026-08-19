import { describe, expect, it, vi } from 'vitest';

import { logger } from '../observability/logger';

import type { RedirectBrandingPort } from './ports/branding.port';
import { RedirectService } from './redirect.service';
import type { RedirectReadRepository, RedirectRead } from './redirect-read.repository';
import type { ResolvedHost, ResolvedLink } from './redirect.types';

/**
 * TASK-2-06. AC-2-16, AC-2-17, AC-2-26, AC-2-27, and step 6's fallback branch.
 *
 * Contract: `docs/contracts/redirect-resolution.md` ("Decision order", steps 1 to 7),
 * `branding.md` ("Rendering rules"). ADR-0009, ADR-0011; D-2-13, D-2-14.
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
 * the difference between a 404 that queried and a 404 that did not is to count.
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

interface Stub {
  readonly service: RedirectService;
  readonly reads: () => number;
}

function serviceWith(
  result: RedirectRead,
  branding?: RedirectBrandingPort,
): Stub {
  let reads = 0;

  const repository = {
    resolveByHostAndSlug: vi.fn(async (): Promise<RedirectRead> => {
      reads += 1;

      return result;
    }),
    resolveHost: vi.fn(async (): Promise<ResolvedHost | null> => {
      reads += 1;

      return result.host;
    }),
  } as unknown as RedirectReadRepository;

  return {
    service: new RedirectService(repository, branding ?? null),
    reads: () => reads,
  };
}

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
    const service = new RedirectService(repository, null);

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
  });

  it('answers the default 404 with no read when the Host header is not a hostname', async () => {
    const stub = serviceWith({ host: HOST, link: LINK });

    expect(await stub.service.resolve('not a host name', 'abc1234', NOW)).toEqual({
      kind: 'not-found',
      status: 404,
      host: null,
    });
    expect(stub.reads()).toBe(0);
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
    const stub = serviceWith({ host: HOST, link: LINK }, port);

    expect((await stub.service.resolve('links.example.test', 'abc1234', NOW)).kind).toBe('redirect');
    expect(port.getForDomain).not.toHaveBeenCalled();
  });

  it('asks the port for branding only on the not-found arm, with the domain and tenant ids', async () => {
    const port: RedirectBrandingPort = { getForDomain: vi.fn(async () => null) };
    const stub = serviceWith({ host: HOST, link: null }, port);

    await stub.service.resolve('links.example.test', 'abc1234', NOW);

    expect(port.getForDomain).toHaveBeenCalledWith(HOST.domainId, HOST.tenantId);
  });

  it('yields the fallback 302 when branding carries a fallback URL (AC-76, Amendment A-4)', async () => {
    const branding = { logoUrl: null, brandColor: null, fallbackUrl: 'https://example.test/gone' };
    const port: RedirectBrandingPort = { getForDomain: vi.fn(async () => branding) };
    const stub = serviceWith({ host: HOST, link: null }, port);

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
    const stub = serviceWith({ host: HOST, link: null }, port);

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
    const stub = serviceWith({ host: HOST, link: null }, port);
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
