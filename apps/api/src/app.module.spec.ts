import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { Controller, Get, RequestMethod } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { ApplicationConfig } from '@nestjs/core/application-config';
import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import { afterEach, describe, expect, it } from 'vitest';

import { AppModule } from './app.module';
import { AuthGuard } from './auth/auth.guard';
import { WorkspaceAuthorizationInterceptor } from './common/authorization/workspace-authorization.interceptor';
import { LocalRateLimiter } from './common/rate-limit/local-rate-limiter';
import { RateLimitGuard } from './common/rate-limit/rate-limit.guard';
import { RATE_LIMIT_PORT } from './common/rate-limit/rate-limit.types';
import { RequestLogInterceptor } from './observability/request-log.interceptor';
import { REDIRECT_ROUTE_PREFIX_EXCLUSION, RedirectModule } from './redirect/redirect.module';
import { TenantTransactionInterceptor } from './tenancy/tenant-transaction.interceptor';

describe('AppModule', () => {
  let moduleRef: TestingModule | null = null;

  afterEach(async () => {
    await moduleRef?.close();
    moduleRef = null;
  });

  it('compiles as a Nest composition root', async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();

    expect(moduleRef.get(AppModule)).toBeInstanceOf(AppModule);
  });

  /**
   * AC-1b-40 (TASK-1b-07). `rate-limit.md`, "What the implementer must guarantee": the guard
   * runs AFTER `AuthGuard` and before every interceptor. The second half is Nest's lifecycle;
   * the first is `AppModule`'s import order (`RateLimitModule` after `AuthModule`), which Nest
   * turns into the order of `ApplicationConfig.getGlobalGuards()`: the list
   * `GuardsContextCreator` runs, in this order, for every route. Read from the resolved
   * container rather than inferred from the source, so a reordering of the imports is caught
   * here rather than by the tenant bucket TASK-051 adds reading a `RequestContext` that is
   * not there yet.
   */
  it('AC-1b-40: the global guards resolve to AuthGuard then RateLimitGuard, in that order and no other', async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();

    const guards = moduleRef.get(ApplicationConfig, { strict: false }).getGlobalGuards();

    expect(guards.map((guard) => guard.constructor)).toEqual([AuthGuard, RateLimitGuard]);
  });

  /**
   * AC-1b-20 (TASK-1b-05, D-05). The three global interceptors in the ruled order: the request
   * log line outermost, the tenant transaction inside it, and the workspace authorization check
   * inside THAT. The tenant interceptor calls `next.handle()` inside `withTenantTransaction`,
   * so the third interceptor's lookup runs under the transaction only if it is third. Read from
   * the resolved container (`ApplicationConfig.getGlobalInterceptors()` is the list
   * `InterceptorsContextCreator` runs, in this order) rather than inferred from the source, so
   * a reordering of the two provider lines is caught here and not by every decorated route
   * answering 500 from `TenantContextMissingError`.
   */
  it('AC-1b-20: the global interceptors resolve to RequestLog, TenantTransaction, WorkspaceAuthorization, in that order and no other', async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();

    const interceptors = moduleRef.get(ApplicationConfig, { strict: false }).getGlobalInterceptors();

    expect(interceptors.map((interceptor) => interceptor.constructor)).toEqual([
      RequestLogInterceptor,
      TenantTransactionInterceptor,
      WorkspaceAuthorizationInterceptor,
    ]);
  });

  it('rate-limit.md: RATE_LIMIT_PORT is bound, to the process-local limiter, so no route waits on Redis for a limit', async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();

    expect(moduleRef.get(RATE_LIMIT_PORT, { strict: false })).toBeInstanceOf(LocalRateLimiter);
  });

  /**
   * AC-2-17, D-2-13, ADR-0006 ("the last matching route"). Express matches in registration
   * order and Nest registers modules in this list's order, so a feature module added BELOW
   * `RedirectModule` would have every one-segment route of its own answered by a slug
   * lookup instead. The comment in `app.module.ts` says so; this is the mechanism.
   */
  it('D-2-13: RedirectModule is the LAST entry in AppModule.imports', () => {
    const imports: unknown[] = Reflect.getMetadata('imports', AppModule) ?? [];

    expect(imports.at(-1)).toBe(RedirectModule);
    expect(imports.filter((entry) => entry === RedirectModule)).toHaveLength(1);
  });
});

