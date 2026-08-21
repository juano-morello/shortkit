import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Test } from '@nestjs/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TestingModule } from '@nestjs/testing';

import { CacheModule } from '../cache/cache.module';
import { REDIRECT_CACHE } from '../cache/redirect-cache';
import { UnavailableRedirectCache } from '../cache/unavailable-redirect-cache';

import { RedirectController } from './redirect.controller';
import { RedirectModule } from './redirect.module';
import { RedirectService } from './redirect.service';
import { RedirectReadRepository } from './redirect-read.repository';

/**
 * TASK-2-06. AC-2-20, and the grep half of GC-N.
 *
 * Contract: `docs/contracts/redirect-resolution.md` ("Module isolation (AC-55)", "The GC-5
 * exception, narrowed"), `isolation-coverage.md` (clauses A1 to A4, whose flag table names
 * `redirect/db/redirect-read.ts` as `app.redirect_context`'s one owner), `branding.md`
 * invariant 1. ADR-0006, ADR-0011; GC-N.
 *
 * ============================================================================
 * TWO LEVELS, BECAUSE EACH MISSES WHAT THE OTHER CATCHES (ADR-0011).
 * ============================================================================
 *
 * The module-graph assertion catches a `@Module({ imports: [LinksModule] })`. It does not
 * catch a bare `import type { LinkSnapshot } from '../links/…'`, which compiles to nothing
 * and still couples this module to a shape the management API owns. The static scan
 * catches that and cannot see a provider imported through a re-export. Both, or the claim
 * is half asserted.
 *
 * IT IS A TEXT SCAN AND IT STAYS ONE, for `context-flag-owners.spec.ts`'s reason: a
 * commented-out import of `../links` is one uncomment away from being real, and nothing
 * here needs to tell code from a comment. The permitted files carry the banned strings in
 * their own docblocks only where the prose names the rule, which is why the scan looks for
 * an import SPECIFIER rather than for the word.
 */

/** `apps/api/src/redirect/**\/*.ts`, excluding `*.spec.ts`. The shipped module, nothing else. */
const redirectSource = fileURLToPath(new URL('./', import.meta.url));
const repositoryRoot = fileURLToPath(new URL('../../../../', import.meta.url));

interface SourceFile {
  /** Repository-relative and forward-slashed, so a failure names a path a reader can open. */
  readonly path: string;
  readonly source: string;
}

function shippedFiles(): SourceFile[] {
  return readdirSync(redirectSource, { recursive: true, encoding: 'utf8' })
    .filter((entry) => entry.endsWith('.ts') && !entry.endsWith('.spec.ts'))
    .map((entry) => join(redirectSource, entry))
    .map((path) => ({
      path: relative(repositoryRoot, path).split(sep).join('/'),
      source: readFileSync(path, 'utf8'),
    }));
}

const files = shippedFiles();

