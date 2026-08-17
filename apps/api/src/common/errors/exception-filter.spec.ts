import {
  BadRequestException,
  Controller,
  Get,
  HttpException,
  NotFoundException,
} from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  ERROR_CODE_STATUS,
  errorEnvelopeContract,
  validationDetailsContract,
} from '@shortkit/contracts';
import type { ErrorEnvelope } from '@shortkit/contracts';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { AppModule } from '../../app.module';
import { DomainError } from './domain-error';
import type * as domainErrorModule from './domain-error';

/**
 * AC-13 — every rejected API request answers with the shared error envelope and a
 * stable machine-readable `code`.
 *
 * Contract: docs/contracts/error-envelope.md. The invariants exercised here are
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
 *
 * ADR-0024 added branch 1 of the four: a thrown `DomainError` answers with its own code
 * and the status `ERROR_CODE_STATUS` gives that code. The tests for it are below the
 * three that were here first (unmapped throwable, framework exception, `ZodError`).
 * `domain-error.spec.ts` holds the assertions on the constructed error itself; what is
 * here is only what a client observes, which is the part that proves the filter reads
 * `isDomainError` rather than deciding for itself.
 */

/** Stands in for the class of value invariant 8 forbids in a body: a credential. */
const LEAKED_SECRET = 'postgres://shortkit:hunter2@db.internal:5432';

/**
 * Another tenant's id, which invariant 8 forbids in any body but the owner's. It stands
 * in for the conflicting row a throw site would attach to `details` to help a client —
 * the mistake ADR-0026 makes impossible at the filter rather than at fourteen throw
 * sites.
 */
const OTHER_TENANT_ID = '33333333-3333-4333-8333-333333333333';

/** Safe to show a stranger, which is what constructing a `DomainError` promises. */
const SLUG_TAKEN_MESSAGE = 'The short code launch is already in use.';
const RATE_LIMITED_MESSAGE = 'Too many requests. Try again in 30 seconds.';
const VALIDATION_MESSAGE = 'That short code cannot be used.';

/** Delta-seconds, as invariant 7 requires of every 429. */
const RETRY_AFTER = '30';

/**
 * What Nest actually puts on a `BadRequestException` for a malformed JSON body: Node's
 * own `JSON.parse` message, which quotes the bytes it choked on. This is the exact shape
 * reproduced under F-094 for a body of
 * `{"password":"hunter2","token":"eyJhbGciOi","x":}` on Node 24.19.
 */
const MALFORMED_BODY_MESSAGE = `Unexpected token '}', ..."ciOi","x":}" is not valid JSON`;

/** The fragment of the caller's own bearer token the message above carries. */
const REFLECTED_TOKEN_FRAGMENT = 'ciOi';

/**
 * What the body says instead, per `error-envelope.md`'s message constants
 * (F-094, F-098, ADR-0026). Hand-read off the contract rather than imported: the filter
 * does not export it, and a test that read the value from the code under test would
 * accept any value the code chose.
 */
const FRAMEWORK_BAD_REQUEST_FORM_MESSAGE = 'The request could not be parsed.';

/**
 * A framework status no code maps to. `error-envelope.md` names 413 specifically: a body
 * over Express's default limit has no row in `ERROR_CODES`, so it answers 500 until one
 * is appended.
 */
const UNMAPPED_FRAMEWORK_STATUS = 413;

/**
 * Route, code and status, with the status hand-read off `error-envelope.md`'s table
 * rather than looked up in `ERROR_CODE_STATUS`. Two codes with two different statuses,
 * neither of which the framework produces on its own, so a filter answering a constant
 * status — or the status of whichever code it saw last — fails one of the rows.
 */
const DOMAIN_ERROR_CASES = [
  { route: 'domain-error', code: 'slug_taken', status: 409 },
  { route: 'domain-error-headers', code: 'rate_limited', status: 429 },
] as const;

/**
 * The second module graph, loaded in `beforeAll` and thrown from by the probe route
 * below. See `loadSecondCopyOfDomainError`.
 */