/* ========================================================================== *
 * The global-prefix exclusion (AC-2-17, ADR-0006, D-2-13).
 * ========================================================================== */

/**
 * ============================================================================
 * WHY THE EXCLUSION PATH IS AN ESCAPED LITERAL AND NOT `:slug` (TASK-2-06, MEASURED).
 * ============================================================================
 *
 * D-2-13 wrote the exclusion as `{ path: ':slug', method: RequestMethod.GET }`, and that
 * form is wrong in a way nothing else in the repository would have caught. Nest matches an
 * exclusion against the route's DECLARED PATH, not against a request URL
 * (`RoutePathFactory.isExcludedFromGlobalPrefix`), and it matches it with
 * `pathToRegexp(path)`, so `:slug`, a one-segment PARAMETER pattern, matches the declared
 * path of EVERY one-segment GET route in the application. Measured on the shipped graph:
 * with that exclusion, `GET /api/links`, `GET /api/workspaces` and `GET /api/invitations`
 * all move to the root and the three list routes disappear from `/api`.
 *
 * `'\\:slug'` is the same string with the colon escaped, which path-to-regexp v8 compiles
 * to a LITERAL `/:slug`, the one declared path the redirect controller has. Every other
 * route keeps its prefix, and this file is where that stays true.
 */
describe('the redirect route is the only route excluded from the /api prefix', () => {
  let app: INestApplication | null = null;

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  @Controller('probe-list')
  class OneSegmentProbeController {
    @Get()
    list(): string {
      return 'list';
    }

    @Get(':id')
    read(): string {
      return 'read';
    }
  }

  @Controller('/')
  class SlugProbeController {
    @Get(':slug')
    resolve(): string {
      return 'slug';
    }
  }

  async function probeApp(exclude: { path: string; method: RequestMethod }[]): Promise<string> {
    const moduleRef = await Test.createTestingModule({
      controllers: [OneSegmentProbeController, SlugProbeController],
    }).compile();

    app = moduleRef.createNestApplication({ logger: false });
    app.setGlobalPrefix('api', { exclude });
    await app.listen(0, '127.0.0.1');
    const baseUrl = await app.getUrl();

    const answered = await Promise.all(
      ['/api/probe-list', '/api/probe-list/7', '/probe-list'].map(async (path) => {
        const response = await fetch(`${baseUrl}${path}`);
        const body = await response.text();

        return `${path}=${response.status === 200 ? body : String(response.status)}`;
      }),
    );

    return answered.join(' ');
  }

  /**
   * `/probe-list` answers `slug` under BOTH exclusions, because `/:slug` matches any one
   * segment and that is the redirect's whole job. What separates the two runs is which
   * handler answers `/api/probe-list`: the list route, or nothing at all.
   */
  it('the escaped literal excludes the slug route and leaves every one-segment /api route alone', async () => {
    expect(await probeApp([REDIRECT_ROUTE_PREFIX_EXCLUSION])).toBe(
      '/api/probe-list=list /api/probe-list/7=read /probe-list=slug',
    );
  });

  /**
   * THE MEASUREMENT, KEPT AS A TEST so the reason the shipped form is escaped is not just
   * a paragraph. The unescaped pattern moves the one-segment list route to the root and
   * takes it off `/api` entirely.
   */
  it('the unescaped pattern D-2-13 wrote would move every one-segment /api GET route to the root', async () => {
    expect(await probeApp([{ path: ':slug', method: RequestMethod.GET }])).toBe(
      '/api/probe-list=404 /api/probe-list/7=read /probe-list=list',
    );
  });

  it('main.ts excludes the redirect route through this exported constant, not a second copy of the path', () => {
    const main = readFileSync(fileURLToPath(new URL('./main.ts', import.meta.url)), 'utf8');

    expect(main).toContain('REDIRECT_ROUTE_PREFIX_EXCLUSION');
    expect(REDIRECT_ROUTE_PREFIX_EXCLUSION).toEqual({
      path: '\\:slug',
      method: RequestMethod.GET,
    });
  });
});
