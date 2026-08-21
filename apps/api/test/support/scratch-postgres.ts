/**
 * A throwaway Postgres *cluster* for tests that have to construct a bad database.
 *
 * ⚠ THIS FILE IS sdlc-test-architect'S. `apps/api/test/support/**` belongs to it under
 * routing rule 0. TASK-018's `paths` names `rls-fixture.ts` and `auth-fixture.ts` as a
 * documented exception; this file is new and is not an implementer's to edit.
 *
 * ---------------------------------------------------------------------------
 * WHY A SECOND POSTGRES, WHEN THE SUITE ALREADY HAS ONE
 * ---------------------------------------------------------------------------
 *
 * `test/support/psql.ts` reaches the suite's live database as `shortkit_app` or
 * `shortkit_migrator`. Neither holds `CREATEROLE` (that is the point of ADR-0003)
 * so neither can create a role, and **roles are cluster-wide**: creating
 * `shortkit_auth` there would collide with the role the container's own init script
 * creates and would leak into every other `.int-spec.ts` in the run
 * (`vitest.integration.config.ts:70`, one shared database, files serialised).
 *
 * `auth-role-provisioning.int-spec.ts` has to do two things that cannot be done on a
 * shared cluster at all:
 *
 *   - run a provisioning artifact from scratch, against an empty cluster, and read
 *     back what it created;
 *   - construct a database the provisioning guards are supposed to REJECT (a
 *     `shortkit_auth` holding `BYPASSRLS`, or a cluster with two of the three roles),
 *     and prove the guard refuses it. A guard tested only against a good database
 *     passes green while inspecting nothing, which is exactly the state
 *     `.github/scripts/provision-test-database.sql:57` is in today.
 *
 * So this fixture owns a container of its own, created and destroyed inside one spec
 * file. It never touches `DATABASE_URL`, `DATABASE_MIGRATION_URL` or any database the
 * developer cares about.
 *
 * ---------------------------------------------------------------------------
 * DOCKER, NOT `pg`, AND NOT A PUBLISHED PORT
 * ---------------------------------------------------------------------------
 *
 * Every statement goes through `docker exec ... psql` inside the container, so the
 * fixture needs neither a client on the host's PATH (there often is none; see
 * `psql.ts`'s two-step resolution) nor a free host port. `POSTGRES_TEST_IMAGE` is
 * read the same way `psql.ts` reads it, so both fixtures pin the same server version.
 *
 * Readiness is probed over **TCP** (`-h 127.0.0.1`), not over the unix socket and not
 * with `pg_isready`. The postgres entrypoint runs initdb, starts a temporary
 * socket-only server, runs `/docker-entrypoint-initdb.d`, stops it and only then
 * starts the real server. A socket probe returns success inside that window
 * (`docker-compose.test.yml`'s healthcheck comment records the same trap costing F-127),
 * and the fixture would then race the restart.
 */
import type { SpawnSyncReturns } from 'node:child_process';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const POSTGRES_TEST_IMAGE = process.env.POSTGRES_TEST_IMAGE ?? 'postgres:17-alpine';

const READY_ATTEMPTS = 120;
const READY_INTERVAL_MS = 500;

/**
 * What `reset()` removes between tests. Deliberately NOT exported: a spec that read
 * its expected role names from here would assert the fixture against itself, and
 * `shortkit_auth` would appear on both sides of every comparison. The specs spell
 * their expectations out as literals.
 *
 * Databases first: a role owning a database cannot be dropped.
 */
const SCRATCH_DATABASES = ['shortkit_test', 'shortkit'] as const;
const SCRATCH_ROLES = ['shortkit_app', 'shortkit_auth', 'shortkit_migrator'] as const;

export interface ScratchPostgres {
  /** The container name, for a message that has to say where to look. */
  readonly container: string;
  /**
   * Runs a psql script as the bootstrap superuser against `postgres`, with
   * `ON_ERROR_STOP=1`. Throws on the first error, carrying psql's stderr, which is
   * how a `RAISE EXCEPTION` from a provisioning guard reaches an assertion.
   *
   * `\connect` works: the session is a real psql over TCP, so a script that switches
   * database mid-file behaves as it does in CI.
   */
  runSql(script: string): string;
  /** One SELECT, wrapped in `json_agg` so the result parses without a format guess. */
  queryJson<T = Record<string, unknown>>(select: string): T[];
  /**
   * Copies a shell script into the container and runs it with `sh`, with the given
   * environment. This is how the Compose `configs:` init scripts (which are shell,
   * not SQL) are exercised as themselves rather than transcribed into a test.
   */
  runShellScript(script: string, env: Readonly<Record<string, string>>): string;
  /** Drops every role and database a provisioning artifact under test may have created. */
  reset(): void;
  /** Removes the container. Safe to call twice. */
  stop(): void;
}

