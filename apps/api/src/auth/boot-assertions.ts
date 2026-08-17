/**
 * Contract: `docs/contracts/auth-config-surface.md`
 * ADR: adr-0058-better-auth-secret-assertion-shape.md, adr-0059, adr-0051, adr-0050
 * Produced by: TASK-003 (this file and the three bindings). Extended by: TASK-004, wave 3.
 *
 * ============================================================================
 * THIS FILE MUST NOT IMPORT `auth.config.ts`. THE DEPENDENCY RUNS THE OTHER WAY.
 * ============================================================================
 *
 * `auth.config.ts` evaluates `betterAuth({ secret: betterAuthSecret(), baseURL:
 * betterAuthUrl(), ... })` at module scope. If this file imported it, `main.ts`'s import of
 * the assertions would evaluate the whole auth config first, an accessor would throw during
 * module evaluation, and the throw would land before `bootstrap()` runs and before any
 * boot-precondition wording reaches the log (ADR-0058).
 *
 * TASK-004 adds `assertTrustedClientIpHeaderConfigured`, `assertBffProxySecretConfigured`
 * and `assertAuthRoleSeparation` here in wave 3. None of them may import `auth.config.ts`
 * either, and `assertAuthRoleSeparation` reaches its pool through `db/client.ts`.
 *
 * NONE OF THESE READS `NODE_ENV`. That is GC-B, and it is the rule better-auth's own
 * `validateSecret` and its cookie-secure fallback both break inside `node_modules`, where
 * this repository's lint cannot reach them (ADR-0051, ADR-0059).
 *
 * THE ACCESSORS READ `process.env`; THE ASSERTIONS TAKE ONE. Both go through the same
 * `accepted*` predicate below, which is what keeps them from disagreeing (ADR-0051): an
 * accessor that trusted a boot assertion would be unsafe in a unit test, a script, or a
 * worker that never ran one.
 */

/**
 * `better-auth@1.6.26`'s published fallback, `dist/utils/constants.mjs:2`, reached by the
 * `||` chain at `dist/context/create-context.mjs:70` and `:78` when nothing is configured.
 * Thirty-nine characters, so it clears the length floor. Rejected by exact value.
 */
export const BETTER_AUTH_PUBLISHED_DEFAULT_SECRET = 'better-auth-secret-12345678901234567890';

/** ADR-0051 promotes better-auth's `length < 32` warning to a refusal. */
export const BETTER_AUTH_SECRET_MIN_LENGTH = 32;

/** The session credential's lifetime. Stated rather than inherited (ADR-0059). */
export const SESSION_LIFETIME_SECONDS = 604_800;

/**
 * Raised by EVERY accessor and assertion in this file.
 *
 * One class across three bindings so `main.ts` reports the same `boot_precondition`
 * whichever path fired. From wave 3 the accessors win the race: `main.ts` imports
 * `auth.config.ts` for the mount, so a module-scope accessor throws before
 * `assertBootPreconditions()` is called and the assertion never executes (ADR-0058).
 *
 * NEVER CARRIES A VALUE, A PREFIX OF ONE, OR A LENGTH. It names the rule that was broken.
 * The secret is not in `LOGGABLE_FIELDS` and no field name is added for it, unlike
 * ADR-0045's user-id prefix where the value is not a credential.
 */
export class AuthBindingError extends Error {
  readonly binding: 'better_auth_secret' | 'better_auth_url' | 'web_app_origins';

  constructor(binding: AuthBindingError['binding'], message: string) {
    super(message);
    this.name = 'AuthBindingError';
    this.binding = binding;
  }
}

/**
 * ============================================================================
 * BETTER_AUTH_SECRET. THREE REJECTIONS, AND NONE OF THEM QUOTES THE VALUE.
 * ============================================================================
 *
 * Not four (ADR-0058). F-074 added a fourth for the compose default TASK-018 introduced;
 * F-144 then removed that literal, `docker-compose.yml` is `${BETTER_AUTH_SECRET:?...}` with
 * no fallback, and a rejection needs a value that exists.
 *
 * The disqualifying property of the third is PUBLICATION, not length or shape: it is
 * thirty-nine characters and clears the floor. A locally generated string of the same shape
 * is fine.
 */
const SECRET_UNSET =
  'BETTER_AUTH_SECRET is not set. It signs every JWT this API mints, and better-auth ' +
  'falls back to a constant published on npm when it is absent — one jwks row plus that ' +
  'constant forges any tid claim in the product. Generate at least ' +
  `${String(BETTER_AUTH_SECRET_MIN_LENGTH)} characters and export it. ` +
  'See .env.example at the repository root, which carries the generation command, and ' +
  'ADR-0051.';

