/**
 * STORY-2-01 — AC-2-4 (the contract half: which destinations are storable).
 * STORY-2-05 — AC-2-27 (the pure-function half: the validity window per branch).
 * TASK-2-01.
 *
 * Contract: docs/contracts/slug.md, error-envelope.md, redirect-resolution.md,
 *           link-mutation-events.md, click-events.md
 * ADR: adr-0005-contract-distribution.md, adr-0009-expiry-eviction.md,
 *      adr-0025-zod-error-recognition-in-contracts.md
 * Decisions: D-2-08 (destination is scheme-constrained and stored parsed),
 *            D-2-11 (`isLinkActive` lives here), D-2-12 (route shapes),
 *            D-2-19 (`linkContract` carries `hostname`; `ipHash` is not on the wire)
 *
 * ============================================================================
 * THE `Location` HEADER IS THE STORED VALUE, SO THE STORE IS THE CHOKE POINT.
 * ============================================================================
 *
 * AC-2-14 requires the 302's `Location` to be byte-identical to `destination_url`.
 * That makes the F-006 class apply here exactly as it did to `fallbackUrl`: if
 * `javascript:` can be stored, it can be served, from the platform's own origin, to an
 * anonymous visitor. Parsing with `new URL` rather than matching a regex is what makes
 * `java\nscript:` and a leading-space variant refuse too — the WHATWG parser strips
 * tabs, newlines and leading C0/space before reading the scheme, and a regex written
 * against the raw string does not.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { isZodError, toValidationDetails } from '../errors';

import {
  CLICK_USER_AGENT_MAX_LENGTH,
  DESTINATION_URL_INVALID_MESSAGE,
  DESTINATION_URL_MAX_LENGTH,
  DESTINATION_URL_SCHEME_MESSAGE,
  DESTINATION_URL_TOO_LONG_MESSAGE,
  LINK_WINDOW_MESSAGE,
  clickEventContract,
  clickQueryContract,
  createLinkContract,
  destinationUrlContract,
  isLinkActive,
  linkContract,
  updateLinkContract,
} from './index';

const WORKSPACE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const DOMAIN_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const LINK_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const CLICK_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

/** The `destinationUrl` messages a failed parse flattens to; `[]` when the parse passed. */
function destinationIssues(input: unknown): string[] {
  const outcome = z.object({ destinationUrl: destinationUrlContract }).safeParse({
    destinationUrl: input,
  });

  if (outcome.success) {
    return [];
  }

  expect(isZodError(outcome.error)).toBe(true);

  return toValidationDetails(outcome.error).fieldErrors.destinationUrl ?? [];
}

