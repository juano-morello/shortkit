---
id: ADR-0021
slug: launch-core
title: Anonymous routes reach tenant data through a tenant-routing capability token
status: accepted
supersedes: null
date: 2026-08-04
---

## Context

The security audit found a hole I left open. Two routes are `@Public()` because the
caller has no account yet: `GET /api/invitations/:token` and
`POST /api/invitations/:token/accept`. Public routes skip
`TenantTransactionInterceptor`, so `app.tenant_id` is unset. `invitations`,
`invitation_workspaces` and `memberships` all carry `FORCE ROW LEVEL SECURITY`, whose
first invariant is that a query with no context affects zero rows. So
`invitationRepository.findByToken` returns null for every valid token, and the
membership insert is rejected by `WITH CHECK`.

The tenant id can only be learned by reading the invitation, and reading the invitation
needs the tenant id. That is the same chicken-and-egg ADR-0002 solved for authenticated
requests with the `tid` claim, and I did not solve it here.

Left as it is, TASK-021's implementer meets a frozen contract and a blocked route. The
cheap exits are both bad: setting `app.tenant_id` inside the invitations module fails
TASK-056's grep, so the likelier one is `CREATE POLICY invitations_public_read ON
invitations USING (true)`, which lets any anonymous caller enumerate every tenant's
pending invitations and their role grants.

ADR-0015's `onUserCreated` has the same shape. It runs inside Better Auth's handler,
mounted outside Nest, so no interceptor has run there either.

## Decision

**The token carries the tenant id, and the secret half proves the bearer may use it.**

```
<tenantId>.<43 chars base64url>          e.g.  9f2c...-....-....-....-........abc.Xk3...
```

The left segment routes; the right segment authorises. 32 bytes from
`crypto.randomBytes`, base64url, is the secret. Only the SHA-256 digest of the secret
is stored, in `invitations.token_digest`, and comparison uses `timingSafeEqual`.

**The handler opens tenant context from the token, then proves the token before
touching anything.** Sequence, normative:

1. Split on the first `.`. Validate the left segment as a uuid. Reject otherwise.
2. `withTenantTransaction(tenantIdFromToken, ...)`.
3. **First statement inside: the digest lookup.** `SELECT ... FROM invitations WHERE
   token_digest = $1`, which RLS scopes to the tenant from step 1.
4. No row, or an expired, revoked or consumed row: 404 or the matching state code, and
   roll back.
5. Only now may any other statement run.

**The caller controls the tenant id, so step 3 is the only thing between an anonymous
request and full write context for a tenant of their choosing.** That is the rule this
ADR exists to state, and step 5 is where it bites.

**It is enforced by shape, not by discipline.** `invitationRepository` exposes exactly
one entry point for anonymous callers:

```ts
findByCapabilityToken(rawToken: string): Promise<Invitation | null>
```

It parses, opens the transaction, verifies the digest, and returns the row or null. A
handler has no invitation object until it returns, so it has nothing to act on before
verification. There is no `findByToken(token)` that skips the digest check, and no way
to obtain the transaction handle separately.

**This is not a GC-5 escape.** Every statement still runs under
`set_config('app.tenant_id', ...)`, under the ordinary `tenant_isolation` policy, on
tables that keep `FORCE ROW LEVEL SECURITY`. No new context flag, no new policy, and
nothing added to `ISOLATION_EXCLUSIONS`, which stays at two. It is a third **sanctioned
pattern** for obtaining a tenant id, alongside the `tid` claim and an
application-generated uuid.

**Signup's uninvited branch generates the uuid in application code.**
`onUserCreated` computes `newTenantId = crypto.randomUUID()` and calls
`withTenantTransaction(newTenantId, ...)`, then inserts the `tenants` row. The
`tenants_self_insert` policy (ADR-0003) admits exactly the row whose `id` equals the
current context, so a signup can create its own tenant and nothing else. Stated here so
TASK-013 does not invent a different mechanism.

**Signup's invited branch obtains its tenant id the same way the public routes do, and
no other way.** Added 2026-08-04 (F-021). The first version of this ADR pinned only the
uninvited branch, and ADR-0015 (the artifact TASK-013 actually reads) described
attaching the user to the inviting tenant with no mention of digest verification. That
branch is the single anonymous path that writes `tenant_memberships`, and because the
Better Auth mount sits outside the Nest graph it is also the one path TASK-056's route
enumeration structurally cannot see. An implementer who opens the transaction before
verifying gives an attacker who signs up with
`invitationToken = "<victim-tenant-uuid>.<random>"` a membership row in the victim's
tenant.

Normative sequence for `onUserCreated`, invited branch, owned by **TASK-013**:

```
1. invitation = await invitationRepository.findByCapabilityToken(signupBody.invitationToken)
     -> parses, opens withTenantTransaction, verifies the digest as its FIRST statement
2. invitation === null  -> REJECT THE SIGNUP. No user, no tenant, no membership.
3. expired / revoked / accepted -> reject with that state's code (invitation-tokens.md)
4. tenantId := invitation.tenantId          <- FROM THE VERIFIED ROW, never from the token
5. create the user, tenant_memberships at TENANT_ROLE.member, and the named workspace
   memberships, in one transaction with token consumption
