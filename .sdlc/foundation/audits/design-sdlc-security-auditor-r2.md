I read every artifact at source. Here is the return.

## 1. Round-1 findings — verdicts

| ID | Verdict | Evidence |
|---|---|---|
| F-001 | **ADDRESSED** | `design/adr-0021-tenant-routing-capability-tokens.md` + `contracts/invitation-tokens.md`: `<tenantId>.<43-char secret>`, digest-only storage, `findByCapabilityToken` as the sole anonymous entry point, digest lookup as the first statement inside the transaction. Registered as sanctioned pattern 3 in `contracts/tenant-context.md:90`, not as an exclusion. |
| F-002 | **ADDRESSED** | `contracts/tenant-scoped-tables.md:103-169`. Three transactions. Phase 1 asserts `userIds.length >= 1` and `rowCounts['tenant_memberships'] >= 1`; phase 2 asserts `DELETE FROM tenants` rowCount 1 and `DELETE FROM "user"` rowCount equal to the census. Verified against `adr-0003:122-129` — the escape stays `FOR DELETE`, option (b) is rejected in the alternatives table with the blast-radius reason. A no-op now fails at phase 1 or phase 2, before phase 3's zero can mean anything. Deletion works: `tenants_privileged_erase` (`rls-policy-template.md:105`) admits the row, cascade runs with RLS bypassed. |
| F-003 | **ADDRESSED** | `contracts/redirect-resolution.md:46-57` and `:108` — `AND state = 'active'` is part of the permitted query shape. `contracts/domain-provisioning.md:47-86` adds RFC 1123 labels, IP-literal rejection and `isReservedHostname`; list in `stubs/packages/contracts/src/domains/reserved-hostnames.ts`. |
| F-004 | **ADDRESSED (substitute holds)** | See analysis below. `authBodyCap` closes the hole the finding named. |
| F-005 | **ADDRESSED** | `adr-0003:78-93` and `rls-policy-template.md:89-107`: `tenants` now has `self_select` (SELECT), `self_update` (UPDATE), `self_insert` (INSERT), `privileged_erase` (DELETE). No `FOR ALL`. The cascade is recorded as a deliberate policy-gated bypass in `adr-0003:179-185`. |
| F-006 | **ADDRESSED** | `contracts/branding.md:18-25` (https-only, stores parsed `href`), `:116-135` (escaping normative), CSP row in `redirect-resolution.md:80`. |
| F-007 | **ADDRESSED** | `set_config(...)` in `contracts/tenant-context.md:62-79`, `adr-0002` diff, `adr-0003:41-51`, `rls-policy-template.md:33-48`, `stubs/.../tenant-context.ts:10-18` with `assertUuid`. |
| F-008 | **ADDRESSED** | `contracts/web-api-client.md:86-114`: decoded-segment rejection, `encodeURIComponent` join, origin assertion, `redirect: 'manual'`, invariants 6 and 7. Mirrored in `stubs/apps/web/src/lib/api/client.ts` `buildUpstreamUrl`. |
| F-009 | **ADDRESSED** | `contracts/click-events.md:32-70`: `Fly-Client-IP` first, rightmost-minus-hops fallback, leftmost XFF never used, HMAC message salted with `tenantId`, rotation posture stated. |
| F-010 | **ADDRESSED** | `contracts/domain-provisioning.md:171-197`: partial unique index over `verified/provisioning/active`, conflict raised at the transition into `verified`, 7-day expiry of unverified claims via the reconciler (transition row at `:38`). |
| F-011 | **ADDRESSED** | `contracts/workspace-authorization.md:119-121` adds the three tenant-role rows at tenant `owner`; `:134-152` states owner-only grant/revoke, separate routes and controllers, last-owner check on both routes. |
| F-012 | **ADDRESSED** | `adr-0015` diff records Amendment A-8 and Juano's ruling; `TENANT_ROLES = ['owner','admin','member']` with `member: 0` in `stubs/packages/contracts/src/roles.ts:21-44`; `INVITEE_TENANT_ROLE = 'member'`. |
| F-013 | **ADDRESSED** | `contracts/click-events.md:19` (`varchar(512)`), `:114` (truncate at enqueue), `:112-116` (10,000 events **or** 4 MiB); `CLICK_BUFFER_MAX_BYTES`/`USER_AGENT_MAX_LENGTH` in the stub. |
| F-014 | **ADDRESSED** | `contracts/auth-tokens.md:51-53` — the `@Public()` check is **Step 0**, returns true immediately, steps 1-7 do not run. Stub `auth-claims.ts` renumbered to match. |
| F-015 | **ADDRESSED** | `contracts/redirect-cache.md:11-34`: every key `sk:{env}:`, `REDIS_KEY_NAMESPACE` required at boot, `ci-{run_id}` per run, CI/local must not point at production. Propagated to `rate-limit.md`, `auth-tokens.md:78`. |
| F-016 | **ADDRESSED** | `adr-0018` diff: `pnpm install --frozen-lockfile` on every job, `pnpm audit --prod --audit-level high` on `quality`, `better-auth` pinned exactly, assigned to TASK-001/TASK-002. |
| F-017 | **ADDRESSED** | New `adr-0022-logging-cors-and-security-headers.md` + `contracts/logging-and-headers.md`: pino redact list, CORS off with the reason and an escalation rule, helmet plus HSTS without `preload`. |

