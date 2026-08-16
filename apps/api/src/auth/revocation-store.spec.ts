import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { ACCESS_TOKEN_LIFETIME_SECONDS } from '@shortkit/contracts';
import { describe, expect, it } from 'vitest';

import {
  InMemoryRevocationStore,
  REVOCATION_STORE_MAX_ENTRIES,
  REVOCATION_TTL_SECONDS,
  revocationStore,
} from './revocation-store';

/**
 * STORY-001 — TASK-003, wave 2. No AC states these; ADR-0053 and ADR-0013 do.
 *
 * Contract: `design/contracts/revocation-store.md` ("Error cases", "Invariants a caller may
 * rely on", "Spec obligations"). ADR-0053, ADR-0013, ADR-0012.
 *
 * ============================================================================
 * TIME IS INJECTED, NOT FAKED. THIS FILE IS WHERE THAT CONVENTION STARTS.
 * ============================================================================
 *
 * Ruled by Juano, 2026-08-16, amending `revocation-store.md` after it froze at the wave-2
 * Design gate — recorded in that contract under "Amendment: the injected clock" rather than
 * patched into it.
 *
 * Invariants 4 and 5 are statements about ELAPSED TIME and cannot be observed without
 * either waiting 300 seconds or controlling the clock. This repository has no fake-timer
 * usage anywhere (`grep -rn "useFakeTimers" apps packages` → zero hits), so whatever the
 * first time-dependent test does becomes the convention. `vi.useFakeTimers` is a global
 * change to a test environment whose integration tier spawns real processes; an injected
 * `Clock` is ordinary production code, synchronous, and local to the one class that needs
 * it. THE PORT IS UNCHANGED — a Redis-backed store (TASK-030) keys expiry off the server's
 * clock and ignores the parameter entirely.
 *
 * ============================================================================
 * ONE CONTRACT OBLIGATION IS NOT DISCHARGEABLE HERE, AND IT IS NAMED RATHER THAN FAKED.
 * ============================================================================
 *
 * `revocation-store.md` obligation 3 is "`revoke` resolves rather than rejecting when the
 * underlying store throws". `InMemoryRevocationStore` has no underlying store that can
 * throw — a `Map` read cannot fail, which the contract itself says twice — so the only way
 * to assert it here would be to inject a failing double and assert on the double. That is
 * testing the mock. What IS assertable is the same guarantee stated over inputs rather than
 * over faults ("`revoke` never rejects, for any input, including `''`"), and that is below.
 * The fault branch becomes real with TASK-030's Redis implementation and belongs to it.
 */

const SESSION = 'sess_2f8a1c0e5b7d4a93';
const ANOTHER_SESSION = 'sess_9d3c7e1a4f0b6285';

const MILLISECONDS_PER_SECOND = 1000;

/** A clock a test advances by hand. Epoch milliseconds, as `Date.now` reports them. */
function controllableClock(start = 1_700_000_000_000): {
  readonly now: () => number;
  readonly advanceSeconds: (seconds: number) => void;
} {
  let current = start;

  return {
    now: () => current,
    advanceSeconds: (seconds) => {
      current += seconds * MILLISECONDS_PER_SECOND;
    },
  };
}

