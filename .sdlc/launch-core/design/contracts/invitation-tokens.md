# Contract: invitation capability tokens

- **Boundary:** anonymous callers to tenant-scoped data. The only sanctioned way a `@Public()` route obtains tenant context.
- **Normative form:** `apps/api/src/invitations/tokens/capability-token.ts` (stub: `design/stubs/apps/api/src/invitations/tokens/capability-token.ts`).
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

**The raw token is never stored, never logged, and never returned by any read.** It
exists once, in the invitation email body. The digest covers the secret half only; the
tenant id is already a column.

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

## Invariants a caller may rely on

1. Every statement runs under `set_config('app.tenant_id', ...)` and the ordinary
   `tenant_isolation` policy. **This is not a GC-5 escape**; `ISOLATION_EXCLUSIONS`
   stays at two.
2. A token is single-use. Replaying an accepted token creates no additional membership
   (AC-34).
3. Guessing a valid token requires guessing 32 random bytes. The tenant id half grants
   nothing on its own.
4. Digest comparison is constant time, so a timing oracle cannot recover the secret.
5. The raw token appears in exactly one place: the invitation email body.

## What the implementer must guarantee

- `findByCapabilityToken` is the only anonymous entry point. Adding a
  digest-skipping read is a defect, and TASK-056 asserts that every `@Public()` route
  touching a tenant-scoped table routes through a capability-token entry point.
- The tenant id is validated as a uuid **before** it reaches `set_config`. It arrives
  from an unauthenticated URL segment.
- An integration test asserts that a token whose tenant half is edited to another
  tenant's id returns 404 and reads nothing from that tenant.
- The raw token never enters a log line, a structured-log field, or an error message.

## Not applied to email verification, deliberately

Better Auth owns `user`, `session`, `account` and `verification`. None carries
`tenant_id` and none has RLS (ADR-0003), so verifying an email touches no tenant-scoped
table and needs no tenant context. Verification tokens stay Better Auth's, unchanged.

## Versioning

The `<uuid>.<secret>` shape is parsed by one function. Changing it invalidates every
outstanding invitation, so a change means a migration that revokes them and a stated
reason.