### F-004, the substituted mechanism

The substitution is sound and I withdraw the prescribed `express.json({limit})`. The architect is right that it consumes the stream. `authBodyCap` covers the cases I filed:

- **`Content-Length` present and over cap** — rejected at 413 before a byte is read.
- **Chunked** — bytes counted in flight, socket destroyed past the cap (`rate-limit.md:69`, `adr-0013:65-68`).
- **`Content-Length` absent** — in HTTP/1.1 a body with no `Content-Length` must be chunked, so it lands in the counting path. Not a gap.
- **Lying `Content-Length`** — Node's parser bounds the delivered body to the declared length; surplus bytes cannot be smuggled into the same request.

One residual inconsistency, non-blocking: `adr-0013:42` comments "413 past the cap" while the chunked path destroys the socket with no response. Worth one word of alignment, not a finding.

## 2. New blocker/major introduced by the revision

```yaml
verdict: changes-requested
findings:
  - severity: major
    kind: design
    file: .sdlc/foundation/design/contracts/rate-limit.md
    line: 42
    summary: The two new @Public() invitation routes are covered by no limiter, and ADR-0021 names a mitigation that does not reach them.
    failure_scenario: >
      RateLimitGuard explicitly does not apply to @Public() routes (rate-limit.md:42) and
      authRateLimit is mounted only on /api/auth/{*splat} (adr-0013:40). The invitation
      routes are @Public() and live under /api, so neither covers them. An unauthenticated
      attacker loops POST /api/invitations/<any-uuid>.<garbage>/accept; each request opens a
      Postgres transaction (BEGIN, two set_config, indexed SELECT, ROLLBACK) on the single
      pooled connection set shared with the redirect hot path that GC-1 constrains and GC-8
      forbids 5xx on. ADR-0021:126-129 states this exact risk and asserts "the only thing
      bounding it is the IP limiter from ADR-0013's revision" — which does not apply to these
      routes. rate-limit.md invariant 7 ("Every route on the API is covered by exactly one
      limiter... There is no unthrottled unauthenticated write surface") is false as written.
    required_change: >
      Give the two capability-token routes an IP-keyed limit and add the row to rate-limit.md's
      Scope table, or state in the Scope section which limiter covers @Public() routes under
      /api. Correct invariant 7 or make it true. Correct ADR-0021's Negative section to name
      the limiter that actually applies.

  - severity: major
    kind: design
    file: .sdlc/foundation/design/adr-0013-better-auth-in-nestjs.md
    line: 78
    summary: The email-keyed pre-auth limit requires parsing the request body that the same ADR forbids consuming.
    failure_scenario: >
      adr-0013:78 and rate-limit.md:61 specify a bucket keyed on `sha256(email)` for
      POST /api/auth/sign-in/email. The email is in the JSON body. authRateLimit is registered
      ahead of toNodeHandler, so reading that body consumes the stream Better Auth needs —
      the exact reason given two lines earlier for why authBodyCap must not parse
      (adr-0013:65-66). No artifact states a buffer-and-replay technique, and the stub
      (rate-limit.types.ts:50) leaves authRateLimitKey unimplemented with a `_principal`
      parameter and no note on where the email comes from. TASK-051's implementer meets a
      contradiction; the fixes that keep sign-in working are to drop the email bucket or to
      key on something else. Dropping it leaves only the IP bucket, so an attacker
      distributing across 1,000 IPs gets 10,000 password guesses per 5 minutes against one
      named account — the defense this row exists to provide.
    required_change: >
      State the mechanism normatively: buffer up to AUTH_BODY_MAX_BYTES, key on the parsed
      email, and re-emit the buffered bytes downstream (or explicitly drop the email bucket and
      record what is lost). Whichever is chosen, say so in rate-limit.md's Scope section and in
      adr-0013, because the ADR's own no-parsing rule currently reads as forbidding it.

  - severity: major
    kind: design
    file: .sdlc/foundation/design/contracts/tenant-context.md
    line: 99
    summary: @NoTenantTransaction removes the transaction WorkspaceGuard is required to run inside, on the one route that erases a tenant.
    failure_scenario: >
      workspace-authorization.md:173 is normative: "WorkspaceGuard runs after AuthGuard and
      inside the tenant transaction, so its membership lookup is itself under RLS."
      POST /api/gdpr/delete requires tenant `owner` (workspace-authorization.md:132) and now
      carries @NoTenantTransaction, which tenant-context.md:99 says "keeps AuthGuard and skips
      only TenantTransactionInterceptor" — silent on WorkspaceGuard. With no ambient context,
      the guard's owner lookup either throws TenantContextMissingError (500 on the erasure
      route) or reads zero rows. TASK-054's implementer meets a permanently broken route; the
      cheapest green fix is to make WorkspaceGuard tolerate a missing context, which removes
      the tenant-owner check from the only irreversible-destruction route in the system and
      lets any authenticated tenant `member` erase the whole tenant. No artifact says where
      that check runs instead.
    required_change: >
      State normatively where authorization for a @NoTenantTransaction route happens — e.g.
      the owner check and the AC-92 confirmation run inside phase 1's withTenantTransaction,
      before the census — and state that WorkspaceGuard must never be reached without an
      active context. Add an integration test asserting a tenant `member` and a tenant `admin`
      both get 403 from POST /api/gdpr/delete.

  - severity: major
    kind: design
    file: .sdlc/foundation/design/adr-0021-tenant-routing-capability-tokens.md
    line: 80
    summary: The invited-signup branch takes a caller-supplied tenant id from the token, and no artifact requires the digest to verify before it writes.
    failure_scenario: >
      ADR-0021's Context (:31-32) names onUserCreated as having the same shape and running
      outside Nest. The Decision then pins only the *uninvited* branch (:80-85). ADR-0015 —
      the artifact TASK-013 reads — says onUserCreated "receives the invitation token when one
      is present in the signup request. With a token it attaches the user to the inviting
      tenant at tenant role member and creates the named workspace memberships," with no
      mention of digest verification. The single enforcement mechanism, TASK-056's assertion
      that "every @Public() route touching a tenant-scoped table routes through a
      capability-token entry point" (invitation-tokens.md:120-122), enumerates Nest routes via
      DiscoveryService — and adr-0013:177-179 states plainly that the /api/auth/* mount sits
      outside the Nest module graph and the discovery test cannot see it. So the one anonymous
      path that writes tenant_memberships is the one path the audit structurally cannot cover.
      An attacker POSTs /api/auth/sign-up/email with invitationToken
      "<victim-tenant-uuid>.<43 random chars>"; an implementer who parses the routing prefix to
      open the transaction before verifying grants the attacker a tenant_memberships row in the
      victim tenant, which makes the `tid` claim in every subsequent token point at that tenant
      and reduces cross-tenant separation from RLS to the workspace-role layer alone.
    required_change: >
      Pin the invited-signup sequence in ADR-0021's Decision and in ADR-0015 with the same
      words used for the public routes: the tenant id is obtained only from
      findByCapabilityToken, which verifies the digest as the first statement; an invalid or
      expired token rejects the signup rather than falling back to any tenant write. Name the
      owning TASK (ADR-0021 currently assigns the invited branch to neither TASK-013 nor
      TASK-021). Add an integration test — signup with a token whose tenant half is another
      tenant's id creates no row in that tenant — since the route enumeration cannot reach it.
```

