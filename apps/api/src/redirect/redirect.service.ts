/**
 * Contract: docs/contracts/redirect-resolution.md ("Decision order", steps 1 to 6;
 *           invariants 2, 4, 5 and 6), redirect-cache.md ("Interface", "Only an `active`
 *           domain is cached", invariants 2 and 4), branding.md ("Rendering rules"), slug.md
 * ADR: adr-0008-redirect-cache-shape.md, adr-0009-expiry-eviction.md,
 *      adr-0011-branding-port.md, adr-0012-redis-client-and-rate-limit-degradation.md,
 *      adr-0007-short-code-generation.md
 * Produced by: TASK-2-06. The cache in front of steps 2 and 3 is TASK-2-07's (wave 4).
 *
 * ============================================================================
 * STEP 0: THE SHAPE CHECK RUNS BEFORE ANY I/O, AND IT IS A SECURITY BOUND.
 * ============================================================================
 *
 * D-2-13 introduced this as a cost bound, since `favicon.ico` and every other scanner path
 * should not reach Postgres, and it is more than that now that the cache is in front. Two
 * shipped facts meet here: `linkKey()` builds `sk:{namespace}:rdr:v1:{hostname}:{slug}`
 * from the slug WITHOUT normalising it, deliberately and with a comment saying it must not
 * start; and redirect traffic is never rate limited at any rate (AC-2-19, AC-86, and
 * `RateLimitGuard` leaves this route alone by path). An unvalidated path segment therefore
 * turns one anonymous request into one new key in a shared Redis namespace, each holding a
 * MISS sentinel for 60 seconds, at whatever rate a stranger can open sockets. Validating
 * first bounds the key namespace to strings a link could actually own.
 *
 * So the order is not negotiable: shape, then hostname, then cache, then Postgres. This
 * function is where "before any cache read or any query" is enforced, and
 * `redirect.service.spec.ts` counts both reads and cache calls to prove it rather than
 * trusting the reading.
 *
 * `SLUG_PATTERN` and the length bound come from the contracts package, which the redirect
 * module may import (GC-N bans the management API's modules, not the shared contracts;
 * D-2-11). `validateSlug` is deliberately NOT used: it additionally rejects the reserved
 * list, and a reserved slug is one no link can hold anyway, so the extra work buys a 404
 * this function was going to return regardless.
 *
 * ============================================================================
 * THE READ-THROUGH, AND WHAT EACH CACHE STATE IS ALLOWED TO COST (TASK-2-07).
 * ============================================================================
 *
 * `redirect-cache.md` invariant 4 is that a cache hit performs ZERO Postgres queries, expiry
 * evaluation and the click enqueue's tenant id included, and invariant 2 is that
 * `'unavailable'` never causes a 404: it causes a Postgres read. The other half, which no
 * contract could state for it, is that a MISS must cost exactly what the resolve cost before
 * the cache existed: one transaction, its two-statement preamble, and the two reads.
 *
 * That is why the cache is read for BOTH keys before either Postgres read is chosen, rather
 * than each step falling through on its own. Two independent read-throughs would open two
 * transactions on a cold request and pay the preamble twice, which is six statements where
 * wave 3 paid four. The states and the read each one issues:
 *
 *   host record + link record   no read at all.
 *   host record + link MISS     no read at all: the cached negative answers the request.
 *   host MISS                   no read at all, and the LINK KEY IS NOT EVEN LOOKED UP.
 *   host cold + link cold       `resolveByHostAndSlug`: one transaction, two statements.
 *   host cold + link MISS       `resolveHost` alone: one statement, since a cached negative
 *                               answers whatever the host turns out to be.
 *   host cold + link record     `resolveHostKeepingLinkOn`: statement 1, plus statement 2 IN
 *                               THE SAME TRANSACTION only if the record names another domain.
 *                               The host key lives 300 s against the link key's 3600, so this
 *                               is the ordinary state rather than an edge.
 *   host record + link cold     `resolveLinkOnDomain` alone, on the CACHED domain id.
 *
 * EVERY BRANCH OPENS AT MOST ONE TRANSACTION, which is the same rule as the paragraph above
 * and the reason the conditional second statement lives inside the repository call.
 *
 * THE HOST IS ALWAYS RESOLVED BEFORE A LINK RECORD IS SERVED, and that ordering is F-003's.
 * A `rdr:` key is keyed on the hostname and says nothing about the state of the domain behind
 * it. NOTHING DELETES A HOST KEY TODAY: the invalidation subscriber deletes `rdr:` keys only,
 * and the `hst:` rows of `redirect-cache.md`'s table (branding changed, domain deleted, domain
 * leaves `active`) belong to later cards, so the 300 s host TTL is the only bound on a stale
 * host record. Reading the host first is what keeps that bound at 300 seconds instead of the
 * link key's 3600.
 *
 * Every cache call is bounded at 50 ms by `commandTimeout` (ADR-0012), reads never throw and
 * writes never throw, so the worst a dead Redis costs this path is its own bound and then the
 * ordinary Postgres resolution: GC-O's "no visitor 5xx" and AC-2-29's "degrades, never
 * breaks" both come from that, not from anything here catching an outage.
 */