describe('destinationUrlContract — what may be stored, and in what form', () => {
  it('AC-2-4: `http://plain.example` is accepted (a shortener must accept http targets)', () => {
    expect(destinationUrlContract.parse('http://plain.example')).toBe('http://plain.example/');
  });

  it('D-2-08: the STORED value is `u.href`, never the raw input', () => {
    // The parse normalises the scheme and host casing and supplies the empty path. The
    // 302 then serves this value verbatim, so normalising once here is what makes
    // "byte-identical to the stored destination" a claim about one canonical string.
    expect(destinationUrlContract.parse('HTTP://Example.COM')).toBe('http://example.com/');
  });

  it('a path, query and fragment survive the parse unchanged', () => {
    expect(destinationUrlContract.parse('https://example.com/a?b=c#d')).toBe(
      'https://example.com/a?b=c#d',
    );
  });

  it.each([
    ['javascript', 'javascript:alert(1)'],
    ['javascript, case-varied', 'JaVaScRiPt:alert(1)'],
    ['javascript, split by a newline the URL parser strips', 'java\nscript:alert(1)'],
    ['javascript, behind a leading space', ' javascript:alert(1)'],
    ['data', 'data:text/html,x'],
    ['ftp', 'ftp://files.example.com/x'],
    ['file', 'file:///etc/passwd'],
    ['mailto', 'mailto:someone@example.com'],
  ])('AC-2-4: a %s URL is refused, keyed destinationUrl', (_label, input) => {
    expect(destinationIssues(input)).toEqual([DESTINATION_URL_SCHEME_MESSAGE]);
  });

  it.each([
    ['a non-URL', 'not a url'],
    ['a protocol-relative reference, which has no scheme of its own', '//example.com'],
    ['a scheme with no host', 'http://'],
    ['the empty string', ''],
  ])('AC-2-4: %s is refused as unparseable', (_label, input) => {
    expect(destinationIssues(input)).toEqual([DESTINATION_URL_INVALID_MESSAGE]);
  });

  it('AC-2-4: the length bound is checked on the RAW input, at 2048', () => {
    const under = `https://example.com/${'a'.repeat(DESTINATION_URL_MAX_LENGTH - 20)}`;

    expect(under.length).toBe(DESTINATION_URL_MAX_LENGTH);
    expect(destinationUrlContract.safeParse(under).success).toBe(true);
    expect(destinationUrlContract.safeParse(`${under}a`).success).toBe(false);
  });

  it('a too-long value is refused before it is parsed, so one issue comes back, not two', () => {
    // `.max()` sits ahead of the transform in the pipe: an over-length `javascript:` URL
    // reports the length and stops, rather than reporting length and scheme together.
    expect(destinationIssues(`javascript:${'a'.repeat(DESTINATION_URL_MAX_LENGTH)}`)).toHaveLength(
      1,
    );
  });

  describe('the binding length check is on `href`, not on the input', () => {
    // Percent-encoding on the way to `href` can multiply a string several times over, so
    // a raw-input bound does not bound what gets STORED — and `destination_url` is
    // unbounded `text`, so nothing downstream catches the overflow either.
    const percentEncoded = (repeats: number): string =>
      `https://example.com/${'é'.repeat(repeats)}`;

    it('a percent-encoding-heavy URL that passes the RAW bound is refused on its href', () => {
      const input = percentEncoded(2028);

      // Measured: 2048 characters in, 12,188 characters of `href` out — a 6x blow-up
      // that a raw-input bound waves straight through.
      expect(input.length).toBe(DESTINATION_URL_MAX_LENGTH);
      expect(new URL(input).href.length).toBe(12_188);
      expect(destinationIssues(input)).toEqual([DESTINATION_URL_TOO_LONG_MESSAGE]);
    });

    it('a percent-encoded URL that passes BOTH bounds is accepted', () => {
      const input = percentEncoded(100);

      expect(destinationUrlContract.parse(input)).toBe(new URL(input).href);
    });

    it('the href boundary is exact: 2048 encoded characters pass, 2054 refuse', () => {
      // 338 and 339 repeats both sit far under the raw bound; only the encoded length
      // separates them, which is what pins the check to `href`.
      const atLimit = percentEncoded(338);
      const overLimit = percentEncoded(339);

      expect({
        atLimitHref: new URL(atLimit).href.length,
        overLimitHref: new URL(overLimit).href.length,
        atLimitRaw: atLimit.length,
        overLimitRaw: overLimit.length,
      }).toEqual({
        atLimitHref: DESTINATION_URL_MAX_LENGTH,
        overLimitHref: 2054,
        atLimitRaw: 358,
        overLimitRaw: 359,
      });

      expect(destinationUrlContract.safeParse(atLimit).success).toBe(true);
      expect(destinationIssues(overLimit)).toEqual([DESTINATION_URL_TOO_LONG_MESSAGE]);
    });

    it('both bounds report the same message, so a client sees one "too long" answer', () => {
      const rawTooLong = `https://example.com/${'a'.repeat(DESTINATION_URL_MAX_LENGTH)}`;

      expect(rawTooLong.length).toBeGreaterThan(DESTINATION_URL_MAX_LENGTH);
      expect(destinationIssues(rawTooLong)).toEqual([DESTINATION_URL_TOO_LONG_MESSAGE]);
      expect(destinationIssues(percentEncoded(2028))).toEqual([DESTINATION_URL_TOO_LONG_MESSAGE]);
    });
  });

  it('the two messages are fixed: they reach a form through validation_failed details', () => {
    expect({
      invalid: DESTINATION_URL_INVALID_MESSAGE,
      scheme: DESTINATION_URL_SCHEME_MESSAGE,
    }).toEqual({
      invalid: 'Enter a valid URL.',
      scheme: 'A destination must be an http:// or https:// URL.',
    });
  });

  it('a non-string is refused rather than coerced', () => {
    expect(destinationUrlContract.safeParse(null).success).toBe(false);
    expect(destinationUrlContract.safeParse(42).success).toBe(false);
  });
});

