---
id: ADR-0017
slug: launch-core
title: Resend behind a MailSender port, with the API key absent in test so no test can send mail
status: accepted
supersedes: null
date: 2026-08-04
---

## Context

`refinement.md` lists the provider as an open Design question and notes the free tier
is sufficient. Two flows send mail: email verification (TASK-010) and workspace
invitations (TASK-021). AC-16 and AC-32 each require exactly one message dispatched,
which is asserted against a fake rather than against a provider.

Volume is trivial. A handful of messages a day at portfolio scale, and a few hundred a
month even with real customers. Deliverability is not measured by any AC in
`launch-core`.

The apex domain is unresolved, so whichever provider is chosen has to send something
before a domain exists to verify.

## Decision

**Resend**, reached through `MailSender`, a port with one method.

```ts
export interface MailSender {
  send(message: OutboundMail): Promise<void>;
}
```

`OutboundMail` is a discriminated union on `template`, so the payload for
`email_verification` and the payload for `workspace_invitation` are separately typed
and a caller cannot send an invitation without its workspace list.

**Three implementations, bound by the `MAIL_SENDER` token:**

| Binding | Environment | Behaviour |
|---|---|---|
| `ResendMailSender` | production, staging | posts to Resend |
| `ConsoleMailSender` | local development | writes the rendered message to stdout |
| `FakeMailSender` | test | records into an array, exposes `sent`, `clear()`, `lastTo()` |

**No test can send mail, enforced rather than agreed.** `vitest.setup.ts` for
`apps/api` asserts `RESEND_API_KEY` is unset and throws at import time if it is set.
`ResendMailSender`'s constructor throws when `NODE_ENV === 'test'`. A test would have
to defeat both to reach the network.

**Sending happens after commit.** ADR-0002 bans third-party network calls inside a
tenant transaction. TASK-010 and TASK-021 pass the send to
`withTenantTransaction`'s `afterCommit` callback, so a rejected invitation never emails
and a failed send never rolls back a committed invitation.

**A send failure after commit is logged and does not fail the request.** The
invitation exists and can be resent. Resending is out of scope for `launch-core`
(TASK-021 says so), so the operator's recourse today is revoke and re-invite.

**From address.** `noreply@<apex>` once a domain exists. Until then
`onboarding@resend.dev`, which Resend permits without domain verification. Recording it
here so nobody treats the placeholder as a decision.

**Bodies are human-facing prose** and get a `stop-slop` pass under GC-12. Templates are
plain TypeScript template strings producing text and HTML, not a template engine.

## Alternatives considered

| Option | Pros | Cons | Why not |
|---|---|---|---|
| Postmark | Best transactional deliverability of the three; excellent bounce and delivery visibility; a sender signature can be verified against a single email address without a domain | Free tier is 100 messages a month, which is a real ceiling if the verification flow is exercised during testing against a live provider | The volume ceiling is the tightest of the three for the least benefit at portfolio scale |
| Amazon SES | Cheapest at any real volume; already in the toolkit of anyone with AWS | Sandbox mode requires verifying every recipient address, and leaving sandbox requires a support request that can take days. IAM, region selection and a signing library are all setup that Resend does not need | The onboarding friction exceeds the value, and the support-request step could block a wave |
| Resend | 3,000 messages a month, 100 a day, on the free tier. One `POST` with a bearer token. Sends from `onboarding@resend.dev` before any domain exists | Newer company than the other two, so less deliverability history. Daily cap of 100 | Chosen |
| SMTP through a generic provider with `nodemailer` | Provider-agnostic; swapping means changing a connection string | SMTP credentials, connection pooling and TLS handling become ours, and delivery feedback is a bounce mailbox nobody reads | More surface for the same outcome the port already gives |
| No provider: log the verification link in development, defer real sending | Zero setup; unblocks TASK-010 immediately | AC-16 and AC-18 describe a real flow a real user completes. Deferring makes STORY-005 untestable end to end | Fails the acceptance criteria |

## Consequences

### Positive

- One `POST` with an API key. The adapter is under 40 lines and the port has one
  method, so replacing Resend is one file.
- Verification and invitation flows are testable before an apex domain exists, which
  keeps STORY-005 and STORY-008 off the apex-blocked list.
- Two independent guards make an accidental live send from a test impossible rather
  than unlikely.
- The typed template union means TASK-021 cannot dispatch a malformed invitation.

### Negative / accepted cost

- **100 messages a day.** Manual end-to-end testing of signup and invitations will hit
  it on a heavy day, and the failure surfaces as a provider error in a flow that
  otherwise worked.
- Sending from `onboarding@resend.dev` until the apex domain exists means verification
  and invitation mail arrives from a domain the recipient does not recognise, so spam
  placement during early testing is likely and is not a bug.
- Nothing in `launch-core` reads Resend's bounce or complaint webhooks, so a
  permanently undeliverable address looks identical to a delivered one. An operator
  whose invitee never received the email has no signal and no resend button.
- Deliverability has no AC, so a regression in it is invisible to the suite.
- The two test guards are in two places. Someone adding a new test setup file has to
  know about the first.

### Follow-ups this creates

- TASK-010 owns `MailSender`, `OutboundMail`, all three implementations, the two test
  guards, and the verification template.
- TASK-021 adds the invitation template and dispatches from `afterCommit`.
- Bounce handling, a resend action, and a real `From` domain belong to a later
  initiative.
- Contract: `design/contracts/mail-sender.md`.
