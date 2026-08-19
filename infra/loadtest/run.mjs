/**
 * `pnpm loadtest --rate <n> --duration <s> [--warmup <s>] [--target <url>]`
 *
 * Contract: docs/contracts/loadtest-result.md, infra/loadtest/types.ts
 * ADR: adr-0018-ci-performance-gate.md, adr-0010-click-event-write-path.md,
 *      adr-0030-no-deploy-target.md
 * Produced by: TASK-2-11
 *
 * ============================================================================
 * WHAT THIS DOES, IN ORDER, AND WHY THE ORDER IS THE MEASUREMENT.
 * ============================================================================
 *
 *   1. `GET /health`, so a stack that is not up fails here rather than as a wall of 404s
 *      inside a percentile.
 *   2. Seeds ONE workspace and ONE link THROUGH THE API: sign in (signing up once if the
 *      account does not exist), mint a JWT, `POST /api/workspaces`, `POST /api/links`.
 *      Never through SQL: a row written by psql skips slug validation, the mutation event
 *      and the cache invalidation, so it measures a link the product cannot create.
 *   3. Warms the cache from the host, and asserts the 302 goes where the seed said. The
 *      first request through `GET /:slug` is a cache MISS by construction (ADR-0008), and a
 *      miss inside the measured window is a Postgres read inside a percentile that is
 *      supposed to describe the cache-hit path.
 *   4. Reads Redis `keyspace_hits` / `keyspace_misses`. This is the only evidence available
 *      that the run stayed on the cache-hit path: `dbQueryCounter` is process-global and
 *      exposed on no route, and a hit and a miss are the same 302 to a client.
 *   5. Runs k6 (`redirect.js`), which excludes its own 10 s warm-up structurally.
 *   6. Reads Redis again, assembles the `LoadTestResult`, writes it, prints the two numbers
 *      with the label that says which one may be gated on.
 *
 * ============================================================================
 * THIS SCRIPT NEVER DECIDES A VERDICT.
 * ============================================================================
 *
 * It measures and it writes. `gate.mjs` reads what it wrote and compares it to
 * `baseline.json`. Keeping the two apart is what stops "make the run pass" from being an
 * edit to the thing that runs the load.
 */
