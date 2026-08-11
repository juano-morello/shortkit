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

`assertTrustedClientIpHeaderConfigured()` fails boot in production when the variable is
unset, empty, not a valid lowercase header name, or names a hop-by-hop forwarding header.
It mirrors `assertBffProxySecretConfigured()` and it applies the same criterion F-033
applied: what is locally checkable is asserted. That a declared header is actually stripped
by the hop in front is not locally checkable, exactly as "the BFF's secret matches" is not.

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
`design/contracts/trusted-client-address.md`. This ADR is the decision. `rate-limit.md` and
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
  off in exactly those environments. The boot assertion makes the state impossible in
  production, and there is no production. `authBodyCap` at 32 KiB and the email-keyed bucket
  are unaffected and still bind, so the credential surface is not unprotected, only less
  protected.
- **The boot assertion does not exist and will not for months.** It lands with TASK-009, which
  is deferred with EPIC-002. Until then this whole decision is a document, and the mitigation
  it relies on is the part that is not written.
- **`ip_hash` collapses to one value per tenant wherever no header is declared.** Every click
  in such an environment hashes the sentinel, so unique-visitor counts there are meaningless.
  That is strictly better than the current design, where the visitor picks the hash, and it is
  still a real loss of signal in the only environment that runs.
- **A third required environment variable on the API side**, beside `BFF_PROXY_SECRET` and
  `CLICK_IP_HASH_KEY`. Each one is a thing an operator gets wrong at three in the morning, and
  `apps/api/.env.example` still does not exist to document any of them.
- **The declaration is weaker than the property it stands for.** An operator can declare a
  header their infrastructure does not strip, boot cleanly, and be exactly as exposed as
  today. Nothing local can tell the difference. This is the same residual as
  `BFF_PROXY_SECRET`'s "set, not matches", and naming it twice is cheaper than discovering it
  twice.

### Follow-ups this creates

- TASK-009 writes `assertTrustedClientIpHeaderConfigured` and calls it in `main.ts` beside
  `assertBffProxySecretConfigured`.
- The shared source `apps/api/src/common/net/trusted-client-address.ts` has no design stub.
  Its full source is fenced in the contract instead. Whichever of TASK-009 and TASK-033 lands
  first materialises it, and the other imports it, which puts a cross-EPIC import edge between
  EPIC-002 and EPIC-003 that nothing enforces today.
- `apps/api/.env.example`, still unwritten under ADR-0030's follow-up, gains the variable.
- Testing the trust model needs a hop that strips the header. The compose stack has none, and
  adding one means a reverse proxy in front of `api` that ADR-0035 declined to write for the
  BFF. Recorded, not scheduled.
- ADR-0030's revisit list gains the trusted-header precondition, which is where this started.
