---
id: ADR-0040
slug: foundation
title: The trusted client address is a declared property of the deployment, and it may be absent
status: accepted
supersedes: null
date: 2026-08-11
accepted_at: 2026-08-11
---

## Context

F-009 is discharged for two surfaces by one premise: `Fly-Client-IP` is set by the platform
and a client cannot spoof it. `click-events.md` states that premise in a sentence and derives
`ip_hash` from it. `rate-limit.md`'s `resolveRateLimitPrincipal` states it as "otherwise
return `Fly-Client-IP`" and derives every IP-keyed rate-limit bucket from it.

ADR-0030 removed the platform. There is no deploy target, no proxy in front of the API, and
nothing that strips `Fly-Client-IP` from an inbound request. A trusted-header model is worth
exactly as much as the hop that strips the header, and that hop no longer exists.

The only environment where the API runs today makes this concrete. The compose stack
publishes `127.0.0.1:3001:3001` (ADR-0031), the BFF proxy route is not written and
`BFF_PROXY_SECRET` is not set (ADR-0035), so nothing sits between a caller and the API. A
`curl -H 'Fly-Client-IP: 198.51.100.9'` against that port picks its own rate-limit principal
and, once the redirect path emits, its own `ip_hash`. **The compose stack's fallback is
already fully client-controlled, so it is not a place to test the trust model.** Both
resolvers would report exactly the behaviour their contracts forbid, and they would report it
in the only environment anyone can run.

Nothing is exploitable today. `resolveRateLimitPrincipal` exists in no shipped code, verified
by `git grep` across `apps/` and `packages/`, and `trustedClientIp` is a stub. TASK-009,
TASK-033 and TASK-051 are all deferred. This is a decision about frozen boundaries three
deferred TASKs will build against, not a live defect.

F-033 already ruled the neighbouring question. When the BFF's shared secret fails to match,
the API fails open with signal rather than failing to boot, because the same process serves
the redirect path and GC-8 forbids a 5xx there. That ruling stands and this decision does not
reopen it.

## Alternatives

### 1. Repoint every read at whatever header the next platform sets

Replace `fly-client-ip` with the header of the platform chosen later, in the two resolvers,
the two contracts and the four ADRs that name it.

- **Pros.** The smallest possible diff. One constant moves. No signature changes, so no TASK's
  expectations move, no new environment variable, and no consumer learns anything. It is also
  what the repository has done every previous time a platform assumption moved.
- **Cons.** It preserves the shape of the defect. A hardcoded header name is trusted because a
  platform that used to exist used to set it, and nothing in the process can distinguish "the
  platform set this" from "the caller sent this". The premise stays unfalsifiable at boot and
  unfalsifiable at request time. ADR-0030 states plainly that a platform will be chosen later,
  so this is a fix with a scheduled expiry, and the next round pays for it again.
- **Why it lost.** The shape is the problem. Renaming the header preserves it.

### 2. Fail to boot whenever no trusted address can be established

Extend the boot assertion to every environment: no declared trusted header, no process.

- **Pros.** The strongest guarantee available. No environment can run with a client-controlled
  principal, and there is no request-time state to reason about because the state cannot
  exist.
- **Cons.** It relitigates F-033 for a reason F-033 already rejected. The same process serves
  the redirect path, which carries the strictest availability constraint in the design (GC-8,
  AC-86), and a rate-limiter configuration must not be able to take it down. It also breaks
  `docker compose up` and the integration suite until every one of them declares a header,
  which is work bought with no safety in environments that have no attacker.
- **Why it lost.** In production it buys nothing the boot assertion does not already buy, and
  outside production it trades availability for a guarantee nobody needs there.

### 3. Fall back to the TCP peer address, `req.socket.remoteAddress`

When no trusted header resolves, key on the connecting peer.

- **Pros.** Not client-supplied, which is the actual property under threat. In the compose
  stack it is the correct value, and it would make the IP buckets work locally and in CI with
  no configuration at all. This is the strongest of the three and it is written second-longest
  for that reason.
- **Cons.** Behind any proxy the peer is the proxy, which is precisely the collapsed-bucket
  outage the F-031 section exists to prevent: 3 signups per hour across the whole product. The
  failure is silent, because a proxy address is a valid IP that passes every check the design
  can make. It converts a detectable no-principal state into an undetectable wrong-principal
  state, and the design already spent a round learning that the first is cheaper.
- **Why it lost.** A wrong answer that looks right costs more than no answer, and no answer is
  the one this decision can signal.

