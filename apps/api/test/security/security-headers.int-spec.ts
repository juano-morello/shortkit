import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { startApiServer } from '../support/api-server';
import type { ApiServer } from '../support/api-server';

/**
 * F-243 clause 2 — `design/contracts/logging-and-headers.md` § "Security headers" and
 * **invariant 4**. ADR-0022. Assigned to TASK-003 by Juano on 2026-08-10.
 *
 * Invariant 4 reads: "HSTS, `nosniff` and `DENY` are present on every API response including
 * errors." The contract then disclaims it in place — "**Not true today.** `helmet` is not
 * registered. F-243 clause 2 is open and escalated: this contract assigned helmet and HSTS to
 * TASK-003 with no AC, no test and no finding tracking them."
 *
 * MEASURED 2026-08-10 against a real boot of the built bundle, which is what this file
 * automates: `GET /health` answers 200 and `GET /api/<unrouted>` answers the branded 404, and
 * NEITHER carries `Strict-Transport-Security`, `X-Content-Type-Options`, `X-Frame-Options`,
 * `Referrer-Policy` or `Content-Security-Policy`. `grep -rn helmet apps/api` returns nothing
 * in `src`, in `package.json` or in the lockfile.
 *
 * ============================================================================
 * WHY THIS BOOTS THE COMPOSITION ROOT INSTEAD OF COMPILING `AppModule`
 * ============================================================================
 *
 * The contract puts helmet in `main.ts`: "`helmet()` with defaults, plus HSTS, registered in
 * `main.ts` before the global prefix." `Test.createTestingModule({ imports: [AppModule] })`
 * never runs `main.ts`, so an in-graph test would answer with no security headers however
 * correct the implementation is — it could not go green for the right reason, which is worse
 * than one that cannot go red. `src/health/health.spec.ts` is in-graph because AC-6 is about a
 * ROUTE; this is about middleware the composition root installs, so it uses
 * `test/support/api-server.ts`, which builds the bundle and runs it on a real socket.
 *
 * That is also why this is an `.int-spec.ts`: `main.ts` refuses to start without a reachable
 * database and a safe runtime role (F-116, F-245), so it needs `docker-compose.test.yml` up.
 *
 * ============================================================================
 * WHAT IS ASSERTED, AND WHAT IS DELIBERATELY NOT
 * ============================================================================
 *
 * The four headers whose values the contract's table states normatively are asserted for
 * those exact values. `Content-Security-Policy`'s value is "helmet default", so only its
 * presence and its having a `default-src` directive are asserted — pinning helmet's own
 * default bytes would fire on a helmet upgrade, which is a decision rather than a defect.
 *
 * The redirect path's two documented exceptions (`Referrer-Policy: unsafe-url` on the 302,
 * the tighter CSP on the branded 404) belong to `redirect-resolution.md` and there is no
 * redirect route yet. They are not this TASK's and are not asserted here.
 *
 * `X-Powered-By: Express` is on every response today and helmet's defaults remove it. The
 * contract's table does not name it, so it is reported rather than asserted.
 */

/**
 * ADR-0027's variable, supplied here for the same reason `src/health/health.spec.ts` supplies
 * it: `main.ts` refuses to boot without a full 40-character SHA and nothing in this file's
 * subject depends on which one.
 */
const BUILD_COMMIT_SHA = '3d1f7a0c94b25e68af31c07d5b8e4a2196fd0c7b';

/**
 * The DSN `main.ts`'s second boot precondition connects with. Read from the environment
 * rather than hardcoded, because `docker-compose.test.yml` is the only thing that decides it
 * and the rest of the integration suite reads the same variable.
 */
const DATABASE_URL = 'DATABASE_URL';

/**
 * The header table, hand-copied from `logging-and-headers.md` § "Security headers". Values
 * are read off the CONTRACT, not off helmet's documentation: helmet's `frameguard` default is
 * `SAMEORIGIN`, and the contract says `DENY`, so an implementer who registers bare `helmet()`
 * fails that row and has to configure it.
 */
const HSTS = 'max-age=31536000; includeSubDomains';
const NOSNIFF = 'nosniff';
const FRAME_OPTIONS = 'DENY';
const REFERRER_POLICY = 'no-referrer';

/**
 * The two responses invariant 4 says "every API response including errors". `/health` is
 * excluded from the global prefix and answers 200; the unrouted `/api` path goes through
 * `ApiExceptionFilter` and answers the branded 404, which is the "including errors" half.
 */
const UNROUTED_API_PATH = '/api/no-such-route-exists-here';

interface Probe {
  readonly path: string;
  readonly status: number;
  readonly header: (name: string) => string | null;
}

let serverBoot: Promise<ApiServer>;
let server: ApiServer;
let probes: readonly Probe[];

