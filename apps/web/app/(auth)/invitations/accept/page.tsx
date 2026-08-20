/**
 * TASK-1b-13 (STORY-1b-02 AC-1b-12; STORY-1b-03 AC-1b-16). The invitation accept page, at
 * `/invitations/accept` — the screen a stranger reaches from an email.
 *
 * A thin server component: the heading, then `<AcceptInvitation />`, which is where every
 * decision lives (its docblock records them). Nothing is fetched here and no `requireAuth`
 * runs — the page MUST be reachable signed out, because a person with no account is its
 * main visitor — and the one input, the token, is in the URL FRAGMENT (D-03), which a
 * server never sees. Static prerendering is fine: the first paint is the client
 * component's "checking" state and depends on nothing request-bound.
 *
 * `/invitations` alone has no page and is Next's default 404.
 */
import type { Metadata } from 'next';
import type { ReactElement } from 'react';

import { AcceptInvitation } from './accept-invitation';

export const metadata: Metadata = {
  title: 'Accept your invitation · Shortkit',
  description: 'Join your team’s Shortkit workspaces.',
  // A page whose only input is a bearer capability has no business in a search index.
  robots: { index: false, follow: false },
};

export default function AcceptInvitationPage(): ReactElement {
  return (
    <main className="auth-page invitation-accept">
      <h1>Accept your invitation</h1>
      <AcceptInvitation />
    </main>
  );
}
