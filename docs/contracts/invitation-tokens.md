# Contract: invitation capability tokens

- **Boundary:** anonymous callers to tenant-scoped data. The only sanctioned way a `@Public()` route obtains tenant context.
- **Normative form:** `apps/api/src/invitations/tokens/capability-token.ts` (format, parse, issue, digest — pure) and `apps/api/src/invitations/capability-lookup.ts` (the two entry functions). Shipped 2026-08-18 by TASK-1b-04; the design stub this line used to name no longer exists.
- **Produced by:** TASK-1b-04 (was TASK-020).
- **Consumed by:** TASK-1b-08 (`POST /api/invitations/lookup`, `POST /api/invitations/accept`), TASK-1b-09 (the sign-up `hooks.before` and the invited `onUserCreated` branch), TASK-1b-13 (accept page), TASK-1b-10 (isolation attempts). Earlier task ids in the body (TASK-013/020/021/022/056) are the 1a-era names for the same work.
- **ADRs:** ADR-0021, ADR-0003, ADR-0015, ADR-0029.

> **Shipped 2026-08-18 (TASK-1b-04). Where the file below diverges from what landed, the
> dated notes in each section say how; the shipped code is authoritative.** In one line:
> the entry point is two plain functions, not a repository method; the token travels in
> the URL fragment and in request bodies (mechanism A, D-03); a tenant conflict is decided
> before any statement (D-04); expiry is derived in SQL and never written (D-11); accept
> inserts memberships `ON CONFLICT DO NOTHING` (D-12); the link is the capability (D-01).

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

It is **not** true that the raw token exists in one place. Corrected 2026-08-11 (F-300),
when it was in the email body and in the URL path of both public routes. **Since
2026-08-18 (D-03, mechanism A) it is in the email body and in the URL fragment of the
accept link, and it reaches the API only in a request body**; see "Where the raw token
actually travels".

The shipped column is `token_digest bytea NOT NULL` with the unique index
`invitations_token_digest_unique`, in migration `0003` (TASK-1b-03), not an `ALTER TABLE`
on an existing table as the block above sketches; `expires_at timestamptz NOT NULL` is
there too. `digestOf(secret)` is `sha256(secret as utf8)`, 32 bytes, and it hashes the
secret half only.

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

**Shipped 2026-08-18 (TASK-1b-04, D-17): the entry point is two plain async functions,
not a repository method.** The Better Auth hooks run outside the Nest graph and cannot
inject a provider, and the Nest `InvitationsService` calls the same two functions, so the
mechanism lives in `apps/api/src/invitations/capability-lookup.ts`:

```ts
export function findInvitationByCapabilityToken(raw: string): Promise<VerifiedInvitation | null>;
export function acceptInvitationByCapabilityToken(raw: string, grant: AcceptGrant): Promise<AcceptedInvitation>;

export interface VerifiedInvitation {
  id; tenantId; email; state; expiresAt;
  workspaces: { workspaceId; workspaceName; workspaceRole }[];
  invitedByUserId; inviterEmail; tenantName;            // never a digest, never the token
}
export interface AcceptGrant { userId: string; tenantMembership: 'create' | 'require'; }
export interface AcceptedInvitation { tenantId: string; workspaces: { workspaceId; workspaceRole }[]; }
```

`InvitationRepository` (`apps/api/src/invitations/invitation.repository.ts`,
`@TenantScopedRepository()`, ambient `tenantDb()`) holds `create`, `listForWorkspace`,
`findById` and `revoke`, never parses a token, and its `InvitationRow` has no digest
field. `parseCapabilityToken` and `MalformedCapabilityToken` are exported from
`tokens/capability-token.ts` and called from exactly that file and `capability-lookup.ts`;
`capability-lookup.spec.ts` greps `apps/api/src` for both rules (GC-L). The `Invitation`
type the sketch above names is the contracts package's wire shape; the function returns
`VerifiedInvitation`, which the public route projects onto `invitationPreviewContract`.

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

**Shipped 2026-08-18 — the sequence as it runs, with one step the sketch lacks:**

