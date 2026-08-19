/**
 * AC-2-35 (enqueue is synchronous, creates no promise, cannot throw; the flush groups by
 * tenant, one transaction and one statement per group), AC-2-38 (truncation at enqueue, the
 * two capacity bounds, drop-oldest and the counter), and the 100/1000 ms triggers of
 * ADR-0010's table. TASK-2-09, wave 4.
 *
 * Contract: `docs/contracts/click-events.md` ("Buffering", "What the implementer must
 * guarantee"). ADR-0010, GC-Q, GC-R.
 *
 * ============================================================================
 * THE TRANSACTION BOUNDARY IS THE ONE THING MOCKED, AND ONLY IN THIS TIER.
 * ============================================================================
 *
 * `withTenantTransaction` opens a real pooled transaction and sets `app.tenant_id`; a unit
 * spec has no database. What this file asserts about it is the SHAPE the flusher uses it in
 * — one call per tenant group, carrying that group's tenant id, with that group's rows and
 * no other tenant's — which is exactly what a recording double can prove and what the
 * integration spec then proves against Postgres and the policies.
 */
import { createHook } from 'node:async_hooks';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RedirectClickInput } from '../redirect/ports/click-sink.port';

const transactions: { tenantId: string }[] = [];

vi.mock('../tenancy/tenant-context', async (importOriginal) => {
  // Typed as a bag rather than as the module: `consistent-type-imports` forbids an
  // `import()` type annotation, and every other export is passed through untouched.
  const actual = await importOriginal<Record<string, unknown>>();

  return {
    ...actual,
    withTenantTransaction: async <T>(tenantId: string, fn: () => Promise<T>): Promise<T> => {
      transactions.push({ tenantId });

      return fn();
    },
  };
});

const { CLICK_USER_AGENT_MAX_LENGTH } = await import('@shortkit/contracts');
const { logger } = await import('../observability/logger');
const {
  CLICK_BUFFER_MAX_BYTES,
  CLICK_BUFFER_MAX_EVENTS,
  CLICK_DROPPED_COUNTER,
  CLICK_FLUSH_EVENT_TRIGGER,
  CLICK_FLUSH_INTERVAL_MS,
  CLICK_INSERT_CHUNK_ROWS,
  CLICK_ROW_BIND_PARAMETERS,
  POSTGRES_MAX_BIND_PARAMETERS,
  ClickEventBuffer,
  userAgentOf,
} = await import('./click-event-buffer');
const { clickIpHash } = await import('./ip-hash');
const { UNKNOWN_IP_SENTINEL } = await import('./trusted-client-ip');

type Buffer_ = InstanceType<typeof ClickEventBuffer>;

const KEY = Buffer.from('FIXTURE-click-ip-hash-key-not-a-real-value0', 'base64url');

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const LINK = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const DOMAIN = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

/** Every append the flusher made, in order, as the writer saw it. */
let appended: (readonly { id: string; tenantId: string; linkId: string }[])[] = [];
let appendFails = 0;

function writerDouble() {
  return {
    append: async (events: readonly { id: string; tenantId: string; linkId: string }[]): Promise<void> => {
      if (appendFails > 0) {
        appendFails -= 1;

        throw new Error('the flush statement failed');
      }

      appended.push(events);

      return Promise.resolve();
    },
  };
}

function clickOn(tenantId: string, headers: RedirectClickInput['headers'] = {}): RedirectClickInput {
  return { linkId: LINK, domainId: DOMAIN, tenantId, occurredAt: new Date(), headers };
}

let buffer: Buffer_;

