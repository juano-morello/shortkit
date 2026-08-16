/**
 * Contract: `.sdlc/identity-membership/design/contracts/auth-config-surface.md`
 * ADR: adr-0013, adr-0046, adr-0050, adr-0051, adr-0052, adr-0055, adr-0056
 * Produced by: TASK-003. Consumed by: TASK-004 (the mount), item 1b (appends a hook).
 *
 * STUB. `auth` is an ambient declaration rather than a throwing body: the exported value is
 * `betterAuth({ ... })`'s return, and a stub that constructs it to get the type is an
 * implementation rather than a stub (stubs/README.md, ADR-0039). The composition itself is
 * normative in `auth-config-surface.md` and in the ADRs above.
 *
 * ONE OF EXACTLY TWO FILES UNDER `apps/api/src` PERMITTED TO NAME `betterAuthDatabase`
 * (ADR-0046, ADR-0056). The other is `db/client.ts`, which defines it.
 * `db/better-auth-database-callers.spec.ts` asserts the pair by equality.
 */
import type { Auth } from 'better-auth';
import type { createAuthMiddleware } from 'better-auth/api';

/** The context Better Auth hands a `hooks.before` middleware. Inferred, never restated. */
export type AuthBeforeHookContext = Parameters<Parameters<typeof createAuthMiddleware>[0]>[0];

/**
 * A registry entry. Better Auth takes ONE `before` function, so `auth.config.ts` iterates
 * this array inside that one function.
 *
 * A hook that does not apply to `ctx.path` returns immediately. A hook that refuses throws
 * an `APIError` and nothing else: `dist/api/dispatch.mjs:86-89` rethrows anything from a
 * before hook that is not one, and a `TypeError` there is an unauthenticated 500 generator
 * against the credential surface (ADR-0013, F-228; ADR-0055).
 */
export type AuthBeforeHook = (ctx: AuthBeforeHookContext) => Promise<void>;

/**
 * ============================================================================
 * APPENDED TO. NEVER ASSIGNED. A LATER AUTHOR WHO REPLACES THIS ARRAY SILENTLY
 * DELETES EVERY EARLIER HOOK.
 * ============================================================================
 *
 * Created empty in this initiative. Item 1b's invitation-validation hook and any
 * email-keyed rate-limit hook `push` onto it (ADR-0013, F-054, F-019). The appenders land
 * after this initiative closes, so this comment is the only thing they will read.
 */
export const beforeHooks: AuthBeforeHook[] = [];

/**
 * The one composed Better Auth instance. TASK-004 mounts it with `toNodeHandler(auth)` and
 * nothing else constructs one.
 */
export declare const auth: Auth;
