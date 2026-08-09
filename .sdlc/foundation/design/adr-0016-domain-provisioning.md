---
id: ADR-0016
slug: foundation
title: A reconciler on an in-process schedule, driven by a Redis work queue, provisions domains without a human
status: accepted
supersedes: null
date: 2026-08-04
---

## Context

SC-4 requires a domain to go from added-in-the-UI to serving HTTPS with no human
intervention. TASK-042 says provisioning is triggered by the verification transition,
not by a person. Something has to run on a timer, because DNS propagation takes minutes
and certificate issuance takes tens of seconds, and nobody is watching.

GC-7 permits one backend deployable, so a worker service is out. That leaves an
in-process scheduler, an external trigger hitting an endpoint, or a webhook. Fly does
not push certificate events, so a webhook is not available.

The work is inherently cross-tenant: at any moment, domains belonging to several
tenants are mid-provisioning. A naive scheduler queries `domains` across all tenants,
which is a tenant-scoped read outside tenant context and would be a third GC-5
exclusion. SC-1 records exactly two.

TASK-038 fixes the state set. AC-66 requires expected-versus-observed diagnostics per
DNS record, which means our own verification record, not just an inference from Fly.

## Decision

**Two DNS records, both ours to check.**

| # | Type | Name | Value | Purpose |
|---|---|---|---|---|
| 1 | `CNAME` | `<hostname>` | `<fly-app>.fly.dev` | routes traffic; Fly completes HTTP-01 through it |
| 2 | `TXT` | `_shortkit-verify.<hostname>` | `shortkit-domain-verification=<verification_token>` | proves ownership independently of Fly |

Requiring our own TXT is what makes AC-66's "value actually observed" testable against
`FakeDnsResolver`, and what makes AC-68's global hostname uniqueness mean something.

**State machine.**

```
                 create
                   |
                   v
        pending_verification <----------------+
             |          \                     | backoff retry
       both records OK   \ record missing/wrong
             |            \                   |
             v             +--> verification_failed
          verified
             |  automatic, same tick
             v
        provisioning --- Fly cert issued ---> active
             |
             +--- 15 min elapsed or Fly error ---> certificate_failed
                                                        |
                                    POST /retry-certificate
                                                        |
                                                        v
                                                  provisioning
```

`verified` is transient. Nothing waits in it, which is how SC-4's "no manual step"
holds.

**The queue lives in Redis, not in Postgres.** This is the decision that keeps the
exclusion count at two.

```
ZADD  domain:work  <runAfterEpochMs>  "<tenantId>:<domainId>"
```

The reconciler pops due members with `ZRANGEBYSCORE ... LIMIT 0 20` followed by `ZREM`,
then processes each item inside `withTenantTransaction(tenantId, ...)`. Every Postgres
read and write is under RLS. The only cross-tenant thing in the system is a sorted set
of opaque identifier pairs, which is not a table and carries no tenant data.

**Schedule: `@nestjs/schedule`, every 30 seconds, inside the API process.** Backoff
per state, written into the score on re-enqueue: `pending_verification` 30 s,
`verification_failed` 5 min, `provisioning` 15 s, `certificate_failed` never (manual
retry only).

**Enqueue points.** `POST /domains`, `POST /domains/:id/verify`,
`POST /domains/:id/retry-certificate`, and the reconciler itself on every non-terminal
outcome.

**Self-healing on read.** `GET /domains` re-enqueues any of that tenant's domains in a
non-terminal state whose queue entry is missing. That read is tenant-scoped and
ordinary. TASK-044's screen polls while a domain provisions, so a Redis flush costs a
delay rather than a stall, and SC-4's no-human-step claim survives a cache outage
without an operator doing anything but leaving the page open.

**Multi-machine safety.** `ZREM` returning 1 is the claim. Only one machine gets it.

**A domain serves traffic only in `active`, and Shortkit's own hostnames cannot be
claimed.** Added 2026-08-04 (F-003). The redirect path filters on `state = 'active'`,
and `POST /api/domains` rejects a reserved hostname, an IP literal, or anything failing
RFC 1123. Two independent defences: without the state gate, a row in
`pending_verification` for `<fly-app>.fly.dev` would have made every unmatched path on
Shortkit's own host resolve against an attacker's domain row. The state gate also closes
dangling-DNS takeover, because a re-claimed hostname has to re-verify before it serves.

**Uniqueness attaches to verification, not to creation.** Added 2026-08-04 (F-010). A
partial unique index over `verified`, `provisioning` and `active` lets unverified claims
coexist and expire after 7 days, so an attacker cannot permanently squat hostnames they
do not own. First to verify wins, which is what AC-68 actually says.

**The documented provisioning window is 15 minutes,** measured from the `verified`
transition. AC-70 asserts against that number. Exceeding it moves the domain to
`certificate_failed` with the last Fly error verbatim in `last_error`.

