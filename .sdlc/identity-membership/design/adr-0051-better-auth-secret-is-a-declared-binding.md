---
id: ADR-0051
slug: identity-membership
title: BETTER_AUTH_SECRET is a declared binding passed explicitly, because the library's own check keys on NODE_ENV
status: accepted
supersedes: null
amends: ADR-0013
date: 2026-08-13
---

## Context

Seven ADRs, three contracts and seventeen TASK cards mention `BETTER_AUTH_SECRET`. All of
them mention it descriptively. **Nothing binds it, nothing asserts it, and no TASK card owns
it.** ADR-0044 line 104 even reasons from it — "a process that can read the row can usually
also read `process.env.BETTER_AUTH_SECRET`" — a sentence that assumes the variable is set.

Read from the pinned `better-auth@1.6.26`, `dist/context/create-context.mjs:66-80`:

```js
const legacySecret = options.secret || env.BETTER_AUTH_SECRET || env.AUTH_SECRET || "";
secret = legacySecret || "better-auth-secret-12345678901234567890";
validateSecret(secret, logger);
```

and `validateSecret` at `:38-45`:

```js
if (isTest()) return;
if (isDefaultSecret && isProduction) throw new BetterAuthError("You are using the default secret...");
if (!secret) throw new BetterAuthError("BETTER_AUTH_SECRET is missing...");
if (secret.length < 32) logger.warn(...);
```

Three consequences, in order of how much they matter:

1. **`isTest()` returns early.** The test tier is exempt from validation entirely, so no test
   in any tier will ever catch a missing secret.
2. **The default-secret throw fires only under `isProduction`.** Development is uncovered.
3. **The `!secret` throw is unreachable**, because the `|| DEFAULT_SECRET` on the line above
   guarantees a truthy value. The 39-character default also clears the `length < 32` warning.

So with the variable unset in development, the process boots silently on a constant published
in the package. That constant is the symmetric key for `jwks.privateKey`
(`plugins/jwt/utils.mjs:46-54`). **One `jwks` row plus a value everyone already has is the
JWT signing key**, and every control this initiative builds — `tid`, the mint-time lookup,
`app.tenant_id`, every RLS policy — is derived from a claim in a token that can then be
forged for any user in any tenant.

The live exposure is local `pnpm dev`. `Dockerfile:83` sets `NODE_ENV=production`
unconditionally, so the compose stack would refuse to boot — GC-B's hazard acting, for once,
as a mitigation.

**And the shape is GC-B's own hazard arriving from inside a dependency.** GC-B says no
behavioural choice may key on `NODE_ENV`. This one does, it is in `node_modules`, and the
rule this project wrote for itself cannot reach it.

## Decision

**`BETTER_AUTH_SECRET` is a declared binding, asserted at boot without consulting
`NODE_ENV`, and passed explicitly into `betterAuth({ secret })` rather than left to the
library's environment lookup.**

### The binding

| Variable | Values | Unset binds to | Assertion |
|---|---|---|---|
| `BETTER_AUTH_SECRET` | any string of at least 32 characters that is not the library default | **nothing — boot fails** | unconditional, every environment |

There is no enumerated value set, so GC-B's obligation is its other half: state what an unset
value binds and make it fail everywhere. It binds to nothing. The assertion runs in
development, in test and under compose, identically, because the environment where this is
most likely to be unset is the one the library's own check skips.

Two rejections encoded in the assertion:

- **the library default `better-auth-secret-12345678901234567890` is rejected by value.**
  Not by length, not by entropy — by exact comparison. It is 39 characters and passes both
  heuristics.
- **shorter than 32 characters is rejected**, promoting the library's warning to a failure.

### Where it is asserted

`apps/api/src/auth/boot-assertions.ts`. The file does not exist yet; **TASK-003 creates it,
in wave 2**, and TASK-004 adds `assertBffProxySecretConfigured()` and
`assertAuthRoleSeparation()` (ADR-0050) to it in wave 3. The assertion runs before the app
accepts traffic, on the same path as `assertRuntimeRoleCannotBypassRls`.

**Moved from TASK-004 to TASK-003 by Juano's ruling, 2026-08-13 (F-033).** The original
placement left wave 2 shipping a composed auth config whose secret nothing checked, which is
F-020's original state for the length of a wave. The config and its guard land together.

### Passed explicitly

`options.secret` is first in the library's precedence chain, so TASK-003 writes:

```ts
betterAuth({ secret: betterAuthSecret(), /* ... */ })
```

This takes the library's env lookup and its `NODE_ENV`-keyed validation out of the path
entirely: by the time `betterAuth` runs, the value has already been checked by our rule, in
every environment.

### `betterAuthSecret()` throws. It never returns a falsy value

**Added 2026-08-13 (F-033).** "Reads the declared binding" left the absent case unspecified,
and the absent case is the one that matters.

