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
it.** ADR-0044 line 104 even reasons from it ("a process that can read the row can usually
also read `process.env.BETTER_AUTH_SECRET`"), a sentence that assumes the variable is set.

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
JWT signing key**, and every control this initiative builds (`tid`, the mint-time lookup,
`app.tenant_id`, every RLS policy) is derived from a claim in a token that can then be
forged for any user in any tenant.

The live exposure is local `pnpm dev`. `Dockerfile:83` sets `NODE_ENV=production`
unconditionally, so the compose stack would refuse to boot: GC-B's hazard acting, for once,
as a mitigation.

**And the shape is GC-B's own hazard arriving from inside a dependency.** GC-B says no
behavioural choice may key on `NODE_ENV`. This one does, it is in `node_modules`, and the
rule this project wrote for itself cannot reach it.

## Decision

**`BETTER_AUTH_SECRET` is a declared binding, asserted at boot without consulting
`NODE_ENV`, and passed explicitly into `betterAuth({ secret })` rather than left to the
library's environment lookup.**

**No file in this repository supplies a value for it** (F-144, 2026-08-14).
`docker-compose.yml` makes the reference required, so a missing value fails at Compose parse
time, and `scripts/check-compose-stack.sh` generates and exports one for the duration of its
own run.

### The binding

| Variable | Values | Unset binds to | Assertion |
|---|---|---|---|
| `BETTER_AUTH_SECRET` | ~~any string of at least 32 characters that is not the library default~~ ~~**any string of at least 32 characters that is neither published constant** (F-074, 2026-08-14)~~ **any string of at least 32 characters that is not `better-auth-secret-12345678901234567890`** (F-144, 2026-08-14, reversing F-074) | **nothing: boot fails** | unconditional, every environment |

**The rule is back to its wave-1 text after two rulings in one day.** F-074 added this
repository's compose default to it. F-144 deletes that default from `docker-compose.yml`, so the
second rejection has nothing left to point at. Both edits stay visible above rather than being
rewritten to the answer, because this is the fourth ruling on one variable and the sequence is
the part worth reading.

There is no enumerated value set, so GC-B's obligation is its other half: state what an unset
value binds and make it fail everywhere. It binds to nothing. The assertion runs in
development, in test and under compose, identically, because the environment where this is
most likely to be unset is the one the library's own check skips.

**Two rejections** encoded in the assertion (~~third added 2026-08-14 by Juano's ruling on
F-074~~ **third struck 2026-08-14 by Juano's ruling on F-144**):

- **the library default `better-auth-secret-12345678901234567890` is rejected by value.**
  Not by length, not by entropy: by exact comparison. It is 39 characters and passes both
  heuristics.
- **shorter than 32 characters is rejected**, promoting the library's warning to a failure.
- ~~**this repository's own compose default
  `development-compose-better-auth-secret-not-a-real-value` is rejected by value**, by the
  same exact comparison and in the same predicate.~~ **Struck (F-144, 2026-08-14): TASK-019
  deletes that literal from `docker-compose.yml` in wave 1, before TASK-003 writes the
  predicate in wave 2, so the rejection has no referent left in the tree. Conditional, and the
  implementer applies the condition: if the literal is still in `docker-compose.yml` when
  TASK-003 starts, this bullet stands and the predicate rejects both constants.**

### ~~Why the compose default is a rejected constant~~: STRUCK 2026-08-14 (F-144)

**Juano's ruling on F-144 strikes this section. Its text is kept verbatim below, indented,
because it is what F-074 put here earlier the same day and this ADR has now been reversed
twice on one variable.**

What the struck section got right: publication is the disqualifying event, and that is why the
literal leaves `docker-compose.yml` instead of getting swapped for a better literal. What it
got wrong is the remedy. Rejecting a committed default by value leaves the default committed
and stops the stack that reads it from starting. F-081 priced that cost hours later, F-081's
own remedy turned out to be unbuildable (F-144), and this is the third answer on the same
question.

> ### Why the compose default is a rejected constant
>
> **Added 2026-08-14 (F-074), Juano's ruling.** TASK-018 had to declare `BETTER_AUTH_SECRET` on
> the compose `api` service in wave 0 (see the follow-up split below). The card stated four
> constraints and this ADR pinned no value, so the implementer wrote one, and it now sits at
> `docker-compose.yml:287` as `${BETTER_AUTH_SECRET:-development-compose-better-auth-secret-not-a-real-value}`.
> It satisfies every rule above: set, non-empty, 55 characters, not equal to better-auth's
> constant. The assertion as originally specified accepts it.
>
> **What disqualifies it is not its length and not its shape. It is committed.** This repository
> is public, so the value is in a history nobody can rewrite, and from wave 2 it is the
> symmetric key for `jwks.privateKey` on any stack started without an override. That is the same
> property as F-020's blocker, not a comparable one. better-auth's constant is not weak because
> a library chose it; it is weak because everybody has it. A locally generated 55-character
> string of exactly this shape is a fine secret. This particular 55-character string is not, and
> picking a different literal to commit next time would not help, because publication is the
> disqualifying event.
>
> So the assertion rejects two named constants and will reject any further committed default the
> same way. Length and entropy are not the test being applied here, and a value that fails this
> rule can be perfectly strong everywhere it is not published.

### Compose carries no default. The gate supplies one

**Added 2026-08-14 (F-144), Juano's ruling. This is what replaces the struck section.**

Two claims stood on top of each other and one had to go. AC-115 says the stack comes up on a
machine with only Docker and a clone. From wave 2 this ADR says the stack cannot come up on a
value this repository publishes. The generation step ruled at F-081 does not settle that: it
moves the failure from the `api` container to the gate's own precondition, because
`check-compose-stack.sh:191-196` refuses to run when a root `.env` exists, for the same reason
the contaminant guard beside it refuses exported credentials (F-315, F-316). A generation step
inside that script makes the script refuse itself.

So the compose file stops carrying a value, and the harness supplies its own.

**`docker-compose.yml`, the `api` service.** The default goes; the reference becomes required:

```yaml
BETTER_AUTH_SECRET: '${BETTER_AUTH_SECRET:?generate at least 32 characters and export it, or put it in .env at the repository root. No value is committed here because this one signs JWTs. See .env.example and ADR-0051.}'
```

Three constraints on that line, all mechanical:

- **Single-quote the YAML scalar.** A plain scalar carrying `: ` or ` #` is a YAML parse error
  before Compose ever sees it, and the message is long enough that the next person to edit it
  reaches for a colon. Quoting takes YAML out of the argument.
- **No `$`, no backtick, no `{` or `}` inside the message.** Compose runs its interpolation
  lexer over the whole string, so a `$` in the message is read as another variable reference
  and a `}` closes the expression early. That rules out putting a generation command in the
  message, since every form of one needs a `$`.
- **The message does not repeat the variable name.** Compose already prints
  `required variable BETTER_AUTH_SECRET is missing a value:` and then this text. The message
  carries the remedy.

The failure is at parse time, so `docker compose up` on a clone with nothing set exits before
it creates a container, a network, a volume or an image layer.

**`scripts/check-compose-stack.sh` generates and exports one value for its own run.** It writes
no file. Seven properties, and TASK-019 owns all of them:

1. **Generated once per run**, in the preconditions block, after the existing refusals and
   before the first `docker compose` command that reads the compose file. `cleanup` runs
   `docker compose down -v` from an EXIT trap, so the export has to precede the trap at `:298`,
   not just the `docker compose config` at `:348`.
2. **Exported, never written to disk.** The `.env` refusal at `:191-196` stays exactly as it is
   and its stated reason stays true: a root `.env` is not on a fresh clone and it masks what an
   exported credential masks.
3. **One value for the whole run.** DOD-1's second `up` and DOD-3's `restart` share the volume,
   and better-auth encrypts `jwks.privateKey` with the secret. A second value mid-run produces
   `Failed to decrypt private key`, which is why this ADR rejected generating at boot.
4. **Safe across runs only because `:418` runs `down -v --rmi local` first.** That line destroys
   the volume, so a fresh secret never meets a `jwks` row from the previous run. If that line
   ever goes, the per-run value goes with it.
5. **It overrides an inherited value.** The harness supplies this credential the way it supplies
   `APP_PASSWORD='app'` at `:303-311`: as a literal it controls. Otherwise a developer's short
   or junk export turns `AC-115.3` red for their shell rather than for the repository.
6. **`BETTER_AUTH_SECRET` does not join the contaminant refusal at `:180-189`** (TASK-017, wave
   9). Those three names refuse because an exported value repairs a missing `$$` escape and
   hides F-315/F-316. Compose carries no default for this one, so an exported value hides
   nothing, and the harness overwrites it. Adding it there makes the harness refuse itself,
   which is F-144's own shape a second time.
7. **The value is never printed**: not in a clause reason, not in a note, not on failure
   (F-379). `docker compose config --format json` at `:348` now writes a live secret into
   `$TMPDIR_CHECK/config.json`; that file is read for `.name` and nothing else, and `cleanup`
   removes the directory.

**The generated value:** 32 bytes from `node:crypto`, base64url. 43 characters over
`[A-Za-z0-9_-]`, which clears the 32-character floor, matches neither rejected constant, and
carries nothing the shell, YAML or a DSN would have to escape.

### better-auth's own constant is still rejected by value

The rejection that came out of F-020 is untouched. Four reasons, and the first is the one that
decides it:

1. **`:?` is a presence check, not a value check.** A developer who sets
   `BETTER_AUTH_SECRET=better-auth-secret-12345678901234567890`, copied from the library's docs
   or from a post about better-auth, satisfies Compose completely. Only the by-value comparison
   catches that, and pasting a constant from documentation is the likeliest way it arrives.
2. **Compose is one surface out of four.** `pnpm dev` reads the shell,
   `apps/api/test/support/auth-fixture.ts:85` sets its own value, and any script, worker or
   test that calls `betterAuth()` without going through `betterAuthSecret()` falls down the
   `||` chain in `create-context.mjs:66-70` to the constant. A parse-time guard in
   `docker-compose.yml` covers the compose `api` service and nothing else.
3. **The library's own validation is still off where it matters.** `isTest()` returns early and
   the default-secret throw fires only under `isProduction`. Where compose gets its value does
   not change that.
4. **The constant is reachable with nothing set anywhere.** It is the last operand of that
   chain, so removing our rejection restores the state F-020 blocked, on the path where nobody
   configured anything.

The second constant goes for a reason that applies to it and not to this one: its only referent
was a literal in `docker-compose.yml`, and TASK-019 deletes that literal a wave before TASK-003
writes the predicate. **What that costs is recorded below**, because deleting the literal from
the file does not unpublish it.

### What a developer sees, and what AC-115 now says

On a clone with nothing set:

```
git clone … && cd shortkit && docker compose up
→ required variable BETTER_AUTH_SECRET is missing a value: generate at least 32 characters
  and export it, or put it in .env at the repository root. …
```

Exit non-zero, nothing created, nothing to clean up. You export a value or write `.env`, run
`up` again, and the stack comes up.

It beats the container exiting on the assertion, which arrives after a cold build of several
minutes, names the variable only inside container logs, and leaves a half-created stack behind.
It beats a committed default, which signs real tokens on any stack started without an override.
**What it loses is AC-115's own text**, and that loss is not a detail:

> AC-115: Given a machine with only Docker and a clone of this repository, when
> `docker compose up` is run at the repository root, then Postgres, the API and the web app all
> reach a healthy state …

From wave 1 that sentence is false as written, and this ADR cannot fix it. **AC-115 belongs to
STORY-002** (`.sdlc/foundation/stories/STORY-002.md:19`, minted by Amendment A-8, recorded met
at `:153`), approved and shipped in a previous initiative. **Changing it is Juano's, and this
ADR is wrong if he declines.** The narrowing that matches what the repository will do, offered
rather than applied:

> Given a machine with only Docker, a clone of this repository, and one generated
> `BETTER_AUTH_SECRET` supplied through the environment or a project-root `.env`, when
> `docker compose up` is run at the repository root, then Postgres, the API and the web app all
> reach a healthy state … (rest unchanged)

Three files quote the old premise and change with it, all TASK-019's:
`scripts/check-compose-stack.sh:4-9`, `.env.example:6-7` ("works with no `.env` at all: that
is AC-115"), and `README.md:90` ("With Docker and this clone, and nothing else installed").
Each says what the harness now supplies and why it supplies it rather than committing it.

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

~~**Docblock amended 2026-08-14 (F-074).** The block above is kept as written in wave 1. The
implemented docblock names a fourth rejection: `betterAuthSecret()` also throws on
`development-compose-better-auth-secret-not-a-real-value`, this repository's committed compose
default, for the reason in the section above. Both published constants are rejected by exact
comparison, in one shared predicate.~~

**Struck 2026-08-14 (F-144).** The docblock above is what TASK-003 implements, unamended.
`development-compose-better-auth-secret-not-a-real-value` leaves `docker-compose.yml` in wave 1,
so no fourth rejection is written.

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
**the same three rejections (unset-or-empty, shorter than 32, equal to the published default)**
~~the same four rejections: unset-or-empty, shorter than 32, equal to
`better-auth-secret-12345678901234567890`, equal to
`development-compose-better-auth-secret-not-a-real-value`~~ (~~F-074, 2026-08-14~~ **struck
F-144, 2026-08-14; the three-rejection form is what wave 2 implements**).
The accessor throws at the point of use so no falsy value can reach the `||` chain; the boot
assertion throws before the process serves, so a misconfiguration is a refusal to boot rather
than a failure on the first sign-in. Both live in wave 2, and the duplication is deliberate:
an accessor that trusts a boot assertion is an accessor that is unsafe in a unit test, a
script or a worker that never ran one.

`auth.config.spec.ts` asserts the composed config carries a secret that is not the default:
the same shape ADR-0013 already requires for `rateLimit.enabled === false`, and for the same
reason. It is a fact that degrades silently.

### The value must not be logged

The secret is not in `LOGGABLE_FIELDS` and no field name is added for it. The boot assertion
reports **that** it failed and which rule it broke, never the value or a prefix of it,
unlike the user id in ADR-0045, where a prefix is useful and the value is not a credential.

## Alternatives considered

| Option | Pros | Cons | Why not |
|---|---|---|---|
| Set the variable in `.env.example` and compose and rely on the library's own validation | Nothing to write; the library already throws | It throws under `isProduction` only, and returns early under `isTest()`. The two environments that exist (ADR-0030) are development and test: the two it does not cover. Relying on it is relying on a check that is off wherever it would fire | The check exists and does not run where it is needed |
| Assert only under compose, where the secret matters | Smaller surface; local development stays frictionless | This is a behavioural choice keyed on the environment, which is what GC-B forbids, and it would be keyed on `NODE_ENV` because that is the only signal compose provides. It also leaves `pnpm dev` (the live exposure) uncovered | GC-B, exactly |
| Generate a random secret at boot when unset | No configuration; nothing to forget | Every restart invalidates every `jwks` row, because the private keys were encrypted with the previous secret and `symmetricDecrypt` throws `Failed to decrypt private key`. Multi-instance deployment mints tokens no other instance can verify | Silently breaks the thing it is protecting |
| Use `BETTER_AUTH_SECRETS` (the array form) with rotation | The library supports it and it is where rotation lives | Rotation is a capability nothing in this initiative needs and `validateSecretsArray` is a second validation path to reason about. It is the right shape for a system with a deploy target | Speculative; ADR-0030 says there is no deploy target |
| **F-074, 2026-08-14:** carry no compose default at all: `BETTER_AUTH_SECRET: ${BETTER_AUTH_SECRET:?set this to a locally generated value}` | Nothing is published, so there is no constant to reject and no list to keep current. Compose fails fast, before any container starts, with a message naming the variable | `docker compose up` on a fresh clone stops working with no `.env`, which is what AC-115 measures and what the compose gate is built around (`.github/workflows/ci.yml` runs `pnpm test:compose` with no `env:` block, deliberately). It also makes the compose stack the one surface with a different setup contract from every other credential in the file, all of which carry fixture defaults | ~~**Juano's ruling, 2026-08-14.** The out-of-the-box `up` is the property being protected. Rejecting the literal by value keeps the file's shape and moves the failure to the assertion, where the message can say why~~ **ADOPTED 2026-08-14 by Juano's ruling on F-144.** The con in the cell to the left is real and unavoidable: the wave-2 assertion stops the out-of-the-box `up` working whichever branch is taken, one wave later and after a cold build. Once both branches lose the property, the parse-time failure is the cheaper one, and the harness supplies its own value so the gate keeps measuring |

Four more, weighed under F-144 once the generation step turned out to be unbuildable:

| Option | Pros | Cons | Why not |
|---|---|---|---|
| **F-081's ruling:** a generation step writes `BETTER_AUTH_SECRET` into the project-root `.env` before compose starts, and `check-compose-stack.sh` runs the same step | Keeps `docker compose up` working for anyone who runs the step; nothing published; the developer path and the gate path are one path | `check-compose-stack.sh:191-196` refuses to run at all when a root `.env` exists, so the step makes the harness refuse itself. The generator also edits a file holding four rotated role passwords (F-083), and a `.env` it leaves behind blocks every later `pnpm test:compose` | **Verified dead at `:191-196` by TASK-019's scout (F-144).** The refusal is there because `.env` masks what an exported credential masks and is not on a fresh clone, the same principle as the contaminant guard beside it. Repairing the refusal to admit one variable spends the guard to save the step |
| Keep the committed default and narrow AC-115 instead | No harness change, no compose change, one sentence edited in STORY-002 | The literal keeps signing tokens on any stack started without an override, which is F-020's blocker under a different string | Publication is the disqualifying event. The struck section above is still right about that |
| Refuse to run when `BETTER_AUTH_SECRET` is exported, matching `:180-189` | Consistent with the three contaminants; the harness measures only what it supplies | There is no default left for an export to mask, so the guard's reason does not transfer. From wave 2 a developer needs the variable exported for `pnpm dev`, so the gate would refuse in the shell people actually work in | The guard exists for `$$`-escape defects (F-315, F-316). Overriding the inherited value gets the same determinism with none of the friction |
| Keep rejecting `development-compose-better-auth-secret-not-a-real-value` after the literal leaves the file | Git history keeps the string permanently, and one string comparison costs nothing | A rejection with no referent in the tree, kept current by nobody, which is the list-staleness cost this ADR already accepted once | **Juano's ruling on F-144.** Conditional on TASK-019 landing first: if the literal is still in `docker-compose.yml` when TASK-003 starts, the rejection stands |

## Consequences

### Positive

- The one credential that makes every other control in this initiative meaningful is
  required, checked by value, and checked in the environment the library skips.
- The check does not consult `NODE_ENV`, so it behaves identically under `pnpm dev`,
  `pnpm test:integration` and `docker compose up`.
- Passing `secret` explicitly means a future library change to the env-lookup precedence
  cannot change which value is used.
- **`docker-compose.yml` no longer carries a signing key.** Added 2026-08-14 (F-144). The
  rejection list is back to one entry, and it names a value better-auth publishes rather than
  one this repository chose. The one committed secret left is
  `apps/api/test/support/auth-fixture.ts:85`, which signs tokens for a spawned test process
  against a throwaway database and reaches no stack a developer runs.
- **The failure moved ahead of the build.** Added 2026-08-14 (F-144). Compose stops at parse,
  prints the variable name and the remedy, and creates no container, network, volume or image.
  The wave-2 assertion is still there behind it for the case where a value is set and wrong.
- **CI needs no change.** Added 2026-08-14 (F-144). The `compose` job keeps running with no
  `env:` block (F-315, F-316), because the harness generates its own value inside the run.

### Negative / accepted cost

- **Another required environment variable**, in the same wave as ADR-0050's
  `DATABASE_AUTH_URL`. Two new boot failures land on a developer who pulls and runs, and both
  will read as regressions before they read as protections.
- **The rejection is by exact value, so it goes stale.** If `better-auth` changes its default
  constant in a later release, the assertion silently stops matching it and the check reverts
  to a length test. The pin (ADR-0018) is what bounds this, and the upgrade procedure has to
  re-read `create-context.mjs`. That is a manual step with no gate behind it.
- ~~**A rejected-by-value list is now a list, and lists go stale quietly.** Added 2026-08-14
  (F-074). One constant was a special case; two are a policy, and the policy is "every value
  this repository commits as a `BETTER_AUTH_SECRET` default has to be added here". Nothing
  enumerates the list. A developer who changes the compose default to a different literal, or
  adds a second compose file with its own default, gets a green check over a published signing
  key and no signal at all. The repair that would close it is a test that reads the default out
  of `docker-compose.yml` and asserts the predicate rejects it, so the list cannot diverge from
  the file it is about. That test is not scheduled here.~~
- ~~**The compose default is now a value the boot assertion refuses, and both land in this
  initiative.** Added 2026-08-14 (F-074). From wave 2, `docker compose up` on a clone with no
  `BETTER_AUTH_SECRET` in the shell or in the project-root `.env` starts an `api` container
  that exits on the assertion, and `scripts/check-compose-stack.sh:476` fails `AC-115.3` for
  the `api` service. The compose job runs with no `env:` block on purpose (F-315, F-316), so CI
  is not exempt and neither is a fresh clone. **This is the cost of the declined alternative
  arriving anyway, one wave later and with a worse first symptom**: compose interpolation would
  have failed before any container started, with a message naming the variable, where the
  assertion fails after `up` reports the stack created. What buys the property back is a
  per-clone value that is not committed. The only file that reaches this variable is the
  project-root `.env`: Compose interpolates `${BETTER_AUTH_SECRET:-…}` from there and reads no
  file under `apps/`. **Nothing schedules that today, and it is the open obligation this
  ruling creates rather than a detail of it.** See the follow-ups below.~~

  **Both struck 2026-08-14 (F-144).** The list is one entry again and the compose default is
  gone. What the second bullet called an open obligation is what F-144 rules on. The costs
  below replace them.

- **`git clone && docker compose up` fails, and that is the command AC-115 measures.** Added
  2026-08-14 (F-144). The message names the variable and the remedy, and nothing gets built
  before it prints, but a developer's first run of the documented command still ends in a
  non-zero exit. Fixing the sentence that describes it is Juano's, not this ADR's.
- **`:?` breaks every compose subcommand, not just `up`.** Added 2026-08-14 (F-144). `down`,
  `ps`, `logs` and `config` all interpolate the file. A developer who meets the parse error and
  reaches for `docker compose down -v` to tidy up meets it a second time. One export clears
  both. The second failure still reads as the tool being broken rather than as the same
  missing variable.
- **`BETTER_AUTH_SECRET` is the only variable in `docker-compose.yml` with no default.** Added
  2026-08-14 (F-144). Four role passwords carry fixture defaults, and the odd one out invites a
  tidy-up that restores a literal. The banner at `docker-compose.yml:274-296` is the only thing
  standing in the way, and it changes from "do not reuse this value" to "no value is here, and
  why". The comment at `:239-240` also points at "BETTER_AUTH_SECRET's default below" and stops
  being true.
- **The literal stays in git history and nothing rejects it any more.** Added 2026-08-14
  (F-144). `development-compose-better-auth-secret-not-a-real-value` was committed on
  `feat/identity-membership` and deleting it from `docker-compose.yml` does not unpublish it.
  Copied out of history into a `.env`, it passes every rejection: 55 characters, not
  better-auth's constant. Accepted because no file points at it after wave 1 and it signed
  nothing outside a loopback stack. The check is a floor against known-published values, which
  this one now is, and the floor no longer covers it.
- **The harness measures a path no developer walks, off by one step.** Added 2026-08-14
  (F-144). The gate generates and exports; a developer follows the README. No clause runs the
  README's own command, so a broken instruction there stays green in CI. The repair is a clause
  that runs the documented step in a scratch shell and then `up`. Not scheduled.
- **The harness now holds a live secret it did not hold before.** Added 2026-08-14 (F-144). It
  sits in the process environment and, through `docker compose config --format json` at `:348`,
  in `$TMPDIR_CHECK/config.json`. Every value in that resolved config used to be committed
  already. `cleanup` removes the directory on EXIT; a `SIGKILL` leaves it behind.
- **The per-run value is safe only while `:418` runs `down -v` first.** Added 2026-08-14
  (F-144). That line destroys the volume, so a new secret never meets a `jwks` row encrypted
  with the previous one. Nothing states the coupling except this bullet and whatever comment
  TASK-019 leaves at the generation step.
- **The requirement bites in wave 1, one wave before the assertion that motivates it.** Added
  2026-08-14 (F-144). From the moment `:?` lands, every compose user needs the variable, and
  `assertBetterAuthSecretConfigured()` does not exist yet to explain why. Deliberate: the
  alternative is a wave in which `docker-compose.yml` still carries a published signing key.
- **~~The two published constants are~~ One published constant is rejected (F-144,
  2026-08-14); a third-party fixture value is not.** The rule covers what this library
  publishes. Any other committed secret, in a downstream fork or a copied compose file, passes.
  The check is a floor against ~~two~~ one known value, not a test for publication, because a
  test for publication is not something a boot assertion can perform.
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
- ~~**TASK-003 implements the second rejected constant** (F-074, 2026-08-14, Juano's ruling).
  `betterAuthSecret()` and `assertBetterAuthSecretConfigured()` reject
  `development-compose-better-auth-secret-not-a-real-value` by exact comparison, in the shared
  predicate, alongside `better-auth-secret-12345678901234567890`. The card's own text
  (`TASK-003:131`) still describes three rejections and needs the fourth; that is a card edit,
  not an ADR one. Unit coverage: one case per rejected constant, asserting the throw rather
  than a return.~~

  **Struck 2026-08-14 (F-144).** TASK-003 implements three rejections, which is what
  `TASK-003:131` already says, so that card needs no edit. **One condition, and TASK-003's
  implementer checks it rather than assuming it:** if
  `development-compose-better-auth-secret-not-a-real-value` is still in `docker-compose.yml`
  when the card starts, TASK-019 did not land, and the fourth rejection goes in after all.
- ~~**Whoever supplies the compose stack a non-committed value owns this, and no card does yet**
  (F-074, 2026-08-14). From wave 2 the compose default is a value the assertion refuses, so
  `AC-115.3` needs a `BETTER_AUTH_SECRET` that is not in the repository, reaching Compose
  through the project-root `.env` or the invoking shell. Sequencing is the same trap F-034
  already sprang once on this variable: the assertion is wave 2, so the answer cannot be wave 4.
  This ADR does not choose between the available shapes (a generation step in the documented
  `up` procedure, a first-run script that writes the root `.env`, or accepting that the stack
  needs one exported variable and saying so where the failure sends the reader). It records
  that the choice is now required and that wave 2 is its deadline.~~

  **Closed 2026-08-14 (F-144): TASK-019, wave 1, owns it.** The card's write surface changes
  with the ruling. It now edits `docker-compose.yml:297` (the `:?` reference) and its banner at
  `:274-296` and `:239-240`, `scripts/check-compose-stack.sh` (generate and export in the
  preconditions, plus the header premise at `:4-9`), `.env.example` and `README.md`. It writes
  no file at the repository root, so `scripts/generate-dev-secret.mjs` is no longer required by
  this ADR. **The README's documented step exports the variable rather than writing `.env`**: a
  root `.env` makes `pnpm test:compose` refuse until it is moved aside (`:191-196`). `.env` is
  the persistent alternative and the README says what it costs.
- **TASK-017, wave 9, must not add `BETTER_AUTH_SECRET` to the contaminant refusal at
  `:180-189`** (F-144, 2026-08-14). The harness exports it on purpose. A guard that refuses it
  makes the harness refuse itself, which is the failure F-144 was raised for.
- **AC-115's text is Juano's to change** (F-144, 2026-08-14). It is STORY-002's, approved and
  recorded met in the foundation initiative. The narrowing this ADR needs is in
  "What a developer sees" above. Until he rules, the repository does something AC-115 says it
  does not.
- **Unscheduled: a clause that runs the README's own start sequence.** (F-144, 2026-08-14.) The
  gate supplies the secret itself, so nothing measures the instruction a developer follows.
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
  still true: this ADR is now what names it, and the fixture is where the value lives.

  What the fixture does **not** carry is `DATABASE_AUTH_URL` (ADR-0050). The API child
  process it spawns will refuse to boot from wave 2 without one. That is a fixture change,
  not a secret change, and it belongs with ~~the wave-1 provisioning work~~ **TASK-018, wave
  0** (F-034, 2026-08-13), which holds `auth-fixture.ts` in its `paths` and lands before the
  pool that reads the DSN exists.
- ADR-0013's plugin configuration block does not mention `secret`. This ADR is the amendment;
  ADR-0013 is frozen and is not edited.
