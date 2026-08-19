/**
 * TASK-2-14 (STORY-2-10; AC-2-48, AC-2-50). The rendering rules the three link surfaces
 * share: who is offered a form, where a session that expired mid-use is sent, and the two
 * conversions between the wire's UTC instants and the `datetime-local` inputs an operator
 * types into.
 *
 * Contract: docs/contracts/workspace-authorization.md ("Minimum role per surface":
 *   `GET /api/links` viewer, `POST`/`PATCH`/`DELETE` member), docs/contracts/slug.md.
 * ADR: adr-0009 (one shared window rule, `isLinkActive`, reached through
 *   `linkWindowState`; nothing here re-decides whether a link serves).
 * Decision: D-2-12 (the role minimums), D-2-18 (the screens, and "timestamps
 *   entered/shown in the operator's local timezone with the zone stated").
 * Consumes: TASK-2-13's `LINKS_ROUTE` / `LINK_ROUTE`; `auth/routes.ts`.
 *
 * ============================================================================
 * THE ROLE GATE IS RANK DATA, NOT A COMPARISON OF ROLE NAMES.
 * ============================================================================
 *
 * `roles.ts` says "Rank is data, in one table. No conditional anywhere else compares role
 * names", so `canManageLinks` goes through `meetsWorkspaceRole` rather than testing for
 * `'viewer'`. A row whose `workspaceRole` the API did not send (the field is optional on
 * `workspaceContract` until the API stops sending workspaces without it) is treated as
 * "cannot manage": the screen offers nothing rather than offering what may be refused.
 *
 * HIDING IS NOT ENFORCEMENT. The API is (it answers 403 to a viewer's write). This only
 * keeps the screen from offering a control whose only outcome would be a refusal.
 *
 * ============================================================================
 * THE `datetime-local` PAIR: LOCAL IN THE FIELD, UTC ON THE WIRE.
 * ============================================================================
 *
 * `linkTimestampContract` is `z.string().datetime()`, a UTC instant ending in `Z`, and a
 * `datetime-local` input holds `YYYY-MM-DDTHH:mm` with no zone at all, which ECMAScript
 * parses as the READER'S LOCAL time. So the two conversions here are the whole timezone
 * story: `toLocalInputValue` renders an instant in the operator's zone, `fromLocalInput`
 * reads their entry back as an instant. The zone itself is stated beside the fields
 * (`timeZoneNote`) because an unlabelled local-time field is the one an operator gets
 * wrong by an hour and never notices.
 *
 * A BLANK FIELD IS `null`, NOT "LEAVE IT ALONE": clearing an expiry is how an operator
 * removes it, and `createLinkBaseContract` declares both bounds nullable for exactly that
 * (`null` clears, absent leaves alone). The form always sends both keys, so a cleared
 * field always clears.
 */
import { WORKSPACE_ROLE, asWorkspaceRole, meetsWorkspaceRole } from '@shortkit/contracts';
import type { WorkspaceRoleValue } from '@shortkit/contracts';

import { RETURN_TO_PARAM, SIGN_IN_ROUTE } from '../auth/routes';

/**
 * May this caller create, edit or delete links in this workspace? `WORKSPACE_ROLE.member`
 * is the minimum on all three (D-2-12); a viewer, and a workspace whose role did not
 * arrive, get the list and nothing else.
 */
export function canManageLinks(workspaceRole: WorkspaceRoleValue | undefined): boolean {
  if (workspaceRole === undefined) {
    return false;
  }

  return meetsWorkspaceRole(asWorkspaceRole(workspaceRole), WORKSPACE_ROLE.member);
}

/**
 * Where a session that expired mid-use is sent: sign in, then straight back to the page
 * that lost it. The sign-in page vets `returnTo` (same-origin relative only) before
 * following it, and every path handed here is built by `LINKS_ROUTE` / `LINK_ROUTE`, which
 * percent-encode the ids.
 */
export function signInAfterExpiryUrl(path: string): string {
  const query = new URLSearchParams({ [RETURN_TO_PARAM]: path });

  return `${SIGN_IN_ROUTE}?${query.toString()}`;
}

