import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * STORY-001 — TASK-003, wave 2. No AC states this; ADR-0056 does, and F-108 pulled it here.
 *
 * Contract: `design/contracts/auth-config-surface.md` invariant 11 (four scans and their
 * directions; the fifth is F-207's and is not in the contract yet). ADR-0056, which amends
 * ADR-0046. ADR-0050.
 *
 * ============================================================================
 * WHAT IS BEING BOUNDED, AND WHY IT IS WORTH FIVE GREPS.
 * ============================================================================
 *
 * `db/client.ts:259` exports an unconstrained handle on the `shortkit_auth` pool: outside
 * any transaction, with no context flag. Measured as that role against the migrated schema,
 * `relrowsecurity` is FALSE on all five Better Auth tables, so the holder reads plaintext
 * `session.token` and the `account` password hashes, INSERTS a session row for any user id
 * with an attacker-chosen token, rewrites any password hash, and reads `jwks.private_key` —
 * with `process.env.BETTER_AUTH_SECRET` in the same process to decrypt it with. A security
 * auditor did the read half from a bare script. That is account takeover, not disclosure.
 *
 * The handle has to exist for the adapter. What has never been bounded is who may hold it.
 * ADR-0046 wrote the rule and deferred the control to TASK-056, which is in no wave of this
 * initiative; ADR-0056 pulled it into the card that first uses the handle.
 *
 * ============================================================================
 * FIVE SCANS, THREE EQUALITIES AND TWO SUBSETS. THEY ARE NOT OF EQUAL WEIGHT.
 * ============================================================================
 *
 * ADR-0056's table, restated only as far as the direction per scan goes, plus scan 5:
 *
 *   1. `betterAuthDatabase`                    equality   ADR-0046's original rule
 *   2. `DATABASE_AUTH_URL`, the bare mention   SUBSET     tripwire on the file set
 *   3. `process.env.DATABASE_AUTH_URL`, the USE  equality LOAD-BEARING
 *   4. the module specifiers `pg` and `drizzle-orm/node-postgres`   equality   tripwire
 *   5. an import of `auth.config`              SUBSET     the second handle (F-207)
 *
 * Scan 3 is the only thing standing between a convenience commit and the `shortkit_auth`
 * role by way of a NEW pool: `DATABASE_AUTH_URL` is in the API process environment, so any
 * file under `apps/api/src` can write
 * `new pg.Pool({ connectionString: process.env.DATABASE_AUTH_URL })` and hold the role
 * without the string `betterAuthDatabase` appearing anywhere. Scan 4 was once believed to
 * close pool construction and DOES NOT: `drizzle-orm/node-postgres`'s own driver builds the
 * pool when `drizzle()` is handed a string.
 *
 * **Scan 5 closes the second route, which is the EXISTING pool rather than a new one.** The
 * exported `auth` carries the adapter built on `betterAuthDatabase()`, so a module that
 * imports it holds the role with none of scans 1-4's spellings in its own text — measured,
 * with all four green. Do not read five greps as five times the coverage.
 *
 * ============================================================================
 * WHAT THE FIVE STILL DO NOT CATCH, BECAUSE A TABLE OF GREPS READS STRONGER THAN IT IS.
 * ============================================================================
 *
 * ADR-0056's list, and one this spec adds:
 *
 *   - **a runtime-built string, and it defeats FOUR of the five, not two.** ADR-0056 lists
 *     it against the env key alone — `process.env['DATABASE_' + 'AUTH_URL']`, beating 2 and
 *     3 — but scans 4 and 5 match a QUOTED LITERAL in the same way, so
 *     `await import('./auth' + '.config')` and `require(DRIVER)` beat those two for exactly
 *     the same reason (F-217). A gap list complete for one scan reads as complete for all,
 *     which is why this bullet now names all four;
 *   - a DSN read from a file or fetched rather than from the environment;
 *   - a client obtained from a transitive dependency neither specifier names;
 *   - a connection opened from a scan-2-permitted file through a helper;
 *   - anything at all outside `apps/api/src` (ADR-0042's boundary; `test/**` and
 *     `scripts/**` are where the auditor's original bare script lived);
 *   - **a side-effect import, `import './auth.config';`, which scan 5 does not match.**
 *     Measured. It is not a bypass — it binds no name, so it reaches no adapter — but it is
 *     the one spelling of an import this pattern misses, and a later reader should know that
 *     rather than rediscover it.
 *
 * So the `describe` below is still a wider sentence than the five scans measure, and it is
 * left as it stands: scan 5 narrows the gap from "any file that imports the instance" to the
 * list above, and renaming the block would make the residual harder to find, not easier.
 *
 * ============================================================================
 * SCANS 2 AND 5 ARE SUBSETS AND THE OTHER THREE ARE EQUALITIES. THAT ASYMMETRY IS DELIBERATE.
 * ============================================================================
 *
 * Scan 2's permitted set is ahead of the tree ON PURPOSE: `main.ts` and
 * `auth/boot-assertions.ts` are pre-authorised for wave 3, where TASK-004 puts
 * `AUTH_VERDICT_PREFIX = 'DATABASE_AUTH_URL connect'` in the first and a refusal message
 * naming the variable in the second. Neither contains the string today, so an equality would
 * be RED ON THE DAY THIS LANDS — and the cheapest way to green a red equality is to trim the
 * permitted set, which deletes the pre-authorisation and brings the collision back in wave 3
 * with nobody remembering why the entries were there. Subset costs only the removal
 * direction, which cannot reach the auth role and which scan 3's equality catches anyway.
 *
 * ⚠ TWO OF THESE REGEXES GO RED ON FIRST RUN IF THEY ARE WRITTEN THE OBVIOUS WAY (F-191).
 * A bare `/'pg'/` matches the MANDATED `provider: 'pg'` in `auth.config.ts` itself, and a
 * bare `/process\.env\[/` matches `health/build-commit.ts:39` today. Both are anchored below.
 * F-186 was this same failure one round earlier in the design, and its lesson is what a red
 * control costs: the cheapest way to green it is to trim `PERMITTED` to whatever the tree
 * contains, WHICH DELETES THE BOUND THE SCAN EXISTS TO ENFORCE.
 *
 * ============================================================================
 * A TEXT SCAN, UNDER `src/**`, AND BOTH OF THOSE ARE RULINGS.
 * ============================================================================
 *
 * Text and not an AST walk: the idiom is `db/context-flag-owners.spec.ts`'s, an AST rewrite
 * of it has been ruled against twice, and the reasoning carries — a commented-out call is one
 * uncomment away from being real, and the permitted files carry the identifier in their own
 * header comments and match harmlessly because they are the permitted ones.
 *
 * `apps/api/src` and not `apps/api`: ADR-0042 fixed what "the API source tree" means, so
 * `test/**` and `scripts/**` are outside it and a fixture holding the handle is invisible
 * here. That residual is ADR-0056's accepted cost and is named in its follow-ups.
 *
 * ⚠ THIS FILE MUST LIVE UNDER `src/**`. `vitest.config.ts:10` includes `src/**\/*.spec.ts`
 * and nothing else; `vitest.integration.config.ts:17` includes `**\/*.int-spec.ts`. A file
 * named `*.spec.ts` under `apps/api/test/` matches NEITHER glob and passes by never running,
 * and `assertEveryIntegrationSpecRuns()` only catches the opposite near-miss.
 */

/** ADR-0056, "The shape": `apps/api/src/**\/*.ts`, excluding `*.spec.ts`. */
const apiSource = fileURLToPath(new URL('../', import.meta.url));
const repositoryRoot = fileURLToPath(new URL('../../../../', import.meta.url));

interface SourceFile {
  /** Repository-relative and forward-slashed, so a failure names a path a reader can open. */
  readonly path: string;
  readonly source: string;
}

const SCAN_SET: readonly SourceFile[] = readdirSync(apiSource, {
  recursive: true,
  encoding: 'utf8',
})
  .filter((entry) => entry.endsWith('.ts') && !entry.endsWith('.spec.ts'))
  .map((entry) => join(apiSource, entry))
  .map((path) => ({
    path: relative(repositoryRoot, path).split(sep).join('/'),
    source: readFileSync(path, 'utf8'),
  }));

function filesMatching(pattern: RegExp): readonly string[] {
  return [...new Set(SCAN_SET.filter((file) => pattern.test(file.source)).map((f) => f.path))]
    .slice()
    .sort();
}

/** Scan 1. The bare identifier, so an import, a re-export, a call and a mention all count. */
const BETTER_AUTH_DATABASE = /\bbetterAuthDatabase\b/;

/** Scan 2. Every spelling, including `const { DATABASE_AUTH_URL } = process.env`. */
const DATABASE_AUTH_URL_MENTIONED = /\bDATABASE_AUTH_URL\b/;

/**
 * Scan 3. THE USE, and the anchoring is the whole point.
 *
 * `process.env.DATABASE_AUTH_URL` and the bracket form with a QUOTED literal key. A bare
 * `/process\.env\[/` matches `health/build-commit.ts:39`'s `process.env[GIT_COMMIT_SHA_ENV]`,
 * which reads a different variable and is not this scan's business (F-191).
 *
 * `process.env['DATABASE_' + 'AUTH_URL']` defeats it, and ADR-0056 says so in as many words.
 * These are floors against the direct spelling, which is the spelling a convenience commit
 * actually uses.
 */
const DATABASE_AUTH_URL_USED =
  /process\s*\.\s*env\s*(?:\.\s*DATABASE_AUTH_URL\b|\[\s*(['"`])DATABASE_AUTH_URL\1\s*\])/;

/**
 * Scan 4. THE MODULE SPECIFIER, in an import, a `require` or a dynamic `import` position —
 * never a bare quoted `'pg'`, which is `auth.config.ts`'s own MANDATED `provider: 'pg'`
 * (F-191). `import type` is matched too: it also carries the specifier, and the scan bounds
 * the file set rather than the runtime edge.
 */
const POSTGRES_DRIVER_IMPORT =
  /(?:\bfrom\s*|\brequire\s*\(\s*|\bimport\s*\(\s*)(['"])(pg|drizzle-orm\/node-postgres)\1/;

/**
 * Scan 5. THE COMPOSED INSTANCE IS A SECOND HANDLE ON THE SAME ROLE (F-207).
 *
 * `(await auth.$context).adapter` reads plaintext `session.token`, the `account` password
 * hashes and `jwks.private_key`, and writes a session row for any user id — measured by the
 * wave-2 security pass **with all four scans above green**. A module that imports `auth`
 * reaches every one of those without any of scans 1-4's spellings appearing in its own text,
 * because the pool was constructed in `auth.config.ts` and handed over as an object.
 *
 * Anchored on IMPORT POSITION like scan 4, so the eleven files that merely name
 * `auth.config.ts` in prose do not match. Verified both directions in
 * "the scan-5 pattern matches an import and not a mention" below.
 */
const AUTH_CONFIG_IMPORT =
  /(?:\bfrom\s*|\brequire\s*\(\s*|\bimport\s*\(\s*)(['"])[^'"]*\bauth\.config(?:\.[jt]s)?\1/;

const CLIENT = 'apps/api/src/db/client.ts';
const AUTH_CONFIG = 'apps/api/src/auth/auth.config.ts';
const MAIN = 'apps/api/src/main.ts';
const BOOT_ASSERTIONS = 'apps/api/src/auth/boot-assertions.ts';

describe('who may reach the shortkit_auth role', () => {
  it('ADR-0056 scan 1 (equality): betterAuthDatabase appears in exactly client.ts and auth.config.ts', () => {
    // EQUALITY IS ITS OWN CANARY, which is why this file carries no separate "the scan
    // reached something" test the way `context-flag-owners.spec.ts` does. `toEqual([])` is
    // satisfied by a scan that walked a moved directory and read nothing; `toEqual(PERMITTED)`
    // is not.
    //
    // Equality rather than subset because BOTH permitted files exist when this runs:
    // `client.ts` is shipped and `auth.config.ts` is created by the card that ships this
    // spec. It therefore catches a REMOVAL as well as an addition, and deleting the call
    // from `auth.config.ts` to reach the pool another way is a diff this must not pass.
    expect(filesMatching(BETTER_AUTH_DATABASE)).toEqual([AUTH_CONFIG, CLIENT]);
  });

  it('ADR-0056 scan 2 (subset): every file naming DATABASE_AUTH_URL is on the permitted list', () => {
    // Subset, and the direction it keeps is the one carrying the security claim: every
    // ADDITION still fails. `main.ts` and `auth/boot-assertions.ts` are here before they
    // contain the string, because TASK-004 puts it in both in wave 3 — THEY MAY NAME THE
    // VARIABLE AND MUST NOT CONNECT WITH IT, and scan 3 is what enforces the second half.
    const permitted = new Set([BOOT_ASSERTIONS, CLIENT, MAIN]);

    expect(
      filesMatching(DATABASE_AUTH_URL_MENTIONED).filter((path) => !permitted.has(path)),
    ).toEqual([]);
  });

  it('ADR-0056 scan 3 (equality): process.env.DATABASE_AUTH_URL is read in db/client.ts alone', () => {
    // ============================================================================
    // THE LOAD-BEARING ONE. IF ANY OF THE FOUR IS EVER DROPPED, IT IS NOT THIS.
    // ============================================================================
    //
    // The identifier is not the capability. Reaching the role needs no identifier at all —
    // the DSN is in the process environment, so one `new pg.Pool({ connectionString:
    // process.env.DATABASE_AUTH_URL })` anywhere under `apps/api/src` holds `shortkit_auth`
    // and scan 1 passes. One measured fact bounds the evasion surface: `docker-compose.yml`
    // interpolates `SHORTKIT_AUTH_PASSWORD` into `DATABASE_AUTH_URL` at Compose PARSE time
    // and the parts are not in the `api` service's environment, so the DSN literal is the
    // only in-process spelling that reaches the role.
    expect(filesMatching(DATABASE_AUTH_URL_USED)).toEqual([CLIENT]);
  });

  it('ADR-0056 scan 4 (equality): the postgres driver is imported in db/client.ts alone', () => {
    // A TRIPWIRE, AND THIS SPEC DOES NOT CLAIM IT CLOSES POOL CONSTRUCTION. Corrected
    // 2026-08-16: `drizzle-orm/node-postgres`'s own driver runs `new pg.Pool({
    // connectionString: params[0] })` when `drizzle()` is handed a string, so
    // `const db = drizzle(dsn)` holds the role in one line with no `new pg.Pool` and no
    // `from 'pg'` in it. Matching the MODULE SPECIFIER is what covers that, and it also
    // covers `from "pg"` and `await import('pg')`, which a quoted-spelling regex missed.
    //
    // A file that obtains a client from somewhere else defeats this and not scan 3.
    expect(filesMatching(POSTGRES_DRIVER_IMPORT)).toEqual([CLIENT]);
  });

  it('ADR-0056 scan 5 (subset): every file importing the composed instance is permitted', () => {
    // ============================================================================
    // SUBSET FOR SCAN 2's REASON, AND NOT AS THE WEAKER CHOICE.
    // ============================================================================
    //
    // `main.ts` mounts the instance in wave 3 through
    // `const { auth } = await import('./auth/auth.config')` — which its own F-210 docblock
    // already spells out and which must stay a DYNAMIC import inside `bootstrap()`, or the
    // accessors throw during module evaluation and no boot assertion runs. It is permitted
    // before it imports anything, so an equality would be red the day this lands, and
    // F-186's trap is that the cheapest green is to trim the permitted set — which deletes
    // the bound.
    //
    // ⚠ `auth.module.ts` IS NOT PERMITTED, AND ITS ABSENCE IS THE POINT (F-212). It was in
    // this set for one round, on the guess that TASK-005's guard would live there. THE CODE
    // FORBIDS IT: `auth/auth.module.ts:21-24` says "IT DELIBERATELY IMPORTS NOTHING FROM
    // `auth.config.ts`", because that module evaluates `betterAuth({ secret:
    // betterAuthSecret(), baseURL: betterAuthUrl(), … })` at module scope — so importing it
    // from a Nest module makes EVERY `AppModule` compile require the auth bindings,
    // including the unit tier's, which has none. A permitted set that admits what the file
    // it names refuses is worse than one that admits too little: a wave-3 implementer reads
    // it as design intent, takes it, and reddens the whole unit tier on module load. If wave
    // 3 decides otherwise, this line and that docblock move together or neither moves.
    //
    // ⚠ THIS MATCHES EXACTLY ONE FILE ON THE TREE TODAY AND THAT MATCH IS A COMMENT.
    // Verified: `main.ts:138` is prose quoting the import TASK-004 must write, and NO FILE
    // UNDER `apps/api/src` IMPORTS `auth.config.ts` at all. So this scan bounds a capability
    // nobody has taken yet, and a reword of that one comment would leave it matching nothing
    // — which a `filter(...).toEqual([])` passes over silently. That is why its positive
    // control below is planted text and not a file on the tree: the control proves the
    // PATTERN works, and cannot be defeated by editing prose.
    const permitted = new Set([MAIN]);

    expect(filesMatching(AUTH_CONFIG_IMPORT).filter((path) => !permitted.has(path))).toEqual([]);
  });

  it('the scan-5 pattern matches an import and not a mention', () => {
    // ============================================================================
    // THE POSITIVE CONTROL FOR SCAN 5, AND IT IS PLANTED TEXT RATHER THAN A FILE.
    // ============================================================================
    //
    // Scan 5 is the only one of the five whose permitted set is satisfied by the tree
    // trivially — nothing imports `auth.config.ts` yet — so `toEqual([])` above proves
    // nothing about the regex. Measured here instead, against spellings hand-written to
    // defeat it. The must-not list is the half that matters as much: SEVEN FILES in the scan
    // set name `auth.config` in prose today — counted, not estimated: `main.ts`,
    // `auth/{auth.config,auth.module,boot-assertions,on-user-created,revocation-store}.ts`
    // and `db/schema/auth.ts` — including `boot-assertions.ts`'s "THIS FILE MUST NOT IMPORT
    // `auth.config.ts`" banner. A pattern that matched those would put the whole scan
    // permanently red and get it deleted.
    const matches = [
      `import { auth } from './auth.config';`,
      `import { auth } from '../auth/auth.config';`,
      `import { auth } from '../../src/auth/auth.config';`,
      `import { auth } from './auth/auth.config.js';`,
      `import type { AuthBeforeHook } from './auth.config.ts';`,
      `const { auth } = await import('./auth.config');`,
      `const { auth } = require('./auth.config');`,
      `export * from './auth.config';`,
      `import { auth as instance } from "./auth.config";`,
      `import {auth} from"./auth.config"`,
      `import {\n  auth,\n  beforeHooks,\n} from './auth.config';`,
      `import { auth } from '@shortkit/api/auth/auth.config';`,
    ];

    const mentions = [
      ` * THIS FILE MUST NOT IMPORT \`auth.config.ts\`. THE DEPENDENCY RUNS THE OTHER WAY.`,
      ` * \`auth.config.ts\` evaluates betterAuth({ secret: betterAuthSecret(), ... })`,
      ` * Produced by: TASK-003. Called by: auth.config.ts's databaseHooks.user.create.after.`,
      `import x from './auth.configuration';`,
      `import { AuthModule } from './auth.module';`,
    ];

    expect({
      importsMissed: matches.filter((line) => !AUTH_CONFIG_IMPORT.test(line)),
      mentionsMatched: mentions.filter((line) => AUTH_CONFIG_IMPORT.test(line)),
    }).toEqual({ importsMissed: [], mentionsMatched: [] });
  });

  it('the scan set is the API source tree, and it is not empty', () => {
    // THE PREMISE OF THE SUBSET SCAN, which is the one assertion above that a scan reading
    // nothing would satisfy. Scans 1, 3 and 4 are equalities and fail on an empty read;
    // scan 2 is `filter(...).toEqual([])` and passes vacuously, which is the exact shape
    // `test/isolation/coverage.ts` records this repository having measured once already.
    expect(SCAN_SET.map((file) => file.path)).toContain(CLIENT);
  });
});