beforeEach(() => {
  transactions.length = 0;
  appended = [];
  appendFails = 0;
  buffer = new ClickEventBuffer(writerDouble(), KEY);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/* ========================================================================== *
 * AC-2-35: what `enqueue` may and may not do on the visitor's path.
 * ========================================================================== */

describe('enqueue (AC-2-35, click-events.md "What the implementer must guarantee")', () => {
  /**
   * MEASURED, NOT REVIEWED. `async_hooks` reports every promise the runtime CREATES, so a
   * `void this.flush()`, an `async` keyword on `enqueue`, or an `await` anywhere inside it
   * turns this red — which is the whole of "no promise is created on the request path"
   * (ADR-0010). A reading of the source proves it for the version that was read.
   */
  it('creates no promise, and returns undefined rather than a thenable', () => {
    let promises = 0;
    const hook = createHook({
      init(_id, type) {
        if (type === 'PROMISE') {
          promises += 1;
        }
      },
    });

    hook.enable();
    const returned = buffer.enqueue(clickOn(TENANT_A));
    hook.disable();

    expect(promises).toBe(0);
    expect(returned).toBeUndefined();
    expect(buffer.size).toBe(1);
  });

  it('performs no I/O: nothing is written until a trigger fires', () => {
    buffer.enqueue(clickOn(TENANT_A));

    expect(transactions).toHaveLength(0);
    expect(appended).toHaveLength(0);
  });

  /**
   * The header bag is the visitor's. Every shape below is one a client can actually produce,
   * plus two the prototype chain produces on its own, and a throw from any of them would
   * reach the redirect handler's guard and be logged as a click failure on a request that
   * otherwise succeeded.
   */
  it('cannot throw on hostile input', () => {
    const hostile: RedirectClickInput['headers'][] = [
      { 'user-agent': ['a', 'b'] },
      { 'user-agent': '\u0000\uD800 lone surrogate' },
      { 'user-agent': 'x'.repeat(64 * 1024) },
      Object.create(null) as Record<string, string>,
      JSON.parse('{"__proto__": {"user-agent": "polluted"}}') as Record<string, string>,
      { constructor: 'not a function here' },
      { 'x-forwarded-for': '203.0.113.7, 10.0.0.1' },
    ];

    for (const headers of hostile) {
      expect(() => buffer.enqueue(clickOn(TENANT_A, headers))).not.toThrow();
    }

    // And the same for a resolved decision whose fields are not what the types promise:
    // `enqueue` is called from a handler that catches, and neither may be the thing that
    // decides a visitor's response.
    const malformed = {
      linkId: LINK,
      domainId: DOMAIN,
      tenantId: undefined,
      occurredAt: new Date('not a date'),
      headers: {},
    } as unknown as RedirectClickInput;

    expect(() => buffer.enqueue(malformed)).not.toThrow();
  });

  it('truncates `user_agent` to 512 characters AT ENQUEUE, asserted on the buffer before any flush', () => {
    buffer.enqueue(clickOn(TENANT_A, { 'user-agent': 'u'.repeat(16 * 1024) }));

    const [buffered] = buffer.buffered;

    expect(buffered?.userAgent).toHaveLength(CLICK_USER_AGENT_MAX_LENGTH);
    expect(appended).toHaveLength(0);
  });

  it('holds a null `user_agent` for an absent header and for a repeated one', () => {
    buffer.enqueue(clickOn(TENANT_A));
    buffer.enqueue(clickOn(TENANT_A, { 'user-agent': ['one', 'two'] }));

    expect(buffer.buffered.map((event) => event.userAgent)).toEqual([null, null]);
  });

  it('hashes the address on this side: the buffered row carries an ip_hash and no address', () => {
    vi.stubEnv('TRUSTED_CLIENT_IP_HEADER', 'x-test-client-ip');
    buffer.enqueue(clickOn(TENANT_A, { 'x-test-client-ip': '203.0.113.7' }));

    const [buffered] = buffer.buffered;

    expect(buffered?.ipHash).toBe(clickIpHash(KEY, TENANT_A, '203.0.113.7'));
    expect(JSON.stringify(buffered)).not.toContain('203.0.113.7');
  });

  it('hashes the sentinel where no address was established (F-320)', () => {
    buffer.enqueue(clickOn(TENANT_A, { 'x-forwarded-for': '203.0.113.7' }));

    expect(buffer.buffered[0]?.ipHash).toBe(clickIpHash(KEY, TENANT_A, UNKNOWN_IP_SENTINEL));
  });

  it('draws a UUID v7 id per event, so the ids sort by arrival', () => {
    buffer.enqueue(clickOn(TENANT_A));
    buffer.enqueue(clickOn(TENANT_A));

    const ids = buffer.buffered.map((event) => event.id);

    expect(ids[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(ids[0]?.localeCompare(ids[1] ?? '')).toBeLessThan(0);
  });
});

/* ========================================================================== *
 * ADR-0010's triggers: 100 buffered events, or 1000 ms, whichever comes first.
 * ========================================================================== */

describe('flush triggers (ADR-0010)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it(`fires at ${String(CLICK_FLUSH_EVENT_TRIGGER)} buffered events, without waiting for the window`, async () => {
    for (let event = 0; event < CLICK_FLUSH_EVENT_TRIGGER; event += 1) {
      buffer.enqueue(clickOn(TENANT_A));
    }

    await vi.advanceTimersByTimeAsync(0);

    expect(appended).toHaveLength(1);
    expect(appended[0]).toHaveLength(CLICK_FLUSH_EVENT_TRIGGER);
    expect(buffer.size).toBe(0);
  });

  it(`fires ${String(CLICK_FLUSH_INTERVAL_MS)} ms after the first event, and not before`, async () => {
    buffer.enqueue(clickOn(TENANT_A));

    await vi.advanceTimersByTimeAsync(CLICK_FLUSH_INTERVAL_MS - 1);
    expect(appended).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1);
    expect(appended).toHaveLength(1);
    expect(buffer.size).toBe(0);
  });

  it('opens no transaction when the window elapses with nothing buffered', async () => {
    await vi.advanceTimersByTimeAsync(CLICK_FLUSH_INTERVAL_MS * 3);

    expect(transactions).toHaveLength(0);
  });

  it('starts a new window for events enqueued after a flush', async () => {
    buffer.enqueue(clickOn(TENANT_A));
    await vi.advanceTimersByTimeAsync(CLICK_FLUSH_INTERVAL_MS);

    buffer.enqueue(clickOn(TENANT_A));
    await vi.advanceTimersByTimeAsync(CLICK_FLUSH_INTERVAL_MS);

    expect(appended).toHaveLength(2);
  });
});

