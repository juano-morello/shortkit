# Contract: outbound mail

- **Boundary:** the application to the email provider; and every test, which must not reach it.
- **Normative form:** `apps/api/src/mail/mail-sender.ts`, not yet written. The design stub at `design/stubs/apps/api/src/mail/mail-sender.ts` stands in until TASK-010 lands the file and is retired then (ADR-0039). It is a design-gate scaffold, not a normative form.
- **Produced by:** TASK-010.
- **Consumed by:** TASK-021 (invitations), TASK-009/010 (verification).
- **ADRs:** ADR-0017, ADR-0002.

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

## Implementations

| Class | Bound when | Behaviour |
|---|---|---|
| `ResendMailSender` | `NODE_ENV` is `production` or `staging` | `POST https://api.resend.com/emails` |
| `ConsoleMailSender` | `NODE_ENV === 'development'` | writes the rendered text to stdout |
| `FakeMailSender` | `NODE_ENV === 'test'` | records in memory |

```ts
export interface FakeMailSender extends MailSender {
  readonly sent: ReadonlyArray<OutboundMail>;
  clear(): void;
  lastTo(email: string): OutboundMail | undefined;
}
```

## No test sends mail. Enforced twice.

1. `apps/api/vitest.setup.ts` throws at import time if `RESEND_API_KEY` is set.
2. `ResendMailSender`'s constructor throws if `NODE_ENV === 'test'`.

A test would have to defeat both to reach the network.

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
invitation; it logs `mail_dispatch_failed` with `{ template, to: redacted, error }` and
does not fail the request.

## Configuration

| Variable | Purpose |
|---|---|
| `RESEND_API_KEY` | provider credential. **Unset in test.** |
| `MAIL_FROM` | `noreply@<apex>` once registered; `onboarding@resend.dev` until then |
| `MAIL_REPLY_TO` | optional |

## Invariants a caller may rely on

1. Exactly one message per verification request (AC-16) and per invitation creation
   (AC-32). `send` is called once, from one place, per operation.
2. `send` resolving means the provider accepted the message. It does **not** mean
   delivery. Nothing in `launch-core` reads bounces.
3. Every template renders both `text/plain` and `text/html`.
4. No message body, and no log line, contains a password, a JWT, or a raw IP (GC-9).
   Verification and invitation tokens appear in the URL in the body, which is their
   purpose, and never in a log.
5. Tokens are single-use and expiring, and a consumed, expired or revoked token
   produces a distinct state (TASK-020, AC-34, AC-35, AC-36).

## What the implementer must guarantee

- Adding a template means extending the `OutboundMail` union, so every implementation
  fails to compile until it handles the new case.
- Bodies are human-facing prose and get a `stop-slop` pass (GC-12).
- `ResendMailSender` retries once on a 5xx or a network error, never on a 4xx.
- Resend's free tier caps at 100 messages a day. Exceeding it surfaces as
  `mail_dispatch_failed`, and the operator's flow otherwise succeeded.

## Versioning

Additive on the union. Changing a template's `data` shape is breaking for the template
renderer only, which is compiled in the same commit.
