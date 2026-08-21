import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { logger } from '../observability/logger';

import { redirectCacheFor } from './cache.module';
import {
  REDIS_CLIENT_OPTIONS,
  REDIS_KEY_NAMESPACE_INVALID_MESSAGE,
  REDIS_KEY_NAMESPACE_UNSET_MESSAGE,
  REDIS_URL_INVALID_MESSAGE,
  RedisBindingError,
  assertRedisConfigured,
  closeRedisClient,
  createRedisClient,
  readRedisBinding,
} from './redis-client';
import { RedisRedirectCache } from './redirect-cache';
import { UnavailableRedirectCache } from './unavailable-redirect-cache';

/**
 * STORY-2-06, AC-2-30 (the option set), AC-2-32 (the boot binding). TASK-2-03, wave 1.
 *
 * Contract: `docs/contracts/redirect-cache.md` ("Keys": `REDIS_KEY_NAMESPACE` is required
 * and the process refuses to boot without it). ADR-0012 (the six options, verbatim),
 * D-2-09 (absence binds the degraded cache loudly), ADR-0029 (no configured value in
 * error text: a Redis URL carries a password), GC-B (no behavioural choice on `NODE_ENV`).
 *
 * THE PREDICATE IS TESTED HERE; THE PROCESS IS TESTED BY THE BOOT CHECK IN THE TASK REPORT
 * AND BY `test/cache/redirect-cache.int-spec.ts`, the same split `mail-transport.spec.ts`
 * records, for the same reason: a predicate that reads an env record and returns needs no
 * child process, and the one thing that does (that `main.ts` calls it, unconditionally,
 * before it listens) is the text scan at the bottom of this file (importing `main.ts`
 * boots the API).
 */

type Outcome = { readonly returned: unknown } | { readonly refusedWith: string; readonly binding: unknown };

function outcomeOf(run: () => unknown): Outcome {
  try {
    return { returned: run() };
  } catch (error) {
    return error instanceof RedisBindingError
      ? { refusedWith: error.message, binding: error.binding }
      : { refusedWith: String(error), binding: undefined };
  }
}

const refused = (message: string): Outcome => ({ refusedWith: message, binding: 'redirect_cache' });

describe('readRedisBinding', () => {
  it('D-2-09: unset and empty are absence, and absence is not a refusal', () => {
    expect({ unset: readRedisBinding({}), empty: readRedisBinding({ REDIS_URL: '' }) }).toEqual({
      unset: undefined,
      empty: undefined,
    });
  });

  it('redirect-cache.md: REDIS_URL set requires REDIS_KEY_NAMESPACE, by name', () => {
    expect({
      unset: outcomeOf(() => readRedisBinding({ REDIS_URL: 'redis://127.0.0.1:6379' })),
      empty: outcomeOf(() => readRedisBinding({ REDIS_URL: 'redis://127.0.0.1:6379', REDIS_KEY_NAMESPACE: '  ' })),
    }).toEqual({
      unset: refused(REDIS_KEY_NAMESPACE_UNSET_MESSAGE),
      empty: refused(REDIS_KEY_NAMESPACE_UNSET_MESSAGE),
    });
  });

  it.each([['dev'], ['prod'], ['staging'], ['ci-1234567890'], ['it-42']])(
    'redirect-cache.md: %j is a namespace, and the binding carries it verbatim',
    (namespace) => {
      expect(
        readRedisBinding({ REDIS_URL: 'rediss://user:pw@example.test:6380', REDIS_KEY_NAMESPACE: namespace }),
      ).toEqual({ url: 'rediss://user:pw@example.test:6380', namespace });
    },
  );

  it.each([['prod:1'], ['a b'], ['sk:prod'], ['dev\t']])(
    'GC-P: %j is refused (a namespace carrying a colon or whitespace would not survive `sk:{env}:` key parsing)',
    (namespace) => {
      expect(
        outcomeOf(() => readRedisBinding({ REDIS_URL: 'redis://127.0.0.1:6379', REDIS_KEY_NAMESPACE: namespace })),
      ).toEqual(refused(REDIS_KEY_NAMESPACE_INVALID_MESSAGE));
    },
  );

  it.each([['localhost:6379'], ['http://127.0.0.1:6379'], ['not a url'], ['tcp://127.0.0.1:6379']])(
    'the validity of REDIS_URL is unconditional: %j refuses even with a namespace set',
    (url) => {
      // ADR-0040's shape, the one `MAIL_TRANSPORT` follows: validity asserted whatever else
      // is declared, so a typo cannot select a client nobody named.
      expect(outcomeOf(() => readRedisBinding({ REDIS_URL: url, REDIS_KEY_NAMESPACE: 'dev' }))).toEqual(
        refused(REDIS_URL_INVALID_MESSAGE),
      );
    },
  );

  it('ADR-0029: no refusal quotes the URL, the namespace, or any part of either', () => {
    // A Redis URL carries a password. The refusal names the rule; the operator has the
    // environment in front of them.
    const secret = 'sup3rs3cret';

    const messages = [
      REDIS_URL_INVALID_MESSAGE,
      REDIS_KEY_NAMESPACE_UNSET_MESSAGE,
      REDIS_KEY_NAMESPACE_INVALID_MESSAGE,
      String(outcomeOf(() => readRedisBinding({ REDIS_URL: `redis://x:${secret}@h:1`, REDIS_KEY_NAMESPACE: 'a:b' }))),
      String(outcomeOf(() => readRedisBinding({ REDIS_URL: `ftp://x:${secret}@h:1`, REDIS_KEY_NAMESPACE: 'dev' }))),
    ].join('\n');

    expect(messages).not.toContain(secret);
  });
});