```

**Step 4 is the rule.** The tenant id used for the write comes from the row the digest
proved, not from the string the caller supplied. Parsing the token for a tenant id
outside `findByCapabilityToken` is a defect.

Because route enumeration cannot reach this path, **an integration test is the only
coverage**: sign up with a syntactically valid token whose tenant half names another
tenant and whose secret half is random, and assert no user, no `tenant_memberships` row,
and no `memberships` row is created in that tenant.

**Email verification is out of scope for this pattern, deliberately.** Better Auth owns
`user`, `session`, `account` and `verification`, none of which carries `tenant_id` or
RLS (ADR-0003). Verifying an email updates `user.emailVerified` and touches no
tenant-scoped table, so it needs no tenant context and gains nothing from a routing
prefix. The audit asked for the same treatment; the reason it is not needed is that the
tables are not tenant-scoped.

**Expiry, single use, revocation.** `expires_at` is 7 days from creation.
`InvitationState` transitions to `accepted` in the same transaction that creates the
memberships. `revoked` is set by the inviting `workspace_admin`. Each produces a
distinct error code, which is what AC-34, AC-35 and AC-36 test separately.

## Alternatives considered

| Option | Pros | Cons | Why not |
|---|---|---|---|
| A global lookup table mapping token digest to tenant id, outside RLS | The tenant id comes from the database keyed by a secret rather than from the URL, so an anonymous caller never chooses the tenant context | The table needs a tenant id column while deliberately escaping `tenantScopedTables()`, which enumerates on the column name `tenant_id`. Dodging it means naming the column something else, and ADR-0019 already flags that naming convention as load-bearing and only review-enforced. It also adds a table the eraser must remember | Strictly safer in one respect and it quietly breaks the enumeration that AC-88 and AC-90 rest on. The capability token gets the same protection from the digest check |
| Make the accept route authenticated: the invitee signs up first, then accepts | No anonymous tenant context at all; the `tid` claim does all the work | ADR-0015 attaches a user to a tenant at creation, and an invitee's tenant is determined by the invitation they have not yet accepted. Signup would have to read the invitation, which is the same problem one step earlier. TASK-021 also states the accept endpoint is `@Public()` because the invitee may have no account | Moves the problem rather than solving it, and contradicts the TASK |
| Give the public routes a fourth context flag, `app.invitation_context` | Symmetric with the two existing escapes; greppable | It would be a genuine third GC-5 escape, granting reads on `invitations` with no tenant bound. SC-1's claim would narrow from two exclusions to three, which is not mine to spend | Rejected on the standing rule: no fix widens an escape |
| Opaque random token with no tenant prefix, resolved by scanning every tenant | The caller cannot influence tenant context | Requires a cross-tenant read to find the row, which is exactly the escape being avoided | Circular |

## Consequences

### Positive

- The two public invitation routes work under RLS, with no new policy, no new context
  flag, and no change to the exclusion count.
- The digest-before-anything-else rule has a single enforcement point, because a handler
  cannot obtain the transaction without also verifying.
- Only a digest is stored, so a database read does not yield usable tokens.
- TASK-013's tenant creation is pinned, so the signup path and the invited path share
  one mechanism instead of inventing two.

### Negative / accepted cost

- **The token leaks the tenant id to anyone who sees the URL.** A uuid is opaque and
  names nothing, but it is a stable identifier that appears in the invitee's browser
  history, in the email, and in any referrer from the accept page. Correlating two
  invitations to the same agency becomes trivial for anyone holding both links.
- An anonymous caller can cause a tenant transaction to open for any tenant id they can
  guess, at the cost of one indexed lookup that then fails. That is a cheap
  denial-of-service amplifier against the connection pool the redirect hot path shares.
  It is bounded by `RateLimitGuard`'s IP bucket on `@Public()` routes under `/api`, at
  30 requests per minute per IP, checked before the token is parsed
  (`rate-limit.md`, F-018). ADR-0013's limiter covers `/api/auth/*` only and does not
  reach these routes; an earlier version of this section said it did, and was wrong.
- The rule "no statement acts on the tenant before the digest verifies" is stated and
  shape-enforced for the invitation repository. A future public route that opens tenant
  context some other way would not inherit the protection, and nothing detects that.
- **The invited-signup branch runs inside Better Auth's handler, outside the Nest module
  graph, so TASK-056's route enumeration cannot see it.** Its coverage is one
  integration test rather than the structural completeness check every other
  tenant-writing surface gets. That is a real gap in SC-1's enumeration claim, and it is
  recorded in `isolation-coverage.md` rather than left implicit.
- Tokens are 80 characters, so the invite URL is long and wraps in most mail clients.

### Follow-ups this creates

- TASK-020 adds `invitations.token_digest`, `expires_at`, and the unique index on
  `token_digest`; `invitationRepository` exposes `findByCapabilityToken` and no
  digest-skipping alternative.
- TASK-021 implements both public routes against that single entry point, and threads
  the token into signup for the invited branch.
- **TASK-013 owns both `onUserCreated` branches**: `crypto.randomUUID()` plus
  `withTenantTransaction` for the uninvited branch relying on `tenants_self_insert`, and
  `findByCapabilityToken` for the invited branch taking the tenant id from the verified
  row. It also owns the integration test that route enumeration cannot replace.
- TASK-056 asserts that every `@Public()` route reaching a tenant-scoped table does so
  through a capability-token entry point, records the justification, and records the
  Better Auth mount as a surface its enumeration cannot reach.
- Contract: `design/contracts/invitation-tokens.md`.
