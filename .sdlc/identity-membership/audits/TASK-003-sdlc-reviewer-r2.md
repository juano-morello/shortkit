# TASK-003 — code review, round 2 (scoped re-review)

- **Scope:** `git diff 147d09e..b214221`, restricted to the r1 fixes and the two changes the
  coordinator named. Everything my r1 cleared stands and was not re-reviewed.
- **Not re-run:** the implementer's 21/21 boot tests and the unit tier.

## Per-finding verdict

### F-203 — the wildcard branch — **ADDRESSED**

`WILDCARD_ORIGIN_SHAPE = /^https?:\/\/[a-z0-9*?._-]+(?::\d+)?$/`, asserted before
`assertWildcardHostIsBounded`. Traced by hand against the regex, all refused:

| Entry | Why it now fails |
|---|---|
| `https://shortkit-*.vercel.app/` | `/` is in neither the host class nor `(?::\d+)?$` |
| `https://app.example.com/?next=1` | `/`, `?` after the host, `=` |
| `shortkit-*.vercel.app` | no `https?://` prefix |
| `https://app.example.com:*` | port must be `\d+`; the host class has no `:` |
| `https://good.example.com:*@evil.com` | `@`, and `:*` is not a port |
| `https://evil.com#*.vercel.app` | `#` |
| `*://example.com`, `https://:*` | no scheme / host class needs ≥1 char |

`https://shortkit-*.vercel.app` and `…:3000` still pass, and `https://*.vercel.app` still
reaches rule 1 so it is still refused **by name** with the message the frozen contract
requires. `wildcardHost`'s simplification (no `split('/')`) is safe **because** the shape
assertion runs first — the ordering is load-bearing and the docblock says so.

**The upper-case judgement: upheld, and it does not trade one silent failure for another.**
A refusal is loud by construction; the alternative is not. `getOrigin` lower-cases, so an
upper-case pattern is a value that can never match, and silently rewriting it would put a
value in force that the operator did not write — the same objection `URL_CARRIES_A_PATH`
already makes. One caveat, filed below: the refusal does not actually name the rule it broke.

### F-204 — the dead remedy — **ADDRESSED**

Re-verified the premise rather than the prose: no `dotenv` in any workspace manifest, no
`--env-file` in any script, `apps/api` declares no `dev` and neither does the root. The
replacement is executable, and I checked the one thing that would have broken it silently —
`apps/api/src` contains no `process.cwd()`, `readFileSync` or `__dirname`, so
`node --env-file=apps/api/.env apps/api/dist/main.js` works from the repository root as
written. Correcting ADR-0059:285-286 was the right second half; the claim lived in both.

### F-205 — `NOISY_NAMES` — **NOT ADDRESSED, and the deferral is right**

I am not verdicting this NOT ADDRESSED in the sense you offered. Two facts I checked:
`ci.yml:354` runs `test:compose` on a runner whose environment carries neither variable, so
the **CI** signal is unaffected and the exposure is a developer machine only; and TASK-017 is
downstream of TASK-009 in `plan.md:134`, so it lands inside this initiative and before Ship.
One condition: it must not be closed `wontfix` at TASK-003's gate, because the reason it is
cheap now is that nobody has yet read a green `test:compose` as evidence.

## New findings

