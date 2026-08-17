import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AuthBindingError,
  BETTER_AUTH_PUBLISHED_DEFAULT_SECRET,
  BETTER_AUTH_SECRET_MIN_LENGTH,
  assertBetterAuthSecretConfigured,
  assertBetterAuthUrlConfigured,
  assertWebAppOriginsConfigured,
  betterAuthSecret,
  betterAuthUrl,
  webAppOrigins,
} from './boot-assertions';

/**
 * STORY-001 — TASK-003, wave 2. No AC states these; three ADRs do.
 *
 * Contract: `docs/contracts/auth-config-surface.md` ("The declared bindings",
 * "`BETTER_AUTH_URL`: `http:` is loopback-only", "Wildcard rules for `WEB_APP_ORIGINS`").
 * ADR-0051, ADR-0058, ADR-0059.
 *
 * ============================================================================
 * THE PREDICATE IS TESTED HERE; THE CALL SITE IS ASSERTED SEPARATELY, AT THE BOTTOM.
 * ============================================================================
 *
 * Ruled by Juano, 2026-08-16. No child process is spawned. The alternative — boot the built
 * bundle with a bad environment and assert on the refusal — would put a five-minute
 * integration tier's cost on a predicate that reads `process.env` and returns, and this
 * repository has no spawn helper for a boot that is EXPECTED to fail (`api-server.ts`
 * rejects on one, and its only consumer today always expects success).
 *
 * The cost is stated rather than hidden: nothing below executes the real boot path, so the
 * last test in this file — that `main.ts` calls all three before it listens — is
 * LOAD-BEARING rather than decorative. It is a text scan, and it is one deliberately: the
 * shape `db/context-flag-owners.spec.ts` already runs and the reasoning
 * `isolation-coverage.md:527-532` records apply, and an assertion that resolved the call
 * graph would need to import `main.ts`, which boots the API.
 *
 * ============================================================================
 * THE ACCESSORS READ `process.env`; THE ASSERTIONS TAKE ONE. BOTH ARE TESTED.
 * ============================================================================
 *
 * That duplication is ADR-0051's decision and not an oversight: an accessor that trusted a
 * boot assertion would be unsafe in a unit test, a script, or a worker that never ran one.
 * So the two are separate call paths over one predicate, and a test of only one of them
 * passes while the other disagrees.
 */

/** Below `BETTER_AUTH_SECRET_MIN_LENGTH`, derived from it rather than counted by hand. */
const TOO_SHORT_SECRET = 'a'.repeat(BETTER_AUTH_SECRET_MIN_LENGTH - 1);

/** Exactly at the floor, so the boundary is admitted rather than merely "long enough". */
const AT_THE_FLOOR_SECRET = 'b'.repeat(BETTER_AUTH_SECRET_MIN_LENGTH);

const LOOPBACK_URL = 'http://localhost:3001';

type Outcome =
  | { readonly returned: unknown }
  | { readonly refusedWith: string; readonly binding: unknown };

/**
 * What a call did, as a value that can be compared in a table.
 *
 * A refusal is reported by its class NAME and its `binding`, never by its message: the
 * message is prose an author may improve, and `binding` is what `main.ts` maps onto
 * `boot_precondition` so the log line names which rule fired. A throw that is not an
 * `AuthBindingError` — including the stub's `not implemented` — stringifies instead, so it
 * fails the comparison loudly rather than being counted as a correct refusal.
 */
function outcomeOf(run: () => unknown): Outcome {
  try {
    return { returned: run() };
  } catch (error) {
    return error instanceof AuthBindingError
      ? { refusedWith: error.name, binding: error.binding }
      : { refusedWith: String(error), binding: undefined };
  }
}

const REFUSED_SECRET: Outcome = {
  refusedWith: 'AuthBindingError',
  binding: 'better_auth_secret',
};
const REFUSED_URL: Outcome = { refusedWith: 'AuthBindingError', binding: 'better_auth_url' };
const REFUSED_ORIGINS: Outcome = {
  refusedWith: 'AuthBindingError',
  binding: 'web_app_origins',
};

