/**
 * The app's own origin and scheme, resolved ONE way for every writer of a session cookie
 * and for the BFF's CSRF check (TASK-007; review round 1, security MINOR). Before this file
 * `session.ts` and the proxy route each derived them separately and disagreed on the
 * header-absent case.
 *
 * ============================================================================
 * THE TRUST ASSUMPTION ON `x-forwarded-proto` / `x-forwarded-host`, STATED.
 * ============================================================================
 *
 * Next's own server populates both when they are absent, from the connection
 * (`node_modules/next/dist/server/base-server.js`, `req.headers['x-forwarded-proto'] ??=`
 * from `socket.encrypted`, `x-forwarded-host ??= host`), so in the Node runtime a route
 * handler ALWAYS sees them; and when they arrive already set they were set by the hop in
 * front — on Vercel, the platform edge, which overwrites inbound forwarding headers on
 * non-Enterprise plans (the same property `web-api-client.md` relies on for
 * `x-vercel-forwarded-for`). This is ADR-0040's declared-binding rule applied one hop
 * later: the value is trusted because the deployment's own infrastructure sets it, not
 * because of its name.
 *
 * What a caller cannot do with it: a cross-origin page cannot make the victim's browser
 * send a custom `x-forwarded-host` — that is a CORS-preflighted header, the route exports
 * no `OPTIONS`, so the preflight answers 405 and the request never reaches the handler; a
 * same-origin script has no need to spoof its own origin. `request.url` in a route handler
 * is itself derived from the same `Host`, so the URL fallback carries the same trust and no
 * more.
 *
 * `Secure` is derived from the SCHEME resolved here and NEVER from `NODE_ENV` — the
 * repo-wide rule (`auth.config.ts` `useSecureCookies: baseUrl.startsWith('https://')`,
 * ADR-0059; the F-380 trap, ADR-0040). On `http://localhost` the cookie is still set, just
 * without `Secure`, which is the only way a cookie survives an `http` origin at all.
 */

/** The one shape both `Headers` and Next's `ReadonlyHeaders` share. */
export interface HeaderReader {
  get(name: string): string | null;
}

/** The first hop's value of a comma-joined forwarded header, lower-cased; `null` when absent/blank. */
export function firstForwarded(value: string | null): string | null {
  if (value === null || value.trim() === '') {
    return null;
  }

  return value.split(',')[0].trim().toLowerCase();
}

/**
 * `true` when the app's own origin is `https`: `x-forwarded-proto` first, then the request
 * URL's scheme when a URL is in hand (a route handler), else `false`. The header-absent +
 * `https` URL case therefore sets `Secure`, and `http://localhost` does not.
 */
export function originIsSecureFrom(headers: HeaderReader, requestUrl?: URL): boolean {
  const proto = firstForwarded(headers.get('x-forwarded-proto'));

  if (proto !== null) {
    return proto === 'https';
  }

  return requestUrl?.protocol === 'https:';
}

/**
 * The deployment's own origin, `scheme://host`, from the forwarded pair when both are
 * present, else from the request URL. Used as the CSRF comparand for `Origin`.
 */
export function deploymentOriginFrom(headers: HeaderReader, requestUrl: URL): string {
  const proto = firstForwarded(headers.get('x-forwarded-proto'));
  const host = firstForwarded(headers.get('x-forwarded-host')) ?? headers.get('host');

  if (proto !== null && host !== null && host !== '') {
    return `${proto}://${host}`;
  }

  return requestUrl.origin;
}
