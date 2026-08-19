/**
 * D-2-10's owed test, and ADR-0011's lesson applied to the second port: `REDIRECT_CLICK_SINK`
 * is injected `@Optional()`, so an unbound token is a redirect that answers perfectly and
 * writes no click row, with every other suite green. This file is what turns that into a red
 * test. TASK-2-09, wave 4.
 *
 * IT COMPILES THE PRODUCTION GRAPH (`AppModule`), not a hand-built testing module: the
 * binding under assertion is a line in `clicks.module.ts` AND the `ClicksModule` entry in
 * `app.module.ts`, and only the real composition root carries both.
 */
import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import { afterEach, describe, expect, it } from 'vitest';

import { AppModule } from '../app.module';
import { REDIRECT_CLICK_SINK } from '../redirect/ports/click-sink.port';

import { ClickEventBuffer } from './click-event-buffer';
import { ClickEventReaderRepository } from './click-event.reader';
import { ClickEventWriterRepository } from './click-event.writer';

describe('ClicksModule in the production graph (D-2-10, ADR-0011)', () => {
  let moduleRef: TestingModule | null = null;

  afterEach(async () => {
    await moduleRef?.close();
    moduleRef = null;
  });

  it('binds REDIRECT_CLICK_SINK, so the redirect writes clicks instead of degrading silently', async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();

    expect(moduleRef.get(REDIRECT_CLICK_SINK, { strict: false })).toBeInstanceOf(ClickEventBuffer);
  });

  /**
   * ============================================================================
   * THE ASSERTION THAT ACTUALLY BITES, AND THE ONE ABOVE IS NOT IT (MEASURED).
   * ============================================================================
   *
   * Nest resolves a provider from the CONSUMER'S module scope, while
   * `get(token, { strict: false })` searches the whole container. So a token bound in this
   * module and not visible to `RedirectModule` passes the test above and hands the
   * controller `null`, which, with `@Optional()`, is a redirect that answers 302 and writes
   * no click row, forever, silently. That is exactly what happened before `ClicksModule`
   * carried `@Global()`, and this is the test that fails when it stops.
   *
   * The private field is read deliberately: what is under test is the INJECTION POINT, and
   * the only honest observation of an injection point is what the instance received.
   */
  it('the redirect CONTROLLER receives it: the injection point is filled, not merely the container', async () => {
    const { RedirectController } = await import('../redirect/redirect.controller');

    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();

    const controller = moduleRef.get(RedirectController, { strict: false });
    const injected = (controller as unknown as { clicks: unknown }).clicks;

    expect(injected).toBe(moduleRef.get(ClickEventBuffer, { strict: false }));
  });

  /**
   * `useExisting`, not `useClass`. Two instances would mean `main.ts`'s SIGTERM drain
   * flushing a buffer no redirect ever enqueued into: a shutdown that loses every buffered
   * click while reporting success.
   */
  it('binds the sink to the SAME instance main.ts drains', async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();

    expect(moduleRef.get(REDIRECT_CLICK_SINK, { strict: false })).toBe(
      moduleRef.get(ClickEventBuffer, { strict: false }),
    );
  });

  it('resolves the writer and the reader, which are the two tenant-facing surfaces', async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();

    expect(moduleRef.get(ClickEventWriterRepository, { strict: false })).toBeInstanceOf(
      ClickEventWriterRepository,
    );
    expect(moduleRef.get(ClickEventReaderRepository, { strict: false })).toBeInstanceOf(
      ClickEventReaderRepository,
    );
  });

  /**
   * The clicks module may import the redirect module's token file (D-2-10 puts the arrow
   * this way round on purpose); the redirect module may import nothing of ours. That
   * direction is asserted from the other side by `redirect-isolation.spec.ts`'s static scan,
   * and this is the half that would notice a `ClicksModule` import appearing in
   * `redirect.module.ts` to "fix" a binding.
   */
  it('is not reachable from the redirect module: RedirectModule compiles with no clicks module present', async () => {
    const { RedirectModule } = await import('../redirect/redirect.module');

    moduleRef = await Test.createTestingModule({ imports: [RedirectModule] }).compile();

    const graph = moduleRef;

    // Compiled at all, which is the assertion: the redirect module boots with the sink
    // unbound (wave 3's state) and the token resolves in no other way.
    expect(() => graph.get(REDIRECT_CLICK_SINK, { strict: false })).toThrow();
  });
});