## 3. Breakage checks the architect flagged

1. **`member` in both enums — mitigations partially sufficient.** The type system does more than the artifacts credit it with: a variable typed `TenantRole` is not assignable to `WorkspaceRole` (`'owner'`/`'admin'` are not members), so confusing `ctx.tenantRole` with `ctx.workspaceRole` is a compile error. Only the bare literal slips through. The residual escalation path is Form B: a resource handler that means `assert(resource.workspaceId, 'member')` and writes `assertTenant('member')` gets a check that passes for every authenticated user in the tenant, letting a tenant `member` with access to workspace W1 write in W2. None of the three mitigations covers this — they address mutation routes, request-body field names, and rank functions. Cheap closure: type `assertTenant(min: Exclude<TenantRole,'member'>)`, since `workspace-authorization.md:39` already says no `@RequireTenantRole` in `launch-core` has a minimum below `admin`. Filed as minor below, not major: it needs an implementer error and the compiler blocks the more likely variable-level version.
2. **`@NoTenantTransaction` is not a fourth escape.** The claim holds. Phases 1 and 3 use `withTenantTransaction` with the `tid` claim (sanctioned source 1); phase 2 is exclusion 2. No new flag, no new policy, `CONTEXT_FLAG_OWNERS` unchanged, and `coverage.ts` enumerates and prints the justification. The problem it introduces is the authorization gap in the finding above, not an escape.
3. **`tenants_self_insert` admits exactly one row.** `WITH CHECK (id = current_setting('app.tenant_id', true)::uuid)` constrains `id` to the active context. An authenticated user attempting to insert under their own context collides with the primary key; a NULL context evaluates to NULL and denies. The only way to insert is to hold a context for an id that does not yet exist, which is the `crypto.randomUUID()` signup branch. It admits no other row.
4. **Cache vs `state = 'active'` — stated, but not where you asked.** `redirect-cache.md` does **not** say it, and its "Normative" invalidation table has no row for a domain leaving `active`. The rule is stated in `stubs/apps/api/src/redirect/redirect.types.ts:45-48`: "A host record is cached only for a domain in that state; anything else caches as a MISS sentinel." That closes it in practice, because `resolveHost` is the only writer of positive `hst:` records and `domain-provisioning.md`'s transition table has no `active` → non-deleted transition, so deletion (which does invalidate) is the only exit. Verdict: the hole is not re-opened; the statement belongs in `redirect-cache.md` too.