const SECRET_TOO_SHORT =
  'BETTER_AUTH_SECRET is shorter than the ' +
  `${String(BETTER_AUTH_SECRET_MIN_LENGTH)} characters ADR-0051 requires. This refusal ` +
  'names the rule and never the value. Thirty-two random bytes from node:crypto, ' +
  'base64url-encoded, is the shape this repository\'s own tooling uses; .env.example at ' +
  'the repository root carries the command that generates one.';

const SECRET_IS_THE_PUBLISHED_DEFAULT =
  'BETTER_AUTH_SECRET is better-auth\'s own published fallback constant, which anyone who ' +
  'installs the package can read. What disqualifies it is publication rather than its ' +
  'length or its shape. Generate your own value and export it. See ADR-0051.';

/**
 * ============================================================================
 * BETTER_AUTH_URL. IT DECIDES THE ISSUER AND THE COOKIE'S `Secure` FLAG.
 * ============================================================================
 *
 * `create-context.mjs:85` sets `options.baseURL` to `''` when this does not resolve, and
 * `auth/base.mjs:19-27` then re-derives a base URL per request from the request itself.
 * `sign.mjs:16-20` computes `defaultIss` and `defaultAud` from that. Measured: the same
 * session cookie with `Host: evil.test` minted a valid token carrying
 * `iss="http://evil.test"`. It also decides the session cookie's `Secure` flag, which
 * otherwise falls back to `NODE_ENV === 'production'` (`cookies/index.mjs:21`). ADR-0059.
 */
const URL_UNSET =
  'BETTER_AUTH_URL is not set. It is the origin this API issues and verifies tokens for, ' +
  'and it decides whether the session cookie is Secure. Unset, better-auth derives both ' +
  'from the incoming request\'s Host header. Export ' +
  'BETTER_AUTH_URL=http://localhost:3001 for local development. See ' +
  'apps/api/.env.example and ADR-0059.';

const URL_UNPARSEABLE =
  'BETTER_AUTH_URL is not an absolute origin. Write the scheme, the host and the port and ' +
  'nothing else, as in http://localhost:3001. See ADR-0059.';

const URL_WRONG_SCHEME =
  'BETTER_AUTH_URL carries a scheme other than http: or https:. The scheme decides ' +
  'whether the session cookie is Secure, and no other scheme gives that a meaning. ' +
  'See ADR-0059.';

const URL_CARRIES_A_PATH =
  'BETTER_AUTH_URL carries a path, a query or a fragment. new URL(value).origin drops ' +
  'them silently, so the value in force would not be the value that was written. Give the ' +
  'bare origin. See ADR-0059.';

/**
 * ============================================================================
 * AND THE RULE ABOUT THE HOST: `http:` IS LOOPBACK-ONLY.
 * ============================================================================
 *
 * Without it this binding permits the state it exists to close. Measured:
 * `BETTER_AUTH_URL=http://api.example.com` yields `better-auth.session_token` with
 * `secure: false` and no `__Secure-` prefix, WITH EVERY ASSERTION GREEN, because a value is
 * set. `advanced.useSecureCookies` is derived from this one string, so nothing else catches
 * it. The compose default is `http://localhost:3001`, and an operator who copies it to a
 * real host keeps the scheme; this rule is what turns that copy into a boot refusal.
 *
 * IT READS NO `NODE_ENV`. The discriminator is the host in the declared value. GC-B holds.
 *
 * It is a STRING test, not a resolution test: a hostname resolving to 127.0.0.1 is refused
 * under `http:`, and so is a TLS-terminating proxy speaking http to a non-loopback backend.
 * The correct value there is the PUBLIC `https:` origin, because that is what the browser
 * sees and what `iss`, `aud` and the cookie's `Secure` flag must describe.
 */
const URL_HTTP_ON_A_PUBLIC_HOST =
  'BETTER_AUTH_URL is http: on a non-loopback host. http: is permitted only for ' +
  'localhost, 127.0.0.0/8 or [::1], because this value decides whether the session cookie ' +
  'carries Secure, and a non-Secure session cookie is the credential in cleartext. Use ' +
  'the https: origin the browser sees, even when TLS terminates at a proxy. See ADR-0059.';

/** `127.0.0.0/8`, as the URL parser renders it: four decimal labels, the first `127`. */
const LOOPBACK_IPV4 = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

/** What `new URL('http://[::1]:3001').hostname` returns, brackets included. */
const LOOPBACK_IPV6 = '[::1]';