import { Inject, Injectable, Optional } from '@nestjs/common';
import { SLUG_MAX_LENGTH, SLUG_PATTERN, isLinkActive } from '@shortkit/contracts';

import { REDIRECT_CACHE } from '../cache/redirect-cache';
import type { CachedHost, CachedLink, RedirectCache } from '../cache/redirect-cache';
import { normaliseHostname } from '../db/platform';
import { errorLogFields, logger } from '../observability/logger';

import { fromCachedHost, fromCachedLink, toCachedHost, toCachedLink } from './cache-records';
import { REDIRECT_BRANDING_PORT } from './ports/branding.port';
import type { RedirectBranding, RedirectBrandingPort } from './ports/branding.port';
import { RedirectReadRepository } from './redirect-read.repository';
import type { RedirectDecision, ResolvedHost, ResolvedLink } from './redirect.types';

/** The default 404, with no host and therefore no branding to reach for. */
const DEFAULT_NOT_FOUND: RedirectDecision = { kind: 'not-found', status: 404, host: null };

/** The route PATTERN, which is what a log line may carry. The concrete path never is. */
const ROUTE_PATTERN = '/:slug';

/**
 * What steps 2 and 3 produced, wherever they read it from. `brandingKnown` is true when the
 * host came from a CACHED record, whose `b` field is the branding answer rather than a hint:
 * ADR-0011 asks the port on a cache miss only, and this is the flag that makes that true.
 */
interface Resolution {
  readonly host: ResolvedHost | null;
  readonly link: ResolvedLink | null;
  readonly brandingKnown: boolean;
}

/** No host, so no link and nothing to render but the default page. */
const NOTHING: Resolution = { host: null, link: null, brandingKnown: false };

@Injectable()
export class RedirectService {
  constructor(
    // `@Inject` on a class token: redundant for Nest, load-bearing for lint. See
    // `redirect.controller.ts`.
    @Inject(RedirectReadRepository) private readonly reads: RedirectReadRepository,
    /**
     * BOUND ALWAYS, AND NOT `@Optional()`. `CacheModule` binds either the Redis-backed cache
     * or `UnavailableRedirectCache` (D-2-09), so there is no deployment where this token is
     * absent and an optional injection would only hide a wiring mistake behind a redirect
     * that silently resolved from Postgres forever.
     */
    @Inject(REDIRECT_CACHE) private readonly cache: RedirectCache,
    /**
     * UNBOUND IN ITEM 2 (ADR-0011). `@Optional()` hands over `null`, every 404 is the
     * default page, and the module boots and is testable with no workspace module present.
     * The default value is what makes the class constructible by hand in a unit spec.
     */
    @Optional()
    @Inject(REDIRECT_BRANDING_PORT)
    private readonly branding: RedirectBrandingPort | null = null,
  ) {}

