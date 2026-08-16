# Code-mode security audit — TASK-003, round 2 (scoped re-review of round 1)

verdict: **all six ADDRESSED.** No breakage introduced. One new finding, `minor`, from the
question the coordinator asked at the end — it is real and it is not one of the six.

Scope: F-206 … F-211 against `git diff 147d09e..b214221`, plus the working-tree artifact
edits. Nothing cleared in r1 was re-reviewed. Scratch database `sec_audit_r2` created with the
`docker-compose.test.yml` grants in the right order, both migrations applied, setup verified
(`shortkit_auth` reads `"user"`, is denied `tenants`; `shortkit_app` reads `tenants`), and
**dropped** — the cluster is back to `postgres`, `shortkit_test`, `template0`, `template1`.
`shortkit_test` never connected to. Compose stack up as found. `/tmp/sk-r2` deleted. Nothing
edited but this file.

| # | Finding | Verdict |
|---|---|---|
| F-206 | `disableOriginCheck` follows `NODE_ENV`/`TEST` | **ADDRESSED** |
| F-207 | the exported `auth` is a second unbounded handle | **ADDRESSED** |
| F-208 | `get-session` returns the session token in its body | **ADDRESSED** (accepted, wording accurate) |
| F-209 | the `warn` basis does not cover the `error` band | **ADDRESSED**; I withdraw the truncation half |
| F-210 | the wave-3 module-scope refusal escapes the handler | **ADDRESSED** |
| F-211 | refusals point at a file that omits the secret | **ADDRESSED** |

## F-206 — ADDRESSED. The measurement neither of us had run.

EXECUTED against the committed `auth.config.ts`, through `auth.handler`, five environment
shapes, cross-origin `POST /api/auth/sign-out` with a cookie:

```
NODE_ENV=test                  skipOriginCheck=false  evil 403 INVALID_ORIGIN   own origin 200
NODE_ENV=production TEST=0     skipOriginCheck=false  evil 403 INVALID_ORIGIN   own origin 200
NODE_ENV=production TEST=no    skipOriginCheck=false  evil 403 INVALID_ORIGIN   own origin 200
NODE_ENV=production            skipOriginCheck=false  evil 403 INVALID_ORIGIN   own origin 200
NODE_ENV=development TEST=1    skipOriginCheck=false  evil 403 INVALID_ORIGIN   own origin 200
```

`TEST=0` under `NODE_ENV=production` answered 200 before the fix and answers 403 now. The
open-redirect half I flagged as riding on the same key is closed with it: an evil
`callbackURL` answers `403 INVALID_CALLBACK_URL` in **every** row above, including
`NODE_ENV=test`, where it was 200.

**Breakage check, and the answer is none.** Under `NODE_ENV=test` on the committed config:
the API's own origin 200; a `WEB_APP_ORIGINS` entry 200; a cookie-carrying POST with **no**
`Origin` now `403 MISSING_OR_NULL_ORIGIN`, which is `auth-tokens.md:116-130`'s documented row
and is exactly why `auth-fixture.ts` decision 1 sends one; a no-cookie no-`Origin` sign-up
from curl still 200; a `Sec-Fetch-Site: cross-site` navigate login blocked. So the fix turns
the frozen contract's rows from unverifiable into exercised, and the one shape whose answer
changed already has its mitigation shipped. **Full unit suite: 30 files, 293 tests, green.**

On the assertion: it reads `$context.skipOriginCheck`, which is the resolved output of the
ternary rather than its input, and that is the right side of the line the `expirationTime`
lesson drew. I did not reproduce your mutation run — my out-of-tree mirror could not resolve
the workspace package — but the substantive claim is independently measured: under
`NODE_ENV=test`, a composed instance with `advanced: { useSecureCookies: false }` and no
`disableOriginCheck` resolves `skipOriginCheck = true`, so deleting the key makes
`toBe(false)` fail in that tier. Your check can fail.

## F-207 — ADDRESSED. Nine plants, five scans.

I re-ran my r1 method against the five scans as they now stand, with my original five plants
and four new ones written specifically at scan 5:

```
evil-a  new pg.Pool + process.env.DATABASE_AUTH_URL        caught 2,3,4
evil-b  drizzle(process.env['DATABASE_AUTH_URL'])          caught 2,3,4
evil-c  destructured env + dynamic driver import           caught 2,4
evil-d  runtime-built env key + runtime-built specifier    MISSED (documented residual)
evil-e  import { auth } from './auth/auth.config'          caught 5   <- r1's gap, closed
evil-f  export * from './auth/auth.config'                 caught 5
evil-g  await import('./auth/auth.config')                 caught 5
evil-h  await import('./auth/' + 'auth.config')            MISSED
evil-i  import './auth/auth.config';                       MISSED (documented, binds no name)
```