/**
 * The two wildcard metacharacters `trusted-origins.mjs:18` enters wildcard mode on. BOTH:
 * `?` matches a single character, so `https://app.example.co?` trusts
 * `https://app.example.com` — measured.
 */
const WILDCARD_METACHARACTERS = /[*?]/;

/**
 * The shape a wildcard entry has to have before its host labels are worth checking (F-203).
 * An `http:`/`https:` scheme, host characters plus the two metacharacters, an optional
 * numeric port, and nothing after it.
 *
 * CASE-INSENSITIVE, AND THE CASE RULE IS SEPARATE (F-214). One regex covering both meant a
 * refusal that printed four structural clauses at an entry which satisfied all four and
 * broke only the unprinted fifth.
 */
const WILDCARD_ORIGIN_SHAPE = /^https?:\/\/[a-z0-9*?._-]+(?::\d+)?$/i;

/** Rule 2's window: the registrable domain, approximated as the final two labels. */
const REGISTRABLE_LABEL_COUNT = 2;

export function betterAuthSecret(): string {
  return acceptedSecret(process.env.BETTER_AUTH_SECRET);
}

/**
 * The declared BETTER_AUTH_URL binding: the origin this API issues and verifies tokens for.
 *
 * Returns `new URL(value).origin`, so a trailing slash is normalised rather than refused —
 * `iss`, `aud` and every trusted-origin comparison are string equalities against this
 * value, and an unnormalised `http://localhost:3001/` would make the API's own origin fail
 * its own origin check.
 */
export function betterAuthUrl(): string {
  return acceptedUrl(process.env.BETTER_AUTH_URL);
}

/**
 * The declared WEB_APP_ORIGINS binding: every origin the dashboard is served from.
 *
 * Comma-separated. Entries are trimmed and empty ones dropped. RETURNS `[]` WHEN THE
 * VARIABLE IS UNSET, WHICH IS LEGAL: the resolved trusted list always contains the API's
 * own origin (`context/helpers.mjs:61-70`), which is what lets the integration tier pass
 * with the variable unset. An unset value costs a local developer a `403 INVALID_ORIGIN` on
 * the login screen and costs the suite nothing.
 */
export function webAppOrigins(): readonly string[] {
  return acceptedOrigins(process.env.WEB_APP_ORIGINS);
}

/**
 * The boot half of the secret rule. Same three rejections, same predicate, same error class.
 *
 * Needs no database, so it carries none of precondition 2's machinery: no retry budget, no
 * backoff, no verdict prefix (ADR-0058). A `process.env` read always answers, so the
 * distinction between "could not answer" and "answered unsafely" that `RLS_VERDICT_PREFIX`
 * exists to draw has nothing to separate here.
 */
export function assertBetterAuthSecretConfigured(env: NodeJS.ProcessEnv): void {
  acceptedSecret(env.BETTER_AUTH_SECRET);
}

/** The boot half of the URL rule. Same predicate as `betterAuthUrl()` (ADR-0059). */
export function assertBetterAuthUrlConfigured(env: NodeJS.ProcessEnv): void {
  acceptedUrl(env.BETTER_AUTH_URL);
}

/**
 * The boot half of the origins rule. Same predicate as `webAppOrigins()` (ADR-0059).
 *
 * A boot assertion and not only a unit test: the unit test proves the composed config is
 * right in CI, and the wildcard that clears a developer's 403 is written in a shell or an
 * env file that no test reads.
 */
export function assertWebAppOriginsConfigured(env: NodeJS.ProcessEnv): void {
  acceptedOrigins(env.WEB_APP_ORIGINS);
}

/**
 * THROWS on unset, on empty, under the floor, and on the published constant. Never returns
 * `undefined` and never returns `''`: `options.secret` is the FIRST OPERAND OF A `||` CHAIN,
 * not an override (`create-context.mjs:70`), so a falsy return falls straight through to
 * `env.BETTER_AUTH_SECRET`, then `env.AUTH_SECRET`, then the published constant — which is
 * the symmetric key for `jwks.privateKey`.
 */
function acceptedSecret(value: string | undefined): string {
  if (value === undefined || value.trim() === '') {
    throw new AuthBindingError('better_auth_secret', SECRET_UNSET);
  }

  if (value.length < BETTER_AUTH_SECRET_MIN_LENGTH) {
    throw new AuthBindingError('better_auth_secret', SECRET_TOO_SHORT);
  }

  if (value === BETTER_AUTH_PUBLISHED_DEFAULT_SECRET) {
    throw new AuthBindingError('better_auth_secret', SECRET_IS_THE_PUBLISHED_DEFAULT);
  }

  return value;
}

