# Contract: domain state machine, DNS verification, and certificate provisioning

- **Boundary:** the domain lifecycle, shared by schema, verification, endpoints, the reconciler, and the UI.
- **Normative form:** `apps/api/src/domains/domain-state.ts` and `packages/contracts/src/domains/index.ts` (stub: `design/stubs/apps/api/src/domains/domain-state.ts`).
- **Produced by:** TASK-038 (schema, state), TASK-039 (verification), TASK-042 (certificates, reconciler).
- **Consumed by:** TASK-040, 041, 043, 044.
- **ADRs:** ADR-0016.

## States

```ts
export const DOMAIN_STATES = [
  'pending_verification', 'verified', 'provisioning',
  'active', 'verification_failed', 'certificate_failed',
] as const;
export type DomainState = (typeof DOMAIN_STATES)[number];
```

`verified` is **transient**. The reconciler moves out of it in the same tick, which is
what makes SC-4's "no manual step" hold. A domain observed sitting in `verified` is a
defect.

## Transitions

Normative. Any transition not listed is rejected by `transitionState` and logged.

| From | To | Trigger |
|---|---|---|
| (create) | `pending_verification` | `POST /api/domains` |
| `pending_verification` | `verified` | both DNS records correct |
| `pending_verification` | `verification_failed` | a record absent or wrong |
| `verification_failed` | `pending_verification` | reconciler backoff, 5 min |
| `verification_failed` | `verified` | records corrected |
| `verified` | `provisioning` | reconciler, same tick, automatic |
| `provisioning` | `active` | Fly reports the certificate issued |
| `provisioning` | `certificate_failed` | 15 min elapsed, or a non-quota Fly error |
| `certificate_failed` | `provisioning` | `POST /api/domains/:id/retry-certificate` |
| `pending_verification`, `verification_failed` | (deleted) | reconciler, `created_at` older than 7 days (F-010, unverified claim expiry) |
| any | (deleted) | `DELETE /api/domains/:id` |

A transition into `verified` that violates `domains_hostname_owned_unique` moves the row
to `verification_failed` with `last_error = 'hostname_claimed_elsewhere'` instead.

`verification_failed` and `certificate_failed` are distinct so AC-66 and AC-72 are
separately testable (TASK-038 requires this).

## Hostname validation and reserved hostnames

Added 2026-08-04 (F-003). `hostname` was a bare `z.string()`, so any account could claim
Shortkit's own hostnames.

```ts
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;   // RFC 1123

export const hostnameContract = z.string()
  .min(4).max(253)
  .transform((h) => h.trim().toLowerCase())
  .transform((h) => new URL(`https://${h}`).hostname)      // IDNA / punycode
  .refine((h) => h.split('.').length >= 2)
  .refine((h) => h.split('.').every((l) => LABEL.test(l)))
  .refine((h) => !isIpLiteral(h))
  .refine((h) => !isReservedHostname(h));
```

Normalisation happens **once, at validation**, and the stored value is the normalised
one. The same normalised form is what `redirect-cache.md` keys on, so a unicode
homograph cannot produce two rows or two cache keys for one hostname.

**Reserved hostnames**, rejected at `POST /api/domains` with 400 `validation_failed`:

| Pattern | Reason |
|---|---|
| the apex domain and its `www` | the marketing surface |
| the API hostname | the API surface |
| `*.fly.dev`, `*.vercel.app`, `*.upstash.io`, `*.neon.tech` | platform hostnames; claiming one serves attacker content from an origin the platform assigns us |
| `localhost`, `*.localhost`, `*.local`, `*.internal` | resolve inside a network, not on the internet |
| any IPv4 or IPv6 literal | not a hostname; cannot carry a certificate we provision |
| the seeded system default domain | already `active` and owned by the platform |

The list lives in `packages/contracts/src/domains/reserved-hostnames.ts`, beside the
reserved slugs, and is imported rather than redeclared.

**This is the second of two independent defences.** The first is that
`resolveHost` serves only `state = 'active'` (`redirect-resolution.md`), so even a
reserved hostname that slipped through would have to pass DNS verification on a zone the
attacker does not control.

## Required DNS records

```ts
export interface RequiredDnsRecord {
  readonly type: 'CNAME' | 'TXT';
  readonly name: string;
  readonly value: string;
}
export declare function requiredDnsRecords(domain: DomainRow): RequiredDnsRecord[];
```

| # | type | name | value |
|---|---|---|---|
| 1 | `CNAME` | `<hostname>` | `<FLY_APP_NAME>.fly.dev` |
| 2 | `TXT` | `_shortkit-verify.<hostname>` | `shortkit-domain-verification=<verification_token>` |

`verification_token` is 32 bytes of `crypto.randomBytes` in base64url, generated at
domain creation, stable for the domain's life.

## Verification result

```ts
export interface DnsDiagnostic {
  readonly type: 'CNAME' | 'TXT';
  readonly name: string;
  readonly expected: string;
  readonly observed: string[];   // every value found; empty array means no record
  readonly ok: boolean;
}
export interface VerificationResult {
  readonly verified: boolean;
  readonly diagnostics: DnsDiagnostic[];
}
export declare function verifyDomain(domainId: string): Promise<VerificationResult>;

