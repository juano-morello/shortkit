# Contract: outbound mail

- **Boundary:** the application to the email provider; and every test, every local stack and every deployment with no mail configured, none of which may reach it.
- **Normative form:** `apps/api/src/mail/mail-sender.ts`, not yet written. The design stub at `design/stubs/apps/api/src/mail/mail-sender.ts` stands in until TASK-010 lands the file and is retired then (ADR-0039). It is a design-gate scaffold, not a normative form. **The stub still carries the `NODE_ENV` binding this contract removed (F-386); this file is normative and the stub is stale until TASK-010 or a stub sweep corrects it.**
- **Produced by:** TASK-010.
- **Consumed by:** TASK-021 (invitations), TASK-009/010 (verification).
- **ADRs:** ADR-0017, ADR-0002, ADR-0028 (log field allowlist), ADR-0029 (no configured value in error text).
- **Depends on:** nothing. `MAIL_TRANSPORT` is read here and nowhere else.

## Normative types

```ts
export type MailTemplate = 'email_verification' | 'workspace_invitation';

export type OutboundMail =
  | {
      template: 'email_verification';
      to: string;
      data: { verificationUrl: string; expiresAt: Date };
    }
  | {
      template: 'workspace_invitation';
      to: string;
      data: {
        inviteUrl: string;
        inviterEmail: string;
        tenantName: string;
        workspaces: ReadonlyArray<{ name: string; role: WorkspaceRole }>;
        expiresAt: Date;
      };
    };

export interface MailSender {
  send(message: OutboundMail): Promise<void>;
}

export const MAIL_SENDER = Symbol('MAIL_SENDER');
```

The union is discriminated on `template`, so a caller cannot dispatch an invitation
without its workspace list, and cannot pass verification data to an invitation.

## The mail transport

Added 2026-08-12 (F-386). **The binding's trigger is this variable, not `NODE_ENV`.**
`Dockerfile:83` is `ENV NODE_ENV=production` in the image `docker compose` runs, so the
previous rule ("`ResendMailSender` when `NODE_ENV` is `production` or `staging`") bound the
live provider in every developer's compose stack. ADR-0017 holds the reasoning.

```
MAIL_TRANSPORT = resend | console | fake | none        # unset is read as none
```

| Value | Class | Behaviour | Required alongside |
|---|---|---|---|
| `resend` | `ResendMailSender` | `POST https://api.resend.com/emails` | `RESEND_API_KEY` and `MAIL_FROM`. **Boot fails when either is unset or empty** |
| `console` | `ConsoleMailSender` | writes the rendered text to stdout with `console.log`, sends nothing | nothing |
| `fake` | `FakeMailSender` | records in memory, sends nothing | nothing |
| `none` | `NoopMailSender` | discards, counts, logs one warn line per message. Sends nothing | nothing |
| unset | `NoopMailSender` | as `none`. The default | nothing |
| any other value | none | **boot fails, in every environment, unconditionally** | not reached |

Three checks, one unconditional and two gated:

1. **Validity of `MAIL_TRANSPORT` is asserted unconditionally.** `Resend`, `prod`, `true` and
   `1` all fail boot everywhere, including in tests and in CI. A typo must never silently
   select a transport nobody named.
2. **`RESEND_API_KEY` and `MAIL_FROM` are asserted only under `resend`.** Declaring the live
   provider without a credential is a configuration error, not a reason to degrade: an
   operator who asked for real mail and gets silence has a worse outcome than one whose
   process refused to start.
3. **`console`, `fake`, `none` and unset assert nothing** and reach no network.

**Absence selects a sender, not a failure.** This is the inversion from
`CLIENT_TRUST_BOUNDARY` and `BFF_TRUST_BOUNDARY`, where absence means "assert nothing and
resolve no principal". Here the permissive branch spends money and reaches a stranger's
inbox, so absence has to select the transport that cannot do either. `none` is a bound,
working `MailSender`: `send` resolves, the caller's `afterCommit` completes, and no request
path changes shape because mail is unconfigured.

**`MAIL_TRANSPORT` is a fourth declaration, not a value of an existing one.** It is not
reachable from `CLIENT_TRUST_BOUNDARY` or `BFF_TRUST_BOUNDARY`: those declare which inbound
hop may be trusted for a client address, and mail is an outbound capability that varies
independently of both. A CDN-fronted redirect-only deployment is `proxy` and must never
send; a Vercel-BFF deployment is `direct` for the header question, `bff` for the secret
question, and is the one that must send. ADR-0017 prices both collapses.

