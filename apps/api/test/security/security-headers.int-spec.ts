import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { startApiServer } from '../support/api-server';
import type { ApiServer } from '../support/api-server';

/**
 * F-243 clause 2 — `docs/contracts/logging-and-headers.md` § "Security headers" and
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
 * ===========================================================================
 * THE SECOND DSN THE SPAWNED CHILD NEEDS, FROM WAVE 1 (F-084, ADR-0050).
 * ===========================================================================
 *
 * This file spawns an API child with its OWN `env` callback rather than through
 * `authServerEnv()`, so nothing else supplies this name to it. `startApiServer` spreads
 * `process.env` into the child, so an exported value reaches it — but a value that is
 * unset in this shell reaches it as unset, and the guard below is what says so in a
 * sentence rather than as a boot failure four frames down.
 *
 * `shortkit_auth` is the only role holding privileges on Better Auth's five tables after
 * migration `0001` revokes `shortkit_app` on all five. NO FALLBACK TO `DATABASE_URL`: a
 * fallback here would spawn a child reading those tables as exactly the role the split
 * exists to keep off them (`auth-fixture.ts:96-103`, same rule, same reason).
 */
const DATABASE_AUTH_URL = 'DATABASE_AUTH_URL';

/**
 * ===========================================================================
 * THE TWO AUTH BINDINGS THE CHILD NEEDS FROM WAVE 2 (F-200, ADR-0051, ADR-0059).
 * ===========================================================================
 *
 * `main.ts` refuses to boot without either, BEFORE the database precondition — measured:
 * eight tests in this file went from passing to failing on
 * `boot_precondition: "better_auth_secret"` the moment TASK-003 landed. That is the guard
 * working. This file spawns its own child with its own `env` callback rather than through
 * `authServerEnv()`, so nothing else was going to supply them.
 *
 * The callback stays EXPLICIT and there is deliberately no `process.env` spread: the
 * comment below has said since wave 1 that it "says what the child needs instead of
 * inheriting it by accident", and that design is exactly why this broke loudly at a named
 * boot precondition rather than quietly on an unset value. It also means `ci.yml` needs
 * neither binding — the callback never reads the ambient environment for them.
 *
 * Neither value is a credential in this context and neither is read by anything this file
 * asserts on. The child is spawned, probed for response headers, and killed.
 */

/**
 * Fifty-three characters, the same shape and the same intent as
 * `test/support/auth-fixture.ts:86` — a throwaway string for a throwaway process, clearing
 * ADR-0051's 32-character floor and deliberately not better-auth's published
 * `better-auth-secret-12345678901234567890`, which is the one value ADR-0058 rejects by
 * exact match. Matched to the fixture's style rather than invented as a third convention.
 */
const BETTER_AUTH_SECRET = 'security-headers-fixture-better-auth-secret-not-real';

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
 * F-280 — the framing policy a browser actually enforces.
 *
 * `X-Frame-Options: DENY` above is the row the implementer had to override helmet's default
 * for, and it is the row a CSP-aware browser DISCARDS: CSP Level 2 § 4 requires a user agent
 * that supports `frame-ancestors` to ignore `X-Frame-Options` entirely, and helmet's default
 * CSP carries `frame-ancestors 'self'`. So the contract's table states `DENY` and the deployed
 * bytes deliver `'self'` — same-origin framing, on the origin whose branded 404 is slated to
 * render tenant-controlled markup (F-006).
 *
 * `'none'` is the value that makes the two headers agree, hand-derived from the contract's own
 * `DENY` rather than read off helmet. This is the one CSP directive asserted by value; the rest
 * of the policy stays "helmet default" and is not pinned, for the reason the CSP test below
 * gives.
 */
const FRAME_ANCESTORS = "'none'";

/**
 * One directive's value out of a `Content-Security-Policy` header, or `undefined` when the
 * directive is absent. Absent and present-but-wrong are different defects and the assertion
 * has to be able to tell them apart.
 */
