## 1. Finding verdicts

**F-031 | ADDRESSED**
- `/home/juano/Workspaces/JustJuanoDev/.sdlc/foundation/design/stubs/apps/api/src/auth/resolve-rate-limit-principal.ts` — new file, exports `BFF_CLIENT_IP_HEADER`, `BFF_PROXY_AUTH_HEADER`, `FLY_CLIENT_IP_HEADER`, `resolveRateLimitPrincipal(headers)`, `assertBffProxySecretConfigured(env)`. Header block states "THE ONLY SITE THAT MAKES THE TRUSTED-PROXY DECISION" and "NOT click-events.md's trustedClientIp(). DO NOT MERGE THE TWO."
- `rate-limit.types.ts` — **both** offending blocks replaced. Lines 120–133 (above `authRateLimitKey`) and lines 293–297 (above `RateLimitGuard`). The old sentence "the client IP is the platform-trusted value (Fly-Client-IP), NEVER the leftmost X-Forwarded-For" is gone from both.
- `contracts/rate-limit.md:88` — "Normative form" line extended to name the new stub; lines 93–99 make the resolver the sole decision site; lines 165–170 replace the `/api/auth/*` "the client IP is `Fly-Client-IP`" sentence; line 484–486 adds it as a guarantee.
- ADR-0012 (follow-ups), ADR-0013 (`authRateLimit(authRateLimitPort)` comment), ADR-0014 all reference it.
- Residual: one sibling stub was missed — see NEW-1.

**F-032 | ADDRESSED**
- `contracts/logging-and-headers.md:19-20` — both paths in `REDACT_PATHS`; lines 73–82 give the rationale, name **TASK-003** as owner, state the wave-1-before-wave-9 ordering, and state the Vercel-side non-logging.
- `adr-0022:35` — Decision-block pino config carries both; lines 52–57 explain.
- `stubs/.../observability/logger.ts:31-38` — both paths present with the `'*.secret'`-does-not-reach-a-header-key note.
- `contracts/web-api-client.md:140-145` and `stubs/.../web/src/lib/api/client.ts:143-146` — `BFF_PROXY_SECRET` never logged on the Vercel side.

**F-033 | ADDRESSED**
- Never-reached clauses: `rate-limit.md:101-107` rules 1 and 2, verbatim "the comparison in rule 3 is never *reached*, not merely never equal", with the `undefined === undefined` case named. Mirrored in the resolver stub lines 41–50.
- IP validation: `rate-limit.md:112-115` rule 4 (`net.isIP`), resolver stub lines 53–56, with the 16 KiB-header memory-budget link.
- Counter: `bff_proxy_auth_mismatch_total` + once-per-minute warn in `rate-limit.md:117-129`, resolver stub lines 61–70, ADR-0014:87-88 and :137-139. Constant `BFF_PROXY_MISMATCH_COUNTER` exported at stub line 91.
- Extra: `assertBffProxySecretConfigured()` — production-only, "set" not "matches", with the GC-8/AC-86 reason for not failing boot on mismatch. Correct posture.

**F-034 | ADDRESSED** — separated key spaces, and the stub and ADR-0012 now describe one object.
- `rate-limit.types.ts:230-238` and `rate-limit.md:405-410` carry the identical `LocalRateLimiter` interface: `checkTenant` / `checkPublicIp`, `LOCAL_LIMITER_MAX_TENANTS` and `LOCAL_LIMITER_MAX_PUBLIC_IPS` both `10_000`.
- `adr-0012:59-67` names the stub as normative shape, both constants, and all three F-028 rules on the public map; `adr-0012:120-125` rewrites the consequence bullet; `adr-0012:132-135` gives TASK-051 both maps.
- **No coverage gap from the separation.** The shared map provided nothing the two maps do not. I checked the reverse direction specifically: `checkTenant` drops F-028 rules 2 and 3 (eviction-skip, forced-eviction counter). Reaching them requires 10 000 concurrently-live authenticated tenant ids; tenant creation runs through signup at 3/hour/IP, so the eviction bypass is not reachable, and ADR-0012:120 says so. Rule 1's *sweep* is memory-only on that map; rule 1's *lazy expiry* is inherent to "same limit, same window" and is not at risk. `checkPublicIp` keys are bounded by F-033 rule 4, so the public map's memory bound is now sound (the thing F-033(3) said was wrong by 100×).
- One shared counter across two maps is explicitly accepted at `adr-0012:123-125`. Observability nit, deferred.