describe('assertRedisConfigured', () => {
  beforeEach(() => {
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('AC-2-32: REDIS_URL unset writes exactly ONE warn line carrying boot_precondition and no other field', () => {
    assertRedisConfigured({});

    expect(vi.mocked(logger.warn).mock.calls.map(([fields]) => fields)).toEqual([
      { boot_precondition: 'redirect_cache' },
    ]);
  });

  it('a complete binding writes nothing at boot', () => {
    assertRedisConfigured({ REDIS_URL: 'redis://127.0.0.1:6379', REDIS_KEY_NAMESPACE: 'dev' });

    expect(vi.mocked(logger.warn)).not.toHaveBeenCalled();
  });

  it('AC-2-32: REDIS_URL set and REDIS_KEY_NAMESPACE unset refuses boot naming the variable, and writes no warn line', () => {
    const outcome = outcomeOf(() => {
      assertRedisConfigured({ REDIS_URL: 'redis://127.0.0.1:6379' });
    });

    expect({ outcome, namesTheVariable: REDIS_KEY_NAMESPACE_UNSET_MESSAGE.includes('REDIS_KEY_NAMESPACE') }).toEqual({
      outcome: refused(REDIS_KEY_NAMESPACE_UNSET_MESSAGE),
      namesTheVariable: true,
    });
    expect(vi.mocked(logger.warn)).not.toHaveBeenCalled();
  });
});

describe('redirectCacheFor (the bound cache)', () => {
  beforeEach(() => {
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('AC-2-32: REDIS_URL unset binds UnavailableRedirectCache, and every read answers "unavailable"', async () => {
    const cache = redirectCacheFor({});

    expect(cache).toBeInstanceOf(UnavailableRedirectCache);
    await expect(cache.getHost('links.example.test')).resolves.toBe('unavailable');
    await expect(cache.getLink('links.example.test', 'abc1234')).resolves.toBe('unavailable');
  });

  it('D-2-09: the degraded binding swallows every write rather than throwing into a caller', async () => {
    const cache = redirectCacheFor({});

    await expect(
      Promise.all([
        cache.setHost('links.example.test', 'miss'),
        cache.setLink('links.example.test', 'abc1234', 'miss'),
        cache.delHost('links.example.test'),
        cache.delLink('links.example.test', 'abc1234'),
      ]),
    ).resolves.toEqual([undefined, undefined, undefined, undefined]);
  });

  it('an invalid binding refuses rather than falling back to the degraded cache', () => {
    // A factory reached without `main.ts`'s assertion (a testing module) must not turn a
    // typo into a silently degraded redirect, the `resolveMailTransport` rule.
    expect(outcomeOf(() => redirectCacheFor({ REDIS_URL: 'redis://127.0.0.1:6379' }))).toEqual(
      refused(REDIS_KEY_NAMESPACE_UNSET_MESSAGE),
    );
  });
});

describe('createRedisClient (ADR-0012, the six options verbatim)', () => {
  beforeEach(() => {
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('AC-2-30: the constructed client carries the ADR-0012 option set', () => {
    // Port 1 is closed: the client is constructed, inspected and disconnected. It never
    // reaches a server, and `lazyConnect: false` means the connect attempt is real. The
    // `error` listener the factory attaches is what keeps that from taking the process down.
    const client = createRedisClient({ url: 'redis://127.0.0.1:1', namespace: 'dev' });

    try {
      expect({
        enableOfflineQueue: client.options.enableOfflineQueue,
        maxRetriesPerRequest: client.options.maxRetriesPerRequest,
        commandTimeout: client.options.commandTimeout,
        connectTimeout: client.options.connectTimeout,
        lazyConnect: client.options.lazyConnect,
        retryAt1: client.options.retryStrategy?.(1),
        retryAt10: client.options.retryStrategy?.(10),
        retryAt1000: client.options.retryStrategy?.(1000),
      }).toEqual({
        enableOfflineQueue: false,
        maxRetriesPerRequest: 1,
        commandTimeout: 50,
        connectTimeout: 1000,
        lazyConnect: false,
        retryAt1: 200,
        retryAt10: 2000,
        retryAt1000: 5000,
      });
    } finally {
      client.disconnect();
    }
  });

  it('the exported option set is the one the client is built from: no second copy to drift', () => {
    const client = createRedisClient({ url: 'redis://127.0.0.1:1', namespace: 'dev' });

    try {
      expect({
        enableOfflineQueue: client.options.enableOfflineQueue,
        maxRetriesPerRequest: client.options.maxRetriesPerRequest,
        commandTimeout: client.options.commandTimeout,
        connectTimeout: client.options.connectTimeout,
        lazyConnect: client.options.lazyConnect,
      }).toEqual({
        enableOfflineQueue: REDIS_CLIENT_OPTIONS.enableOfflineQueue,
        maxRetriesPerRequest: REDIS_CLIENT_OPTIONS.maxRetriesPerRequest,
        commandTimeout: REDIS_CLIENT_OPTIONS.commandTimeout,
        connectTimeout: REDIS_CLIENT_OPTIONS.connectTimeout,
        lazyConnect: REDIS_CLIENT_OPTIONS.lazyConnect,
      });
    } finally {
      client.disconnect();
    }
  });

  it('GC-O: a client that cannot connect emits `error` at the client and never as an unhandled event', async () => {
    // Without a listener, ioredis re-emits a connection failure as an unhandled `error`
    // event and Node takes the process down, the `pg` failure mode F-123 already cost us.
    const client = createRedisClient({ url: 'redis://127.0.0.1:1', namespace: 'dev' });

    try {
      expect(client.listenerCount('error')).toBeGreaterThan(0);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(client.status).not.toBe('ready');
    } finally {
      client.disconnect();
    }
  });

  it('a cache built on the client is a RedisRedirectCache', async () => {
    const cache = redirectCacheFor({ REDIS_URL: 'redis://127.0.0.1:1', REDIS_KEY_NAMESPACE: 'dev' });

    try {
      expect(cache).toBeInstanceOf(RedisRedirectCache);
    } finally {
      // The module singleton was built here. Left open it reconnects every 200 ms for the
      // rest of the run and holds the event loop, which is `allowExitOnIdle`'s lesson one
      // dependency over.
      await closeRedisClient();
    }
  });
});

/**
 * The stripper `mail-transport.spec.ts` and `boot-assertions.spec.ts` use: comments and
 * string literals out, so a variable named in prose or carried inside a refusal message
 * neither satisfies nor fails a scan.
 */
function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g, '""');
}

const apiSource = fileURLToPath(new URL('../', import.meta.url));
const repositoryRoot = fileURLToPath(new URL('../../../../', import.meta.url));

function shippedSources(): ReadonlyArray<{ readonly path: string; readonly code: string }> {
  return readdirSync(apiSource, { recursive: true, encoding: 'utf8' })
    .filter((entry) => entry.endsWith('.ts') && !entry.endsWith('.spec.ts') && !entry.endsWith('.int-spec.ts'))
    .map((entry) => join(apiSource, entry))
    .map((path) => ({
      path: relative(repositoryRoot, path).split(sep).join('/'),
      code: codeOnly(readFileSync(path, 'utf8')),
    }));
}

describe('who reads the Redis variables (GC-B, D-2-09)', () => {
  it('REDIS_URL and REDIS_KEY_NAMESPACE are named in code by exactly cache/redis-client.ts', () => {
    // A SUBSTRING match, the idiom `mail-transport.spec.ts` uses: `REDIS_URL_ENV` and the
    // three message constants all carry the token, and any of them imported into a second
    // file is that file taking an interest in the variable, which is what this is for.
    const naming = shippedSources()
      .filter(({ code }) => code.includes('REDIS_URL') || code.includes('REDIS_KEY_NAMESPACE'))
      .map(({ path }) => path)
      .sort();

    expect(naming).toEqual(['apps/api/src/cache/redis-client.ts']);
  });

  it('nothing under apps/api/src/cache/** names NODE_ENV in code', () => {
    const offenders = shippedSources()
      .filter(({ path }) => path.startsWith('apps/api/src/cache/'))
      .filter(({ code }) => /\bNODE_ENV\b/.test(code))
      .map(({ path }) => path);

    expect(offenders).toEqual([]);
  });

  it('the raw client is not import-anywhere: `redisClient` is named only under apps/api/src/cache/**', () => {
    // ADR-0012 is one client and one failure posture. TASK-051-era reuse (the limiters, the
    // revocation store) is a deliberate export later (D-2-01 deferred it), not an import
    // somebody adds. Consumers hold the `REDIRECT_CACHE` token instead.
    const offenders = shippedSources()
      .filter(({ code }) => /\bredisClient\b/.test(code))
      .map(({ path }) => path)
      .filter((path) => !path.startsWith('apps/api/src/cache/'));

    expect(offenders).toEqual([]);
  });

  it('there are files under apps/api/src/cache/** for the scans to cover', () => {
    expect(shippedSources().filter(({ path }) => path.startsWith('apps/api/src/cache/')).length).toBeGreaterThan(3);
  });
});

describe('the call site in main.ts', () => {
  const main = readFileSync(fileURLToPath(new URL('../main.ts', import.meta.url)), 'utf8');
  const code = codeOnly(main);

  it('AC-2-32: main.ts calls assertRedisConfigured before it listens', () => {
    const called = code.indexOf('assertRedisConfigured(');
    const listen = code.indexOf('.listen(');

    expect({ called: called !== -1, beforeListen: called !== -1 && called < listen }).toEqual({
      called: true,
      beforeListen: true,
    });
  });

  it('the call is unconditional: the gating is inside the function (GC-B)', () => {
    const line = code.split('\n').find((candidate) => candidate.includes('assertRedisConfigured('));

    expect(line?.trim()).toBe('assertRedisConfigured(process.env);');
  });

  it('F-245: bootstrap().catch maps RedisBindingError.binding onto boot_precondition', () => {
    expect(code).toContain('error instanceof RedisBindingError ? { boot_precondition: error.binding }');
  });

  it('the assertion sits with the other env-only preconditions, before the database ones', () => {
    // Its class: three `process.env` reads and a `new URL()`. A misconfigured namespace
    // refuses in two milliseconds rather than after a twenty-second database budget.
    expect(code.indexOf('assertRedisConfigured(')).toBeLessThan(code.indexOf('answeredOrRetried('));
  });
});