/** Every `from '<specifier>'` and `import('<specifier>')` in the file, however it is spelled. */
const IMPORT_SPECIFIER = /(?:from|import)\s*\(?\s*(['"])([^'"]+)\1/g;

function specifiersOf(file: SourceFile): string[] {
  return [...file.source.matchAll(IMPORT_SPECIFIER)].map((match) => match[2]);
}

const specifiers = files.flatMap((file) =>
  specifiersOf(file).map((specifier) => ({ file: file.path, specifier })),
);

describe('the redirect module reads no shipped file (the premise, not the subject)', () => {
  /**
   * Both scans below report their findings as `toEqual([])`, which a walk over a moved or
   * renamed directory satisfies by reading nothing at all. This is what makes the empties
   * mean something.
   */
  it('scans the files this card ships', () => {
    expect(files.map((file) => file.path).sort()).toEqual([
      'apps/api/src/redirect/cache-records.ts',
      'apps/api/src/redirect/db/redirect-read.ts',
      'apps/api/src/redirect/not-found-page.ts',
      'apps/api/src/redirect/ports/branding.port.ts',
      'apps/api/src/redirect/ports/click-sink.port.ts',
      'apps/api/src/redirect/redirect-read.repository.ts',
      'apps/api/src/redirect/redirect.controller.ts',
      'apps/api/src/redirect/redirect.module.ts',
      'apps/api/src/redirect/redirect.service.ts',
      'apps/api/src/redirect/redirect.types.ts',
    ]);
  });

  it('found the import specifiers it is about to filter', () => {
    expect(specifiers.length).toBeGreaterThan(5);
  });
});

describe('GC-N: no import from the management API (AC-2-20)', () => {
  /**
   * The five modules named by GC-N. `../common` and `../db` are NOT on it and are imported
   * deliberately: `db/client.ts` is where `databaseTransaction` lives (the escape this
   * module is one of five sanctioned consumers of) and `db/platform.ts` imports nothing at
   * all, which is what lets the hostname normaliser be shared with the seed.
   */
  const BANNED = ['links', 'auth', 'workspaces', 'members', 'invitations'];

  it.each(BANNED)('imports nothing matching ../%s', (module) => {
    const offending = specifiers
      .filter(({ specifier }) => new RegExp(`(^|/)\\.\\.?/${module}(/|$)`).test(specifier))
      .map(({ file, specifier }) => `${file}: ${specifier}`);

    expect(offending).toEqual([]);
  });

  /**
   * THE NO-ORM HALF OF THE RECORDED CONSTRAINT (README, `app.module.ts`). Not a style rule:
   * a query builder on this path is what turns "one parameterised statement" into whatever
   * the builder emits, and it is the thing a well-meaning refactor reaches for first.
   * `databaseTransaction` hands over a drizzle transaction and this module never names
   * drizzle to use it: the two statements go through the session's own prepared-query
   * path with `$1`/`$2` bound by the driver.
   */
  it('imports no drizzle, at any depth', () => {
    const offending = specifiers
      .filter(({ specifier }) => specifier === 'drizzle-orm' || specifier.startsWith('drizzle-orm/'))
      .map(({ file, specifier }) => `${file}: ${specifier}`);

    expect(offending).toEqual([]);
  });

  /** F-045: the contracts package is imported at its root, never at a subpath. */
  it('imports @shortkit/contracts at its root only', () => {
    const offending = specifiers
      .filter(({ specifier }) => specifier.startsWith('@shortkit/contracts/'))
      .map(({ file, specifier }) => `${file}: ${specifier}`);

    expect(offending).toEqual([]);
  });

  it('reimplements no validity window: isLinkActive comes from the contracts package (ADR-0009, D-2-11)', () => {
    const importers = files.filter((file) => file.source.includes('isLinkActive('));

    expect(importers.length).toBeGreaterThan(0);

    for (const file of importers) {
      expect(specifiersOf(file), file.path).toContain('@shortkit/contracts');
    }
  });
});

describe('the GC-5 exception, narrowed by grep (AC-2-20)', () => {
  const READ_FILE = 'apps/api/src/redirect/db/redirect-read.ts';

  /**
   * isolation-coverage.md's flag table names ONE owner for `app.redirect_context`, and
   * `src/db/context-flag-owners.spec.ts` asserts the pair against `CONTEXT_FLAG_OWNERS`
   * over the whole API tree. This asserts the narrower half the contract puts on this
   * module: within `redirect/**`, one file, one call.
   */
  it('sets app.redirect_context in exactly one file, and names it in no other', () => {
    const naming = files
      .filter((file) => file.source.includes('app.redirect_context'))
      .map((file) => file.path);

    expect(naming).toEqual([READ_FILE]);
  });

  it('issues SET TRANSACTION READ ONLY in that same file', () => {
    const read = files.find((file) => file.path === READ_FILE);

    expect(read?.source).toContain('SET TRANSACTION READ ONLY');
  });

  it('is one of databaseTransaction\'s sanctioned consumers, and the only one here', () => {
    const consumers = files
      .filter((file) => file.source.includes('databaseTransaction'))
      .map((file) => file.path);

    expect(consumers).toEqual([READ_FILE]);
  });

  /**
   * "Exactly two query shapes are permitted here, verbatim" (`redirect-resolution.md`).
   * Every SELECT text under the module is collected and compared against the two, so a
   * third statement (a count, a probe, a "just this once" join) fails here rather than
   * widening the escape quietly. `AND state = 'active'` is PART of the shape and not an
   * optional filter (F-003): without it a `pending_verification` row serves traffic.
   */
  /**
   * A string literal that STARTS with `SELECT`, on one line, delimited by the quote it
   * opened with. Prose in a docblock never starts a quoted run with the word, so this reads
   * the statements and nothing else.
   */
  const SELECT_LITERAL = /(['"])(SELECT(?:(?!\1)[^\n])*)\1/g;

  const selects = files
    .flatMap((file) => [...file.source.matchAll(SELECT_LITERAL)].map((match) => match[2]))
    .sort();

  /**
   * The two data shapes, plus the one preamble statement that is also a SELECT. A third
   * DATA statement (a count, a probe, a join that saves a round trip) fails here, which
   * is the point: the escape is narrowed to two tables and two shapes and the length of
   * this list is the control, exactly as `ISOLATION_EXCLUSIONS`'s length is.
   */
  it('contains exactly the two permitted statement shapes, the preamble, and no third', () => {
    expect(selects).toEqual(
      [
        "SELECT id, tenant_id, workspace_id FROM domains WHERE hostname = $1 AND state = 'active'",
        'SELECT id, tenant_id, workspace_id, domain_id, destination_url, expires_at, activates_at FROM links WHERE domain_id = $1 AND slug = $2',
        "SELECT set_config('app.redirect_context', 'on', true)",
      ].sort(),
    );
  });

  it('reads only domains and links, and binds every visitor-supplied value as a parameter', () => {
    const data = selects.filter((statement) => statement.includes(' FROM '));
    const tables = data.flatMap((statement) =>
      [...statement.matchAll(/\bFROM\s+(\w+)/g)].map((match) => match[1]),
    );

    expect([...new Set(tables)].sort()).toEqual(['domains', 'links']);

    for (const statement of data) {
      expect(statement, statement).toMatch(/\$1/);
      expect(statement, statement).not.toMatch(/\$\{/);
    }
  });

  /** F-003: the state predicate is part of the shape, so its absence is a failing test. */
  it('resolves a hostname only while its domain is active', () => {
    expect(selects.find((statement) => statement.includes('FROM domains'))).toContain(
      "state = 'active'",
    );
  });
});

describe('the module graph (AC-2-20, ADR-0011)', () => {
  let moduleRef: TestingModule | null = null;

  afterEach(async () => {
    await moduleRef?.close();
    moduleRef = null;
  });

  /**
   * `RedirectModule.imports` IS EXACTLY `[CacheModule]` as of TASK-2-07, and the list is the
   * assertion: not "no forbidden module", which a reviewer would have to check by reading,
   * but this one entry and nothing beside it. `CacheModule` is infrastructure (two records
   * and a sentinel over Redis), and it is neither one of the five GC-N names nor a module
   * that could reach one.
   */
  it('imports exactly one Nest module, the cache', () => {
    expect(Reflect.getMetadata('imports', RedirectModule) ?? []).toEqual([CacheModule]);
  });

  it('compiles standalone, with both ports unbound and the degraded cache bound', async () => {
    // Empty is unset (`readRedisBinding`), so the factory selects `UnavailableRedirectCache`
    // and no socket is opened by a unit run. Stubbed rather than assumed: a developer with
    // `REDIS_URL` exported would otherwise build a real client here and leave it open.
    vi.stubEnv('REDIS_URL', '');

    moduleRef = await Test.createTestingModule({ imports: [RedirectModule] }).compile();

    expect(moduleRef.get(RedirectController)).toBeInstanceOf(RedirectController);
    expect(moduleRef.get(RedirectService)).toBeInstanceOf(RedirectService);
    expect(moduleRef.get(RedirectReadRepository)).toBeInstanceOf(RedirectReadRepository);
    // ADR-0011's lesson, applied to the one token that is NOT optional: an unbound cache
    // would degrade this module to a Postgres-only redirect with nothing saying so.
    expect(moduleRef.get(REDIRECT_CACHE)).toBeInstanceOf(UnavailableRedirectCache);
  });

  /**
   * `redirect-resolution.md`: the module carries no `AuthGuard`, no `WorkspaceGuard`, no
   * `RateLimitGuard` and no `TenantTransactionInterceptor`. The global enhancers still WRAP
   * the route: `@Public()` is what exempts it from the guard and the tenant interceptor,
   * and the rate limiter leaves it alone by path (`isUnderApiPrefix`), needing no edit.
   */
  it('binds no guard and no interceptor of its own', () => {
    const providers: unknown[] = Reflect.getMetadata('providers', RedirectModule) ?? [];
    const tokens = providers.map((provider) =>
      typeof provider === 'function' ? provider.name : JSON.stringify(provider),
    );

    expect(tokens.join(' ')).not.toMatch(/APP_GUARD|APP_INTERCEPTOR|Guard|Interceptor/);
  });
});