/* ========================================================================== *
 * AC-2-38: the two capacity bounds, drop-oldest, and the counter.
 * ========================================================================== */

describe('capacity (AC-2-38, click-events.md invariant 8)', () => {
  it(`holds at most ${String(CLICK_BUFFER_MAX_EVENTS)} events and drops the OLDEST`, () => {
    const overflow = 5;

    for (let event = 0; event < CLICK_BUFFER_MAX_EVENTS + overflow; event += 1) {
      buffer.enqueue(clickOn(TENANT_A));
    }

    expect(buffer.size).toBe(CLICK_BUFFER_MAX_EVENTS);
    expect(buffer.dropped).toBe(overflow);
    // The survivors are the newest: ids sort by arrival, so the first held id is the sixth
    // drawn, and the last held id is the last drawn.
    const ids = buffer.buffered.map((event) => event.id);
    expect([...ids].sort()).toEqual(ids);
  });

  /**
   * The row count alone did not bound memory (F-013): a 16 KiB `User-Agent` at a few hundred
   * RPS reached ~160 MiB of live heap on the machine that also serves every redirect. The
   * truncation caps one event at well under 1 KiB and this cap bounds the buffer regardless,
   * which is why it is reached FIRST here, with every event carrying a full-width agent.
   */
  it(`holds at most ${String(CLICK_BUFFER_MAX_BYTES)} bytes, reached before the row count when agents are wide`, () => {
    const wide = { 'user-agent': 'u'.repeat(CLICK_USER_AGENT_MAX_LENGTH) };

    for (let event = 0; event < CLICK_BUFFER_MAX_EVENTS; event += 1) {
      buffer.enqueue(clickOn(TENANT_A, wide));
    }

    expect(buffer.size).toBeLessThan(CLICK_BUFFER_MAX_EVENTS);
    expect(buffer.bytes).toBeLessThanOrEqual(CLICK_BUFFER_MAX_BYTES);
    expect(buffer.dropped).toBeGreaterThan(0);
  });

  it(`warns once per window under sustained overflow, carrying ${CLICK_DROPPED_COUNTER} and no field but \`code\``, () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(logger, 'warn');

    for (let event = 0; event < CLICK_BUFFER_MAX_EVENTS + 50; event += 1) {
      buffer.enqueue(clickOn(TENANT_A));
    }

    const dropLines = warn.mock.calls.filter(
      ([fields]) => (fields as { code?: string }).code === CLICK_DROPPED_COUNTER,
    );

    expect(dropLines).toHaveLength(1);
    expect(Object.keys(dropLines[0]?.[0] as object)).toEqual(['code']);
  });
});