/** Runs the accessor with `BETTER_AUTH_SECRET` bound to `value`, or unset for `undefined`. */
function secretUnder(value: string | undefined): Outcome {
  vi.stubEnv('BETTER_AUTH_SECRET', value);

  return outcomeOf(() => betterAuthSecret());
}

function urlUnder(value: string | undefined): Outcome {
  vi.stubEnv('BETTER_AUTH_URL', value);

  return outcomeOf(() => betterAuthUrl());
}

function originsUnder(value: string | undefined): Outcome {
  vi.stubEnv('WEB_APP_ORIGINS', value);

  return outcomeOf(() => webAppOrigins());
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('betterAuthSecret', () => {
  it('ADR-0051: returns the declared value when it clears the length floor', () => {
    // It must never return `''` or `undefined`, and the reason is the `||` chain at
    // `create-context.mjs:70`: a falsy return is not an override, it falls straight through
    // to `env.BETTER_AUTH_SECRET`, then `env.AUTH_SECRET`, then the published constant.
    // Asserting the returned value — rather than "it did not throw" — is what catches an
    // implementation that validates and then returns nothing.
    expect(secretUnder(AT_THE_FLOOR_SECRET)).toEqual({ returned: AT_THE_FLOOR_SECRET });
  });

  it('ADR-0058: refuses exactly three values — unset, empty, under the floor, and the published default', () => {
    // THREE REJECTIONS, NOT FOUR (settled 2026-08-15). F-074 added a fourth for the compose
    // default `development-compose-better-auth-secret-not-a-real-value`; F-144 then removed
    // that literal from `docker-compose.yml`, which is now `${BETTER_AUTH_SECRET:?...}` with
    // no fallback, so ADR-0051's conditional fourth rejection has no referent. Grepped
    // twice. A fourth rejection appearing here later needs a value that exists.
    //
    // The published default is 39 characters, so it CLEARS the length floor: length is not
    // what disqualifies it. Publication is. A locally generated string of identical shape is
    // fine, which is why `AT_THE_FLOOR_SECRET` above is admitted.
    const outcomes = [
      secretUnder(undefined),
      secretUnder(''),
      secretUnder(TOO_SHORT_SECRET),
      secretUnder(BETTER_AUTH_PUBLISHED_DEFAULT_SECRET),
    ];

    expect(outcomes).toEqual([REFUSED_SECRET, REFUSED_SECRET, REFUSED_SECRET, REFUSED_SECRET]);
  });

  it('ADR-0058: the refusal carries no part of the value, not even its length', () => {
    // The secret is a credential and is in no `LOGGABLE_FIELDS` entry, and `main.ts` writes
    // this message verbatim with `includeMessage: true` on the boot path. A message quoting
    // a prefix or a length is a disclosure into a log stream, and it is the natural thing to
    // write — ADR-0045's user-id prefix is precedent for the OPPOSITE case, where the value
    // is not a credential.
    // ⚠ `refusedWith` IS IN THE ASSERTION AND IS NOT DECORATION. Without it this test passes
    // against ANY throw whose message happens not to contain the fixture string — including
    // the stub's `not implemented`, and including a `TypeError` from a half-written
    // predicate. Measured on the wave-2 red run, where it was the one test in this file that
    // went green against a module whose every body throws.
    vi.stubEnv('BETTER_AUTH_SECRET', TOO_SHORT_SECRET);

    let refusedWith = 'nothing was thrown';
    let message = '';
    try {
      betterAuthSecret();
    } catch (error) {
      refusedWith = error instanceof AuthBindingError ? error.name : String(error);
      message = error instanceof Error ? error.message : String(error);
    }

    expect({
      refusedWith,
      quotesTheValue: message.includes(TOO_SHORT_SECRET),
      quotesAPrefix: message.includes(TOO_SHORT_SECRET.slice(0, 8)),
      quotesTheLength: message.includes(String(TOO_SHORT_SECRET.length)),
    }).toEqual({
      refusedWith: 'AuthBindingError',
      quotesTheValue: false,
      quotesAPrefix: false,
      quotesTheLength: false,
    });
  });
});

describe('assertBetterAuthSecretConfigured', () => {
  it('ADR-0051: the boot half applies the same three rejections to the env it is handed', () => {
    // The duplication with the accessor is deliberate and this is the test that keeps the
    // two from disagreeing: it runs the SAME table against the other entry point. An
    // implementation whose assertion is stricter or looser than its accessor passes one of
    // these two tests and fails the other.
    const outcomes = [
      outcomeOf(() => assertBetterAuthSecretConfigured({})),
      outcomeOf(() => assertBetterAuthSecretConfigured({ BETTER_AUTH_SECRET: '' })),
      outcomeOf(() =>
        assertBetterAuthSecretConfigured({ BETTER_AUTH_SECRET: TOO_SHORT_SECRET }),
      ),
      outcomeOf(() =>
        assertBetterAuthSecretConfigured({
          BETTER_AUTH_SECRET: BETTER_AUTH_PUBLISHED_DEFAULT_SECRET,
        }),
      ),
      outcomeOf(() =>
        assertBetterAuthSecretConfigured({ BETTER_AUTH_SECRET: AT_THE_FLOOR_SECRET }),
      ),
    ];

    expect(outcomes).toEqual([
      REFUSED_SECRET,
      REFUSED_SECRET,
      REFUSED_SECRET,
      REFUSED_SECRET,
      { returned: undefined },
    ]);
  });
});

describe('betterAuthUrl', () => {
  it('ADR-0059: http is admitted for a loopback host', () => {
    // `localhost`, anything in `127.0.0.0/8`, and `[::1]`. The compose default is
    // `http://localhost:3001` and the integration tier runs on `http://127.0.0.1:<port>`,
    // so all three forms are live values in this repository rather than a spec exercise.
    const outcomes = [
      urlUnder('http://localhost:3001'),
      urlUnder('http://127.0.0.1:3001'),
      urlUnder('http://127.1.2.3'),
      urlUnder('http://[::1]:3001'),
    ];

    expect(outcomes).toEqual([
      { returned: 'http://localhost:3001' },
      { returned: 'http://127.0.0.1:3001' },
      { returned: 'http://127.1.2.3' },
      { returned: 'http://[::1]:3001' },
    ]);
  });

  it('ADR-0059: http is refused for a non-loopback host', () => {
    // ============================================================================
    // THIS IS THE RULE THAT MAKES A COMMITTED DEFAULT SAFE WHEREVER IT IS COPIED.
    // ============================================================================
    //
    // MEASURED during the wave-2 security pass: `BETTER_AUTH_URL=http://api.example.com`
    // issued `better-auth.session_token` with `secure: false` and no `__Secure-` prefix,
    // WITH EVERY ASSERTION GREEN, because a value was set. `advanced.useSecureCookies` is
    // derived from this one string, so nothing downstream can catch a wrong one, and that
    // cookie is a full credential through the `bearer` plugin.
    //
    // An operator who copies the compose default to a real host keeps the scheme. That is
    // the whole failure mode, and it is the one this refusal exists for.
    const outcomes = [
      urlUnder('http://api.example.com'),
      urlUnder('http://192.168.1.10:3001'),
      urlUnder('http://shortkit.internal'),
    ];

    expect(outcomes).toEqual([REFUSED_URL, REFUSED_URL, REFUSED_URL]);
  });

  it('ADR-0059: https is admitted for any host', () => {
    expect(urlUnder('https://api.example.com')).toEqual({ returned: 'https://api.example.com' });
  });

  it('ADR-0059: the refusal names the loopback rule rather than only the variable', () => {
    // The card asks for the refusal to name the rule, and the reason is what an operator
    // does next: "BETTER_AUTH_URL is invalid" sends them to change the HOST, which is the
    // one edit that cannot fix it. The correct value for a TLS-terminating proxy is the
    // public `https:` origin, and the message is the only place that can say so.
    vi.stubEnv('BETTER_AUTH_URL', 'http://api.example.com');

    let message = '';
    try {
      betterAuthUrl();
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message.toLowerCase()).toContain('localhost');
  });

  it('ADR-0059: a value that is not a bare absolute origin is refused', () => {
    // A path, a query or a fragment all make `new URL(value).origin` silently DROP the extra
    // part, so an operator who sets `https://api.example.com/api/auth` gets a base URL that
    // is not what they wrote and no error anywhere. Unset and empty are the two that fall
    // through to better-auth's per-request derivation, and a non-http scheme is refused
    // because `useSecureCookies` has no meaning for one.
    const outcomes = [
      urlUnder(undefined),
      urlUnder(''),
      urlUnder('api.example.com'),
      urlUnder('https://api.example.com/api/auth'),
      urlUnder('https://api.example.com?tenant=1'),
      urlUnder('https://api.example.com#fragment'),
      urlUnder('ftp://api.example.com'),
    ];

    expect(outcomes).toEqual([
      REFUSED_URL,
      REFUSED_URL,
      REFUSED_URL,
      REFUSED_URL,
      REFUSED_URL,
      REFUSED_URL,
      REFUSED_URL,
    ]);
  });

  it('ADR-0059: a trailing slash is normalised rather than refused', () => {
    // `new URL(value).origin` has no trailing slash, and `iss`, `aud` and every
    // trusted-origin comparison are string equalities against this value. An unnormalised
    // `http://localhost:3001/` would make the API's own origin fail its own origin check.
    expect(urlUnder('http://localhost:3001/')).toEqual({ returned: LOOPBACK_URL });
  });
});

describe('assertBetterAuthUrlConfigured', () => {
  it('ADR-0059: the boot half admits loopback http and refuses non-loopback http', () => {
    // `boot-assertions.spec.ts` covers both directions of the loopback rule, on both entry
    // points, for the reason the secret table above gives: two call paths over one predicate.
    const outcomes = [
      outcomeOf(() => assertBetterAuthUrlConfigured({ BETTER_AUTH_URL: LOOPBACK_URL })),
      outcomeOf(() =>
        assertBetterAuthUrlConfigured({ BETTER_AUTH_URL: 'http://api.example.com' }),
      ),
      outcomeOf(() =>
        assertBetterAuthUrlConfigured({ BETTER_AUTH_URL: 'https://api.example.com' }),
      ),
      outcomeOf(() => assertBetterAuthUrlConfigured({})),
    ];

    expect(outcomes).toEqual([
      { returned: undefined },
      REFUSED_URL,
      { returned: undefined },
      REFUSED_URL,
    ]);
  });
});

describe('webAppOrigins', () => {
  it('ADR-0059: an unset variable resolves to the empty list, which is legal', () => {
    // The resolved trusted list always contains the API's own origin
    // (`context/helpers.mjs:61-70`), which is what lets the integration tier pass with this
    // variable unset — `authServerEnv()` does not set it. Refusing an unset value here would
    // make every integration suite fail on a binding none of them needs.
    expect(originsUnder(undefined)).toEqual({ returned: [] });
  });

  it('ADR-0059: entries are trimmed and empty ones dropped', () => {
    // A comma-separated list written by a human has spaces in it and often a trailing comma.
    // An untrimmed entry never matches any origin and fails as a 403 on a login screen, one
    // layer away from anything that names this variable.
    expect(originsUnder(' https://a.example.com , , https://b.example.com ')).toEqual({
      returned: ['https://a.example.com', 'https://b.example.com'],
    });
  });

  it('ADR-0059 rule 1: a host label that is entirely metacharacters is refused', () => {
    // `matchesOriginPattern` (`trusted-origins.mjs:18-23`) treats a pattern containing a
    // metacharacter and no `://` as a wildcard over the HOST, so a bare `*` trusts every
    // origin on the internet with no error anywhere. That value is exactly what someone
    // reaches for when every local login answers 403, which is why this refuses rather than
    // warns.
    //
    // THE METACHARACTERS ARE `*` AND `?`, BOTH. `trusted-origins.mjs:18` enters wildcard
    // mode on either, and `?` matches a single character.
    const outcomes = [
      originsUnder('*'),
      originsUnder('https://*'),
      originsUnder('https://?.example.com'),
    ];

    expect(outcomes).toEqual([REFUSED_ORIGINS, REFUSED_ORIGINS, REFUSED_ORIGINS]);
  });

  it('ADR-0059: `https://*.vercel.app` is refused by name, not only the bare wildcard', () => {
    // Named because frozen `auth-tokens.md:159-162` rules exactly this entry out in exactly
    // these words — "it trusts every application on the platform" — and because measuring it
    // is unambiguous: it matches `https://evil.vercel.app`, and end to end it let a
    // cross-origin sign-up through with 200. Naming the entry the frozen contract names is
    // what stops the rule drifting back to the version that admitted it.
    expect(originsUnder('https://*.vercel.app')).toEqual(REFUSED_ORIGINS);
  });

  it('ADR-0059 rule 2: a metacharacter in either of the final two labels is refused', () => {
    // So the registrable domain is literal. `https://app.example.co?` trusts
    // `https://app.example.com` — measured — which is a different registrable domain that
    // someone else owns.
    const outcomes = [
      originsUnder('https://shortkit-*.app'),
      originsUnder('https://app.example.co?'),
    ];

    expect(outcomes).toEqual([REFUSED_ORIGINS, REFUSED_ORIGINS]);
  });

  it('ADR-0059: the documented Vercel preview form passes both rules', () => {
    // `https://shortkit-*.vercel.app` is the preview form `auth-tokens.md:158-162`
    // documents, and production plus preview needs two entries because a prefix wildcard
    // does not match the bare production host. A rule set that refused this would be one
    // nobody could deploy behind, and the cheapest repair from there is the bare `*`.
    expect(originsUnder('https://shortkit-*.vercel.app')).toEqual({
      returned: ['https://shortkit-*.vercel.app'],
    });
  });
});

describe('assertWebAppOriginsConfigured', () => {
  it('ADR-0059: the boot half refuses the wildcard forms and admits the preview form', () => {
    // A boot assertion and not only a unit test: the unit test proves the composed config is
    // right in CI, and the wildcard that clears a developer's 403 is written in a shell or an
    // env file that no test reads.
    const outcomes = [
      outcomeOf(() => assertWebAppOriginsConfigured({ WEB_APP_ORIGINS: '*' })),
      outcomeOf(() =>
        assertWebAppOriginsConfigured({ WEB_APP_ORIGINS: 'https://*.vercel.app' }),
      ),
      outcomeOf(() =>
        assertWebAppOriginsConfigured({ WEB_APP_ORIGINS: 'https://shortkit-*.vercel.app' }),
      ),
      outcomeOf(() => assertWebAppOriginsConfigured({})),
    ];

    expect(outcomes).toEqual([
      REFUSED_ORIGINS,
      REFUSED_ORIGINS,
      { returned: undefined },
      { returned: undefined },
    ]);
  });
});

describe('the call site in main.ts', () => {
  /**
   * ⚠ A TEXT SCAN, AND THE LOAD-BEARING TEST IN THIS FILE.
   *
   * Nothing above executes the real boot path, so a repository where all three predicates
   * are perfect and none of them is called is green everywhere except here. That state is
   * not hypothetical: `assertRuntimeRoleCannotBypassRls()` shipped in TASK-005 with NO
   * CALLER, and F-116 is the finding that found it — a `DATABASE_URL` pointing at a
   * `BYPASSRLS` role started the API normally for as long as it sat there.
   *
   * It reads `main.ts` rather than importing it, for the reason `context-flag-owners.spec.ts`
   * gives for the same idiom, plus one of its own: importing `main.ts` runs `bootstrap()`.
   */
  const main = readFileSync(fileURLToPath(new URL('../main.ts', import.meta.url)), 'utf8');

  const LISTEN = main.indexOf('.listen(');

  it.each([
    ['assertBetterAuthSecretConfigured'],
    ['assertBetterAuthUrlConfigured'],
    ['assertWebAppOriginsConfigured'],
  ])('ADR-0058: main.ts calls %s before it listens', (assertion) => {
    const called = main.indexOf(`${assertion}(`);

    // Two failures, one assertion, and they are different defects: `-1` is "never wired in",
    // and an index after `.listen(` is "wired in after the process is already serving" —
    // which is a window in which an auth surface answers requests on the published constant.
    expect({ called: called !== -1, beforeListen: called !== -1 && called < LISTEN }).toEqual({
      called: true,
      beforeListen: true,
    });
  });
});