```ts
/**
 * The declared BETTER_AUTH_SECRET binding.
 *
 * THROWS when the variable is unset, empty, shorter than 32 characters, or equal to the
 * library's published default. It never returns undefined and never returns ''.
 *
 * `options.secret` is the FIRST OPERAND OF A `||` CHAIN, not an override
 * (create-context.mjs:70). A falsy return falls straight through to
 * env.BETTER_AUTH_SECRET, then env.AUTH_SECRET, then the published constant
 * 'better-auth-secret-12345678901234567890', which is the symmetric key for
 * jwks.privateKey. Returning '' here silently restores exactly the state this ADR exists
 * to remove, and every gate stays green.
 */
export declare function betterAuthSecret(): string;
```

Measured against the pinned `better-auth@1.6.26`, one process per row, `BETTER_AUTH_SECRET`
and `AUTH_SECRET` unset:

| `betterAuth({...})` argument | `NODE_ENV` | resulting `ctx.secret` |
|---|---|---|
| no `secret` key | development | the published default |
| no `secret` key | test | the published default |
| no `secret` key | production | throws `BetterAuthError` |
| `secret: ''` | development | **the published default** |
| `secret: undefined` | development | **the published default** |
| `secret: 'AUDIT-EXPLICIT-...'` | development | ours |
| `secret: 'AUDIT-EXPLICIT-...'` + env set to junk | development | ours |

The mechanism works, and it works only for a non-empty return. Rows four and five are why the
accessor throws rather than returning a default, a sentinel or `undefined`.

**Two checks, one rule.** `betterAuthSecret()` and `assertBetterAuthSecretConfigured()` apply
the same three rejections (unset-or-empty, shorter than 32, equal to the published default).
The accessor throws at the point of use so no falsy value can reach the `||` chain; the boot
assertion throws before the process serves, so a misconfiguration is a refusal to boot rather
than a failure on the first sign-in. Both live in wave 2, and the duplication is deliberate:
an accessor that trusts a boot assertion is an accessor that is unsafe in a unit test, a
script or a worker that never ran one.

`auth.config.spec.ts` asserts the composed config carries a secret that is not the default —
the same shape ADR-0013 already requires for `rateLimit.enabled === false`, and for the same
reason. It is a fact that degrades silently.

### The value must not be logged

The secret is not in `LOGGABLE_FIELDS` and no field name is added for it. The boot assertion
reports **that** it failed and which rule it broke, never the value or a prefix of it —
unlike the user id in ADR-0045, where a prefix is useful and the value is not a credential.

## Alternatives considered

| Option | Pros | Cons | Why not |
|---|---|---|---|
| Set the variable in `.env.example` and compose and rely on the library's own validation | Nothing to write; the library already throws | It throws under `isProduction` only, and returns early under `isTest()`. The two environments that exist (ADR-0030) are development and test — the two it does not cover. Relying on it is relying on a check that is off wherever it would fire | The check exists and does not run where it is needed |
| Assert only under compose, where the secret matters | Smaller surface; local development stays frictionless | This is a behavioural choice keyed on the environment, which is what GC-B forbids, and it would be keyed on `NODE_ENV` because that is the only signal compose provides. It also leaves `pnpm dev` — the live exposure — uncovered | GC-B, exactly |
| Generate a random secret at boot when unset | No configuration; nothing to forget | Every restart invalidates every `jwks` row, because the private keys were encrypted with the previous secret and `symmetricDecrypt` throws `Failed to decrypt private key`. Multi-instance deployment mints tokens no other instance can verify | Silently breaks the thing it is protecting |
| Use `BETTER_AUTH_SECRETS` (the array form) with rotation | The library supports it and it is where rotation lives | Rotation is a capability nothing in this initiative needs and `validateSecretsArray` is a second validation path to reason about. It is the right shape for a system with a deploy target | Speculative; ADR-0030 says there is no deploy target |

## Consequences

### Positive

- The one credential that makes every other control in this initiative meaningful is
  required, checked by value, and checked in the environment the library skips.
- The check does not consult `NODE_ENV`, so it behaves identically under `pnpm dev`,
  `pnpm test:integration` and `docker compose up`.
- Passing `secret` explicitly means a future library change to the env-lookup precedence
  cannot change which value is used.

### Negative / accepted cost

- **Another required environment variable**, in the same wave as ADR-0050's
  `DATABASE_AUTH_URL`. Two new boot failures land on a developer who pulls and runs, and both
  will read as regressions before they read as protections.
- **The rejection is by exact value, so it goes stale.** If `better-auth` changes its default
  constant in a later release, the assertion silently stops matching it and the check reverts
  to a length test. The pin (ADR-0018) is what bounds this, and the upgrade procedure has to
  re-read `create-context.mjs`. That is a manual step with no gate behind it.
- **32 characters and "not the default" is a weak definition of a good secret.** It admits
  `aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`. The library's entropy heuristic is not adopted, because
  a heuristic that warns rather than fails is a rule nobody obeys, and one that fails on a
  legitimate value is worse. So the check is a floor, not a judgement.
- **The three rejections are written twice**, once in `betterAuthSecret()` and once in
  `assertBetterAuthSecretConfigured()`, and nothing makes them agree. Added 2026-08-13
  (F-033). One shared predicate in the same module is the repair and it is the implementer's
  to make; what this ADR requires is that neither path can be satisfied by a falsy value.