## Decision

**A deployment declares which header carries the client address. The API asserts at boot that
a declaration exists, reads a client address from that header and from no other, and where no
address is established the result is no principal, never a client-supplied one.**

### The declaration

`TRUSTED_CLIENT_IP_HEADER` names a header whose value the operator's own infrastructure sets
and strips from every inbound request. It has no default. It is worded against the property,
not against a header name, so that a change of platform is a change of configuration rather
than a change of source in seven places.

`assertTrustedClientIpHeaderConfigured()` fails boot when the variable is unset, empty, not a
valid lowercase header name, or names a hop-by-hop forwarding header. It applies the same
criterion F-033 applied: what is locally checkable is asserted. That a declared header is
actually stripped by the hop in front is not locally checkable, exactly as "the BFF's secret
matches" is not.

### The trigger is the declared trust boundary, not `NODE_ENV`

Amended 2026-08-11 (F-380). **The first version of this decision gated the assertion on
`NODE_ENV === 'production'` and justified it with "there is no production".
`Dockerfile:83` is `ENV NODE_ENV=production`**, in the image `docker compose` runs, so the
justification was false against an artifact shipped the same day and the gate would have
refused to boot `api` on a developer's laptop the moment TASK-009 landed.

This is this ADR's own argument one level up. The precondition is worded against the property
rather than against a header name because a hardcoded name preserves the defect's shape.
`NODE_ENV` is a build flag standing in for "is this a real deployment", and the compose
stack, a local stack legitimately running the production image, is the case that proves the
stand-in wrong.

```
CLIENT_TRUST_BOUNDARY = proxy | direct        # unset is read as direct
```

| Value | Meaning | `TRUSTED_CLIENT_IP_HEADER` |
|---|---|---|
| `proxy` | a hop in front terminates client connections and sets and strips the declared header | **required**, and boot fails without it |
| `direct` | clients reach this process directly, and no header is trusted | ignored for the assertion |
| unset | read as `direct`. This is the default and it asserts nothing | not required |
| anything else | **boot fails, in every environment.** A typo must not silently mean `direct` |

Two checks, and only one of them is conditional. **The value's validity is asserted
unconditionally**, so `Proxy`, `true` and `prod` are caught in tests, in CI and in compose
rather than only where someone remembered to look. **The header requirement is conditional on
the declared boundary**, so a stack that declares nothing asserts nothing.

A local compose stack declares nothing, so no assertion fires, no principal is established,
and requests fail open with signal. That is the behaviour this ADR already ruled, now reached
without a build flag standing in for a trust boundary.

The **read** is untouched by this amendment. `readTrustedClientAddress`'s four rules depend
on `TRUSTED_CLIENT_IP_HEADER` and on nothing else, so `CLIENT_TRUST_BOUNDARY` governs whether
forgetting the header is an error and never governs what is read. The integration suite may
therefore declare the header alone, and declares both so its intent is on the record.

The exact error strings, including the new one for an invalid boundary value, are in
`trusted-client-address.md`. They are stated there once and this ADR does not repeat them.

### The sibling assertion declares its own boundary

Added 2026-08-11 (F-385). The follow-up below named `assertBffProxySecretConfigured` as carrying
the same trigger independently and left it there. It is not merely the same shape. It is the
same live break in the same stack: `rate-limit.md` and the design stub both specified "throws
when `NODE_ENV === 'production'` and `BFF_PROXY_SECRET` is unset or empty", `Dockerfile:83` sets
that `NODE_ENV` in the image `docker compose` runs, and the compose `api` service's environment
block carries `DATABASE_URL` and nothing else (`docker-compose.yml:227`, ADR-0035). Repairing
this ADR alone left `docker compose up` refusing to boot `api` from the day TASK-009 landed.

It gets the same treatment, and the reason that decided it is worth stating: **one reader should
learn one rule rather than two exceptions.** The rule is that a boot assertion keys on a declared
property of the deployment and never on a build flag.

Two smaller routes to a booting stack were considered. Both lost.

**Give the compose stack a fixture `BFF_PROXY_SECRET`.**

- **Pros.** The smallest change available. No new variable, no contract amendment, and it works
  today. The compose file already carries fixture credentials with comments saying they are
  fixtures, so the pattern is established and a reader would not be surprised.
- **Cons.** It leaves the `NODE_ENV` trigger in place on an assertion sitting beside one that no
  longer has it, so F-380's argument applies to one and not the other and the next reader has to
  learn which is which. It also repairs one environment: a second local stack, a CI job, or a
  developer running the image directly still meets the refusal, and each gets its own fixture.
