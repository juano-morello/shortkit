## 1. Verdicts on the routed findings

**F-024 — ADDRESSED.** The ownership table at `/home/juano/Workspaces/JustJuanoDev/.sdlc/foundation/design/contracts/rate-limit.md:109-118` names a file and one owning TASK for all six auth-surface pieces, and the TASK front matter can actually execute it: `TASK-009.md` already carries `apps/api/src/auth/**`, `apps/api/src/main.ts`, `apps/api/src/app.module.ts` in `paths` and `design/contracts/rate-limit.md` in `contracts`; `TASK-051.md` carries `apps/api/src/app.module.ts`. No escalation needed — the amendment ADR-0013:257-259 says is "recorded for Juano's ruling, not applied" is already satisfied on disk.

The port claim survives the specific test you asked for. The wave-2 `LocalAuthRateLimiter` is not a type-satisfying placeholder, because TASK-009 also owns the three integration tests (`rate-limit.md:197-212`) and TASK-009 is wave 2 — at that point the local bucket is the *only* binding, so "six sign-ins from six IPs, sixth returns 429" cannot pass against a no-op. That is what makes "no no-op default" enforced rather than asserted; the `@Optional()` prose alone would not have. Wave 10 adds a binding while the local one stays bound as ADR-0012's fallback, so there is no window with neither bound.

**F-025 — ADDRESSED.** `rate-limit.md:171-212` plus `auth-rate-limit.port.ts:53-68`. The three tests do catch both filed failure modes: test 1 fails if `ctx.path` is not base-path-relative (the hook would return early on every request and no 429 would ever arrive); test 2 fails if the key is `sha256(rawEmail)`; test 3 fails if the key is global rather than per-address. The normalisation rule is stated as `trim().toLowerCase()` and nothing more, with the lockout reasoning explicit — that is the right call, and `trim()` is in the safe direction even if Better Auth does not trim.

**F-027 — ADDRESSED, with one residual (new finding F-030 below).** `rate-limit.md:252-281`, `web-api-client.md:59-64`, `client.ts:27-32`. The body fallback cannot be spoofed: the 429 body is emitted by our own middleware or by our own `APIError` call with a constant `message`, no user input is reflected into it, and every hop is TLS through the BFF. It cannot be mis-ordered either — `errorEnvelopeContract` is a non-strict `z.object({code, message, details?})`, so `{code:'rate_limited', message, retryAfterSeconds}` validates at rule 2 and never falls through to rule 5's `internal_error` mapping. The proxy's response-header allowlist includes `retry-after`, so the header path also survives the hop. Invariant 3's rewrite is true for the three surfaces it enumerates; it is not true for a fourth that no artifact accounts for — see F-030.

## 2. The mechanism that moved under deferred item 4 — `after` → `before` hook

The orphan argument **holds**, but it holds for a different reason than the artifacts give, and one ADR now contradicts itself.

An orphaned `user` (row committed, no `tenant_memberships`) cannot escalate:

- Token mint: `tid: await tenantIdForUser(user.id)` (ADR-0013:143). With no membership row this either throws (no token) or yields `undefined`, in which case the claim is simply absent from the signed JWT.
- `AuthGuard` steps 1–7 (`auth-tokens.md:55-67`) contain **no check that `tid` is present or uuid-shaped**. So a tid-less token passes the guard.
- What actually stops it is one layer further down: `withTenantTransaction` "MUST validate `tenantId` as a uuid before it reaches `set_config`" (`tenant-context.md:168`, `tenant-context.ts:75-76`). Undefined fails that and throws → 500, not a cross-tenant read.
- The single `@NoTenantTransaction` route, `POST /api/gdpr/delete`, does a Form C in-handler owner assert, which reads `tenant_memberships` — an orphan gets 403.
- Adoption paths: invitation accept requires a valid unconsumed capability token (legitimate); the tenant-role grant route requires an owner acting inside their own tenant under RLS; re-signup is blocked by the unique email. `UNIQUE (user_id)` makes adoption one-shot. No escalation path.

So: cannot authenticate, cannot be adopted by an attacker-controlled path. But the stated mechanism ("cannot obtain a `tid` claim") is nowhere specified as a behaviour, and the guarantee actually rests on a uuid validation in a different contract, producing a 500 rather than a 401. That plus the stale atomicity prose is F-029.

## 3. The two items the architect could not verify — risk assessment only

**`Unbranded<T>` in generic parameter position.** Real chance of failing open: when the argument is checked against `Unbranded<T>` and the check type is a naked `T`, inference is deferred and `T` can fall back to its constraint `string`; `Unbranded<string>` is `string`, and a branded value is assignable to `string`. If that happens the guard compiles away silently.