function cspDirective(csp: string | null, name: string): string | undefined {
  const found = (csp ?? '')
    .split(';')
    .map((part) => part.trim())
    .find((part) => part === name || part.startsWith(`${name} `));

  return found?.slice(name.length).trim();
}

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
  const unset = [DATABASE_URL, DATABASE_AUTH_URL].filter(
    (variable) => (process.env[variable] ?? '') === '',
  );

  // ALL THREE DSNs, NOT TWO (F-084). The message named DATABASE_URL and
  // DATABASE_MIGRATION_URL while the child this file spawns also needs
  // DATABASE_AUTH_URL from wave 1, and a remedy that is short by one variable is a
  // remedy someone follows and still gets a red run.
  if (unset.length > 0) {
    throw new Error(
      `${unset.join(' and ')} not set, and \`main.ts\` refuses to boot without a ` +
        'reachable database (F-116, F-245). Run `docker compose -f ' +
        'docker-compose.test.yml up -d --wait`, export ' +
        "DATABASE_URL='postgres://shortkit_app:app@127.0.0.1:55433/shortkit_test', " +
        "DATABASE_MIGRATION_URL='postgres://shortkit_migrator:migrator@127.0.0.1:55433/" +
        "shortkit_test' and DATABASE_AUTH_URL='postgres://shortkit_auth:auth@127.0.0.1:" +
        "55433/shortkit_test', then `pnpm --filter @shortkit/api db:migrate`.",
    );
  }

  // Kicked off without awaiting, and awaited again in `beforeEach`. `api-server.ts`'s own
  // docblock explains why: a rejection awaited only in `beforeAll` makes Vitest 3.2.7 report
  // every test in the file SKIPPED beside a summary that still says "N passed".
  //
  // Both DSNs are passed EXPLICITLY rather than left to the `process.env` spread, so this
  // callback says what the child needs instead of inheriting it by accident.
  //
  // `BETTER_AUTH_URL` IS THE `baseUrl` THE HARNESS ALREADY HANDS THIS CALLBACK, and that is
  // a deliberate choice over a literal (F-200). The loopback rule is a STRING test, so a
  // hardcoded `http://127.0.0.1:3001` would satisfy it just as well while telling a future
  // reader that the value is arbitrary — and it is not: this same binding decides `iss`,
  // `aud` and the session cookie's `Secure` flag for the two auth suites, which is why
  // `authServerEnv(baseUrl)` passes the real origin. A child that claims an origin it does
  // not answer on is a fixture nobody should copy. The port is chosen by `startApiServer`
  // and is on loopback, so the rule admits it.
  serverBoot = startApiServer({
    env: (baseUrl) => ({
      GIT_COMMIT_SHA: BUILD_COMMIT_SHA,
      [DATABASE_URL]: process.env[DATABASE_URL] ?? '',
      [DATABASE_AUTH_URL]: process.env[DATABASE_AUTH_URL] ?? '',
      BETTER_AUTH_SECRET,
      BETTER_AUTH_URL: baseUrl,
    }),
  });
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

  it('F-280: the CSP denies framing too, so the browser and `X-Frame-Options` agree', () => {
    // THE ROW THE IMPLEMENTER DELIBERATELY OVERRODE IS THE ROW THE BROWSER THROWS AWAY.
    // `frameguard: { action: 'deny' }` puts `X-Frame-Options: DENY` on the wire and the test
    // above proves it — and helmet's default CSP, which `main.ts` leaves alone, carries
    // `frame-ancestors 'self'` on the same response. CSP Level 2 requires a user agent that
    // supports `frame-ancestors` to ignore `X-Frame-Options`, which is every browser, so the
    // effective policy is same-origin framing and the contract's table says `DENY`.
    //
    // MEASURED 2026-08-10 against `node dist/main.js` on loopback: `GET /health` and the
    // branded 404 both carry `X-Frame-Options: DENY` AND
    // `…;frame-ancestors 'self';…`. Nothing in the suite could see the disagreement,
    // because every existing assertion reads the header the browser discards.
    //
    // ASSERTED ON THE DIRECTIVE'S VALUE, not on the whole policy string: helmet's other
    // defaults are a decision and pinning them would fire on an upgrade. This one is not a
    // default the contract accepted — the contract accepted `DENY`.
    for (const probe of probes) {
      expect(cspDirective(probe.header('content-security-policy'), 'frame-ancestors'), probe.path).toBe(
        FRAME_ANCESTORS,
      );
    }
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