function acceptedUrl(value: string | undefined): string {
  if (value === undefined || value.trim() === '') {
    throw new AuthBindingError('better_auth_url', URL_UNSET);
  }

  const parsed = parseUrl(value.trim());

  if (parsed === undefined) {
    throw new AuthBindingError('better_auth_url', URL_UNPARSEABLE);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new AuthBindingError('better_auth_url', URL_WRONG_SCHEME);
  }

  if (parsed.pathname !== '/' || parsed.search !== '' || parsed.hash !== '') {
    throw new AuthBindingError('better_auth_url', URL_CARRIES_A_PATH);
  }

  if (parsed.protocol === 'http:' && !isLoopbackHost(parsed.hostname)) {
    throw new AuthBindingError('better_auth_url', URL_HTTP_ON_A_PUBLIC_HOST);
  }

  return parsed.origin;
}

function acceptedOrigins(value: string | undefined): readonly string[] {
  if (value === undefined || value.trim() === '') {
    return [];
  }

  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
    .map((entry) => acceptedOrigin(entry));
}

/**
 * One entry of `WEB_APP_ORIGINS`.
 *
 * A wildcard entry cannot be parsed as a URL — `matchesOriginPattern`
 * (`trusted-origins.mjs:18-23`) treats a pattern carrying a metacharacter and no `://` as a
 * wildcard over the HOST, so a bare `*` trusts every origin on the internet with no error
 * anywhere — and is returned verbatim once it clears the shape check and both host rules.
 * Everything else is an ordinary origin and is normalised the way `BETTER_AUTH_URL` is.
 *
 * ============================================================================
 * THE WILDCARD BRANCH IS HELD TO THE SAME ORIGIN SHAPE AS THE PLAIN ONE (F-203).
 * ============================================================================
 *
 * It used to check the host labels and nothing else, so every refusal the plain branch
 * applies was skipped for any entry containing a metacharacter. The cost is not symmetry:
 * `matchesOriginPattern` evaluates the pattern against `getOrigin(url)`, WHICH NEVER
 * CARRIES A TRAILING SLASH, so `https://shortkit-*.vercel.app/` — the documented preview
 * form as an address bar writes it — booted green and then matched nothing, and every
 * preview `POST /api/auth/*` answered `403 INVALID_ORIGIN` with the assertion whose job is
 * to catch bad entries having said nothing. The cheapest remedy from that symptom is a
 * broader wildcard, which is the value this whole predicate exists to refuse.
 *
 * Two neighbours closed by the same rule: `https://app.example.com/?next=1`, which the `?`
 * classified as a wildcard and so bypassed the path/query refusal; and a scheme-less
 * `shortkit-*.vercel.app`, which better-auth matches against the HOST alone and therefore
 * trusts over `http:` as well as `https:`.
 */
function acceptedOrigin(entry: string): string {
  if (WILDCARD_METACHARACTERS.test(entry)) {
    assertWildcardOriginShape(entry);
    assertWildcardHostIsBounded(entry);

    return entry;
  }

  const parsed = parseUrl(entry);

  if (
    parsed === undefined ||
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
    parsed.pathname !== '/' ||
    parsed.search !== '' ||
    parsed.hash !== ''
  ) {
    throw new AuthBindingError(
      'web_app_origins',
      `WEB_APP_ORIGINS entry ${JSON.stringify(entry)} is not an absolute http or https ` +
        'origin. Entries are comma-separated origins with no path, query or fragment. ' +
        'See ADR-0059.',
    );
  }

  return parsed.origin;
}

/**
 * ============================================================================
 * TWO RULES, NOT ONE, AND THE SECOND IS AN APPROXIMATION THAT SAYS SO.
 * ============================================================================
 *
 *   1. NO HOST LABEL MAY BE ENTIRELY METACHARACTERS.
 *      Refuses `*`, `https://*`, `https://*.vercel.app`, `https://?.example.com`.
 *   2. NO METACHARACTER IN THE FINAL TWO LABELS, so the registrable domain is literal.
 *      Refuses `https://shortkit-*.app`, `https://app.example.co?`.
 *
 * `https://shortkit-*.vercel.app` passes both and is the preview form `auth-tokens.md:158-162`
 * documents. `https://*.vercel.app` is REFUSED, because that contract rules exactly that
 * entry out by name: "it trusts every application on the platform". Measured: it matches
 * `https://evil.vercel.app`, and end-to-end it let a cross-origin sign-up through with 200.
 *
 * Rule 2 approximates "the registrable domain" and is unsound under a multi-label public
 * suffix: `https://ex*.co.uk` passes and should not. Closing that needs a public-suffix
 * list, which is a dependency and a data file that goes stale, for a case this repository
 * does not have. Stated rather than closed (ADR-0059).
 */