describe('linkContract — the wire shape of one link (D-2-19)', () => {
  const WIRE_LINK = {
    id: LINK_ID,
    workspaceId: WORKSPACE_ID,
    domainId: DOMAIN_ID,
    hostname: 'localhost',
    slug: 'spring-sale-2026',
    destinationUrl: 'https://example.com/a',
    expiresAt: null,
    activatesAt: null,
    createdAt: '2026-08-19T09:00:00.000Z',
  } as const;

  it('parses a JSON round trip of the row, keeping the timestamps as ISO strings', () => {
    expect(linkContract.parse(WIRE_LINK)).toEqual({
      ...WIRE_LINK,
      expiresAt: null,
      activatesAt: null,
      createdAt: '2026-08-19T09:00:00.000Z',
    });
  });

  it('D-2-19: `hostname` is on the wire, denormalised, so item 3 changes no shape', () => {
    expect(linkContract.parse(WIRE_LINK).hostname).toBe('localhost');
  });

  it('the window timestamps are nullable ISO strings, validated as datetimes', () => {
    const parsed = linkContract.parse({
      ...WIRE_LINK,
      expiresAt: '2026-09-01T00:00:00.000Z',
      activatesAt: '2026-08-20T00:00:00.000Z',
    });

    expect({ expiresAt: parsed.expiresAt, activatesAt: parsed.activatesAt }).toEqual({
      expiresAt: '2026-09-01T00:00:00.000Z',
      activatesAt: '2026-08-20T00:00:00.000Z',
    });
  });

  it('carries no `tenantId`: the caller is already inside their own tenant', () => {
    // The workspaces contract's rule, restated for links: an id the caller cannot act on
    // has no reason to be on the wire. Unknown keys are stripped, so a service that
    // spread the row would not leak it either.
    const parsed = linkContract.parse({ ...WIRE_LINK, tenantId: WORKSPACE_ID });

    expect(Object.keys(parsed)).not.toContain('tenantId');
  });

  it('refuses a malformed id on any of the three id fields', () => {
    expect({
      id: linkContract.safeParse({ ...WIRE_LINK, id: 'nope' }).success,
      workspaceId: linkContract.safeParse({ ...WIRE_LINK, workspaceId: 'nope' }).success,
      domainId: linkContract.safeParse({ ...WIRE_LINK, domainId: 'nope' }).success,
    }).toEqual({ id: false, workspaceId: false, domainId: false });
  });

  it('refuses a timestamp that is not an ISO 8601 instant', () => {
    expect(linkContract.safeParse({ ...WIRE_LINK, createdAt: 'not a date' }).success).toBe(false);
  });

  it('matches the package-wide timestamp convention: UTC `Z`, as workspaceContract declares it', () => {
    // Ruled 2026-08-19. One convention across the contracts package; `toISOString()` on
    // both sides produces `Z`, and an offset form is refused here exactly as it is on a
    // workspace's `createdAt`, so no consumer has to handle two spellings.
    expect({
      utc: linkContract.safeParse({ ...WIRE_LINK, createdAt: '2026-08-19T09:00:00.000Z' }).success,
      offset: linkContract.safeParse({ ...WIRE_LINK, createdAt: '2026-08-19T11:00:00+02:00' })
        .success,
      dateOnly: linkContract.safeParse({ ...WIRE_LINK, createdAt: '2026-08-19' }).success,
    }).toEqual({ utc: true, offset: false, dateOnly: false });
  });
});

