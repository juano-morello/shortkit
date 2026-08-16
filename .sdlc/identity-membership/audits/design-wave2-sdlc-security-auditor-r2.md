# Design-mode security audit — identity-membership wave 2 (TASK-003), round 2 (scoped re-review)

verdict: changes-requested — all eight round-1 findings ADDRESSED, four new findings, two of
them introduced by the revision itself.

Scope: the eight round-1 findings, the three revisions the coordinator flagged, and breakage
introduced by the revision. Everything cleared in round 1's `## Notes` was not re-opened and no
revision disturbs it. Claims marked **re-executed** were run again against the pinned
`better-auth@1.6.26` and the live `shortkit_test` database; database work was read-only inside
`BEGIN … ROLLBACK` under `SET ROLE`, and the round-1 forged-session row is confirmed absent
(`count = 0`). Compose stack found up, left up. Scratch scripts deleted.

## Round-1 findings

| # | Round-1 finding | Verdict | Evidence |
|---|---|---|---|
| 1 | `iss`/`aud` from the Host header | **ADDRESSED** | ADR-0059. Re-executed with `baseURL`, `jwt.issuer` and `jwt.audience` all set: the same session cookie sent with `Host: evil.test` minted `iss=aud=https://api.example.com`. `exp - iat = 300`. |
| 2 | Session cookie `Secure` from `NODE_ENV` | **ADDRESSED** | ADR-0059. Re-executed: `__Secure-better-auth.session_token`, `secure: true`, `httpOnly: true`, `sameSite: lax`, `maxAge: 604800`. `advanced.useSecureCookies` derived from the declared scheme, `NODE_ENV` read nowhere. |
| 3 | `logger.level: 'error'` discards the report | **ADDRESSED in the decision, residual in two artifacts** | ADR-0060. Re-executed: at `'warn'` the bound hook received `[better-auth] Base URL is not set…`; at `'error'`, zero lines. See "Does `'warn'` land everywhere" below. |
| 4 | Caller list bounds an identifier, not the role; capability understated | **ADDRESSED** | ADR-0056 adds two equalities and restates the capability; ADR-0057 qualifies the two-factor claim to a database-only adversary and names the in-process case. The new control has its own defects — findings R2-1 and R2-3. |
| 5 | Eviction attacker-influenced; insertion-order eviction | **ADDRESSED** | ADR-0053 now names the write path as attacker-reachable, couples the cost to TASK-004's limiter with its numbers, requires `delete` before `set`, and adds the spec assertion. Propagated to `contracts/revocation-store.md:130,134,145` and the stub `:48-52,103-104`. |
| 6 | Residue is 7 days, and the 500 carries the credential | **ADDRESSED** | ADR-0054's residue table now carries the `Set-Cookie` row and `7 days`; `session.expiresIn` is a stated key in the config table. |
| 7 | Sign-up enumeration oracle unrecorded | **ADDRESSED** | ADR-0061 accepts it with reasoning, records both `emailAndPassword` keys as deliberately unset, and escalates `autoSignIn: false` as the one change that closes it. |
| 8 | `trustedOrigins`/`WEB_APP_ORIGINS` unowned; wildcard | **ADDRESSED, over-delivered, with a gap** | Juano ruled it TASK-003's; ADR-0059 adds a boot assertion as well as the unit test. The assertion rejects what it claims — and admits one entry the frozen contract names unacceptable. Finding R2-2. |

## The three things the coordinator asked me to check

**1. Does `assertWebAppOriginsConfigured` reject what it claims?** Partly. Executed against
`matchesOriginPattern`: `*` trusts `https://evil.test` and `https://*` trusts
`https://evil.test` — both refused by the assertion, and both confirmed catastrophic, so the
assertion is load-bearing and correctly aimed. Executed end-to-end: with
`WEB_APP_ORIGINS=['*']`, a cross-origin `POST /api/auth/sign-up/email` carrying
`Origin: https://evil.vercel.app` and a cookie returned **200** where the unset case returns
`403 INVALID_ORIGIN`. The gap is in finding R2-2.

**2. Does the new `pg.Pool` control catch the bypass I found?** The `DATABASE_AUTH_URL`
equality does. The `new pg.Pool` / `from 'pg'` equality is weaker than the ADR implies —
finding R2-3 — and the `DATABASE_AUTH_URL` equality is scheduled to break in wave 3 —
finding R2-1. All three equalities are green against today's tree: `betterAuthDatabase`,
`DATABASE_AUTH_URL` and `pg` each occur only in `apps/api/src/db/client.ts` (verified). One
piece of good news worth recording: the "connection string assembled from parts" evasion is
**not** available in-process — `docker-compose.yml:273` interpolates `SHORTKIT_AUTH_PASSWORD`
at parse time into `DATABASE_AUTH_URL`, and the parts themselves are not in the `api` service's
environment, so the DSN literal is the only spelling that reaches the role.