**Why not `MAIL_TRUST_BOUNDARY`.** The siblings name a trust boundary because that is what
they declare. Nothing here is trusted. This names which transport delivers, and one value
per implementation is what keeps the enum from growing to cover deployment nuance. See
Versioning.

### The boot assertion

`assertMailTransportConfigured(env)` is called **unconditionally** from `main.ts`'s
`assertBootPreconditions()`, beside `readBuildCommitSha()` and `assertRuntimeRoleIsSafe()`.
The gating is inside the function, and it reads `MAIL_TRANSPORT` and **never `NODE_ENV`**.

**It throws `BootPreconditionError('mail_transport', <message>)`**, the shipped type at
`main.ts:305`, so the refusal carries `boot_precondition: 'mail_transport'` and is
distinguishable by machine from `database_reachable` and
`runtime_role_cannot_bypass_rls` (F-245). This follows shipped `main.ts` rather than the two
unwritten sibling assertions, whose contracts say only "throw" with an exact message; when
TASK-009 writes those, the same wrapping should apply to them.

It also emits the one signal a misconfigured deployment gets before a user notices: when the
resolved transport is `none`, **one warn line at boot**, carrying
`boot_precondition: 'mail_transport'` and no other field. That name is already in
`LOGGABLE_FIELDS` (`logger.ts:54`), so the line needs no allowlist edit.

The line fires for unset and for an explicit `none` alike. An operator who declared `none`
on purpose is reading one warn line per process start, which is cheap; an operator who
forgot is reading the only local evidence that exists, at the moment it is still cheap to
act on.

### Error strings

Exact. None interpolates a configured value: an environment read is not eligible for error
text (ADR-0029), and `MAIL_FROM` and `RESEND_API_KEY` are the two reads most likely to carry
something an operator did not mean to publish.

```ts
export const MAIL_TRANSPORT_INVALID_MESSAGE =
  'MAIL_TRANSPORT must be "resend", "console", "fake" or "none", or unset. It is not NODE_ENV and it is not a boolean.';

export const RESEND_API_KEY_UNSET_MESSAGE =
  'MAIL_TRANSPORT is "resend" but RESEND_API_KEY is not set. A deployment that sends mail must carry the provider credential. See design/contracts/mail-sender.md.';

export const MAIL_FROM_UNSET_MESSAGE =
  'MAIL_TRANSPORT is "resend" but MAIL_FROM is not set. A live sender names its From address rather than defaulting to one. See design/contracts/mail-sender.md.';

export const MAIL_TEST_GUARD_MESSAGE =
  'A test process must not be able to send mail. RESEND_API_KEY is set, or MAIL_TRANSPORT is "resend". Unset both in the test environment. See design/contracts/mail-sender.md.';

export const RESEND_SENDER_NOT_DECLARED_MESSAGE =
  'ResendMailSender was constructed but MAIL_TRANSPORT is not "resend". The live sender is reachable only by explicit declaration. See design/contracts/mail-sender.md.';
```

### Normative source

```ts
export const MAIL_TRANSPORT_ENV = 'MAIL_TRANSPORT';

/** Unset is read as 'none'. Anything outside this set fails boot, everywhere. */
export const MAIL_TRANSPORTS = ['resend', 'console', 'fake', 'none'] as const;
export type MailTransport = (typeof MAIL_TRANSPORTS)[number];

export const MAIL_SUPPRESSED_COUNTER = 'mail_suppressed_total';

/**
 * Called UNCONDITIONALLY from main.ts. The gating is inside, and it keys on
 * MAIL_TRANSPORT, NEVER on NODE_ENV (F-386; Dockerfile:83 is ENV NODE_ENV=production
 * in the image docker compose runs, which is how the old rule bound the LIVE provider
 * in every developer's stack).
 *
 *   1. ALWAYS: MAIL_TRANSPORT, if set, is one of MAIL_TRANSPORTS.
 *      Otherwise throw MAIL_TRANSPORT_INVALID_MESSAGE.
 *   2. ONLY when it is 'resend': RESEND_API_KEY and MAIL_FROM are set and non-empty.
 *      Otherwise throw RESEND_API_KEY_UNSET_MESSAGE or MAIL_FROM_UNSET_MESSAGE.
 *   3. When the resolved transport is 'none', including unset: log ONE warn line
 *      carrying boot_precondition: 'mail_transport', and return.
 *
 * Cannot check that a deployment which sends mail declared a transport. Nothing local
 * can tell a process with no mail configured that it was meant to have some.
 */
export function assertMailTransportConfigured(
  env: Record<string, string | undefined>,
): void;

/** Resolves the bound sender. The ONLY read of MAIL_TRANSPORT outside the assertion. */
export function resolveMailTransport(
  env: Record<string, string | undefined>,
): MailTransport;

/** Bound under 'resend'. Retries once on 5xx or a network error, never on a 4xx. */
export declare class ResendMailSender implements MailSender {
  /**
   * Throws RESEND_SENDER_NOT_DECLARED_MESSAGE when MAIL_TRANSPORT is not 'resend'.
   * Guard 2 of 2 against a live send from a test, and the guard that also covers a
   * direct `new ResendMailSender(...)` in any runner.
   */
  constructor(apiKey: string, from: string, env: Record<string, string | undefined>);
  send(message: OutboundMail): Promise<void>;
}

/** Bound under 'console'. Writes the rendered message to stdout. Reaches no network. */
export declare class ConsoleMailSender implements MailSender {
  send(message: OutboundMail): Promise<void>;
}

/**
 * Bound under 'none' and under an unset MAIL_TRANSPORT. Discards the message.
 *
 * `send` RESOLVES. A caller cannot distinguish it from a delivered message, which is
 * deliberate: no request path branches on whether mail is configured. What it does
 * emit is one warn line per message (msg 'mail_suppressed', field `template`) and one
 * increment of MAIL_SUPPRESSED_COUNTER.
 *
 * Records NOTHING. FakeMailSender is the one that records; a long-lived process
 * accumulating every suppressed message is a memory leak with an audit trail.
 */
export declare class NoopMailSender implements MailSender {
  send(message: OutboundMail): Promise<void>;
}
```