**Fly quota errors surface as themselves.** `refinement.md` flags Fly's unpublished
certificate quotas. The Fly API client maps a quota or rate-limit response to
`last_error` beginning `fly_quota:` and keeps the domain in `provisioning` with a 5
minute backoff rather than failing it, because a quota is transient and a wrong DNS
record is not.

**Deletion releases the binding.** `DELETE /domains/:id` calls Fly's certificate
deletion, removes the queue entry, and deletes the row. Fly failing does not block the
row deletion; the orphaned certificate is logged for manual cleanup. AC-73 tests that
the hostname stops resolving to a working redirect, which the row deletion achieves.

## Alternatives considered

| Option | Pros | Cons | Why not |
|---|---|---|---|
| Postgres work table with `SELECT ... FOR UPDATE SKIP LOCKED` | Durable across a Redis outage; transactional with the state change; the standard answer | The claim query reads across tenants, so either the table is exempt from RLS or the reconciler gets a context escape. Either way SC-1 records a third exclusion, and SC-1 is the initiative's headline claim | The durability is worth less than the exclusion costs |
| External cron (GitHub Actions schedule) calling a reconcile endpoint | No in-process scheduler; visible in CI | The endpoint has to authenticate as something with cross-tenant reach, which is the same exclusion wearing a different hat, plus a shared secret and a 5-minute minimum interval | Same cost, more moving parts |
| Fly Machines cron | Platform-native scheduling | A second deployable, which GC-7 forbids | Ruled out by constraint |
| Poll only while a UI client is watching | No background work at all | A domain whose DNS propagates overnight never advances until someone opens the page, which is a manual step by another name | Fails SC-4 |
| Trust Fly's certificate state alone, no TXT record | One record for the operator to create | AC-66 needs an expected-versus-observed diagnostic per record, and Fly's API reports its own view, not the DNS values we asked for. Ownership would also rest on whoever points a CNAME first | Cannot produce the diagnostic the AC requires |

## Consequences

### Positive

- Every Postgres access in provisioning runs under RLS in tenant context, so the
  exclusion count stays at exactly two.
- No new deployable, no new infrastructure, no new bill. Redis is already there.
- The state machine has one transient state and one terminal failure state per failure
  cause, so AC-66 and AC-72 are separately testable, which TASK-038 requires.
- `FakeDnsResolver` plus the TXT record makes verification fully testable with no
  registered domain, so TASK-038, TASK-039, TASK-040 and TASK-041 are not
  apex-blocked.

### Negative / accepted cost

- **The queue is not durable.** A Redis flush drops pending work. Recovery depends on a
  tenant opening `/domains`, so a domain can sit in `pending_verification` indefinitely
  if nobody looks. That is a real gap in SC-4's "no human intervention" claim under a
  specific failure, and it is the price of not taking a third exclusion.
- `@nestjs/schedule` ties background work to the API process lifecycle. A deploy
  interrupts a tick, and a machine under heavy redirect load runs the reconciler on the
  same event loop.
- Two DNS records for the operator to create instead of one. Every additional record is
  a step someone gets wrong, and SC-4's whole point is diagnosing exactly that.
- The 15-minute window is chosen, not measured. If Fly's issuance is routinely slower,
  domains land in `certificate_failed` and a retry succeeds, which teaches operators to
  ignore the failure state.
- Fly certificate deletion failing leaves an orphan on the Fly account that only a log
  line records. Against Fly's unpublished quotas, orphans accumulate toward a limit
  nobody can see.
- Unverified claims coexisting means two tenants can both see a pending claim on the
  same hostname, and the loser learns of the conflict only when their verification
  transition fails. The error names the state, not the winner, so a legitimate owner
  racing a squatter gets a message that reads like their own DNS is wrong.
- The 7-day unverified expiry deletes a claim from a customer who added a domain and
  went on holiday before updating DNS. They re-add it and lose nothing but the row, and
  nothing warns them first.
- The reserved-hostname list is maintained by hand and includes the apex domain, which
  is still unregistered. Whoever registers it has to add it here, and forgetting leaves
  the platform's own hostname claimable until the state gate stops it serving.

### Follow-ups this creates

- TASK-038 adds `state`, `verification_token`, `last_checked_at`, `last_error`, the
  global unique on `hostname`, and `transitionState`.
- TASK-039 owns `requiredDnsRecords`, `verifyDomain`, `FakeDnsResolver`, and resolves
  with DNS-over-HTTPS against two resolvers to reduce single-resolver caching effects.
- TASK-040 owns the enqueue points and the self-heal on `GET /domains`.
- TASK-042 owns the reconciler, the Fly client, the quota mapping, the 15-minute
  window, and `docs/architecture/domain-provisioning.md`.
- Confirm Fly's certificate quota behaviour before TASK-042 dispatches, per the
  refinement's risk entry.
- Contract: `design/contracts/domain-provisioning.md`.
