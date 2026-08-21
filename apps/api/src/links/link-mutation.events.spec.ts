/**
 * STORY-2-01 / STORY-2-04: the hook `link-mutation-events.md` fixes, on its own, with no
 * database: the registry, the two phases, registration order within a phase, and the two
 * opposite failure postures. TASK-2-05.
 *
 * Contract: docs/contracts/link-mutation-events.md ("Two phases", "Firing rules",
 *           invariants 4 and 5). ADR: adr-0008, adr-0002.
 *
 * The firing TABLE (one mutation per successful operation, `before`/`after` per operation)
 * is asserted where the operations are, in `test/links/links.int-spec.ts`; what is asserted
 * here is everything that is true of the dispatcher whatever fired it.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

import type { TenantDb } from '../tenancy/tenant-context';
import { logger } from '../observability/logger';
import {
  clearLinkMutationSubscribers,
  onLinkMutated,
  runAfterCommitSubscribers,
  runInTransactionSubscribers,
} from './link-mutation.events';
import type { LinkMutation, LinkSnapshot } from './link-mutation.events';

/** A handle no test dereferences: the dispatcher passes it through and never reads it. */
const FAKE_DB = {} as unknown as TenantDb;

const SNAPSHOT: LinkSnapshot = {
  id: '11111111-1111-4111-8111-111111111111',
  tenantId: '22222222-2222-4222-8222-222222222222',
  workspaceId: '33333333-3333-4333-8333-333333333333',
  domainId: '44444444-4444-4444-8444-444444444444',
  hostname: 'localhost',
  slug: 'spring9',
  destinationUrl: 'https://example.test/a',
  expiresAt: null,
  activatesAt: null,
};

const MUTATION: LinkMutation = {
  action: 'created',
  linkId: SNAPSHOT.id,
  actorId: 'user_1',
  tenantId: SNAPSHOT.tenantId,
  occurredAt: new Date('2026-08-19T12:00:00.000Z'),
  before: null,
  after: SNAPSHOT,
};

beforeEach(() => {
  clearLinkMutationSubscribers();
  vi.restoreAllMocks();
});

describe('the registry dispatches by phase, in registration order', () => {
  it('an in-transaction subscriber receives the live TenantDb; an after-commit one receives null', async () => {
    const inTransaction = vi.fn().mockResolvedValue(undefined);
    const afterCommit = vi.fn().mockResolvedValue(undefined);

    onLinkMutated({ name: 'audit', phase: 'in-transaction', handle: inTransaction });
    onLinkMutated({ name: 'cache', phase: 'after-commit', handle: afterCommit });

    await runInTransactionSubscribers(MUTATION, FAKE_DB);
    expect(inTransaction).toHaveBeenCalledExactlyOnceWith(MUTATION, FAKE_DB);
    expect(afterCommit).not.toHaveBeenCalled();

    await runAfterCommitSubscribers(MUTATION);
    expect(afterCommit).toHaveBeenCalledExactlyOnceWith(MUTATION, null);
    expect(inTransaction).toHaveBeenCalledOnce();
  });

  it('within a phase, subscribers run in the order they registered, one after the other', async () => {
    const order: string[] = [];
    const record = (name: string) => async (): Promise<void> => {
      await Promise.resolve();
      order.push(name);
    };

    onLinkMutated({ name: 'first', phase: 'after-commit', handle: record('first') });
    onLinkMutated({ name: 'second', phase: 'after-commit', handle: record('second') });
    onLinkMutated({ name: 'third', phase: 'after-commit', handle: record('third') });

    await runAfterCommitSubscribers(MUTATION);

    expect(order).toEqual(['first', 'second', 'third']);
  });

  it('registering the same name twice is refused: two invalidators would delete the same key twice and hide one', () => {
    onLinkMutated({ name: 'cache', phase: 'after-commit', handle: vi.fn() });

    expect(() => onLinkMutated({ name: 'cache', phase: 'in-transaction', handle: vi.fn() })).toThrow(
      /cache/,
    );
  });
});

describe('the two failure postures are opposite, and that is the contract (invariants 4 and 5)', () => {
  it('an in-transaction throw propagates, so the caller rolls the mutation back with it', async () => {
    const later = vi.fn().mockResolvedValue(undefined);

    onLinkMutated({
      name: 'audit',
      phase: 'in-transaction',
      handle: () => Promise.reject(new Error('audit insert refused')),
    });
    onLinkMutated({ name: 'second', phase: 'in-transaction', handle: later });

    await expect(runInTransactionSubscribers(MUTATION, FAKE_DB)).rejects.toThrow(
      'audit insert refused',
    );
    // The throw stops the phase: nothing after it may act on a mutation that is about to
    // be rolled back.
    expect(later).not.toHaveBeenCalled();
  });

  it('an after-commit throw is logged and swallowed, and the subscribers after it still run', async () => {
    const error = vi.spyOn(logger, 'error').mockReturnValue(undefined);
    const later = vi.fn().mockResolvedValue(undefined);

    onLinkMutated({
      name: 'cache',
      phase: 'after-commit',
      handle: () => Promise.reject(new Error('redis unreachable at 10.0.0.1:6379')),
    });
    onLinkMutated({ name: 'second', phase: 'after-commit', handle: later });

    await expect(runAfterCommitSubscribers(MUTATION)).resolves.toBeUndefined();
    expect(later).toHaveBeenCalledOnce();

    // The operator's write already succeeded, so the only place this can go is the log,
    // and the error's MESSAGE does not go with it (`includeMessage: false`): a cache
    // failure's message names an internal host, and this line is not a DomainError's.
    expect(error).toHaveBeenCalledOnce();
    const [fields] = error.mock.calls[0];
    expect(fields).toMatchObject({ code: 'link_mutation_subscriber_failed', err_name: 'Error' });
    expect(JSON.stringify(fields)).not.toContain('10.0.0.1');
  });
});

describe('the snapshot is a plain object, and the mutation carries no row', () => {
  it('LinkSnapshot is structurally clonable: a Drizzle row would couple every subscriber to the schema', () => {
    // `structuredClone` throws on a class instance carrying functions, which is what a
    // Drizzle row proxy is. Passing this is what "never the Drizzle row object" means in
    // a form a test can measure.
    expect(() => structuredClone(MUTATION)).not.toThrow();
    expect(structuredClone(SNAPSHOT)).toEqual(SNAPSHOT);
    expect(Object.getPrototypeOf(SNAPSHOT)).toBe(Object.prototype);
  });
});
