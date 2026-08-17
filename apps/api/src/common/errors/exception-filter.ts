/**
 * Contract: docs/contracts/error-envelope.md
 * ADR: adr-0024-domain-error-transport.md, adr-0025-zod-error-recognition-in-contracts.md
 * Produced by: TASK-007
 * Consumed by: every API TASK. Nothing may opt out.
 *
 * ============================================================================
 * THE ONE PLACE A THROWN ERROR BECOMES A RESPONSE BODY.
 * ============================================================================
 *
 * Registered as APP_FILTER in AppModule, so it catches every throwable — including the
 * ones that are not HttpExceptions — and every non-2xx body under /api validates
 * against errorEnvelopeContract (error-envelope.md invariant 1).
 *
 * FOUR BRANCHES, IN THIS ORDER, and no fifth:
 *   1. isDomainError  -> err.status, err.toEnvelope(), err.headers written first
 *   2. isZodError     -> 400 validation_failed with the flattened field errors
 *   3. HttpException  -> 404 not_found, 400 validation_failed, everything else 500
 *   4. anything else  -> 500 internal_error with INTERNAL_ERROR_MESSAGE, no details
 *
 * BRANCH 4 PUTS NOTHING OF THE ORIGINAL ERROR IN THE BODY. A Postgres error naming a
 * connection string, a Redis timeout naming an internal host and an assertion quoting a
 * row all land there. What reaches the LOG is decided by TASK-003's stack-versus-message
 * policy, written out in `observability/logger.ts`: the error's name and its stack FRAMES
 * go on the line, its message does not, and every line carries `request_id`. That closes
 * `error-envelope.md` invariant 9 — debugging a 500 means finding its `request_id` in the
 * logs — which was false for every 500 this filter answered before now.
 *
 * THE FILTER DOES NOT WALK `cause`. A DomainError re-thrown inside a plain Error is a
 * 500 (ADR-0024).
 *
 * NO STATUS IS PICKED HERE. Every one comes from ERROR_CODE_STATUS, through
 * `errorResponse()` or through `DomainError.status`, which is a getter over the same
 * table.
 *
 * EVERY BODY GOES THROUGH `narrowEnvelope` (ADR-0026), so the only values that reach a
 * client are strings written in this file and shapes validated against a schema in
 * `packages/contracts`. No message an HttpException carried reaches a body.
 */
import { randomUUID } from 'node:crypto';

import { Catch, HttpException } from '@nestjs/common';
import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common';
import {
  ERROR_CODE_STATUS,
  FORM_ERROR_KEY,
  isZodError,
  toValidationDetails,
} from '@shortkit/contracts';
import type { ErrorEnvelope } from '@shortkit/contracts';
import type { Logger } from 'pino';

import { errorLogFields, logger } from '../../observability/logger';
import { INTERNAL_ERROR_MESSAGE, isDomainError } from './domain-error';
import { errorResponse, narrowEnvelope } from './error-envelope';
import type { ErrorResponse } from './error-envelope';

/**
 * `apps/api` declares no `express` dependency and none of its types resolve here, so the
 * response is named by the four members this filter uses. `getResponse<T>()` is a cast,
 * so nothing is lost by narrowing it.
 */
interface HttpResponseLike {
  readonly headersSent: boolean;
  setHeader(name: string, value: string): void;
  status(code: number): HttpResponseLike;
  json(body: unknown): void;
  end(): void;
}

/** Same reasoning as `HttpResponseLike`: only what this filter reads. */
interface HttpRequestLike {
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
}

/** `logging-and-headers.md`: the `x-request-id` header, or a generated uuid. */
const REQUEST_ID_HEADER = 'x-request-id';

/**
 * A caller-supplied `x-request-id` is untrusted input on its way into a log aggregator.
 * pino JSON-encodes it, so a newline cannot split the record, but nothing bounds its
 * length — 128 characters is longer than any correlation id anyone issues and short enough
 * that a megabyte header cannot be replayed into the log on every request.
 */
const MAX_REQUEST_ID_LENGTH = 128;

/**
 * The envelope message for both validation branches. A client renders per code and
 * never branches on a message (error-envelope.md invariant 3); the failing fields are
 * in `details`, which is the part a form reads.
 */
const VALIDATION_FAILED_MESSAGE = 'The request could not be validated.';

/**
 * Fixed rather than the framework's own text, which for an unmatched route is the
 * request method and path echoed back.
 */
const NOT_FOUND_MESSAGE = 'The requested resource was not found.';