- **TASK-003's surface grew to close a one-wave window.** It now creates
  `apps/api/src/auth/boot-assertions.ts`, a file TASK-004 was going to own, and edits
  `main.ts`. TASK-004 then adds to a file it did not create. The alternative was wave 2
  booting on the published constant with nothing checking, which is F-020's original state.
- **The unit test asserts the composed config, which is not the running process.** A test can
  pass while the deployed process reads a different environment. That gap exists for
  `rateLimit.enabled` too, and the boot assertion is what closes it.
- This does not protect the `jwks` row itself. ADR-0050 keeps `shortkit_app` away from it and
  ADR-0044 records that `shortkit_auth` must read it. **Neither ADR is sufficient alone**: the
  row is useless without the secret and the secret is useless without the row, and the two
  decisions are what keep them apart.

### Follow-ups this creates

- TASK-003 passes `secret` explicitly and asserts it in `auth.config.spec.ts`.
- ~~TASK-004 owns `assertBetterAuthSecretConfigured()` in `apps/api/src/auth/boot-assertions.ts`
  and its call in `main.ts`, alongside `assertBffProxySecretConfigured()`.~~
  **Moved to TASK-003, wave 2, by Juano's ruling 2026-08-13 (F-033).** TASK-003 owns
  `betterAuthSecret()`, `assertBetterAuthSecretConfigured()`, the new
  `apps/api/src/auth/boot-assertions.ts` file, and the call in `main.ts`. TASK-004 adds
  `assertBffProxySecretConfigured()` and ADR-0050's `assertAuthRoleSeparation()` to the file
  TASK-003 created, in wave 3.
- ~~TASK-009 adds `BETTER_AUTH_SECRET` to `.env.example`, `docker-compose.yml`,
  `docker-compose.test.yml` and the README, with a generation command.~~

  **Split by wave 2026-08-13 (F-034), Juano's ruling.** That bullet named a TASK and not a
  wave, and the wave is the whole problem. `assertBetterAuthSecretConfigured()` is
  unconditional and lands in TASK-003, wave 2, so from wave 2 an `api` container with no
  `BETTER_AUTH_SECRET` refuses to boot. TASK-009 is wave 4. A boot assertion is only as early
  as the binding it asserts.

  - **TASK-018, wave 0** declares `BETTER_AUTH_SECRET` on `docker-compose.yml`'s `api`
    service, in the `environment:` block that carries `DATABASE_URL` and nothing else today
    (`docker-compose.yml:227-228`), beside the `CREATE ROLE` work that card already owns in
    that file. `docker-compose.test.yml` has no `api` service and needs no entry.
    `apps/api/test/support/auth-fixture.ts:85` already sets a 53-character value on the
    spawned API child process, and TASK-018 owns that file, so the integration tier is
    already covered.
  - **TASK-009, wave 4** keeps `apps/api/.env.example` and the README, with the generation
    command. Documentation may land after the binding. The binding may not land after the
    process that refuses to boot without it. Waves 2 and 3 would otherwise ship a repository
    whose `compose` job cannot go green: `gate` is the required check and it fans in three
    jobs, of which `compose` is one (`.github/workflows/ci.yml:382-386`). The two cheapest
    repairs under that pressure are deleting this ADR's assertion, or giving ADR-0050's
    `DATABASE_AUTH_URL` a fallback to `DATABASE_URL`.
  - **`apps/web/.env.example` gets neither variable.** It is a Vercel project's environment,
    with a different access list and a different audit trail, and `apps/web` reads neither
    value. `apps/web/scripts/assert-no-inlined-secrets.mjs` searches for `BFF_PROXY_SECRET`'s
    value specifically, so a secret added there is outside the guard that covers that file.
- ~~**The integration tier needs a value or it cannot boot the auth surface**, and `isTest()`
  means the library will not complain. Whoever owns the test database's environment owns
  this; on the current plan that is nobody, which is the same gap ADR-0050 reports.~~

  **Corrected 2026-08-13: it already has one.** `apps/api/test/support/auth-fixture.ts:85`
  sets `BETTER_AUTH_SECRET: 'integration-fixture-better-auth-secret-not-a-real-key'` on the
  API child process. Checked: 53 characters, not equal to the published default, so it passes
  both rejections and the integration tier boots under the new assertion with no change. The
  fixture's own docblock says it decides these names because nothing else did, and that is
  still true — this ADR is now what names it, and the fixture is where the value lives.

  What the fixture does **not** carry is `DATABASE_AUTH_URL` (ADR-0050). The API child
  process it spawns will refuse to boot from wave 2 without one. That is a fixture change,
  not a secret change, and it belongs with ~~the wave-1 provisioning work~~ **TASK-018, wave
  0** (F-034, 2026-08-13), which holds `auth-fixture.ts` in its `paths` and lands before the
  pool that reads the DSN exists.
- ADR-0013's plugin configuration block does not mention `secret`. This ADR is the amendment;
  ADR-0013 is frozen and is not edited.
