# Contract: outbound mail

- **Boundary:** the application to the email provider; and every test, every local stack and every deployment with no mail configured, none of which may reach it.
- **Normative form:** `apps/api/src/mail/mail-sender.ts` (the port and the union), `apps/api/src/mail/mail-transport.ts` (the declaration, the assertion, the resolver, the five strings), `apps/api/src/mail/senders/*.ts` (the four classes), `apps/api/src/mail/templates/*.ts` (the renderers), `apps/api/src/mail/mail.module.ts` (the `useFactory` binding). Shipped 2026-08-18 by TASK-1b-02. The design stub this line used to point at (`design/stubs/apps/api/src/mail/mail-sender.ts`) no longer exists in the tree — `design/stubs/**` is gone — so F-401 (a stub carrying the struck `NODE_ENV` binding) is discharged by absence.
- **Produced by:** TASK-1b-02 (item 1b). TASK-010 was the foundation card that never shipped.
- **Consumed by:** TASK-1b-08 (invitations dispatch, `MailModule` imported into `InvitationsModule`). **No verification caller exists**: email verification is outside item 1b, the `email_verification` arm and its renderer are present so the union has two members and every sender is compiled against both, and nothing dispatches it.
- **ADRs:** ADR-0017, ADR-0002, ADR-0028 (log field allowlist), ADR-0029 (no configured value in error text).
- **Depends on:** nothing. `MAIL_TRANSPORT` is read here and nowhere else.

## Normative types

