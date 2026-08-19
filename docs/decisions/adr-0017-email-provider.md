---
id: ADR-0017
slug: foundation
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
| ~~`ResendMailSender`~~ | ~~production, staging~~ | posts to Resend |
| ~~`ConsoleMailSender`~~ | ~~local development~~ | writes the rendered message to stdout |
| ~~`FakeMailSender`~~ | ~~test~~ | records into an array, exposes `sent`, `clear()`, `lastTo()` |

**Struck 2026-08-12 (F-386). The Environment column read `NODE_ENV`, and `Dockerfile:83`
is `ENV NODE_ENV=production` in the image `docker compose` runs, so this table bound the
live provider in every developer's local stack.** Four implementations now, selected by
`MAIL_TRANSPORT`. See "The binding declares a transport" below.

**No test can send mail, enforced rather than agreed.** `vitest.setup.ts` for
`apps/api` asserts `RESEND_API_KEY` is unset and throws at import time if it is set.
~~`ResendMailSender`'s constructor throws when `NODE_ENV === 'test'`.~~ Guard 2 also keyed
on `NODE_ENV` and now throws when `MAIL_TRANSPORT` is not `resend` (F-386). A test would
have to defeat both to reach the network.

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

### The binding declares a transport, and absence sends nothing

Added 2026-08-12 (F-386), amending the struck table above.

```
MAIL_TRANSPORT = resend | console | fake | none        # unset is read as none
```

`resend` binds the live provider and requires `RESEND_API_KEY` and `MAIL_FROM`, both
asserted at boot. `console` prints. `fake` records. `none`, and an unset variable, bind
`NoopMailSender`, which discards the message, resolves, logs one warn line and increments
`mail_suppressed_total`. Any other value fails boot in every environment, so a typo cannot
select a transport nobody named. The mechanism, the four exact error strings and the signal
table live in `docs/contracts/mail-sender.md` and are not restated here (ADR-0039).

**Absence selects a no-op sender rather than failing an assertion.** The two sibling
declarations from F-380 and F-385 make absence mean "assert nothing", because their
permissive branch costs an unenforced rate limit. This one's permissive branch spends money
and reaches a stranger's inbox, so absence has to reach a sender that cannot do either.
Failing boot instead would recreate the defect F-380 fixed: `docker compose up` refusing to
start until every developer sets a variable, on a stack with no invitation surface to use it.

**Mail is a third fact, not a value of `CLIENT_TRUST_BOUNDARY` or `BFF_TRUST_BOUNDARY`.**
Those two declare which inbound hop may be trusted for a client address. Mail is an outbound
capability, and two deployments ADR-0014 and ADR-0030 leave open break the collapse in
opposite directions. A CDN-fronted, redirect-only API is `proxy` and has no invitation
surface, so keying mail off `proxy` would bind the live provider on the one deployment that
must never send. An API at its own origin behind a Vercel BFF is `direct` and `bff`, and it
is the deployment that must send, so keying off `proxy` there would bind a no-op sender and
every invitation would vanish with the request reporting success.

The name drops the `_BOUNDARY` suffix on purpose. Nothing here is trusted; the variable says
which transport delivers. What it keeps from its siblings is the rule a reader learns once:
a boot-time behavioural choice keys on a declared property of the deployment, never on
`NODE_ENV`, unset means the safe value, and an unrecognised value is fatal everywhere.

**`staging` is deleted, not renamed.** Nothing in this repository is staging: ADR-0030
records no deploy target, and `staging` is not a value Node or the bundlers understand, so
carrying it forward meant a magic string that only this table read. A staging environment,
if one is ever built, declares `MAIL_TRANSPORT=resend` with its own key and its own
`MAIL_FROM`, or declares `console` and reads its own logs. What separates it from production
is the values it sets, not a fourth environment name.

#### Alternatives, priced

**Give the compose stack `MAIL_TRANSPORT=console` and keep the `NODE_ENV` table.** Smaller,
and it fixes the reported stack. Rejected on the same ground F-385 rejected the fixture
secret: it repairs one environment while CI, a second local stack, a bare `docker run` and
any future deploy target each need their own fixture, and it leaves a third `NODE_ENV`
trigger sitting beside two that no longer have one. A reader would learn one rule and two
exceptions.

**Bind on `RESEND_API_KEY` being present.** No new variable, and it is safe by absence for
free, since no environment holds a key. Rejected because it makes a credential the switch:
an operator who exports a key to run one script turns on live sending everywhere in that
shell, and an operator who wants sending off in an environment that has a key has to delete
the credential to do it. Presence-of-secret is also unassertable at boot in the useful
direction, since there is no way to say "this deployment should be sending and is not".

**Boot fails when `MAIL_TRANSPORT` is unset.** The strictest option, and it catches the real
failure this design accepts: a deployment that should send mail and silently does not.
Rejected because it puts a mandatory variable in front of `docker compose up`, `pnpm test`
and CI, none of which send mail, and because a variable that every environment must set to a
value that does nothing gets set by copy-paste and stops being read.

