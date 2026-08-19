/**
 * Contract: docs/contracts/branding.md ("Rendering rules", "Output encoding is normative,
 *           not advisory"), redirect-resolution.md ("Response headers", invariant 7)
 * ADR: adr-0011-branding-port.md; D-2-14 (the CSP gains `frame-ancestors 'none'`)
 * Produced by: TASK-2-06
 *
 * ============================================================================
 * THE PAGE RENDERS WITH NO DATABASE ACCESS AT ALL. THAT IS A REQUIREMENT.
 * ============================================================================
 *
 * `redirect-resolution.md`: "The default 404 renders with no database access at all, so it
 * works when everything else is down." This module imports nothing that can do I/O, and the
 * integration suite asserts the page still renders with every pool connection held open by
 * someone else (AC-2-16). It is the answer to the pool-exhaustion arm as much as to the
 * unknown slug: whatever failed, there is always a page.
 *
 * ============================================================================
 * ESCAPING IS PART OF THE CONTRACT, NOT A RENDERING SUGGESTION (F-006).
 * ============================================================================
 *
 * Branding is null everywhere in item 2 (no column, no endpoint, no bound port), so every
 * page this ships renders is the default one. The helper is written and tested now anyway,
 * because the alternative is writing it in the wave that first has a tenant-controlled
 * string to put in an attribute, under whatever pressure that wave is under. F-006 is the
 * record of what the unescaped version cost: a `logoUrl` carrying a quote and a script tag
 * survived `z.string().url()` intact and executed for every anonymous visitor who hit an
 * unknown slug on that tenant's hostname.
 *
 * Three independent defences, and this file is two of them: attribute escaping on every
 * interpolated value, a render-time re-check of the colour against its own regex, and the
 * CSP below, which allows no script source at all.
 */
import type { ResolvedHost } from './redirect.types';

/**
 * `redirect-resolution.md`'s directive list, PLUS `frame-ancestors 'none'` (D-2-14, closing
 * F-280's open half).
 *
 * The extra directive is not belt and braces. A per-response CSP REPLACES helmet's, and
 * `frame-ancestors` does not fall back to `default-src`, so this response would carry no
 * framing policy at all and the browser would fall back to `X-Frame-Options`, the weaker
 * of the two mechanisms and the one `logging-and-headers.md` deliberately stopped relying
 * on. `main.ts`'s helmet docblock states the requirement on this constant in as many words.
 */
export const REDIRECT_404_CSP =
  "default-src 'none'; img-src https:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/** `brandingContract`'s own regex, re-checked here at render time (branding.md rule 2). */
const BRAND_COLOR = /^#[0-9a-fA-F]{6}$/;

const DEFAULT_BRAND_COLOR = '#111827';
const LOGO_SIZE = 64;

/**
 * The five characters that break out of an attribute value or a text node.
 *
 * THE AMPERSAND IS REPLACED FIRST AND THE ORDER IS THE WHOLE CORRECTNESS. Replacing `<`
 * before `&` turns an input of `&lt;` into `&lt;` again: the entity is rebuilt rather than
 * escaped, and the value the browser sees is a live `<`.
 */
export function escapeHtmlAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export interface NotFoundPage {
  readonly status: 404;
  readonly body: string;
  readonly contentType: 'text/html; charset=utf-8';
}

/**
 * `logoUrl` reaches an `<img src>` with explicit `width` and `height`, and never a
 * `srcset`, a CSS `url()` or an inline style (branding.md rule 3). `img-src https:` in the
 * CSP is what stops a plain-HTTP logo; the escaping is what stops the attribute breakout.
 */
function logo(logoUrl: string | null): string {
  if (logoUrl === null) {
    return '';
  }

  return `<img src="${escapeHtmlAttribute(logoUrl)}" width="${String(LOGO_SIZE)}" height="${String(LOGO_SIZE)}" alt="">`;
}

/**
 * The colour is re-checked HERE and not trusted from storage (branding.md rule 2): zod
 * constrained it when it was written, and this string is about to enter a `style`
 * attribute on a page served to anonymous visitors. A value that fails renders the default.
 */
function accent(brandColor: string | null): string {
  return brandColor !== null && BRAND_COLOR.test(brandColor) ? brandColor : DEFAULT_BRAND_COLOR;
}

export function renderNotFound(host: ResolvedHost | null): NotFoundPage {
  const branding = host?.branding ?? null;

  const body =
    '<!doctype html>' +
    '<html lang="en">' +
    '<head>' +
    '<meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>Link not found</title>' +
    '</head>' +
    '<body style="margin:0;font:16px/1.5 system-ui,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center">' +
    `<main style="text-align:center;padding:2rem;color:${escapeHtmlAttribute(accent(branding?.brandColor ?? null))}">` +
    logo(branding?.logoUrl ?? null) +
    '<h1 style="font-size:1.25rem;margin:0 0 .5rem">This link is not available</h1>' +
    '<p style="margin:0;opacity:.7">It may have expired, been removed, or never existed.</p>' +
    '</main>' +
    '</body>' +
    '</html>';

  return { status: 404, body, contentType: 'text/html; charset=utf-8' };
}