function docker(args: readonly string[], input?: string): SpawnSyncReturns<string> {
  return spawnSync('docker', [...args], { encoding: 'utf8', input });
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Starts an empty cluster and waits for the real server to accept TCP.
 *
 * `--rm` so an interrupted run leaves nothing behind; `stop()` is still called from
 * `afterAll`, because `--rm` only fires when the container exits on its own.
 */
export function startScratchPostgres(label: string): ScratchPostgres {
  const container = `shortkit-scratch-${label}-${String(process.pid)}-${Date.now().toString(36)}`;

  const started = docker([
    'run',
    '-d',
    '--rm',
    '--name',
    container,
    '-e',
    'POSTGRES_PASSWORD=postgres',
    '-e',
    'POSTGRES_DB=postgres',
    POSTGRES_TEST_IMAGE,
  ]);

  if (started.error !== undefined || started.status !== 0) {
    throw new Error(
      `could not start a scratch Postgres (${POSTGRES_TEST_IMAGE}): ` +
        `${started.error?.message ?? started.stderr.trim()}. ` +
        'These provisioning assertions construct a cluster of their own: they cannot ' +
        'run against DATABASE_URL, whose roles hold no CREATEROLE. Make Docker available ' +
        'to the test run.',
    );
  }

  const handle: ScratchPostgres = {
    container,

    runSql(script: string): string {
      const result = docker(
        [
          'exec',
          '-i',
          container,
          'psql',
          '-v',
          'ON_ERROR_STOP=1',
          '-X',
          '-q',
          '-A',
          '-t',
          '-h',
          '127.0.0.1',
          '-U',
          'postgres',
          '-d',
          'postgres',
        ],
        script,
      );

      if (result.error !== undefined) {
        throw new Error(`could not reach scratch container ${container}: ${result.error.message}`);
      }

      if (result.status !== 0) {
        throw new Error(
          `psql exited ${String(result.status)} in ${container}:\n${result.stderr.trim()}`,
        );
      }

      return result.stdout;
    },

    queryJson<T = Record<string, unknown>>(select: string): T[] {
      return JSON.parse(
        handle.runSql(`SELECT coalesce(json_agg(q), '[]'::json) FROM (\n${select}\n) q;\n`).trim(),
      ) as T[];
    },

    runShellScript(script: string, env: Readonly<Record<string, string>>): string {
      const hostPath = join(mkdtempSync(join(tmpdir(), 'shortkit-scratch-')), 'script.sh');
      writeFileSync(hostPath, script);

      const copied = docker(['cp', hostPath, `${container}:/tmp/scratch-script.sh`]);

      if (copied.status !== 0) {
        throw new Error(`could not copy the script into ${container}: ${copied.stderr.trim()}`);
      }

      const result = docker([
        'exec',
        ...Object.entries(env).flatMap(([name, value]) => ['-e', `${name}=${value}`]),
        container,
        'sh',
        '/tmp/scratch-script.sh',
      ]);

      if (result.error !== undefined) {
        throw new Error(`could not reach scratch container ${container}: ${result.error.message}`);
      }

      if (result.status !== 0) {
        throw new Error(
          `the init script exited ${String(result.status)} in ${container}:\n` +
            `${result.stderr.trim()}\n${result.stdout.trim()}`,
        );
      }

      return result.stdout;
    },

    reset(): void {
      handle.runSql(
        [
          ...SCRATCH_DATABASES.map((name) => `DROP DATABASE IF EXISTS ${name} WITH (FORCE);`),
          ...SCRATCH_ROLES.map((name) => `DROP ROLE IF EXISTS ${name};`),
        ].join('\n'),
      );
    },

    stop(): void {
      docker(['rm', '-f', container]);
    },
  };

  for (let attempt = 0; attempt < READY_ATTEMPTS; attempt += 1) {
    const probe = docker([
      'exec',
      container,
      'psql',
      '-X',
      '-q',
      '-A',
      '-t',
      '-h',
      '127.0.0.1',
      '-U',
      'postgres',
      '-d',
      'postgres',
      '-c',
      'SELECT 1',
    ]);

    if (probe.status === 0) {
      return handle;
    }

    sleepSync(READY_INTERVAL_MS);
  }

  const logs = docker(['logs', '--tail', '30', container]);
  handle.stop();

  throw new Error(
    `scratch Postgres ${container} never accepted a TCP connection after ` +
      `${String((READY_ATTEMPTS * READY_INTERVAL_MS) / 1000)}s. Last logs:\n${logs.stdout}\n${logs.stderr}`,
  );
}