**F-035 | ADDRESSED** — and the header choice is correct, verified independently.
- Vercel's own docs, `/docs/headers/request-headers`: `x-forwarded-for` — "If you are trying to use Vercel behind a proxy, we currently overwrite the X-Forwarded-For header and do not forward external IPs. This restriction is in place to prevent IP spoofing." `x-vercel-forwarded-for` — "This header is identical to the `x-forwarded-for` header. However, `x-forwarded-for` could be overwritten if you're using a proxy on top of Vercel." The architect's reasoning matches the documented behaviour exactly. The docs also describe it as *the* public IP, singular — so "read whole" is right, not a list.
- Propagated: `contracts/web-api-client.md:120-138` (normative section, absent-header-omit, the proxy-in-front-of-Vercel invalidation), `stubs/.../web/src/lib/api/client.ts:137-160` + `VERCEL_CLIENT_IP_HEADER`, ADR-0014:103-104, `rate-limit.md:86`, `web-api-client.md:182-186` (guarantee 8).

**On the belt-and-braces holding if the header choice were wrong — it partially holds, and the architect's claim is slightly overstated.** The multi-valued-list ban defends against the *split-leftmost* class of mistake only. If the named header were itself client-settable as a single value, reading it whole is still fully attacker-controlled and the ban buys nothing. What actually carries the weight is the shared secret plus F-033 rule 4 on the API side: an attacker who cannot make *Vercel* emit a chosen value cannot influence the principal at all, because the forwarded header without the secret is ignored. The two realistic wrong-choice outcomes are both bounded: Enterprise trusted-proxy makes `x-forwarded-for` client-influenced while leaving `x-vercel-forwarded-for` as Vercel's own (the choice is strictly *more* robust), and a proxy stacked in front of Vercel degrades the value to that proxy's egress — a bucket-collapse, not a spoof, and the design flags it. Not a finding; stated so the record is accurate.

## 2. Reproduced propagation check

I did not use the architect's grep list. What I ran, over `.sdlc/foundation/` excluding `audits/` and `work/`:

| Change | Grep | Result |
|---|---|---|
| Resolver rule | `Fly-Client-IP\|fly-client-ip\|FLY_CLIENT_IP` | 11 live design hits. All correct: resolver stub (3), `rate-limit.md` (5, all fallback-context), ADR-0014, `web-api-client.md`, `client.ts`, `rate-limit.types.ts` (3, all inside new blocks), plus `click-events.md`/`click-event.types.ts`/ADR-0010/`logger.ts`/`logging-and-headers.md` where it is correct by design. **No surviving unconditional statement.** |
| Resolver rule | `platform-trusted` | 2 hits. `click-events.md:32` correct. **`auth-rate-limit.port.ts:47` is a survivor → NEW-1.** |
| Leftmost XFF | `X-Forwarded-For\|x-forwarded-for` | Every rate-limit-path hit is a prohibition. `click-events.md` retains its right-anchored fallback, which is correct and separate. |
| Redaction | `REDACT_PATHS\|redact` | 3 copies of the list (contract, ADR, stub). All three carry both new paths. No fourth copy exists. |
| F-033 clauses + counter | `bff_proxy_auth_mismatch_total` | 6 hits: `rate-limit.md` ×2, ADR-0014 ×2, resolver stub ×2. Not in ADR-0012 (correct — different degradation). No competing counter name. |
| Separated key spaces | `LocalRateLimiter\|checkTenant\|checkPublicIp\|LOCAL_LIMITER` | 19 hits. `check(tenantId)` survives only on the Redis `RateLimiter` interface, which is tenant-only by design and now says so (`rate-limit.types.ts:189-193`). **`rate-limit.md:223` and `rate-limit.types.ts:245` are survivors → see below.** |
| `x-vercel-forwarded-for` | `x-vercel-forwarded-for\|VERCEL_CLIENT_IP` | 4 hits, all consistent. No other candidate header named anywhere. |
| `rateLimit: { enabled: false }` | `rateLimit\|enabled: false` | 4 sites: ADR-0013:138 + :321, `rate-limit.md:171-175` + invariant 3 at :449, `rate-limit.types.ts:36-42`. Complete. |

**Contradicting statements that survive:**