  /**
   * The decision order, steps 0 to 6, in order. `now` is the API process's clock and is
   * passed in rather than read here (ADR-0009: never Redis's, never Postgres's), which is
   * also what lets the window branches be tested without touching a timer.
   */
  async resolve(host: string | undefined, segment: string, now: Date): Promise<RedirectDecision> {
    // Step 0. Before the cache, before Postgres, before anything. See the header.
    if (!isResolvableSlug(segment)) {
      return DEFAULT_NOT_FOUND;
    }

    // Step 1. Lowercase, IDNA via `new URL()`, port stripped, by the same function the seed
    // normalises the stored hostname with, so the request and the row cannot disagree.
    const hostname = normalisedHostOrNull(host);

    if (hostname === null) {
      return DEFAULT_NOT_FOUND;
    }

    // Steps 2 and 3: the cache, then whichever Postgres read the cache left necessary.
    const resolution = await this.readThrough(hostname, segment);

    if (resolution.host === null) {
      return DEFAULT_NOT_FOUND;
    }

    // Step 4. THE WINDOW IS EVALUATED ON EVERY READ, FROM THE RECORD ALREADY IN HAND,
    // whether that record came from Postgres or from Redis, and an inactive link does NOT
    // fall through to a second lookup (ADR-0009, AC-2-26). This check is the correctness
    // mechanism and `linkTtlSeconds`' clamp is not: Redis expiry is lazy and granular to the
    // second, so a record can outlive its TTL by an unbounded margin. Deleting this line on
    // the reasoning that the key would have expired anyway is the defect ADR-0009 exists to
    // prevent. The rule is the contracts package's and is never reimplemented here.
    if (resolution.link !== null && isLinkActive(resolution.link, now)) {
      // Step 5. The destination byte for byte: no rewriting, no normalisation, no added
      // parameters. The controller writes it with `setHeader`, not with Express's
      // `res.redirect`, which would percent-encode it on the way out.
      return { kind: 'redirect', status: 302, location: resolution.link.destinationUrl, link: resolution.link };
    }

    // Step 6. Fallback if the host's branding names one, the branded 404 otherwise.
    return this.notFound(resolution.host, resolution.brandingKnown);
  }

  /**
   * Steps 2 and 3 with the cache in front. See the file header for the state table; the one
   * thing to keep while editing is that the LINK key is read after the host key and never
   * before it, so a cached negative host costs one Redis call and nothing else.
   */
  private async readThrough(hostname: string, slug: string): Promise<Resolution> {
    const cachedHost = await this.getHost(hostname);

    if (cachedHost === 'miss') {
      return NOTHING;
    }

    const cachedLink = await this.getLink(hostname, slug);

    if (cachedHost === 'unavailable') {
      return cachedLink === 'unavailable'
        ? this.fillBoth(hostname, slug)
        : this.fillHost(hostname, slug, cachedLink);
    }

    return this.linkForCachedHost(hostname, slug, fromCachedHost(cachedHost), cachedLink);
  }

  /** Both keys cold: ONE transaction and the two statements, which is wave 3's cost. */
  private async fillBoth(hostname: string, slug: string): Promise<Resolution> {
    const read = await this.reads.resolveByHostAndSlug(hostname, slug);

    await this.putHost(hostname, read.host);

    if (read.host === null) {
      // NOTHING IS WRITTEN AT `rdr:` FOR A HOSTNAME THAT RESOLVES TO NO ACTIVE DOMAIN. The
      // host key is what the next request reads first, so a link key under a hostname that
      // serves nothing is a key nothing would ever look at, held for an hour.
      return NOTHING;
    }

    await this.putLink(hostname, slug, read.link);

    return { host: read.host, link: read.link, brandingKnown: false };
  }