describe('createLinkContract — POST /api/links (D-2-12)', () => {
  it('the minimum body is a workspace and a destination', () => {
    expect(
      createLinkContract.parse({
        workspaceId: WORKSPACE_ID,
        destinationUrl: 'https://example.com/a',
      }),
    ).toEqual({ workspaceId: WORKSPACE_ID, destinationUrl: 'https://example.com/a' });
  });

  it('D-2-12: there is no `domainId` field — item 3 adds it, and it is stripped until then', () => {
    const parsed = createLinkContract.parse({
      workspaceId: WORKSPACE_ID,
      destinationUrl: 'https://example.com/a',
      domainId: DOMAIN_ID,
    });

    expect(Object.keys(parsed)).not.toContain('domainId');
  });

  it('the `slug` field is presence-and-type only: `validateSlug` at the route owns validity', () => {
    // A reserved slug PASSES this schema and is refused by `validateSlug` in the handler,
    // because the five violations are what AC-2-2 puts in `fieldErrors.slug` and zod
    // cannot produce them in that order. Duplicating the rule here would give two
    // sources of truth for one message.
    expect(
      createLinkContract.safeParse({
        workspaceId: WORKSPACE_ID,
        destinationUrl: 'https://example.com/a',
        slug: 'admin',
      }).success,
    ).toBe(true);
  });

  it('a non-string slug is still refused', () => {
    expect(
      createLinkContract.safeParse({
        workspaceId: WORKSPACE_ID,
        destinationUrl: 'https://example.com/a',
        slug: 7,
      }).success,
    ).toBe(false);
  });

  it('the window timestamps are optional, nullable ISO strings', () => {
    const parsed = createLinkContract.parse({
      workspaceId: WORKSPACE_ID,
      destinationUrl: 'https://example.com/a',
      expiresAt: '2026-09-01T00:00:00.000Z',
      activatesAt: null,
    });

    expect({ expiresAt: parsed.expiresAt, activatesAt: parsed.activatesAt }).toEqual({
      expiresAt: '2026-09-01T00:00:00.000Z',
      activatesAt: null,
    });
  });

  it('a missing workspaceId or destinationUrl is refused', () => {
    expect({
      noWorkspace: createLinkContract.safeParse({ destinationUrl: 'https://example.com/a' })
        .success,
      noDestination: createLinkContract.safeParse({ workspaceId: WORKSPACE_ID }).success,
    }).toEqual({ noWorkspace: false, noDestination: false });
  });

  describe('the activation window must open before it closes', () => {
    function windowIssues(activatesAt: string, expiresAt: string): string[] {
      const outcome = createLinkContract.safeParse({
        workspaceId: WORKSPACE_ID,
        destinationUrl: 'https://example.com/a',
        activatesAt,
        expiresAt,
      });

      if (outcome.success) {
        return [];
      }

      return toValidationDetails(outcome.error).fieldErrors.activatesAt ?? [];
    }

    it('activatesAt after expiresAt is refused, keyed `activatesAt`', () => {
      expect(windowIssues('2026-09-02T00:00:00.000Z', '2026-09-01T00:00:00.000Z')).toEqual([
        LINK_WINDOW_MESSAGE,
      ]);
    });

    it('activatesAt EQUAL to expiresAt is refused: the link would never be active', () => {
      expect(windowIssues('2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z')).toEqual([
        LINK_WINDOW_MESSAGE,
      ]);
    });

    it('activatesAt before expiresAt is accepted', () => {
      expect(windowIssues('2026-08-20T00:00:00.000Z', '2026-09-01T00:00:00.000Z')).toEqual([]);
    });

    it('one timestamp alone is accepted: the refinement only sees the fields in THIS body', () => {
      // A PATCH naming only `activatesAt` cannot be checked against a stored `expires_at`
      // by a schema that never sees the row. That comparison is the route's (TASK-2-05),
      // against the pre-image it already loads for `onLinkMutated`.
      expect(
        createLinkContract.safeParse({
          workspaceId: WORKSPACE_ID,
          destinationUrl: 'https://example.com/a',
          activatesAt: '2026-09-02T00:00:00.000Z',
        }).success,
      ).toBe(true);
    });

    it('a malformed timestamp reports ITS OWN issue only, not the window message too', () => {
      // Measured on zod 4.4.3: an object-level `.refine` runs even when a field already
      // produced an issue. `Date.parse('garbage')` is NaN and `NaN < NaN` is false, so
      // without the guard in `hasOrderedWindow` a single typo would show two errors —
      // one true, one invented.
      const outcome = createLinkContract.safeParse({
        workspaceId: WORKSPACE_ID,
        destinationUrl: 'https://example.com/a',
        activatesAt: 'garbage',
        expiresAt: '2026-09-01T00:00:00.000Z',
      });

      expect(outcome.success).toBe(false);

      if (!outcome.success) {
        expect(toValidationDetails(outcome.error).fieldErrors.activatesAt).not.toContain(
          LINK_WINDOW_MESSAGE,
        );
      }
    });

    it('the message is fixed', () => {
      expect(LINK_WINDOW_MESSAGE).toBe('The activation time must be before the expiry time.');
    });
  });
});

