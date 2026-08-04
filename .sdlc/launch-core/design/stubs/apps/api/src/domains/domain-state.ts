/**
 * Contract: design/contracts/domain-provisioning.md
 * ADR: adr-0016-domain-provisioning.md
 * Produced by: TASK-038 (states, schema), TASK-039 (verification), TASK-042 (certificates)
 */

export const DOMAIN_STATES = [
  'pending_verification',
  'verified',
  'provisioning',
  'active',
  'verification_failed',
  'certificate_failed',
] as const;

export type DomainState = (typeof DOMAIN_STATES)[number];

/**
 * `verified` is TRANSIENT. The reconciler moves out of it in the same tick, which is
 * what makes SC-4's "no manual step" hold. A domain observed sitting in `verified`
 * is a defect.
 *
 * Any transition not listed is rejected by transitionState and logged.
 */
export const ALLOWED_TRANSITIONS: Record<DomainState, readonly DomainState[]> = {
  pending_verification: ['verified', 'verification_failed'],
  verification_failed: ['pending_verification', 'verified'],
  verified: ['provisioning'],
  provisioning: ['active', 'certificate_failed'],
  certificate_failed: ['provisioning'],
  active: [],
};

export interface RequiredDnsRecord {
  readonly type: 'CNAME' | 'TXT';
  readonly name: string;
  readonly value: string;
}

export interface DnsDiagnostic {
  readonly type: 'CNAME' | 'TXT';
  readonly name: string;
  readonly expected: string;
  /** Every value found. ALWAYS present; an empty array means no record (AC-66). */
  readonly observed: string[];
  readonly ok: boolean;
}

export interface VerificationResult {
  readonly verified: boolean;
  /** Carries a diagnostic for EVERY required record, not only the failing one. */
  readonly diagnostics: DnsDiagnostic[];
}

/**
 * 1. CNAME  <hostname>                      -> <FLY_APP_NAME>.fly.dev
 * 2. TXT    _shortkit-verify.<hostname>     -> shortkit-domain-verification=<token>
 *
 * The TXT is ours, which is what makes AC-66's expected-vs-observed testable against
 * FakeDnsResolver and what makes AC-68's global hostname uniqueness meaningful.
 */
export function requiredDnsRecords(_domain: {
  hostname: string;
  verificationToken: string;
}): RequiredDnsRecord[] {
  throw new Error('not implemented');
}

export function verifyDomain(_domainId: string): Promise<VerificationResult> {
  throw new Error('not implemented');
}

/** FakeDnsResolver implements this. NO TEST PERFORMS A REAL DNS LOOKUP. */
export interface DnsResolver {
  resolveCname(name: string): Promise<string[]>;
  resolveTxt(name: string): Promise<string[]>;
}

export interface CertificateStatus {
  readonly state: DomainState;
  readonly reason: string | null;
}

export function certificateStatus(_domainId: string): Promise<CertificateStatus> {
  throw new Error('not implemented');
}

/** AC-70 asserts against this number. */
export const PROVISIONING_WINDOW_MS = 15 * 60 * 1000;

/**
 * Redis ZSET, NOT a Postgres table. That is what keeps the reconciler from reading
 * across tenants and keeps SC-1's exclusion count at exactly two (ADR-0016).
 * Members are `<tenantId>:<domainId>`; the score is runAfter in epoch ms.
 * ZREM returning 1 is the claim, which makes multi-machine operation safe.
 */
export const DOMAIN_WORK_QUEUE_KEY = 'domain:work';

export const RECONCILE_BACKOFF_MS: Record<DomainState, number | null> = {
  pending_verification: 30_000,
  verification_failed: 300_000,
  verified: 0,
  provisioning: 15_000,
  certificate_failed: null, // manual retry only
  active: null,
};
