/**
 * Contract: docs/contracts/slug.md, click-events.md, redirect-resolution.md,
 *           link-mutation-events.md, error-envelope.md
 * ADR: adr-0005-contract-distribution.md, adr-0009-expiry-eviction.md
 * Produced by: TASK-2-01
 *
 * Re-exports only, so a wave conflict is one line. Three files rather than one because
 * they have three different audiences: `link.ts` is the management API's, `click-event.ts`
 * is the clicks module's, and `is-link-active.ts` is imported by the redirect hot path,
 * which may not import the management API at all (GC-N) and must not pull zod in behind
 * one pure comparison.
 */

export * from './click-event';
export * from './is-link-active';
export * from './link';
