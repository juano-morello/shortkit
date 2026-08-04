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
| any | (deleted) | `DELETE /api/domains/:id` |

`verification_failed` and `certificate_failed` are distinct so AC-66 and AC-72 are
separately testable (TASK-038 requires this).

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
| hostname claimed by any tenant | 409 | `hostname_already_claimed` |
| domain of another tenant, by id | 404 | `not_found` (AC-69) |
| malformed hostname | 400 | `validation_failed` |

`hostname_already_claimed` **never discloses which tenant holds it** (AC-68). The
message is fixed: `"That hostname is already in use."` Uniqueness is a database
constraint (`UNIQUE (hostname)`), not a pre-check, so the race is closed.

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
3. A hostname is globally unique across tenants (AC-68).
4. `retry-certificate` is idempotent. Repeating it while `provisioning` is a no-op.
5. Deleting a domain stops it serving redirects for that tenant (AC-73). Fly's
   certificate deletion failing does not block the row deletion; the orphan is logged.

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
