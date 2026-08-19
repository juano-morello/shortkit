'use client';

/**
 * TASK-2-14 (STORY-2-10, AC-2-48). The list half of `/workspaces/[workspaceId]/links`. One
 * row per link, carrying its slug, the composed short URL with a copy control, the
 * destination and the window badge, plus the cursor's "load more".
 *
 * Contract: docs/contracts/redirect-resolution.md (what the composed URL reaches),
 *   docs/contracts/slug.md (slugs are case-sensitive), docs/contracts/error-envelope.md.
 * ADR: adr-0009 (ONE window rule, `isLinkActive`), adr-0007, adr-0014.
 * Decision: D-2-02 (short links are `${SHORT_LINK_ORIGIN}/<slug>`), D-2-18.
 * Consumes: TASK-2-13's `linkWindowState`, `LINK_ROUTE`, `shortUrl`.
 *
 * ============================================================================
 * THE WINDOW WORD IS `linkWindowState`'S, WHICH IS `isLinkActive`'S (ADR-0009).
 * ============================================================================
 *
 * Nothing here compares a timestamp. `linkWindowState` asks the shared rule whether the
 * link SERVES and only splits the not-serving case into the two words an operator can act
 * on, so this screen and the redirect can never disagree about a link's state. `now` is a
 * PROP: the screen takes one clock per list change and every row is judged against it, so
 * a row cannot flip mid-list and a re-render cannot silently re-date the page.
 *
 * ============================================================================
 * THE SHORT URL IS SELECTABLE TEXT FIRST AND A COPY BUTTON SECOND.
 * ============================================================================
 *
 * It is the one thing an operator takes off this screen, so it is rendered in full, as
 * selectable text, and never as `undefined/<slug>`: the origin arrives as a prop from the
 * server (`shortLinkOrigin()` throws when `SHORT_LINK_ORIGIN` is unset, so an unconfigured
 * deployment fails loudly instead of handing out a broken link), and a row whose URL still
 * cannot be composed shows the slug alone with no copy control rather than a wrong URL.
 *
 * The copy control is an ENHANCEMENT over that text. `navigator.clipboard` is absent on an
 * insecure origin and can be refused by permission, so the outcome is reported either way
 * through the screen's live region ("copied", or "select it and copy it").
 *
 * ============================================================================
 * THE DESTINATION IS RENDERED AS TEXT. IT IS NEVER AN `href`.
 * ============================================================================
 *
 * A destination is attacker-influenced from the point of view of everyone else who later
 * opens this list: any member of the workspace can store one, and the API admits every
 * `http:`/`https:` URL (D-2-08 bans only the `javascript:`/`data:` class). Rendering it as
 * a link would let one member put a control on a colleague's screen that navigates
 * somewhere the colleague did not read first. It is shown as text, truncated by CSS with
 * the full value in `title`, so the whole string is in the DOM for a screen reader and
 * nothing about it is clickable. The card's own words are "destination (truncated, full on
 * title)".
 */
import Link from 'next/link';
import { useId } from 'react';
import type { ReactElement } from 'react';

import type { Link as LinkRow } from '@shortkit/contracts';

import { LINK_ROUTE, linkWindowState } from '../../lib/links/links-api';
import { shortUrl } from '../../lib/short-url';
import { LINK_SCREEN_MESSAGES, formatInstant } from './links-view';

export const LINK_LIST_MESSAGES = {
  heading: 'Links',
  loadMore: 'Load more links',
  loadingMore: 'Loading…',
  copy: 'Copy',
  edit: 'Edit',
  shortUrlLabel: 'short link for',
  destinationLabel: 'Destination',
} as const;

export interface LinkListProps {
  /** Newest first, as the API sent them; the screen owns the state and the cursor. */
  items: LinkRow[];
  workspaceId: string;
  /** `SHORT_LINK_ORIGIN`, read on the server and handed down (it is not a public variable). */
  shortLinkOrigin: string;
  /** The clock every row's window badge is judged against; one value per list change. */
  now: Date;
  /** `member`+ (D-2-12): a viewer gets the list and no row action. */
  canManage: boolean;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
  /** The outcome of a copy, for the screen's one live region. */
  onCopied: (copied: boolean) => void;
}