function assertWildcardHostIsBounded(entry: string): void {
  const labels = wildcardHost(entry).split('.');

  if (labels.some(isEntirelyWildcard)) {
    throw new AuthBindingError(
      'web_app_origins',
      `WEB_APP_ORIGINS entry ${JSON.stringify(entry)} has a host label that is entirely ` +
        'wildcard, so it trusts every host at that position — https://*.vercel.app trusts ' +
        'every application on the platform. Put the wildcard inside a label, as in ' +
        'https://shortkit-*.vercel.app. See ADR-0059.',
    );
  }

  if (labels.slice(-REGISTRABLE_LABEL_COUNT).some((label) => WILDCARD_METACHARACTERS.test(label))) {
    throw new AuthBindingError(
      'web_app_origins',
      `WEB_APP_ORIGINS entry ${JSON.stringify(entry)} carries a wildcard in one of the ` +
        'final two labels, so it widens the registrable domain rather than the subdomain. ' +
        'The metacharacters are * and ?, and ? matches one character. See ADR-0059.',
    );
  }
}

/**
 * A wildcard entry is an ORIGIN with a wildcard inside its host, and nothing else: an
 * `http:`/`https:` scheme, a host of host characters and metacharacters, an optional
 * numeric port, and no userinfo, path, query, fragment or trailing slash. It must also be
 * lower case.
 *
 * ============================================================================
 * TWO RULES AND TWO MESSAGES, BECAUSE A REFUSAL HAS TO NAME THE RULE IT BROKE (F-214).
 * ============================================================================
 *
 * The structural check is case-INSENSITIVE and the case check is its own. One combined
 * rule refused `https://Shortkit-*.vercel.app` with a message listing a scheme, a host, a
 * port and the absence of a path — every one of which that entry satisfies — while saying
 * nothing about the only clause it broke. An operator reads four satisfied rules and
 * concludes the assertion is broken, and the cheapest way past an assertion you believe is
 * broken is a wildcard broad enough to stop failing, which is the pressure F-181 and F-203
 * both exist to keep off this value.
 *
 * Lower case is required rather than normalised, because `matchesOriginPattern` compares
 * the pattern against `getOrigin(url)`, which is lower-cased — an upper-case pattern is an
 * entry that can never match, which is the failure this whole check exists to turn into a
 * refusal. Silently rewriting an operator's entry is the other option and is worse: the
 * value in force would not be the value they wrote.
 */
function assertWildcardOriginShape(entry: string): void {
  if (!WILDCARD_ORIGIN_SHAPE.test(entry)) {
    throw new AuthBindingError(
      'web_app_origins',
      `WEB_APP_ORIGINS entry ${JSON.stringify(entry)} is not an absolute origin with a ` +
        'wildcard inside its host. Write an http:// or https:// scheme, a host, and at ' +
        'most a numeric port — no path, query, fragment or trailing slash, because ' +
        'better-auth matches the pattern against an origin that never carries one, so such ' +
        'an entry boots green and then matches nothing. As in ' +
        'https://shortkit-*.vercel.app. See ADR-0059.',
    );
  }

  if (entry !== entry.toLowerCase()) {
    throw new AuthBindingError(
      'web_app_origins',
      `WEB_APP_ORIGINS entry ${JSON.stringify(entry)} is not lower case. Everything else ` +
        'about it is accepted; write it as ' +
        `${JSON.stringify(entry.toLowerCase())}. better-auth matches a wildcard pattern ` +
        'against the origin as the browser sends it, which is lower-cased, so an entry ' +
        'with a capital in it can never match anything and would boot green and then be ' +
        'silently inert. It is refused rather than lower-cased for you, so the value in ' +
        'force is the value you wrote. See ADR-0059.',
    );
  }
}

/** A label made of nothing but `*` and `?`. `''` is not one: it is a stray dot. */
function isEntirelyWildcard(label: string): boolean {
  return label !== '' && label.replace(/[*?]/g, '') === '';
}

/**
 * The host part of a wildcard entry, which no URL parser will take.
 *
 * Only ever called after `assertWildcardOriginShape`, so the scheme is present and there is
 * no path to cut at — everything after `://` and before an optional `:port` is the host.
 */
function wildcardHost(entry: string): string {
  const afterScheme = entry.slice(entry.indexOf('://') + '://'.length);

  return afterScheme.split(':')[0];
}

function parseUrl(value: string): URL | undefined {
  return URL.canParse(value) ? new URL(value) : undefined;
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === LOOPBACK_IPV6 || LOOPBACK_IPV4.test(hostname);
}