- **Why it lost.** It buys the boot back by giving up the rule.

**Gate it on `CLIENT_TRUST_BOUNDARY=proxy`**, which the follow-up below suggested, on the grounds
that `proxy` is precisely the condition under which a BFF secret is required.

- **Pros.** No fourth environment variable on the API side. One declaration covers both
  assertions, so a reader learns one name, and a deployment says its topology once. It is the
  smaller design and it was this ADR's own recommendation.
- **Cons.** `proxy` is not that fact. `CLIENT_TRUST_BOUNDARY` declares that a hop in front
  terminates client connections and strips a header; the BFF secret declares that our own
  frontend forwards an address it authenticates. The two vary independently, and the case that
  breaks the collapse is not hypothetical. An API reachable at its own origin with Vercel
  proxying browser traffic to it is `direct` for the header question and BFF-fronted for the
  secret question, and it is the deployment where the secret is the **only** source of a
  rate-limit principal. Gating on `proxy` falls silent exactly there. The converse misfires too:
  an API behind a CDN serving redirects with no web app deployed would be refused boot until its
  operator invented a secret nothing reads, which teaches "set the variable to silence the
  error" — the fixture alternative, reached by a longer road.
- **Why it lost.** It makes one variable stand for two facts, which is the substitution
  `NODE_ENV` was already making.

So, a sibling declaration with the same shape:

```
BFF_TRUST_BOUNDARY = bff | direct        # unset is read as direct
```

`bff` requires `BFF_PROXY_SECRET` set and non-empty. `direct`, and unset, require nothing. Any
other value fails boot in every environment, for the reason its sibling does: `direct` is the
permissive branch and a typo must not reach it silently. The extra signal available here — a
mis-set boundary in a real BFF deployment also shows up on `bff_proxy_auth_mismatch_total` —
makes the unconditional check buy slightly less than it does next door. It stays anyway. It
costs one comparison, and a counter nobody is watching yet is not a substitute for a refusal.

The two variables share their shape deliberately: a named hop or `direct`, unset means `direct`,
an unrecognised value is fatal everywhere. The rule is learned once and applied twice.

The **read** is untouched. F-033's four rules depend on `BFF_PROXY_SECRET` and the two headers
and on nothing else, and rule 1 already disables the branch unconditionally when the secret is
unset. `BFF_TRUST_BOUNDARY` governs whether forgetting the secret is an error and never governs
what is trusted. Blast radius is the assertion.

The exact strings, including the two new ones, are in `rate-limit.md`, which is normative for
this assertion. They are stated there once and this ADR does not repeat them.

### The read

`readTrustedClientAddress(headers, env)` returns a string that `net.isIP` accepts, or `null`.
It never throws, and it never reads `X-Forwarded-For` or `Forwarded` in any position. The
leftmost-entry ban therefore becomes an every-position ban, and `TRUSTED_PROXY_HOPS`, whose
only correct value was ever `0`, is deleted.

The two trust domains keep their two resolvers and are still never merged.
`resolveRateLimitPrincipal` tries the BFF branch first under F-033's four unchanged rules,
then the declared header, then returns `null`. `trustedClientIp` tries the declared header
only, never the BFF branch, and substitutes `UNKNOWN_IP_SENTINEL` for `null` so a click row
still exists.

### At request time

Fail-open with signal, as F-033 ruled for the neighbouring case. An IP-keyed bucket that gets
no principal does not run, and the request proceeds. `trusted_client_ip_unresolved_total`
counts every such request. The warn fires once per minute and only when a header was declared
and the read still failed, because an environment that declares nothing is in a stated
condition rather than a broken one.

The normative mechanism, including the exact error strings and the shared source, is
`docs/contracts/trusted-client-address.md`. This ADR is the decision. `rate-limit.md` and
`click-events.md` keep their own function's specifics and point there for the trust rule.

## Consequences

### Positive

- The premise is checkable. "Is a trusted client address established" now has an answer at
  boot and a different answer per request, and both are recorded rather than assumed.
- Changing platform is a configuration change. The next deploy target sets one variable, and
  no source file, contract or ADR names its header.
- One ban replaces two rules. No resolver reads a forwarding header at any position, so the
  leftmost-entry rule, the rightmost-entry fallback and the hop count all collapse into a
  single sentence.