export function LinkList({
  items,
  workspaceId,
  shortLinkOrigin,
  now,
  canManage,
  hasMore,
  loadingMore,
  onLoadMore,
  onCopied,
}: LinkListProps): ReactElement {
  const idBase = useId();
  const headingId = `${idBase}-heading`;

  return (
    <section className="links-list" aria-labelledby={headingId}>
      <h2 id={headingId}>{LINK_LIST_MESSAGES.heading}</h2>
      <ul className="link-rows" aria-labelledby={headingId}>
        {items.map((link) => (
          <LinkRowItem
            key={link.id}
            link={link}
            workspaceId={workspaceId}
            shortLinkOrigin={shortLinkOrigin}
            now={now}
            canManage={canManage}
            onCopied={onCopied}
          />
        ))}
      </ul>
      {hasMore ? (
        <p className="links-more">
          <button
            type="button"
            className="secondary"
            aria-disabled={loadingMore}
            onClick={() => {
              onLoadMore();
            }}
          >
            {loadingMore ? LINK_LIST_MESSAGES.loadingMore : LINK_LIST_MESSAGES.loadMore}
          </button>
        </p>
      ) : null}
    </section>
  );
}

interface LinkRowItemProps {
  link: LinkRow;
  workspaceId: string;
  shortLinkOrigin: string;
  now: Date;
  canManage: boolean;
  onCopied: (copied: boolean) => void;
}

function LinkRowItem({ link, workspaceId, shortLinkOrigin, now, canManage, onCopied }: LinkRowItemProps): ReactElement {
  const state = linkWindowState(link, now);
  const url = composeShortUrl(link.slug, shortLinkOrigin);

  async function handleCopy(): Promise<void> {
    onCopied(url === null ? false : await copyText(url));
  }

  return (
    <li className="link-row" data-link-id={link.id}>
      <div className="link-row-main">
        <span className="link-slug">{link.slug}</span>
        <span className="link-state" data-state={state}>
          {LINK_SCREEN_MESSAGES.windowStates[state]}
        </span>
      </div>

      <p className="link-short-url">
        {/* Selectable text, in full. The button is the convenience, not the source. */}
        <code>{url ?? link.slug}</code>
        {url === null ? null : (
          <button
            type="button"
            className="secondary"
            onClick={() => {
              void handleCopy();
            }}
          >
            {LINK_LIST_MESSAGES.copy} <span className="visually-hidden">{LINK_LIST_MESSAGES.shortUrlLabel} {link.slug}</span>
          </button>
        )}
      </p>

      <p className="link-destination" title={link.destinationUrl}>
        <span className="visually-hidden">{LINK_LIST_MESSAGES.destinationLabel}: </span>
        {link.destinationUrl}
      </p>

      <p className="link-times">
        Created <time dateTime={link.createdAt} suppressHydrationWarning>{formatInstant(link.createdAt)}</time>
        {link.activatesAt === null ? null : (
          <>
            {' · '}Activates <time dateTime={link.activatesAt} suppressHydrationWarning>{formatInstant(link.activatesAt)}</time>
          </>
        )}
        {link.expiresAt === null ? null : (
          <>
            {' · '}Expires <time dateTime={link.expiresAt} suppressHydrationWarning>{formatInstant(link.expiresAt)}</time>
          </>
        )}
      </p>

      {canManage ? (
        <div className="link-row-actions">
          <Link className="workspace-row-link" href={LINK_ROUTE(workspaceId, link.id)}>
            {LINK_LIST_MESSAGES.edit} <span className="visually-hidden">{link.slug}</span>
          </Link>
        </div>
      ) : null}
    </li>
  );
}

/**
 * `${origin}/${slug}`, or `null` when it cannot be composed. `shortUrl` throws rather than
 * building a wrong URL (a blank slug or a blank origin), and a throw during render would
 * take the whole list down over one row; the row shows its slug and no copy control
 * instead. Neither input can be blank in practice: the origin is validated on the server
 * and `SLUG_PATTERN` admits no empty slug, which is why this is a guard and not a branch
 * anyone is expected to see.
 */
export function composeShortUrl(slug: string, origin: string): string | null {
  try {
    return shortUrl(slug, origin);
  } catch {
    return null;
  }
}

/** `true` when the clipboard took it. Absent (insecure origin) or refused is `false`. */
async function copyText(text: string): Promise<boolean> {
  const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;

  if (clipboard === undefined) {
    return false;
  }

  try {
    await clipboard.writeText(text);

    return true;
  } catch {
    return false;
  }
}