describe('InMemoryRevocationStore', () => {
  it('ADR-0013: a revoked session reads as revoked and an untouched one does not', async () => {
    // The whole point of the store in one assertion, and it is a pair rather than a single
    // `true`: an implementation whose `isRevoked` returns `true` unconditionally satisfies
    // the first half and denies every request in the product.
    const clock = controllableClock();
    const store = new InMemoryRevocationStore(clock.now);

    await store.revoke(SESSION);

    expect({
      revoked: await store.isRevoked(SESSION),
      untouched: await store.isRevoked(ANOTHER_SESSION),
    }).toEqual({ revoked: true, untouched: false });
  });

  it('invariant 5: an entry lives exactly REVOCATION_TTL_SECONDS and not one second longer', async () => {
    // Both sides of the boundary, because each alone passes a broken implementation: an
    // entry that never expires passes the "still revoked" half, and one that expires
    // immediately passes the "no longer revoked" half.
    //
    // THE CONSTANT IS READ, NEVER RESTATED AS 300. `auth-contracts.md` invariant 4 requires
    // the token lifetime and the revocation TTL to be one number declared once, and a test
    // that spelled the number would pass while the two drifted apart.
    const clock = controllableClock();
    const store = new InMemoryRevocationStore(clock.now);

    await store.revoke(SESSION);

    clock.advanceSeconds(REVOCATION_TTL_SECONDS - 1);
    const justBefore = await store.isRevoked(SESSION);

    clock.advanceSeconds(1);
    const atExpiry = await store.isRevoked(SESSION);

    expect({ justBefore, atExpiry }).toEqual({ justBefore: true, atExpiry: false });
  });

  it('invariant 4: re-revoking extends the entry to a full TTL from the second write', async () => {
    // Idempotent with a REFRESHED TTL, not idempotent as a no-op. The second `revoke` lands
    // one second before the first entry would have expired, and the check happens one second
    // before the SECOND entry would — a point the original entry is long dead at, so an
    // implementation that ignores a repeat write fails here.
    const clock = controllableClock();
    const store = new InMemoryRevocationStore(clock.now);

    await store.revoke(SESSION);
    clock.advanceSeconds(REVOCATION_TTL_SECONDS - 1);
    await store.revoke(SESSION);
    clock.advanceSeconds(REVOCATION_TTL_SECONDS - 1);

    expect(await store.isRevoked(SESSION)).toBe(true);
  });

  it('F-177: a re-revoked entry is not the first evicted when the ceiling is crossed', async () => {
    // ============================================================================
    // THE ASSERTION THAT PINS `delete` BEFORE `set`. WITHOUT IT THE DEFECT IS INVISIBLE.
    // ============================================================================
    //
    // `Map.set` on an EXISTING key keeps its original insertion position. `revoke` is
    // idempotent with a refreshed TTL, so without a `delete` first, a session revoked twice
    // holds the NEWEST expiry at the OLDEST position and is evicted first — eviction then
    // preferentially drops exactly the entries someone took the trouble to refresh.
    //
    // Eviction below the TTL is a CONTROL BYPASS, not a memory event (ADR-0053): a revoked
    // session becomes honoured again, the write path is attacker-reachable through sign-in
    // and sign-out, and what makes flushing the map expensive is TASK-004's IP-keyed
    // limiter, which ADR-0040 records does not bind in any environment that exists today.
    //
    // The fill stops one short of the ceiling so that the REFRESH cannot itself trigger an
    // eviction whichever order an implementation checks size in. Only the two writes after
    // it cross the line, and the entry that should go is `filled-1`.
    const clock = controllableClock();
    const store = new InMemoryRevocationStore(clock.now);

    for (let index = 0; index < REVOCATION_STORE_MAX_ENTRIES - 1; index += 1) {
      await store.revoke(`filled-${String(index)}`);
    }

    clock.advanceSeconds(1);
    await store.revoke('filled-0');

    await store.revoke('crosses-the-ceiling-1');
    await store.revoke('crosses-the-ceiling-2');

    expect({
      refreshed: await store.isRevoked('filled-0'),
      oldestNeverRefreshed: await store.isRevoked('filled-1'),
    }).toEqual({ refreshed: true, oldestNeverRefreshed: false });
  });

  it('ADR-0012: revoke resolves for every input, including the empty session id', async () => {
    // `revoke` REJECTING is a contract violation and not a degraded mode: the session row is
    // already deleted, the hook is queued after the write, and failing a sign-out because a
    // store misbehaved is the wrong trade. The write site is allowed to `await` it with no
    // `try`/`catch` of its own, which is only safe if this holds for every input.
    //
    // `''` is in the contract's error table with its own row — it resolves, writes nothing,
    // and logs. A long value is the other end: nothing bounds what a caller can pass.
    const clock = controllableClock();
    const store = new InMemoryRevocationStore(clock.now);

    await expect(store.revoke('')).resolves.toBeUndefined();
    await expect(store.revoke('x'.repeat(10_000))).resolves.toBeUndefined();
  });

  it('invariant 3: the empty session id reads as not revoked rather than as revoked', async () => {
    // `''` writes nothing, so it must not read back as `true` — a store that recorded it
    // would answer `true` for a `jti` claim that failed to decode, which is the shape a
    // guard sees when a token is malformed rather than revoked.
    const clock = controllableClock();
    const store = new InMemoryRevocationStore(clock.now);

    await store.revoke('');

    expect(await store.isRevoked('')).toBe(false);
  });

  it('invariant 5: the TTL is ACCESS_TOKEN_LIFETIME_SECONDS, not a second number', () => {
    // A shorter TTL lets a token minted one second before sign-out outlive its own
    // revocation entry, which is a revoked session honoured for the difference. The write
    // site holds a SESSION and not a token, so there is no `exp` to subtract from and the
    // full lifetime is the only safe value. `auth-contracts.md` invariant 4 fixes the two as
    // one number declared once, and `apps/web` imports the source with no build step, so a
    // change to it breaks `pnpm typecheck` at the moment it is made.
    expect(REVOCATION_TTL_SECONDS).toBe(ACCESS_TOKEN_LIFETIME_SECONDS);
  });
});

