import { describe, expect, it } from 'vitest';

import { REDIRECT_404_CSP, escapeHtmlAttribute, renderNotFound } from './not-found-page';
import type { RedirectBranding } from './ports/branding.port';
import type { ResolvedHost } from './redirect.types';

/**
 * TASK-2-06. AC-2-16, AC-77.
 *
 * Contract: `docs/contracts/branding.md` ("Output encoding is normative, not advisory",
 * rules 1 to 4), `redirect-resolution.md` (the header table and invariant 7). F-006, F-280.
 *
 * Branding is always null in item 2: no branding column, no endpoint and no bound port
 * exists yet, and item 3 owns all three. The ESCAPING is nevertheless built and tested
 * now, on the argument F-006 was filed under: the helper is what item 3's values pass
 * through, and a helper written at the moment the first tenant-controlled value arrives is
 * a helper written under time pressure.
 */

const HOST: ResolvedHost = {
  domainId: '00000000-0000-4000-8000-0000000000d1',
  tenantId: '00000000-0000-4000-8000-0000000000a1',
  workspaceId: '00000000-0000-4000-8000-0000000000b1',
  branding: null,
};

function branded(branding: RedirectBranding): ResolvedHost {
  return { ...HOST, branding };
}

describe('escapeHtmlAttribute', () => {
  it('replaces all five characters that can break out of an attribute or a text node', () => {
    expect(escapeHtmlAttribute(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;');
  });

  it('escapes the ampersand first, so an escaped entity is never rebuilt into a live one', () => {
    expect(escapeHtmlAttribute('&lt;script&gt;')).toBe('&amp;lt;script&amp;gt;');
  });

  it('leaves a value with nothing to escape byte-identical', () => {
    expect(escapeHtmlAttribute('https://cdn.example.test/logo.png')).toBe(
      'https://cdn.example.test/logo.png',
    );
  });

  it('escapes every occurrence, not the first', () => {
    expect(escapeHtmlAttribute('a"b"c"')).toBe('a&quot;b&quot;c&quot;');
  });
});

describe('renderNotFound', () => {
  it('answers 404 with an HTML content type, for an unresolved host', () => {
    const page = renderNotFound(null);

    expect(page.status).toBe(404);
    expect(page.contentType).toBe('text/html; charset=utf-8');
    expect(page.body.startsWith('<!doctype html>')).toBe(true);
  });

  it('renders the default Shortkit page when the host resolved but carries no branding', () => {
    expect(renderNotFound(HOST).body).toBe(renderNotFound(null).body);
  });

  /**
   * branding.md rule 3: the logo is an `<img src>` with explicit `width` and `height`, and
   * never a `srcset` or a CSS `url()`.
   */
  it('interpolates a logo only into an img src with explicit width and height', () => {
    const body = renderNotFound(
      branded({ logoUrl: 'https://cdn.example.test/logo.png', brandColor: null, fallbackUrl: null }),
    ).body;

    expect(body).toContain('<img src="https://cdn.example.test/logo.png"');
    expect(body).toContain('width="');
    expect(body).toContain('height="');
    expect(body).not.toContain('srcset');
    expect(body).not.toContain('url(');
  });

  /**
   * F-006, the finding this helper exists for: a logo URL that passed a URL parser can
   * still carry a quote and a tag, and the raw value in an attribute is a breakout.
   */
  it('escapes a breakout attempt in a logo URL rather than emitting it', () => {
    const body = renderNotFound(
      branded({
        logoUrl: 'https://x/a"><script>alert(1)</script>',
        brandColor: null,
        fallbackUrl: null,
      }),
    ).body;

    expect(body).not.toContain('<script');
    expect(body).toContain('&quot;&gt;&lt;script&gt;');
  });

  /**
   * branding.md rule 2: the colour is re-checked against its own regex AT RENDER TIME,
   * because validation constrains the scheme and not the content, and this string reaches
   * a `style` attribute.
   */
  it('re-checks the brand colour at render time and drops a value that fails the regex', () => {
    const body = renderNotFound(
      branded({
        logoUrl: null,
        brandColor: 'red; background: url(javascript:alert(1))',
        fallbackUrl: null,
      }),
    ).body;

    expect(body).not.toContain('javascript:');
    expect(body).not.toContain('background:');
  });

  it('accepts a six-digit hex colour and puts it in a style attribute', () => {
    const body = renderNotFound(
      branded({ logoUrl: null, brandColor: '#1188ff', fallbackUrl: null }),
    ).body;

    expect(body).toContain('style="');
    expect(body).toContain('#1188ff');
  });

  it('rejects the three-digit shorthand, which brandingContract also rejects', () => {
    const body = renderNotFound(
      branded({ logoUrl: null, brandColor: '#18f', fallbackUrl: null }),
    ).body;

    expect(body).not.toContain('#18f');
  });

  it('leaves no placeholder unfilled and names no infrastructure', () => {
    const body = renderNotFound(HOST).body;

    expect(body).not.toContain('undefined');
    expect(body.toLowerCase()).not.toContain('postgres');
  });
});

describe('REDIRECT_404_CSP', () => {
  /**
   * D-2-14 closes F-280's open half HERE, and `main.ts`'s helmet docblock is the
   * instruction: a per-response CSP REPLACES helmet's, and `frame-ancestors` does not fall
   * back to `default-src`, so a directive list without it drops the framing protection
   * helmet's line adds.
   */
  it('carries the contract directive list plus frame-ancestors none', () => {
    expect(REDIRECT_404_CSP).toBe(
      "default-src 'none'; img-src https:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    );
  });

  it('allows no script source at all, which is invariant 7', () => {
    expect(REDIRECT_404_CSP).not.toContain('script-src');
    expect(REDIRECT_404_CSP).toContain("default-src 'none'");
  });
});
