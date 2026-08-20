---
id: ADR-0052
slug: identity-membership
title: Better Auth's logger is bound to the pino instance, because a second log channel defeats the allowlist by construction
status: accepted
supersedes: null
amends: ADR-0028, ADR-0013
amended_by: ADR-0060
date: 2026-08-13
---

> **AMENDED 2026-08-15 BY ADR-0060 (F-175), Juano's ruling. The level is `'warn'`, not
> `'error'`. Every `level: 'error'` below is struck; read ADR-0060 for the reasoning and the
> audited basis.**
>
> Measured by the wave-2 design security pass: composed with the exact logger this ADR
> mandates, the bound `log` hook received **zero lines**: `'error'` filtered out
> `create-context.mjs:64`'s warning that the base URL is unset and the origin is being derived
> from each incoming request, which is the line that reports two of that audit's major
> findings. It also dropped the short-secret warning and `rate-limiter/index.mjs:284`'s
> "cannot determine a client IP", which is the control TASK-004 depends on.
>
> **The justification stated below is wrong at the source.** `sign-up.mjs:168`'s "Sign-up
> attempt for existing email" is `logger.info`, not `logger.warn`, so `'warn'` suppresses it
> just as completely. The auditor read every `warn` call site in 1.6.26 before proposing the
> change: none interpolates an email, token, password or user id, and this ADR's own hook drops
> positional `args`, so the structured second arguments never reach the line either.
>
> **AND A SECOND AMENDMENT, 2026-08-16 (F-216): THIS ADR'S CENTRAL CLAIM HAS AN EXCEPTION.**
> "Exactly one censoring mechanism" does not hold for the `onError` path. `api/index.mjs:199`
> selects better-auth's **package-level logger singleton** (`const log = optLogLevel ===
> "error" || optLogLevel === "warn" || optLogLevel === "debug" ? logger : void 0`), and writes
> every `APIError` message through it with `log?.error(e.message)`. The bound `log` hook is not
> consulted, `disableColors` does not apply, and the pino field allowlist never sees it.
>
> **The level is not the cause and `'warn'` is not the regression**: all three of `error`,
> `warn` and `debug` enable it, so it was equally true under the `'error'` this ADR originally
> decided. Nothing leaks today: every message on that path is a fixed string, which is why
> four design rounds and a first implementation audit did not surface it. It was found by
> asking which claim in the diff no test could check.
>
> Item 1b's mandated `APIError` refusal is what makes it live; `auth-config-surface.md`
> invariant 4 and the `AuthBeforeHook` docblock carry the same sentence, where the author of
> that hook will meet it.

## Context

ADR-0028 says there is exactly one censoring mechanism, deliberately. GC-G names `email` as
the field that must never join `LOGGABLE_FIELDS`. `eslint.config.mjs:97-124` bans `console`
and `@nestjs/common`'s `Logger` under `apps/api/src` so that nothing writes outside pino.

Better Auth ships its own logger and it writes through `console`. From
`@better-auth/core/dist/env/logger.mjs:55-69`, read at the pinned version:

```js
const createLogger = (options) => {
  const enabled  = options?.disabled !== true;
  const logLevel = options?.level ?? "warn";
  const LogFunc = (level, message, args = []) => {
    if (!enabled || !shouldPublishLog(logLevel, level)) return;
    const formattedMessage = formatMessage(level, message, colorsEnabled);
    if (!options || typeof options.log !== "function") {
      if (level === "error") console.error(formattedMessage, ...args);
      else if (level === "warn") console.warn(formattedMessage, ...args);
      else console.log(formattedMessage, ...args);
      return;
    }
    options.log(level === "success" ? "info" : level, message, ...args);
  };
```

The lint rules do not reach `node_modules`. Nothing in pino sees these lines: no
`LOGGABLE_FIELDS`, no `serializers.err`, no `formatters.log`, no ISO timestamp of ours, no
`service`, no `env`, and ANSI colour when a TTY is detected, on the same descriptor the JSON
goes to. That is the defect F-278 was filed for, arriving from a dependency.

Two reachable consequences, both from the auditor and both confirmed in the source:

1. **`dist/api/middlewares/origin-check.mjs:110`**:
   `ctx.context.logger.error(\`Invalid origin: ${originHeader}\`)`, where `originHeader` is
   the `Origin` or `Referer` header. **Unauthenticated, attacker-controlled bytes, up to
   Node's 16 KB header limit, straight onto the log stream** in a line no allowlist sees.
   `error` is above the default `warn` level, so this is live the moment the mount exists.
   CR and LF are rejected by Node's header parser, so this is pollution and allowlist bypass
   rather than record forgery.
2. **`dist/api/routes/sign-up.mjs:168`**:
   `logger.info(\`Sign-up attempt for existing email: ${email}\`)`. Suppressed at the default
   `warn` level, and one config key from being live. `logger: { level: 'info' }` is a
   plausible thing for a developer to write and there is no rule anywhere against it. It puts
   an email address on a log line, which is the one field GC-G names.

No artifact in this repository decides anything about this logger. ADR-0041 (any other
logger is gated at the dependency list) is the nearest existing rule and it was written
about direct dependencies, not about a logger inside one.

## Decision

**TASK-003 states `logger` on the composed Better Auth config, bound to the shared pino
instance through the `log` hook, and `auth.config.spec.ts` asserts it.**

```ts
betterAuth({
  logger: {
    level: 'warn',   // 'error' until 2026-08-15; struck by ADR-0060, F-175
    disableColors: true,
    // THE MESSAGE IS THE ONLY THING THAT CROSSES, AND IT CROSSES AS `msg`.
    // `args` is dropped: dispatch.mjs and index.mjs pass error objects positionally,
    // and pino's default serialisation of an arbitrary object is what F-244 closed.
    log: (level, message) => {
      logger[level === 'debug' ? 'debug' : level === 'info' ? 'info' : level === 'warn' ? 'warn' : 'error'](
        { code: 'better_auth' },
        message,
      );
    },
  },
  // ...
})
```

Three properties, each load-bearing:

- **`log` is a function, so the `console` branch is never taken.** That is the whole
  mechanism: `createLogger` checks `typeof options.log !== "function"` and takes the
  `console` path only when it is absent.
- **`args` is not forwarded.** `dist/api/dispatch.mjs:72` and `dist/api/index.mjs:208` pass
  error objects positionally. Spreading them into pino's first argument would put an
  arbitrary object's enumerable properties on the line, which is exactly the shape
  `serializers.err` exists to prevent (F-244). Dropping them loses stack detail from inside
  the dependency and keeps the allowlist intact.
- **`message` lands in `msg`, not in a field.** `msg` is free text by construction and is the
  one field no key-based scheme can censor (ADR-0028, "Door six"). **So this decision does
  not make Better Auth's messages safe; it makes them visible to one mechanism instead of
  none, and puts them in the field that is already understood to be uncensored.**

~~`level: 'error'` keeps `sign-up.mjs:168`'s email line suppressed at the source rather than
relying on a downstream filter.~~ **Struck 2026-08-15 (ADR-0060, F-175): the level is `'warn'`,
and that line is `logger.info` at the source, so `'warn'` suppresses it just as completely.**
Raising it to `info` is a decision this ADR forbids without an amendment, and the spec asserts
the level, now at `'warn'`.

### The residual, stated rather than closed

`origin-check.mjs:110` still interpolates an attacker-controlled header into a message, and
that message still reaches the log store, now as pino's `msg` rather than as a raw
`console.error` line. **Binding the logger does not fix F-108's class; it relocates it into a
field the repository already knows is uncensored.** What it buys is that the line is JSON, is
levelled, carries `service` and `env`, and can be dropped by level or by `code` at the
collector. What it does not buy is a bound on the bytes.

The honest bound would be truncating `message` in the hook. This ADR does not, for the reason
F-108 already established: the repository refused truncation as a general answer to
caller-controlled bytes, because a truncated attacker string is still an attacker string and
the truncation length becomes a number nobody can justify. Recorded as accepted residual,
with the trigger below.

## Alternatives considered

| Option | Pros | Cons | Why not |
|---|---|---|---|
| `logger: { disabled: true }` | One key. Nothing from the dependency reaches any log, so the allowlist is trivially intact and the `origin-check` residual disappears entirely | Discards every diagnostic the auth surface produces, including the ones that matter during an incident: adapter failures, key-decryption failures (`Failed to decrypt private key`, which is ADR-0051's exact failure mode), and hook errors. The mount already sits outside the Nest graph, so no filter and no interceptor sees it either: disabling the logger makes the most security-critical component in the system silent | Trades all observability on the one surface with none of our own instrumentation, to close a residual that binding also mostly closes |
| Leave it at the default and add a lint rule or a CI grep | No config change | No lint rule reaches `node_modules`, and there is nothing in our source to grep. The channel is created by a dependency at runtime | There is nothing for a static rule to see |
| Bind the hook and forward `args` through pino's `err` serializer | Keeps stack detail from inside the dependency | `args` is `unknown[]` and positionally shaped; only some call sites pass an `Error`. Deciding per-site what is an error is reading a dependency's call sites and depending on them not changing | A second place a Better Auth upgrade breaks logging, for detail that is already in the message |
| Truncate `message` in the hook to a fixed length | Bounds the `origin-check` bytes | F-108 established that truncation is not this repository's answer to caller-controlled bytes, and the length would be unjustifiable. It also silently mangles legitimate long messages | Consistency with a decision already taken, and the residual is stated instead |

## Consequences

### Positive

- One log stream, one format, one level scheme. `LOGGABLE_FIELDS` is not bypassed by a
  channel nobody enumerated, and ADR-0028's "exactly one censoring mechanism" becomes true
  again from the moment Better Auth mounts rather than false from that moment.
- The email line at `sign-up.mjs:168` is suppressed at the source by `level: 'warn'` (it is an
  `info` call, struck from `'error'` 2026-08-15), and raising the level is now a diff that
  fails a test.
- `disableColors: true` removes ANSI escapes from a stream that is otherwise JSON: the
  benign half of F-278, closed here before it lands rather than after.

### Negative / accepted cost

- **The `origin-check.mjs:110` residual is real and is not closed.** An unauthenticated
  caller still writes up to 16 KB of chosen bytes into `msg`, once per request they choose to
  make. It is now inside the structured stream instead of beside it, which makes it
  droppable at a collector and does not make it bounded.
- **`msg` is the uncensored field and this decision routes a dependency's free text into
  it.** That is a deliberate widening of what reaches `msg`, in a repository whose logging
  rule is that `msg` must be a constant at every one of our own call sites. The dependency
  does not follow that rule and cannot be made to.
- **`args` is dropped, so diagnostics lose detail.** An adapter error's stack does not reach
  the log through this hook. During an incident on the auth surface, the line will say what
  happened and not where.
- **The hook is a mapping from four Better Auth levels onto pino's, written by hand.** A
  level added upstream falls into the `error` branch. That is the safe direction and it is
  still a mapping that can drift.
- This is a fourth thing `auth.config.spec.ts` asserts about the composed config, alongside
  `rateLimit.enabled === false`, the schema pin and the secret. All four are facts that
  degrade silently, which is why they are all in one place, and that file is now the single
  point where four unrelated silent failures are caught.

### What would force truncation or disabling

- A log store with a cost or a retention model that an unauthenticated caller can move by
  sending headers. There is none today; the sink is a developer's terminal and CI's job log.
- A second dependency-owned log channel, which would make the per-dependency hook a pattern
  rather than a one-off and is the point at which a shared adapter is worth building.

### Follow-ups this creates

- TASK-003 writes the `logger` key and its comment, and `auth.config.spec.ts` asserts
  `level === 'warn'` (struck from `'error'` 2026-08-15, ADR-0060), and that `log` is a
  function.
- ADR-0028 gains no edit; it is frozen. This ADR is the record that its "exactly one
  censoring mechanism" claim needs a dependency-shaped caveat, and the caveat is: **a mounted
  dependency is a second channel until something binds it.**
- ADR-0041's rule (any other logger is gated at the dependency list) is extended in
  practice, not in text: the gate for a logger *inside* a dependency is a config key and a
  unit test, because the dependency list cannot express it.
