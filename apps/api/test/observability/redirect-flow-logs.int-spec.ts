import { request as httpRequest } from 'node:http';

import pg from 'pg';
import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runTransaction, SEED_TRANSACTIONS } from '../../scripts/seed.mts';
import { PLATFORM_TENANT_ID } from '../../src/db/platform';
import { CACHE_INVALIDATION_FAILED_CODE } from '../../src/links/cache-invalidation.subscriber';
import { LOGGABLE_FIELDS, REDACT_CENSOR } from '../../src/observability/logger';
import { startApiServer } from '../support/api-server';
import type { ApiServer } from '../support/api-server';
import {
  POLICY_COMPLIANT_PASSWORD,
  authServerEnv,
  clearSignupState,
  jwtClaims,
  mintToken,
  signIn,
  signUp,
} from '../support/auth-fixture';
import { execSql, querySql } from '../support/psql';
import { appDsn, migrationDsn } from '../support/rls-fixture';

/**
 * STORY-2-08, AC-2-43: SC-5 widened to the WHOLE ITEM-2 FLOW, measured on the bytes one
 * child process wrote. TASK-2-10, wave 5.
 *
 * Contract: `docs/contracts/logging-and-headers.md` ("Required fields", "What may never
 * appear in a log line", "A field reaches a line only if it is named"),
 * `redirect-cache.md` ("On failure", as amended 2026-08-19), `click-events.md` (`ip_hash`
 * never leaves the database), `redirect-resolution.md`. ADR-0028, ADR-0010, ADR-0012;
 * D-2-15, D-2-19. Enforces GC-G and GC-R.
 *
 * ============================================================================
 * ONE CHILD, ONE CAPTURE, THE WHOLE LOOP: CREATE, HIT, MISS, FLUSH, FAILED INVALIDATION.
 * ============================================================================
 *
 * `no-credentials-in-logs.int-spec.ts` is the same mechanism over the auth and workspace
 * flow, and this file is deliberately its sibling rather than an extension of it: the flow
 * here needs a child configured DIFFERENTLY (a declared trusted-address header, and a
 * `REDIS_URL` pointing at a port nothing listens on), and a suite that reconfigured the
 * other one would weaken the assertions that already run there.
 *
 * WHAT THE FLOW DRIVES, AND WHY EACH LEG IS HERE:
 *
 *   POST /api/links          the destination URL enters the process, in a request body and
 *                            then in a row. It is the single most quotable value in item 2:
 *                            it is attacker-supplied, it is what the 302 carries, and it is
 *                            what a driver error message would print (`link.repository.ts`
 *                            says so and reads neither `.code` nor `.message`).
 *   GET /<slug>   (hit)      the concrete path, the hostname and the slug all arrive on one
 *                            request. The line must carry the PATTERN `/:slug` and nothing
 *                            derived from the segment; the cache key the redirect builds
 *                            (`rdr:v1:{hostname}:{slug}`) must appear nowhere at all.
 *   GET /<miss>   (miss)     the 404 path, which is where a "not found: <what>" line is
 *                            most tempting to write.
 *   the click flush          `ip_hash` is written to `click_events` and is pseudonymous per
 *                            deployment. The raw address reaches the process as a header and
 *                            must appear on no line; NEITHER MUST THE HASH, which is read
 *                            back out of the database here and scanned for as bytes.
 *   PATCH /api/links/:linkId a FORCED INVALIDATION FAILURE: the child's Redis binding names
 *                            a port nothing listens on, so `delLink` rejects, the retry
 *                            schedule is exhausted and the subscriber writes its one line.
 *                            That line is D-2-15's whole subject: `code`, `link_id`,
 *                            `attempts`, and NOT the key, the hostname or the slug the key
 *                            embeds.
 *
 * THE RAW ADDRESS IS PLANTED RATHER THAN INFERRED. `trustedClientIp` reads the header
 * `TRUSTED_CLIENT_IP_HEADER` names and nothing else (ADR-0040), so the child declares one
 * and the redirect carries it. Without that, every visitor hashes the sentinel and the
 * "no raw address" assertion would be true of a process that never saw one, which is the
 * F-295 shape this repository keeps filing. 203.0.113.42 is TEST-NET-3 (RFC 5737): it
 * belongs to nobody and it cannot arrive by accident.
 *
 * WHY THE SCAN IS FOR THESE BYTES RATHER THAN FOR AN IPv4 PATTERN. The Redis binding that
 * forces the invalidation failure produces one throttled `redirect_cache_unavailable` warn
 * whose `err_stack` names the address of the CACHE (`127.0.0.1:<port>`, the connection this
 * process configured), which is not a visitor and not a tenant's data. A pattern scan would
 * fire on it and the repair would be to weaken the scan, so the assertion names the planted
 * value, the hash the database holds, and the fields no line may carry.
 */

