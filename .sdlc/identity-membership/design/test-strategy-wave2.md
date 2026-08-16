# Test strategy — identity-membership, wave 2 (TASK-003)

Extends `test-strategy.md` (waves 0 and 1). Everything that file says about the three tiers,
the suffix trap and fixtures still holds; this covers what wave 2 adds. Grounding is
`test-scout-wave2.md`, every claim there carrying `file:line`.

Wave 2 is one card under STORY-001, claiming **AC-1, AC-3, AC-4, AC-5**.

## The suite this wave starts from

| Tier | Files | Tests | Time | State |
|---|---|---|---|---|
| unit (`apps/api`) | 18 | 137 | ~1.4 s | green |
| unit (root, all packages) | — | 236 | ~2.2 s | green |
| integration | 6 | 82 | ~5 min | green |

**None of TASK-003's target files exist.** Every test this wave writes is a new file.

## Three patterns this repository has never used

The scout searched for prior art and found none for any of these. Whatever wave 2 writes
becomes the convention, so each is decided here rather than per-test.

**1. Time — an injected clock, not fake timers.** Ruled by Juano 2026-08-16.
`InMemoryRevocationStore` takes `now: Clock = Date.now`; tests pass their own and advance it by
hand. `vi.useFakeTimers` is a global change to a test environment whose integration tier spawns
real processes, and this is one class needing one seam. **This amended `revocation-store.md`
after it froze** — recorded in that contract under *Amendment: the injected clock*, not patched
quietly. The port is unchanged; the parameter belongs to the in-memory implementation, and a
Redis store ignores it.

**2. Boot refusal — unit-test the predicate, separately assert the call site.** Ruled by Juano
2026-08-16. `assertBetterAuthUrlConfigured` is tested directly for accept and refuse; a second
test asserts `main.ts` calls it before `listen`. That is the shape
`assertRuntimeRoleCannotBypassRls` already has. **No spawned child**, which keeps a five-minute
tier from growing and avoids a spawn helper this repo does not have. The cost is stated: nothing
executes the real boot path for this guard, so the call-site assertion is load-bearing rather
than decorative.

**3. Whole-body response comparison.** `signup-creates-tenant.int-spec.ts` asserts a
duplicate-address and a fresh-address signup return **byte-identical bodies after normalising
`id`, `createdAt` and `updatedAt`**. Assert whole-body equality, never the absence of a named
key: the named form passes the day the library changes either branch. Pre-committed at the
Design gate with both outcomes — pass makes it the standing guard, fail means the existence
disclosure is real and gets accepted explicitly with ADR-0061 superseded.

## What each AC gets, and in which tier

| AC | Tier | File | Why there |
|---|---|---|---|
| **AC-1** signup creates one user, one tenant, one owner membership | integration | `test/auth/signup-creates-tenant.int-spec.ts` | Three tables and two roles. Nothing below the real database proves it. |
| **AC-3** claim set on a session created by **sign-in** | integration | same file | Needs a real mint. `jti` is the Better Auth session id, so it needs a real session row. **Premise amended 2026-08-16 (F-193)** — signup no longer creates a session. |
| **AC-4** mint refuses without a membership | integration | `test/auth/mint-refuses-without-membership.int-spec.ts` | TASK-002 covers `tenantIdForUser` throwing; this is the **mint leg**, and the failure must be raised before a payload is signed. |
| **AC-5** `rateLimit.enabled === false` on the composed config | unit | `src/auth/auth.config.spec.ts` | The AC says "without starting a server". |

**AC-5 is testable as written**, using `vi.stubEnv` plus dynamic import — the pattern
`health.spec.ts` already proves. The scout traced two frames into `better-auth@1.6.26` to
confirm `betterAuthDatabase()` fires synchronously at import, and left one item **NOT
VERIFIED**: whether an unawaited `init()` performs I/O. **The test architect resolves that by
running the test**, and reports it rather than working around it. If it does open a connection,
`auth.config.ts` needs a lazy accessor and that is a design finding, not a test workaround.

## Beyond the ACs — assertions this design pre-committed

These have no AC and are written anyway, because the Design phase committed to them in writing:

- **The loopback rule** (`boot-assertions.spec.ts`): `http://localhost:3001` accepted,
  `http://api.example.com` refused, refusal naming the rule. Guards the finding where a
  non-Secure session cookie shipped with every assertion green.
- **Eviction order** (`revocation-store.spec.ts`): a re-revoked entry is **not** the first
  evicted. `revoke` must `delete` before `set`; without it the newest expiry sits at the oldest
  position.
- **TTL** (`revocation-store.spec.ts`): an entry `REVOCATION_TTL_SECONDS` old resolves `false`
  and leaves the map. Read the constant, never restate 300.
- **`revoke` never rejects; `isRevoked` may.** Both directions asserted — the asymmetry is what
  stops a guard treating an unreachable store as proof of validity.
- **The four caller-list scans** (`src/db/better-auth-database-callers.spec.ts`): copy
  `context-flag-owners.spec.ts`'s idiom. **Anchor the regexes** — a bare `/'pg'/` matches the
  mandated `provider: 'pg'`, and a bare `/process\.env\[/` matches `build-commit.ts:39` today.
  Scan 2 is a **subset**; the other three are equalities.

## Fixtures

`test/support/auth-fixture.ts` already provides `authRequest`, `signUp`, `signIn`, `signOut`,
`getSession`, `mintToken`, `jwtClaims` and the table readers, and already sets
`DATABASE_AUTH_URL` — **the waves 0–1 strategy is stale on that point and this supersedes it.**

Two gaps the architect must close, both first-of-kind:

- **`jwtClaims` and `mintToken` have zero callers anywhere in the repo.** Wave 2 is the first
  exercise of that path. Expect to find defects in the helpers themselves and report them rather
  than route around them.
- **The fixture strips cookie attributes**, so nothing today can assert `Secure`, `HttpOnly`,
  `SameSite` or the `__Secure-` prefix. AC coverage does not require it; the config-surface
  contract's cookie table does. Extend the fixture rather than parsing headers in a spec.

## Deliberately not automated

- **The two-process revocation weakness.** ADR-0053's accepted cost. Reproducing it needs a
  second API process, which no tier runs and no deploy manifest exists to model.
- **Secret rotation orphaning the `jwks` rows** (ADR-0057). Needs a second secret and a restart;
  the ADR carries it as a coupling note and TASK-030 owns the mechanism.
- **`https://ex*.co.uk` trusting `exfiltrate-evil.co.uk`** (F-189, parked). Closable only with a
  public-suffix list.

## Red means red for the right reason

Unchanged from waves 0–1 and restated because it is the phase's whole point. Every new test must
fail as an **assertion** or on `not implemented` — never on an import error, a missing fixture
or a typo. A test that cannot load proves nothing about the code.

**This wave has a specific hazard.** All six target files are new and import modules that do not
exist, so the default failure is a module-resolution error — which is exactly the wrong red. The
six stubs exist for this: they compile and their bodies throw. **The architect proves the
correct red by copying the stubs to their real paths, recording the failures, and deleting them
again** — the method wave 1's architect used for F-046 and the reason its 42 blocked tests were
accepted as genuinely red.

**The orchestrator runs both suites and reads the failure reasons.** Not the architect's report.
Wave 1's gate note records that being what caught an implementer reporting nine green tests
against a stack it had torn down.