/* ========================================================================== *
 * The flush itself: grouped by tenant, one transaction and one statement per group.
 * ========================================================================== */

describe('flush (AC-2-35, GC-Q)', () => {
  it('groups by tenantId: one transaction per tenant, carrying only that tenant\'s rows', async () => {
    buffer.enqueue(clickOn(TENANT_A));
    buffer.enqueue(clickOn(TENANT_B));
    buffer.enqueue(clickOn(TENANT_A));

    await buffer.flush();

    expect(transactions.map((transaction) => transaction.tenantId).sort()).toEqual(
      [TENANT_A, TENANT_B].sort(),
    );
    expect(appended).toHaveLength(2);

    for (const batch of appended) {
      expect(new Set(batch.map((event) => event.tenantId)).size).toBe(1);
    }
  });

  it('empties the buffer, so a second flush writes nothing', async () => {
    buffer.enqueue(clickOn(TENANT_A));

    await buffer.flush();
    await buffer.flush();

    expect(appended).toHaveLength(1);
    expect(buffer.size).toBe(0);
  });

  it('opens no transaction when there is nothing buffered', async () => {
    await buffer.flush();

    expect(transactions).toHaveLength(0);
  });

  /**
   * "Retry once per batch; the conflict clause makes that idempotent" (ADR-0010). The retry
   * re-sends the SAME ids, which is what `ON CONFLICT (id) DO NOTHING` makes safe; the
   * integration spec proves the row count against Postgres.
   */
  it('retries a failed batch once, with the same ids', async () => {
    appendFails = 1;
    buffer.enqueue(clickOn(TENANT_A));
    const [enqueued] = buffer.buffered;

    await buffer.flush();

    expect(transactions).toHaveLength(2);
    expect(appended).toHaveLength(1);
    expect(appended[0]?.[0]?.id).toBe(enqueued?.id);
  });

  it('gives up after the retry, logs, and never rejects: the flush is off the request path', async () => {
    appendFails = 2;
    const error = vi.spyOn(logger, 'error');
    buffer.enqueue(clickOn(TENANT_A));

    await expect(buffer.flush()).resolves.toBeUndefined();

    expect(appended).toHaveLength(0);
    expect(buffer.size).toBe(0);
    expect(
      error.mock.calls.some(([fields]) => (fields as { code?: string }).code === 'click_flush_failed'),
    ).toBe(true);
  });

  it('a failing tenant does not take another tenant\'s batch with it', async () => {
    appendFails = 2;
    buffer.enqueue(clickOn(TENANT_A));
    buffer.enqueue(clickOn(TENANT_B));

    await buffer.flush();

    expect(appended).toHaveLength(1);
    expect(appended[0]?.[0]?.tenantId).toBe(TENANT_B);
  });

  it('serialises concurrent flushes, so one batch is never written twice', async () => {
    buffer.enqueue(clickOn(TENANT_A));

    await Promise.all([buffer.flush(), buffer.flush(), buffer.flush()]);

    expect(appended).toHaveLength(1);
  });
});

/* ========================================================================== *
 * The wire ceiling: one tenant's group can legally exceed what one INSERT carries.
 * ========================================================================== */

