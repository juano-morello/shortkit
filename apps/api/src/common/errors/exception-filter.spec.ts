import { Controller, Get, NotFoundException } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  ERROR_CODE_STATUS,
  errorEnvelopeContract,
  validationDetailsContract,
} from '@shortkit/contracts';
import type { ErrorEnvelope } from '@shortkit/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../../app.module';

/**
 * AC-13 — every rejected API request answers with the shared error envelope and a
 * stable machine-readable `code`.
 *
 * Contract: design/contracts/error-envelope.md. The invariants exercised here are
 * numbered 1 (every non-2xx body under /api validates against errorEnvelopeContract),
 * 2 (the code is stable and its status is fixed by ERROR_CODE_STATUS), 4 (`details`
 * appears only where the contract names a shape) and 8 (no secret reaches the body),
 * plus the two rules under "What the implementer must guarantee": the filter is
 * registered as APP_FILTER in AppModule so it catches non-HttpException throwables,
 * and a ZodError becomes 400 validation_failed carrying the flattened field errors.
 *
 * The assertions go through a real HTTP round trip on loopback rather than by calling
 * a filter class directly. AC-13 is about the response a client receives, and calling
 * `catch()` on a filter instance would assert the filter's arguments instead — which
 * would still pass if the filter were never registered.
 */

/** Stands in for the class of value invariant 8 forbids in a body: a credential. */
const LEAKED_SECRET = 'postgres://shortkit:hunter2@db.internal:5432';

/**
 * A real ZodError, built by failing a contract that already exists. `apps/api` has no
 * `zod` dependency, so the error cannot be constructed here directly; parsing a known
 * bad envelope produces the same object a ZodValidationPipe would throw.
 *
 * `code` is valid and `message` is empty, so exactly one field fails.
 */
function zodErrorFixture(): unknown {
  const result = errorEnvelopeContract.safeParse({ code: 'not_found', message: '' });

  if (result.success) {
    throw new Error('fixture is stale: errorEnvelopeContract accepted an empty message');
  }

  return result.error;
}

@Controller('api/error-probe')
class ErrorProbeController {
  /** Anything the filter has no mapping for. */
  @Get('unmapped')
  unmapped(): never {
    throw new Error(`connection to ${LEAKED_SECRET} refused`);
  }

  /** A framework exception, which guards and the router both throw. */
  @Get('http-exception')
  httpException(): never {
    throw new NotFoundException();
  }

  /** What a validation pipe throws on a malformed request body. */
  @Get('zod')
  zod(): never {
    throw zodErrorFixture();
  }
}

let app: INestApplication;
let baseUrl: string;

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
    controllers: [ErrorProbeController],
  }).compile();

  // `logger: false` keeps the suite output clean. Nothing here asserts on logs.
  app = moduleRef.createNestApplication({ logger: false });
  await app.listen(0, '127.0.0.1');
  baseUrl = await app.getUrl();
});

afterAll(async () => {
  await app?.close();
});

interface Probe {
  readonly status: number;
  readonly body: unknown;
  readonly raw: string;
}

/**
 * Reads the body as text first, so a non-JSON response fails an assertion below
 * instead of throwing out of `response.json()`.
 */
async function probe(route: string): Promise<Probe> {
  const response = await fetch(`${baseUrl}/api/error-probe/${route}`);
  const raw = await response.text();

  let body: unknown = raw;
  try {
    body = JSON.parse(raw) as unknown;
  } catch {
    /* left as the raw text */
  }

  return { status: response.status, body, raw };
}

/** Shared precondition: the response body is an envelope at all. */
function expectEnvelope(probed: Probe): ErrorEnvelope {
  const parsed = errorEnvelopeContract.safeParse(probed.body);

  expect(parsed.success, `not an error envelope: ${probed.raw}`).toBe(true);
  if (!parsed.success) {
    throw new Error('unreachable');
  }

  return parsed.data;
}

describe('the API exception filter', () => {
  it('AC-13: answers a rejected request with a body that validates against errorEnvelopeContract', async () => {
    const probed = await probe('http-exception');

    expect(errorEnvelopeContract.safeParse(probed.body).success, `body was ${probed.raw}`).toBe(
      true,
    );
  });

  it('AC-13: returns a code whose normative status is the status it answered with', async () => {
    const probed = await probe('http-exception');
    const envelope = expectEnvelope(probed);

    expect(ERROR_CODE_STATUS[envelope.code]).toBe(probed.status);
  });

  it('AC-13: answers 500 internal_error for a throwable it has no mapping for', async () => {
    const probed = await probe('unmapped');

    expect(probed.status).toBe(500);
    expect(expectEnvelope(probed).code).toBe('internal_error');
  });

  it('AC-13: keeps an unmapped throwable out of the response body', async () => {
    const probed = await probe('unmapped');
    expectEnvelope(probed);

    expect(probed.raw).not.toContain(LEAKED_SECRET);
  });

  it('AC-13: attaches no details to an internal_error envelope', async () => {
    const probed = await probe('unmapped');
    const envelope = expectEnvelope(probed);

    expect(envelope.details).toBeUndefined();
  });

  it('AC-13: answers 400 validation_failed for a ZodError', async () => {
    const probed = await probe('zod');

    expect(probed.status).toBe(400);
    expect(expectEnvelope(probed).code).toBe('validation_failed');
  });

  it('AC-13: carries validation details that validate against validationDetailsContract', async () => {
    const probed = await probe('zod');
    const envelope = expectEnvelope(probed);

    expect(validationDetailsContract.safeParse(envelope.details).success).toBe(true);
  });

  it('AC-13: reports field errors only for the field that failed validation', async () => {
    const probed = await probe('zod');
    const envelope = expectEnvelope(probed);
    const details = validationDetailsContract.parse(envelope.details);

    expect(Object.keys(details.fieldErrors)).toEqual(['message']);
  });
});
