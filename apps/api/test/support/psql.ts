/**
 * SQL access for the integration suite's fixtures, without a Node driver.
 *
 * ⚠ THIS FILE IS sdlc-test-architect'S TO REPLACE — NOT TASK-005'S.
 *
 * `apps/api/test/support/**` appears in no TASK's paths and belongs to
 * sdlc-test-architect under routing rule 0, so no implementer may edit it. TASK-005's
 * obligation towards this file is the dependency alone: it adds `pg` to
 * `apps/api/package.json`, because `drizzle-orm/node-postgres` requires it. Once that
 * has landed, sdlc-test-architect swaps the `psql` spawn below for a `pg.Client` and
 * deletes the process spawning; nothing outside this file knows how the SQL is sent
 * (F-077, F-100).
 *
 * The suite needs three things the production API deliberately does not expose:
 * DDL as the migrator role, seeding, and a read on the runtime role that is NOT
 * wrapped in a tenant transaction (AC-10). `apps/api/src/db/client.ts` never
 * exports an unscoped client — that is the point of ADR-0002 — so the fixture
 * needs its own connection.
 *
 * `pg` is not a dependency of `apps/api` at the time these tests were written.
 * Importing it here would make every test in the file fail on module resolution,
 * which proves nothing. So the fixture shells out to `psql` instead, and the two
 * exported functions become a `pg.Client` in the swap described above.
 *
 * Resolution order for the client binary:
 *   1. `psql` on PATH.
 *   2. `docker run --rm -i --network host <POSTGRES_TEST_IMAGE> psql`.
 * Both are given the DSN verbatim, so `localhost:<port>` means the same thing to
 * either one.
 */
import { spawnSync } from 'node:child_process';

const POSTGRES_TEST_IMAGE = process.env.POSTGRES_TEST_IMAGE ?? 'postgres:17-alpine';

let cachedInvocation: readonly string[] | null = null;

function psqlInvocation(): readonly string[] {
  if (cachedInvocation !== null) {
    return cachedInvocation;
  }

  const local = spawnSync('psql', ['--version'], { encoding: 'utf8' });
  cachedInvocation =
    local.status === 0
      ? ['psql']
      : ['docker', 'run', '--rm', '-i', '--network', 'host', POSTGRES_TEST_IMAGE, 'psql'];

  return cachedInvocation;
}

export interface SqlOptions {
  /**
   * Sets `app.tenant_id` for the psql session before the statement runs, so a
   * fixture can read or seed an RLS-protected table. psql interpolates it through
   * `:'tenant_id'`, which quotes it as a literal — the value never reaches the
   * statement by string concatenation (rls-policy-template.md).
   */
  readonly tenantId?: string;
  /**
   * Extra psql variables. `:'name'` interpolates one as a quoted literal and
   * `:"name"` as a quoted identifier, both of which psql escapes for us.
   */
  readonly variables?: Readonly<Record<string, string>>;
}

function send(dsn: string, script: string, options: SqlOptions): string {
  const invocation = psqlInvocation();
  const args = [
    ...invocation.slice(1),
    '-X',
    '-q',
    '-A',
    '-t',
    '-v',
    'ON_ERROR_STOP=1',
    ...(options.tenantId === undefined ? [] : ['-v', `tenant_id=${options.tenantId}`]),
    ...Object.entries(options.variables ?? {}).flatMap(([name, value]) => [
      '-v',
      `${name}=${value}`,
    ]),
    dsn,
  ];

  const result = spawnSync(invocation[0], args, { encoding: 'utf8', input: script });

  if (result.error !== undefined) {
    throw new Error(
      `could not run '${invocation.join(' ')}': ${result.error.message}. ` +
        'Install psql or make Docker available to the test run.',
    );
  }

  if (result.status !== 0) {
    throw new Error(
      `psql exited ${String(result.status)} for:\n${script}\n\n${result.stderr.trim()}`,
    );
  }

  return result.stdout;
}

const SET_TENANT_ID = "SELECT set_config('app.tenant_id', :'tenant_id', false) \\g /dev/null\n";

/** Runs statements for their effect. Any error aborts the script and throws. */
export function execSql(dsn: string, script: string, options: SqlOptions = {}): void {
  send(dsn, (options.tenantId === undefined ? '' : SET_TENANT_ID) + script, options);
}

/**
 * Runs one SELECT and returns its rows. The statement is wrapped in `json_agg`
 * so the result parses without a column-format guess.
 */
export function querySql<T = Record<string, unknown>>(
  dsn: string,
  select: string,
  options: SqlOptions = {},
): T[] {
  const script =
    (options.tenantId === undefined ? '' : SET_TENANT_ID) +
    `SELECT coalesce(json_agg(q), '[]'::json) FROM (\n${select}\n) q;\n`;

  return JSON.parse(send(dsn, script, options).trim()) as T[];
}
