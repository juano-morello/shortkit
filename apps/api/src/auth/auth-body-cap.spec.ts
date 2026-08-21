import { request as httpRequest } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import express from 'express';
import type { Request, Response } from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { LINGER_MAX_BYTES, authBodyCap } from './auth-body-cap';

/**
 * STORY-001: AC-7's mechanism, one layer under the wire. TASK-004, wave 3.
 *
 * Contract: `docs/contracts/rate-limit.md` ("A body cap, `authBodyCap`, sits ahead of the
 * Express limiter at 32 KiB", invariant 8). ADR-0013 ("`authBodyCap` does not parse").
 *
 * AC-7 itself is asserted against the built API in `test/auth/auth-mount.int-spec.ts`. What
 * is asserted HERE is the middleware's own three behaviours, on a bare Express app with a
 * probe handler behind it, because two of them are invisible from outside:
 *
 *   1. `Content-Length` over the cap answers 413 and the handler behind never runs, after
 *      draining a moderate overflow so the status survives, and at once above
 *      `LINGER_MAX_BYTES`;
 *   2. a body that is not over the cap reaches the handler INTACT, with the stream neither
 *      consumed nor switched to flowing mode, which is the whole reason `bodyParser: false`
 *      exists and the property Better Auth's `toNodeHandler` depends on;
 *   3. a chunked body with no `Content-Length` is counted as it passes and the socket is
 *      destroyed once the cap is crossed, with no response body.
 *
 * ============================================================================
 * THE ACCEPTED PATH IS ASSERTED BY WHAT THE HANDLER BEHIND IT SEES, NOT BY THE STATUS.
 * ============================================================================
 *
 * A middleware that read the body to count it and then called `next()` would answer 200
 * here and hand Better Auth an ended stream, and `better-call`'s `getRequest` would then
 * build a `Request` with no body: the symptom ADR-0013 warns is `undefined` rather than an
 * error. So the probe reports the bytes it received AND whether the stream was already
 * flowing or listened to when it got there, and both are in the assertion.
 */

const CAP = 1024;

interface Probe {
  readonly status: number;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: string;
}

interface Outcome {
  /** Set when the server answered. */
  readonly response?: Probe;
  /** Set when the connection failed or closed with no response. */
  readonly error?: string;
}

let server: Server;
let port: number;

interface Observed {
  readonly bytes: number;
  readonly flowing: boolean | null;
  readonly listeners: number;
}

/** What the handler behind the cap observed on its most recent invocation, or `undefined`. */
let observed: Observed | undefined;

/** Read through a call so TypeScript's flow narrowing does not pin the variable at `undefined` across an await. */
const seen = (): Observed | undefined => observed;

beforeAll(async () => {
  const app = express();

  app.all('/api/auth/{*splat}', authBodyCap({ maxBytes: CAP }), (req: Request, res: Response) => {
    // Recorded BEFORE the body is read, because that is when Better Auth attaches its own
    // `data` listener: a stream that is already flowing, or already has a listener, has had
    // its chunks delivered to somebody else.
    const flowing = req.readableFlowing;
    const listeners = req.listenerCount('data');

    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      observed = { bytes: Buffer.concat(chunks).length, flowing, listeners };
      res.status(200).json(observed);
    });
    req.on('error', () => {
      observed = { bytes: -1, flowing, listeners };
    });
  });

  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/**
 * One raw request. `chunked: true` writes the body in pieces with no `Content-Length`;
 * otherwise `Content-Length` is whatever `headers` says, or the body's true length.
 */
