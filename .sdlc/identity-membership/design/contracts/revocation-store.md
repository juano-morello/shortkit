# Contract: the revocation store

- **Boundary:** `apps/api/src/auth/revocation-store.ts`, between the write site
  (`auth.config.ts`'s `databaseHooks.session.delete.after`, TASK-003) and the read site
  (`AuthGuard` step 6, TASK-005, wave 4). Also the boundary between this initiative's
  process-local implementation and TASK-030's Redis one.
- **Normative form:** the TypeScript below, and the stub at
  `design/stubs/apps/api/src/auth/revocation-store.ts`, which typechecks against
  `apps/api/tsconfig.json` and passes `eslint.config.mjs`.
- **Produced by:** TASK-003.
- **Consumed by:** TASK-005. Replaced by TASK-030 (deferred, out of this initiative).
- **ADRs:** ADR-0053 (this store), ADR-0013 (`jti` is the session id, TTL 300, the write
  site), ADR-0012 (degradation posture).

## The normative form

```ts
import { ACCESS_TOKEN_LIFETIME_SECONDS } from '@shortkit/contracts';

/**
 * The full access-token lifetime, counted from the write.
 *
 * Derived, never restated as 300: `auth-contracts.md` invariant 4 requires the lifetime and
 * the revocation TTL to be one number declared once.
 */
export const REVOCATION_TTL_SECONDS = ACCESS_TOKEN_LIFETIME_SECONDS;

/** Entry ceiling. Above it, expired entries are pruned first, then the oldest is evicted. */
export const REVOCATION_STORE_MAX_ENTRIES = 10_000;

/**
 * Raised by `isRevoked` when the store could not answer. NEVER raised by
 * `InMemoryRevocationStore`: a Map read cannot fail.
 */
export class RevocationStoreUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions);
}

export interface RevocationStore {
  /**
   * Records that every token minted for `sessionId` is refused for
   * REVOCATION_TTL_SECONDS from now.
   *
   * NEVER REJECTS.
   */
  revoke(sessionId: string): Promise<void>;

  /**
   * Whether `sessionId` currently carries a live revocation entry.
   *
   * MAY REJECT with `RevocationStoreUnavailableError`.
   */
  isRevoked(sessionId: string): Promise<boolean>;
}

export class InMemoryRevocationStore implements RevocationStore {
  revoke(sessionId: string): Promise<void>;
  isRevoked(sessionId: string): Promise<boolean>;
}

/** The bound instance. `auth.config.ts` writes to it; `AuthGuard` reads it. */
export const revocationStore: RevocationStore;
```

`sessionId` is Better Auth's `session.id`, the primary key of the `session` row. It is the
value the JWT carries as `jti` (ADR-0013, F-227). It is **not** `session.token`, which is the
credential and must never reach this module, a log line or a key.

## Error cases

| Situation | `revoke` | `isRevoked` |
|---|---|---|
| Store healthy | resolves `undefined` | resolves `true` or `false` |
| Store unreachable or errors | **resolves.** Logs `warn` with `code: 'auth_revocation_degraded'` and swallows | **rejects** with `RevocationStoreUnavailableError` |
| `sessionId` is `''` | resolves, writes nothing, logs `warn` with `code: 'auth_revocation_degraded'` | resolves `false` |
| Entry evicted by the ceiling before its TTL | n/a | resolves `false`. The eviction logged `warn` with `code: 'auth_revocation_evicted'` at write time |
| Process restarted since the write | n/a | resolves `false`. Entries do not survive a restart |

No error thrown by this module carries a session id, a session token, a user id or an email
in its message. `LOGGABLE_FIELDS` gains no name: `code` is already on the allowlist and is
the only field these lines add.

**`revoke` rejecting is a contract violation, not a degraded mode.** `auth-tokens.md`'s
revocation table and ADR-0012 both fix this: the session row is already deleted, the hook is
queued after the write, and failing a sign-out because a store is unavailable is the wrong
trade. An implementation that lets an error escape `revoke` breaks the sign-out response.

**`isRevoked` rejecting is a normal, expected mode** for any implementation that does I/O.
The caller decides the posture and `auth-tokens.md` step 5 fixes it as skip-open.

## Invariants a caller may rely on

1. **One entry covers every token that session ever minted**, including tokens minted before
   the entry was written and tokens that would be minted after it. `jti` is the session id.
2. **`jti` is not unique per token.** Callers may not use it for replay detection or as a
   per-token cache key (`auth-tokens.md` invariant 5a).
3. **A resolved `false` from `isRevoked` means the store answered.** It never means "could
   not tell". That case rejects.
4. `revoke` is idempotent. Revoking the same session twice extends the entry to
   `REVOCATION_TTL_SECONDS` from the second write and is not an error. **Re-revoking also
   moves the entry to the back of the eviction order**, so a refreshed entry is never evicted
   before a stale one.
5. An entry lives at most `REVOCATION_TTL_SECONDS`, which equals the maximum token lifetime,
   so a token that outlives its revocation entry has also outlived its own `exp`.
6. `revoke` and `isRevoked` perform no database access and hold no connection from either
   pool. The revocation check is the guard's only non-database store read
   (`auth-tokens.md`, "Verification").

## What the caller may assume, and what the implementer must guarantee

**The write site (TASK-003) may assume** that awaiting `revoke` cannot fail its hook, so it
needs no `try`/`catch` of its own around the call.

**The read site (TASK-005) must** wrap `isRevoked` in a `try`/`catch`, treat a rejection as
skip-open, and log it. That catch is **unreachable with the implementation shipped in this
initiative** and is required anyway, because TASK-030 replaces the implementation without
touching the guard. Removing it as dead code re-opens the gap when Redis arrives.

**Any implementer must guarantee:**

- `revoke` never rejects, for any input, including `''` and a value longer than any session
  id.
- `isRevoked` rejects only with `RevocationStoreUnavailableError`, never with a driver error
  or a `TypeError`.
- Neither method logs a session id, a session token, a user id or an email.
- The TTL is read from `REVOCATION_TTL_SECONDS` and not restated.
- `revocationStore` is a single instance per process. Two instances mean two maps and a
  sign-out that half-registers.
- **`revoke` deletes the key before setting it.** `Map.set` on an existing key keeps the
  original insertion position, so without the delete a re-revoked session holds the newest
  expiry and the oldest position and is evicted first. Added 2026-08-16 after the wave-2
  security pass.
- Eviction below the TTL is a **control bypass**, not a memory event: the write path is
  attacker-reachable through sign-in and sign-out, and its cost is set by TASK-004's IP-keyed
  limiter, which ADR-0040 records does not bind in any environment that exists today
  (ADR-0053).

## Spec obligations

`apps/api/src/auth/revocation-store.spec.ts` asserts, at minimum:

1. `revoke` then `isRevoked` resolves `true`; a different session id resolves `false`.
2. An entry `REVOCATION_TTL_SECONDS` old resolves `false` and is removed from the map.
3. `revoke` resolves rather than rejecting when the underlying store throws.
4. **A re-revoked entry is not the first evicted** when the ceiling is crossed. This is the
   assertion that pins `delete`-before-`set`; without it the ordering defect is invisible.
5. `docker-compose.yml`'s `api` service declares no `deploy:`, `replicas:` or `scale:` key.

**This file is not in TASK-003's declared `test_files`** and needs to be added.

## Process-local scope, stated as part of the contract

`InMemoryRevocationStore` holds state in one process. **A caller may not assume that a
`revoke` on one process is visible to an `isRevoked` on another.** On the topology this
repository runs, one Compose container and no deploy manifest, there is only one process and
the assumption is safe. ADR-0053 holds the reasoning, the three mechanisms that make the
assumption visible, and the accepted costs.

`apps/api/src/auth/revocation-store.spec.ts` asserts that `docker-compose.yml`'s `api`
service declares no `deploy:`, `replicas:` or `scale:` key. That spec is **not in TASK-003's
declared `test_files`** and needs to be added; see ADR-0053's follow-ups.

## Versioning and backward compatibility

The port is the versioned artifact and the implementation is not. TASK-030 may replace
`InMemoryRevocationStore` with a Redis implementation with no change to `auth.config.ts` or
`auth.guard.ts`, provided:

- `revoke` still never rejects,
- `isRevoked` still rejects only with `RevocationStoreUnavailableError`,
- the key format carries the environment segment F-015 requires
  (`sk:{env}:revoked:jti:<sessionId>`, `redirect-cache.md`).

Adding a method is compatible. Changing `revoke` to reject, changing `isRevoked` to resolve
`false` on failure, or making `sessionId` mean anything other than `session.id` is breaking
and requires an ADR superseding ADR-0053 and ADR-0013 together, because the write site, the
read site and the claim move as one.

`ACCESS_TOKEN_LIFETIME_SECONDS` is `@shortkit/contracts`'s, and `apps/web` imports that
package's source with no build step (ADR-0005), so a change to it breaks `pnpm typecheck` at
the moment it is made. That is the compatibility mechanism for the TTL.
