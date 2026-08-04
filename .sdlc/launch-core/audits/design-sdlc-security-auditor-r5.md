Round 5 re-review complete. Diff read in full; claims checked at source (topology, logging contract, stub normative forms, Vercel header behaviour).

## 1. Prior findings

**F-028 | ADDRESSED.** Constants land in the stub directly beneath `LOCAL_LIMITER_MAX_TENANTS` (`/home/juano/Workspaces/JustJuanoDev/.sdlc/launch-core/design/stubs/apps/api/src/common/rate-limit/rate-limit.types.ts:218`), all three rules stated in both stub and contract.

I checked rule 3 hardest, as asked. It holds, and for a stronger reason than the one written down. The bypass targets `signInPerEmail` (reset a victim's 5-attempt lockout). With rule 3, forcing the victim's entry out requires 10,000 *simultaneously over-limit* entries in that same bucket — 10,000 distinct addresses × 5 attempts = 50,000 sign-ins, each of which must first pass `signInPerIp` at 10 per 5 minutes, so ~5,000 distinct source IPs and on the order of 25 minutes of sustained traffic. The victim's window is 900 seconds. **The attack is strictly slower than simply waiting for the entry to expire**, so it is not merely raised in cost, it is pointless. The forced-eviction fallback therefore does not reopen it either: reaching the all-over-limit state costs more than the window it would reset.

Fail-closed-for-new-principals was the right thing to reject. Failing closed on a bucket keyed by an attacker-chosen principal hands an anonymous attacker a global signup/sign-in lockout for the price of filling one map — strictly worse than the memory bound it would buy.

**F-029 | ADDRESSED.** Both halves. `tenantIdForUser` throws `NoTenantMembershipError` (stub line 55-60), stale atomicity sentences corrected in ADR-0015 and ADR-0013. The added guard step 6 is the right call and is what actually converts 500→401.

Renumbered sequence checked against F-014's concern: step 0 still first and still returns immediately; 1-5 unchanged; new 6 claim shape; 7 `ev`; 8 populate. Contract and stub agree line for line. ADR-0015:122's cross-reference to "`auth-tokens.md` step 6" is correct under the new numbering. One residual off-by-one, harmless, listed as a deferred nit.

**F-030 | ADDRESSED.** The `X-Retry-After` discovery is real and is a better reason than the one I filed. I confirmed nothing else in the design depended on the built-in limiter: no other reference to it exists anywhere in `design/`, and `rate-limit.md` invariant 7's coverage claim rests entirely on our own four buckets plus the guard. The disable is recorded as deliberate in ADR-0013 with the "we are removing a second, weaker protection" framing, which is the right form for overriding a framework security default.

**Self-found BFF defect — the diagnosis is correct and the mechanism is sound in principle.** All three claims check out at source:

- *Topology.* ADR-0016:35 and `contracts/domain-provisioning.md:101` both specify `CNAME <hostname> → <fly-app>.fly.dev`. Custom domains reach Fly directly, so the redirect surface never traverses the BFF. The claim holds.
- *Redirect surface unreachable via the trusted-proxy path.* `click-events.md` is unchanged and its `trustedClientIp()` reads only `fly-client-ip` with a right-anchored XFF fallback. The redirect controller sits outside `/api` and outside the guard. **`ip_hash` is not exposed by this change** — provided the two resolvers stay separate, which is the subject of NEW-1 below.
- *Secret-present-but-wrong.* Contract rule 1 is a positive condition ("only when ... matches"), so wrong-secret falls to rule 2. Correct. **Secret absent on the API side is the case that is not covered** — NEW-3.

**F-009 is not weakened *in principle*.** A configured trusted proxy authenticated by a shared secret is categorically different from a client-supplied header, ignore-don't-reject is the right probing posture, and Vercel overwrites inbound `x-forwarded-for` on non-Enterprise plans, so the upstream source is not attacker-controlled by default. The argument survives. What does not survive is the *propagation* of the fix into the artifacts an implementer builds from.

## 2. New findings

```yaml
verdict: changes-requested
findings:
  - severity: major
    kind: design
    file: .sdlc/launch-core/design/stubs/apps/api/src/common/rate-limit/rate-limit.types.ts
    line: 113
    summary: The BFF client-IP fix exists only in prose. Both normative stub blocks and the /api/auth/* section of the contract still state Fly-Client-IP unconditionally, so the collapsed-bucket outage is still what gets built.
    failure_scenario: >
      rate-limit.md:4 names rate-limit.types.ts as the normative form. That stub says at
      line 113 "The client IP is the platform-trusted value (Fly-Client-IP), NEVER the
      leftmost X-Forwarded-For" directly above authRateLimitKey (TASK-009's function),
      and again at line 243 above RateLimitGuard (TASK-051's). rate-limit.md:130 repeats
      it inside the /api/auth/* section — the one surface that is always behind the BFF.
      Neither stub nor that section mentions X-Shortkit-Client-IP, X-Shortkit-Proxy-Auth
      or BFF_PROXY_SECRET, and no resolver signature or header constant is specified
      anywhere. TASK-009 implements from the stub in wave 2 and keys on Fly-Client-IP;
      every browser-originated sign-in arrives from Vercel's egress; the entire product
      shares 10 sign-ins per 5 minutes and 3 signups per hour. That is the outage this
      round was opened to fix, shipped anyway. The mirror-image risk is equally live:
      an implementer working from the prose builds a shared resolveClientIp() helper and
      the redirect path picks it up, putting an attacker-settable value into ip_hash and
      reopening F-009 on the append-only store.
    required_change: >
      Put the resolution rule in the normative artifact the way F-028's constants were
      put there. Replace both stub comment blocks with the two-step resolution, export
      named constants for the two header names, and specify a single
      resolveRateLimitPrincipal(headers) signature that is the only site performing the
      trusted-proxy decision. State explicitly that click-events.md's trustedClientIp
      is a separate function and must not be merged with it. Correct rate-limit.md:130
      so the /api/auth/* section points at the new section instead of contradicting it.
    category: (a) load-bearing — TASK-009 (wave 2) and TASK-051 (wave 10) both build from this stub.

  - severity: major
    kind: design
    file: .sdlc/launch-core/design/contracts/logging-and-headers.md
    line: 14
    summary: The two new headers carry a raw client IP and a shared secret, and neither is added to the redact list that the same contract declares append-only and mandates be extended in the same commit.
    failure_scenario: >
      REDACT_PATHS enumerates req.headers["fly-client-ip"] and
      req.headers["x-forwarded-for"] precisely because GC-9 forbids "a raw IP address,
      in any field, from any header" in a log line. x-shortkit-client-ip is a raw client
      IP present on every browser-originated API request and is not on the list.
      x-shortkit-proxy-auth carries BFF_PROXY_SECRET verbatim on those same requests and
      is also not on the list; the wildcard '*.secret' matches a property named "secret"
      one level deep and does not reach a header key. The contract's own rule — "A TASK
      introducing a nested secret adds a path in the same commit" — is unassigned here,
      and TASK-003 writes logger.ts in wave 1, before TASK-009 introduces the headers,
      so nobody is holding the pen. Consequence: on any request-object log line (an
      unhandled exception path is the reliable one — the redact list's existence is the
      design's own admission that headers get serialised), a long-lived shared secret
      lands in the log aggregator, which this design explicitly calls a weaker boundary
      than the database. Anyone with log-read access or a leaked log export then forges
      X-Shortkit-Client-IP against Fly directly and defeats every IP-keyed auth bucket:
      unlimited credential stuffing against signInPerIp and unlimited signups, which
      also exhausts Resend's 100/day tier that ADR-0017 treats as a live constraint.
    required_change: >
      Add req.headers["x-shortkit-client-ip"] and req.headers["x-shortkit-proxy-auth"]
      to REDACT_PATHS in contracts/logging-and-headers.md, ADR-0022's Decision block and
      stubs/.../observability/logger.ts, in this diff, and name the owning TASK. State in
      web-api-client.md that BFF_PROXY_SECRET is never logged on the Vercel side either.
    category: (a) load-bearing — TASK-003 is wave 1 and ships the list eight waves before the headers exist.

  - severity: major
    kind: design
    file: .sdlc/launch-core/design/contracts/rate-limit.md
    line: 95
    summary: An unset BFF_PROXY_SECRET on the API side is an unspecified state that a naive constant-time comparison resolves as a match, and the mechanism has no failure signal and no validation of the forwarded value.
    failure_scenario: >
      Three gaps in one rule. (1) The design deliberately chose not to fail at boot, so
      "BFF_PROXY_SECRET unset on Fly" is a reachable production state, and no artifact
      says what the resolver does in it. The obvious implementation compares the header
      against process.env.BFF_PROXY_SECRET; for a request arriving directly at Fly with
      no auth header, that is undefined vs undefined, or '' vs '' after a normalising
      guard — a match. An anonymous attacker then sends X-Shortkit-Client-IP: <random>
      with no secret at all and has it trusted, minting a fresh bucket per request and
      voiding every IP-keyed auth limit. (2) There is no signal. Every other degradation
      in this design increments something — rate_limit_degraded_total,
      auth_revocation_degraded_total, local_rate_limit_forced_eviction_total — while
      this one is specified to degrade with nothing at all. (3) The forwarded value is
      never validated as an IP address, so on the trusted path it flows unbounded into a
      Redis key segment and into a LocalAuthRateLimiter map key. Node accepts headers up
      to 16 KiB, so the "roughly 6 MB at worst" memory estimate for 10,000 entries is
      wrong by a factor of a hundred if the value is ever attacker-shaped, which gap (1)
      makes reachable.
    required_change: >
      State that an unset or empty BFF_PROXY_SECRET disables the trusted-proxy branch
      unconditionally, and that an absent or empty X-Shortkit-Proxy-Auth never matches —
      the comparison is never reached, not merely never equal. Require the forwarded
      value to parse as an IPv4 or IPv6 address before use, falling back to Fly-Client-IP
      otherwise. Add bff_proxy_auth_mismatch_total incremented whenever the header is
      present and the secret does not match, plus a once-per-minute warn, so the
      collapsed-bucket state is observable.
    category: (a) load-bearing — this is the contract text TASK-009 and TASK-051 implement, and gap (1) is an unauthenticated bypass.

  - severity: major
    kind: design
    file: .sdlc/launch-core/design/adr-0012-redis-client-and-rate-limit-degradation.md
    line: 110
    summary: The new ADR-0012 consequence states the guard's local limiter now holds IP keys alongside tenant keys, which contradicts the stub's check(tenantId) signature and LOCAL_LIMITER_MAX_TENANTS, and that map got none of the three rules F-028 just added to its sibling.
    failure_scenario: >
      TASK-051 is handed two incompatible specs for the same object: rate-limit.types.ts
      line 183-187 types LocalRateLimiter as check(tenantId: string) capped by
      LOCAL_LIMITER_MAX_TENANTS, while ADR-0012:110 says that same map holds @Public()
      IP keys. Taking ADR-0012 as true, the map has no rule-3 skip and no sweep. During a
      Redis outage an authenticated attacker churns 10,000 distinct IPs across @Public()
      routes — each new IP gets a fresh 30/60s allowance, so this costs ~10,000 requests
      — evicting their own tenant's write bucket and resetting the 120-writes/60s window
      at will. The limit exists to protect the connection pool the redirect path shares,
      during exactly the window when the redirect path is already on its Postgres
      fallback under GC-1 and GC-8. That is the same argument that made F-028 major,
      applied to the map that did not get fixed.
    required_change: >
      Pick one. Either separate the key spaces — one map for tenant principals, one for
      IP principals, each capped, and update the stub's signature and the constant name
      — or apply the same three rules to the shared map and say so in the stub. Either
      way the stub and ADR-0012 must stop describing different objects.
    category: (a) load-bearing — the stub signature and the ADR disagree, so TASK-051 has no single spec. The severity of the accepted cost is contestable; the spec conflict is not.

  - severity: minor
    kind: design
    file: .sdlc/launch-core/design/contracts/web-api-client.md
    line: 83
    summary: The Vercel-side source of the browser address is described as "Vercel's own headers" without naming one, moving F-009's trust decision one hop upstream and leaving it unspecified.
    failure_scenario: >
      Verified: Vercel overwrites inbound x-forwarded-for to prevent spoofing on
      non-Enterprise plans, so the default is safe and this is hardening rather than a
      live hole. But the contract does not name the header, and the naive reading —
      req.headers.get('x-forwarded-for').split(',')[0] — is the exact construct F-009
      exists to forbid. If the deployment ever moves behind Cloudflare, another proxy, or
      a Vercel trusted-proxy configuration, the leftmost entry becomes attacker-chosen,
      the BFF signs it with the shared secret, and the API trusts it: every IP-keyed auth
      limit voided by a header the attacker sets in their own browser.
    required_change: >
      Name the header the BFF reads and state that only the platform-set value is used,
      never a leftmost entry from a multi-valued list, with a one-line note that any
      additional proxy in front of Vercel invalidates the assumption.
    category: (b) real but self-contained — an implementer warned about it handles it in one line.
```

## 3. Deferred, explicitly not blocking

- **`auth-tokens.md:53` and `auth-claims.ts:73` both still say "steps 1 through 7 do not run"** — there are now eight. Harmless: both sentences separately and explicitly say `RequestContext` is not populated, so the semantics are unambiguous and the F-014 failure mode (semantic reversal) does not recur. Worth a one-character fix whenever those files are next touched. Nit.
- **`rate-limit.md` never mentions `rateLimit: { enabled: false }`.** The disable lives only in ADR-0013 prose, while TASK-009's normative artifacts (this contract and the stub) are silent, and invariant 3's claim to enumerate every 429 source depends on it. One cross-reference line.
- **The BFF is not told to strip inbound `x-shortkit-*`.** Low risk: the forwarded-header allowlist is explicit and the BFF sets both unconditionally, so even a sloppy copy-then-overwrite implementation is safe. Worth one sentence for the same reason the allowlist itself is written down.
- **Nothing registers `BFF_PROXY_SECRET` as required configuration.** There is no env-var registry contract in this design; the variable appears only in prose in three places. Related to NEW-3 but separable.
- **Version-drift residual on the `rateLimit` default** — see below.

## 4. The two judgement calls

**Silent degradation vs fail-to-boot.** Neither, as specified. Fail-to-boot is the wrong posture here for a concrete reason: the same Fly process serves `/api` *and* the redirect path, so a typo in a rate-limiter secret would take down the surface with the strictest availability constraint in the whole design (GC-8, AC-86, "returns 302 at any rate"). Trading a full redirect outage against a degraded limiter is a bad trade, and the architect's instinct not to fail closed is right.

But what is written is not "degrade" — it is "degrade *invisibly*", and that is the part that does not hold up. Every other degradation in this design is instrumented; this one alone has no counter, no log, and no way to distinguish "working" from "collapsed into one global bucket" short of a user complaining that signup is broken. The right posture is fail-open-with-signal: boot, disable the trusted-proxy branch, increment `bff_proxy_auth_mismatch_total`, warn once a minute — plus a boot-time assertion in production that the variable is merely *set*. That last one catches the most common misconfiguration (forgot to add it to the Fly side) without coupling boot to the other deployable, because "set" is a local check while "matches" cannot be verified without a live round-trip. That is NEW-3's required change and it costs a paragraph.

**Unpinned Better Auth.** Three of the four verified facts degrade loudly, and the architect already built the mitigations:

- `createAuthMiddleware` / `hooks.before` signature — a change is a TypeScript compile error. Loud.
- `ctx.body.email` — undefined gives a 500 on every sign-in. Loud, and stated as such.
- `ctx.path` value — silent, and this is exactly why F-025 mandates an integration test pinning predicate, key and 429 together. Test-pinned, so it degrades to a red CI job.

The fourth does not. `rateLimit: { enabled: false }` is verified against nothing. If the option is renamed, the config object is typed, so TS catches it — but if the *default* or the *production-only* behaviour shifts, the disable silently stops applying, and it stops applying only in production, which is precisely F-030's original failure mode returning. The cheap fix is version-independent and worth carrying into Implement rather than blocking Design: a unit test asserting the composed `betterAuth` config has `rateLimit.enabled === false`, owned by TASK-009 alongside its three integration tests. I would attach that to TASK-001's pinning note rather than reopen ADR-0013.

## 5. Could not do

- **Could not verify Better Auth behaviour against a pinned version.** Nothing is installed and ADR-0018 pins no number yet. My assessment above is about how the design degrades if the facts shift, not a confirmation that they hold.
- **Could not confirm whether the request logger serialises headers.** ADR-0022 says the request logger emits method, path, status and duration, which suggests a narrow serialiser; the existence of `req.headers.*` redact paths suggests otherwise. NEW-2's exploit is conditional on that, and I have flagged it as conditional rather than asserted. The GC-9 rule violation ("a raw IP address, in any field, from any header") is unconditional either way.
- **Did not update `findings.yaml`.** F-028/F-029/F-030 remain at `status: routed`; the five new findings are unnumbered — the orchestrator assigns.

**Verdict: `changes-requested`.**

Sources: [Vercel request headers](https://vercel.com/docs/headers/request-headers), [vercel/community discussion 2484](https://github.com/vercel/community/discussions/2484)