- The integration suite can exercise the IP buckets. It declares its own header name, which
  the hardcoded platform name made impossible without a test pretending to be Fly. F-025's
  six-different-IPs test now isolates the email bucket for the reason it claims to.
- Choosing a deploy target acquires a named precondition instead of an inherited assumption.
  ADR-0030's list carries it.
- **The gate no longer depends on a build flag.** Added 2026-08-11 (F-380). `NODE_ENV` is set
  by the `Dockerfile`, by test runners and by framework defaults, none of which knows anything
  about who terminates client connections. Keying on the trust boundary means the same image
  runs unchanged on a laptop and behind a proxy, and the difference is one declared variable
  rather than a flag that also switches logging, error output and dependency resolution.
- **A malformed boundary value fails everywhere, not only in production.** The one check that
  can be made unconditional was made unconditional, so a typo surfaces in the environment that
  runs it rather than in the one nobody runs yet.
- **Both boot assertions key on declared topology and neither reads `NODE_ENV`.** Added
  2026-08-11 (F-385). `docker compose up` boots `api` with none of the four variables set,
  which is the state the compose stack documents and the state it was in before either
  assertion was specified. The next boot precondition anyone adds has a pattern to copy that
  does not carry the trap.
- **The two facts are separately declarable.** A deployment can say it is BFF-fronted without
  claiming a stripping hop it does not have, and still get the secret assertion it needs.

### The cost accepted

- **An approved contract is amended, not extended.** `rate-limit.md`'s "Which address the
  client IP means" was accepted with `resolveRateLimitPrincipal(headers): string` and a
  fallback branch that always produced a value. The signature is now
  `string | null` and the fallback branch is gone. Anything written against the old shape
  compiles differently.
- **Three deferred TASKs have their expectations moved.** TASK-009 gains a second boot
  assertion, a null-principal branch in three Express buckets and a declared header in its
  integration suite. TASK-051 gains a null-principal branch in `RateLimitGuard` and loses the
  guarantee that `checkPublicIp` always has a key. TASK-033 loses `TRUSTED_PROXY_HOPS` and the
  XFF fallback and gains the sentinel on a wider set of inputs. Each is priced in the report
  at `.sdlc/foundation/work/F-320-F-300-rulings.md` and in the TASK constraints there.
- **No IP-keyed limit applies in any environment that exists today.** Compose, CI and local
  dev all run without a declared header, so the three Express auth buckets and the `@Public()`
  bucket do not bind there. F-018's connection-pool protection for the invitation routes is
  off in exactly those environments. ~~The boot assertion makes the state impossible in
  production, and there is no production.~~ **Struck 2026-08-11 (F-380).** Both halves were
  wrong. `Dockerfile:83` is `ENV NODE_ENV=production`, in the image `docker compose` runs, so
  a production `NODE_ENV` exists on a developer's laptop and the gate would have refused to
  boot `api` there the day TASK-009 landed. The assertion no longer keys on `NODE_ENV` at
  all; it keys on the declared trust boundary, and the state stays possible wherever no
  boundary is declared. `authBodyCap` at 32 KiB and the email-keyed bucket
  are unaffected and still bind, so the credential surface is not unprotected, only less
  protected.
- **The boot assertion does not exist and will not for months.** It lands with TASK-009, which
  is deferred with EPIC-002. Until then this whole decision is a document, and the mitigation
  it relies on is the part that is not written.
- **The gate is now opt-in, so a genuinely forgotten configuration boots cleanly.** Added
  2026-08-11 (F-380), and it is what the repair costs. Under the `NODE_ENV` gate an operator
  who deployed the production image and forgot the header got a refusal. Under this one, an
  operator who forgets **both** variables gets a running process with no IP-keyed limit and no
  boot-time complaint, because nothing local can tell a bare process that it was supposed to
  be behind a proxy. The state is observable rather than silent:
  `trusted_client_ip_unresolved_total` is nonzero from the first request, and that counter is
  now load-bearing rather than decorative. It is a weaker signal than a refusal and it is the
  honest price of not letting a build flag decide a trust question.
- **A second environment variable to get right**, and the two can disagree.
  `CLIENT_TRUST_BOUNDARY=proxy` with a header naming something the hop does not set produces
  a process that boots, asserts clean, and trusts nothing, which reads at a glance like a
  working trusted-proxy deployment.
- **`ip_hash` collapses to one value per tenant wherever no header is declared.** Every click
  in such an environment hashes the sentinel, so unique-visitor counts there are meaningless.
  That is strictly better than the current design, where the visitor picks the hash, and it is
  still a real loss of signal in the only environment that runs.