beforeAll(() => {
  if ((process.env[DATABASE_URL] ?? '') === '') {
    throw new Error(
      `${DATABASE_URL} is not set, and \`main.ts\` refuses to boot without a reachable ` +
        'database (F-116, F-245). Run `docker compose -f docker-compose.test.yml up -d ' +
        "--wait`, export DATABASE_URL='postgres://shortkit_app:app@127.0.0.1:55433/" +
        "shortkit_test' and DATABASE_MIGRATION_URL='postgres://shortkit_migrator:migrator" +
        "@127.0.0.1:55433/shortkit_test', then `pnpm --filter @shortkit/api db:migrate`.",
    );
  }

  // Kicked off without awaiting, and awaited again in `beforeEach`. `api-server.ts`'s own
  // docblock explains why: a rejection awaited only in `beforeAll` makes Vitest 3.2.7 report
  // every test in the file SKIPPED beside a summary that still says "N passed".
  serverBoot = startApiServer({ env: () => ({ GIT_COMMIT_SHA: BUILD_COMMIT_SHA }) });
  serverBoot.catch(() => undefined);
});

beforeEach(async () => {
  server = await serverBoot;

  if (probes !== undefined) {
    return;
  }

  probes = await Promise.all(
    ['/health', UNROUTED_API_PATH].map(async (path): Promise<Probe> => {
      const response = await fetch(`${server.baseUrl}${path}`);

      // Drained so the socket closes and `stop()` is not waiting on a live connection.
      await response.text();

      return {
        path,
        status: response.status,
        header: (name) => response.headers.get(name),
      };
    }),
  );
}, 120_000);

afterAll(async () => {
  await server?.stop();
});

describe('the security headers every API response carries', () => {
  it('F-243: both probed responses really were served, so the header assertions are not vacuous', () => {
    // The precondition the rest of the file rests on. A boot that half-ran, a prefix that
    // moved, or a `/health` that 404s would leave every "the header is present" assertion
    // failing for a reason that has nothing to do with helmet — and, worse, would let a
    // future "the header is absent" assertion pass against a process that answered nothing.
    expect(probes.map((probe) => [probe.path, probe.status])).toEqual([
      ['/health', 200],
      [UNROUTED_API_PATH, 404],
    ]);
  });

  it('F-243: invariant 4 — HSTS is on every API response including errors, with no `preload`', () => {
    // `logging-and-headers.md` § "Security headers": `max-age=31536000; includeSubDomains`,
    // scope "every response". Asserted as an EQUALITY rather than as a presence check,
    // because that is what excludes `preload` — which the contract refuses in its own
    // sentence: "submission is close to irreversible and the apex domain is unregistered".
    // A `preload` added later is a decision nobody can take back for months, and the equality
    // is what makes it show up as a failing test rather than as a shipped header.
    for (const probe of probes) {
      expect(probe.header('strict-transport-security'), probe.path).toBe(HSTS);
    }
  });

  it('F-243: invariant 4 — `X-Content-Type-Options: nosniff` is on every API response including errors', () => {
    // The error response is the half that goes wrong quietly: middleware registered after the
    // global prefix, or inside a module rather than on the app, covers the routed 200 and
    // misses the filter's own response. That is why both probes are asserted rather than one.
    for (const probe of probes) {
      expect(probe.header('x-content-type-options'), probe.path).toBe(NOSNIFF);
    }
  });

  it("F-243: invariant 4 — `X-Frame-Options: DENY`, which is not helmet's default", () => {
    // MEASURED AGAINST THE CONTRACT, NOT AGAINST HELMET. helmet's `frameguard` default is
    // `SAMEORIGIN`; the contract's table says `DENY`. So a bare `app.use(helmet())` passes
    // every other row here and fails this one, which is the point: this is the row that
    // proves the implementer read the table rather than the README.
    for (const probe of probes) {
      expect(probe.header('x-frame-options'), probe.path).toBe(FRAME_OPTIONS);
    }
  });

  it('F-243: `Referrer-Policy: no-referrer` is on every API response', () => {
    // The contract's scope for this row is "every response except the redirect 302", and the
    // redirect route does not exist yet — `redirect-resolution.md` owns the `unsafe-url`
    // exception when it does. Both probes here are API responses, so both take the default.
    for (const probe of probes) {
      expect(probe.header('referrer-policy'), probe.path).toBe(REFERRER_POLICY);
    }
  });

  it('F-243: a Content-Security-Policy is set on API responses', () => {
    // Presence and a `default-src` directive, not helmet's exact default bytes. The contract's
    // value for this row is literally "helmet default", so pinning the string would fire on a
    // helmet upgrade — a decision — while telling us nothing about whether a policy is in
    // force. What a defect looks like here is the header missing or empty, and that is what
    // this catches.
    const csp = probes[1].header('content-security-policy');

    expect(csp).toBeTypeOf('string');
    expect(csp ?? '').toContain('default-src');
  });

  it('invariant 3: no API response carries `Access-Control-Allow-Origin`, for any origin', () => {
    // `logging-and-headers.md` § CORS: "Disabled. `app.enableCors()` is never called", and
    // "What the implementer must guarantee" asks for exactly this test. Nothing asserted it
    // until now, so `app.enableCors()` could be added to `main.ts` for a local frontend
    // problem with every gate green — and ADR-0014's whole reason for routing the browser
    // through the BFF is that the API is never reached cross-origin.
    //
    // GREEN BY DESIGN: CORS has never been enabled. Proved by mutation in the round's report
    // rather than assumed, because a test that has never been able to fail is not a guard.
    for (const probe of probes) {
      expect(probe.header('access-control-allow-origin'), probe.path).toBeNull();
    }
  });
});