**F-001's capability token does what it claims.** `findByCapabilityToken` is the only anonymous entry point, it returns `Invitation | null`, and there is no way to obtain the transaction handle separately — so a handler cannot hold an invitation object pre-verification. A caller-supplied tenant id can *open* a transaction for any guessed tenant (the ADR states this at `:126-129`), but the first statement is the digest lookup, RLS-scoped to that tenant, and no other statement may run until it matches. The only unaddressed consequence is that the DoS amplifier this creates is unbounded — finding 1 above.

## 4. Minor and nit (non-major, listed for completeness)

- `adr-0003:139` — "The approved shapes are the five above and nothing else." Seven shapes are defined above it, and `adr-0003:176` itself says "the template shape, the cascade root's four, and two escapes" = 7. `rls-policy-template.md:129-137` carries the correct 7-row table. Stale count in the block TASK-056 reads for the `pg_policies` assertion. **Minor** — it is in a normative audit rule.
- `contracts/workspace-authorization.md:80` — `assertTenant(min: TenantRole)` accepts `'member'`, a minimum that authorises everyone. Narrow the parameter type. **Minor.**
- `adr-0003:143-157` — the paragraph "Auth tables are not tenant-scoped..." appears twice, verbatim. Editorial. **Nit.**
- `contracts/workspace-authorization.md:154-169` — the invariant list numbers 1,2,3,4,5,4,5. **Nit.**
- `adr-0021:133` says tokens are 79 characters; `invitation-tokens.md:16` says 80 (36+1+43). The contract is right. **Nit.**
- `tenant-scoped-tables.md:91` — `erase()` returns `deletedRowCounts: Record<string, number>`, but phase 2 issues two statements and PostgreSQL reports no per-table cascade counts, so the per-table map cannot be populated. The real per-table assertion lives in the census comparison at `:196-199`. Ambiguous return type. **Nit.**

## 5. Deferred — outside the fix diff, not blocking

- `adr-0019:139-145` accepts that erasure is now three non-atomic transactions; a crash between phase 2 and phase 3 leaves data gone and unverified. Stated and accepted; no action asked.
- Click events buffered at phase-1 time and flushed after phase 2 will hit a foreign-key error against the deleted tenant and can fail phase 3 spuriously. Operational, not security.
- `logging-and-headers.md:67-69` — pino `*.token` matches one level only; a nested secret is logged. Already stated as an accepted cost in ADR-0022.
- `adr-0013:170-173` — email-keyed limiting as an account-enumeration oracle. Stated and accepted (and moot if finding 2 resolves toward dropping the bucket).

## 6. Verdict

`changes-requested` — all 17 round-1 findings addressed; four new majors introduced by the fix.

## 7. What I could not do

Nothing was blocked. Every file named in the task exists and I read it at source. I did not evaluate stub syntax or attempt compilation, per instruction — there is still no workspace. I did not run any code and made no edits.