- **A third required environment variable on the API side**, beside `BFF_PROXY_SECRET` and
  `CLICK_IP_HASH_KEY`. Each one is a thing an operator gets wrong at three in the morning, and
  `apps/api/.env.example` still does not exist to document any of them.
- **A fourth, and two of the four exist only to say what the other two are for.** Added
  2026-08-11 (F-385). `BFF_TRUST_BOUNDARY` joins `CLIENT_TRUST_BOUNDARY` as a declaration that
  carries no value of its own; it exists so a boot check can fire. That is the price of not
  letting one variable stand for two facts. `apps/api/.env.example`, still unwritten, has to
  carry all four with the distinction spelled out, or an operator sets one boundary and assumes
  the other followed.
- **The BFF secret assertion is opt-in too, so the collapsed-bucket outage boots cleanly.**
  Added 2026-08-11 (F-385). An operator who deploys the BFF and forgets both
  `BFF_TRUST_BOUNDARY` and the secret gets a running process in which every browser request
  falls through to the declared header, which under ADR-0014 is one address for the entire
  product: 3 signups per hour and 10 sign-ins per 5 minutes, product-wide. That is the F-031
  outage reached by configuration instead of by design. It is loud in metrics and silent at
  boot, because the BFF still sends `X-Shortkit-Proxy-Auth` and F-033 rule 1 counts every one on
  `bff_proxy_auth_mismatch_total`. Same trade as the sibling's, and it is worse here: what the
  refusal would have caught is a product outage rather than an absent limit.
- **The declaration is weaker than the property it stands for.** An operator can declare a
  header their infrastructure does not strip, boot cleanly, and be exactly as exposed as
  today. Nothing local can tell the difference. This is the same residual as
  `BFF_PROXY_SECRET`'s "set, not matches", and naming it twice is cheaper than discovering it
  twice.

### Follow-ups this creates

- TASK-009 writes `assertTrustedClientIpHeaderConfigured` and calls it in `main.ts` beside
  `assertBffProxySecretConfigured`. The call site is unconditional; the gating is inside the
  function.
- ~~**`assertBffProxySecretConfigured` has the same defect, independently, and this ADR does not
  fix it.** Added 2026-08-11 (F-380), named rather than repaired because it is a separate
  finding. Its specification in `rate-limit.md` and in the design stub is "throws when
  `NODE_ENV === 'production'` and `BFF_PROXY_SECRET` is unset or empty". `Dockerfile:83` sets
  that `NODE_ENV`, and ADR-0035 records that the compose stack does not set
  `BFF_PROXY_SECRET`, so the sibling assertion refuses to boot `api` under
  `docker compose up` for exactly the reason this amendment removed from its neighbour.
  **Repairing this ADR alone therefore does not unbreak `docker compose up`.** Whoever owns
  that finding has `CLIENT_TRUST_BOUNDARY` available: `proxy` is precisely the condition under
  which a BFF secret is required.~~ **Done 2026-08-11 (F-385)**, in "The sibling assertion
  declares its own boundary" above. The facts in the struck text hold and were re-verified at
  source. **Its recommendation was rejected**: `CLIENT_TRUST_BOUNDARY=proxy` and "a BFF is in
  front" are two facts about two hops that vary independently, so gating on `proxy` falls
  silent in the deployment where the secret is the only source of a principal. The trigger is
  `BFF_TRUST_BOUNDARY`, normative in `rate-limit.md`. TASK-009 must not ship the `NODE_ENV`
  form of either assertion.
- The shared source `apps/api/src/common/net/trusted-client-address.ts` has no design stub.
  Its full source is fenced in the contract instead. Whichever of TASK-009 and TASK-033 lands
  first materialises it, and the other imports it, which puts a cross-EPIC import edge between
  EPIC-002 and EPIC-003 that nothing enforces today.
- `apps/api/.env.example`, still unwritten under ADR-0030's follow-up, gains
  `TRUSTED_CLIENT_IP_HEADER`, `CLIENT_TRUST_BOUNDARY` and `BFF_TRUST_BOUNDARY`, with the
  difference between the two boundaries written out rather than left to the names.
- Testing the trust model needs a hop that strips the header. The compose stack has none, and
  adding one means a reverse proxy in front of `api` that ADR-0035 declined to write for the
  BFF. Recorded, not scheduled.
- ADR-0030's revisit list gains the trusted-header precondition, which is where this started.