```
1. parseCapabilityToken(raw)            -> MalformedCapabilityToken => null (find) / InvitationNotFoundError (accept)
2. IF a tenant context is active AND its id != the parsed prefix
     -> InvitationTenantConflictError (409) BEFORE ANY STATEMENT           (D-04, ADR-0015)
   (`currentTenantId()` inside a try; TenantContextMissingError = none active = the ordinary case)
3. withTenantTransaction(prefix, ...)   -- joins a matching active context (invariant 5), else opens one
4. FIRST statement: SELECT ... FROM invitations
     WHERE token_digest = $digest AND tenant_id = <current>              -- owner-qualified too (F-302)
   `expires_at < now()` is read as a column of this SELECT, on Postgres's clock
5. timingSafeEqual(stored, computed)    -- mismatch or no row => the 404 path
6. state: accepted -> 409; revoked -> 410; expired flag -> 410 (row NOT rewritten, D-11)
7. find: tenants.name (id = current), grants JOIN workspaces.name; return. Never writes.
   accept: UPDATE invitations SET state='accepted', accepted_at=now(), accepted_by_user_id=$user
             WHERE id=$id AND tenant_id=<current> AND state='pending' AND expires_at >= now()
             RETURNING id                        -- zero rows => 409 (the concurrent-accept race, AC-1b-27)
           INSERT memberships ... ON CONFLICT (workspace_id, user_id) DO NOTHING, per grant (D-12)
           tenantMembership 'create': INSERT tenant_memberships (member) ON CONFLICT (user_id) DO NOTHING
             -> zero rows and no row in THIS tenant => 409 invitation_tenant_conflict
           tenantMembership 'require': SELECT tenant_memberships (tenant_id=current, user_id) before the consume
             -> none => 409 invitation_tenant_conflict
```

Why the SQL equality in step 4 is acceptable alongside step 5: the digest is SHA-256 of
256 random bits, so a timing oracle on the index comparison could at most leak digest
bytes, and a digest yields no token. Step 5 is kept where the comparison the caller can
observe happens in this process, and it is what a defective index cannot bypass.

## State and error mapping

| Condition | Status | Code |
|---|---|---|
| malformed, unknown, or wrong tenant | 404 | `not_found` |
| `state = 'accepted'` | 409 | `invitation_already_accepted` (AC-34) |
| `expires_at < now()` or `state = 'expired'` | 410 | `invitation_expired` (AC-35) |
| `state = 'revoked'` | 410 | `invitation_revoked` (AC-36) |
| accepting user already belongs to another tenant | 409 | `invitation_tenant_conflict` (ADR-0015) |

`expires_at` is **7 days** from creation (`INVITATION_TTL_SECONDS`).

Precedence, shipped 2026-08-18: `accepted` and `revoked` are answered before expiry is
consulted, so a revoked invitation whose `expires_at` has also passed is 410
`invitation_revoked`. `state = 'expired'` is honoured if a later sweeper writes it; 1b
never does (D-11). The five errors are `InvitationNotFoundError`,
`InvitationAlreadyAcceptedError`, `InvitationExpiredError`, `InvitationRevokedError`,
`InvitationTenantConflictError` in `apps/api/src/invitations/errors.ts`, each with one
fixed message; no `ERROR_CODES` entry was added (GC-M).

## Acceptance is one transaction

Consuming the token and creating the memberships commit together (AC-33): the state
moves to `accepted`, and `memberships` rows are created for **exactly** the named
workspaces. An invited signup additionally creates the `tenant_memberships` row at
tenant role `member` (Amendment A-8, ADR-0015).

**Added 2026-08-18.** Three rulings bind this section:

- **D-01 (Juano, 2026-08-18): the link is the capability.** `invitations.email` is the mail
  recipient and a prefill; acceptance never compares the accepting account's address with
  it. Neither function reads `email` for any decision.
- **D-04: the signed-in accept is authenticated and runs under the caller's tenant.**
  `AcceptGrant.tenantMembership = 'require'`; a token naming another tenant is 409
  `invitation_tenant_conflict` before any statement. The invited signup passes `'create'`.
