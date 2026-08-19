/**
 * Contract: docs/contracts/redirect-resolution.md ("Decision order", steps 1 to 6;
 *           invariants 4, 5 and 6), branding.md ("Rendering rules"), slug.md
 * ADR: adr-0009-expiry-eviction.md, adr-0011-branding-port.md, adr-0007-short-code-generation.md
 * Produced by: TASK-2-06. Wrapped by TASK-2-07, which puts the cache in front of the reads.
 *
 * ============================================================================
 * STEP 0: THE SHAPE CHECK RUNS BEFORE ANY I/O, AND IT IS A SECURITY BOUND.
 * ============================================================================
 *
 * D-2-13 introduced this as a cost bound, since `favicon.ico` and every other scanner path
 * should not reach Postgres, and it is more than that once the cache is in front (wave 4).
 * Two shipped facts meet here: `linkKey()` builds `sk:{namespace}:rdr:v1:{hostname}:{slug}`
 * from the slug WITHOUT normalising it, deliberately and with a comment saying it must not
 * start; and redirect traffic is never rate limited at any rate (AC-2-19, AC-86, and
 * `RateLimitGuard` leaves this route alone by path). An unvalidated path segment therefore
 * turns one anonymous request into one new key in a shared Redis namespace, each holding a
 * MISS sentinel for 60 seconds, at whatever rate a stranger can open sockets. Validating
 * first bounds the key namespace to strings a link could actually own.
 *
 * So the order is not negotiable: shape, then hostname, then cache, then Postgres. This
 * function is where "before any cache read or any query" is enforced, and
 * `redirect.service.spec.ts` counts reads to prove it rather than trusting the reading.
 *
 * `SLUG_PATTERN` and the length bound come from the contracts package, which the redirect
 * module may import (GC-N bans the management API's modules, not the shared contracts;
 * D-2-11). `validateSlug` is deliberately NOT used: it additionally rejects the reserved
 * list, and a reserved slug is one no link can hold anyway, so the extra work buys a 404
 * this function was going to return regardless.
 */
import { Inject, Injectable, Optional } from '@nestjs/common';
import { SLUG_MAX_LENGTH, SLUG_PATTERN, isLinkActive } from '@shortkit/contracts';

import { normaliseHostname } from '../db/platform';
import { errorLogFields, logger } from '../observability/logger';

import { REDIRECT_BRANDING_PORT } from './ports/branding.port';
import type { RedirectBranding, RedirectBrandingPort } from './ports/branding.port';
import { RedirectReadRepository } from './redirect-read.repository';
import type { RedirectDecision, ResolvedHost } from './redirect.types';

/** The default 404, with no host and therefore no branding to reach for. */
const DEFAULT_NOT_FOUND: RedirectDecision = { kind: 'not-found', status: 404, host: null };

@Injectable()
export class RedirectService {
  constructor(
    // `@Inject` on a class token: redundant for Nest, load-bearing for lint. See
    // `redirect.controller.ts`.
    @Inject(RedirectReadRepository) private readonly reads: RedirectReadRepository,
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

    // Steps 2 and 3, in one transaction: only a domain in state `active` resolves (F-003),
    // and the link is looked up on THAT domain's id, never on the hostname.
    const { host: resolved, link } = await this.reads.resolveByHostAndSlug(hostname, segment);

    if (resolved === null) {
      return DEFAULT_NOT_FOUND;
    }

    // Step 4. The window is evaluated on EVERY read, from the record already in hand, and
    // an inactive link does NOT fall through to a second lookup (ADR-0009). The rule is the
    // contracts package's and is never reimplemented here.
    if (link !== null && isLinkActive(link, now)) {
      // Step 5. The destination byte for byte: no rewriting, no normalisation, no added
      // parameters. The controller writes it with `setHeader`, not with Express's
      // `res.redirect`, which would percent-encode it on the way out.
      return { kind: 'redirect', status: 302, location: link.destinationUrl, link };
    }

    // Step 6. Fallback if the host's branding names one, the branded 404 otherwise.
    return this.notFound(resolved);
  }

  private async notFound(host: ResolvedHost): Promise<RedirectDecision> {
    const branding = await this.brandingFor(host);

    if (branding === null) {
      return { kind: 'not-found', status: 404, host };
    }

    const withBranding: ResolvedHost = { ...host, branding };

    return branding.fallbackUrl === null
      ? { kind: 'not-found', status: 404, host: withBranding }
      : { kind: 'fallback', status: 302, location: branding.fallbackUrl, host: withBranding };
  }

  /**
   * The port is asked ONLY on the not-found arm. ADR-0011 says "on a cache miss only",
   * which from TASK-2-07 is what the `hst:` record's `b` field makes true; here, with no
   * cache in front, the narrower rule is better on both counts: a resolved 302 never pays
   * for it, and the visitor's commonest path never touches item 3's code at all.
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
          route: '/:slug',
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