describe('updateLinkContract — PATCH /api/links/:linkId (D-2-12)', () => {
  it('every field is optional: an empty patch parses (and still fires `updated`)', () => {
    // `toEqual({})` would NOT prove this: vitest ignores keys whose value is `undefined`,
    // so a schema that filled every field with `undefined` would pass it. The key list is
    // what actually distinguishes "absent" from "present and undefined".
    expect(Object.keys(updateLinkContract.parse({}))).toEqual([]);
  });

  it('the four patchable fields are destinationUrl, slug, expiresAt and activatesAt', () => {
    const parsed = updateLinkContract.parse({
      destinationUrl: 'HTTPS://Example.com/b',
      slug: 'autumn-sale',
      expiresAt: '2026-12-01T00:00:00.000Z',
      activatesAt: null,
    });

    expect(parsed).toEqual({
      destinationUrl: 'https://example.com/b',
      slug: 'autumn-sale',
      expiresAt: '2026-12-01T00:00:00.000Z',
      activatesAt: null,
    });
  });

  it('`workspaceId` is NOT patchable: a link does not move workspace through this route', () => {
    const parsed = updateLinkContract.parse({ workspaceId: WORKSPACE_ID });

    expect(Object.keys(parsed)).not.toContain('workspaceId');
  });

  it('null clears a timestamp, which is how an operator removes an expiry', () => {
    // The key must be PRESENT and null — an absent key means "leave it alone", and the
    // two are the whole difference between clearing an expiry and ignoring the request.
    const parsed = updateLinkContract.parse({ expiresAt: null });

    expect(Object.keys(parsed)).toEqual(['expiresAt']);
    expect(parsed.expiresAt).toBeNull();
  });

  it('the destination rules still apply on a patch', () => {
    expect(updateLinkContract.safeParse({ destinationUrl: 'javascript:alert(1)' }).success).toBe(
      false,
    );
  });

  it('the window refinement survives the omit and the partial', () => {
    const outcome = updateLinkContract.safeParse({
      activatesAt: '2026-09-02T00:00:00.000Z',
      expiresAt: '2026-09-01T00:00:00.000Z',
    });

    expect(outcome.success).toBe(false);

    if (!outcome.success) {
      expect(toValidationDetails(outcome.error).fieldErrors.activatesAt).toEqual([
        LINK_WINDOW_MESSAGE,
      ]);
    }
  });
});

