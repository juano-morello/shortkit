import { Body, Controller, Get, Param, Post, RequestMethod } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import type { CryptoKey, JSONWebKeySet, JWTPayload } from 'jose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppModule } from '../app.module';
import { JWKS_KEY_SET_SOURCE, REVOCATION_STORE } from '../auth/auth.guard';
import { InMemoryRevocationStore } from '../auth/revocation-store';
import { DomainError } from '../common/errors/domain-error';
import { NoTenantTransaction, Public } from '../tenancy/tenant-context';
import { LOGGABLE_FIELDS, REDACT_CENSOR, logger } from './logger';

/**
 * STORY-006 — AC-33 (the line exists), AC-34 (its fields), over a real HTTP round trip.
 * TASK-016, wave 8.
 *
 * Contract: `docs/contracts/logging-and-headers.md`, "Required fields" (`request_id`, `route`
 * as the PATTERN, `status`, `duration_ms`, `tenant_id` inside a tenant transaction) and
 * "A field reaches a line only if it is named" (ADR-0028). Enforces GC-9.
 *
 * ============================================================================
 * THE REAL MODULE GRAPH, A PROBE ROUTE BESIDE IT, AND THE BYTES PINO WROTE.
 * ============================================================================
 *
 * The application is compiled from `AppModule` the way `auth.guard.spec.ts` and
 * `tenant-transaction.interceptor.spec.ts` do it — the real `APP_GUARD`, both real
 * `APP_INTERCEPTOR`s in the order `app.module.ts` registers them, the real filter — with the
 * `/api` global prefix `main.ts` sets, so the `route` asserted below is the pattern a client's
 * URL matches and not a test-only spelling. The probe controller is a fixture registered
 * BESIDE the module: it is `@NoTenantTransaction()` because this tier has no database, and
 * the guard still runs in full for it, which is what puts a `RequestContext` on the request.
 *
 * WHAT IS ASSERTED IS THE STRING PINO HANDED ITS DESTINATION, not the record a call site
 * built. The shared logger writes file descriptor 1 synchronously through the stream it was
 * constructed with; that stream's `write` is spied here, so every assertion is over the same
 * bytes an aggregator would receive, after `formatters.log` has censored whatever it censors.
 * The other suites in this directory read a CHILD's fd 1 for the same reason; this one needs
 * a signed token and a live Nest app on the same side of the assertion, and a spy on the
 * destination is the in-process equivalent. If pino renames the symbol the lookup below
 * throws in `beforeAll` rather than letting the suite pass over nothing.
 *
 * `LOG_LEVEL` is unset, which is `info` — the level the deployed image runs at (no
 * `LOG_LEVEL` in the `Dockerfile`), and the level the request line is written at.
 */

const ISSUER = 'http://127.0.0.1:43113';
const TENANT_ID = '3f2a9c1e-7b4d-4e8a-9c6f-1d2e3f4a5b6c';
const USER_ID = 'user_7d3e2f1a0b9c8d7e';
const SESSION_ID = 'sess_1c9f0b7e2d4a6c8b';

/** A credential posted in a body. It must reach no line, in no field, under no spelling. */
const PASSWORD_IN_A_BODY = 'hunter2-request-log-body-marker';

/** An id in the URL. The line carries the pattern, so this string must not be on it. */
const ITEM_ID = 'item-8f2c1a9d-concrete-id-in-the-path';

/** `x-request-id` a caller sends, so the filter's line and the request line share it. */
const CALLER_REQUEST_ID = 'caller-supplied-correlation-id-0001';

/**
 * The fixed `msg` the interceptor writes and the filter's context string for branch 4.
 * Hand-copied rather than imported: an expected value read out of the module under test
 * agrees with it whatever it says.
 */
const REQUEST_COMPLETED = 'request completed';
const UNHANDLED = 'unhandled';

/**
 * The keys pino's own configuration puts on every line — `base` is `{ service, env }`, the
 * level formatter emits `level`, `timestamp` is `time`. Not `LOGGABLE_FIELDS`' business: they
 * are bindings pino writes, not fields a call site names, and the contract lists them under
 * "What the implementer must guarantee" as the shape a shipper depends on.
 */
const PINO_OWN_KEYS = new Set(['level', 'time', 'service', 'env']);

/** The one key `formatters.log` leaves to `serializers.err` — the partition in `logger.ts`. */
const ERROR_KEY = 'err';

const PROBE = '/api/request-log-probe';

@Controller('request-log-probe')
@NoTenantTransaction('the request log line is under test and this tier has no database')
class RequestLogProbeController {
  @Get('items')
  list(): { items: never[] } {
    return { items: [] };
  }

