/**
 * Contract: `docs/contracts/auth-config-surface.md` (`AuthBeforeHookContext`, `AuthBeforeHook`)
 * ADR: adr-0013 (the `hooks.before` registry), adr-0055, F-228, F-216
 * Produced by: TASK-1b-09. Re-exported by `auth.config.ts`, which is where the contract
 *              declares both names; consumed by `email-rate-limit-hook.ts` and
 *              `invitation-signup.ts`.
 *
 * ============================================================================
 * WHY THE TWO TYPES LIVE HERE AND NOT IN `auth.config.ts`, WHERE THE CONTRACT WRITES THEM.
 * ============================================================================
 *
 * `db/better-auth-database-callers.spec.ts` scan 5 bounds who may import the composed
 * instance's module: by TEXT, so a type-only import of that module's specifier matches
 * exactly like a value import would, and so would this sentence if it spelled the specifier
 * in import position (F-207: the composed instance is a second handle on the auth role, and
 * a text scan does not distinguish a type import from a value import, nor prose from code;
 * F-191). The two hook modules need the type and must not appear on that scan's permitted
 * list, so the type is defined here and the config module re-exports it under the same
 * names. Nothing here imports anything from this repository; it is a type derivation and a
 * comment.
 *
 * `AuthBeforeHookContext` is INFERRED from `createAuthMiddleware`'s handler parameter and
 * never restated: the context type is a large structural type whose shape changes between
 * Better Auth releases, and a restated copy compiles and diverges (auth-config-surface.md).
 */
import type { createAuthMiddleware } from 'better-auth/api';

/** The context Better Auth hands a `hooks.before` middleware. Inferred, never restated. */
export type AuthBeforeHookContext = Parameters<Parameters<typeof createAuthMiddleware>[0]>[0];

/**
 * A registry entry. Better Auth takes ONE `before` function, so `auth.config.ts` iterates
 * the `beforeHooks` array inside that one function, in registration order, short-circuiting
 * on a throw.
 *
 * A hook that does not apply to `ctx.path` returns immediately. A hook that refuses throws
 * an `APIError` and nothing else: `dist/api/dispatch.mjs:86-89` rethrows anything from a
 * before hook that is not one, and a `TypeError` there is an unauthenticated 500 generator
 * against the credential surface (ADR-0013, F-228; ADR-0055).
 *
 * `ctx.body` is UNVALIDATED at this point: probes against 1.6.26 delivered `ctx.body.email`
 * as an object, as a number, and `ctx.body` as `undefined`. Every read of it goes through a
 * predicate that accepts `unknown`.
 *
 * AND AN `APIError`'s MESSAGE DOES NOT GO THROUGH THE BOUND LOGGER (F-216): `api/index.mjs`'s
 * `onError` writes `e.message` through better-auth's package-level logger singleton, straight
 * to `console`, past `LOGGABLE_FIELDS`. So every message a hook throws is a fixed exported
 * constant: no token, no address, no user id, no tenant id, no invitation id.
 */
export type AuthBeforeHook = (ctx: AuthBeforeHookContext) => Promise<void>;

/**
 * A `hooks.after` registry entry: the same context shape (`createAuthMiddleware` serves
 * both), iterated by `auth.config.ts`'s one `after` function over `afterHooks` in registration
 * order. Added 2026-08-18 (TASK-1b-09, architect ruling): the email-keyed sign-in bucket
 * counts FAILED attempts, and the outcome is known only after the endpoint ran.
 *
 * What an after hook can see, measured on 1.6.26 (`api/dispatch.mjs`, `dispatchAuthEndpoint`):
 * `ctx.context.returned` is the endpoint's returned value: the `ctx.json(...)` object on
 * success, or THE `APIError` INSTANCE the endpoint threw (the dispatcher catches it and stores
 * it before running the after hooks; a `ValidationError` is an `APIError`). The numeric status
 * is NOT on the context; "the endpoint returned without an `APIError`" is the success signal.
 * After hooks do NOT run when a before hook threw. `ctx.body` is the same parsed body the
 * before hook saw.
 *
 * An after hook that throws a non-`APIError` aborts a request the endpoint already answered
 * (a 500 over a successful sign-in) so it never throws at all: it degrades open with a warn.
 */
export type AuthAfterHook = (ctx: AuthBeforeHookContext) => Promise<void>;