/**
 * What a framework 400 says under `_form`, in place of the exception's own message
 * (F-094, ADR-0026). Nest maps a body-parser `SyntaxError` to
 * `new BadRequestException(err.message)` and Node's `JSON.parse` message quotes the
 * bytes it choked on, so forwarding it reflects 15 to 30 raw bytes of an unauthenticated
 * request body — a fragment of a bearer token among them — into a JSON body, against
 * invariant 8. The same arm receives express's `URIError`, whose message quotes the raw
 * path segment, which is why this text says "request" rather than "body". The original
 * goes to the log.
 */
const FRAMEWORK_BAD_REQUEST_FORM_MESSAGE = 'The request could not be parsed.';

/** What is written to the response, once a branch has decided it. */
interface FilterOutcome extends ErrorResponse {
  readonly headers?: Readonly<Record<string, string>>;
}

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const response = http.getResponse<HttpResponseLike>();

    // Bound to a local, never to `this`: the filter is a singleton and per-request state
    // on the instance would attribute one request's id to another's failure.
    const log = logger.child({ request_id: requestId(http.getRequest<HttpRequestLike>()) });

    // The redirect surface streams a 302 outside /api. Writing a body over a started
    // response corrupts it, so the failure goes to the log and the response is ended.
    if (response.headersSent) {
      logError(log, 'after the response started', exception);
      response.end();
      return;
    }

    try {
      this.write(log, response, exception);
    } catch (failure: unknown) {
      // F-092. This filter is the one component that answers for every throwable, and
      // resolving or writing can itself throw: `details` carrying a BigInt or a circular
      // reference makes `res.json` throw, and a header value Node rejects makes
      // `setHeader` throw ERR_INVALID_CHAR. Without this, the throw escapes into Nest's
      // error layer or finalhandler and the client gets a 500 with the wrong code — or,
      // outside production, HTML carrying a stack.
      logError(log, 'while writing the error response', failure);

      // A header may already have gone out, in which case there is nothing left to
      // write but the end of the response.
      if (response.headersSent) {
        response.end();
        return;
      }

      const { status, body } = errorResponse('internal_error', INTERNAL_ERROR_MESSAGE);
      response.status(status).json(body);
    }
  }

  /** Classify, write the headers, write the body. Everything that may throw. */
  private write(log: Logger, response: HttpResponseLike, exception: unknown): void {
    const outcome = this.resolve(log, exception);

    // Before the body: this is how a 429 carries `Retry-After` (invariant 7) without
    // the throwing guard reaching for the response object.
    for (const [name, value] of Object.entries(outcome.headers ?? {})) {
      response.setHeader(name, value);
    }

    response.status(outcome.status).json(this.narrow(log, outcome.body));
  }

  /**
   * ADR-0026, applied once to the body the filter is about to write, so branch 1's
   * `toEnvelope()` output passes through it along with branches 2 to 4.
   */
  private narrow(log: Logger, body: ErrorEnvelope): ErrorEnvelope {
    const narrowed = narrowEnvelope(body);

    if (body.details !== undefined && narrowed.details === undefined) {
      // The code and nothing else. The dropped value is the one suspected of carrying
      // another tenant's data, and a log is not a safe place for it (GC-9).
      log.warn({ code: body.code }, 'dropped details from an envelope: no shape is named for it');
    }

    return narrowed;
  }

  private resolve(log: Logger, exception: unknown): FilterOutcome {
    // 1. The only way application code asks for a status other than 500.
    if (isDomainError(exception)) {
      const status = exception.status;

      // Unreachable by type, reachable through a cast: a code with no row in
      // ERROR_CODE_STATUS. Never answer with `undefined` as a status.
      if (!Number.isInteger(status)) {
        log.error({ code: exception.code }, 'domain error code has no status');
        return errorResponse('internal_error', INTERNAL_ERROR_MESSAGE);
      }

      return { status, body: exception.toEnvelope(), headers: exception.headers };
    }

    // 2. What a schema parse throws. Recognised and flattened by the package that
    // declares the schema (ADR-0025); zod is not imported here, value or type.
    if (isZodError(exception)) {
      return errorResponse(
        'validation_failed',
        VALIDATION_FAILED_MESSAGE,
        toValidationDetails(exception),
      );
    }

    // 3. What the framework raises on its own. Application code throws a DomainError.
    if (exception instanceof HttpException) {
      return this.resolveHttpException(log, exception);
    }

    // 4. Everything else, and the body says nothing about it.
    logError(log, 'unhandled', exception);
    return errorResponse('internal_error', INTERNAL_ERROR_MESSAGE);
  }

  private resolveHttpException(log: Logger, exception: HttpException): FilterOutcome {
    const status = exception.getStatus();

    if (status === ERROR_CODE_STATUS.not_found) {
      return errorResponse('not_found', NOT_FOUND_MESSAGE);
    }

    if (status === ERROR_CODE_STATUS.validation_failed) {
      // F-108, and the reason this arm now logs through the shared helper like every
      // other. The exception's own message never reaches the BODY (F-094, ADR-0026)
      // because the framework builds it out of the raw request bytes — and it does not
      // reach the LOG either, for the same reason and a stronger one: an unauthenticated
      // POST carrying a credential puts a fragment of it in Nest's
      // `BadRequestException(err.message)`, and `REDACT_PATHS` is a path list that cannot
      // reach inside a string. Hard-truncating it was considered and rejected: a cap does
      // not remove a credential sitting at the start of the quoted slice. What is left is
      // the exception's name, its frames and the `request_id`, which is what the operator
      // can act on anyway. See `observability/logger.ts` for the full policy.
      //
      // MEASURED, END TO END, IN `observability/framework-400-request-body.spec.ts`, and
      // it corrects what six findings assumed. body-parser DOES attach the verbatim body to
      // the error it raises (`read.js:163`), but `RoutesResolver.mapExternalException`
      // (`routes-resolver.js:94-101`) replaces every `SyntaxError` with
      // `new BadRequestException(err.message)` before any filter runs — so `err.body` is
      // gone before this line, and what actually arrives is the MESSAGE, into which V8
      // quotes the first ten characters of the body: `Unexpected token 'S', "SEKRIT-KEY"...`.
      //
      // THERE IS A SECOND COPY OF THAT FRAGMENT AND NOTHING HERE MAY REACH FOR IT (F-273).
      // `exception.getResponse()` returns `{ message, error, statusCode }` carrying the same
      // quoted bytes one level down, under a key nothing special-cases. This filter never
      // calls it — not for the body (branch 3 builds its own envelope, ADR-0026) and not for
      // the log (`logError` passes the exception to `errorLogFields`, which reads `name`,
      // `message` and `stack` and returns). A later edit that logs or forwards
      // `getResponse()` reinstates F-108 through a route the `includeMessage` policy does
      // not stand in front of, because the value is no longer the exception's `message`.
      logError(log, 'framework exception with a 400 status', exception);
      return errorResponse('validation_failed', VALIDATION_FAILED_MESSAGE, {
        fieldErrors: { [FORM_ERROR_KEY]: [FRAMEWORK_BAD_REQUEST_FORM_MESSAGE] },
      });
    }

    // No code maps to any other framework status, and a code carries exactly one
    // status, so there is nothing to answer with but a 500. The original is logged.
    logError(log, 'framework exception with an unmapped status', exception, { status });
    return errorResponse('internal_error', INTERNAL_ERROR_MESSAGE);
  }
}

