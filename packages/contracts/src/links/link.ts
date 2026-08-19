/**
 * Contract: docs/contracts/slug.md, error-envelope.md, redirect-resolution.md,
 *           link-mutation-events.md
 * ADR: adr-0005-contract-distribution.md, adr-0009-expiry-eviction.md,
 *      adr-0025-zod-error-recognition-in-contracts.md
 * Produced by: TASK-2-01
 *
 * The five link endpoints, declared once and read by both deployables (D-2-12):
 *
 *   POST   /api/links                 createLinkContract  -> 201 linkContract
 *   GET    /api/links?workspaceId=    paginationQuery     -> 200 paginated(linkContract)
 *   GET    /api/links/:linkId         (no body)           -> 200 linkContract
 *   PATCH  /api/links/:linkId         updateLinkContract  -> 200 linkContract
 *   DELETE /api/links/:linkId         (no body)           -> 200 linkContract
 *
 * THIS PACKAGE MAY IMPORT `zod` AND NOTHING ELSE (ADR-0005).
 *
 * ============================================================================
 * EVERY TIMESTAMP ON THE WIRE IS AN ISO STRING. ONE CONVENTION, PACKAGE-WIDE.
 * ============================================================================
 *
 * Ruled 2026-08-19, during TASK-2-01. The card specified `z.coerce.date()` while also
 * saying "matching the workspace contract's convention" — and those are two different
 * things: `workspaceContract` and `invitationContract` both ship `createdAt`,
 * `updatedAt` and `archivedAt` as `z.string().datetime()`, with the API mapping
 * `Date -> toISOString()` at the service boundary (`toClientWorkspace`). The convention
 * clause wins over the mechanism clause. A second date convention inside one contracts
 * package is the comprehension hazard this repo keeps filing findings about, and a link
 * is not special enough to earn one: the operator SETS these two timestamps and the
 * redirect READS them, but so does every other consumer of every other timestamp here.
 *
 * So: responses carry ISO strings, requests accept and validate ISO strings, and the
 * `Date` boundary sits where it already sat for workspaces — in the service, on both
 * sides of the contract.
 *
 * The one place a `Date` survives is `isLinkActive`, which accepts `Date | string | null`
 * per bound precisely so BOTH callers work unchanged: the redirect path hands it the
 * row's real `Date`s straight from drizzle, and the screens hand it the wire's ISO
 * strings. See `is-link-active.ts`.
 *
 * ============================================================================
 * `destinationUrl` IS PARSED ON THE WAY IN AND PERMISSIVE ON THE WAY OUT.
 * ============================================================================
 *
 * Requests run `destinationUrlContract`. `linkContract` — a RESPONSE shape — declares
 * plain `z.string()`, per the rule `invitations/index.ts` states: the server produced
 * the value from a row it already accepted, and a client-side parse must not refuse it.
 * Re-running the URL parse on a response would also make a row stored before any future
 * rule change unreadable by a current client, for no gain.
 */
import { z } from 'zod';

import { idContract } from '../pagination';