**3. Does the level land at `'warn'` everywhere an implementer reads?** No — in two places,
both escalated by name and neither yet applied. `contracts/auth-config-surface.md:102,242,247`
says `'warn'` and is the normative form. **`ADR-0052:69,100,135` still states `level: 'error'`
in its own Decision block with no `amended_by` pointer, and `:171` still says the spec asserts
`level === 'error'`** — that last one is read by the test architect, so the test can be written
to the value the amendment reverses. **`TASK-003.md:190` still says `level: 'error'`** and is
the artifact the implementer works from. Amending rather than editing in place was the right
call; the residual is that the amendment has not been applied to either, and both are Juano's.
Covered by finding R2-4.

## New findings

```yaml
findings:
  - id: R2-1
    task: TASK-003
    source: sdlc-security-auditor
    round: 2
    severity: major
    kind: design
    file: .sdlc/identity-membership/design/adr-0056-better-auth-database-caller-list-is-asserted-in-wave-2.md
    line: 123
    summary: >-
      The new `DATABASE_AUTH_URL` equality permits only `db/client.ts` and collides with content
      TASK-004 is already designed to write into `main.ts`.
    failure_scenario: >-
      ADR-0050:271-272 and its file table at `:379` require `main.ts` to gain
      `AUTH_VERDICT_PREFIX = 'DATABASE_AUTH_URL connect'`, and TASK-004's card repeats it at
      `:150-152` — the prefix is deliberately that literal so it cannot collide with
      `RLS_VERDICT_PREFIX = 'DATABASE_URL connect'` (`main.ts:48`). The scan is a text scan by
      design and matches comments and string literals. So in wave 3 a second file under
      `apps/api/src` contains `DATABASE_AUTH_URL`, the equality goes red, and it goes red on a
      card that opens no pool and holds no handle. `assertAuthRoleSeparation`'s refusal message
      in `boot-assertions.ts` will almost certainly name the variable too, making a third. The
      likely response under a red gate is to widen `PERMITTED` to whatever the tree contains,
      which is how a control becomes a list of the files that happen to exist.
    required_change: >-
      Decide the wave-3 shape now rather than at the point it is red. Either name `main.ts` and
      `auth/boot-assertions.ts` in this equality's permitted set with the reason (they name the
      variable, they do not connect with it), or scan for the use rather than the mention —
      `process.env.DATABASE_AUTH_URL` — which distinguishes the verdict prefix from a
      connection. State the choice in ADR-0056 so TASK-004 inherits it.

  - id: R2-2
    task: TASK-003
    source: sdlc-security-auditor
    round: 2
    severity: major
    kind: design
    file: .sdlc/identity-membership/design/adr-0059-the-auth-config-declares-its-origin-cookies-and-session.md
    line: 141
    summary: >-
      `assertWebAppOriginsConfigured` admits `https://*.vercel.app`, the one entry the frozen
      contract names unacceptable, and does not treat `?` as a wildcard.
    failure_scenario: >-
      The stated predicate refuses an entry that is `*` and an entry whose host part is a bare
      `*`, and permits "a wildcard where a non-wildcard registrable host remains"
      (`stubs/.../boot-assertions.ts:112-120`). `https://*.vercel.app` satisfies that: the
      registrable host `vercel.app` is not a wildcard. `auth-tokens.md:159-162` rules exactly
      that entry out in as many words — "not an acceptable entry: it trusts every app on the
      platform" — and names `https://shortkit-*.vercel.app` as the supported preview form.
      EXECUTED: `matchesOriginPattern('https://evil.vercel.app', 'https://*.vercel.app')` is
      `true`, and end-to-end, `WEB_APP_ORIGINS=['https://*.vercel.app']` let a cross-origin
      `POST /api/auth/sign-up/email` from `Origin: https://evil.vercel.app` through with **200**.
      Anyone who can deploy on the shared platform then reaches every state-changing auth route
      from a page the victim visits. Separately, `matchesOriginPattern` enters wildcard mode on
      `*` **or** `?` (`trusted-origins.mjs:18`), and `?` is a single-character wildcard —
      EXECUTED: `https://app.example.co?` trusts `https://app.example.com`. The assertion names
      only `*`.
    required_change: >-
      Replace "a non-wildcard registrable host remains" with the contract's actual rule: a
      wildcard is permitted only inside a host **label**, never as a whole label, so
      `https://shortkit-*.vercel.app` passes and `https://*.vercel.app` refuses. Add `?` to the
      metacharacters the predicate inspects. Cite `auth-tokens.md:158-162` as the source, and
      have the unit test assert the refusal of `https://*.vercel.app` by name rather than only
      the bare `*`.

  - id: R2-3
    task: TASK-003
    source: sdlc-security-auditor
    round: 2
    severity: minor
    kind: design
    file: .sdlc/identity-membership/design/adr-0056-better-auth-database-caller-list-is-asserted-in-wave-2.md
    line: 130
    summary: >-
      The `new pg.Pool` / `from 'pg'` equality is defeated by a package the sanctioned code
      already imports, so the honest bound is the `DATABASE_AUTH_URL` scan alone.
    failure_scenario: >-
      `drizzle-orm/node-postgres`'s own driver constructs the pool: `driver.js:61-71` is
      `new pg.Pool({ connectionString: params[0] })` when `drizzle()` is handed a string. So a
      file under `apps/api/src` writing
      `import { drizzle } from 'drizzle-orm/node-postgres'; const db = drizzle(dsn);` holds
      `shortkit_auth` with no `betterAuthDatabase`, no `new pg.Pool` and no `from 'pg'` anywhere
      in it — one line, no obfuscation, using an import that four sanctioned files already
      carry. `await import('pg')` also matches neither spelling. The ADR's "what the three still
      do not catch" list names an env key built at runtime, a DSN from a file, and a transitive
      dependency; it does not name this, and it presents the pg scan as closing the pool
      construction path. Only the `DATABASE_AUTH_URL` equality actually stands between a
      convenience commit and the auth role.
    required_change: >-
      Add `drizzle(<string>)` and `await import('pg')` to the stated residual, and say plainly
      that the `DATABASE_AUTH_URL` equality is the load-bearing one of the three and the pg scan
      is a second-order tripwire. If the pg scan is kept, match the module specifier rather than
      the quoted spelling so `from "pg"` and `import('pg')` are covered too.

  - id: R2-4
    task: TASK-003
    source: sdlc-security-auditor
    round: 2
    severity: minor
    kind: design
    file: .sdlc/identity-membership/tasks/TASK-003.md
    line: 190
    summary: >-
      The card the implementer works from is now behind the contract on the logger level and on
      six config keys, and ADR-0052's own Decision block still reads `'error'`.
    failure_scenario: >-
      `TASK-003.md:190` says `level: 'error'`; ADR-0052 says it four times, including at `:171`
      where it instructs the spec to assert `level === 'error'`, which is the line the test
      architect reads. An implementer working the card writes `'error'` and a spec asserting
      `'error'` passes, and the channel that reports an unresolved `baseURL` closes again with
      every gate green — the exact state ADR-0060 exists to end. The card also does not mention
      `baseURL`, `trustedOrigins`, `advanced.useSecureCookies`, `session.expiresIn`,
      `jwt.issuer`/`jwt.audience`, the two new boot assertions, or two of the three equalities in
      the spec it owns. Both ADR-0059 and ADR-0060 escalate the card text to Juano, so this is a
      known gap rather than a silent one; it is filed because the window between the escalation
      and the edit is the window an implementer starts in.
    required_change: >-
      Apply the two escalations before the card goes to an implementer: `amended_by: ADR-0060`
      plus a struck-in-place correction in ADR-0052's Decision block and its `:171` spec line,
      and the ADR-0059/ADR-0060 keys in TASK-003's Approach. If the card cannot be edited this
      round, add one line to it pointing at `auth-config-surface.md` as the normative form for
      every composed key, so the contract wins on conflict by instruction rather than by
      convention.