/**
 * The only place anything of the original error is recorded. Nothing from here reaches a
 * body.
 *
 * `includeMessage` is `isDomainError(...)` and nothing else. Constructing a `DomainError`
 * asserts its message is safe to show a stranger (`error-envelope.md`), so it is a
 * fortiori safe to log; every other throwable's message is the field that carries a DSN,
 * an internal host or a fragment of a request body. The frames go on the line either way —
 * that is TASK-003's answer to `error-envelope.md` § "What the 500 log line carries", and
 * it reverses F-093's interim rather than restoring what F-093 removed: the frames come
 * back only because the header line carrying `name: message` is stripped out of them.
 */
function logError(
  log: Logger,
  context: string,
  exception: unknown,
  fields: Readonly<Record<string, unknown>> = {},
): void {
  log.error(
    { ...fields, ...errorLogFields(exception, { includeMessage: isDomainError(exception) }) },
    context,
  );
}

/**
 * The `x-request-id` the caller sent, or a fresh uuid. Nothing upstream sets the header
 * today, so most ids are generated and correlate the lines of one failure with each other
 * and with nothing else. That is still `error-envelope.md` invariant 9's floor — a 500 now
 * has an id at all — and it becomes end-to-end correlation the moment the BFF forwards one
 * (TASK-012).
 */
function requestId(request: HttpRequestLike | undefined): string {
  // Optional throughout: `getRequest()` is a cast, and this runs before the try/catch that
  // F-092 wrapped `write` in, so a throw here would escape the one component that answers
  // for every throwable.
  const supplied = request?.headers[REQUEST_ID_HEADER];
  const value = Array.isArray(supplied) ? supplied[0] : supplied;

  if (typeof value !== 'string' || value.trim() === '') {
    return randomUUID();
  }

  return value.trim().slice(0, MAX_REQUEST_ID_LENGTH);
}