  /**
   * The host key expired under a link key that did not: 300 s against 3600 s.
   *
   * ONE TRANSACTION IN EVERY BRANCH OF THIS METHOD. A cached negative answers whatever the
   * host turns out to be, so statement 1 alone is enough; a cached RECORD is usable only if it
   * names the domain that resolves now, which statement 1 is what decides, so the conditional
   * second statement goes inside the same transaction rather than into a second one. Resolving
   * the host and then reading the link through a separate call would pay the preamble twice,
   * which is the six-statement shape that reading both cache keys up front exists to avoid.
   */
  private async fillHost(
    hostname: string,
    slug: string,
    cachedLink: CachedLink | 'miss',
  ): Promise<Resolution> {
    const read =
      cachedLink === 'miss'
        ? { host: await this.reads.resolveHost(hostname), link: null }
        : await this.reads.resolveHostKeepingLinkOn(hostname, slug, cachedLink.dm);

    await this.putHost(hostname, read.host);

    if (read.host === null) {
      return NOTHING;
    }

    if (cachedLink === 'miss') {
      return { host: read.host, link: null, brandingKnown: false };
    }

    // THE RECORD IS SERVED ONLY IF IT NAMES THE DOMAIN THAT RESOLVED (invariant 5). The `rdr:`
    // key is keyed on the hostname, so if a hostname changed hands between two domain rows
    // while its link key survived, serving the record would hand one tenant's destination to
    // another tenant's hostname.
    if (cachedLink.dm === read.host.domainId) {
      return { host: read.host, link: fromCachedLink(cachedLink), brandingKnown: false };
    }

    // The row on the domain that actually resolved came back in the same transaction, and
    // writing it back overwrites the record that named the other domain.
    await this.putLink(hostname, slug, read.link);

    return { host: read.host, link: read.link, brandingKnown: false };
  }

  /**
   * Step 3 against a host that came from a CACHED record, so no host statement was issued and
   * none is owed: the link is the only thing that can still need Postgres, and it needs it for
   * a cold key or for a record naming another domain (invariant 5, as above).
   */
  private async linkForCachedHost(
    hostname: string,
    slug: string,
    host: ResolvedHost,
    cachedLink: CachedLink | 'miss' | 'unavailable',
  ): Promise<Resolution> {
    if (cachedLink === 'miss') {
      return { host, link: null, brandingKnown: true };
    }

    if (cachedLink !== 'unavailable' && cachedLink.dm === host.domainId) {
      return { host, link: fromCachedLink(cachedLink), brandingKnown: true };
    }

    const link = await this.reads.resolveLinkOnDomain(host.domainId, slug);

    await this.putLink(hostname, slug, link);

    return { host, link, brandingKnown: true };
  }

  /**
   * `resolveHost` IS THE ONLY WRITER OF A POSITIVE `hst:` RECORD, and this is that writer
   * (`redirect-cache.md`, "Only an `active` domain is cached"; F-003). The rule needs no
   * check here because it is enforced by the statement: `AND state = 'active'` is part of the
   * permitted shape, so a host that resolved is an active one and any other state arrives as
   * `null` and caches as MISS. Caching a `pending_verification` domain would reopen F-003
   * through the cache while the query kept its predicate.
   */
  private async putHost(hostname: string, host: ResolvedHost | null): Promise<void> {
    await this.write(async (cache) =>
      cache.setHost(hostname, host === null ? 'miss' : toCachedHost(host)),
    );
  }

  /** `setLink` applies `linkTtlSeconds` itself (AC-2-28); the clamp is hygiene, not the rule. */
  private async putLink(hostname: string, slug: string, link: ResolvedLink | null): Promise<void> {
    const value = link === null ? 'miss' : toCachedLink(link);

    // `null` means a bound that could not be read, which is never cached: see
    // `cache-records.ts`. The request is served from the row already in hand.
    if (value === null) {
      return;
    }

    await this.write(async (cache) => cache.setLink(hostname, slug, value));
  }

  private async getHost(hostname: string): Promise<CachedHost | 'miss' | 'unavailable'> {
    try {
      return await this.cache.getHost(hostname);
    } catch (error) {
      this.cacheFailed(error);

      return 'unavailable';
    }
  }

  private async getLink(hostname: string, slug: string): Promise<CachedLink | 'miss' | 'unavailable'> {
    try {
      return await this.cache.getLink(hostname, slug);
    } catch (error) {
      this.cacheFailed(error);

      return 'unavailable';
    }
  }

  private async write(fill: (cache: RedirectCache) => Promise<void>): Promise<void> {
    try {
      await fill(this.cache);
    } catch (error) {
      this.cacheFailed(error);
    }
  }

