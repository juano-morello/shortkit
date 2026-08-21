import { WORKSPACE_ROLE, WORKSPACE_ROLES } from '@shortkit/contracts';
import { describe, expect, it } from 'vitest';

import type { OutboundMail } from './mail-sender';
import { renderEmailVerification } from './templates/email-verification';
import { escapeHtml, formatExpiry } from './templates/format';
import { renderMail } from './templates/render-mail';
import { renderWorkspaceInvitation, roleLabel } from './templates/workspace-invitation';

/**
 * STORY-1b-01: the rendered invitation (AC-1b-3's `data` shape). TASK-1b-02.
 *
 * Contract: `docs/contracts/mail-sender.md` (invariants 4 and 5; "Bodies are human-facing
 * prose and get a `stop-slop` pass"). ADR-0017, GC-K (the URL is in the body on purpose,
 * verbatim, and nowhere else), GC-12.
 */

const URL = 'https://app.example.test/invitations/accept#token=0b6c1c2e-3f4a-4b5c-8d6e-7f8091a2b3c4.AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_abcde';

const DATA = {
  inviteUrl: URL,
  inviterEmail: 'owner@agency.example',
  tenantName: 'Acme Agency',
  workspaces: [
    { name: 'Campaigns', role: WORKSPACE_ROLE.member },
    { name: 'Reporting', role: WORKSPACE_ROLE.viewer },
    { name: 'Ops', role: WORKSPACE_ROLE.workspace_admin },
  ],
  expiresAt: new Date('2026-08-25T15:04:00Z'),
} as const;

/**
 * The phrases a `stop-slop` pass strips from transactional copy, and the exclamation
 * mark, which it strips from all of it. Human-facing text in both parts is checked; a
 * later edit that reintroduces one fails here rather than in a reader's inbox.
 */
const SLOP = /\b(excited|thrilled|delighted|dive in|seamless|effortless|elevate|unlock|journey|hey there|hi there|welcome aboard)\b|!/i;

describe('renderWorkspaceInvitation', () => {
  const rendered = renderWorkspaceInvitation(DATA);

  it('subject is the contract\'s: "You\'ve been invited to <tenantName> on Shortkit"', () => {
    expect(rendered.subject).toBe("You've been invited to Acme Agency on Shortkit");
  });

  it('invariant 4: both parts render, and the text part carries the URL verbatim on a line of its own', () => {
    expect({
      textHasUrlLine: rendered.text.split('\n').includes(URL),
      htmlHasHref: rendered.html.includes(`href="${URL}"`),
      htmlHasVisibleUrl: rendered.html.split(URL).length - 1,
    }).toEqual({ textHasUrlLine: true, htmlHasHref: true, htmlHasVisibleUrl: 2 });
  });

  it('names the inviter, the tenant, every workspace with its role label, and the expiry in both parts', () => {
    const expiry = formatExpiry(DATA.expiresAt);

    for (const part of [rendered.text, rendered.html]) {
      expect(part).toContain('owner@agency.example');
      expect(part).toContain('Acme Agency');
      expect(part).toContain('Campaigns');
      expect(part).toContain('Reporting');
      expect(part).toContain('Ops');
      expect(part).toContain('(member)');
      expect(part).toContain('(viewer)');
      expect(part).toContain('(workspace admin)');
      expect(part).toContain(expiry);
    }

    expect(expiry).toBe('25 August 2026 at 15:04 UTC');
  });

  it('says the link is single-use and what to do if unexpected, in both parts', () => {
    for (const part of [rendered.text, rendered.html]) {
      expect(part).toContain('The link works once and expires on');
      expect(part).toContain('If you were not expecting this, ignore it. Nothing happens until you open the link.');
    }
  });

  it('GC-12: the copy is stop-slop clean', () => {
    const humanText = [rendered.subject, rendered.text, rendered.html.replace(/<[^>]+>/g, ' ')].join('\n');

    expect(humanText.match(SLOP)).toBeNull();
  });

  it('escapes tenant name, inviter and workspace names in the HTML part and leaves the text part alone', () => {
    const hostile = renderWorkspaceInvitation({
      ...DATA,
      tenantName: '<img src=x onerror=alert(1)> & "Co"',
      inviterEmail: "o'neil@agency.example",
      workspaces: [{ name: '<script>steal()</script>', role: WORKSPACE_ROLE.member }],
    });

    expect({
      htmlHasRawTag: hostile.html.includes('<img') || hostile.html.includes('<script>'),
      htmlEscapedTenant: hostile.html.includes('&lt;img src=x onerror=alert(1)&gt; &amp; &quot;Co&quot;'),
      htmlEscapedInviter: hostile.html.includes('o&#39;neil@agency.example'),
      htmlEscapedWorkspace: hostile.html.includes('&lt;script&gt;steal()&lt;/script&gt;'),
      textVerbatim: hostile.text.includes('<img src=x onerror=alert(1)> & "Co"') && hostile.text.includes('<script>steal()</script>'),
    }).toEqual({ htmlHasRawTag: false, htmlEscapedTenant: true, htmlEscapedInviter: true, htmlEscapedWorkspace: true, textVerbatim: true });
  });

  it('roleLabel covers every WORKSPACE_ROLES value with a phrase and no underscore', () => {
    expect(WORKSPACE_ROLES.map((role) => roleLabel(WORKSPACE_ROLE[role]))).toEqual(['workspace admin', 'member', 'viewer']);
  });
});

describe('renderEmailVerification', () => {
  const rendered = renderEmailVerification({ verificationUrl: 'https://app.example.test/verify#token=abc', expiresAt: new Date('2026-08-19T00:00:00Z') });

  it('renders both parts with the URL verbatim, and the copy is stop-slop clean', () => {
    expect({
      subject: rendered.subject,
      textHasUrlLine: rendered.text.split('\n').includes('https://app.example.test/verify#token=abc'),
      htmlHasHref: rendered.html.includes('href="https://app.example.test/verify#token=abc"'),
      slop: [rendered.subject, rendered.text, rendered.html.replace(/<[^>]+>/g, ' ')].join('\n').match(SLOP),
    }).toEqual({ subject: 'Verify your email address for Shortkit', textHasUrlLine: true, htmlHasHref: true, slop: null });
  });
});

describe('renderMail', () => {
  it('dispatches on template to the renderer for that member', () => {
    const invitation: OutboundMail = { template: 'workspace_invitation', to: 'a@b.test', data: DATA };
    const verification: OutboundMail = { template: 'email_verification', to: 'a@b.test', data: { verificationUrl: 'https://x.test/v#t', expiresAt: DATA.expiresAt } };

    expect({
      invitation: renderMail(invitation),
      verification: renderMail(verification),
    }).toEqual({
      invitation: renderWorkspaceInvitation(DATA),
      verification: renderEmailVerification(verification.data),
    });
  });
});

describe('escapeHtml', () => {
  it('escapes the five HTML metacharacters and is the identity on a token URL', () => {
    expect({ escaped: escapeHtml(`<a href="x">&'</a>`), url: escapeHtml(URL) }).toEqual({
      escaped: '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;',
      url: URL,
    });
  });
});