```ts
export interface FakeMailSender extends MailSender {
  readonly sent: ReadonlyArray<OutboundMail>;
  clear(): void;
  lastTo(email: string): OutboundMail | undefined;
}
```

## No test sends mail. Enforced twice, and neither guard reads `NODE_ENV`.

1. `apps/api/vitest.setup.ts` throws `MAIL_TEST_GUARD_MESSAGE` at import time if
   `RESEND_API_KEY` is set **or** `MAIL_TRANSPORT` is `resend`.
2. `ResendMailSender`'s constructor throws `RESEND_SENDER_NOT_DECLARED_MESSAGE` when
   `MAIL_TRANSPORT` is not `resend`.

A test would have to defeat both to reach the network, and defeating both now means setting
two variables on purpose rather than inheriting one from a base image.

**A suite that declares nothing gets `NoopMailSender` and reaches no network.** That is the
change worth noticing: the old guards depended on `NODE_ENV === 'test'` being present, which
vitest sets and a plain `tsx` script, a child-process harness with an explicit `env`, or a
CI shell does not. Under this rule the failure of a harness to declare anything lands on the
transport that cannot send.

**A suite asserting on sent mail sets `MAIL_TRANSPORT=fake`.** `FakeMailSender` is no longer
selected by the runner, so AC-16's and AC-32's exactly-one assertions require the
declaration. A suite that forgets sees `sent` on no sender at all and fails to compile
against `MAIL_SENDER`, rather than passing for the wrong reason.

## Dispatch timing

**Mail is sent from `afterCommit`, never inside a tenant transaction** (ADR-0002:
no third-party network I/O inside a transaction holding a pooled connection).

```ts
await withTenantTransaction(tenantId, async (db) => {
  const invitation = await invitationRepository.create(db, input);
  return invitation;
}, { afterCommit: () => mail.send({ template: 'workspace_invitation', to, data }) });
```

A rejected invitation never emails. A failed send never rolls back a committed
invitation; it logs `mail_dispatch_failed` and does not fail the request.

## Signal

| Condition | Counter | Log |
|---|---|---|
| transport is `none`, resolved at boot | none | one **warn** at boot, `boot_precondition: 'mail_transport'` |
| a message reaches `NoopMailSender` | `mail_suppressed_total` | **warn**, `msg: 'mail_suppressed'`, field `template` |
| the provider rejected or the network failed | none | **error**, `msg: 'mail_dispatch_failed'`, fields `template`, `err_name`, `err_message` |

`mail_suppressed` is one line per message rather than one per minute. Volume is a handful of
messages a day (ADR-0017), and the operator this line is written for is the one who invited
somebody from a deployment that cannot send.

**No log line carries a recipient address, a subject, a rendered body, or a URL containing a
token.** `LOGGABLE_FIELDS` is an allowlist (ADR-0028), so `to`, `subject`, `inviteUrl` and
`verificationUrl` are censored to `[redacted]` by default and no denylist entry is needed.
`template` is the one new name TASK-010 adds to `LOGGABLE_FIELDS`; it is a closed union of
two literals and carries nothing about a person. `err_name` and `err_message` are already
allowlisted (`error-envelope.md`).

