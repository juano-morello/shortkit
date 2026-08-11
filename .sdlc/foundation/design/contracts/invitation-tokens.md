# Contract: invitation capability tokens

- **Boundary:** anonymous callers to tenant-scoped data. The only sanctioned way a `@Public()` route obtains tenant context.
- **Normative form:** `apps/api/src/invitations/tokens/capability-token.ts`, not yet written. The design stub at `design/stubs/apps/api/src/invitations/tokens/capability-token.ts` stands in until TASK-020 lands the file and is retired then (ADR-0039). It is a design-gate scaffold, not a normative form.
- **Produced by:** TASK-020.
- **Consumed by:** TASK-021 (both public routes), TASK-022 (accept UI), TASK-013 (invited signup branch), TASK-056 (public-route audit).
- **ADRs:** ADR-0021, ADR-0003, ADR-0015.

## Token format

```
<tenantId>.<secret>

tenantId  uuid v4, canonical lowercase hyphenated, 36 chars
secret    32 bytes from crypto.randomBytes, base64url, no padding, 43 chars
total     80 chars including the separator
```

The left segment **routes**. The right segment **authorises**. The separator is the
first `.`; the secret contains none, because base64url's alphabet excludes it.

## Storage

```sql
ALTER TABLE invitations
  ADD COLUMN token_digest bytea       NOT NULL,   -- SHA-256 of the secret half ONLY
  ADD COLUMN expires_at   timestamptz NOT NULL;

CREATE UNIQUE INDEX invitations_token_digest_unique ON invitations (token_digest);
```

**The raw token is never stored in this database, never logged by this process, and never
returned by any read.** The digest covers the secret half only; the tenant id is already a
column.

It is **not** true that the raw token exists in one place. It is in the email body and in
the URL path of both public routes. Corrected 2026-08-11 (F-300); see "Where the raw token
actually travels".

## The single entry point

```ts
export interface CapabilityToken {
  readonly tenantId: string;
  readonly secret: string;
}

/** Throws MalformedCapabilityToken. Validates tenantId as a uuid (ADR-0003 F-007 rule). */
export declare function parseCapabilityToken(raw: string): CapabilityToken;

export declare function issueCapabilityToken(tenantId: string): {
  raw: string;
  digest: Buffer;
};

export interface InvitationRepository {
  /**
   * The ONLY entry point available to an anonymous caller.
   * Parses, opens withTenantTransaction(tenantId), verifies the digest with
   * timingSafeEqual, and only then returns the row.
   */
  findByCapabilityToken(rawToken: string): Promise<Invitation | null>;
}
```

There is no `findByToken(token)` and no way to obtain the transaction handle
separately. A handler holds no invitation object until verification has succeeded, so
it has nothing to act on before then.

## Normative sequence

```
1. parseCapabilityToken(raw)                  -> MalformedCapabilityToken => 404 not_found
2. withTenantTransaction(tenantId, ...)       -- caller-controlled tenant id
3. SELECT ... FROM invitations
     WHERE token_digest = sha256(secret)      -- FIRST statement, RLS-scoped by step 2
4. timingSafeEqual on the stored digest       -- constant time
5. state / expiry checks
6. everything else
```

**No statement between step 2 and step 4 may act on the tenant.** The caller chooses
the tenant id, so step 4 is the only thing standing between an anonymous request and
tenant write context. Step 3 is safe to run first because it is scoped by RLS to the
claimed tenant and matches only on a digest the caller cannot forge.

A malformed token, an unknown digest, and a digest belonging to another tenant all
return **404 `not_found`** with the same body and no timing difference beyond the
indexed lookup. Existence is not disclosed.

## State and error mapping

| Condition | Status | Code |
|---|---|---|
| malformed, unknown, or wrong tenant | 404 | `not_found` |
| `state = 'accepted'` | 409 | `invitation_already_accepted` (AC-34) |
| `expires_at < now()` or `state = 'expired'` | 410 | `invitation_expired` (AC-35) |
| `state = 'revoked'` | 410 | `invitation_revoked` (AC-36) |
| accepting user already belongs to another tenant | 409 | `invitation_tenant_conflict` (ADR-0015) |

`expires_at` is **7 days** from creation.

## Acceptance is one transaction

Consuming the token and creating the memberships commit together (AC-33): the state
moves to `accepted`, and `memberships` rows are created for **exactly** the named
workspaces. An invited signup additionally creates the `tenant_memberships` row at
tenant role `member` (Amendment A-8, ADR-0015).

## The invited-signup branch uses the same entry point

Added 2026-08-04 (F-021). `onUserCreated`'s invited branch runs inside Better Auth's
handler, which is mounted outside the Nest module graph, so **TASK-056's route
enumeration cannot see it**. It is the single anonymous path that writes
`tenant_memberships`.

Validation runs in a **`before` hook**: `databaseHooks.user.after` cannot roll back the
insert that triggered it, so rejecting there would leave a user row behind.

```
hooks.before, /sign-up/email, when body.invitationToken is present:
  1. invitation = await invitationRepository.findByCapabilityToken(body.invitationToken)
  2. null                        -> throw APIError(404). NO USER IS CREATED.
  3. expired / revoked / accepted -> throw with that state's code, above

databaseHooks.user.after (onUserCreated), invited branch:
  4. invitation = findByCapabilityToken(body.invitationToken)   -- same verified read
  5. tenantId := invitation.tenantId       <- FROM THE VERIFIED ROW, not from the token
  6. tenant_memberships(TENANT_ROLE.member) + the named workspace memberships,
     in one transaction with token consumption
```

