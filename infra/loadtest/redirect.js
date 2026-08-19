/**
 * The k6 script. NOT RUN DIRECTLY: `infra/loadtest/run.mjs` seeds the workspace and the link,
 * warms the cache, reads Redis, spawns this, and assembles the result file. `pnpm loadtest`
 * is the entry point.
 *
 * Contract: docs/contracts/loadtest-result.md, infra/loadtest/types.ts
 * ADR: adr-0018-ci-performance-gate.md (layer 0: the aggregated number is the server's own),
 *      adr-0008 / adr-0009 (the cache-hit path this drives)
 * Produced by: TASK-2-11
 *
 * ============================================================================
 * WHY k6 AND NOT A NODE GENERATOR (ADR-0018, AND IT IS NOT A PREFERENCE).
 * ============================================================================
 *
 * The generator and the API share this machine's CPUs. A Node generator loses that fight and
 * then reports its own event-loop delay as the application's latency. k6 is a Go binary with
 * its own scheduler, so the load it claims to apply is the load it applies, and the number it
 * aggregates comes off the server's own clock regardless.
 *
 * ============================================================================
 * TWO SCENARIOS, AND THAT IS THE WARM-UP EXCLUSION.
 * ============================================================================
 *
 * `warmup` and `measured` run the same request through two exec functions; only `measured`
 * records anything. The exclusion is therefore structural rather than a filter applied
 * afterwards: there is no path by which a warm-up request reaches a percentile. `measured`
 * starts at `startTime`, so the two never overlap in the requests they START; `gracefulStop`
 * lets an in-flight warm-up iteration finish without letting a new one begin.
 *
 * The cache is ALREADY WARM when this starts: `run.mjs` warms it and reads Redis's
 * hit/miss counters before spawning k6, so `warmup` here is about the runtime's JIT, the
 * connection pool and the buffer, not about the first cache miss.
 */
/* global __ENV, console */
import { Counter, Trend } from 'k6/metrics';
import http from 'k6/http';

const TARGET = required('LOADTEST_TARGET');
const SLUG = required('LOADTEST_SLUG');
const RATE = Number(required('LOADTEST_RATE'));
const DURATION_S = Number(required('LOADTEST_DURATION_S'));
const WARMUP_S = Number(required('LOADTEST_WARMUP_S'));
const SUMMARY_OUT = required('LOADTEST_SUMMARY_OUT');

const TARGET_URL = `${TARGET}/${SLUG}`;

/** The server's own measurement, off `Server-Timing: app;dur=<ms>`. The gated number. */
const serverDuration = new Trend('server_duration_ms');
/** What this process saw on the wire. Reported, never gated. */
const clientDuration = new Trend('client_duration_ms');
const measuredRequests = new Counter('measured_requests');
/** Neither 2xx nor 302, or a response carrying no `Server-Timing` to aggregate. */
const measuredErrors = new Counter('measured_errors');

/**
 * VUs are iteration slots, not concurrency the target sees: at ~1 ms per request one VU
 * covers roughly 1000 RPS, and k6 DROPS iterations rather than queueing them when it runs
 * out. Over-allocating costs a few MB of goroutine stacks and buys the run its stated rate;
 * under-allocating produces a fast p99 for a load that was never applied, which is the
 * failure this harness has to be unable to report. `run.mjs` refuses a result whose
 * achieved rate fell short, so a wrong number here fails loudly.
 */
const PRE_ALLOCATED_VUS = Math.max(20, Math.ceil(RATE / 4));
const MAX_VUS = Math.max(100, RATE);

export const options = {
  /** Only the headers are read, and a 302 has no body worth allocating. */
  discardResponseBodies: true,
  /** p(50) and p(99) are not in k6's default set, and both are contract fields. */
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(50)', 'p(95)', 'p(99)', 'count'],
  scenarios: {
    warmup: {
      executor: 'constant-arrival-rate',
      exec: 'warmup',
      rate: RATE,
      timeUnit: '1s',
      duration: `${WARMUP_S}s`,
      preAllocatedVUs: PRE_ALLOCATED_VUS,
      maxVUs: MAX_VUS,
      /** Lets an in-flight iteration finish. It starts no new one, so it adds no load. */
      gracefulStop: '2s',
    },
    measured: {
      executor: 'constant-arrival-rate',
      exec: 'measured',
      startTime: `${WARMUP_S}s`,
      rate: RATE,
      timeUnit: '1s',
      duration: `${DURATION_S}s`,
      preAllocatedVUs: PRE_ALLOCATED_VUS,
      maxVUs: MAX_VUS,
      gracefulStop: '5s',
    },
  },
};

/** The warm-up scenario. Drives the same request and records NOTHING. */
export function warmup() {
  hit();
}

export function measured() {
  const response = hit();

  measuredRequests.add(1);
  clientDuration.add(response.timings.duration);

  const serverMs = appDurationMs(response);

  if (serverMs === null || !isRedirect(response.status)) {
    measuredErrors.add(1);

    return;
  }

  serverDuration.add(serverMs);
}

function hit() {
  /**
   * `redirects: 0`. Following the 302 would send this generator to the destination host,
   * measure the internet, and put a third party's availability inside a merge gate.
   */
  return http.get(TARGET_URL, { redirects: 0, tags: { name: 'redirect' } });
}

function isRedirect(status) {
  return status === 302 || (status >= 200 && status < 300);
}

/**
 * The `app;dur=<ms>` value, or `null` when the header is absent or unparseable.
 *
 * A missing header is an ERROR rather than a skipped sample. Silently skipping is how a
 * change that stops emitting `Server-Timing` produces an empty trend, an undefined p99 and a
 * gate that reports nothing wrong.
 */
function appDurationMs(response) {
  const header = response.headers['Server-Timing'] ?? response.headers['server-timing'];

  if (typeof header !== 'string') {
    return null;
  }

  const match = /(?:^|,)\s*app;dur=([0-9.]+)/.exec(header);

  if (match === null) {
    return null;
  }

  const value = Number(match[1]);

  return Number.isFinite(value) ? value : null;
}

function required(name) {
  const value = __ENV[name];

  if (value === undefined || value === '') {
    throw new Error(`${name} is not set. Run this through \`pnpm loadtest\`, not directly.`);
  }

  return value;
}

/**
 * k6 writes what this returns. `run.mjs` reads the file and assembles the contract's
 * `LoadTestResult` from it: this script deliberately does not write the result file itself,
 * because two of that file's fields (the cache hit ratio and the machine) come from outside
 * k6 and a half-filled result file is worse than none.
 */
export function handleSummary(data) {
  const trend = (name) => {
    const metric = data.metrics[name];

    return metric === undefined ? null : metric.values;
  };

  const counter = (name) => {
    const metric = data.metrics[name];

    return metric === undefined ? 0 : metric.values.count;
  };

  const summary = {
    server: trend('server_duration_ms'),
    client: trend('client_duration_ms'),
    requests: counter('measured_requests'),
    errors: counter('measured_errors'),
    droppedIterations: counter('dropped_iterations'),
  };

  console.log(
    `measured ${String(summary.requests)} request(s), ${String(summary.errors)} error(s), ` +
      `${String(summary.droppedIterations)} dropped iteration(s)`,
  );

  return { [SUMMARY_OUT]: JSON.stringify(summary, null, 2) };
}