Does F-023 reopen? **No, not the escalation itself.** The primary brand is unaffected — a bare `'member'` literal still is not assignable to `WorkspaceRole`, which is what F-023 closed. What is lost is the anti-laundering layer: `authorizer.assert(wsId, asWorkspaceRole(ctx.tenantRole))` would compile. That needs a developer to write it deliberately, and it is exactly the move someone makes to silence a brand mismatch under time pressure — and neither backstop catches it, because TASK-056 greps for `as TenantRole` / `as WorkspaceRole` string casts (ADR-0023:154, `isolation-coverage.md:282`), not for a call to the sanctioned function. Verdict: accept as a known cost, warn the implementer. Cheap mitigations at implement time, both inside existing TASK scope: a `@ts-expect-error` type test in TASK-007 asserting `asWorkspaceRole(tenantRoleValue)` is rejected, and extend TASK-056's grep to enumerate `asTenantRole(` / `asWorkspaceRole(` call sites and assert the count. Not a gate blocker.

**`APIError` header control and `ctx.path` relativity.** Near-zero residual risk, and correctly handled. F-027's design is already header-independent — the body carries the value and the client prefers the header, so whichever way header control resolves, nothing breaks. `ctx.path` is now pinned by a wave-2 test rather than assumed, which converts an unverifiable framework claim into a failure that surfaces in TASK-009 at the cheapest possible moment. This is the right shape for both.

## 4. New findings

```yaml
findings:
  - id: F-028
    severity: major
    kind: design
    file: .sdlc/foundation/design/contracts/rate-limit.md
    line: 127
    summary: LocalAuthRateLimiter is keyed on attacker-controlled principals with no stated memory bound, unlike every other local bucket in the design.
    failure_scenario: >-
      The tenant-side local bucket is explicitly bounded — "LRU-capped at 10,000 tenants",
      LOCAL_LIMITER_MAX_TENANTS = 10_000 (rate-limit.types.ts:175,187; ADR-0012:56). The new
      LocalAuthRateLimiter is specified only as "a real in-process token bucket, same algorithm
      and same limits" with no cap, no eviction and no sweep, and its principals are the client
      IP and sha256(email) — both unbounded and both chosen by an unauthenticated caller. An
      attacker rotating source addresses (an IPv6 /64 is free) creates one live map entry per
      request; every entry survives its window with nothing to reap it. The path is live in two
      situations: the whole wave-2..wave-10 interval, when the local bucket is the only auth
      limiter that exists, and any Redis outage in production, when ADR-0012's posture routes
      every auth decision to it. In the second case the attacker converts a Redis outage into
      an API OOM-restart loop, while the redirect path is already degraded onto its Postgres
      fallback that GC-1 constrains and GC-8 forbids 5xx on.
    required_change: >-
      State the bound for LocalAuthRateLimiter the way it is stated for LocalRateLimiter: a
      per-bucket entry cap with LRU eviction, and expiry of entries whose window has passed.
      Put the constant in the stub next to LOCAL_LIMITER_MAX_TENANTS so it is copied, not
      remembered.

  - id: F-029
    severity: minor
    kind: design
    file: .sdlc/foundation/design/adr-0015-user-tenant-cardinality.md
    line: 65
    summary: The revision's residue paragraph contradicts the atomicity claim two paragraphs above it, and no artifact says what tenantIdForUser does when no membership exists.
    failure_scenario: >-
      ADR-0015:63-66 still reads "exactly one tenant_memberships row exists when the transaction
      commits, inside the same transaction as the user insert", and ADR-0013:170-171 repeats it,
      while ADR-0015:101-105 now says the user can commit without one. An implementer working
      from the Decision block builds for atomicity, discovers it is not implementable — which is
      what this round already discovered — and improvises. Separately, ADR-0013:143 mints
      tid: await tenantIdForUser(user.id) with no stated behaviour for the no-membership case,
      and AuthGuard steps 1-7 (auth-tokens.md:55-67) never check that tid is present or
      uuid-shaped. A tid-less token therefore passes the guard and is stopped only by
      withTenantTransaction's uuid validation one layer down, surfacing as a 500 on every
      request rather than a 401. The design's safety here is real but accidental.
    required_change: >-
      Delete or correct the two stale atomicity sentences. State that tenantIdForUser throws
      when no membership row exists, so no token is minted for an orphan, and make the "cannot
      obtain a tid claim" argument a specified behaviour rather than an inference.

  - id: F-030
    severity: minor
    kind: design
    file: .sdlc/foundation/design/contracts/rate-limit.md
    line: 308
    summary: Invariant 3 enumerates three 429 sources; Better Auth ships a fourth that is on by default in production and matches none of the shapes.
    failure_scenario: >-
      Better Auth has its own built-in rate limiter, disabled in development and enabled in
      production by default, which answers with its own body and its own retry header spelling.
      No ADR or contract disables it, configures it, or accounts for its response shape. If it
      fires, the body carries no code: 'rate_limited', so web-api-client rule 5 maps it to
      internal_error and the login screen shows the generic error — the exact outcome F-027 was
      filed to prevent. It is invisible everywhere it would be caught: off in dev, off in the
      test environment the three required integration tests run in, on only in production.
    required_change: >-
      Decide explicitly in ADR-0013 whether Better Auth's built-in limiter is disabled (ours is
      the limiter of record, and two limiters on one surface is a debugging trap) or kept and
      configured; if kept, add its response shape to the table and to invariant 3. Note that I
      am asserting this framework default from knowledge, not from a check in this environment —
      confirm against the docs for the pinned better-auth version.
```