describe('clickEventContract — the read surface of one click (D-2-19)', () => {
  const WIRE_CLICK = {
    id: CLICK_ID,
    linkId: LINK_ID,
    occurredAt: '2026-08-19T09:00:00.000Z',
    userAgent: 'Mozilla/5.0',
  } as const;

  it('parses a JSON round trip of the row, keeping `occurredAt` an ISO string', () => {
    expect(clickEventContract.parse(WIRE_CLICK)).toEqual({
      id: CLICK_ID,
      linkId: LINK_ID,
      occurredAt: '2026-08-19T09:00:00.000Z',
      userAgent: 'Mozilla/5.0',
    });
  });

  it('AC-2-39, D-2-19: `ipHash` IS NOT ON THE WIRE, and is stripped if a service sends it', () => {
    // `ip_hash` is pseudonymous per tenant and never leaves the database (GC-R). The
    // shape is the second line of defence behind the repository's select list: a reader
    // that selected `*` still cannot put it in a response parsed through this contract.
    const parsed = clickEventContract.parse({ ...WIRE_CLICK, ipHash: 'AAAAAAAAAAAAAAAAAAAAAA' });

    expect(Object.keys(parsed)).not.toContain('ipHash');
  });

  it('`userAgent` is nullable: a visitor sending no User-Agent still gets a row', () => {
    expect(clickEventContract.parse({ ...WIRE_CLICK, userAgent: null }).userAgent).toBeNull();
  });

  it('the length bound equals the column width, so it can never refuse a stored row', () => {
    // 512 is `varchar(512)` in click-events.md and the truncation point at enqueue. The
    // constant is exported so TASK-2-09 truncates against this value rather than a
    // second literal.
    expect(CLICK_USER_AGENT_MAX_LENGTH).toBe(512);
    expect(
      clickEventContract.safeParse({
        ...WIRE_CLICK,
        userAgent: 'a'.repeat(CLICK_USER_AGENT_MAX_LENGTH),
      }).success,
    ).toBe(true);
    expect(
      clickEventContract.safeParse({
        ...WIRE_CLICK,
        userAgent: 'a'.repeat(CLICK_USER_AGENT_MAX_LENGTH + 1),
      }).success,
    ).toBe(false);
  });
});

describe('clickQueryContract — GET /api/links/:linkId/clicks', () => {
  it('carries the pagination fields, with the shared default of 25', () => {
    expect(clickQueryContract.parse({})).toEqual({ limit: 25 });
  });

  it('`from` and `to` are optional ISO strings on the query string', () => {
    expect(
      clickQueryContract.parse({ from: '2026-08-01T00:00:00.000Z', to: '2026-08-19T00:00:00.000Z' }),
    ).toEqual({
      limit: 25,
      from: '2026-08-01T00:00:00.000Z',
      to: '2026-08-19T00:00:00.000Z',
    });
  });

  it('the pagination bounds are the shared ones, not a second set', () => {
    expect({
      limit: clickQueryContract.parse({ limit: '50' }).limit,
      cursor: clickQueryContract.parse({ cursor: 'abc' }).cursor,
      tooLarge: clickQueryContract.safeParse({ limit: 101 }).success,
      tooSmall: clickQueryContract.safeParse({ limit: 0 }).success,
    }).toEqual({ limit: 50, cursor: 'abc', tooLarge: false, tooSmall: false });
  });

  it('an unparseable `from` is refused rather than silently ignored', () => {
    expect(clickQueryContract.safeParse({ from: 'last tuesday' }).success).toBe(false);
  });
});

