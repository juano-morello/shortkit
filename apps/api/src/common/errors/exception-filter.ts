/**
 * Contract: design/contracts/error-envelope.md
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
 * row all land there. Name, message and stack go to the log and stop there (GC-9,
 * error-envelope.md invariant 8).
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
import { Catch, HttpException, Logger } from '@nestjs/common';
import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common';
import {
  ERROR_CODE_STATUS,
  FORM_ERROR_KEY,
  isZodError,
  toValidationDetails,
} from '@shortkit/contracts';
import type { ErrorEnvelope } from '@shortkit/contracts';

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
  // TASK-003 replaces this with the pino logger, which adds `request_id` to these
  // lines. Until then a 500 is correlated by timestamp only.
  private readonly logger = new Logger(ApiExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<HttpResponseLike>();

    // The redirect surface streams a 302 outside /api. Writing a body over a started
    // response corrupts it, so the failure goes to the log and the response is ended.
    if (response.headersSent) {
      this.logError('after the response started', exception);
      response.end();
      return;
    }

    try {
      this.write(response, exception);
    } catch (failure: unknown) {
      // F-092. This filter is the one component that answers for every throwable, and
      // resolving or writing can itself throw: `details` carrying a BigInt or a circular
      // reference makes `res.json` throw, and a header value Node rejects makes
      // `setHeader` throw ERR_INVALID_CHAR. Without this, the throw escapes into Nest's
      // error layer or finalhandler and the client gets a 500 with the wrong code — or,
      // outside production, HTML carrying a stack.
      this.logError('while writing the error response', failure);

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
  private write(response: HttpResponseLike, exception: unknown): void {
    const outcome = this.resolve(exception);

    // Before the body: this is how a 429 carries `Retry-After` (invariant 7) without
    // the throwing guard reaching for the response object.
    for (const [name, value] of Object.entries(outcome.headers ?? {})) {
      response.setHeader(name, value);
    }

    response.status(outcome.status).json(this.narrow(outcome.body));
  }

  /**
   * ADR-0026, applied once to the body the filter is about to write, so branch 1's
   * `toEnvelope()` output passes through it along with branches 2 to 4.
   */
  private narrow(body: ErrorEnvelope): ErrorEnvelope {
    const narrowed = narrowEnvelope(body);

    if (body.details !== undefined && narrowed.details === undefined) {
      // The code and nothing else. The dropped value is the one suspected of carrying
      // another tenant's data, and a log is not a safe place for it (GC-9).
      this.logger.warn(`dropped details from a ${body.code} envelope: no shape is named for it`);
    }

    return narrowed;
  }

  private resolve(exception: unknown): FilterOutcome {
    // 1. The only way application code asks for a status other than 500.
    if (isDomainError(exception)) {
      const status = exception.status;

      // Unreachable by type, reachable through a cast: a code with no row in
      // ERROR_CODE_STATUS. Never answer with `undefined` as a status.
      if (!Number.isInteger(status)) {
        this.logger.error(`domain error code has no status: ${exception.code}`);
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
      return this.resolveHttpException(exception);
    }

    // 4. Everything else, and the body says nothing about it.
    this.logError('unhandled', exception);
    return errorResponse('internal_error', INTERNAL_ERROR_MESSAGE);
  }

  private resolveHttpException(exception: HttpException): FilterOutcome {
    const status = exception.getStatus();

    if (status === ERROR_CODE_STATUS.not_found) {
      return errorResponse('not_found', NOT_FOUND_MESSAGE);
    }

    if (status === ERROR_CODE_STATUS.validation_failed) {
      // The exception's own message never reaches the body (F-094, ADR-0026): the
      // framework builds it out of the raw request bytes. It goes to the log instead,
      // through the same helper branch 4 uses. What the caller gets is a fixed string,
      // under `_form` because it belongs to the request as a whole rather than a field.
      this.logError('framework exception with a 400 status', exception);
      return errorResponse('validation_failed', VALIDATION_FAILED_MESSAGE, {
        fieldErrors: { [FORM_ERROR_KEY]: [FRAMEWORK_BAD_REQUEST_FORM_MESSAGE] },
      });
    }

    // No code maps to any other framework status, and a code carries exactly one
    // status, so there is nothing to answer with but a 500. The original is logged.
    this.logError(`framework exception with unmapped status ${status}`, exception);
    return errorResponse('internal_error', INTERNAL_ERROR_MESSAGE);
  }

  /**
   * The only place anything of the original error is recorded. Nothing from here reaches
   * a body.
   *
   * The stack is deliberately not logged, which is the policy `main.ts` already carries
   * under F-064's ruling: ADR-0022 redacts by path at the logger and no path reaches
   * into a stack, so it would be the one field on the line outside the redaction
   * pipeline. Name and message are the summary. F-093 exists because these two files
   * said opposite things; the stack returns when TASK-003 lands the pino error
   * serialiser, which is the TASK that owns the permanent answer for both files.
   */
  private logError(context: string, exception: unknown): void {
    if (exception instanceof Error) {
      this.logger.error(`${context}: ${exception.name}: ${exception.message}`);
      return;
    }

    this.logger.error(`${context}: non-error throwable: ${String(exception)}`);
  }
}