Scan 5 catches every spelling that actually binds the instance. The positive control over
planted text is the right closure for the vacuity the test architect found — a `toEqual([])`
on a tree where nothing imports the file proves nothing about the pattern, and a control that
cannot be defeated by rewording a comment is the only shape that survives. Both new subset
directions are stated, and neither F-191 false positive fires.

`evil-h` is the one thing I would add to the residual list, and it is a **nit, not a
finding**: the list names the runtime-built *env key* as defeating scans 2 and 3, and does not
name the runtime-built *module specifier*, which defeats 4 and 5 by the same mechanism. One
clause. Without it the specifier scans read as closed to a reader who has just been told the
env scans are not.

## F-208 — ADDRESSED, and the recorded wording matches the measurement.

"`get-session` returns the plaintext session token in its response body, so `HttpOnly`
protects it from nothing that already runs script on a trusted origin, and `bearer()` accepts
that value as a complete credential" — accurate, and accepted with no owner is the right call
for a route this initiative does not mount.

One clarification worth having in the sentence, because I measured it and a reader could take
the phrase the other way: **"trusted origin" is not `trustedOrigins`.** A `get-session` read
from `http://localhost:3000`, a configured `WEB_APP_ORIGINS` member, returns 200 with the
token in the body and **zero `Access-Control-*` headers** — so a browser on that origin cannot
read it. The precondition is script running where the browser attaches the cookie, which is
the API's own origin or whatever proxies it. Adding an origin to `WEB_APP_ORIGINS` does not
expose the token. Not a finding; the phrase is loose in the one direction that would scare the
next reader off a safe change.

## F-209 — ADDRESSED on the basis half, and **I withdraw the truncation half.**

The basis correction is right and names the sites. On the dispute: **your ruling is correct
and my required change was wrong.** A byte cap admits a cap's worth per request and leaves
line count untouched, so it prices as mitigation and buys nothing against the cost that
matters; and overriding an alternatives-table refusal whose stated trigger has not fired is
how a table stops meaning anything. I should have written the finding as the basis defect
alone and left the remedy to the ADR that already owns the question. Not a door I want
reopened.

## F-210 — ADDRESSED. `main.ts` now carries the measurement and the one-line shape wave 3 has
to use, and the two artifacts that asserted the same false thing are corrected. The dynamic
import inside `bootstrap()` is the right fix: it keeps the shared error class meaningful, and
it keeps `boot-assertions.ts`'s one-way import rule untouched.

## F-211 — ADDRESSED, and better than filed. Both secret refusals point at the root
`.env.example`, which does carry the generation command. The implementer was right that I had
the wrong file in the finding; the substance held. `apps/api/.env.example`'s copy-to-`.env`
sentence was corrected in the same pass under F-204.

## The question nobody asked: claims no test can check

**The answer is not "no".** I attacked three, by execution. Two hold. One does not.

**Holds — the `before` registry, which ships empty and which item 1b's *authorization* hook
lands in.** I pushed real hooks onto `beforeHooks` at runtime against the composed instance.
Registration order is honoured; a hook pushed *after* the first request is seen by the same
closure, so the array is read at call time and not captured; an `APIError` from hook 1 answers
`403` with its own `code` and **hook 2 does not run**; a `TypeError` from a hook answers a
body-less `500`, exactly as the contract's error table says; and a refused sign-up wrote **no
`user` row** — the refusal stops the write, not just the response. Every one of those is a
claim the shipped suite cannot reach, and every one is true.

**Holds — "one hook covers sign-out, `revoke-session`, `revoke-other-sessions` and
delete-user", which was only ever run for sign-out.** Three sessions, three minted `jti`, all
three unrevoked; `POST /api/auth/revoke-other-sessions` → 200; the two other sessions read
`true` and the caller's own reads `false`. `deleteManyWithHooks` does fire the hook per row.
Worth having measured: this is the "sign out everywhere" button, the thing a user presses
after a compromise, and if the claim had been wrong the stolen tokens would have stayed good
for 300 more seconds with nothing failing.

**Does not hold — ADR-0052's "exactly one censoring mechanism", and `logger.level` is the
switch that turns the second one on.** This is the new finding below.