export interface DnsResolver {
  resolveCname(name: string): Promise<string[]>;
  resolveTxt(name: string): Promise<string[]>;
}
```

`observed` is always present, including when empty. AC-66 requires the value actually
observed, and an absent record is `[]`, which the UI renders as "no record found"
rather than omitting the row.

`FakeDnsResolver` implements `DnsResolver`. **No test performs a real DNS lookup.**
Production resolves over DNS-over-HTTPS against two independent resolvers and treats a
record as present when either sees it, which reduces single-resolver cache effects.
Propagation delay is `verification_failed` with a retry, never a terminal state.

## Endpoints

| Method | Path | Role | Notes |
|---|---|---|---|
| `POST` | `/api/domains` | `workspace_admin` | returns `pending_verification` plus `requiredRecords` (AC-65) |
| `GET` | `/api/domains` | `viewer` | re-enqueues non-terminal domains (self-heal, ADR-0016) |
| `DELETE` | `/api/domains/:id` | `workspace_admin` | releases the Fly binding (AC-73) |
| `POST` | `/api/domains/:id/verify` | `workspace_admin` | enqueues immediately |
| `POST` | `/api/domains/:id/retry-certificate` | `workspace_admin` | safe to repeat (AC-72) |

```ts
export const domainContract = z.object({
  id: z.string().uuid(),
  hostname: z.string(),
  state: z.enum(DOMAIN_STATES),
  requiredRecords: z.array(requiredDnsRecordContract),
  diagnostics: z.array(dnsDiagnosticContract),
  lastError: z.string().nullable(),
  lastCheckedAt: z.string().datetime().nullable(),
});
```

## Errors

| Condition | Status | Code |
|---|---|---|
| hostname held by any tenant in `verified`, `provisioning` or `active` | 409 | `hostname_already_claimed` |
| hostname held by any tenant in `pending_verification` or `verification_failed` | the normal create response | none; the claim is created and coexists |
| domain of another tenant, by id | 404 | `not_found` (AC-69) |
| malformed or reserved hostname | 400 | `validation_failed` |

`hostname_already_claimed` **never discloses which tenant holds it** (AC-68). The
message is fixed: `"That hostname is already in use."`

### What the 409 is allowed to disclose

Added 2026-08-05 (F-097). `POST /api/domains` is unauthenticated as far as the target
hostname is concerned: any user with a free workspace can post candidate hostnames and
read the status. So the 409 is an existence oracle, and the rule is that it may only
answer for a state whose existence is **already public without this endpoint**.

The first two rows above are that rule. The 409 states are exactly the predicate of
`domains_hostname_owned_unique`, and reaching any of them requires a `CNAME` from the
hostname's own zone to `<FLY_APP_NAME>.fly.dev`, which is a public DNS record; `active`
additionally puts the hostname in a Certificate Transparency log. A DNS query for the
candidate hostname answers the same question, without an account and without a rate
limit. The 409 therefore discloses nothing the attacker could not read more cheaply.

`pending_verification` and `verification_failed` are the opposite case. Nothing about
those rows is publicly observable, so a 409 on them would be a genuine cross-tenant
oracle over hostnames nobody has proved control of. The F-010 revision below already
requires those claims to coexist, which is what keeps this true; the row above states it
as an error-surface rule so a TASK-040 implementer meets it where the status codes are.

**This is the disclosure the product accepts, not an oversight.** AC-68 requires the
rejection, so the bit cannot be removed without changing the AC. What is pinned here is
that the bit is all of it: no tenant id, no workspace name, no timestamp, no part of the
conflicting row, and no `details` on the envelope (`error-envelope.md` invariant 10, now
enforced at the filter by ADR-0026). The enumeration rate is bounded by the write rate
limit in `rate-limit.md`, which is the same bound the F-010 squatting analysis used.

**Residual, accepted: the DNS equivalence is checked at verification time, not at 409
time.** Added 2026-08-05 (`sdlc-security-auditor`, round 2 on F-097). A row that reached
`verified` or `provisioning` and whose owner then removed the `CNAME` keeps answering 409
after the public evidence is gone, so for that window the endpoint answers a question DNS
no longer does. The window is short by construction: `verified` is transient, and
invariant 1 moves a row out of `provisioning` within 15 minutes, to `active` or to
`certificate_failed`, and `certificate_failed` is not a 409 state. The one case where the
bound is not hard is a `fly_quota:` backoff, which holds a row in `provisioning` past the
window. `active` needs no window at all: its hostname is in a Certificate Transparency
log whatever happens to the zone afterwards.

Re-checking DNS on each conflict would close this. It buys a bit that was public minutes
earlier, and it costs a network call and a failure mode on a write path, so it is not
worth it. What would force it: a state that answers 409 with no bounded lifetime, or a
decision to leave stale `verified` rows in place rather than expiring them. If F-102
reopens AC-68 and the DNS-proof ordering is adopted, this residual disappears along with
the rule that creates it.

The security auditor's suggested alternative, answering 409 only after the caller has
proved control of the hostname by DNS, was not adopted: it contradicts AC-68's literal
text, which asserts a rejection at the point tenant A adds a hostname tenant B has
verified. Changing an AC is Juano's call, not this contract's. The alternative is worth
raising if AC-68 is ever reopened, and the fact that it is worth raising is why the
argument above is written out rather than assumed.

## Uniqueness: first to *verify* wins

Revised 2026-08-04 (F-010). The contract previously enforced `UNIQUE (hostname)` at
creation, before any proof of ownership, which is stricter than AC-68 and made
hostname squatting trivial: an attacker rate-limited only at 120 writes a minute could
claim roughly 172,000 hostnames a day, and every real owner would meet a permanent 409
with no support path and no way to tell a squat from a genuine pending claim.

```sql
CREATE UNIQUE INDEX domains_hostname_owned_unique
  ON domains (hostname)
  WHERE state IN ('verified', 'provisioning', 'active');