```yaml
verdict: clear
findings:
  - severity: minor
    kind: behavior
    file: apps/api/src/auth/boot-assertions.ts
    line: 405
    summary: >
      The wildcard shape refusal enumerates the shape but never names case, which is the one
      sub-rule an operator can break while satisfying every clause the message states.
    failure_scenario: >
      `WEB_APP_ORIGINS=https://Shortkit-*.vercel.app`. Boot refuses. The message says to write
      "a lower-case http:// or https:// scheme, a host, and at most a numeric port — no path,
      query, fragment or trailing slash". The operator's scheme is already lower-case, they
      have a host, no port, and none of the four forbidden parts — every clause of the message
      is satisfied by the value that was just rejected, and "lower-case" attaches grammatically
      to "scheme". Nothing points at the capital `S`. The likely next moves are dropping the
      wildcard or reaching for `https://*.vercel.app`, which is also refused. This is the same
      class as the defect it fixes: `boot-assertions.ts:51` fixes the standard as "it names the
      rule that was broken", and here it names four rules that were not.
    required_change: >
      The refusal states that the host must be lower-case, and says why (better-auth compares
      the pattern against a lower-cased origin), so the message distinguishes a case error from
      a shape error. A worked example with the offending characters is not required; naming the
      rule is.

  - severity: minor
    kind: behavior
    file: apps/api/src/db/better-auth-database-callers.spec.ts
    line: 265
    summary: >
      Scan 5 pre-authorises `auth.module.ts` to import `auth.config.ts`, which
      `auth.module.ts:21-24` — same commit — has a documented rule against.
    failure_scenario: >
      A TASK-005 implementer reads scan 5, sees `auth.module.ts` on the permitted set with the
      comment "may hold TASK-005's guard", and writes `import { auth } from './auth.config'` in
      the module. Scan 5 stays green because that is exactly what it permits. `auth.config.ts`
      evaluates `betterAuth({ secret: betterAuthSecret(), baseURL: betterAuthUrl(), … })` and
      calls `betterAuthDatabase()` at module scope, so every unit test that compiles
      `AppModule` — `app.module.spec.ts` included — now requires `BETTER_AUTH_SECRET`,
      `BETTER_AUTH_URL` and `DATABASE_AUTH_URL`, and the unit tier goes red on module load. The
      control that should have refused the edge is the one that invited it. It is also not
      needed for the stated purpose: `auth-config-surface.md` has TASK-005 reaching the
      instance through the mounted `/api/auth/jwks` and taking `iss`/`aud` from
      `betterAuthUrl()`, neither of which is an import of `auth.config.ts`.
    required_change: >
      Scan 5's permitted set is `main.ts` alone unless a named artifact requires the module to
      hold the instance, and the comment reconciles with `auth.module.ts`'s rule rather than
      contradicting it. If `auth.module.ts` really is to be pre-authorised, the two docblocks
      have to agree on which one is wrong before the wave-3 implementer meets them.

  - severity: minor
    kind: behavior
    file: apps/api/src/auth/auth.config.spec.ts
    line: 76
    summary: >
      `expirationTime` is still declared in the spec's options type and never read; a unit-tier
      assertion is available now and is worth having.
    failure_scenario: >
      Someone applies the "simplification" that frozen `auth-contracts.md:136-138` still
      instructs — `expirationTime: ACCESS_TOKEN_LIFETIME_SECONDS` — in wave 2 or 3. Unit
      191/191, typecheck, lint and build all stay green, because the only assertion is
      `signup-creates-tenant.int-spec.ts:264`, which cannot run until the mount exists. Every
      token is then issued with `exp = 300`.
    required_change: >
      Assert in `auth.config.spec.ts` that the composed option is a string and equals
      `` `${ACCESS_TOKEN_LIFETIME_SECONDS}s` `` derived from the constant, labelled in the
      comment as a floor under the wave-3 `exp - iat` assertion rather than a substitute for
      it. **This is not the mistake the new `skipOriginCheck` test warns against.** That test
      can assert an output because `create-context.mjs` resolves one into `$context`;
      `expirationTime` has no resolved surface short of a minted token, and `toExpJWT` and
      `sec` are both behind better-auth's `exports` map — 56 subpaths, no wildcard, no
      `./utils` — so neither can be imported to convert it. What is left is the type, and the
      type IS the defect: `toExpJWT` branches on `typeof expirationTime === 'number'`, so
      `typeof … === 'string'` is a statement about the library's branch, not a restatement of
      a literal.

  - severity: nit
    kind: implementation
    file: apps/api/src/db/better-auth-database-callers.spec.ts
    line: 285
    summary: Two counts in scan 5's positive-control comment do not match the tree.
    failure_scenario: >
      "ELEVEN FILES under `apps/api/src` name `auth.config.ts` in prose today" — measured, it
      is **7** within the scan set and 12 across all `.ts` including specs. Eleven is 12 minus
      the module itself, i.e. a count over a set that includes `*.spec.ts`, which `SCAN_SET`
      excludes at :127 — so the number offered as the reason the pattern's precision matters is
      counting files the pattern is never run against. The neighbouring "NO FILE UNDER
      `apps/api/src` IMPORTS `auth.config.ts` at all" is false for the same reason:
      `auth.config.spec.ts` imports it dynamically in `composed()`.
    required_change: >
      Both sentences say "in the scan set" and carry the number that set actually holds.

  - severity: nit
    kind: behavior
    file: apps/api/src/auth/boot-assertions.ts
    line: 173
    summary: >
      `.` is in the host character class with no label structure, so a trailing or doubled dot
      still produces an entry that boots green and matches nothing.
    failure_scenario: >
      `https://shortkit-*.vercel.app.` or `https://shortkit-*..vercel.app` clears the shape
      regex; rule 1 skips the empty label by design (`isEntirelyWildcard('')` is `false`) and
      rule 2 sees `['app','']` or `['vercel','app']`, so both are accepted verbatim and neither
      matches any origin. Same residual class as F-203, narrowed from "any entry with a
      metacharacter" to "a dot typo", which is why it is a nit and not a repeat.
    required_change: >
      If closed, the host is a dot-joined sequence of non-empty labels rather than a character
      class containing `.`. Acceptable to leave, stated.
```

## Verified and not filed

- **`advanced.disableOriginCheck: false` is correct, and it is the only new key this round
  that arrived with a control that can fail.** Every cited line checks out verbatim:
  `create-context.mjs:210` is the ternary as quoted, `env-impl.mjs:36` is
  `isTest = () => nodeENV === "test" || toBoolean(env.TEST)` over
  `toBoolean(v) = v ? v !== "false" : false`, and `origin-check.mjs:20-27` gates on
  `ctx.context.skipOriginCheck`, so the `validateURL` claim holds too. Placement under
  `advanced` is right, and it is not in `auth-config-surface.md`'s normative table, so adding
  it is compatible under that contract's own versioning rule. `auth.config.spec.ts:353` asserts
  the **resolved** `$context.skipOriginCheck`, and the author measured the two negative
  compositions before writing it — key absent and `advanced` absent both give `true`. That is
  the shape the other eight silent facts should be held to.
- **Scan 5's pattern.** I re-ran `AUTH_CONFIG_IMPORT` over `apps/api/src` excluding
  `*.spec.ts`: exactly one match, `main.ts`, and it is the F-210 comment quoting the dynamic
  import TASK-004 must write — the ⚠ note is accurate. `./auth.configuration` is correctly
  rejected (the optional `.[jt]s` group needs a literal dot and `\1` then fails on `u`, and no
  second `auth.config` exists to backtrack to). The planted-text positive control is the right
  answer to a scan whose tree-side assertion is vacuous, and disclosing the side-effect-import
  gap in the same block is the honest version of a residual list.
- **Coherence of the five, read cold.** The header table, the "what the five do not catch"
  block and the per-scan direction comments hang together; the two subsets now each carry
  their own reason and they are different reasons, which is right. The one thing that does not
  read coherently is scan 5's permitted set against `auth.module.ts`'s own docblock, filed
  above.