/**
 * The 302's `Location` is the stored value BYTE FOR BYTE (AC-2-14), so whatever reaches
 * this column can be served from the platform's own origin to an anonymous visitor. That
 * puts `destination_url` in the F-006 class alongside `fallbackUrl`: `javascript:` and
 * `data:` must be UNSTORABLE, not merely unrendered.
 *
 * ============================================================================
 * `new URL()`, NOT A REGEX. THE PARSER IS THE POINT (D-2-08).
 * ============================================================================
 *
 * The WHATWG parser strips tabs, newlines and leading C0/space before it reads the
 * scheme, so `java\nscript:alert(1)` and `' javascript:alert(1)'` both resolve to
 * protocol `javascript:` and are refused here. A regex written against the raw string
 * sees neither. `links.spec.ts` carries both as cases.
 *
 * `http:` is admitted alongside `https:`: a shortener's targets are other people's URLs
 * and plenty are still plain HTTP. `branding.md`'s https-only rationale is about assets
 * the platform embeds in its own page and does not transfer.
 *
 * THE STORED VALUE IS `u.href`, NEVER THE RAW INPUT. Parsing normalises the scheme and
 * host casing and supplies an empty path, so `HTTP://Example.COM` is stored once, as
 * `http://example.com/`, and "byte-identical to the stored destination" is a claim about
 * one canonical string rather than about whatever an operator pasted.
 *
 * ============================================================================
 * THE BINDING LENGTH CHECK IS ON `href`, NOT ON THE INPUT (fixed 2026-08-19).
 * ============================================================================
 *
 * Bounding only the raw input does not bound what gets STORED, because `new URL`
 * percent-encodes every non-ASCII character on the way to `href` and one code point can
 * become up to nine characters. Measured: a 2048-character input of
 * `https://example.com/` followed by `é` repeats yields an `href` of 12,188 characters —
 * a 6x blow-up that passes a raw-input bound. `links.destination_url` is unbounded
 * `text`, so nothing downstream catches it either, and the `Location` header served to
 * every anonymous visitor inherits the whole thing.
 *
 * So the bound is applied TWICE, and the second one is the one that binds: the pre-parse
 * `.max()` is a cheap early-out that keeps `new URL` from parsing a multi-megabyte
 * string, and the post-transform check on `parsed.href.length` is what actually
 * guarantees the stored value fits. Both report the same message, so a client sees one
 * "too long" answer whichever bound tripped.
 */
export const DESTINATION_URL_MAX_LENGTH = 2048;

export const DESTINATION_URL_INVALID_MESSAGE = 'Enter a valid URL.';
export const DESTINATION_URL_SCHEME_MESSAGE =
  'A destination must be an http:// or https:// URL.';
export const DESTINATION_URL_TOO_LONG_MESSAGE =
  `A destination must be ${DESTINATION_URL_MAX_LENGTH} characters or fewer once normalised.`;

export const destinationUrlContract = z
  .string()
  .max(DESTINATION_URL_MAX_LENGTH, DESTINATION_URL_TOO_LONG_MESSAGE)
  .transform((value, ctx) => {
    let parsed: URL;

    try {
      parsed = new URL(value);
    } catch {
      ctx.addIssue({ code: 'custom', message: DESTINATION_URL_INVALID_MESSAGE });

      return z.NEVER;
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      ctx.addIssue({ code: 'custom', message: DESTINATION_URL_SCHEME_MESSAGE });

      return z.NEVER;
    }

    // The bound that actually binds: `href` is what is stored and what the 302 serves,
    // and percent-encoding can multiply the input's length several times over.
    if (parsed.href.length > DESTINATION_URL_MAX_LENGTH) {
      ctx.addIssue({ code: 'custom', message: DESTINATION_URL_TOO_LONG_MESSAGE });

      return z.NEVER;
    }

    return parsed.href;
  });

export type DestinationUrl = z.infer<typeof destinationUrlContract>;

/**
 * The client shape of one link (D-2-19).
 *
 * `tenantId` is absent for the reason `workspaceContract` gives: the caller is already
 * inside their own tenant, so the id tells them nothing they can act on.
 *
 * `hostname` IS PRESENT and denormalised by the service from `SYSTEM_DEFAULT_DOMAIN`,
 * matching `LinkSnapshot.hostname` in `link-mutation-events.md` — the field the cache
 * invalidator keys `rdr:v1:{hostname}:{slug}` on with no lookup. Sending it now is what
 * keeps item 3's multi-domain rows from changing this wire shape.
 */
export const linkContract = z.object({
  id: idContract,
  workspaceId: idContract,
  domainId: idContract,
  hostname: z.string(),
  slug: z.string(),
  destinationUrl: z.string(),
  expiresAt: z.string().datetime().nullable(),
  activatesAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
});

export type Link = z.infer<typeof linkContract>;

/**
 * Refused: an activation instant at or after the expiry instant. Equal is refused too —
 * the window would be empty and the link would never serve.
 *
 * The check only sees the fields in ONE body. A PATCH naming `activatesAt` alone cannot
 * be compared against a stored `expires_at` by a schema that never reads the row; that
 * comparison belongs to the route (TASK-2-05), against the pre-image it already loads to
 * build `onLinkMutated`'s `before`.
 */