**Parsing the token for a tenant id anywhere outside `findByCapabilityToken` is a
defect.** Owned by TASK-013.

**Residue if step 6 fails after the user commits:** a `user` row with no
`tenant_memberships` row, which cannot obtain a `tid` claim and therefore cannot
authenticate to any tenant-scoped route. That is the acceptable failure. A membership row
in an unproven tenant is not. Do not relax step 5 to avoid the orphan.

Required test, because enumeration cannot substitute for it: sign up with a
syntactically valid token whose tenant half names another tenant and whose secret half
is random, and assert no user, no `tenant_memberships` row and no `memberships` row is
created in that tenant.

## Invariants a caller may rely on

1. Every statement runs under `set_config('app.tenant_id', ...)` and the ordinary
   `tenant_isolation` policy. **This is not a GC-5 escape**; `ISOLATION_EXCLUSIONS`
   stays at two.
2. A token is single-use. Replaying an accepted token creates no additional membership
   (AC-34).
3. Guessing a valid token requires guessing 32 random bytes. The tenant id half grants
   nothing on its own.
4. Digest comparison is constant time, so a timing oracle cannot recover the secret.
5. The raw token appears in exactly one place **in storage under this system's control**:
   the invitation email body. It is never written to `invitations`, never returned by a
   read, never logged, and never constructed into error text (ADR-0029).
   **Corrected 2026-08-11 (F-300).** The invariant said "in exactly one place" without
   qualification, and that is false. See "Where the raw token actually travels" below. A
   deferred TASK reading the old wording would have built against a guarantee this design
   does not provide.

## Where the raw token actually travels

Added 2026-08-11 (F-300). **Parked, with the invariant corrected. No mechanism is chosen
here, deliberately** — that decision belongs to whoever builds the accept flow, and it is
not reachable today: TASK-022 is deferred with EPIC-002 and no accept screen exists.

The accept flow puts the raw token in a **URL path**. `GET /api/invitations/:token`
(`workspace-authorization.md`, `@Public()`, "authorisation IS the capability token") is
reached from a link in an email, so the bearer credential is in the address bar. URLs leak
by four named channels, and this design mitigates none of them:

| Channel | What lands there |
|---|---|
| the address bar | the full token, visible over a shoulder and copyable into a chat message |
| browser history and sync | the full token, persisted on the device and on every device the profile syncs to |
| the `Referer` header | the full token, sent to the origin of any third-party asset, font, script or image the accept page loads |
| platform request logs | the full token, in whatever access log the hosting platform keeps, outside `logging-and-headers.md`'s allowlist because it is not this process writing the line |

`POST /api/invitations/:token/accept` carries the token in its path too. It is an XHR
rather than a navigation, so it reaches no address bar, no history entry and no `Referer`,
and it does reach the fourth row. Any fix that covers only the `GET` leaves that one.

ADR-0029 keeps the token out of `Error.message` and out of every own enumerable property of
an error, and it does nothing about any of the four rows above, because **the URL is where
the design put it**. That ADR's rule and this gap are compatible and separate.

### Plausible fixes, recorded so the decision is informed when it is taken

Neither is chosen and neither is costed against the other here.

**A. Exchange the token by POST with a body.** The emailed link points at a web page that
carries no credential; the page posts the token to the API in a JSON body. Cost: the token
still has to reach the page somehow, so it moves to a URL fragment or the link becomes
two-step, and a fragment is invisible to `Referer` and to server logs but still lands in
history and in the address bar. It also changes the route's method and shape, which
`workspace-authorization.md`, TASK-021 and the `@Public()` audit in TASK-056 all read.

**B. One-time redirect that swaps the token for a session before the page renders.** The
emailed link hits an endpoint that verifies the token, consumes it, sets a short-lived
cookie, and 303s to a token-free URL. Cost: the token is still in one address-bar entry and
one platform log line before the redirect, so this narrows the window rather than closing
it; it needs the token to be single-use in a way that survives a prefetching mail client,
which will follow the link before the human does; and it puts a state change on a `GET`,
which ADR-0038 classifies as non-mutating and which the rate-limit design treats as safe to
serve.

**What would force the decision:** EPIC-002 being scheduled, or the accept page loading any
third-party asset, which turns the `Referer` row from a design smell into a disclosure to a
named third party.

## What the implementer must guarantee

- `findByCapabilityToken` is the only anonymous entry point. Adding a
  digest-skipping read is a defect, and TASK-056 asserts that every `@Public()` route
  touching a tenant-scoped table routes through a capability-token entry point.
- The tenant id is validated as a uuid **before** it reaches `set_config`. It arrives
  from an unauthenticated URL segment.
- An integration test asserts that a token whose tenant half is edited to another
  tenant's id returns 404 and reads nothing from that tenant.
- The raw token never enters a log line, a structured-log field, or an error message. That
  is ADR-0029's rule and it binds this process. It does not bind the address bar, browser
  history, the `Referer` header or a platform access log, none of which this process
  writes. Whoever builds the accept flow reads "Where the raw token actually travels" first
  and either picks a mechanism there or records that they did not.

## Not applied to email verification, deliberately

Better Auth owns `user`, `session`, `account` and `verification`. None carries
`tenant_id` and none has RLS (ADR-0003), so verifying an email touches no tenant-scoped
table and needs no tenant context. Verification tokens stay Better Auth's, unchanged.

## Versioning

The `<uuid>.<secret>` shape is parsed by one function. Changing it invalidates every
outstanding invitation, so a change means a migration that revokes them and a stated
reason.
