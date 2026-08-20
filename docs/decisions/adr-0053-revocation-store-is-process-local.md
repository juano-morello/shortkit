---
id: ADR-0053
slug: identity-membership
title: The revocation store is a process-local map, and the single-process assumption is asserted rather than assumed
status: accepted
supersedes: null
supersedes_in_part: ADR-0013
date: 2026-08-14
---

## Context

ADR-0013 specified Redis: `sk:{env}:revoked:jti:<session.id>` with `EX = 300`, written by
`databaseHooks.session.delete.after` and read by `AuthGuard`. `auth-tokens.md` restates it
and is frozen.

There is no Redis in this repository. Grepped: no `redis` or `ioredis` dependency in any
`package.json`, no `createClient` anywhere in `apps/api/src`, and the four files that
mention Redis mention it in prose about a hypothetical timeout. `redisClient` is deferred
TASK-030, which is not in this initiative. TASK-003's card refuses to decide the
replacement and hands it here.

What the topology actually is, measured rather than assumed. `docker-compose.yml`'s `api`
service carries no `scale`, `replicas` or `deploy` key, so Compose runs one container. No
`fly.toml`, `render.yaml` or any other deploy manifest exists in the repository, and
ADR-0030 put the deploy target out of scope. One process serves, in Compose and in CI's
`compose` job, and nothing else runs the API at all.

So a process-local store is correct on every topology this repository has today and
silently wrong on the first one it does not have. A sign-out served by process A leaves
that session's tokens honoured by process B for up to the full 300-second lifetime, the
logout reports success, and no test anywhere fails.

Two more facts shape the port. TASK-005 is the reader, one wave later, and its card fixes
the guard's posture as skip-open when the store is unavailable, matching ADR-0012. And the
write hook fires on every session deletion, not only sign-out: `dist/db/with-hooks.mjs`
reads rows before deleting and invokes `delete.after` once per row, so expired-session
cleanup writes an entry per deleted row.

## Decision

**`apps/api/src/auth/revocation-store.ts` declares the port and ships one process-local
implementation. The single-process assumption the implementation depends on is asserted by
a unit test, not left in a comment.**

### The port

```ts
export interface RevocationStore {
  revoke(sessionId: string): Promise<void>;
  isRevoked(sessionId: string): Promise<boolean>;
}
```

The normative form, with every doc comment, is `docs/contracts/revocation-store.md` and
the stub at `design/stubs/apps/api/src/auth/revocation-store.ts`.

**`revoke` never rejects. `isRevoked` may.** The asymmetry is the decision and it is not
an oversight.

`revoke` runs after the session row is already gone, on a hook queued after the write, so a
rejection has nothing to roll back and would fail a sign-out because a store was
unavailable. ADR-0012's posture and ADR-0013 both forbid that. A failure is logged and
swallowed.

`isRevoked` rejects with `RevocationStoreUnavailableError` when it cannot answer, and the
caller decides. A port that returns `false` for both "not revoked" and "could not tell"
makes an unreachable store indistinguishable from a valid token at the one place the
difference matters, and it gives TASK-005 nothing to count. This is F-245's rule applied one
level down: "could not answer" is not "answered safely". `InMemoryRevocationStore` never
raises it, because a Map read cannot fail, and that unreachable branch in TASK-005 is
stated in the contract so the guard's author knows it is unreachable today and required
anyway.

### The implementation

`InMemoryRevocationStore`: a `Map<string, number>` from session id to expiry in epoch
milliseconds.

- **No timers.** One `setTimeout` per revocation keeps the event loop alive unless every one
  is `unref`ed, and an unref'd handle is a thing nobody in this repository owns. Entries are
  swept lazily: `isRevoked` treats an expired entry as absent and deletes it, and `revoke`
  sweeps expired entries before it inserts.
- **`REVOCATION_TTL_SECONDS = ACCESS_TOKEN_LIFETIME_SECONDS`,** imported from
  `@shortkit/contracts` rather than written as 300. `auth-contracts.md` invariant 4 requires
  the lifetime and the TTL to be one number declared once, and the card's `Produces` block
  writes `REVOCATION_TTL_SECONDS = 300` as a literal. The import satisfies both readings.