```

## Notes

**Nothing in the revision disturbs what round 1 cleared.** I re-checked the two places a
revision could have: browser CSRF still fails closed with the new keys in place (the 403 path is
unchanged and `trustedOrigins: []` still resolves to the API's own origin, verified on the
composed context), and `disableSettingJwtHeader`, `definePayload`'s `jti`/`sub` behaviour and
`rateLimit.enabled === false` are unchanged and were re-observed on the same probe.

**Two things the revision did that improve on what I asked for.** ADR-0059 sets `baseURL` *and*
`jwt.issuer`/`jwt.audience` rather than either alone, and states why: each closes a different
path to the same value. That is stronger than my required change, which named only the claim
keys. And the boot assertion for `WEB_APP_ORIGINS` is the right instinct — the value that clears
a developer's 403 is written in a shell, and no unit test reads a shell. R2-2 is a defect in the
predicate, not in the decision to have one.

**The one architectural risk I would flag without filing it.** ADR-0059's own escalation 1 is
real and blocking in practice: `BETTER_AUTH_URL` becomes a boot-fatal binding in wave 2, while
`docker-compose.yml` belongs to two landed wave-0/1 cards and `.env.example` to a wave-4 card.
Nothing in wave 2 can supply the binding, so the `compose` job cannot go green the day TASK-003
lands. That is a sequencing problem rather than a security one, and it is correctly escalated;
it is worth Juano ruling on it in the same pass as R2-1, because both are wave-boundary
questions the implementer cannot answer alone.