/* global process, console, fetch, URL, setTimeout */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { connect } from 'node:net';
import { cpus, hostname, release, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

const HERE = dirname(fileURLToPath(import.meta.url));
const K6_SCRIPT = join(HERE, 'redirect.js');
const DEFAULT_OUT_DIR = join(HERE, 'results');

/**
 * The account the harness drives. A FIXTURE, and it is fixed rather than random for one
 * reason: `AUTH_RATE_LIMIT_BUCKETS.signUpPerIp` is 3 per hour per address, so a harness that
 * signed up a fresh user per run would refuse its own fourth run of the hour with a 429 and
 * look like a broken stack. Signing in first and signing up only when that fails means one
 * signup ever, per stack.
 */
const HARNESS_EMAIL = 'loadtest-harness@shortkit.test';
const HARNESS_PASSWORD = 'quilted-harbour-19-lantern';
const HARNESS_NAME = 'Load Test Harness';

/** Never resolved: `redirects: 0` in the k6 script means nothing ever follows this. */
const DESTINATION = 'https://example.com/loadtest-destination';

/** `redis:7-alpine` from `docker-compose.yml`, fixture password included. */
const DEFAULT_REDIS_URL = 'redis://:redis-fixture@127.0.0.1:56379';
const DEFAULT_TARGET = 'http://localhost:3001';

/** How far short of the requested rate a run may land before it is not a measurement. */
const RATE_TOLERANCE = 0.95;

/**
 * The wait between seeding the link and warming the cache, and it is not padding.
 *
 * Creating a link invalidates its cache records TWICE: once immediately and once after
 * `INVALIDATION_SECOND_PASS_DELAY_MS` (1000 ms, `links/cache-invalidation.subscriber.ts`),
 * which sweeps a stale write-back left by a read that was in flight during the commit. A
 * harness that warms the cache inside that second window has its warm entry deleted from
 * under it, and the first request of the measured run is a Postgres read.
 *
 * MEASURED, not assumed: without this wait every run reported exactly one keyspace miss and a
 * cacheHitRatio of 0.9988, which `gate.mjs` correctly discards.
 */
const SEED_SETTLE_MS = 2 * 1000;

const options = readOptions();

await main();

async function main() {
  const target = options.target.replace(/\/+$/, '');

  await assertHealthy(target);

  const seeded = await seed(target);
  console.log(`seeded: workspace ${seeded.workspaceId}, link ${seeded.linkId}, slug ${seeded.slug}`);

  await sleep(SEED_SETTLE_MS);
  await warm(target, seeded);

  const before = await redisStats(options.redis);

  const summaryPath = join(options.outDir, `.k6-summary-${String(process.pid)}.json`);
  mkdirSync(options.outDir, { recursive: true });

  runK6({ target, slug: seeded.slug, summaryPath });

  const after = await redisStats(options.redis);
  const summary = JSON.parse(readFileSync(summaryPath, 'utf8'));
  rmSync(summaryPath, { force: true });

  const result = assemble({ target, summary, before, after });
  const path = join(options.outDir, `${result.measuredAt.replace(/:/g, '-')}.json`);

  writeFileSync(path, `${JSON.stringify(result, null, 2)}\n`);

  report(result, path);
}

/* ========================================================================== *
 * ARGUMENTS
 * ========================================================================== */

function readOptions() {
  let parsed;

  try {
    parsed = parseArgs({
      options: {
        rate: { type: 'string' },
        duration: { type: 'string' },
        warmup: { type: 'string', default: '10' },
        target: { type: 'string', default: process.env.LOADTEST_TARGET ?? DEFAULT_TARGET },
        redis: { type: 'string', default: process.env.REDIS_URL ?? DEFAULT_REDIS_URL },
        'out-dir': { type: 'string', default: DEFAULT_OUT_DIR },
        /**
         * `local-compose` by default because that is what a developer running this has in
         * front of them, and because ADR-0030 leaves `deployed` with no producer. The CI job
         * passes `ci-containers`.
         */
        environment: { type: 'string', default: 'local-compose' },
        /**
         * The tree the TARGET was built from, which is not necessarily the tree this script
         * is running out of: the compose stack builds an image, and an image outlives the
         * next edit. Both default to reading git here, which is right when the stack was
         * just built from this checkout and wrong silently otherwise, so both are passable.
         *
         * `--build-tree-digest none` records a CLEAN tree, which is what an image built from
         * `git archive <commit>` deserves and what reading this worktree would get wrong the
         * moment anything unrelated is edited in it.
         */
        'build-commit': { type: 'string' },
        'build-tree-digest': { type: 'string' },
      },
      allowPositionals: false,
    });
  } catch (error) {
    usage(error.message);
  }

  const rate = positiveInteger(parsed.values.rate, '--rate');
  const duration = positiveInteger(parsed.values.duration, '--duration');
  const warmup = positiveInteger(parsed.values.warmup, '--warmup');
  const environment = parsed.values.environment;

  if (!['ci-containers', 'local-compose', 'deployed'].includes(environment)) {
    usage(`--environment must be ci-containers, local-compose or deployed, not ${environment}`);
  }

  if (environment === 'deployed') {
    usage(
      'ADR-0030: no deploy target exists, so nothing can produce a `deployed` result. ' +
        'See docs/performance/redirect-baseline.md, "The half that is not built".',
    );
  }

  return {
    rate,
    duration,
    warmup,
    environment,
    target: parsed.values.target,
    redis: parsed.values.redis,
    outDir: resolve(parsed.values['out-dir']),
    buildCommit: parsed.values['build-commit'] ?? gitCommit(),
    buildTreeDigest: declaredDigest(parsed.values['build-tree-digest']),
  };
}

/** `none` is an explicit clean tree; anything else is taken verbatim; absent reads git. */
function declaredDigest(raw) {
  if (raw === undefined) {
    return gitWorkingTreeDigest();
  }

  return raw === 'none' || raw === '' ? null : raw;
}

function positiveInteger(raw, flag) {
  const value = Number(raw);

  if (!Number.isInteger(value) || value <= 0) {
    usage(`${flag} must be a positive integer, not ${String(raw)}`);
  }

  return value;
}

function usage(message) {
  console.error(`${message}\n`);
  console.error('usage: pnpm loadtest --rate <n> --duration <seconds> [--warmup <seconds>]');
  console.error('                     [--target <url>] [--redis <url>] [--out-dir <dir>]');
  console.error('                     [--environment ci-containers|local-compose]');
  console.error('');
  console.error('The stack must already be up: `docker compose up -d api` (README).');
  process.exit(2);
}

/* ========================================================================== *
 * SEEDING, THROUGH THE API
 * ========================================================================== */

async function assertHealthy(target) {
  const response = await fetch(`${target}/health`).catch((error) => {
    fail(
      `GET ${target}/health could not be reached (${error.message}). Start the stack with ` +
        '`docker compose up -d api`, or pass --target.',
    );
  });

  const body = await response.json().catch(() => ({}));

  if (response.status !== 200 || body.status !== 'ok') {
    fail(`GET ${target}/health answered ${String(response.status)} ${JSON.stringify(body)}`);
  }
}

async function seed(target) {
  const token = await authenticate(target);

  const workspace = await api(target, 'POST', '/api/workspaces', {
    token,
    body: { name: 'Load test' },
    expect: 201,
  });

  /**
   * A fresh slug per run rather than a fixed one. A fixed slug would answer 409 `slug_taken`
   * on the second run against the same stack, and the repair for that (reusing whatever row
   * is already there) measures a link this run did not create and cannot describe.
   */
  const slug = `lt${Math.random().toString(36).slice(2, 10)}`;

  const link = await api(target, 'POST', '/api/links', {
    token,
    body: { workspaceId: workspace.id, destinationUrl: DESTINATION, slug },
    expect: 201,
  });

  return { workspaceId: workspace.id, linkId: link.id, slug: link.slug };
}

/**
 * A JWT for the harness account. Signs in first and signs up only when that fails, so the
 * per-IP signup bucket is charged once per stack rather than once per run.
 */
async function authenticate(target) {
  let signedIn = await auth(target, '/sign-in/email', {
    email: HARNESS_EMAIL,
    password: HARNESS_PASSWORD,
  });

  if (signedIn.status !== 200) {
    const signedUp = await auth(target, '/sign-up/email', {
      email: HARNESS_EMAIL,
      password: HARNESS_PASSWORD,
      name: HARNESS_NAME,
    });

    if (signedUp.status !== 200) {
      fail(
        `POST /api/auth/sign-up/email answered ${String(signedUp.status)}: ${signedUp.raw}. ` +
          'A 429 here is the per-IP signup bucket (3 per hour); a fresh stack clears it.',
      );
    }

    signedIn = await auth(target, '/sign-in/email', {
      email: HARNESS_EMAIL,
      password: HARNESS_PASSWORD,
    });
  }

  if (signedIn.status !== 200 || signedIn.cookie === '') {
    fail(`POST /api/auth/sign-in/email answered ${String(signedIn.status)}: ${signedIn.raw}`);
  }

  const minted = await auth(target, '/token', undefined, signedIn.cookie);

  if (minted.status !== 200 || typeof minted.body.token !== 'string') {
    fail(`GET /api/auth/token answered ${String(minted.status)}: ${minted.raw}`);
  }

  return minted.body.token;
}

/**
 * One request to the auth surface, carrying an `Origin` header.
 *
 * `better-auth@1.6.26` answers a state-changing request without one with
 * `403 MISSING_OR_NULL_ORIGIN`. The server's own origin is what a browser would send to it
 * and is in Better Auth's trusted list by way of `BETTER_AUTH_URL`, so this needs no entry
 * in `WEB_APP_ORIGINS` and no configuration change anywhere to run.
 */
async function auth(target, path, body, cookie) {
  const response = await fetch(`${target}/api/auth${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      origin: target,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(cookie === undefined ? {} : { cookie }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  const raw = await response.text();

  let parsed = {};
  try {
    parsed = JSON.parse(raw);
  } catch {
    /* left as {}; the caller reports `raw` */
  }

  return {
    status: response.status,
    body: parsed,
    raw,
    cookie: response.headers
      .getSetCookie()
      .map((header) => header.split(';')[0])
      .filter((pair) => !pair.endsWith('='))
      .join('; '),
  };
}

async function api(target, method, path, { token, body, expect }) {
  const response = await fetch(`${target}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  const raw = await response.text();

  if (response.status !== expect) {
    fail(`${method} ${path} answered ${String(response.status)}, not ${String(expect)}: ${raw}`);
  }

  return JSON.parse(raw);
}

/* ========================================================================== *
 * WARM-UP AND THE CACHE-HIT EVIDENCE
 * ========================================================================== */

/**
 * Drives the redirect from the host until it is certain the cache holds both records the
 * path reads (the host resolve and the link), and asserts the `Location` is the destination
 * the seed wrote. A run that measured a 404 at 25 000 requests would otherwise report an
 * excellent p99 for a page that redirects nobody.
 */
async function warm(target, seeded) {
  const url = `${target}/${seeded.slug}`;

  for (let attempt = 1; attempt <= 20; attempt += 1) {
    const response = await fetch(url, { redirect: 'manual' });
    await response.arrayBuffer();

    if (response.status === 302 && response.headers.get('location') === DESTINATION) {
      if (attempt >= 5) {
        return;
      }

      continue;
    }

    if (attempt === 20) {
      fail(
        `GET ${url} answered ${String(response.status)} to ${String(response.headers.get('location'))}, ` +
          `not 302 to ${DESTINATION}. The seeded link is not being served; nothing measurable ` +
          'follows from driving it.',
      );
    }

    await sleep(200);
  }
}

/**
 * `keyspace_hits` and `keyspace_misses` out of `INFO stats`, over a raw socket.
 *
 * A dependency-free RESP client rather than `ioredis`: this file is the only thing in the
 * repository that runs outside a workspace package, and adding a Node dependency to the root
 * manifest to read two integers would put a package on the merge gate's audit surface for
 * the sake of a load test.
 *
 * SERVER-WIDE COUNTERS. Everything they see during a run is the redirect cache, because the
 * only traffic this harness generates is `GET /:slug`, redirect traffic is never rate limited
 * (ADR-0012, AC-86) and the revocation store is not on Redis (D-2-01). A Redis instance shared
 * with anything else invalidates the ratio, which is why the compose stack publishes its own
 * on 56379 and the CI job runs its own service container.
 */
async function redisStats(url) {
  const parsed = new URL(url);
  const password = parsed.password === '' ? null : decodeURIComponent(parsed.password);
  const port = parsed.port === '' ? 6379 : Number(parsed.port);

  const text = await new Promise((resolvePromise, rejectPromise) => {
    const socket = connect({ host: parsed.hostname, port }, () => {
      if (password !== null) {
        socket.write(`AUTH ${password}\r\n`);
      }

      socket.write('INFO stats\r\n');
    });

    let buffer = '';

    socket.setEncoding('utf8');
    socket.setTimeout(5000);
    socket.on('data', (chunk) => {
      buffer += chunk;

      if (buffer.includes('keyspace_misses:')) {
        socket.end();
        resolvePromise(buffer);
      }
    });
    socket.on('timeout', () => {
      socket.destroy();
      rejectPromise(new Error(`timed out reading INFO stats from ${parsed.hostname}:${String(port)}`));
    });
    socket.on('error', rejectPromise);
    socket.on('close', () => resolvePromise(buffer));
  });

  if (text.startsWith('-') || text.includes('NOAUTH') || text.includes('WRONGPASS')) {
    fail(`Redis refused the INFO read at ${url}: ${text.split('\r\n')[0]}`);
  }

  return {
    hits: infoValue(text, 'keyspace_hits'),
    misses: infoValue(text, 'keyspace_misses'),
  };
}

function infoValue(text, key) {
  const match = new RegExp(`^${key}:(\\d+)`, 'm').exec(text);

  if (match === null) {
    fail(
      `Redis INFO stats carried no ${key}. Pass --redis with the DSN of the cache the target ` +
        'is using; without it a run cannot show it stayed on the cache-hit path.',
    );
  }

  return Number(match[1]);
}

/* ========================================================================== *
 * THE RUN
 * ========================================================================== */

function runK6({ target, slug, summaryPath }) {
  const binary = process.env.K6_BIN ?? 'k6';

  const run = spawnSync(binary, ['run', K6_SCRIPT], {
    stdio: 'inherit',
    env: {
      ...process.env,
      LOADTEST_TARGET: target,
      LOADTEST_SLUG: slug,
      LOADTEST_RATE: String(options.rate),
      LOADTEST_DURATION_S: String(options.duration),
      LOADTEST_WARMUP_S: String(options.warmup),
      LOADTEST_SUMMARY_OUT: summaryPath,
    },
  });

  if (run.error !== undefined && run.error.code === 'ENOENT') {
    fail(
      `k6 was not found (tried \`${binary}\`). Install the version the CI job pins: see ` +
        "`.github/workflows/ci.yml`, job `performance`, or set K6_BIN to its path. k6 is not " +
        'an npm dependency: it is a Go binary, deliberately, so the generator does not compete ' +
        'with the API for the event loop (ADR-0018).',
    );
  }

  if (run.status !== 0) {
    fail(`k6 exited ${String(run.status)}. The run produced no result file.`);
  }
}

function assemble({ target, summary, before, after }) {
  if (summary.server === null || summary.client === null) {
    fail(
      'k6 recorded no samples. Every response either failed or carried no `Server-Timing: ' +
        'app;dur=` header, so there is nothing to aggregate (ADR-0018 layer 0).',
    );
  }

  const hits = after.hits - before.hits;
  const misses = after.misses - before.misses;
  const lookups = hits + misses;

  return {
    measuredAt: new Date().toISOString(),
    target,
    rate: options.rate,
    achievedRate: round(summary.requests / options.duration),
    durationS: options.duration,
    warmupS: options.warmup,
    requests: summary.requests,
    errors: summary.errors,
    serverP50: round(summary.server['p(50)']),
    serverP95: round(summary.server['p(95)']),
    serverP99: round(summary.server['p(99)']),
    clientP50: round(summary.client['p(50)']),
    clientP95: round(summary.client['p(95)']),
    clientP99: round(summary.client['p(99)']),
    cacheHitRatio: lookups === 0 ? 0 : round(hits / lookups, 6),
    emissionMode: 'deferred-batch',
    environment: options.environment,
    droppedIterations: summary.droppedIterations,
    machine: describeMachine(),
    build: { commit: options.buildCommit, workingTreeDigest: options.buildTreeDigest },
  };
}

function report(result, path) {
  const shortfall = result.achievedRate < result.rate * RATE_TOLERANCE;

  console.log('');
  console.log(`server p50/p95/p99 ms  ${fmt(result.serverP50)} / ${fmt(result.serverP95)} / ${fmt(result.serverP99)}   <- the gated number (SC-2, server-side)`);
  console.log(`client p50/p95/p99 ms  ${fmt(result.clientP50)} / ${fmt(result.clientP95)} / ${fmt(result.clientP99)}   <- reported, never gated`);
  console.log(`requests ${String(result.requests)}  errors ${String(result.errors)}  achieved ${fmt(result.achievedRate)}/s of ${String(result.rate)}/s  cache hit ratio ${String(result.cacheHitRatio)}`);
  console.log(`machine  ${result.machine}`);
  console.log(`written  ${path}`);

  if (shortfall) {
    console.log('');
    console.log(
      `::warning::the achieved rate is more than ${String(Math.round((1 - RATE_TOLERANCE) * 100))}% below the requested rate. ` +
        'gate.mjs discards this run rather than reading its percentiles.',
    );
  }

  if (result.cacheHitRatio < 1) {
    console.log('');
    console.log(
      '::warning::the cache hit ratio is below 1.0, so this run did not measure the cache-hit ' +
        'path (loadtest-result.md invariant 2). gate.mjs discards it.',
    );
  }
}

/* ========================================================================== *
 * PROVENANCE
 * ========================================================================== */

/**
 * The machine, in one line. Not decoration: a latency figure with no machine attached is not
 * a baseline, and `ciP99BudgetMs` is tied to a specific runner class whose replacement
 * invalidates it silently (ADR-0018).
 */
function describeMachine() {
  const model = cpus()[0]?.model.replace(/\s+/g, ' ').trim() ?? 'unknown CPU';
  const gib = Math.round(totalmem() / 1024 ** 3);

  return `${hostname()}, ${model}, ${String(cpus().length)} logical CPUs, ${String(gib)} GiB RAM, linux ${release()}`;
}

function gitCommit() {
  const run = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' });

  return run.status === 0 ? run.stdout.trim() : 'unknown';
}

/** `null` for a clean tree; a digest of the diff otherwise. */
function gitWorkingTreeDigest() {
  const status = spawnSync('git', ['status', '--porcelain'], { encoding: 'utf8' });
  const diff = spawnSync('git', ['diff'], { encoding: 'utf8' });

  if (status.status !== 0 || diff.status !== 0) {
    return null;
  }

  if (status.stdout.trim() === '') {
    return null;
  }

  return createHash('sha256').update(status.stdout).update(diff.stdout).digest('hex').slice(0, 16);
}

/* ========================================================================== *
 * SMALL THINGS
 * ========================================================================== */

function round(value, digits = 3) {
  const factor = 10 ** digits;

  return Math.round(value * factor) / factor;
}

function fmt(value) {
  return value.toFixed(3);
}

function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

function fail(message) {
  console.error(`::error::${message}`);
  process.exit(1);
}
