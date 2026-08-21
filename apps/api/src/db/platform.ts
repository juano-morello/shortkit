/**
 * The platform tenant, its workspace, and the system default domain row.
 *
 * Contract: docs/contracts/redirect-resolution.md, domain-provisioning.md
 * ADR: adr-0063-platform-tenant-and-system-default-domain.md (normative),
 *      adr-0034-seed-contract.md, adr-0003-rls-policy-template-and-roles.md
 * Produced by: TASK-2-02 (D-2-06, D-2-07)
 *
 * ============================================================================
 * WHY THREE FIXED UUIDS EXIST AT ALL, AND WHY THIS FILE IS THE ONLY PLACE THEY DO
 * ============================================================================
 *
 * `domains` is a tenant-scoped table under the UNCHANGED template (ADR-0003): `tenant_id
 * uuid NOT NULL`, no nullable owner, no platform-owned escape hatch. The system default
 * hostname therefore has to be owned by SOME tenant, and D-2-06 chose a seeded platform
 * tenant over the alternatives (a nullable owner, a second table, a policy exception).
 * ADR-0063 records the comparison.
 *
 * The consequence a caller must know before writing a query: NO CUSTOMER TRANSACTION CAN
 * READ THE PLATFORM ROW. `domains_tenant_isolation` compares `tenant_id` against
 * `app.tenant_id`, and a customer's flag is never `PLATFORM_TENANT_ID`, so a `SELECT` for
 * the system default domain inside `withTenantTransaction(<a customer>)` returns zero
 * rows. That is correct and nothing needs it to be otherwise: link creation writes
 * `domain_id = SYSTEM_DEFAULT_DOMAIN_ID` and the FOREIGN KEY check that validates it runs
 * with row security BYPASSED (measured on 1b's 23503 behaviour, ADR-0062), so the
 * reference resolves without the row ever being visible. A repository test that "fixes"
 * the invisible row by widening a policy has turned D-2-06 into a leak.
 *
 * THE IDS ARE FROZEN, for ADR-0034's reason: they are in volumes on developer machines
 * and the seed has no delete path, so changing one means two platform tenants and a manual
 * cleanup. Version nibble 4 and variant nibble 8, so each passes any uuid validation the
 * code applies, and each is obviously synthetic to a human reading a row.
 *
 * THIS FILE IMPORTS NOTHING, and that is structural rather than tidy. `scripts/seed.mts`
 * imports it, and Node runs that by stripping the types with no build step, so anything
 * this file pulled in would have to survive the same treatment. It also means the redirect
 * module may import it without touching drizzle (GC-N).
 */

/** The tenant that owns the system default domain. `Shortkit platform`, seeded, never a signup. */
export const PLATFORM_TENANT_ID = '00000000-0000-4000-8000-00000000000f';
export const PLATFORM_TENANT_NAME = 'Shortkit platform';

/**
 * The platform tenant's one workspace. `domains.workspace_id` is `NOT NULL` and its
 * composite key names `(workspace_id, tenant_id)`, so the domain row needs a workspace in
 * the same tenant to point at; nothing else uses it and no operator is a member of it.
 */
export const PLATFORM_WORKSPACE_ID = '00000000-0000-4000-8000-00000000001f';
export const PLATFORM_WORKSPACE_NAME = 'Platform';

/**
 * The `domains` row every link references until item 3 lands tenant-owned domains.
 * Created directly in `active` (redirect-resolution.md step 2 resolves only `active`, and
 * `is_system_default` is what separates it from a customer domain that got there by
 * proving DNS ownership).
 */
export const SYSTEM_DEFAULT_DOMAIN_ID = '00000000-0000-4000-8000-00000000002f';

/**
 * What `SYSTEM_DEFAULT_DOMAIN` means when it is not set. D-2-02: `localhost`, with short
 * links shown as `http://localhost:3001/<slug>`, the API's published compose port, because
 * the redirect serves on the SAME process and port as the API (ADR-0006, one deployable).
 *
 * A default rather than a boot refusal, unlike `CLICK_IP_HASH_KEY` (D-2-17): an absent
 * hostname produces a working local stack, not a silently weaker security property.
 */
export const DEFAULT_SYSTEM_DEFAULT_DOMAIN = 'localhost';

/**
 * `redirect-resolution.md` decision order, step 1: lowercase, IDNA via `new URL()`, strip
 * the port. The STORED hostname is the normalised one and so is every cache key built from
 * a request's `Host`, which is what stops a unicode homograph or a `:3001` suffix producing
 * two rows or two keys for one hostname (`domain-provisioning.md`, "Normalisation happens
 * once, at validation").
 *
 * `new URL()` does the IDNA work and drops the port for us. It throws on input that is not
 * a hostname at all, and this function lets that throw: the seed refusing loudly beats the
 * seed writing a row the redirect can never match.
 */
export function normaliseHostname(input: string): string {
  return new URL(`https://${input.trim().toLowerCase()}`).hostname;
}

/**
 * The hostname the seeded system default domain carries, read from the environment the
 * same way in the seed and in the API (GC-B: nothing here consults `NODE_ENV`).
 */
export function systemDefaultHostname(
  env: Readonly<Record<string, string | undefined>>,
): string {
  const declared = env.SYSTEM_DEFAULT_DOMAIN;

  return normaliseHostname(
    declared === undefined || declared.trim() === ''
      ? DEFAULT_SYSTEM_DEFAULT_DOMAIN
      : declared,
  );
}
