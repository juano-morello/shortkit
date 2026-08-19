import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * AC-6, the in-process half — TASK-003.
 *
 * AC-6 reads: "Given the API deployed to Fly.io, when `GET /health` is requested over
 * HTTPS, then it returns 200 with a JSON body containing a `status` field equal to
 * `"ok"` and a `commit` field matching the deployed git SHA."
 *
 * `design/test-strategy.md` § "Deliberately not automated" splits it (ruled 2026-08-06).
 * What is asserted here is the half with a real red step: the app boots, `GET /health`
 * answers 200, the body carries `status: "ok"`, and `commit` is the value the build-time
 * SHA source supplied rather than an empty string, a hardcoded constant or a placeholder.
 * "Deployed to Fly.io" and "over HTTPS" are exempt and verified by `sdlc-product-auditor`
 * against the deployed URL — a test against a live host reports red for Fly being down,
 * for DNS, for deployment protection, and cannot go red at all before a deploy exists.
 *
 * **Why a real HTTP round trip.** The assertions go over loopback against an application
 * built from `AppModule`, the way `common/errors/exception-filter.spec.ts` does, rather
 * than calling a controller method directly. AC-6 is about the response the platform
 * health probe receives; calling a handler would pass even with the controller never
 * registered in the composition root, which is the failure mode F-217 describes — the
 * `/health` prefix exclusion at `main.ts:47-49` already exists while nothing answers the
 * route, so it 404s today.
 *
 * **Why the commit assertion supplies its own SHA.** Asserting that `commit` is merely a
 * non-empty string passes against `commit: 'unknown'`, which is the defect worth catching:
 * a health endpoint reporting a stale or empty commit makes a deployed build
 * unidentifiable, and nothing else in the pipeline notices. So the test puts a known SHA
 * into the build-time source and asserts the response carries that exact value. A
 * hardcoded constant, a placeholder, an empty string, a truncated form, a read of the
 * wrong variable, and a runtime `git rev-parse` (there is no `.git` in the deployed image)
 * all fail it.
 *
 * **The source name is pinned here because no artifact named it.** Searched 2026-08-07:
 * no ADR, contract, TASK, `.env.example` or workflow in this repository named the variable
 * carrying the build's git SHA — TASK-003 owns `Dockerfile` and `fly.toml`, where it is
 * introduced. (`apps/api/.env.example` and the root `.env.example` name `GIT_COMMIT_SHA`
 * since TASK-009, matching what this test decided.) This test therefore decides it, and records the decision rather than
 * assuming it: the Dockerfile takes the SHA as a build argument and exposes it to the
 * running process as `GIT_COMMIT_SHA`. If TASK-003's implementer picks a different name,
 * `COMMIT_SHA_ENV` below is the single edit; the assertion does not weaken.
 */

/**
 * The environment variable the deployed image carries its build's git SHA in. See the
 * docblock above: this is TASK-003's to confirm or rename, not an established convention.
 */
const COMMIT_SHA_ENV = 'GIT_COMMIT_SHA';

/**
 * A full 40-character SHA, hand-written and deliberately not this repository's HEAD.
 * Nothing in the application can compute it, so the only way the response carries it is
 * by reading the source the build wrote it to.
 */
const BUILD_COMMIT_SHA = '3d1f7a0c94b25e68af31c07d5b8e4a2196fd0c7b';

let app: INestApplication;
let baseUrl: string;

beforeAll(async () => {
  // Set before the module graph is loaded, so this holds whether the implementation reads
  // the variable once at import time — legitimate, since a build-time value never changes
  // in a running process — or on every request. `AppModule` is therefore imported
  // dynamically: a static import is hoisted above this assignment.
  vi.stubEnv(COMMIT_SHA_ENV, BUILD_COMMIT_SHA);

  const { AppModule } = await import('../app.module');

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();

  // `logger: false` keeps the suite output clean. Nothing here asserts on logs.
  app = moduleRef.createNestApplication({ logger: false });
  await app.listen(0, '127.0.0.1');
  baseUrl = await app.getUrl();
});

afterAll(async () => {
  await app?.close();
  vi.unstubAllEnvs();
});

interface HealthProbe {
  readonly status: number;
  readonly body: unknown;
  readonly raw: string;
}

/**
 * Reads the body as text first, so a non-JSON response fails an assertion below rather
 * than throwing out of `response.json()` and reporting a parse error instead of the
 * status the route answered with.
 */
async function probeHealth(): Promise<HealthProbe> {
  const response = await fetch(`${baseUrl}/health`);
  const raw = await response.text();

  let body: unknown = raw;
  try {
    body = JSON.parse(raw) as unknown;
  } catch {
    /* left as the raw text */
  }

  return { status: response.status, body, raw };
}

/** Shared precondition: the response body is a JSON object at all. */
function expectJsonBody(probed: HealthProbe): Record<string, unknown> {
  expect(
    typeof probed.body === 'object' && probed.body !== null && !Array.isArray(probed.body),
    `not a JSON object: ${probed.raw}`,
  ).toBe(true);

  return probed.body as Record<string, unknown>;
}

describe('GET /health', () => {
  it('AC-6: answers 200 from an application built on the composition root', async () => {
    const probed = await probeHealth();

    expect(probed.status, `body was ${probed.raw}`).toBe(200);
  });

  it('AC-6: answers a JSON body whose status field is "ok"', async () => {
    const probed = await probeHealth();
    const body = expectJsonBody(probed);

    expect(body.status).toBe('ok');
  });

  it('AC-6: reports the commit the build-time SHA source supplied, not a placeholder', async () => {
    const probed = await probeHealth();
    const body = expectJsonBody(probed);

    expect(body.commit).toBe(BUILD_COMMIT_SHA);
  });
});