1. **`design/stubs/apps/api/src/auth/ports/auth-rate-limit.port.ts:47`** — "`principal` is the **platform-trusted client IP** for the IP buckets". This is a normative stub named on `rate-limit.md`'s own "Normative form" line — the line this diff edited to add a third file to. Filed as NEW-1.

2. **`contracts/rate-limit.md:223` and `stubs/.../rate-limit.types.ts:245`** — F-028's rationale still says "the sibling's principals are tenant ids, which only an authenticated caller produces" / "The sibling above is keyed on tenant ids". After F-034 the sibling has two key spaces, one of them unauthenticated IPs. In the stub this sits ~10 lines below the F-034 block that says the opposite. It is a rationale sentence about a *different* class, not a spec for `LocalRateLimiter`, and no implementer builds the wrong object from it — the normative interface is unambiguous in both files. **Contestable, minor. Not filed as a finding; listed as deferred.**

## 3. New findings

```yaml
- id: NEW-1
  severity: major
  kind: design
  classification: (b) real but self-contained
  file: design/stubs/apps/api/src/auth/ports/auth-rate-limit.port.ts
  line: 47
  summary: The auth rate-limit port — named on rate-limit.md's own "Normative form" line — still documents its `principal` parameter as "the platform-trusted client IP", the pre-F-031 wording.
  failure_scenario: >-
    rate-limit.md:88 names three normative stubs. Two were rewritten this round; this one
    was not. The implementer of the three Express IP buckets calls
    AuthRateLimitPort.check(bucket, principal) and reads this doc comment to learn what to
    pass. "Platform-trusted" is the design's own vocabulary for Fly-Client-IP — click-events.md:32
    and adr-0010:59 use it for exactly that, and F-031 quoted this same phrase as the defect.
    Following it behind the BFF passes Vercel's egress address for every user: 3 signups per
    hour and 10 sign-ins per 5 minutes across the entire product, which is the collapsed-bucket
    outage F-031 was filed to prevent. Not a privilege bypass; a product-wide availability
    failure that surfaces only once the BFF and the limiter deploy together.
  required_change: >-
    Replace with the resolver rule: "`principal` is the value returned by
    resolveRateLimitPrincipal(headers) for the IP buckets — never Fly-Client-IP read directly —
    and sha256(normaliseEmailForKey(email)) for the email bucket." Also clarify the trailing
    "Never a raw address", which now reads as contradicting the IP buckets.
  why_self_contained: >-
    One sentence in one file. The correct rule is stated in three other artifacts the same
    implementer must read, including rate-limit.types.ts, which this file imports from. A
    warning carried into the owning TASK closes it without touching any decision.
```

```yaml
- id: NEW-2
  severity: major
  kind: design
  classification: (b) real but self-contained
  file: design/contracts/rate-limit.md
  line: 191
  summary: >-
    The ownership row added this round assigns `resolveRateLimitPrincipal` and
    `assertBffProxySecretConfigured` to TASK-009, whose own file moved auth-surface rate
    limiting out to TASK-058; the boot assertion lands in main.ts, which TASK-058's paths exclude.
  failure_scenario: >-
    TASK-009.md "Out of scope" reads: "the auth-surface protection — authBodyCap, the IP
    rate-limit buckets, the hooks.before email bucket, AUTH_RATE_LIMIT_PORT and
    LocalAuthRateLimiter — moved to TASK-058". Its implementer reads that and skips rate-limit
    machinery. TASK-058.md never mentions the resolver, the shared secret, or the boot
    assertion, and its paths glob (auth/middleware/**, auth/ports/**, auth.config.ts,
    test/auth/**) covers neither apps/api/src/auth/resolve-rate-limit-principal.ts nor main.ts.
    The resolver itself will most likely still get built — TASK-058's implementer needs a
    principal and rate-limit.md is in their contracts list. `assertBffProxySecretConfigured()`
    in main.ts is the piece with no owner in practice: main.ts is TASK-009's exclusive
    territory and TASK-009 believes this is not its work. Without it, production can run with
    BFF_PROXY_SECRET unset; F-033 rule 1 then disables the trusted-proxy branch and every
    IP-keyed bucket collapses to Vercel's egress. The collapse is signalled
    (bff_proxy_auth_mismatch_total fires, since the BFF still sends the auth header), so this
    is a signalled availability failure, not a silent bypass — the assertion exists precisely
    to catch it at boot instead.
  required_change: >-
    Contract-side: state in the ownership table that TASK-009 retains only
    `assertBffProxySecretConfigured()` and its main.ts call, and that the resolver file is
    TASK-058's if TASK-009 has not shipped it. TASK-side amendment escalates to Juano —
    TASK-009 needs the main.ts assertion named in its Produces, or the assertion needs to move
    with an explicit path grant to TASK-058.
  why_self_contained: >-
    A routing/ownership defect, not a decision defect. Every mechanism is correctly specified;
    only the "who writes it" line is wrong. A warning into TASK-009 and TASK-058 closes it.
  note: >-
    Six further rows of the same table (authBodyCap, authRateLimit, email bucket,
    AUTH_RATE_LIMIT_PORT, LocalAuthRateLimiter) carry the same stale TASK-009 attribution.
    Those predate this diff — the table was created in d50b8f6, the same commit that created
    TASK-058 — so they are deferred, not filed.
```