let secondGraph: typeof domainErrorModule | undefined;

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

  /**
   * Branch 3's 400 arm. A malformed JSON body reaches the filter as a
   * `BadRequestException` carrying the parser's own text.
   */
  @Get('http-exception-bad-request')
  httpExceptionBadRequest(): never {
    throw new BadRequestException(MALFORMED_BODY_MESSAGE);
  }

  /**
   * Branch 3's fallback arm: a framework status no code maps to. The message stands in
   * for the class of text invariant 8 forbids in a body.
   */
  @Get('http-exception-unmapped-status')
  httpExceptionUnmappedStatus(): never {
    throw new HttpException(
      `upstream ${LEAKED_SECRET} rejected the body`,
      UNMAPPED_FRAMEWORK_STATUS,
    );
  }

  /** What a validation pipe throws on a malformed request body. */
  @Get('zod')
  zod(): never {
    throw zodErrorFixture();
  }

  /**
   * ADR-0024: the only way application code asks for a status other than 500. The
   * `cause` is what a real throw site would attach — it belongs in the log and nowhere
   * near the body.
   */
  @Get('domain-error')
  domainError(): never {
    throw new DomainError('slug_taken', SLUG_TAKEN_MESSAGE, {
      cause: new Error(`connection to ${LEAKED_SECRET} refused`),
    });
  }

  /** What TASK-051's rate-limit guard throws: a code and a `Retry-After` header. */
  @Get('domain-error-headers')
  domainErrorWithHeaders(): never {
    throw new DomainError('rate_limited', RATE_LIMITED_MESSAGE, {
      headers: { 'Retry-After': RETRY_AFTER },
    });
  }

  /** A code the contract names a `details` shape for, carried by the error itself. */
  @Get('domain-error-details')
  domainErrorWithDetails(): never {
    throw new DomainError('validation_failed', VALIDATION_MESSAGE, {
      details: { fieldErrors: { slug: ['is reserved'] } },
    });
  }

  /**
   * ADR-0026: `details` on a code the contract names no shape for. A 409 is where a
   * throw site is most tempted to attach the row it conflicted with.
   */
  @Get('domain-error-details-unnamed')
  domainErrorWithUnnamedDetails(): never {
    throw new DomainError('slug_taken', SLUG_TAKEN_MESSAGE, {
      details: { conflictingRow: { tenantId: OTHER_TENANT_ID, slug: 'launch' } },
    });
  }

  /**
   * ADR-0026: a valid `ValidationDetails` with a second key attached beside it. The
   * narrowing uses the parse output, and `z.object` strips what it did not declare.
   */
  @Get('domain-error-details-sibling')
  domainErrorWithSiblingDetails(): never {
    throw new DomainError('validation_failed', VALIDATION_MESSAGE, {
      details: {
        fieldErrors: { slug: ['is reserved'] },
        conflictingRow: { tenantId: OTHER_TENANT_ID },
      },
    });
  }

  /** A `DomainError` from a second evaluation of `domain-error.ts` in this process. */
  @Get('domain-error-second-graph')
  domainErrorFromSecondGraph(): never {
    if (secondGraph === undefined) {
      throw new Error('fixture is missing: the second copy of domain-error.ts never loaded');
    }

    throw new secondGraph.DomainError('slug_taken', SLUG_TAKEN_MESSAGE);
  }
}

/**
 * A second evaluation of `domain-error.ts`: a distinct class object that
 * `instanceof DomainError` rejects, carrying the same `Symbol.for` marker. TASK-056's
 * isolation suite and the integration config load these same sources under a second
 * vitest project, which is the duplication ADR-0024 chose a registered symbol for.
 *
 * Called after the app is listening, so every module Nest resolves lazily is already
 * in the registry when the reset happens and only `domain-error.ts` and its imports
 * are re-evaluated.
 *
 * The guards are the honesty check: if the runner ever hands back the cached module,
 * this stops being a second graph and the test below would pass against an
 * `instanceof` filter. It fails loudly instead of quietly proving nothing.
 */
async function loadSecondCopyOfDomainError(): Promise<typeof domainErrorModule> {
  vi.resetModules();
  const loaded = await import('./domain-error');

  if (loaded.DomainError === DomainError) {
    throw new Error(
      'fixture is stale: the dynamic import returned the same class object, so this is not a second module graph',
    );
  }

  if (new loaded.DomainError('not_found', 'x') instanceof DomainError) {
    throw new Error(
      'fixture is stale: an error from the second copy still satisfies instanceof, so this test no longer distinguishes the two implementations',
    );
  }

  return loaded;
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

  secondGraph = await loadSecondCopyOfDomainError();
});

afterAll(async () => {
  await app?.close();
});

interface Probe {
  readonly status: number;
  readonly body: unknown;
  readonly raw: string;
  readonly headers: Headers;
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