describe('isLinkActive — AC-2-27, one branch at a time (ADR-0009, D-2-11)', () => {
  const NOW = new Date('2026-08-19T12:00:00.000Z');
  const BEFORE = new Date('2026-08-19T11:00:00.000Z');
  const AFTER = new Date('2026-08-19T13:00:00.000Z');

  it('AC-2-27: absence of both timestamps is active', () => {
    expect(isLinkActive({ expiresAt: null, activatesAt: null }, NOW)).toBe(true);
  });

  it.each([
    ['activatesAt in the future', { expiresAt: null, activatesAt: AFTER }, false],
    ['activatesAt exactly now', { expiresAt: null, activatesAt: NOW }, true],
    ['activatesAt in the past', { expiresAt: null, activatesAt: BEFORE }, true],
    ['expiresAt in the future', { expiresAt: AFTER, activatesAt: null }, true],
    ['expiresAt exactly now', { expiresAt: NOW, activatesAt: null }, false],
    ['expiresAt in the past', { expiresAt: BEFORE, activatesAt: null }, false],
    ['inside a closed window', { expiresAt: AFTER, activatesAt: BEFORE }, true],
    ['before a closed window', { expiresAt: AFTER, activatesAt: AFTER }, false],
    ['after a closed window', { expiresAt: BEFORE, activatesAt: BEFORE }, false],
  ])('%s is %s', (_label, window, expected) => {
    expect(isLinkActive(window, NOW)).toBe(expected);
  });

  it('the boundaries are half-open: active AT activatesAt, inactive AT expiresAt', () => {
    // ADR-0009's comparisons are `now < activatesAt` and `now >= expiresAt`. Stated as
    // its own assertion because flipping either inequality is a one-character edit that
    // every other row above still passes.
    expect({
      atActivation: isLinkActive({ expiresAt: null, activatesAt: NOW }, NOW),
      atExpiry: isLinkActive({ expiresAt: NOW, activatesAt: null }, NOW),
      oneMsBeforeExpiry: isLinkActive(
        { expiresAt: NOW, activatesAt: null },
        new Date(NOW.getTime() - 1),
      ),
      oneMsBeforeActivation: isLinkActive(
        { expiresAt: null, activatesAt: NOW },
        new Date(NOW.getTime() - 1),
      ),
    }).toEqual({
      atActivation: true,
      atExpiry: false,
      oneMsBeforeExpiry: true,
      oneMsBeforeActivation: false,
    });
  });

  describe('both bound forms are accepted, so both callers work unchanged', () => {
    // Ruled 2026-08-19. The redirect path passes drizzle's real `Date`s from the row;
    // the screens pass the wire's ISO strings, because every timestamp in this package
    // is an ISO string on the wire. One function, two input forms, identical answers.
    it.each([
      ['a future activation', { activatesAt: AFTER, expiresAt: null }, false],
      ['a past expiry', { activatesAt: null, expiresAt: BEFORE }, false],
      ['an open window', { activatesAt: BEFORE, expiresAt: AFTER }, true],
    ])('%s answers the same from Dates and from ISO strings', (_label, window, expected) => {
      const asStrings = {
        activatesAt: window.activatesAt === null ? null : window.activatesAt.toISOString(),
        expiresAt: window.expiresAt === null ? null : window.expiresAt.toISOString(),
      };

      expect({ dates: isLinkActive(window, NOW), strings: isLinkActive(asStrings, NOW) }).toEqual({
        dates: expected,
        strings: expected,
      });
    });

    it('a bound that exists but cannot be read fails CLOSED', () => {
      // This decides an anonymous visitor's 302. An unreadable expiry must not keep
      // serving a link forever and an unreadable activation must not open one early, so
      // "I cannot tell" answers 404 rather than guessing the permissive way.
      expect({
        unreadableExpiry: isLinkActive({ activatesAt: null, expiresAt: 'garbage' }, NOW),
        unreadableActivation: isLinkActive({ activatesAt: 'garbage', expiresAt: null }, NOW),
        invalidDateObject: isLinkActive(
          { activatesAt: null, expiresAt: new Date('garbage') },
          NOW,
        ),
        // The empty string is the likeliest way an unreadable bound actually arrives —
        // a cleared form field serialised as `''` rather than omitted or nulled. It takes
        // the same NaN path, so it must fail closed too and not read as "no bound".
        emptyStringExpiry: isLinkActive({ activatesAt: null, expiresAt: '' }, NOW),
        emptyStringActivation: isLinkActive({ activatesAt: '', expiresAt: null }, NOW),
      }).toEqual({
        unreadableExpiry: false,
        unreadableActivation: false,
        invalidDateObject: false,
        emptyStringExpiry: false,
        emptyStringActivation: false,
      });
    });
  });

  it('is pure: `now` is the only clock, so the same inputs always answer the same', () => {
    // The redirect passes the API process's clock (ADR-0009). Nothing here reads
    // `Date.now()`, which is what lets the cache-hit path decide expiry with no I/O
    // (AC-2-26) and what makes the redirect's behaviour testable without fake timers.
    const window = { expiresAt: AFTER, activatesAt: BEFORE };

    expect([isLinkActive(window, NOW), isLinkActive(window, NOW), isLinkActive(window, AFTER)]).toEqual(
      [true, true, false],
    );
  });
});