```

- Unverified claims **coexist**. Any number of tenants may hold the same hostname in
  `pending_verification` or `verification_failed`.
- The conflict is raised at the **transition into `verified`**, not at creation. Only
  the tenant who can place our TXT record in the zone can get there, and there is one
  zone, so at most one wins. A losing transition catches `23505` and moves that row to
  `verification_failed` with `last_error = 'hostname_claimed_elsewhere'`.
- **Unverified claims expire after 7 days.** The reconciler deletes any domain still in
  `pending_verification` or `verification_failed` whose `created_at` is older than
  `UNVERIFIED_CLAIM_TTL_DAYS`, so an abandoned or malicious claim does not accumulate.
- A hostname in `active` is genuinely exclusive, which is what AC-68 asserts.

This composes with `redirect-resolution.md`'s `state = 'active'` predicate: a squatted
row never serves traffic even while it exists.

## The work queue

```
ZADD domain:work <runAfterEpochMs> "<tenantId>:<domainId>"
```

Redis, not Postgres, so the reconciler never reads across tenants and SC-1's exclusion
count stays at two. Claim is `ZRANGEBYSCORE ... LIMIT 0 20` then `ZREM`; `ZREM`
returning 1 is the claim, which makes multi-machine operation safe. All Postgres work
runs inside `withTenantTransaction(tenantId, ...)`.

Backoff written into the score: `pending_verification` 30 s, `verification_failed`
5 min, `provisioning` 15 s, `certificate_failed` never.

Tick: `@nestjs/schedule`, every 30 s, in the API process. No second deployable (GC-7).

## Provisioning window

**15 minutes** from the `verified` transition. AC-70 asserts against this number.
Exceeding it moves the domain to `certificate_failed` with Fly's last error verbatim in
`last_error`.

Fly quota or rate-limit responses map to `last_error` prefixed `fly_quota:` and keep
the domain in `provisioning` with a 5-minute backoff, because a quota is transient and
a wrong DNS record is not.

## Invariants a caller may rely on

1. A domain reaching `verified` becomes `active` or `certificate_failed` within 15
   minutes, with no human action (SC-4, AC-70).
2. A verification failure always names type, name, expected and observed for **every**
   required record, not only the failing one (AC-66).
3. A hostname is unique across tenants **once verified** (AC-68). Unverified claims may
   coexist and expire after 7 days.
4. `retry-certificate` is idempotent. Repeating it while `provisioning` is a no-op.
5. Deleting a domain stops it serving redirects for that tenant (AC-73). Fly's
   certificate deletion failing does not block the row deletion; the orphan is logged.
6. **A domain serves traffic only in `active`.** Creating a row grants nothing; the
   redirect path filters on state (`redirect-resolution.md`).
7. A reserved hostname, an IP literal, and a malformed hostname are all rejected at
   creation with 400, so none reaches the redirect path in any state.
8. The stored hostname is already normalised (lowercased, IDNA), so it matches the Redis
   key form exactly.

## Accepted gap, stated

The queue is not durable. A Redis flush drops pending work; recovery depends on a
tenant opening `/domains`, which re-enqueues. A domain nobody looks at can stall.

## What the implementer must guarantee

- Confirm Fly's certificate quota behaviour before TASK-042 dispatches
  (`refinement.md` Risks).
- `docs/architecture/domain-provisioning.md` records the 15-minute window, the two
  records, and the state diagram. TASK-043 extends it with the live flow.
- TASK-038, 039, 040 and 041 are **not apex-blocked**. Only TASK-042, 043 and 044 are.

## Versioning

`DomainState` values are persisted strings. Adding one requires a UI case in TASK-044
and a row in the transition table. Renaming one is a data migration.