const EMAIL = 'wave5-redirect-flow-logs@example.com';
/** D-2-02: the seeded system default domain locally, and the `Host` the redirect resolves. */
const HOSTNAME = 'localhost';
const SLUG = 'flowLogA1';
/** A slug nothing issued: the 404 leg. Same shape, so it passes the fast shape-reject. */
const MISS_SLUG = 'flowLogB2';
/**
 * A destination whose path segment is unmistakable in a byte scan, and whose query carries
 * a value a serialiser would have to have chosen to print.
 */
const DESTINATION = 'https://example.test/wave5-destination-never-logged?utm=flow-logs';
const EDITED_DESTINATION = 'https://example.test/wave5-edited-never-logged?utm=flow-logs';
/** TEST-NET-3 (RFC 5737). Belongs to nobody; cannot arrive by accident. */
const CLIENT_IP = '203.0.113.42';
/** The header the child declares as its trusted source of that address (ADR-0040). */
const TRUSTED_HEADER = 'x-shortkit-client-ip';
/**
 * A port nothing listens on, so every `delLink` rejects and the invalidation failure is
 * FORCED rather than simulated. Port 1 is privileged and unbound on every runner this suite
 * targets; the client stays away from `ready`, so `RedisRedirectCache.remove` throws its
 * `RedirectCacheUnavailableError` on the first call and on every retry.
 */
const UNREACHABLE_REDIS = 'redis://127.0.0.1:1';
const NAMESPACE = `it-flow-${String(process.pid)}`;

/** How long the child gets to flush the last line into the parent's capture. */
const CAPTURE_SETTLE_MS = 15_000;
/** The buffer flushes at 1000 ms or 100 events (ADR-0010); one click needs the timer. */
const CLICK_FLUSH_BUDGET_MS = 15_000;

/** pino's own keys on every line: `base` is `{ service, env }`, plus `level` and `time`. */
const PINO_OWN_KEYS = new Set(['level', 'time', 'service', 'env']);
/** The one key `formatters.log` leaves to `serializers.err` (`logger.ts`, the partition). */
const ERROR_KEY = 'err';

/**
 * THE TWO WRITERS THAT ARE NOT PINO, both already on record in
 * `no-credentials-in-logs.int-spec.ts`: Nest's bootstrap logger and Better Auth's
 * package-level `onError` logger (ADR-0052's F-216 amendment). Anything else that does not
 * parse as JSON fails the suite, which is what "every line is JSON but the pinned set"
 * means here.
 */