**Bind `ConsoleMailSender` on absence.** Tempting: a developer gets the invitation URL in
the log and the flow is usable locally. Rejected because stdout is a log destination in every
deployment that has one, so a real deployment that forgot the variable would print raw
single-use invitation tokens into its platform log store. F-300 already records the token's
uncontrolled channels; this would add one and make it the default. `console` stays available
and stays opt-in.

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
- **No environment can send mail by inheriting a build flag.** Added 2026-08-12 (F-386).
  Reaching Resend now takes two deliberate declarations, `MAIL_TRANSPORT=resend` and a
  credential, and boot refuses if only one of them is there. The compose stack, CI, a bare
  `docker run` and `pnpm dev` all resolve to `NoopMailSender` without anyone editing them.
- **The two test guards cover runners that are not vitest.** Both keyed on `NODE_ENV`, which
  vitest sets and a `tsx` script, a child-process harness with an explicit `env` block, or a
  CI shell does not. Both now key on `MAIL_TRANSPORT`, and a harness that declares nothing
  lands on the sender that cannot reach a network.
- **GC-3 holds by construction.** A live sender bound in every developer's stack is a cost
  line on the Resend account and a 100-a-day cap shared with real users. The fix removes it
  without anyone remembering to.

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
- **A deployment that should send mail and forgot to say so accepts invitations that never
  arrive.** Added 2026-08-12 (F-386), and it is what this repair costs. Under the old table,
  shipping the production image was enough to get real sending; under this one, an operator
  who forgets `MAIL_TRANSPORT` gets a running process, a working invitation endpoint, HTTP
  200 on every invite, and silence. Nothing local can tell a process with no transport that
  it was meant to have one. The mitigations are a warn line at boot naming
  `boot_precondition: 'mail_transport'` and a warn line per suppressed message, and both are
  logs that somebody has to read. This trade is deliberate: a stranger receiving mail from a
  laptop is unrecoverable, and an invitation that did not arrive gets re-sent.
- **A fifth API-side environment variable**, joining `CLIENT_TRUST_BOUNDARY`,
  `BFF_TRUST_BOUNDARY`, `TRUSTED_CLIENT_IP_HEADER` and `BFF_PROXY_SECRET`. Three of the five
  now exist to say what the other two are for. `apps/api/.env.example` is still unwritten and
  has five to document.
- **The fake sender is no longer free.** Any suite asserting AC-16's or AC-32's exactly-one
  message sets `MAIL_TRANSPORT=fake`, where it used to inherit `NODE_ENV=test` from the
  runner. A suite that forgets fails to compile against `FakeMailSender`, which is the safe
  direction, and it is still one more thing a test author has to know.
- **`MAIL_FROM` is now required under `resend`**, with no default in the adapter. An operator
  standing up real sending sets two variables rather than one, and `onboarding@resend.dev`
  has to be typed rather than assumed.
- **The counter is a name with no backend.** `mail_suppressed_total` joins
  `trusted_client_ip_unresolved_total` and `bff_proxy_auth_mismatch_total` in waiting for a
  metrics client that nothing in `apps/api/src` imports. Until one lands, the warn lines are
  the entire signal.

### Follow-ups this creates

- ~~TASK-010 owns~~ **Shipped 2026-08-18 by TASK-1b-02 (item 1b), TASK-010 having never
  landed:** `MailSender`, `OutboundMail`, all **four** implementations (`NoopMailSender` added
  by F-386), `assertMailTransportConfigured`, `resolveMailTransport`, the two test guards,
  the `template` entry in `LOGGABLE_FIELDS` — **landed**, in `logger.ts` and the
  `logging-and-headers.md` fence together — the invitation template, and a minimal
  verification template with no caller. The adapter is `fetch`, not the SDK; no dependency
  was added. The shipped shapes that go beyond the contract's block (the error class, the
  console block's exact bytes, the optional constructor options) are recorded as dated notes
  in `docs/contracts/mail-sender.md`.
- TASK-1b-08 dispatches from `afterCommit` (was TASK-021).
- Bounce handling, a resend action, and a real `From` domain belong to a later
  initiative.
- **The compose stack may declare `MAIL_TRANSPORT=console`** once an invitation surface
  exists there, so a developer can read the invite URL out of the log. It is a usability
  change, not a safety one: absence already resolves to `NoopMailSender`. Whoever owns
  `docker-compose.yml` and ADR-0035 makes that call. F-386's pass did not touch either file.
  **Ruled 2026-08-18 (D-02, Juano): it does.** TASK-1b-11 sets it; unset stays `none`.
  **Done 2026-08-18:** `docker-compose.yml` carries `MAIL_TRANSPORT: ${MAIL_TRANSPORT:-console}`
  with the comment, ADR-0035 carries the dated note, and `check-compose-stack.sh` reads the
  invite link out of `docker compose logs api` in four clauses.
- ~~The design stub `design/stubs/apps/api/src/mail/mail-sender.ts` still carries the struck
  `NODE_ENV` binding~~ **Struck 2026-08-18 (TASK-1b-02):** `design/stubs/**` no longer exists
  in the repository, so there is nothing to retire and F-401 is discharged by absence.
  `mail-sender.md`'s "Normative form" now names the shipped files.
- Contract: `docs/contracts/mail-sender.md`.
