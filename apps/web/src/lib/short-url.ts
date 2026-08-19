/**
 * TASK-2-13 (STORY-2-10; the copyable short URL AC-2-48 shows and AC-2-51 bounds).
 *
 * Contract: docs/contracts/redirect-resolution.md (what the composed URL reaches),
 *   docs/contracts/web-api-client.md (what it may NOT be used for).
 * ADR: adr-0006-http-surface-partitioning.md (one deployable, the redirect outside the
 *   `/api` prefix, which is why this origin is the API's and not this app's),
 *   adr-0007-short-code-generation.md (slugs are case-sensitive).
 * Decision: D-2-02 (ruled 2026-08-19), D-2-18.
 *
 * ============================================================================
 * DISPLAY AND COPY ONLY. THIS IS NEVER A FETCH TARGET (AC-2-51).
 * ============================================================================
 *
 * Every request the screens issue goes through `apiClient` to the same-origin BFF at
 * `/api/bff/...` (ADR-0014). What this module builds is the string an operator reads,
 * copies and pastes into a browser: `http://localhost:3001/<slug>` in compose, the real
 * short domain in a deployment. Handing it to `fetch` would be a cross-origin call to the
 * redirect surface from a screen, which is the one thing AC-2-51 rules out.
 *
 * ============================================================================
 * THE ORIGIN IS A PARAMETER, NOT AN AMBIENT READ.
 * ============================================================================
 *
 * `SHORT_LINK_ORIGIN` carries no `NEXT_PUBLIC_` prefix, deliberately (the pair of rules in
 * `apps/web/.env.example`): it is read at request time on the server, never inlined into a
 * client bundle. So `shortUrl` takes the origin rather than reading it, and
 * `shortLinkOrigin()` is the one read, called from a server component that passes the
 * value down as a prop. A client component that called `shortLinkOrigin()` would find
 * `process.env.SHORT_LINK_ORIGIN` undefined in the browser and throw at render, which is
 * the defect this split makes impossible to write by accident.
 */

/**
 * The variable's name, for the spec and for any error copy that has to say it out loud.
 * The read below is a LITERAL `process.env.SHORT_LINK_ORIGIN` rather than
 * `process.env[SHORT_LINK_ORIGIN_VAR]`: only a literal dot access is a shape Next can
 * reason about, and keeping every env read in that shape is what makes
 * `scripts/assert-no-inlined-secrets.mjs` legible for the variables that do matter.
 */
export const SHORT_LINK_ORIGIN_VAR = 'SHORT_LINK_ORIGIN';

/**
 * The configured display origin, trimmed and with any trailing slashes removed.
 *
 * SERVER ONLY. Thrown-on rather than defaulted, the posture `session.ts` takes for
 * `API_BASE_URL`: an unset value would otherwise render `undefined/<slug>` next to a copy
 * button, and an operator would paste a broken link without the page ever saying anything
 * was wrong. There is also no value that could be defaulted to honestly, since the right
 * one differs per environment and no code may key on which one it is (GC-B).
 */
export function shortLinkOrigin(): string {
  const value = process.env.SHORT_LINK_ORIGIN;

  if (value === undefined || value.trim() === '') {
    throw new Error(
      `${SHORT_LINK_ORIGIN_VAR} is not set. The links screens show and copy short links under it (D-2-02).`,
    );
  }

  return trimTrailingSlashes(value.trim());
}

/**
 * `${origin}/${slug}`, with exactly one slash between them.
 *
 * The slug is percent-encoded, which is the identity on every slug the API can store:
 * `SLUG_PATTERN` admits letters, digits, `-` and `_`, and all four are unreserved
 * characters `encodeURIComponent` leaves alone. So the slug appears VERBATIM, case
 * included, which is the property that matters (two slugs differing only in case are two
 * different links, ADR-0007, and a normalising composer would hand out a URL that 404s).
 * What the encoding buys is the case that should be unreachable: a value that is not
 * slug-shaped cannot add a path segment to a URL the operator is invited to click.
 *
 * Both arguments are required and neither may be blank. A blank one is a programming
 * defect rather than a user-facing failure, so it throws a plain `Error` the way
 * `buildRequestUrl` throws for an unusable param, instead of composing something wrong.
 */
export function shortUrl(slug: string, origin: string): string {
  if (slug.trim() === '') {
    throw new Error('shortUrl: a link with no slug has no short URL.');
  }

  const base = trimTrailingSlashes(origin.trim());

  if (base === '') {
    throw new Error(`shortUrl: no origin to compose against (${SHORT_LINK_ORIGIN_VAR}).`);
  }

  return `${base}/${encodeURIComponent(slug)}`;
}

/** `http://host:3001///` and `http://host:3001` compose the same URL. */
function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, '');
}