const NEST_BOOTSTRAP_LINE = /^\[Nest\] \d+\s+- /;
const BETTER_AUTH_PACKAGE_LOGGER_LINE = /\[Better Auth\]:/;
/* eslint-disable-next-line no-control-regex -- the ANSI escape prefix those two writers use */
const ANSI_ESCAPE = /\u001b\[[0-9;]*m/g;

const REQUEST_COMPLETED = 'request completed';
/** The route PATTERN the redirect controller logs. Never the concrete path (GC-G). */
const REDIRECT_ROUTE_PATTERN = '/:slug';

/**
 * `LOGGABLE_FIELDS` AS ITEM 1b LEFT IT, hand-written so the growth is a diff rather than a
 * count. AC-2-43 asks for exactly two new names, and the two are D-2-15's: the invalidation
 * failure line carries `link_id` and `attempts` and nothing else beyond `code`.
 */
const LOGGABLE_FIELDS_BEFORE_ITEM_2 = [
  'attempt',
  'boot_precondition',
  'code',
  'duration_ms',
  'err_message',
  'err_name',
  'err_stack',
  'msg',
  'request_id',
  'retry_in_ms',
  'route',
  'status',
  'template',
  'tenant_id',
];

interface EmittedLine {
  readonly raw: string;
  readonly record: Record<string, unknown>;
}

interface Probe {
  readonly status: number;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: unknown;
  readonly raw: string;
}

/** Everything the flow produced that an assertion needs, so each `it` reads and never re-runs it. */
interface FlowArtefacts {
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly linkId: string;
  /** The pseudonymous hash the database holds for the planted address. Never on a line. */
  readonly ipHash: string;
  readonly statuses: Readonly<Record<string, number>>;
  readonly redirectLocation: string;
  readonly output: string;
}

let serverBoot: Promise<ApiServer>;
let server: ApiServer;
let artefacts: FlowArtefacts;

/* ========================================================================== *
 * HTTP. `node:http` rather than `fetch`, so the `Host` header can be the hostname the
 * seeded domain carries while the socket goes to the loopback address the child bound.
 * ========================================================================== */

async function issue(
  method: 'GET' | 'POST' | 'PATCH',
  path: string,
  options: {
    readonly host?: string;
    readonly token?: string;
    readonly body?: unknown;
    readonly headers?: Record<string, string>;
  } = {},
): Promise<Probe> {
  const port = Number(new URL(server.baseUrl).port);
  const payload = options.body === undefined ? undefined : JSON.stringify(options.body);

  return new Promise<Probe>((resolve, reject) => {
    const call = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path,
        method,
        setHost: false,
        headers: {
          host: options.host ?? '127.0.0.1',
          ...(options.token === undefined ? {} : { authorization: `Bearer ${options.token}` }),
          ...(payload === undefined
            ? {}
            : { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) }),
          ...options.headers,
        },
      },
      (response) => {
        const chunks: Buffer[] = [];

        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');

          let body: unknown = raw;
          try {
            body = JSON.parse(raw) as unknown;
          } catch {
            /* left as the raw text */
          }

          resolve({ status: response.statusCode ?? 0, headers: response.headers, body, raw });
        });
      },
    );

    call.on('error', reject);

    if (payload !== undefined) {
      call.write(payload);
    }

    call.end();
  });
}

/* ========================================================================== *
 * The capture, and the lines in it.
 * ========================================================================== */

function emittedLines(output: string): EmittedLine[] {
  return output
    .split('\n')
    .filter((line) => line !== '')
    .map((raw) => {
      try {
        return { raw, record: JSON.parse(raw) as Record<string, unknown> };
      } catch {
        // Kept, with an empty record, so the byte scan still covers it and the "every line
        // is JSON" assertion names it.
        return { raw, record: {} };
      }
    });
}

function requestLines(output: string): EmittedLine[] {
  return emittedLines(output).filter((line) => line.record.msg === REQUEST_COMPLETED);
}

/** ADR-0028's polarity: a field is named on the allowlist, or its VALUE reads `[redacted]`. */
function keysNeitherNamedNorCensored(record: Record<string, unknown>): string[] {
  return Object.keys(record).filter(
    (key) =>
      !PINO_OWN_KEYS.has(key) &&
      key !== ERROR_KEY &&
      !LOGGABLE_FIELDS.has(key) &&
      record[key] !== REDACT_CENSOR,
  );
}

async function untilCaptured(condition: (output: string) => boolean, what: string): Promise<string> {
  const deadline = Date.now() + CAPTURE_SETTLE_MS;

  for (;;) {
    const output = server.output();

    if (condition(output)) {
      return output;
    }

    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}. The child's output was:\n${output}`);
    }

    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
}

