/**
 * TASK-2-13 (STORY-2-10, the transport half of AC-2-51 and the copyable URL AC-2-48 shows).
 *
 * The short URL is DISPLAY AND COPY ONLY. Nothing here is ever handed to `fetch`: every
 * request the screens issue goes through `apiClient` to `/api/bff/...`, and this module
 * composes the string a human reads and pastes. The two properties worth pinning are the
 * ones a reviewer cannot see by eye: the join never doubles a slash, and the slug reaches
 * the URL exactly as it was stored, case included, because slugs are case-sensitive and a
 * lower-cased copy resolves to a 404.
 *
 * Contract: docs/contracts/redirect-resolution.md (the visitor surface being composed).
 * Decision: D-2-02 (ruled 2026-08-19: the system default domain is `localhost` and short
 *   links are `http://localhost:3001/<slug>`), D-2-18 (the screens show
 *   `${SHORT_LINK_ORIGIN}/${slug}`).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SHORT_LINK_ORIGIN_VAR, shortLinkOrigin, shortUrl } from './short-url';

/** What compose sets, literally (docker-compose.yml, `web`), and what a laptop reads. */
const THE_COMPOSE_ORIGIN = 'http://localhost:3001';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('shortUrl composes the origin with the slug', () => {
  it('joins them with exactly one slash', () => {
    expect(shortUrl('spring-sale-2026', THE_COMPOSE_ORIGIN)).toBe(
      'http://localhost:3001/spring-sale-2026',
    );
  });

  it('does not double the slash when the origin carries a trailing one', () => {
    expect(shortUrl('abc1234', 'http://localhost:3001/')).toBe('http://localhost:3001/abc1234');
    expect(shortUrl('abc1234', 'http://localhost:3001///')).toBe('http://localhost:3001/abc1234');
  });

  it('leaves the origin otherwise untouched: scheme, host and port survive verbatim', () => {
    expect(shortUrl('abc1234', 'https://sk.example')).toBe('https://sk.example/abc1234');
    expect(shortUrl('abc1234', 'http://127.0.0.1:8080')).toBe('http://127.0.0.1:8080/abc1234');
  });

  it('appends the slug verbatim, case preserved (slugs are case-sensitive, ADR-0007)', () => {
    // Two slugs differing only in case are two different links; a composer that
    // normalised either would hand the operator a URL that 404s.
    expect(shortUrl('AbC-dE_f', THE_COMPOSE_ORIGIN)).toBe('http://localhost:3001/AbC-dE_f');
    expect(shortUrl('abc-de_f', THE_COMPOSE_ORIGIN)).toBe('http://localhost:3001/abc-de_f');
    expect(shortUrl('gH7kM2p', THE_COMPOSE_ORIGIN)).not.toBe(shortUrl('gh7km2p', THE_COMPOSE_ORIGIN));
  });

  it('cannot be walked out of its origin by a value that is not slug-shaped', () => {
    // No slug the API stores can contain these, so this changes nothing an operator sees.
    // It is the backstop for the one place a caller-supplied string reaches a URL a human
    // is invited to click.
    expect(shortUrl('../admin', THE_COMPOSE_ORIGIN)).toBe('http://localhost:3001/..%2Fadmin');
    expect(shortUrl('a b', THE_COMPOSE_ORIGIN)).toBe('http://localhost:3001/a%20b');
  });

  it('refuses an empty slug and an empty origin rather than composing a wrong URL', () => {
    expect(() => shortUrl('', THE_COMPOSE_ORIGIN)).toThrow();
    expect(() => shortUrl('abc1234', '')).toThrow();
    expect(() => shortUrl('abc1234', '   ')).toThrow();
  });
});

describe('shortLinkOrigin reads SHORT_LINK_ORIGIN (GC-B: declared, never derived)', () => {
  it('names the variable the .env.example and compose both set', () => {
    expect(SHORT_LINK_ORIGIN_VAR).toBe('SHORT_LINK_ORIGIN');
  });

  it('returns the configured origin, trimmed, with any trailing slash removed', () => {
    vi.stubEnv(SHORT_LINK_ORIGIN_VAR, THE_COMPOSE_ORIGIN);
    expect(shortLinkOrigin()).toBe(THE_COMPOSE_ORIGIN);

    vi.stubEnv(SHORT_LINK_ORIGIN_VAR, ` ${THE_COMPOSE_ORIGIN}/ `);
    expect(shortLinkOrigin()).toBe(THE_COMPOSE_ORIGIN);
  });

  it('throws when it is unset or blank, so no screen renders `undefined/<slug>`', () => {
    vi.stubEnv(SHORT_LINK_ORIGIN_VAR, '');
    expect(() => shortLinkOrigin()).toThrow(/SHORT_LINK_ORIGIN/);

    vi.stubEnv(SHORT_LINK_ORIGIN_VAR, '   ');
    expect(() => shortLinkOrigin()).toThrow(/SHORT_LINK_ORIGIN/);
  });

  it('composes the D-2-02 link end to end', () => {
    vi.stubEnv(SHORT_LINK_ORIGIN_VAR, THE_COMPOSE_ORIGIN);

    expect(shortUrl('gH7kM2p', shortLinkOrigin())).toBe('http://localhost:3001/gH7kM2p');
  });
});