describe('the bound revocationStore', () => {
  it('ADR-0053: the exported instance is a live store, shared by the write site and the guard', async () => {
    // ONE INSTANCE PER PROCESS. Two would mean two maps and a sign-out that half-registers:
    // `auth.config.ts`'s `databaseHooks.session.delete.after` writes to this export and
    // TASK-005's guard reads it, and they must be looking at the same map.
    //
    // It takes no clock — production never passes one and gets `Date.now` — so this asserts
    // the write/read round trip only, with no time in it.
    await revocationStore.revoke(SESSION);

    expect(await revocationStore.isRevoked(SESSION)).toBe(true);
  });
});

describe('the topology this store is correct on', () => {
  /**
   * ⚠ GREEN ON THE DAY IT LANDS, AND WRITTEN ANYWAY. `revocation-store.md`'s spec
   * obligation 5 and ADR-0053 both ask for it, and the reason is that it is a guard rather
   * than a proof: `InMemoryRevocationStore` is correct only while ONE process serves, and
   * the assumption is invisible in every other artifact.
   *
   * The production change that fails it is a `deploy: replicas: 2` added to the `api`
   * service by someone scaling out — at which point a sign-out served by one container
   * leaves that session's tokens honoured by the other for up to REVOCATION_TTL_SECONDS,
   * silently, with every other test in this file still green.
   */
  const compose = readFileSync(
    fileURLToPath(new URL('../../../../docker-compose.yml', import.meta.url)),
    'utf8',
  );

  /** The `api:` service block: from its own key to the next key at the same indent. */
  function serviceBlock(name: string): string {
    const start = compose.indexOf(`\n  ${name}:\n`);

    expect(start, `docker-compose.yml declares no '${name}' service`).not.toBe(-1);

    const rest = compose.slice(start + 1);
    const next = rest.search(/\n {2}\S[^\n]*:\n/);

    return next === -1 ? rest : rest.slice(0, next);
  }

  it('ADR-0053: the api service declares no deploy, replicas or scale key', () => {
    const scaling = serviceBlock('api')
      .split('\n')
      .filter((line) => /^\s+(deploy|replicas|scale):/.test(line))
      .map((line) => line.trim());

    expect(scaling).toEqual([]);
  });
});
