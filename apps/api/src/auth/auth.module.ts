import { Module } from '@nestjs/common';

import { LocalAuthRateLimiter } from './auth-rate-limit';
import { AUTH_RATE_LIMIT_PORT } from './ports/auth-rate-limit.port';

/**
 * ADR: adr-0013-better-auth-in-nestjs.md, adr-0011 (the port shape), adr-0012
 * Produced by: TASK-003. Extended by: TASK-004 (`AUTH_RATE_LIMIT_PORT`), TASK-005 (`AuthGuard`).
 *
 * ============================================================================
 * THE BETTER AUTH HANDLER IS NOT IN THIS MODULE, AND CANNOT BE.
 * ============================================================================
 *
 * ADR-0013 mounts it as one Express registration in `main.ts` (TASK-004, wave 3), outside
 * the Nest graph: it needs the raw request body, which Nest's body parser has already
 * consumed by the time a controller runs. So this module holds nothing of the mount, and
 * `ApiExceptionFilter` never sees a Better Auth response — `auth.config.ts` raises its own
 * failures as `APIError` for that reason (ADR-0055).
 *
 * WHAT IT DOES HOLD, SINCE WAVE 3, IS THE AUTH RATE-LIMIT PORT (`rate-limit.md`, "Ownership
 * and injection order": "the auth module declares the port, exactly as the redirect module
 * declares its branding port"). `main.ts` resolves the token with `app.get()` and hands the
 * implementation to `authRateLimit` on the mount, so the middleware outside the graph is
 * bound by the graph — and an unbound token fails `app.get()` at boot, which is the
 * "required, not `@Optional()`" property the contract asks for. TASK-051 rebinds the same
 * token to a Redis-backed implementation here without touching the mount.
 *
 * `LocalAuthRateLimiter` holds no connection and reads no environment at construction, so
 * compiling this module in the unit tier costs an `unref()`ed timer and nothing else.
 *
 * IT DELIBERATELY IMPORTS NOTHING FROM `auth.config.ts`. That module evaluates
 * `betterAuth({ secret: betterAuthSecret(), baseURL: betterAuthUrl(), ... })` at module
 * scope, so importing it here would make every `AppModule` compile — including the ones in
 * the unit tier — require the auth bindings to be set.
 */
@Module({
  providers: [{ provide: AUTH_RATE_LIMIT_PORT, useClass: LocalAuthRateLimiter }],
  exports: [AUTH_RATE_LIMIT_PORT],
})
export class AuthModule {}
