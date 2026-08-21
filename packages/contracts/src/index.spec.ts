/**
 * STORY-001, AC-8. TASK-001.
 *
 * ADR: adr-0005-contract-distribution.md
 *
 * ============================================================================
 * F-099. THE SUBJECT IS THE BARREL, NOT THE CONTRACTS BEHIND IT.
 * ============================================================================
 *
 * ADR-0005 makes `src/index.ts` what both deployables read: `apps/web` imports this
 * package's source directly with no build step, and `apps/api` imports the same entry
 * point. The two lines TASK-001 exists to land are
 *
 *     export * from './auth';     // TASK-001
 *     export * from './members';  // TASK-001
 *
 * and until this file existed they were asserted by NOTHING. `auth.spec.ts` imports
 * `./index` (the auth module's own index, not the package's), and `members.spec.ts`
 * does the same, so DELETING EITHER BARREL LINE LEFT THE WHOLE SUITE GREEN. The package's
 * one actual public surface was the one deliverable with no coverage.
 *
 * ============================================================================
 * GREEN ON ARRIVAL, DELIBERATELY. DO NOT DELETE THIS FILE AS REDUNDANT.
 * ============================================================================
 *
 * Both barrel lines are already present, so this has no failing history. That is what it
 * is for: it pins something that works today and was held in place by nothing. Measured:
 * commenting out `export * from './auth'` fails this test with
 * `"auth: signUpRequestContract": false`, and commenting out `export * from './members'`
 * fails it with `"members: parseTenantMembership": false`.
 *
 * IT ASSERTS REACHABILITY AND IDENTITY, NOT BEHAVIOUR. What each contract does is
 * `auth.spec.ts`'s and `members.spec.ts`'s job and is not restated here. Identity rather
 * than mere presence (`'x' in entryPoint`) because a barrel that re-declared a copy of a
 * schema instead of re-exporting it would satisfy presence and hand `apps/web` a
 * different object than `apps/api` holds.
 */
import { describe, expect, it } from 'vitest';

import { signUpRequestContract } from './auth';
import * as entryPoint from './index';
import { createInvitationRequestContract } from './invitations';
import { isLinkActive, linkContract } from './links';
import { parseTenantMembership, parseWorkspaceMembership } from './members';
import { validateSlug } from './slug';
import { workspaceContract } from './workspaces';

describe('package entry point', () => {
  it('AC-8 (ADR-0005, F-099): the auth and member contracts are reachable through src/index.ts', () => {
    // One assertion covering both lines, keyed by module, so a failure names which
    // re-export went rather than reporting `undefined` twice.
    expect({
      'auth: signUpRequestContract': entryPoint.signUpRequestContract === signUpRequestContract,
      'members: parseTenantMembership': entryPoint.parseTenantMembership === parseTenantMembership,
    }).toEqual({
      'auth: signUpRequestContract': true,
      'members: parseTenantMembership': true,
    });
  });

  it('AC-21 (ADR-0005, TASK-012): the workspace contracts are reachable through src/index.ts', () => {
    // The same pin for the line TASK-012 uncommented: `apps/web` reads `workspaceContract`
    // through this barrel and nothing else would notice the line going back to a comment.
    expect(entryPoint.workspaceContract === workspaceContract).toBe(true);
  });

  it('AC-1b-1 (ADR-0005, TASK-1b-01): the invitation contracts and the workspace-membership pair are reachable through src/index.ts', () => {
    // The line TASK-1b-01 uncommented (`export * from './invitations'`) and the second pair
    // `members/index.ts` grew. Both deployables read `createInvitationRequestContract` through
    // this barrel; `parseWorkspaceMembership` is what `MembershipRepository` brands through.
    expect({
      'invitations: createInvitationRequestContract':
        entryPoint.createInvitationRequestContract === createInvitationRequestContract,
      'members: parseWorkspaceMembership':
        entryPoint.parseWorkspaceMembership === parseWorkspaceMembership,
    }).toEqual({
      'invitations: createInvitationRequestContract': true,
      'members: parseWorkspaceMembership': true,
    });
  });

  it('AC-2-4/AC-2-27 (ADR-0005, TASK-2-01): the link contracts and the implemented slug rules are reachable through src/index.ts', () => {
    // The line TASK-2-01 uncommented (`export * from './links'`), plus the two `slug.ts`
    // functions that stopped throwing `not implemented` on this card. `isLinkActive` is
    // the identity that matters most here: ADR-0009 requires the API and the redirect
    // path to share ONE function, and a barrel that handed them different objects would
    // satisfy presence while letting the two diverge (F-099's whole point).
    expect({
      'links: linkContract': entryPoint.linkContract === linkContract,
      'links: isLinkActive': entryPoint.isLinkActive === isLinkActive,
      'slug: validateSlug': entryPoint.validateSlug === validateSlug,
    }).toEqual({
      'links: linkContract': true,
      'links: isLinkActive': true,
      'slug: validateSlug': true,
    });
  });
});