describe('chunking (the Int16 bind-parameter ceiling)', () => {
  it('a full buffer would exceed the ceiling in one statement, which is why the chunk exists', () => {
    // The premise, stated as arithmetic rather than as prose: if this ever stops being true
    // the chunk is no longer load-bearing, and if the chunk itself crosses it the fix is
    // undone. 65,535 / 7 is 9362 rows, and the row cap is 10,000.
    expect(CLICK_BUFFER_MAX_EVENTS * CLICK_ROW_BIND_PARAMETERS).toBeGreaterThan(
      POSTGRES_MAX_BIND_PARAMETERS,
    );
    expect(CLICK_INSERT_CHUNK_ROWS * CLICK_ROW_BIND_PARAMETERS).toBeLessThan(
      POSTGRES_MAX_BIND_PARAMETERS,
    );
    expect(Math.floor(POSTGRES_MAX_BIND_PARAMETERS / CLICK_ROW_BIND_PARAMETERS)).toBe(9362);
  });

  it('splits one tenant\'s group into statements of at most the chunk size, inside ONE transaction', async () => {
    const size = CLICK_INSERT_CHUNK_ROWS * 2 + 500;

    for (let event = 0; event < size; event += 1) {
      buffer.enqueue(clickOn(TENANT_A));
    }

    await buffer.flush();

    // One transaction for the tenant, three statements inside it.
    expect(transactions).toHaveLength(1);
    expect(appended.map((batch) => batch.length)).toEqual([
      CLICK_INSERT_CHUNK_ROWS,
      CLICK_INSERT_CHUNK_ROWS,
      500,
    ]);

    // And nothing was lost or repeated in the splitting.
    const written = new Set(appended.flatMap((batch) => batch.map((event) => event.id)));
    expect(written.size).toBe(size);
  });

  it('retries the whole group, chunks included, and the conflict clause makes that safe', async () => {
    appendFails = 1;
    const size = CLICK_INSERT_CHUNK_ROWS + 1;

    for (let event = 0; event < size; event += 1) {
      buffer.enqueue(clickOn(TENANT_A));
    }

    await buffer.flush();

    expect(transactions).toHaveLength(2);
    expect(appended.map((batch) => batch.length)).toEqual([CLICK_INSERT_CHUNK_ROWS, 1]);
  });
});

/* ========================================================================== *
 * Invariant 8, the half a code review cannot see: what a truncated agent RETAINS.
 * ========================================================================== */

describe('userAgentOf (click-events.md invariant 8)', () => {
  it('truncates to the column width', () => {
    expect(userAgentOf({ 'user-agent': 'u'.repeat(16 * 1024) })).toHaveLength(
      CLICK_USER_AGENT_MAX_LENGTH,
    );
    expect(userAgentOf({ 'user-agent': 'short' })).toBe('short');
    expect(userAgentOf({})).toBeNull();
  });

  /**
   * V8 answers `slice` on a flat parent with a SlicedString, which holds the WHOLE PARENT
   * alive, so a truncated agent kept the 16 KiB header it came from and invariant 8's "well
   * under 1 KiB per buffered event" was false by roughly twelve times.
   *
   * MEASURED, WITH A FORCED COLLECTION, because an uncollected nursery is louder than the
   * property: 20,000 agents out of 16 KiB parents retain 313.6 MiB as slices and 10.3 MiB as
   * flat copies. `v8.setFlagsFromString` plus a `vm` context is how a spec reaches `gc()`
   * without the suite being run under `--expose-gc`; the flag is put back afterwards.
   * The 40 MiB threshold sits an order of magnitude below the sliced figure and four times
   * above the flat one, so it discriminates without being a benchmark.
   */
  it('copies the truncation flat, so a 16 KiB header does not stay alive behind it', () => {
    const count = 20_000;
    const held: (string | null)[] = [];

    setFlagsFromString('--expose-gc');
    const collect = runInNewContext('gc') as () => void;

    try {
      collect();
      const before = process.memoryUsage().heapUsed;

      for (let index = 0; index < count; index += 1) {
        held.push(userAgentOf({ 'user-agent': `${String(index)}-`.padEnd(16 * 1024, 'u') }));
      }

      collect();
      const retainedMiB = (process.memoryUsage().heapUsed - before) / 1024 / 1024;

      expect(held).toHaveLength(count);
      expect(held[0]).toHaveLength(CLICK_USER_AGENT_MAX_LENGTH);
      expect(
        retainedMiB,
        `${retainedMiB.toFixed(1)} MiB retained by ${String(count)} truncated agents`,
      ).toBeLessThan(40);
    } finally {
      setFlagsFromString('--no-expose-gc');
    }
  });

  it('is exact for a value the copy could otherwise rewrite: a split surrogate pair', () => {
    // The pair lands astride the boundary, so the truncation keeps its high half alone. A
    // `utf8` round trip would replace it with U+FFFD; the stored value is the visitor's.
    const agent = `${'u'.repeat(CLICK_USER_AGENT_MAX_LENGTH - 1)}\uD83D\uDE00tail`;
    const truncated = userAgentOf({ 'user-agent': agent });

    expect(truncated).toHaveLength(CLICK_USER_AGENT_MAX_LENGTH);
    expect(truncated?.charCodeAt(CLICK_USER_AGENT_MAX_LENGTH - 1)).toBe(0xd83d);
  });
});
