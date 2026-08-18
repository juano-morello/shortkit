/**
 * Contract: docs/contracts/mail-sender.md (invariant 4)
 * Produced by: TASK-1b-02
 *
 * The two helpers every template shares. Separate from `render-mail.ts` so a template
 * imports helpers and the renderer imports templates, and nothing imports in a circle.
 */

/**
 * The five characters that change meaning inside HTML text and attribute values. Applied to
 * every interpolated value in the HTML part: `tenantName`, `inviterEmail` and workspace
 * names are strings other tenants' users typed. The URL goes through it too, because one
 * rule for every value is easier to keep than a rule with one carve-out. For the URLs this
 * system builds (an origin plus a base64url fragment) the escape is the identity, which
 * `templates.spec.ts` asserts as "verbatim in both parts".
 */
export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/**
 * `25 August 2026 at 15:04 UTC`. Fixed locale and fixed zone, so the same `Date` renders the
 * same bytes on every machine and the recipient can tell which clock the deadline is on.
 */
export function formatExpiry(expiresAt: Date): string {
  const formatted = new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone: 'UTC',
  }).format(expiresAt);

  return `${formatted} UTC`;
}
