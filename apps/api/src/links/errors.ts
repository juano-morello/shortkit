/**
 * Contract: docs/contracts/error-envelope.md ("How an error carries its code to the
 *           filter", invariant 10), slug.md ("Error mapping")
 * ADR: adr-0024-domain-error-transport.md
 * Produced by: TASK-2-05
 *
 * The link module's named refusals, in the feature's own directory, as
 * `error-envelope.md` requires: there is no central catalogue and no TASK edits a shared
 * file to add an error.
 */
import { DomainError, INTERNAL_ERROR_MESSAGE } from '../common/errors/domain-error';

/**
 * 409 `slug_taken`. THE MESSAGE IS FIXED AND THERE IS NO `details` (AC-2-3).
 *
 * `domain-error.ts`'s illustrative sketch interpolates the slug; AC-2-3 does not, and it
 * wins. The disclosure bound `error-envelope.md` invariant 10 accepts here is ONE BIT,
 * that some tenant holds this slug on the shared system default domain, and a message
 * naming the value would not add to it, but a `details` shape would invite a client to
 * branch on it and a future edit to put the holder in it. The caller supplied the slug;
 * it is on their own form.
 */
export class SlugTakenError extends DomainError {
  constructor() {
    super('slug_taken', 'That short code is already taken.');
  }
}

/**
 * 500 `slug_generation_exhausted`. `SLUG_GENERATION_MAX_ATTEMPTS` draws all lost the race
 * on `links_domain_id_slug_unique`.
 *
 * At 57^7 ≈ 1.95e12 codes per domain this is not reachable by chance, so it means the
 * domain is saturated or the generator is not drawing randomly. The caller can still act
 * on it (retrying is exactly right), which is why the message says so rather than being
 * `INTERNAL_ERROR_MESSAGE`.
 */
export class SlugGenerationExhaustedError extends DomainError {
  constructor() {
    super(
      'slug_generation_exhausted',
      'A short code could not be generated. Please try again.',
    );
  }
}

/**
 * 404 `not_found`, for an id naming no link THE CURRENT TENANT OWNS. Another tenant's
 * link, a deleted one, and a non-uuid all get this same answer (envelope invariant 5,
 * AC-2-6). The message carries no id: the one the caller supplied may be another
 * tenant's.
 */
export class LinkNotFoundError extends DomainError {
  constructor() {
    super('not_found', 'Link not found.');
  }
}

/**
 * 500, with the SAME body every other unhandled 500 carries.
 *
 * ============================================================================
 * WHAT IT MEANS, AND WHY IT IS NOT LEFT AS AN UNMAPPED DRIVER ERROR.
 * ============================================================================
 *
 * `links` names its domain as a PAIR (ADR-0063 as amended 2026-08-19): `(domain_id,
 * domain_tenant_id) REFERENCES domains (id, tenant_id)` plus `links_domain_owner_check`,
 * which narrows the admitted pairs to the row's own tenant and the platform default. A
 * bug in the create path therefore surfaces as 23503 or 23514 (the database refusing)
 * rather than as a link on another tenant's domain, and that is the whole point of the
 * two constraints.
 *
 * The reachable cause is a stack whose PLATFORM SEED NEVER RAN: no `domains` row carries
 * `SYSTEM_DEFAULT_DOMAIN_ID`, so every create is refused 23503 (F-236 is the reason a
 * migration cannot write that row). The unreachable one is a create path that wrote a
 * pair the check refuses, which is a defect in this module.
 *
 * Naming the class is what makes either legible: `err_name` on the log line is
 * `LinkDomainUnavailableError` and the operator knows to run the seed, where an unmapped
 * `DrizzleQueryError` gives them a stack through a driver they did not write. The body is
 * `INTERNAL_ERROR_MESSAGE` verbatim, so a client cannot tell this 500 from any other one:
 * the diagnosis is the operator's and the caller can do nothing with it.
 */
export class LinkDomainUnavailableError extends DomainError {
  constructor(cause: unknown) {
    super('internal_error', INTERNAL_ERROR_MESSAGE, { cause });
  }
}