- **D-12: an existing membership's role wins.** `INSERT ... ON CONFLICT (workspace_id,
  user_id) DO NOTHING`, never `DO UPDATE` (F-341); the accept response lists every
  workspace the invitation named whether or not its row was new.

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

**Shipped names, 2026-08-18 (owned by TASK-1b-09, per D-18):** step 1 and step 4 are
`findInvitationByCapabilityToken(body.invitationToken)`; step 6 is
`acceptInvitationByCapabilityToken(body.invitationToken, { userId: user.id,
tenantMembership: 'create' })`, which performs the verified read again, consumes the
token, writes the named `memberships` rows and the `tenant_memberships` row at
`INVITEE_TENANT_ROLE` in one transaction, and returns the tenant id FROM THE ROW. Step 5's
rule stands: no hook reads `parseCapabilityToken`. Every `APIError` a hook throws carries
a fixed message (F-216); the two functions' errors carry no value either.

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
   is unchanged by this card. (Corrected 2026-08-18: it read "stays at two"; the array in
   `test/isolation/coverage.ts` has held three entries since TASK-002 added
   `TenantMembershipLookup.tenantIdForUser` under ADR-0045, and 1b adds none.)
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
   **Restated 2026-08-18 (D-03, GC-K).** The raw token appears in exactly two places under
   this system's control: the rendered mail body and the URL fragment of the accept link.
   Never a URL path or query on the API or the web, never a table (digest only), never a
   log field or `msg`, never an error message or body, never a `params` value of
   `apiClient`. Between those two places it travels only in request bodies
   (`POST /api/invitations/lookup { token }`, `POST /api/invitations/accept { token }`,
   `POST /api/auth/sign-up/email { ..., invitationToken }`).
6. A tenant conflict is decided before any statement (D-04): with a tenant context active
   for a different tenant than the token's prefix, both entry functions throw 409
   `invitation_tenant_conflict` and open nothing. Added 2026-08-18.

## Where the raw token actually travels

Added 2026-08-11 (F-300). Parked then, with the invariant corrected and no mechanism
chosen. **Decided 2026-08-18 (D-03, item 1b): mechanism A, fragment + body.** The rest of
this section is kept as the record of the choice; the paragraphs describing the URL-path
design are historical.

**What ships.** The email link is `<WEB_APP_ORIGIN>/invitations/accept#token=<raw>`. The
accept page (a client component) reads `location.hash`, immediately calls
`history.replaceState` to `/invitations/accept`, and keeps the token in component state
(and `sessionStorage` for the sign-in-then-accept round trip, cleared on accept — D-14).
The API legs carry the token in a JSON body: `POST /api/invitations/lookup { token }`
(`@Public()`, the one public route), `POST /api/invitations/accept { token }`
(authenticated), and `POST /api/auth/sign-up/email { ..., invitationToken }`.
`GET /api/invitations/:token` and `POST /api/invitations/:token/accept` are **not built**.

The four channels, re-scored for mechanism A:

| Channel | Under mechanism A |
|---|---|
| the address bar | the fragment is visible until the page runs `replaceState` — one paint, then gone; the history entry is replaced, not pushed |
| browser history and sync | the replaced entry carries no fragment; a mail client that opened the link keeps whatever it keeps of the URL it launched (outside this system) |
| the `Referer` header | fragments are never sent in `Referer`; the API legs are XHR with a body |
| platform request logs | fragments never reach a server; the API legs carry the token in a body, which access logs do not record |

Cost accepted (D-03): the accept page needs JavaScript, and a mail client that strips
`#…` breaks the link (the plain-text part carries the URL verbatim). Mechanism B was
rejected because it puts a state change on a `GET`, is consumed by prefetching mail
clients, and leaves one address-bar and one platform-log entry.

**The historical design, for the record.** The accept flow put the raw token in a **URL path**. `GET /api/invitations/:token`
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
  *Shipped 2026-08-18:* the entry points are `findInvitationByCapabilityToken` and
  `acceptInvitationByCapabilityToken`; `capability-lookup.spec.ts` asserts the callers of
  `parseCapabilityToken(` and the token-derived callers of `withTenantTransaction(` by grep.
- The tenant id is validated as a uuid **before** it reaches `set_config`. It arrives
  from an unauthenticated URL segment. *Shipped:* from an unauthenticated body field;
  `parseCapabilityToken` checks the shape with its own regex and a fixed-message error, and
  `withTenantTransaction`'s `assertUuid` is the second floor.
- An integration test asserts that a token whose tenant half is edited to another
  tenant's id returns 404 and reads nothing from that tenant.
  *Shipped:* `apps/api/test/invitations/capability-token.int-spec.ts` ("the prefix swap")
  in both directions, plus the concurrent-accept race, expiry, revocation, the tenant
  conflict with and without an active context, and the no-plaintext-on-the-row check.
- The raw token never enters a log line, a structured-log field, or an error message. That
  is ADR-0029's rule and it binds this process. It does not bind the address bar, browser
  history, the `Referer` header or a platform access log, none of which this process
  writes. Whoever builds the accept flow reads "Where the raw token actually travels" first
  and either picks a mechanism there or records that they did not. *Shipped:* mechanism A
  was picked (D-03); `MalformedCapabilityToken.message` and the five `DomainError`
  messages are fixed literals; the unit specs scan them.

## Not applied to email verification, deliberately

Better Auth owns `user`, `session`, `account` and `verification`. None carries
`tenant_id` and none has RLS (ADR-0003), so verifying an email touches no tenant-scoped
table and needs no tenant context. Verification tokens stay Better Auth's, unchanged.

## Versioning

The `<uuid>.<secret>` shape is parsed by one function. Changing it invalidates every
outstanding invitation, so a change means a migration that revokes them and a stated
reason.