```ts
export type MailTemplate = 'email_verification' | 'workspace_invitation';

export type OutboundMail =
  | {
      template: 'email_verification';
      to: string;
      idempotencyKey?: string; // 2026-08-19, debt sweep (1b-W1-08); see the dated note below
      data: { verificationUrl: string; expiresAt: Date };
    }
  | {
      template: 'workspace_invitation';
      to: string;
      idempotencyKey?: string; // 2026-08-19, debt sweep (1b-W1-08); see the dated note below
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

> **Shipped 2026-08-18 (TASK-1b-02), and it diverges in the class, not the field.** The
> assertion throws `MailBindingError`, declared in `mail-transport.ts` with
> `readonly binding: 'mail_transport'`, and `main.ts`'s `bootstrap().catch` maps
> `error.binding` onto `boot_precondition` exactly as it maps `AuthBindingError.binding`
> (ADR-0058). `BootPreconditionError` could not be used: it is module-private to `main.ts`,
> and `main.ts` calls `bootstrap()` at module scope, so a leaf module importing it would boot
> the API. The auth bindings met the same wall and answered it the same way. The FIELD VALUE
> on the line is this contract's, verbatim, and it is what `test/mail/mail-transport-boot.int-spec.ts`
> and every operator grep key on. `resolveMailTransport` throws the same class on an
> unrecognised value rather than returning `none`, so `mail.module.ts`'s factory — reachable
> without `main.ts` from a testing module — cannot turn a typo into a silently suppressed
> sender either.

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
  'MAIL_TRANSPORT is "resend" but RESEND_API_KEY is not set. A deployment that sends mail must carry the provider credential. See docs/contracts/mail-sender.md.';

export const MAIL_FROM_UNSET_MESSAGE =
  'MAIL_TRANSPORT is "resend" but MAIL_FROM is not set. A live sender names its From address rather than defaulting to one. See docs/contracts/mail-sender.md.';

export const MAIL_TEST_GUARD_MESSAGE =
  'A test process must not be able to send mail. RESEND_API_KEY is set, or MAIL_TRANSPORT is "resend". Unset both in the test environment. See docs/contracts/mail-sender.md.';

export const RESEND_SENDER_NOT_DECLARED_MESSAGE =
  'ResendMailSender was constructed but MAIL_TRANSPORT is not "resend". The live sender is reachable only by explicit declaration. See docs/contracts/mail-sender.md.';
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

> **Shipped shape, 2026-08-18 (TASK-1b-02), where it adds to the block above:**
>
> - `ResendMailSender`'s constructor takes an optional fourth argument,
>   `options: { replyTo?: string; fetch?: typeof fetch }`. `replyTo` carries `MAIL_REPLY_TO`
>   (sent as Resend's `reply_to`); `fetch` is how `senders.spec.ts` drives the retry table
>   against a fake without a socket. The three-argument form above is unchanged and is what
>   the module factory calls, plus `replyTo`. The adapter uses the platform `fetch` and no
>   SDK: one `POST`, `authorization: Bearer <key>`, JSON `{ from, to: [to], subject, text,
>   html, reply_to? }`; the provider's response body is drained and never read, because
>   Resend's error text can quote the rejected field and `to` is an address.
> - `readResendBinding(env)` in `mail-transport.ts` is the one reader of `RESEND_API_KEY`,
>   `MAIL_FROM` and `MAIL_REPLY_TO`; the assertion calls it to refuse and the factory calls it
>   to construct, so "set" means the same thing on both paths (set and non-blank).
> - **Added 2026-08-19 (debt sweep, ledger 1b-W1-08): `OutboundMail.idempotencyKey`, and the
>   `Idempotency-Key` header.** The retry was unsafe in one window: a network throw does not
>   say whether the provider accepted the message before the response was lost, so the one
>   retry could send a second copy. When a message carries `idempotencyKey`,
>   `ResendMailSender` now sends it as the `Idempotency-Key` header on BOTH attempts — the
>   value is identical on the first attempt and the retry, which is what lets Resend
>   deduplicate the pair. The invitation dispatch (`invitation-mail.ts`,
>   `invitations.service.ts`) sets it to the invitation row's id: a uuid, stable, and not a
>   secret. A message without the field sends no such header and keeps the pre-sweep
>   behaviour — the double-send window then stands for that caller, which today is nobody
>   (nothing dispatches `email_verification`). Every other sender ignores the field.
>   `senders.spec.ts` pins presence, identity across the retry, and absence.
>   `resolveMailTransport` is the ONE literal read of `MAIL_TRANSPORT`; the assertion goes
>   through it. `mail-transport.spec.ts` scans `apps/api/src/**` (comments and strings
>   stripped) and asserts `mail/mail-transport.ts` is the only file naming the variable and
>   that nothing under `mail/` names `NODE_ENV` in code. `vitest.setup.ts` (guard 1) sits
>   outside `src/` and reads it directly, as this contract says it does.
> - `NoopMailSender`'s counter is process-local: `readMailSuppressedCount()` in
>   `senders/noop-mail-sender.ts` is the number behind `MAIL_SUPPRESSED_COUNTER` until a
>   metrics client exists.
> - `ConsoleMailSender` writes ONE `console.log` per message, in this exact shape, so the
>   compose e2e and a developer's `grep` can rely on it (the text part puts the URL on a line
>   of its own):
>
>   ```
>   --- outbound mail (console transport; nothing was sent) ---
>   To: <to>
>   Subject: <subject>
>
>   <text part, verbatim>
>   --- end of outbound mail ---
>   ```
>
>   That `console.log` is the one sanctioned `console` call under `apps/api/src`: the eslint
>   carve-out is one `disable-next-line` on the statement, and AC-116's enumeration
>   (`logging-opt-out.spec.ts`) names the file as its second exemption beside `logger.ts`,
>   with the reason recorded in `logging-and-headers.md` ("Never call `console.*`"). The
>   content is a delivery channel, not a log line, and it may never go through the logger.
> - Templates: `templates/render-mail.ts` exports `renderMail(message): { subject, text, html }`
>   with an exhaustive `switch`; `templates/workspace-invitation.ts` exports
>   `renderWorkspaceInvitation(data)` (subject "You've been invited to <tenantName> on
>   Shortkit"; `tenantName`, `inviterEmail`, workspace names and the URL HTML-escaped in the
>   HTML part; the URL verbatim on its own line in the text part; expiry as
>   `25 August 2026 at 15:04 UTC`); `templates/email-verification.ts` the minimal sibling.
> - The module: `MailModule` binds `MAIL_SENDER` by `useFactory: () => mailSenderFor(process.env)`
>   and exports it. `mailSenderFor` is exhaustive over `MailTransport`, so a fifth value
>   without a class is a compile error.

## No test sends mail. Enforced twice, and neither guard reads `NODE_ENV`.

1. `apps/api/vitest.setup.ts` throws `MAIL_TEST_GUARD_MESSAGE` at import time if
   `RESEND_API_KEY` is set **or** `MAIL_TRANSPORT` is `resend`. ("Set" is set and non-empty:
   `RESEND_API_KEY=` is what an env file produces for an absent variable and authenticates
   nothing. Shipped 2026-08-18; both configs name the setup file, so both tiers are covered.)
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
`template` is the one new name this contract adds to `LOGGABLE_FIELDS` (landed by
TASK-1b-02, 2026-08-18; `logger.ts` and the fence in `logging-and-headers.md` both carry it);
it is a closed union of two literals and carries nothing about a person. `err_name` and `err_message` are already
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

> 2026-08-18: D-02 (ruled by Juano) has the compose stack declare `MAIL_TRANSPORT=console`
> so a developer and the compose e2e read the invite URL out of `docker compose logs api`;
> TASK-1b-11 sets it in `docker-compose.yml`. Every other environment — the unit and
> integration tiers, CI, `pnpm dev`, a bare `docker run` — still declares nothing and resolves
> `none`. `apps/api/.env.example` documents all four variables (TASK-1b-02).

## Invariants a caller may rely on

1. Exactly one `send` per invitation creation (AC-1b-3, formerly AC-32), from one place,
   whatever the transport. (The verification clause, AC-16, has no caller in item 1b.)
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
- `ResendMailSender` retries once on a 5xx or a network error, never on a 4xx. Since
  2026-08-19 (1b-W1-08) both attempts carry the message's `idempotencyKey` as the
  `Idempotency-Key` header when the caller set one, so the retry cannot double-send.
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