async function send(options: {
  readonly method?: string;
  readonly path?: string;
  readonly headers?: Record<string, string>;
  readonly body?: Buffer;
  readonly chunked?: boolean;
}): Promise<Outcome> {
  const body = options.body ?? Buffer.alloc(0);
  const chunked = options.chunked ?? false;

  return new Promise<Outcome>((resolve) => {
    let settled = false;
    const settle = (outcome: Outcome): void => {
      if (!settled) {
        settled = true;
        resolve(outcome);
      }
    };

    const request = httpRequest(
      {
        host: '127.0.0.1',
        port,
        // A fresh connection per request: the cap destroys sockets, and a kept-alive one from
        // an earlier case must not be what the next case writes into.
        agent: false,
        method: options.method ?? 'POST',
        path: options.path ?? '/api/auth/sign-up/email',
        headers: {
          'content-type': 'application/json',
          ...(chunked ? { 'transfer-encoding': 'chunked' } : { 'content-length': String(body.length) }),
          ...options.headers,
        },
      },
      (response) => {
        let text = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => (text += chunk));
        response.on('end', () =>
          settle({
            response: { status: response.statusCode ?? 0, headers: response.headers, body: text },
          }),
        );
        response.on('error', (error) => settle({ error: error.message }));
      },
    );

    request.on('error', (error: NodeJS.ErrnoException) => settle({ error: error.code ?? error.message }));
    request.on('close', () => settle({ error: 'closed with no response' }));

    if (chunked) {
      // 256-byte pieces, so the cap is crossed mid-stream rather than in one write.
      for (let offset = 0; offset < body.length; offset += 256) {
        request.write(body.subarray(offset, offset + 256));
      }
    } else {
      request.write(body);
    }
    request.end();
  });
}

describe('authBodyCap', () => {
  it('answers 413 when Content-Length exceeds the cap, and the handler behind never runs', async () => {
    observed = undefined;

    const outcome = await send({ body: Buffer.alloc(CAP + 1, 'a') });

    expect({
      status: outcome.response?.status,
      connection: outcome.response?.headers.connection,
      handlerRan: seen() !== undefined,
    }).toEqual({ status: 413, connection: 'close', handlerRan: false });
  });

  it('above LINGER_MAX_BYTES it answers at once and cuts the connection on flush, and the handler never runs', async () => {
    // A declared length nobody legitimate sends is not paid for on the wire: the 413 is
    // written immediately and the socket dropped once it is flushed. Whether the client reads
    // the status or a reset is a race the contract accepts, so only "not admitted" is pinned.
    observed = undefined;

    const outcome = await send({
      body: Buffer.alloc(16, 'z'),
      headers: { 'content-length': String(LINGER_MAX_BYTES + 1) },
    });

    expect({
      admitted: outcome.response?.status === 200,
      statusIfAny: outcome.response?.status,
      handlerRan: seen() !== undefined,
    }).toEqual({ admitted: false, statusIfAny: outcome.response === undefined ? undefined : 413, handlerRan: false });
  });

  it('passes a body of exactly the cap through intact, without consuming or flowing the stream', async () => {
    // `>` and not `>=`: AC-7 says "greater than 32768", so the boundary is admitted. And the
    // handler must see a stream nobody has touched: `readableFlowing === null` is Node's
    // "no mechanism for consuming has been attached", and zero `data` listeners is the same
    // statement from the other side.
    observed = undefined;

    const outcome = await send({ body: Buffer.alloc(CAP, 'b') });

    expect({ status: outcome.response?.status, observed: seen() }).toEqual({
      status: 200,
      observed: { bytes: CAP, flowing: null, listeners: 0 },
    });
  });

  it('passes a chunked body under the cap through intact, on the same terms', async () => {
    observed = undefined;

    const outcome = await send({ body: Buffer.alloc(CAP - 1, 'c'), chunked: true });

    expect({ status: outcome.response?.status, observed: seen() }).toEqual({
      status: 200,
      observed: { bytes: CAP - 1, flowing: null, listeners: 0 },
    });
  });

  it('destroys the socket with no response once a chunked body crosses the cap', async () => {
    // No `Content-Length` to refuse on, so the bytes are counted as they pass and the
    // connection is cut. A legitimate oversized upload sees a reset rather than a 413, which
    // ADR-0013 records as an accepted cost. NO RESPONSE AT ALL, not a 413 after the fact: a
    // status written to a stream that is still being fed would sit behind the upload.
    const outcome = await send({ body: Buffer.alloc(CAP * 4, 'd'), chunked: true });

    expect({ answered: outcome.response !== undefined, failed: outcome.error !== undefined }).toEqual({
      answered: false,
      failed: true,
    });
  });

  it('lets a request with no body through', async () => {
    observed = undefined;

    const outcome = await send({ method: 'GET', path: '/api/auth/ok' });

    expect({ status: outcome.response?.status, bytes: seen()?.bytes }).toEqual({
      status: 200,
      bytes: 0,
    });
  });
});
