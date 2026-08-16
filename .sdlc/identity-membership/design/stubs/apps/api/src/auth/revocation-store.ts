/**
 * Contract: `.sdlc/identity-membership/design/contracts/revocation-store.md`
 * ADR: adr-0053-revocation-store-is-process-local.md, adr-0013-better-auth-in-nestjs.md
 * Produced by: TASK-003 (the write side and the store). Read by: TASK-005 (AuthGuard step 6).
 *
 * The revocation handle is the Better Auth SESSION id, which the JWT carries as `jti`
 * (ADR-0013, F-227). One entry covers every token that session ever minted, including
 * tokens minted before the entry was written. It is not a per-token nonce.
 *
 * ============================================================================
 * THIS STORE IS PROCESS-LOCAL AND IS CORRECT ONLY WHILE ONE PROCESS SERVES.
 * ============================================================================
 *
 * ADR-0013 specified Redis. There is no Redis client in this repository and none arrives
 * in this initiative; `redisClient` is deferred TASK-030. `docker compose` runs one `api`
 * container and no deploy manifest exists (ADR-0030), so a process-local store is correct
 * on everything this repository runs today.
 *
 * On two processes it is silently wrong: a sign-out served by process A leaves that
 * session's tokens honoured by process B for up to REVOCATION_TTL_SECONDS. ADR-0053 names
 * what makes that visible when the topology changes.
 */
import { ACCESS_TOKEN_LIFETIME_SECONDS } from '@shortkit/contracts';

/**
 * The full access-token lifetime, counted from the write.
 *
 * Derived rather than restated: `auth-contracts.md` invariant 4 requires the lifetime and
 * the revocation TTL to be one number declared once. The write site holds a session and not
 * a token, so there is no `exp` to subtract from, and anything shorter lets a token minted
 * one second before sign-out outlive its own revocation entry (ADR-0013, F-227).
 */
export const REVOCATION_TTL_SECONDS = ACCESS_TOKEN_LIFETIME_SECONDS;

/**
 * The entry ceiling, above which the oldest live entry is evicted (ADR-0053).
 *
 * The hook fires on EVERY session deletion, including expired-session cleanup, so a sweep
 * that deletes a million rows writes a million entries that each live 300 seconds. Without
 * a ceiling that is an unbounded map on a process with no other memory pressure.
 *
 * ============================================================================
 * EVICTION IS A CONTROL BYPASS, NOT A MEMORY EVENT.
 * ============================================================================
 *
 * Eviction below the TTL means a revoked session is honoured again. The write path is
 * ATTACKER-REACHABLE: every session deletion writes an entry, and sign-in followed by
 * sign-out is that path, so an attacker holding a stolen token can in principle flush the
 * victim's entry by driving this many deletions inside the 300-second window. What makes
 * that expensive is TASK-004's IP-keyed limiter, in another card, which ADR-0040 records
 * does not bind in any environment that exists today. Raising this number trades memory for
 * attacker effort and does not remove the primitive.
 */
export const REVOCATION_STORE_MAX_ENTRIES = 10_000;

/**
 * Raised by `isRevoked` when the store could not answer.
 *
 * `InMemoryRevocationStore` never raises it: a Map read cannot fail. It exists because
 * TASK-005 must distinguish "not revoked" from "could not tell", and a port that cannot
 * express the second forces the guard to treat an unreachable store as proof of validity.
 * That is F-245's rule one level down.
 */
export class RevocationStoreUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'RevocationStoreUnavailableError';
  }
}

export interface RevocationStore {
  /**
   * Records that every token minted for `sessionId` is refused for
   * REVOCATION_TTL_SECONDS from now.
   *
   * NEVER REJECTS. The session row is already deleted and the hook is queued after the
   * write, so failing a sign-out because a store is unavailable contradicts ADR-0012's
   * posture. A failure is logged and swallowed, and degrades to the same window a failed
   * read degrades to.
   */
  revoke(sessionId: string): Promise<void>;

  /**
   * Whether `sessionId` currently carries a revocation entry.
   *
   * MAY REJECT with `RevocationStoreUnavailableError`. The caller decides the posture;
   * ADR-0012 and `auth-tokens.md` step 5 fix that decision as skip-open for the guard.
   * A resolved `false` means the store answered and the session is not revoked.
   */
  isRevoked(sessionId: string): Promise<boolean>;
}

/**
 * A source of the current time in epoch milliseconds. `Date.now` satisfies it.
 *
 * ADDED 2026-08-16 by Juano's ruling at the wave-2 Test phase, amending this contract after it
 * froze at the Design gate the same day. Invariants 4 and 5 are statements about ELAPSED TIME
 * and cannot be observed without either waiting 300 seconds or controlling the clock. This
 * repository has no fake-timer usage anywhere, so the first time-dependent test sets the
 * convention: an injected clock is ordinary production code, synchronous, and local to one
 * class, where `vi.useFakeTimers` is a global change to a test environment whose integration
 * tier spawns real processes.
 *
 * THE PORT IS UNCHANGED. This belongs to the in-memory implementation, not to `RevocationStore`
 * — a Redis-backed store (TASK-030) keys expiry off the server's clock and ignores it.
 */
export type Clock = () => number;

/**
 * The process-local implementation. A Map of session id to expiry, swept lazily.
 *
 * No timers: one `setTimeout` per revocation keeps the event loop alive unless every one of
 * them is `unref`ed, and an unref'd timer is a handle nobody in this repository owns. A
 * lazy sweep costs a walk of the map on write and nothing on read.
 */
export class InMemoryRevocationStore implements RevocationStore {
  /**
   * Production never passes `now` and gets `Date.now`. Tests pass their own and advance it.
   *
   * **Store it as `private readonly now` when you implement this.** It is a plain parameter
   * here, not a parameter property, for one stub-only reason: every body below throws, so a
   * stored property is never read and `noUnusedLocals` (`tsconfig.base.json:9`) rejects the
   * file — and TypeScript's underscore exemption covers unused *parameters*, not unused
   * private *properties*. Verified by compiling it both ways.
   */
  constructor(_now: Clock = Date.now) {}

  /**
   * DELETE THE KEY BEFORE SETTING IT. `Map.set` on an existing key keeps the ORIGINAL
   * insertion position, and `revoke` is idempotent with a refreshed TTL, so without the
   * delete a session revoked twice holds the newest expiry and the oldest position and is
   * evicted first. Eviction would then preferentially drop the entries someone took the
   * trouble to refresh. `revocation-store.spec.ts` asserts a re-revoked entry is not the
   * first evicted (ADR-0053).
   */
  revoke(_sessionId: string): Promise<void> {
    throw new Error('not implemented');
  }

  isRevoked(_sessionId: string): Promise<boolean> {
    throw new Error('not implemented');
  }
}

/** The bound instance. `auth.config.ts` writes to it; TASK-005's guard reads it. */
export const revocationStore: RevocationStore = new InMemoryRevocationStore();
