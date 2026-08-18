/**
 * Contract: docs/contracts/error-envelope.md, slug.md, workspace-authorization.md, workspaces.md,
 *           invitation-tokens.md
 * ADR: adr-0005-contract-distribution.md
 * Produced by: TASK-007
 *
 * `apps/web` imports this source directly, with no build step. That is what makes
 * AC-14 true by construction: an incompatible change here breaks `pnpm typecheck`.
 *
 * THIS PACKAGE MAY IMPORT `zod` AND NOTHING ELSE.
 * Banned by lint: node:*, @nestjs/*, drizzle-orm, pg, react.
 * Next.js bundles this into client components; a Node-only import breaks the build.
 */

export * from './errors';
export * from './pagination';
export * from './roles';
export * from './slug';

export * from './domains/reserved-hostnames';

// Feature contracts are added here by their producing TASK, one line each,
// alphabetically. Keep this file re-exports only, so a wave conflict is one line.
// export * from './audit';        // TASK-049
export * from './auth';         // TASK-001
// export * from './domains';      // TASK-040
// export * from './gdpr';         // TASK-053
export * from './invitations';  // TASK-1b-01
// export * from './links';        // TASK-025
export * from './members';      // TASK-001
export * from './workspaces';   // TASK-012; TASK-014, TASK-045 extend it