- **`REVOCATION_STORE_MAX_ENTRIES = 10_000`,** enforced by pruning expired entries first and
  then evicting in insertion order. This copies the shape of `better-auth`'s own memory
  store, which caps at `MEMORY_STORE_MAX_ENTRIES = 1e5` and prunes before evicting
  (`dist/api/rate-limiter/index.mjs:6-18`, quoted in ADR-0013). Without a ceiling, a cleanup
  sweep that deletes a million expired sessions writes a million entries that each live 300
  seconds, on a process with no other memory pressure.
- **`revoke` deletes the key before it sets it.** `Map.set` on an existing key keeps the
  original insertion position, and invariant 4 makes `revoke` idempotent with a refreshed
  TTL. Without the delete, a session revoked twice holds the newest expiry and the oldest
  position, so it is evicted first: eviction would preferentially drop the entries someone
  took the trouble to refresh. `delete` then `set` makes insertion order track current
  expiry, which is what the eviction policy assumes. `revocation-store.spec.ts` asserts that
  a re-revoked entry is not the first evicted.
- **An eviction is logged once, at `warn`, with `code: 'auth_revocation_evicted'.** `code` is
  already in `LOGGABLE_FIELDS`, so this adds no name to the allowlist and creates no
  wave-parallel conflict on that file.

### What makes the latent failure visible

Three mechanisms, in increasing order of how much work they do.

**1. A `warn` line, once per process, on the first `revoke`.** `code:
'auth_revocation_process_local'`, message stating that revocation does not cross processes.
It costs one boolean and it is present wherever the process runs, including a topology
nobody predicted. It does not go stale.

**2. A unit assertion that Compose still runs one `api`.**
`apps/api/src/auth/revocation-store.spec.ts` reads `docker-compose.yml` and fails if the
`api` service gains a `deploy:`, `replicas:` or `scale:` key. The failure message names this
ADR and says what to do. It is one file and one service, so it is not a list that goes
stale, and it fires on the exact diff that makes the store wrong in the one deployment this
repository actually has.

**3. ADR-0030 is named as the trigger for everything else.** There is no deploy manifest to
assert against, and enumerating the filenames of platforms this repository might one day use
is the list-staleness cost ADR-0051 has already accepted twice for a worse reason. Adding a
deploy target supersedes ADR-0030, and that superseding ADR is where this decision is
re-read. Recorded as a coupling rather than pretended to be a mechanism.

**TASK-030 owns the replacement.** When `redisClient` exists, `RedisRevocationStore`
implements the same port, `revocationStore` binds to it, and mechanisms 1 and 2 come out in
the same commit. Nothing about TASK-003's write site or TASK-005's read site changes,
because both hold the port.

## Alternatives considered

| Option | Pros | Cons | Why not |
|---|---|---|---|
| Ship no store: `revoke` is a no-op, `isRevoked` always returns `false`, until TASK-030 | Honest about the absent dependency. No memory to bound, no eviction to price, nothing that looks stronger than it is | TASK-005 in wave 4 then writes a guard step against a port with no behaviour, and its integration test cannot assert AC-21's "the prior credential stops working". The step becomes dead code that nobody exercises until TASK-030, which is the state F-025 was filed for. It also makes sign-out do nothing on the one topology that exists, where the process-local store makes it correct | It removes a working control on today's topology to avoid a caveat about a topology nobody runs |
| Timer-per-entry: `setTimeout(..., TTL).unref()` deleting the key | Exact expiry, no sweep, no ceiling needed because entries remove themselves | One timer per session deletion, so a cleanup sweep of a million rows schedules a million timers. `unref` is required or the process will not exit, and a forgotten `unref` is invisible until a container refuses to stop. Timers also make the store non-deterministic under fake timers in a unit test | Buys exact expiry, which nothing needs, and pays with a handle-leak failure mode this repository has already been bitten by (`main.ts:86-93`) |
| No ceiling on the map | Simpler. No eviction path, so a revoked session is never un-revoked early | The hook fires on expired-session cleanup, so the write volume is not bounded by sign-outs. An unbounded map on a single-instance process with no memory limit is F-028's defect, in our own code this time rather than in a dependency | The dependency in the tree already solved this and its solution is three lines |
| `isRevoked` returns `false` on failure, so the store owns skip-open | Symmetric with `revoke`. TASK-005's guard step is one line with no try/catch | The guard cannot count the degradation `auth-tokens.md` names, and cannot log it. When Redis arrives, the skip-open decision sits in the store rather than in the guard, so a second caller with a different posture has no way to express it | The port would be unable to say "I could not tell", which is the only thing that distinguishes a degraded check from a passing one |
| Assert against an enumerated list of deploy manifests (`fly.toml`, `render.yaml`, k8s) | Fires when a real deploy target appears, which is the case that matters most | The list is kept current by nobody, and a platform not on it adds no signal at all while reading as though it does. ADR-0051 has already paid this cost twice on one variable | A control that is silently incomplete is worse than a stated coupling, because the stated coupling does not claim to be a mechanism |
| Postgres table with `SKIP LOCKED`-style polling, or an advisory-lock scheme, to get cross-process revocation without Redis | Correct across processes today. Uses infrastructure that already exists | A read on the guard's happy path, which `auth-tokens.md` forbids in as many words ("No database read and no store read on the happy path"), and ADR-0002's ordering problem returns because the read runs before the tenant transaction opens. It also puts an auth-table write on a pool whose role split ADR-0050 just finished drawing | It buys correctness on a topology nobody runs by breaking a stated invariant on the one they do |

## Consequences

### Positive

- Sign-out revokes on every topology this repository runs, so AC-21's mechanism is real in
  wave 2 rather than deferred to wave 6 behind TASK-030.
- TASK-005 writes its guard step against a port that will not change when Redis arrives.
  The port is the whole point of the file; the map is an implementation detail behind it.
- The single-process assumption is asserted by a test rather than described in a comment, so
  the diff that breaks it is red.
- No new name in `LOGGABLE_FIELDS`, so nothing here collides with a wave-parallel TASK.

### Negative / accepted cost

- **Two processes and revocation is partial, for up to 300 seconds per session, with no
  runtime signal that it happened.** Mechanism 2 catches the Compose diff. It does not catch
  a platform that scales an image without touching `docker-compose.yml`, and nothing else
  does either. This is the headline cost and it is accepted because no such platform exists
  in this repository today.
- **A restart drops every entry.** All outstanding revocations are forgotten, so a token
  minted before a sign-out and before a restart is honoured again for its remaining
  lifetime. Redis would have survived it. Bounded by the 300-second lifetime, and a restart
  is already an event that clears in-process JWKS caches.
- **Eviction is a control-bypass primitive, not a capacity accident, and its cost is set by a
  limiter in another card.** Corrected 2026-08-16 after the wave-2 security pass. Above
  10,000 live entries the oldest is dropped and a revoked session becomes honoured again.
  The write path is attacker-reachable: every session deletion writes an entry, and sign-in
  followed by sign-out is that path. An attacker holding a stolen token whose session was
  just revoked can in principle flush the victim's entry by driving 10,000 session deletions
  inside the 300-second window, and have the stolen token honoured for the remainder of its
  life.

  What makes that expensive is TASK-004's IP-keyed limiter, at 3 sign-ups per hour and 10
  sign-ins per 5 minutes per IP. **So the cost of this bypass is set by a control in another
  card, and ADR-0040 records that no IP-keyed limit binds in any environment that exists
  today**, because `resolveRateLimitPrincipal` returns `null` where no trusted-address header
  is declared. Naming the coupling rather than leaving the ceiling to read as a memory bound.

  The eviction logs at `warn` with `code: 'auth_revocation_evicted'`, and nobody reads the
  log. Raising the ceiling trades memory for attacker effort and does not remove the
  primitive; only a store with no ceiling, or one outside the process, does.
- **The port's asymmetry is a thing to get wrong.** `revoke` never rejects and `isRevoked`
  may, which reads as an inconsistency to anyone who has not read this section. The contract
  states it twice for that reason.
- **A unit test now reads `docker-compose.yml`,** coupling a file in `apps/api/src` to a
  file at the repository root that four other TASKs write. A Compose refactor that renames
  the `api` service turns this red for a reason that has nothing to do with revocation.
- **`ACCESS_TOKEN_LIFETIME_SECONDS` becomes a dependency of the store,** so
  `revocation-store.ts` imports from `@shortkit/contracts`. That is one more edge in the
  API's dependency graph on a package whose whole point is that it has almost none.
- **This supersedes ADR-0013 in part and `auth-tokens.md` is frozen.** The contract's
  Revocation section names Redis, a key format and `auth_revocation_degraded_total`, and
  none of the three exists. See the conflict note below; the amendment is not this ADR's to
  make.

### Follow-ups this creates

- TASK-003 ships `revocation-store.ts`, its unit spec, and the `databaseHooks.session.delete.after`
  write. **The card's `test_files` does not list `revocation-store.spec.ts`** and it needs to:
  the store has TTL arithmetic, an eviction path and the Compose assertion, and none of them
  is covered by the five files the card names.
- TASK-005 catches `RevocationStoreUnavailableError` and skips open, per `auth-tokens.md`
  step 5. Its own card already says so.
- TASK-030 binds a Redis implementation to the same port and removes mechanisms 1 and 2 in
  that commit. **Superseded 2026-08-19: see the note immediately below.**

### `redisClient` now exists, and this store still does not use it (2026-08-19, D-2-01)

Item 2 (links and the redirect hot path) landed `apps/api/src/cache/redis-client.ts`:
`ioredis` is a dependency of `@shortkit/api`, one client is constructed on ADR-0012's six
options when `REDIS_URL` is declared, and the redirect cache is bound to it (TASK-2-03,
ADR-0012, `redirect-cache.md`). **Two sentences in this ADR are therefore now false as
written and are corrected here rather than left standing:** the Context's "no `redis` or
`ioredis` dependency in any `package.json` … `redisClient` is deferred TASK-030, which is
not in this initiative", and the follow-up above.

**Juano ruled DEFER (D-2-01, 2026-08-19).** The revocation store stays
`InMemoryRevocationStore` and the three rate limiters stay process-local
(`LocalAuthRateLimiter`, `rate-limit.md`'s per-machine tenant bucket). One process is still
the only topology (ADR-0030 stands, `docker-compose.yml` runs one `api`, and there is still
no deploy manifest), so a Redis-backed store buys nothing behaviourally at N=1 except
revocations surviving an API restart, bounded at 300 s, and it would put a new moving part
on the auth path in the same wave the cache's failure posture is being proven. The cost of
deferring is this paragraph; the cost of taking it was degraded-path parity tests for three
limiters and a store, spent on a property no running topology exhibits.

**The trigger moves with the ruling.** This ADR's replacement condition is no longer "when
`redisClient` exists". It exists. It is now **the ADR that supersedes ADR-0030, or the
first topology running more than one API process, whichever comes first.** That is the same
condition mechanism 3 already names, so the two now agree instead of the earlier one firing
first and silently.

**Mechanisms 1 and 2 stay**, both of them: the once-per-process `warn` on the first `revoke`
(`code: 'auth_revocation_process_local'`), and `revocation-store.spec.ts`'s assertion that
`docker-compose.yml`'s `api` service has gained no `deploy:`, `replicas:` or `scale:` key.
Item 2 adds a `redis` service to that file (D-2-16); the assertion reads the `api` service
only and is unaffected.

Nothing in `auth/` or `common/rate-limit/**` changed in item 2, and nothing may reach the
client to change it quietly: `cache.module.ts` is its only caller, and
`redis-client.spec.ts` fails if any file outside `apps/api/src/cache/**` names
`redisClient`. Rebinding is a card (`TASK-2-15`, written and dormant), not an import.
- **`auth_revocation_degraded_total` does not exist and no metrics facility exists in
  `apps/api/src`.** Grepped: zero hits for the counter name and no counter or metric
  registry anywhere in the tree. `auth-tokens.md` and ADR-0013 both name it. Until something
  provides one, the degradation is a `warn` line carrying `code`, and that substitution is
  recorded here rather than left as an unmet obligation in a frozen contract.