/**
 * The operator's IANA zone, or `null` when the runtime will not name one. Read at render
 * rather than kept in state: it is environment configuration, not a clock, so it does not
 * go stale and reading it is pure.
 *
 * It DOES differ between the server render and the browser's (the Next server's zone is
 * the container's), which is why every element that shows a local time carries
 * `suppressHydrationWarning`. React re-renders those subtrees on the client, so what the
 * operator ends up looking at is their own zone; the attribute only keeps a known,
 * accepted difference from being reported as a defect. The same difference is already
 * accepted for the invitation list's `Intl.DateTimeFormat(undefined, …)` renderings.
 */
export function resolvedTimeZone(): string | null {
  try {
    const { timeZone } = new Intl.DateTimeFormat().resolvedOptions();

    return timeZone === '' ? null : timeZone;
  } catch {
    return null;
  }
}

/** The sentence beside the two datetime fields. Names the zone when the runtime names one. */
export function timeZoneNote(timeZone: string | null): string {
  return timeZone === null
    ? 'Times are entered and shown in the local timezone of this device.'
    : `Times are entered and shown in your local timezone (${timeZone}).`;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/**
 * A wire instant -> the `YYYY-MM-DDTHH:mm` a `datetime-local` input holds, in the reader's
 * zone. `null`, and an instant that cannot be read, render as an empty field: there is no
 * honest local rendering of an unparseable bound, and an empty field says "no bound",
 * which is what the operator would be setting if they saved without touching it.
 */
export function toLocalInputValue(instant: string | null): string {
  if (instant === null) {
    return '';
  }

  const date = new Date(instant);

  if (Number.isNaN(date.getTime())) {
    return '';
  }

  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** What an operator's entry in a `datetime-local` field means on the wire. */
export type LocalInstant = { ok: true; instant: string | null } | { ok: false };

/**
 * The `datetime-local` field -> a UTC ISO instant, `null` for a cleared field, or a
 * refusal for text that is not a date and time at all (a browser that renders the field as
 * plain text, or a value pasted into it).
 */
export function fromLocalInput(value: string): LocalInstant {
  const trimmed = value.trim();

  if (trimmed === '') {
    return { ok: true, instant: null };
  }

  const parsed = new Date(trimmed);

  if (Number.isNaN(parsed.getTime())) {
    return { ok: false };
  }

  return { ok: true, instant: parsed.toISOString() };
}

/** An instant, in the reader's locale and zone; the raw value when it cannot be read. */
export function formatInstant(instant: string): string {
  const date = new Date(instant);

  if (Number.isNaN(date.getTime())) {
    return instant;
  }

  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

/**
 * The copy the two link screens share. Per-code sentences are `LINK_MESSAGES`
 * (TASK-2-13's, the one home for a failure's wording); nothing here echoes a server string.
 */
export const LINK_SCREEN_MESSAGES = {
  backToWorkspaces: 'Back to workspaces',
  backToLinks: 'Back to links',
  empty: 'No links yet. Create one below and it appears here.',
  emptyForViewer: 'No links yet.',
  archived: 'This workspace is archived, so no new links can be created in it. Its existing links are listed below and keep redirecting.',
  readOnly: 'Your role in this workspace lets you see links but not change them.',
  created: (slug: string): string => `Link ${slug} created.`,
  updated: (slug: string): string => `Link ${slug} saved.`,
  deleted: (slug: string): string => `Link ${slug} deleted.`,
  copied: 'Short link copied to the clipboard.',
  copyFailed: 'Could not copy. Select the short link and copy it.',
  loadedMore: 'More links loaded.',
  reloaded: 'List reloaded.',
  refreshFailed: 'The change was saved, but the list could not be refreshed. Reload the list to see it.',
  gone: 'That link no longer exists. The list has been refreshed.',
  windowStates: {
    active: 'Active',
    scheduled: 'Scheduled',
    expired: 'Expired',
  },
} as const;