  /** 201 is Nest's default for `@Post()`. The body is accepted and deliberately ignored. */
  @Post('items')
  create(@Body() _body: unknown): { created: true } {
    return { created: true };
  }

  @Get('items/:id')
  one(@Param('id') _id: string): never {
    throw new DomainError('not_found', 'The requested resource was not found.');
  }

  @Get('boom')
  boom(): never {
    throw new Error('the handler fell over');
  }

  @Get('public')
  @Public('the request log line for an unauthenticated route is under test')
  publicRoute(): { ok: true } {
    return { ok: true };
  }
}

interface EmittedLine {
  readonly raw: string;
  readonly record: Record<string, unknown>;
}

let app: INestApplication;
let baseUrl: string;
let signingKey: CryptoKey;
let keySet: JSONWebKeySet;
let stream: { write(chunk: string): unknown };
let captured: string[];

function claims(overrides: JWTPayload = {}): JWTPayload {
  return { sub: USER_ID, tid: TENANT_ID, email: 'operator@example.com', ev: true, jti: SESSION_ID, ...overrides };
}

async function sign(payload: JWTPayload = claims()): Promise<string> {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'EdDSA', kid: 'test-key' })
    .setIssuedAt()
    .setIssuer(ISSUER)
    .setAudience(ISSUER)
    .setExpirationTime(Math.floor(Date.now() / 1000) + 300)
    .sign(signingKey);
}

interface Probe {
  readonly status: number;
  readonly raw: string;
}

async function probe(
  path: string,
  options: { method?: 'GET' | 'POST'; token?: string; headers?: Record<string, string>; body?: unknown } = {},
): Promise<Probe> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      ...(options.token === undefined ? {} : { authorization: `Bearer ${options.token}` }),
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...options.headers,
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });

  return { status: response.status, raw: await response.text() };
}

/**
 * The stream the shared logger was constructed with. `logger[Symbol('pino.stream')]` is an
 * own property of the root instance (`pino.js`, `[streamSym]: stream`), and every child reads
 * it through the prototype chain, so one spy sees every line the process would write.
 */
function pinoStreamOf(instance: object): { write(chunk: string): unknown } {
  const symbol = Object.getOwnPropertySymbols(instance).find(
    (candidate) => candidate.description === 'pino.stream',
  );

  if (symbol === undefined) {
    throw new Error('the pino stream symbol was not found on the shared logger; nothing below could capture a line');
  }

  return (instance as unknown as Record<symbol, { write(chunk: string): unknown }>)[symbol];
}

function lines(): EmittedLine[] {
  return captured
    .join('')
    .split('\n')
    .filter((line) => line !== '')
    .map((raw) => ({ raw, record: JSON.parse(raw) as Record<string, unknown> }));
}

/** The request lines only: the ones carrying `route`. */
function requestLines(): EmittedLine[] {
  return lines().filter((line) => line.record.route !== undefined);
}

/**
 * The response reaches the client and the server's `'finish'` listener runs on separate
 * turns of the same event loop, in no guaranteed order, so a line is awaited rather than
 * read straight after `fetch`. Bounded: a line that never comes fails the test loudly.
 */