Neither is load-bearing. Neither should BLOCK the gate.

## 4. Deferred observations (not blocking, not extending anything)

- `contracts/rate-limit.md:223` / `rate-limit.types.ts:245` — F-028 rationale still describes `LocalRateLimiter` as tenant-keyed only. Stale rationale, not a spec; the normative interface 20 lines away is unambiguous. Contestable.
- `contracts/rate-limit.md:206-217` — "There is no unprotected window... From wave 2 the auth surface is limited" is now false: TASK-058 is wave 3 (state.yaml:69) and TASK-009 mounts the surface in wave 2. One-wave window, pre-launch, and an artifact of Juano's own split ruling. Pre-existing since round 3.
- `TASK-003.md` has `contracts: []` and a paths glob that excludes `apps/api/src/observability/**`, while three design artifacts name it the owner of `REDACT_PATHS`. Pre-existing; same shape as NEW-2 but no new attribution added this round.
- `design/stubs/README.md` — the new resolver stub is not in the "Security-critical comments are load-bearing" table, though it is now the densest such block in the design. The README's "These have not been compiled" is also now inaccurate for that one file.
- Memory arithmetic disagrees across artifacts: `rate-limit.md:240` implies ~150 B/entry (40 000 entries ≈ 6 MB), `adr-0012:123` implies ~300 B/entry (10 000 ≈ 3 MB). Both order-of-magnitude sane; total worst case ≈ 6 maps × 10 000, bounded.
- The `@Public()` bucket on the **Redis** path has no typed interface (`rate-limit.types.ts:189-193` says it bypasses `RateLimiter` and uses the Lua script directly), while the local fallback has typed `checkPublicIp`. Asymmetric, two code paths for one bucket.
- In local `next dev` with `BFF_PROXY_SECRET` set on both sides for parity, the BFF omits `x-shortkit-client-ip` but still sends the auth header — a valid secret with a rule-4 failure, so `bff_proxy_auth_mismatch_total` warns once a minute in dev. Harmless noise; consider omitting both headers together.
- `crypto.timingSafeEqual` throws on unequal-length buffers and the resolver is specified to never throw. The stub says "over equal-length buffers"; the implementer needs the length pre-check. Vercel's own docs example (linked below) shows the pattern.

## 5. Verdict

`changes-requested`

Five findings addressed; two new majors, **both classified (b) real but self-contained**. On your adjudication rules both are park-with-a-warning, not BLOCKED. If you want the Design gate to move, NEW-1 is a one-sentence contract-side edit and NEW-2 is one table row plus a TASK amendment that escalates.

## 6. What I could not do

- I did not run `tsc` — you verified the resolver stub compiles and I took that as given.
- I could not verify Vercel Enterprise trusted-proxy behaviour beyond the public docs page; the docs say Enterprise customers "can purchase and enable a trusted proxy to allow your custom `X-Forwarded-For` IP" and say nothing about whether that also affects `x-vercel-forwarded-for`. The design's stated invalidation clause covers this case explicitly, so it does not change the verdict.
- I read `refinement.md`, `plan.md` and the TASK files only to check for contradicting statements. I did not edit anything, and NEW-2's TASK-side remedy is stated as an escalation rather than performed.

Sources: [Vercel request headers](https://vercel.com/docs/headers/request-headers), [vercel/community discussion #2484](https://github.com/vercel/community/discussions/2484)