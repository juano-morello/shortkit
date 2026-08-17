/**
 * Contract: `docs/contracts/rate-limit.md` (the 32 KiB cap ahead of the Express limiter,
 *           invariant 8: "No request body larger than 32 KiB reaches Better Auth")
 * ADR: adr-0013-better-auth-in-nestjs.md ("`authBodyCap` does not parse")
 * Produced by: TASK-004 (wave 3). Registered once, in `main.ts`, ahead of `authRateLimit`
 *              and `toNodeHandler(auth)` on `/api/auth/{*splat}`.
 *
 * ============================================================================
 * IT DOES NOT PARSE, AND IT DOES NOT CONSUME THE STREAM ON THE ACCEPTED PATH.
 * ============================================================================
 *
 * The auth mount sits outside the Nest graph with `bodyParser: false`, because Better Auth
 * reads the raw request stream (ADR-0013). That is also why `express.json({ limit })` cannot
 * be the cap here: it would consume the stream, and `better-call`'s `getRequest` would then
 * build a `Request` with no body — the symptom is `undefined` rather than an error. And it
 * is why this middleware attaches NO `data` listener: attaching one switches the stream to
 * flowing mode, and `authRateLimit` behind it awaits its store before calling `next()`, so
 * every chunk emitted in that gap would be delivered to nobody Better Auth ever hears from.
 *
 * What it does instead:
 *
 *   - `Content-Length` greater than the cap answers 413 with `Connection: close`, and never
 *     hands a byte of the body to anything behind it. HOW the 413 is delivered depends on the
 *     size, and the reason is a TCP fact measured in `auth-mount.int-spec.ts`: a socket that
 *     is closed while unread bytes are still arriving answers them with a RST, and a RST
 *     discards whatever the peer has not yet read — including the 413 sitting in its receive
 *     buffer. So a moderately oversized body (up to `LINGER_MAX_BYTES`) is READ AND DISCARDED
 *     first and the 413 written after, which is what makes the status reach the client; that
 *     costs bandwidth and no memory, since nothing buffers a discarded stream. Beyond that
 *     ceiling the 413 is written at once and the socket is dropped on flush, so an absurd
 *     declared length is not paid for on the wire, and the client may see a reset instead of
 *     the status — the same accepted cost as the chunked case below.
 *   - A body with NO `Content-Length` (chunked) — or, defensively, one that delivers more
 *     than it declared — is counted as it passes through the parser's `push` into the
 *     request stream, and the socket is destroyed once the cap is crossed. No response body:
 *     a status written to a stream still being fed would sit behind the upload. A legitimate
 *     oversized upload therefore sees a connection reset rather than a 413, which ADR-0013
 *     records as an accepted cost.
 *
 * WHY `push` AND NOT A LISTENER. `_http_common`'s `parserOnBody` delivers each body slice with
 * `stream.push(b)`; wrapping that method on this one request counts the bytes at the moment
 * they enter the readable buffer, before any consumer sees them, without touching the
 * stream's mode, its listeners or its backpressure. It is the only hook Node offers that
 * observes body bytes without becoming a reader. Verified against Node 24 and pinned by the
 * "flowing: null, listeners: 0" assertion in `auth-body-cap.spec.ts`.
 *
 * `better-call` bounds a body only when a `bodySizeLimit` is passed and `toNodeHandler` passes
 * none, and with no `Content-Length` its own check compares against `NaN` and never fires.
 * This middleware is therefore the whole of the cap on this surface.
 */
import type { IncomingMessage } from 'node:http';

import type { RequestHandler, Response } from 'express';

export interface AuthBodyCapOptions {
  /** Inclusive: a body of exactly this many bytes is admitted. AC-7 says "greater than". */
  readonly maxBytes: number;
}

/**
 * The largest declared body the 413 path drains before answering, so the status is delivered
 * rather than lost to a reset. One MiB: thirty-two times the cap, far above anything a
 * client legitimately sends to an auth route, and small enough that draining it is a
 * negligible cost per request. Above it the connection is cut on flush.
 */
export const LINGER_MAX_BYTES = 1024 * 1024;

export function authBodyCap(options: AuthBodyCapOptions): RequestHandler {
  const { maxBytes } = options;

  return (req, res, next) => {
    const declared = Number(req.headers['content-length']);

    if (Number.isFinite(declared) && declared > maxBytes) {
      refuse(req, res, declared, maxBytes);
      return;
    }

    countBodyBytes(req, maxBytes);
    next();
  };
}

/**
 * The 413. Not JSON and not an `ErrorEnvelope`: `packages/contracts` has no 413 code, and
 * inventing one here would put a value on the wire that the append-only enum does not carry.
 * `Connection: close` in every case: this connection has an unread or half-read body on it
 * and is not to be reused.
 */
function refuse(req: IncomingMessage, res: Response, declared: number, maxBytes: number): void {
  const answer = (): void => {
    res
      .status(413)
      .set('Connection', 'close')
      .type('text/plain')
      .send(`request body exceeds the ${String(maxBytes)}-byte limit on /api/auth`);
  };

  if (declared > LINGER_MAX_BYTES) {
    answer();
    return;
  }

  // Read and discard, then answer. `resume()` with no `data` listener drops every chunk on
  // the floor; nothing behind this middleware runs, so nothing else will ever read it. If the
  // client stops sending, Node's own `requestTimeout` closes the socket.
  req.once('end', answer);
  req.once('error', () => undefined);
  req.resume();
}

/**
 * Wraps `req.push` for this one request so that every body slice the HTTP parser delivers is
 * counted before it is buffered. Once the running total crosses the cap the socket is
 * destroyed and the slice is dropped; `push` reports "stop" to the parser, which is moot
 * because the socket is gone.
 *
 * `push(null)` is end-of-stream and carries no bytes; anything else is a `Buffer` here,
 * because the parser hands `parserOnBody` a `Buffer` slice and nothing else calls `push` on
 * an `IncomingMessage`.
 */
function countBodyBytes(req: IncomingMessage, maxBytes: number): void {
  const push = req.push.bind(req);
  let seen = 0;

  req.push = (chunk: unknown, encoding?: BufferEncoding): boolean => {
    if (chunk !== null && chunk !== undefined) {
      seen += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk), encoding);

      if (seen > maxBytes) {
        req.socket.destroy();
        return false;
      }
    }

    return push(chunk as Buffer | null, encoding);
  };
}