async function eventually(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 2_000;

  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}. Captured so far:\n${captured.join('')}`);
    }

    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

async function theRequestLine(): Promise<EmittedLine> {
  await eventually(() => requestLines().length >= 1, 'a request log line');
  const emitted = requestLines();

  expect(emitted, `expected exactly one request line, got:\n${emitted.map((line) => line.raw).join('\n')}`).toHaveLength(1);

  return emitted[0];
}

/** ADR-0028 over one emitted line: every key is named, pino's own, the `err` seam, or censored. */
function expectEveryFieldNamedOrCensored(line: EmittedLine): void {
  const offending = Object.entries(line.record).filter(([key, value]) => {
    if (LOGGABLE_FIELDS.has(key) || PINO_OWN_KEYS.has(key)) {
      return false;
    }

    if (key === ERROR_KEY && typeof value === 'object' && value !== null) {
      return Object.keys(value).some((inner) => !LOGGABLE_FIELDS.has(inner));
    }

    return value !== REDACT_CENSOR;
  });

  expect(offending, `keys neither named nor censored on:\n${line.raw}`).toEqual([]);
}

beforeAll(async () => {
  const pair = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
  signingKey = pair.privateKey;
  keySet = { keys: [{ ...(await exportJWK(pair.publicKey)), alg: 'EdDSA', kid: 'test-key' }] };

  vi.stubEnv('BETTER_AUTH_URL', ISSUER);
  // `/health` reads the build SHA per request and 500s without one; the assertion on it below
  // is about its line's shape, not about the SHA.
  vi.stubEnv('GIT_COMMIT_SHA', '3d1f7a0c94b25e68af31c07d5b8e4a2196fd0c7b');

  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
    controllers: [RequestLogProbeController],
  })
    .overrideProvider(JWKS_KEY_SET_SOURCE)
    .useValue(() => Promise.resolve(keySet))
    .overrideProvider(REVOCATION_STORE)
    .useValue(new InMemoryRevocationStore())
    .compile();

  // `logger: false` silences NEST's own logger. The pino singleton is untouched — its lines
  // are the subject.
  app = moduleRef.createNestApplication({ logger: false });
  // The same prefix and exclusion `main.ts` sets (ADR-0006), so `route` below is the pattern
  // a client's URL matches.
  app.setGlobalPrefix('api', { exclude: [{ path: 'health', method: RequestMethod.GET }] });
  await app.listen(0, '127.0.0.1');
  baseUrl = await app.getUrl();

  stream = pinoStreamOf(logger);
});

beforeEach(() => {
  captured = [];
  vi.spyOn(stream, 'write').mockImplementation((chunk: string) => {
    captured.push(chunk);
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await app?.close();
  vi.unstubAllEnvs();
});

describe('one line per request, carrying the five named fields and nothing else', () => {
  it('AC-33/AC-34: an authenticated 200 emits one info line with exactly request_id, route, status, tenant_id and duration_ms', async () => {
    const result = await probe(`${PROBE}/items`, { token: await sign() });
    expect(result.status, result.raw).toBe(200);

    const line = await theRequestLine();

    // Exactly the five fields, plus `msg` and pino's own keys. No `method` (not in the
    // contract's "Required fields"), no user id, no email, nothing of the URL or headers.
    expect(Object.keys(line.record).sort()).toEqual(
      ['duration_ms', 'env', 'level', 'msg', 'request_id', 'route', 'service', 'status', 'tenant_id', 'time'].sort(),
    );
    expect(line.record.level).toBe('info');
    expect(line.record.msg).toBe(REQUEST_COMPLETED);
    expect(line.record.route).toBe(`${PROBE}/items`);
    expect(line.record.status).toBe(200);
    expect(line.record.tenant_id).toBe(TENANT_ID);
    expect(line.record.request_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(typeof line.record.duration_ms).toBe('number');
    expect(line.record.duration_ms).toBeGreaterThanOrEqual(0);
    expectEveryFieldNamedOrCensored(line);
  });

  it('a 201 from a @Post() handler is logged as 201', async () => {
    const result = await probe(`${PROBE}/items`, { method: 'POST', token: await sign(), body: { name: 'Acme' } });
    expect(result.status, result.raw).toBe(201);

    const line = await theRequestLine();

    expect(line.record.status).toBe(201);
    expect(line.record.route).toBe(`${PROBE}/items`);
  });

  it('route is the PATTERN, never the concrete path: a 404 thrown by the handler logs `/items/:id` and no id', async () => {
    const result = await probe(`${PROBE}/items/${ITEM_ID}`, { token: await sign() });
    expect(result.status, result.raw).toBe(404);

    const line = await theRequestLine();

    expect(line.record.route).toBe(`${PROBE}/items/:id`);
    expect(line.record.status).toBe(404);
    expect(line.record.tenant_id).toBe(TENANT_ID);
    // Byte-level, over every line this request produced, not only the `route` field.
    for (const emitted of lines()) {
      expect(emitted.raw).not.toContain(ITEM_ID);
    }
  });

  it('a handler that throws a plain Error is logged with the 500 the filter wrote, and the caller’s x-request-id is on both lines', async () => {
    // MEASURED, and the reason the interceptor reads the status on `'finish'` rather than in
    // an RxJS `finalize`: at `finalize` time the filter has not written yet and
    // `response.statusCode` still reads 200 for this request. See the interceptor's header.
    const result = await probe(`${PROBE}/boom`, {
      token: await sign(),
      headers: { 'x-request-id': CALLER_REQUEST_ID },
    });
    expect(result.status, result.raw).toBe(500);

    const line = await theRequestLine();
    expect(line.record.status).toBe(500);
    expect(line.record.route).toBe(`${PROBE}/boom`);
    expect(line.record.request_id).toBe(CALLER_REQUEST_ID);

    // The filter's own line for the same request, correlated by the id the caller sent.
    const filterLine = lines().find((emitted) => emitted.record.msg === UNHANDLED);
    expect(filterLine, `no filter line among:\n${captured.join('')}`).toBeDefined();
    expect(filterLine?.record.request_id).toBe(CALLER_REQUEST_ID);
    expect(filterLine?.record.err_name).toBe('Error');
    // The handler's message is withheld everywhere (`errorLogFields`, `includeMessage: false`).
    for (const emitted of lines()) {
      expect(emitted.raw).not.toContain('the handler fell over');
      expectEveryFieldNamedOrCensored(emitted);
    }
  });

  it('with NO x-request-id, the filter’s error line and the request line still share one generated request_id', async () => {
    // The interceptor chooses the id and stores it under `REQUEST_ID_KEY`; the filter reads
    // that slot first (`observability/request-id.ts`). Before that, both generated their own
    // uuid and the two lines for one failed request could not be joined.
    const result = await probe(`${PROBE}/boom`, { token: await sign() });
    expect(result.status, result.raw).toBe(500);

    const line = await theRequestLine();
    const filterLine = lines().find((emitted) => emitted.record.msg === UNHANDLED);

    expect(filterLine, `no filter line among:\n${captured.join('')}`).toBeDefined();
    expect(line.record.request_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(filterLine?.record.request_id).toBe(line.record.request_id);
  });

  it('a caller-supplied x-request-id is trimmed and capped at 128 characters, the same reading the filter gives it', async () => {
    const long = `  ${'x'.repeat(200)}  `;
    const result = await probe(`${PROBE}/items`, { token: await sign(), headers: { 'x-request-id': long } });
    expect(result.status, result.raw).toBe(200);

    const line = await theRequestLine();

    expect(line.record.request_id).toBe('x'.repeat(128));
  });
});

describe('tenant_id is present only when a RequestContext exists', () => {
  it('a @Public() route on the probe gets a line with no tenant_id key at all', async () => {
    const result = await probe(`${PROBE}/public`);
    expect(result.status, result.raw).toBe(200);

    const line = await theRequestLine();

    expect(line.record).not.toHaveProperty('tenant_id');
    expect(line.record.route).toBe(`${PROBE}/public`);
    expect(line.record.status).toBe(200);
    expect(Object.keys(line.record).sort()).toEqual(
      ['duration_ms', 'env', 'level', 'msg', 'request_id', 'route', 'service', 'status', 'time'].sort(),
    );
  });

  it('GET /health — the one route excluded from the global prefix — logs the pattern `/health` with no tenant_id', async () => {
    const result = await probe('/health');
    expect(result.status, result.raw).toBe(200);

    const line = await theRequestLine();

    expect(line.record.route).toBe('/health');
    expect(line.record).not.toHaveProperty('tenant_id');
  });
});

describe('what the line never carries', () => {
  it('a body carrying a password reaches no line, in no field, under no spelling', async () => {
    const result = await probe(`${PROBE}/items`, {
      method: 'POST',
      token: await sign(),
      body: { name: 'Acme', password: PASSWORD_IN_A_BODY, confirmation: PASSWORD_IN_A_BODY },
    });
    expect(result.status, result.raw).toBe(201);

    const line = await theRequestLine();

    expect(line.record.status).toBe(201);
    expect(line.raw).not.toContain(PASSWORD_IN_A_BODY);
    expect(line.record).not.toHaveProperty('password');
    expect(line.record).not.toHaveProperty('body');
    for (const emitted of lines()) {
      expect(emitted.raw).not.toContain(PASSWORD_IN_A_BODY);
      expectEveryFieldNamedOrCensored(emitted);
    }
  });

  it('the token that authenticated the request is on no line', async () => {
    const token = await sign();
    const result = await probe(`${PROBE}/items`, { token });
    expect(result.status, result.raw).toBe(200);

    await theRequestLine();

    for (const emitted of lines()) {
      expect(emitted.raw).not.toContain(token);
      for (const segment of token.split('.')) {
        expect(emitted.raw).not.toContain(segment);
      }
    }
  });
});

describe('what the interceptor does not see, measured so the claim is not read wider than it is', () => {
  it('a request the guard refuses (401) produces no request line: Nest runs guards before interceptors', async () => {
    const refused = await probe(`${PROBE}/items`);
    expect(refused.status, refused.raw).toBe(401);

    // A second, accepted request pins the ordering: by the time its line has arrived, any
    // line the refused request could have produced would be there too.
    const accepted = await probe(`${PROBE}/public`);
    expect(accepted.status, accepted.raw).toBe(200);

    const line = await theRequestLine();

    expect(line.record.route).toBe(`${PROBE}/public`);
    expect(requestLines()).toHaveLength(1);
  });
});
