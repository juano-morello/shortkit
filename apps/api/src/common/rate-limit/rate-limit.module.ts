import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';

import { LocalRateLimiter } from './local-rate-limiter';
import { RateLimitGuard } from './rate-limit.guard';
import { RATE_LIMIT_PORT } from './rate-limit.types';

/**
 * Contract: `docs/contracts/rate-limit.md` ("Ownership and injection order", "What the
 *           implementer must guarantee")
 * ADR: adr-0012, adr-0040
 * Produced by: TASK-1b-07 (wave 1 of item 1b); debt sweep D1 (2026-08-19) filled the guard's
 *              tenant branch, still through this binding. TASK-051 rebinds `RATE_LIMIT_PORT`
 *              to the Redis-backed implementation here, keeping `LocalRateLimiter` as the
 *              fallback.
 *
 * Declares the port and binds the guard, the way `AuthModule` declares `AUTH_RATE_LIMIT_PORT`
 * and binds `AuthGuard`: the guard reaches the store through the token and never through a
 * client directly, so a wave-1 guard is built against a Redis client that does not exist yet
 * (`redisClient`, TASK-030) and is limited by the in-process bucket meanwhile: the same
 * implementation ADR-0012 already requires for Redis-unavailable degradation. There is no
 * unprotected window and no no-op default; an unbound token fails at boot.
 *
 * `LocalRateLimiter` holds no connection and reads no environment at construction, so
 * compiling this module in the unit tier costs an `unref()`ed timer and nothing else.
 *
 * ============================================================================
 * IMPORTED BY `AppModule` AFTER `AuthModule`, AND THE ORDER IS A RULING.
 * ============================================================================
 *
 * Nest applies `APP_GUARD` providers in module scan order, which is `AppModule`'s import
 * order, and runs global guards in that order. `AuthGuard` first, this guard second: the
 * contract fixes "the guard runs AFTER `AuthGuard` (it needs `tenantId`) and BEFORE
 * `TenantTransactionInterceptor`": the second half is Nest's lifecycle (every guard before
 * any interceptor), the first is this import order, and `app.module.spec.ts` pins it by
 * reading the resolved global guard list. Since debt sweep D1 the order is load-bearing: the
 * tenant branch reads the `RequestContext` `AuthGuard` wrote, and a refused write never
 * reaches the interceptor that would open its tenant transaction.
 */
@Module({
  providers: [
    { provide: RATE_LIMIT_PORT, useClass: LocalRateLimiter },
    { provide: APP_GUARD, useClass: RateLimitGuard },
  ],
  exports: [RATE_LIMIT_PORT],
})
export class RateLimitModule {}