export const LINK_WINDOW_MESSAGE = 'The activation time must be before the expiry time.';

function hasOrderedWindow(input: {
  readonly expiresAt?: string | null;
  readonly activatesAt?: string | null;
}): boolean {
  if (
    input.expiresAt === null ||
    input.expiresAt === undefined ||
    input.activatesAt === null ||
    input.activatesAt === undefined
  ) {
    return true;
  }

  const activatesAt = Date.parse(input.activatesAt);
  const expiresAt = Date.parse(input.expiresAt);

  // A field that already failed `.datetime()` still reaches this refinement — measured
  // on zod 4.4.3, where an object-level `.refine` runs even when a field produced an
  // issue. `NaN < NaN` is false, so without this guard a malformed timestamp would
  // report the window message ON TOP of its own, and a form would show two errors for
  // one typo. The field's issue is the true one; say nothing further.
  if (Number.isNaN(activatesAt) || Number.isNaN(expiresAt)) {
    return true;
  }

  return activatesAt < expiresAt;
}

/**
 * An ISO 8601 instant, as every other timestamp in this package declares it. UTC `Z`
 * only, which is what `Date.prototype.toISOString` produces on both sides of the wire;
 * the operator's local timezone is a rendering concern (D-2-18), not a transport one.
 */
const linkTimestampContract = z.string().datetime();

/**
 * The unrefined shape the two wire contracts are built from. NOT ITSELF A WIRE SHAPE.
 *
 * It is exported only because zod 4.4.3 refuses `.omit()` and `.partial()` on an object
 * carrying a refinement — measured: `.omit() cannot be used on object schemas containing
 * refinements`. So `updateLinkContract` cannot be `createLinkContract.omit(...)` as the
 * card wrote it; the base is derived first and the same refinement is applied to both,
 * which keeps one source for the field set and one for the window rule.
 */
export const createLinkBaseContract = z.object({
  workspaceId: idContract,
  /**
   * PRESENCE AND TYPE ONLY. Slug VALIDITY is `validateSlug`'s at the route: AC-2-2 fixes
   * five violations in a deterministic order and puts the violation itself in
   * `details.fieldErrors.slug`, which zod cannot reproduce. Duplicating the rule here
   * would give one message two sources of truth. A reserved slug therefore PASSES this
   * schema and is refused by the handler.
   */
  slug: z.string().optional(),
  destinationUrl: destinationUrlContract,
  /**
   * Optional AND nullable: absent means "leave it alone", `null` means "clear it". A
   * PATCH removing an expiry has no other way to say so, and create treats the two
   * alike.
   */
  expiresAt: linkTimestampContract.nullable().optional(),
  activatesAt: linkTimestampContract.nullable().optional(),
});

/**
 * `POST /api/links`. `WORKSPACE_ROLE.member` on `body.workspaceId` (Form A, D-2-12).
 *
 * There is NO `domainId` field. Every link created in item 2 lands on
 * `SYSTEM_DEFAULT_DOMAIN_ID`; a field nobody can use yet is a field to misdesign later,
 * so item 3 adds it when custom domains exist.
 */
export const createLinkContract = createLinkBaseContract.refine(hasOrderedWindow, {
  message: LINK_WINDOW_MESSAGE,
  path: ['activatesAt'],
});

export type CreateLinkRequest = z.infer<typeof createLinkContract>;

/**
 * `PATCH /api/links/:linkId`. `WORKSPACE_ROLE.member` (Form B, D-2-12).
 *
 * Patchable: `destinationUrl`, `slug`, `expiresAt`, `activatesAt`. `workspaceId` is
 * omitted — a link does not change workspace through this route — and an empty patch is
 * valid: it answers 200 and still fires `onLinkMutated` with `before` deep-equal to
 * `after` (`link-mutation-events.md`'s firing rule, AC-2-7).
 */
export const updateLinkContract = createLinkBaseContract
  .omit({ workspaceId: true })
  .partial()
  .refine(hasOrderedWindow, { message: LINK_WINDOW_MESSAGE, path: ['activatesAt'] });

export type UpdateLinkRequest = z.infer<typeof updateLinkContract>;