/* ========================================================================== *
 * The platform seed, through the shipped units (`links.int-spec.ts`'s shape).
 * ========================================================================== */

function platformTransaction() {
  const found = SEED_TRANSACTIONS.find((transaction) => transaction.tenantId === PLATFORM_TENANT_ID);

  if (found === undefined) {
    throw new Error('scripts/seed.mts has no platform transaction; no link can be created.');
  }

  return found;
}

async function seedPlatform(): Promise<void> {
  const pool = new pg.Pool({ connectionString: appDsn() });

  try {
    const client: PoolClient = await pool.connect();

    try {
      await runTransaction(client, platformTransaction(), new Map());
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

function dropPlatformRows(): void {
  execSql(migrationDsn(), `DELETE FROM tenants WHERE id = :'tenant'::uuid;`, {
    tenantId: PLATFORM_TENANT_ID,
    flags: { 'app.privileged_erase': PLATFORM_TENANT_ID },
    variables: { tenant: PLATFORM_TENANT_ID },
  });
}

/** The click row the flush wrote, polled: the buffer's timer is what decides when. */
async function untilClickRow(tenantId: string, linkId: string): Promise<{ ip_hash: string }> {
  const deadline = Date.now() + CLICK_FLUSH_BUDGET_MS;

  for (;;) {
    const [row] = querySql<{ ip_hash: string }>(
      migrationDsn(),
      `SELECT ip_hash FROM click_events WHERE link_id = :'link'::uuid AND tenant_id = :'tenant'::uuid`,
      { tenantId, variables: { link: linkId, tenant: tenantId } },
    );

    if (row !== undefined) {
      return row;
    }

    if (Date.now() > deadline) {
      throw new Error(
        `no click row reached click_events for link ${linkId} within ` +
          `${String(CLICK_FLUSH_BUDGET_MS)}ms, so nothing here would measure ip_hash. The ` +
          `child's output was:\n${server.output()}`,
      );
    }

    await new Promise<void>((resolve) => setTimeout(resolve, 250));
  }
}

/* ========================================================================== *
 * The flow.
 * ========================================================================== */

async function runFlow(): Promise<FlowArtefacts> {
  const statuses: Record<string, number> = {};

  const signedUp = await signUp(server, EMAIL, POLICY_COMPLIANT_PASSWORD);
  expect(signedUp.status, signedUp.raw).toBe(200);
  statuses.signUp = signedUp.status;

  const signedIn = await signIn(server, EMAIL, POLICY_COMPLIANT_PASSWORD);
  expect(signedIn.status, signedIn.raw).toBe(200);
  statuses.signIn = signedIn.status;

  const minted = await mintToken(server, signedIn.cookie);
  expect(minted.status, minted.raw).toBe(200);
  statuses.mint = minted.status;

  const token = (minted.body as { token?: unknown }).token;
  expect(typeof token).toBe('string');
  const jwt = token as string;
  const tenantId = jwtClaims(jwt).tid;
  expect(typeof tenantId).toBe('string');

  const workspace = await issue('POST', '/api/workspaces', {
    token: jwt,
    body: { name: 'Wave 5 flow' },
  });
  expect(workspace.status, workspace.raw).toBe(201);
  statuses.workspace = workspace.status;
  const workspaceId = (workspace.body as { id: string }).id;

  // The destination enters the process here, in a body, and is stored. Every assertion
  // below is about it not leaving through a log line. The create ALSO fires the invalidation
  // of the negative key, which against this child's Redis binding is the first exhausted
  // retry schedule of the run.
  const created = await issue('POST', '/api/links', {
    token: jwt,
    body: { workspaceId, slug: SLUG, destinationUrl: DESTINATION },
  });
  expect(created.status, created.raw).toBe(201);
  statuses.create = created.status;
  const linkId = (created.body as { id: string }).id;

  // THE HIT. `Host: localhost` is the seeded system default domain, so the redirect
  // resolves from Postgres (the cache is unreachable by construction) and answers 302 with
  // the stored destination byte for byte.
  const hit = await issue('GET', `/${SLUG}`, {
    host: HOSTNAME,
    headers: { [TRUSTED_HEADER]: CLIENT_IP },
  });
  expect(hit.status, hit.raw).toBe(302);
  statuses.hit = hit.status;
  const location = hit.headers.location;
  expect(typeof location).toBe('string');

  // THE MISS. A slug nothing issued: the same route, the default 404 page.
  const miss = await issue('GET', `/${MISS_SLUG}`, {
    host: HOSTNAME,
    headers: { [TRUSTED_HEADER]: CLIENT_IP },
  });
  expect(miss.status, miss.raw).toBe(404);
  statuses.miss = miss.status;

  // THE FLUSH. Off the request path, on the buffer's timer, so it is polled for in the
  // database rather than waited out.
  const click = await untilClickRow(tenantId as string, linkId);

  // THE FORCED INVALIDATION FAILURE. The write commits and answers 200; the after-commit
  // subscriber exhausts its retries against a cache that is not there and writes ONE line.
  const edited = await issue('PATCH', `/api/links/${linkId}`, {
    token: jwt,
    body: { destinationUrl: EDITED_DESTINATION },
  });
  expect(edited.status, edited.raw).toBe(200);
  statuses.edit = edited.status;

  const output = await untilCaptured(
    (captured) =>
      captured.includes(CACHE_INVALIDATION_FAILED_CODE) &&
      requestLines(captured).some((line) => line.record.route === '/api/links/:linkId'),
    'the invalidation failure line and the PATCH request line',
  );

  return {
    tenantId: tenantId as string,
    workspaceId,
    linkId,
    ipHash: click.ip_hash,
    statuses,
    redirectLocation: location as string,
    output,
  };
}

beforeAll(() => {
  clearSignupState(EMAIL);

  serverBoot = seedPlatform().then(async () =>
    startApiServer({
      env: (baseUrl) => ({
        ...authServerEnv(baseUrl),
        // The level the deployed image runs at and the level the request line is written
        // at: left to inherit, a shell exporting LOG_LEVEL=error would silence the lines
        // this file counts and the non-vacuity assertion would fail for the wrong reason.
        LOG_LEVEL: 'info',
        // Declared, unreachable: the redirect degrades to Postgres and every invalidation
        // rejects, which is the state AC-2-43's last leg needs.
        REDIS_URL: UNREACHABLE_REDIS,
        REDIS_KEY_NAMESPACE: NAMESPACE,
        // ADR-0040: the click path reads THIS header and no other, so a raw address only
        // reaches the process because the deployment declared where it comes from.
        TRUSTED_CLIENT_IP_HEADER: TRUSTED_HEADER,
      }),
    }),
  );
  serverBoot.catch(() => undefined);
});

beforeAll(async () => {
  server = await serverBoot;
  artefacts = await runFlow();
}, 180_000);

afterAll(async () => {
  await server?.stop();
  clearSignupState(EMAIL);
  dropPlatformRows();
});

describe('AC-2-43: the whole redirect flow leaves no destination, path, key, address or hash in the bytes the process wrote', () => {
  it('non-vacuity: the flow really happened, and the redirect answered with the stored destination', () => {
    // The count clause F-295 refuses to do without. Everything below is true of a process
    // that served nothing.
    expect(artefacts.statuses).toMatchObject({
      signUp: 200,
      signIn: 200,
      mint: 200,
      workspace: 201,
      create: 201,
      hit: 302,
      miss: 404,
      edit: 200,
    });
    // The 302 carried the destination byte for byte, which is what makes "and it appears on
    // no line" a statement about logging rather than about a redirect that never worked.
    expect(artefacts.redirectLocation).toBe(DESTINATION);
    // The click row exists, so `ip_hash` was really written and the scan below is not
    // scanning for a value nothing produced.
    expect(artefacts.ipHash.length).toBeGreaterThan(0);

    // FIVE request lines, which is every leg the interceptor sees: the workspace create,
    // the link create, the redirect hit, the redirect miss and the PATCH. The three auth
    // legs produce none, because Better Auth is mounted on Express outside the Nest graph
    // (ADR-0013) and no interceptor runs there.
    const lines = requestLines(artefacts.output);

    expect(lines.length, artefacts.output).toBeGreaterThanOrEqual(5);
    expect(lines.map((line) => line.record.route)).toContain('/api/workspaces');
    expect(lines.map((line) => line.record.route)).toContain('/api/links');
    expect(lines.map((line) => line.record.route)).toContain('/api/links/:linkId');
    expect(
      lines.filter((line) => line.record.route === REDIRECT_ROUTE_PATTERN),
    ).toHaveLength(2);
  });

  it('the redirect lines carry the route PATTERN and no concrete path, on the hit and on the miss', () => {
    // GC-G, `logging-and-headers.md`: the route is the PATTERN. A concrete `/flowLogA1`
    // there is a tenant's slug on a shared log stream, and the slug is one half of the
    // cache key.
    const redirects = requestLines(artefacts.output).filter(
      (line) => line.record.route === REDIRECT_ROUTE_PATTERN,
    );

    expect(redirects.map((line) => line.record.status).sort()).toEqual([302, 404]);

    for (const line of redirects) {
      expect(line.record.route, line.raw).toBe(REDIRECT_ROUTE_PATTERN);
      expect(String(line.record.route)).not.toContain(SLUG);
      expect(String(line.record.route)).not.toContain(MISS_SLUG);
      // The redirect runs with no tenant context (it is `@Public()`), so no line of it may
      // carry a tenant id read out of the row it resolved.
      expect(line.record, line.raw).not.toHaveProperty('tenant_id');
      expect(typeof line.record.request_id, line.raw).toBe('string');
      expect(typeof line.record.duration_ms, line.raw).toBe('number');
    }
  });

  it('no destination URL appears in any byte the process wrote, stored or edited, whole or by its path segment', () => {
    expect(artefacts.output).not.toContain(DESTINATION);
    expect(artefacts.output).not.toContain(EDITED_DESTINATION);
    // The distinctive halves on their own, in case a serialiser split or truncated one.
    expect(artefacts.output).not.toContain('wave5-destination-never-logged');
    expect(artefacts.output).not.toContain('wave5-edited-never-logged');
    expect(artefacts.output).not.toContain(encodeURIComponent(DESTINATION));
  });

  it('no concrete /:slug path, and no cache key, appears in any byte the process wrote', () => {
    // The path as it arrived, the slug on its own, and the two key shapes
    // `redirect-cache.md` fixes: `{hostname}:{slug}` is what D-2-15 refused to put on the
    // invalidation line, because the key embeds the slug.
    expect(artefacts.output).not.toContain(`/${SLUG}`);
    expect(artefacts.output).not.toContain(`/${MISS_SLUG}`);
    expect(artefacts.output).not.toContain(SLUG);
    expect(artefacts.output).not.toContain(MISS_SLUG);
    expect(artefacts.output).not.toContain(`${HOSTNAME}:${SLUG}`);
    expect(artefacts.output).not.toContain(`rdr:v1:${HOSTNAME}:${SLUG}`);
    expect(artefacts.output).not.toContain(`sk:${NAMESPACE}:rdr:v1:${HOSTNAME}:${SLUG}`);
  });

  it('neither the raw address nor the hash the database holds for it appears in any byte the process wrote', () => {
    // GC-R. The address arrived in a declared header and was hashed on the click path; the
    // hash is pseudonymous per deployment and is in `click_events` and nowhere else (D-2-19,
    // and `click-event.reader.ts` does not even SELECT the column).
    expect(artefacts.output).not.toContain(CLIENT_IP);
    expect(artefacts.output).not.toContain(encodeURIComponent(CLIENT_IP));
    expect(artefacts.output).not.toContain(artefacts.ipHash);
    // The header NAME is not on a line either: naming it is one edit away from logging its
    // value (`trusted-client-address.ts`).
    expect(artefacts.output).not.toContain(TRUSTED_HEADER);
  });

  it('no line carries a `url`, `ip_hash`, `slug`, `hostname` or `key` field, named or censored', () => {
    // The allowlist is what makes this true by default (ADR-0028): none of these names is
    // on it, so a line carrying one would render `[redacted]` rather than a value. Asserting
    // the ABSENCE of the key as well is the stronger statement AC-2-43 asks for: a field
    // nobody may add is different from a field whose value is censored.
    const forbidden = ['url', 'ip_hash', 'ip', 'slug', 'hostname', 'key', 'destination', 'destination_url'];

    for (const line of emittedLines(artefacts.output)) {
      for (const field of forbidden) {
        expect(Object.keys(line.record), line.raw).not.toContain(field);
        expect(LOGGABLE_FIELDS.has(field), field).toBe(false);
      }
    }
  });

  it('every line the process wrote is one JSON record, save the two non-pino writers already on record', () => {
    const notJson = emittedLines(artefacts.output)
      .filter((line) => Object.keys(line.record).length === 0)
      .map((line) => line.raw.replace(ANSI_ESCAPE, ''));

    const unexplained = notJson.filter(
      (line) => !NEST_BOOTSTRAP_LINE.test(line) && !BETTER_AUTH_PACKAGE_LOGGER_LINE.test(line),
    );

    expect(unexplained).toEqual([]);
  });

  it('no key on any line carries a value under a name the allowlist does not hold', () => {
    const lines = emittedLines(artefacts.output);

    expect(lines.length).toBeGreaterThan(0);

    const offending = lines.flatMap((line) =>
      keysNeitherNamedNorCensored(line.record).map((key) => `${key} on ${line.raw}`),
    );

    expect(offending).toEqual([]);
  });

  it('the forced invalidation failure writes ONE line shape, carrying code, link_id and attempts and nothing else (D-2-15)', () => {
    const failures = emittedLines(artefacts.output).filter(
      (line) => line.record.code === CACHE_INVALIDATION_FAILED_CODE,
    );

    // At least one: the create's negative-key deletion and the edit's both fail against a
    // cache that is not there, which is what makes this leg a measurement rather than a
    // simulation.
    expect(failures.length).toBeGreaterThanOrEqual(1);

    for (const line of failures) {
      expect(line.record.link_id, line.raw).toBe(artefacts.linkId);
      expect(typeof line.record.attempts, line.raw).toBe('number');
      // The key, the hostname and the slug are what `redirect-cache.md` said to log and
      // D-2-15 removed: the key embeds the slug, and an identifier reconstructible from an
      // id stays off the line.
      expect(Object.keys(line.record).sort(), line.raw).toEqual(
        ['attempts', 'code', 'env', 'level', 'link_id', 'msg', 'service', 'time'].sort(),
      );
    }
  });

  it('LOGGABLE_FIELDS grew by exactly `link_id` and `attempts`', () => {
    // AC-2-43's last clause, and the reason it is a clause at all: the allowlist is the one
    // mechanism between an unnamed field and a line, so item 2 adding to it is a diff a
    // reviewer sees rather than a name that appeared with a feature.
    const shipped = [...LOGGABLE_FIELDS].sort();

    expect(shipped.filter((field) => !LOGGABLE_FIELDS_BEFORE_ITEM_2.includes(field))).toEqual([
      'attempts',
      'link_id',
    ]);
    expect(shipped).toEqual([...LOGGABLE_FIELDS_BEFORE_ITEM_2, 'attempts', 'link_id'].sort());
    // ...and nothing 1b named was dropped along the way.
    for (const field of LOGGABLE_FIELDS_BEFORE_ITEM_2) {
      expect(LOGGABLE_FIELDS.has(field), field).toBe(true);
    }
  });
});