  /**
   * ============================================================================
   * NOTHING SHIPPED REACHES THIS, AND IT IS HERE FOR THE SAME REASON THE CONTROLLER GUARDS
   * `enqueue`.
   * ============================================================================
   *
   * `redirect-cache.ts` answers `'unavailable'` for a rejection, a synchronous throw, a
   * timeout, a disconnected client and a value that does not decode, and its writes swallow
   * the same failures, so a conforming binding never rejects. The binding arrives from
   * another module all the same, and the invariant a visitor depends on is GC-O's: a cache
   * problem must never turn a live link into a 404 or a 5xx. A guard here is what makes that
   * true of an implementation this module does not own.
   *
   * The line carries no key, no hostname and no slug (GC-G), and the message is withheld
   * because a cache error's message can carry the key. It is emitted per occurrence, which is
   * bearable precisely because a conforming binding produces none: an `'unavailable'` READ
   * logs nothing at all, since a cold key returns that too and a line keyed on it would be
   * one per request on an empty cache (`redirect-cache.md`, the 2026-08-19 amendment).
   */
  private cacheFailed(error: unknown): void {
    logger.error(
      {
        code: 'redirect_cache_failed',
        route: ROUTE_PATTERN,
        ...errorLogFields(error, { includeMessage: false }),
      },
      'the redirect cache binding rejected instead of degrading; the redirect resolved from Postgres',
    );
  }

  private async notFound(host: ResolvedHost, brandingKnown: boolean): Promise<RedirectDecision> {
    const branding = brandingKnown ? host.branding : await this.brandingFor(host);

    if (branding === null) {
      return { kind: 'not-found', status: 404, host };
    }

    const withBranding: ResolvedHost = { ...host, branding };

    return branding.fallbackUrl === null
      ? { kind: 'not-found', status: 404, host: withBranding }
      : { kind: 'fallback', status: 302, location: branding.fallbackUrl, host: withBranding };
  }

  /**
   * The port is asked ONLY on the not-found arm, and ONLY when the host did not come from the
   * cache. ADR-0011 says "on a cache miss only", and `CachedHost.b` is what makes that true:
   * a cached record's `b` IS the branding answer, `null` included, so a hit renders from it.
   * The narrower half is this card's predecessor's: a resolved 302 never pays for branding at
   * all, so the visitor's commonest path never touches item 3's code.
   *
   * A THROW FROM THE PORT DEGRADES TO THE DEFAULT PAGE. GC-O admits no visitor 5xx, and
   * this is an implementation the redirect module cannot see: it is bound by another
   * module, reads another module's table, and its failure has nothing to do with whether
   * this link exists. The controller's catch would also hold it; catching here keeps the
   * distinction between "resolution failed" and "the logo could not be read".
   */
  private async brandingFor(host: ResolvedHost): Promise<RedirectBranding | null> {
    if (this.branding === null) {
      return null;
    }

    try {
      return await this.branding.getForDomain(host.domainId, host.tenantId);
    } catch (error) {
      logger.error(
        {
          code: 'redirect_branding_unavailable',
          route: ROUTE_PATTERN,
          ...errorLogFields(error, { includeMessage: false }),
        },
        'the branding port failed; the default 404 was served',
      );

      return null;
    }
  }
}

/**
 * The length bound is checked BEFORE the pattern, so a megabyte of path segment costs one
 * comparison rather than a regex pass. `SLUG_PATTERN` admits at most 64 characters itself;
 * the explicit bound is about what a hostile input costs, not about what is valid.
 */
function isResolvableSlug(segment: string): boolean {
  return segment.length <= SLUG_MAX_LENGTH && SLUG_PATTERN.test(segment);
}

/**
 * `new URL()` does the IDNA folding and drops the port, and it THROWS on input that is not
 * a hostname at all. A `Host` header is attacker-controlled, so the throw is caught here
 * and answered with the default 404 rather than being allowed to look like a failure of the
 * resolution itself.
 */
function normalisedHostOrNull(host: string | undefined): string | null {
  if (host === undefined || host.trim() === '') {
    return null;
  }

  try {
    return normaliseHostname(host);
  } catch {
    return null;
  }
}
