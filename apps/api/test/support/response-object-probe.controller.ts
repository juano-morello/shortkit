import { BadRequestException, Controller, Get, SetMetadata } from '@nestjs/common';

import { PUBLIC_ROUTE_METADATA } from '../../src/tenancy/tenant-context';

/**
 * F-273's fixture. ⚠ THIS FILE IS sdlc-test-architect'S, like the rest of
 * `apps/api/test/support/**`. It is imported by
 * `src/observability/framework-400-request-body.spec.ts` and by the child process that suite
 * spawns; nothing in `apps/api/src` imports it and nothing may.
 *
 * ## What it is for
 *
 * `BadRequestException` carries the value it was constructed with TWICE: on `message`, and
 * inside the object `getResponse()` returns. For the framework's own malformed-body 400 the
 * two copies hold the same bytes, so a test asserting that the emitted line is free of the
 * request-body fragment cannot tell which copy the defence acted on — and
 * `error-envelope.md`'s `includeMessage` policy acts on the FIRST copy only.
 *
 * This route produces the shape where the two copies DIFFER. Nest's `HttpException`
 * derives `this.message` from the response object only when `response.message` is a string
 * (`initMessage`, `@nestjs/common/exceptions/http.exception.js`); an ARRAY leaves `message`
 * as the class-name text, so the marker below exists at exactly one place on the exception —
 * `getResponse().message[0]` — and no field the log policy governs holds it.
 *
 * That is the route the F-273 finding names: a copy "under a key nothing special-cases",
 * reachable only by calling `getResponse()`. A filter edit that logs or forwards that object
 * puts this marker on the wire while every other assertion in the suite stays green.
 *
 * ## Why this shape is realistic rather than invented
 *
 * `{ message: string[], error, statusCode }` is what Nest's own `ValidationPipe` throws, and
 * `ApiExceptionFilter` is registered with a bare `@Catch()`, so it answers for every pipe,
 * guard and interceptor any later TASK mounts. `apps/api` validates with zod through
 * `packages/contracts` today (ADR-0025), which is why no route in `src` produces this shape
 * and why the fixture lives here instead.
 */

/**
 * Reachable ONLY through `getResponse()`. Deliberately unlike the two markers
 * `framework-400-request-body.spec.ts` sends in a request body, so that a leak of this value
 * fails the F-273 assertions and nothing else — which is what makes them load-bearing.
 */
export const RESPONSE_OBJECT_ONLY_MARKER = 'ROSECRET-reachable-only-through-getResponse';

/** No global prefix is set on the app the suite's child builds, so this resolves at the root. */
export const RESPONSE_OBJECT_PROBE_PATH = 'f273-response-object';

/**
 * Public since TASK-005 registered `AuthGuard` as `APP_GUARD` (wave 4): the marker below is
 * only reachable if the handler runs, and the handler only runs on a route the global guard
 * exempts. The metadata is what `@Public('…')` writes once TASK-006 implements it.
 */
@Controller(RESPONSE_OBJECT_PROBE_PATH)
@SetMetadata(PUBLIC_ROUTE_METADATA, 'F-273 fixture: the probe has to reach its handler')
export class ResponseObjectProbeController {
  @Get()
  throwWithTheMarkerOnlyInTheResponseObject(): never {
    throw new BadRequestException({
      message: [`_form: ${RESPONSE_OBJECT_ONLY_MARKER}`],
      error: 'Bad Request',
      statusCode: 400,
    });
  }
}