**Which category each is in, plainly.** F-028 is the only one I consider gate-blocking, and it blocks on a single normative sentence plus a constant — it is not a re-architecture and does not need a fresh architect. If you would rather not spend round 4 on it, it converts cleanly into a TASK-009 implementation constraint the way F-026's TASK half was ruled; what it must not do is stay unstated, because the sibling limiter's explicit cap makes the omission read as deliberate. F-029 and F-030 are cheap prose/config corrections that can ride along with whatever you decide for F-028.

## 5. Deferred observations — explicitly not blocking

1. **How the raw-Express mount obtains a container-resolved port.** "An unbound token fails at boot" (`rate-limit.md:140-142`) is a Nest guarantee that applies to Nest-injected consumers. All three call sites here — two Express middlewares and a `betterAuth()` config object — sit outside the module graph, so boot-time resolution is only reached if something in the graph injects the token or `main.ts` does `app.get(...)` after `create()`. Failure direction is loud (500 on first sign-in), and the three F-025 tests catch it at wave 2, so this is an implementation note, not a hole.
2. **Two owners, one `hooks.before` seam.** TASK-009 writes the email-limiter before-hook; TASK-013 writes the invitation-validation before-hook in the same `auth.config.ts`. Better Auth's `hooks.before` is a single function, and no artifact states the composition rule. If TASK-013 replaces rather than extends, the email bucket vanishes and F-019's failure returns — but the three F-025 integration tests fail loudly in CI when that happens, which is why this is deferred rather than filed. Worth one sentence to TASK-013's implementer.
3. **LRU cross-talk in degraded mode.** With Redis down, the guard's `LocalRateLimiter.check(tenantId)` also serves `@Public()` IP keys; an attacker churning IPs can evict tenant buckets from the 10,000-entry LRU and reset a tenant's window per request. Pre-existing (ADR-0012:108 records the eviction consequence), degraded-mode only.
4. **The "Better Auth lowercases for lookup" assumption is safe in both worlds.** If it is false, case-variants are distinct accounts and our shared bucket is merely stricter — the cost is a cross-account lockout between case-variants, and the evasion the normalisation exists to stop would not have existed. No action.
5. **`TASK-013.md`'s approved Approach block** still reads "the tenant and its owner record are created in the same transaction as the user, so no account can exist without a tenant", directly contradicting the amendment note Juano added below it in the same file. Escalation-class (approved artifact) — flagged, not filed.
6. **ADR-0013:257-259** says TASK-009's `paths`/`contracts` amendments are pending Juano's ruling; they are already present in `TASK-009.md`. Stale note, no action.
7. **No type-level test anywhere pins the brand.** See section 3 for the two cheap mitigations.

## 6. Verdict

`changes-requested` — on F-028 alone. F-024, F-025 and F-027 are all genuinely addressed at source, the `before`-hook move is sound and its orphan argument holds, and nothing in this revision reopened a closed finding.

## 7. What I could not do

**The file at `/home/juano/Workspaces/JustJuanoDev/.sdlc/foundation/work/design-return-r3.md` is not the round-3 return.** It is the original design return: it opens "Design phase complete. 20 ADRs, 18 contracts, 23 stubs" (on-disk reality is 23 / 20 / 27), its escalation list contains items ruled before round 1, and it contains zero occurrences of `F-024`, `F-025`, `F-027`, `Unbranded`, `APIError` or `LocalAuthRateLimiter`. `state.yaml:67` records the round-3 return as persisted on arrival, so either the wrong document was written to that path or it was overwritten. The actual round-3 return is not on disk and I could not read it — the process defect you recorded is still live, one round later.

Consequence: every verdict above is from artifact text, which is what I was told to do anyway, so nothing is weakened. The two "could not verify" items I assessed from the artifacts plus your description of them, not from the architect's own words. I have not filed any finding that depends on the return's content.