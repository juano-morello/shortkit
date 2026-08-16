import { Module } from '@nestjs/common';

/**
 * ADR: adr-0013-better-auth-in-nestjs.md
 * Produced by: TASK-003. Extended by: TASK-005 (`AuthGuard`).
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
 * It is registered in `app.module.ts` now, empty, so that TASK-005's `AuthGuard` and its
 * providers land in a module that already exists rather than in one added by the same diff
 * that adds the guard.
 *
 * IT DELIBERATELY IMPORTS NOTHING FROM `auth.config.ts`. That module evaluates
 * `betterAuth({ secret: betterAuthSecret(), baseURL: betterAuthUrl(), ... })` at module
 * scope, so importing it here would make every `AppModule` compile — including the ones in
 * the unit tier — require the auth bindings to be set.
 */
@Module({})
export class AuthModule {}