**No counter backend exists.** Verified 2026-08-12: nothing in `apps/api/src` imports a
metrics client, and `mail_suppressed_total`, `trusted_client_ip_unresolved_total` and
`bff_proxy_auth_mismatch_total` are all names waiting for one. Until metrics land, the warn
line is the whole signal, which is why it is per message and not sampled.

## Configuration

| Variable | Purpose | Required when |
|---|---|---|
| `MAIL_TRANSPORT` | which sender is bound. `resend`, `console`, `fake`, `none`. Unset reads as `none` | never. Absence is a valid, safe declaration |
| `RESEND_API_KEY` | provider credential | `MAIL_TRANSPORT=resend`. Boot fails without it. **Unset in test** |
| `MAIL_FROM` | `noreply@<apex>` once registered; `onboarding@resend.dev` until then | `MAIL_TRANSPORT=resend`. Boot fails without it |
| `MAIL_REPLY_TO` | optional | never |

`MAIL_FROM` has no default. ADR-0017 recorded `onboarding@resend.dev` so nobody would treat
the placeholder as a decision, and a default in the adapter is exactly how a placeholder
becomes one.

**No environment sets `MAIL_TRANSPORT` today**, and none holds a `RESEND_API_KEY`. Every
stack that exists resolves to `NoopMailSender`, which is the state F-386 asked for and is
reached by adding nothing to any environment. A stack that wants the rendered message in its
logs declares `console`; a stack that declares nothing stays safe.

## Invariants a caller may rely on

1. Exactly one `send` per verification request (AC-16) and per invitation creation (AC-32),
   from one place, whatever the transport.
2. `send` resolving means the **bound transport** accepted the message. Under `resend` that
   means the provider accepted it, and it still does not mean delivery: nothing in
   `launch-core` reads bounces. Under `console`, `fake` or `none` it means no message left
   the process. A caller must not read a resolved `send` as evidence that a human will
   receive anything.
3. `send` never throws in a way that fails the caller's request. `NoopMailSender` never
   rejects.
4. Every template renders both `text/plain` and `text/html`, for every transport.
   `ConsoleMailSender` prints the text part.
5. No message body, and no log line, contains a password, a JWT, or a raw IP (GC-9).
   Verification and invitation tokens appear in the URL in the body, which is their purpose,
   and never in a log. `ConsoleMailSender` writes the token URL to **stdout**, which is a
   log destination in every deployment that has one, and that is the reason `console` is not
   what an unset `MAIL_TRANSPORT` selects.
6. Tokens are single-use and expiring, and a consumed, expired or revoked token
   produces a distinct state (TASK-020, AC-34, AC-35, AC-36).

## What the implementer must guarantee

- Adding a template means extending the `OutboundMail` union, so every implementation,
  including `NoopMailSender`, fails to compile until it handles the new case.
- **Only two places read `MAIL_TRANSPORT`**: `assertMailTransportConfigured` and
  `resolveMailTransport`. No adapter, no module, no test helper reads it a third time, and
  nothing reads `NODE_ENV` anywhere under `apps/api/src/mail/**`.
- The `MAIL_SENDER` provider is a `useFactory` over `resolveMailTransport(process.env)`. The
  factory is the only construction site for `ResendMailSender` in shipped code.
- Bodies are human-facing prose and get a `stop-slop` pass (GC-12).
- `ResendMailSender` retries once on a 5xx or a network error, never on a 4xx.
- Resend's free tier caps at 100 messages a day. Exceeding it surfaces as
  `mail_dispatch_failed`, and the operator's flow otherwise succeeded.
- No error message and no log line interpolates `RESEND_API_KEY`, `MAIL_FROM` or the raw
  value of `MAIL_TRANSPORT` (ADR-0029).

## Versioning

Additive on the `OutboundMail` union. Changing a template's `data` shape is breaking for the
template renderer only, which is compiled in the same commit.

**`MAIL_TRANSPORT` carries one value per `MailSender` implementation, and that is the whole
rule.** Adding a value means adding a class in the same commit; adding a value to describe a
deployment ("`resend_staging`", "`resend_throttled`") is how a transport selector becomes a
configuration language, and it belongs in `MAIL_FROM`, in a separate key, or in a variable of
its own. `CLIENT_TRUST_BOUNDARY` and `BFF_TRUST_BOUNDARY` carry the same stance for the same
reason (`trusted-client-address.md`, Versioning).

Removing `none` is not available: it is what unset resolves to, and the safety of every
undeclared environment rests on it.