  return { status: response.status, body, raw, headers: response.headers };
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

  it('AC-13: answers 400 validation_failed for a framework exception carrying a 400', async () => {
    const probed = await probe('http-exception-bad-request');

    expect(probed.status).toBe(400);
    expect(expectEnvelope(probed).code).toBe('validation_failed');
  });

  /**
   * Amended for F-101. This asserted the pass-through of the exception's own message
   * until F-094 removed it from the contract in the same fix round: Nest builds that
   * message from the raw request bytes, so forwarding it reflects a fragment of the
   * caller's body — a token among them — into an error body (ADR-0026).
   */
  it("AC-13: replaces a framework 400's own message with the fixed one under _form", async () => {
    const probed = await probe('http-exception-bad-request');
    const envelope = expectEnvelope(probed);
    const details = validationDetailsContract.parse(envelope.details);

    expect(details.fieldErrors).toEqual({ _form: [FRAMEWORK_BAD_REQUEST_FORM_MESSAGE] });
  });

  it('AC-13: keeps the request bytes a framework 400 quotes out of the response body', async () => {
    const probed = await probe('http-exception-bad-request');
    expectEnvelope(probed);

    expect(probed.raw).not.toContain(REFLECTED_TOKEN_FRAGMENT);
  });

  it('AC-13: answers 500 internal_error for a framework exception with an unmapped status', async () => {
    const probed = await probe('http-exception-unmapped-status');

    expect(probed.status).toBe(500);
    expect(expectEnvelope(probed).code).toBe('internal_error');
  });

  it("AC-13: keeps an unmapped framework exception's message out of the response body", async () => {
    const probed = await probe('http-exception-unmapped-status');
    expectEnvelope(probed);

    expect(probed.raw).not.toContain(LEAKED_SECRET);
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

  it.each(DOMAIN_ERROR_CASES)(
    'AC-13: answers a thrown DomainError with the code it carries, $code',
    async ({ route, code }) => {
      const probed = await probe(route);

      expect(expectEnvelope(probed).code).toBe(code);
    },
  );

  it.each(DOMAIN_ERROR_CASES)(
    'AC-13: answers a thrown DomainError carrying $code with status $status, the row the contract gives that code',
    async ({ route, status }) => {
      const probed = await probe(route);

      expect(probed.status).toBe(status);
    },
  );

  it("AC-13: passes a DomainError's own message to the body", async () => {
    const probed = await probe('domain-error');

    expect(expectEnvelope(probed).message).toBe(SLUG_TAKEN_MESSAGE);
  });

  it("AC-13: keeps a DomainError's cause out of the response body", async () => {
    const probed = await probe('domain-error');
    expectEnvelope(probed);

    expect(probed.raw).not.toContain(LEAKED_SECRET);
  });

  it("AC-13: writes a DomainError's headers to the response", async () => {
    const probed = await probe('domain-error-headers');

    expect(probed.headers.get('retry-after')).toBe(RETRY_AFTER);
  });

  it("AC-13: forwards a DomainError's details to the body", async () => {
    const probed = await probe('domain-error-details');
    const envelope = expectEnvelope(probed);

    expect(envelope.details).toEqual({ fieldErrors: { slug: ['is reserved'] } });
  });

  /**
   * ADR-0026, added 2026-08-05. The filter narrows every body it writes: `details`
   * survives only under `validation_failed` and only as the output of parsing it against
   * `validationDetailsContract`. ADR-0026 records that a test asserting the body is the
   * only thing that catches a drop — nothing else does, because `errorEnvelopeContract`
   * types `details` as `unknown`.
   */
  it('AC-13: drops details from an envelope whose code names no details shape', async () => {
    const probed = await probe('domain-error-details-unnamed');

    expect(expectEnvelope(probed).details).toBeUndefined();
  });

  it('AC-13: strips a key attached beside fieldErrors on a validation_failed envelope', async () => {
    const probed = await probe('domain-error-details-sibling');

    expect(expectEnvelope(probed).details).toEqual({ fieldErrors: { slug: ['is reserved'] } });
  });

  it('AC-13: answers a DomainError thrown from a second module graph with its own code', async () => {
    const probed = await probe('domain-error-second-graph');

    expect(expectEnvelope(probed).code).toBe('slug_taken');
  });

  it('AC-13: answers a DomainError thrown from a second module graph with its own status', async () => {
    const probed = await probe('domain-error-second-graph');

    expect(probed.status).toBe(409);
  });
});
