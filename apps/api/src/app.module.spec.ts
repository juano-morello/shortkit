import { ApplicationConfig } from '@nestjs/core/application-config';
import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import { afterEach, describe, expect, it } from 'vitest';

import { AppModule } from './app.module';
import { AuthGuard } from './auth/auth.guard';
import { LocalRateLimiter } from './common/rate-limit/local-rate-limiter';
import { RateLimitGuard } from './common/rate-limit/rate-limit.guard';
import { RATE_LIMIT_PORT } from './common/rate-limit/rate-limit.types';

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
   * turns into the order of `ApplicationConfig.getGlobalGuards()` — the list
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

  it('rate-limit.md: RATE_LIMIT_PORT is bound, to the process-local limiter, so no route waits on Redis for a limit', async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();

    expect(moduleRef.get(RATE_LIMIT_PORT, { strict: false })).toBeInstanceOf(LocalRateLimiter);
  });
});
