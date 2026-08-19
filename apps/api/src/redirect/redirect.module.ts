/**
 * Contract: docs/contracts/redirect-resolution.md ("Module isolation (AC-55)"),
 *           branding.md invariant 1
 * ADR: adr-0006-http-surface-partitioning.md, adr-0011-branding-port.md,
 *      adr-0012-redis-client-and-rate-limit-degradation.md; D-2-09, D-2-13
 * Produced by: TASK-2-06. TASK-2-07 added `CacheModule` to `imports`; TASK-2-09's
 *              `ClicksModule` binds `REDIRECT_CLICK_SINK` from ITS side, not from here.
 *
 * ============================================================================
 * `imports` IS EXACTLY ONE ENTRY, AND THAT IS THE ASSERTION (GC-N, AC-2-20).
 * ============================================================================
 *
 * Nothing from the management API, at the module level or the file level: no links, no
 * auth, no workspaces, no members, no invitations. Both ports point INWARDS, in that the
 * redirect declares them and other modules bind them, which is the only shape that keeps the arrow
 * pointing the permitted way (ADR-0011). `redirect-isolation.spec.ts` asserts the module
 * graph and scans every import specifier under this directory, because neither catches what
 * the other does.
 *
 * `CacheModule` IS NOT ONE OF THE FIVE, AND IT IS NOT A PORT EITHER. GC-N names the
 * management API's modules; the cache is infrastructure this module consumes through the
 * `REDIRECT_CACHE` token, exactly as it consumes the pool through `db/redirect-read.ts`.
 * (Naming the transaction helper here instead would fail a grep in `redirect-isolation.spec.ts`
 * that asserts ONE file under this module reaches it, comments included, deliberately.)
 * There is nothing to invert: the cache knows nothing about links, hosts or branding (it
 * moves two records and a sentinel), so the dependency points at a leaf and stays acyclic.
 * The binding it hands over is whichever one boot chose (D-2-09): Redis-backed when
 * `REDIS_URL` is declared, `UnavailableRedirectCache` when it is not, and the redirect
 * resolves correctly either way.
 *
 * The module carries no guard and no interceptor of its own. The global enhancers still
 * wrap the route: `@Public()` on the controller exempts it from `AuthGuard` and
 * `TenantTransactionInterceptor`, `RateLimitGuard` skips it by path, and
 * `RequestLogInterceptor` emits its one line with `route: '/:slug'`, the pattern, never
 * the concrete path.
 */
import { Module, RequestMethod } from '@nestjs/common';

import { CacheModule } from '../cache/cache.module';

import { RedirectController } from './redirect.controller';
import { RedirectReadRepository } from './redirect-read.repository';
import { RedirectService } from './redirect.service';

/**
 * ============================================================================
 * THE GLOBAL-PREFIX EXCLUSION, AND WHY ITS PATH CARRIES A BACKSLASH (ADR-0006, D-2-13).
 * ============================================================================
 *
 * Exported from here rather than written into `main.ts`, so the one place that knows the
 * redirect's declared path is the module that declares it, and so `app.module.spec.ts` can
 * assert the effect against real routes instead of against a string in a file it cannot
 * import (`main.ts` boots on import).
 *
 * D-2-13 specified `{ path: ':slug', method: RequestMethod.GET }` and that form is a defect
 * (measured on the shipped graph, not reasoned about). Nest matches an exclusion against a
 * route's DECLARED PATH rather than against a request URL
 * (`RoutePathFactory.isExcludedFromGlobalPrefix`) and compiles the exclusion with
 * `pathToRegexp`, so the parameter pattern `:slug` matches the declared path of EVERY
 * one-segment GET route in the application: `GET /api/links`, `GET /api/workspaces` and
 * `GET /api/invitations` all lose the prefix and move to the root, taking three list routes
 * off `/api` entirely.
 *
 * `'\\:slug'` is that path with the colon escaped, which path-to-regexp v8 compiles to the
 * LITERAL `/:slug`, the one declared path this controller has. Every other route keeps its
 * prefix. Both directions are pinned in `app.module.spec.ts`, including the broken form, so
 * the reason this is not the obvious string survives the next person to simplify it.
 */
export const REDIRECT_ROUTE_PREFIX_EXCLUSION = {
  path: '\\:slug',
  method: RequestMethod.GET,
} as const;

@Module({
  imports: [CacheModule],
  controllers: [RedirectController],
  providers: [RedirectService, RedirectReadRepository],
})
export class RedirectModule {}