```yaml
findings:
  - task: TASK-003
    source: sdlc-security-auditor
    round: 2
    severity: minor
    kind: design
    file: apps/api/src/auth/auth.config.ts
    line: 182
    summary: >-
      Every `APIError` message in the auth surface is written to `console.error` by a
      better-auth logger singleton that ignores the composed `log` hook and ignores
      `disableColors` — and `logger.level` is what selects it, so ADR-0060's `'warn'` is one of
      the three values that enable the bypass.
    failure_scenario: >-
      EXECUTED. `dist/api/index.mjs:21` imports the PACKAGE-LEVEL `logger` from
      `@better-auth/core/env` — `createLogger()` with no options, so no `log` hook, no
      `disableColors`, straight to `console.error`. `:199-209` in `onError` reads:

        const optLogLevel = options.logger?.level;
        const log = optLogLevel === "error" || optLogLevel === "warn" || optLogLevel === "debug"
          ? logger : void 0;
        …
        if (isAPIError(e)) {
          if (e.status === "INTERNAL_SERVER_ERROR") ctx.logger.error(e.status, e);
          log?.error(e.message);
        }

      `ctx.logger` is ours; `logger` is not. So `e.message` for EVERY `APIError` — not only
      failures — goes out on a channel ADR-0052's binding does not reach, and the level key
      that ADR-0060 exists to set is the enable switch: `'warn'`, `'error'` and `'debug'` all
      select it, which is why changing `'error'` to `'warn'` showed nobody anything.

      Measured with stderr **piped, not a TTY**, on the committed config with
      `disableColors: true`:

        ^[[2m2026-08-16T22:10:48.484Z^[[0m ^[[31mERROR^[[0m ^[[1m[Better Auth]:^[[0m
        invitation token inv_7f3c9a2b1e is not valid for alice@acme.example

      Not JSON, not pino, ANSI escapes despite `disableColors`, no `service`, no `env`, no
      `code`, no `LOGGABLE_FIELDS`, no `serializers.err`. The message is the one I raised from
      a `before` hook, written the way an invitation-validation hook naturally would be.

      **Nothing leaks today, which is why this is `minor` and not higher**: every `APIError`
      message in the tree is a fixed string, including this card's own
      `NO_TENANT_MEMBERSHIP` and `TENANT_PROVISIONING_FAILED`, which ADR-0054 and ADR-0055
      deliberately made fixed for the unrelated reason that the body is rendered verbatim to
      the caller. What is wrong is the guarantee and the guidance. Contract invariant 4 and
      `auth.config.ts`'s `AuthBeforeHook` docblock both REQUIRE item 1b's refusal to be an
      `APIError` and say nothing about its message reaching an unbound console channel — and
      an invitation token and an email are precisely what that hook has in scope. GC-G is
      enforced by a mechanism that is documented as total and is not.

      This is the same defect shape as F-206 one layer up: a key that reads as a threshold and
      is also a switch, in a dependency, with no test able to see it. It is testable — 
      `observability/logger.spec.ts` already spawns a child and reads its fd 1 — just untested.
    required_change: >-
      Amend ADR-0052 to say the binding covers `ctx.logger` and NOT `onError`'s
      `log?.error(e.message)`, naming `api/index.mjs:199-209` and the fact that the level key
      selects the singleton; and add one sentence to `auth.config.ts`'s `AuthBeforeHook`
      docblock and to contract invariant 4 telling hook authors that an `APIError` message is
      rendered to the caller **and** written to an uncensored console channel, so it carries no
      token, email, user id or tenant id. Both are one sentence each and both land before item
      1b, which is the point. If a stronger closure is wanted later, `options.onAPIError.onError`
      is the documented hook that replaces this branch entirely — but that is a decision, not
      a fix, and it belongs in ADR-0052 rather than in this card.
```

## Notes

**One nit, not filed as a finding.** ADR-0056's residual list names the runtime-built env key
against scans 2 and 3 and does not name the runtime-built module specifier against scans 4 and
5, which I measured as a working miss (`evil-h`). One clause in the same list.

**Two things I confirmed rather than found.** The contract's last error-table row is real: a
non-`APIError` from a hook produced `# SERVER_ERROR:` plus a full stack with absolute paths
from a `console.error` inside `better-call/router.mjs:94`, outside pino, exactly as recorded.
And `getColorDepth()` did not suppress the escapes on a pipe, so the singleton's output is
ANSI-coloured wherever it lands, including a log file.

**On the skipped step-2b doubt reviewer.** The new finding above is what that slot would have
been looking for, and my panel did not find it in r1 — I found it in r2 only because a
side-effect of attacking the empty hook registry printed a coloured line that the composed
`disableColors: true` said could not exist. That is one accident, not a method. The slot is
worth running.
