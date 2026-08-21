/**
 * A throwaway Redis for `redirect-cache.int-spec.ts`.
 *
 * ---------------------------------------------------------------------------
 * WHY A CONTAINER OF ITS OWN
 * ---------------------------------------------------------------------------
 *
 * TASK-2-04 wires the compose and CI Redis services; until they land there is no shared
 * instance to point at, and this suite needs one it may STOP AND PAUSE: AC-2-29's
 * "Redis is gone", AC-2-30's "hung but connected" and AC-2-31's "it comes back with no
 * restart" are all statements about a server that goes away underneath a live client. A
 * suite that did that to a shared service would take every other suite down with it.
 *
 * When 2-04's `docker-compose.test.yml` service exists, this fixture stays: the shared
 * instance is for suites that need a working cache, and this one deliberately breaks its
 * server.
 *
 * ---------------------------------------------------------------------------
 * THE DISCIPLINE IS `test/support/scratch-postgres.ts`'s
 * ---------------------------------------------------------------------------
 *
 * `docker exec redis-cli` for every command, so nothing needs a client on the host's PATH;
 * readiness POLLED rather than slept on; loopback only (`127.0.0.1`, never `0.0.0.0`, which
 * is the file-wide rule in both compose files); and `stop()` from `afterAll` and from the
 * failure path of setup.
 *
 * NOT `--rm`, WHICH IS THE ONE DELIBERATE DIVERGENCE from that fixture. AC-2-31 needs the
 * SAME server to come back (`docker stop` then `docker start`), and `--rm` removes the
 * container on stop, so the restart would be a different server. `stop()` is
 * `docker rm -f`, called from `afterAll` and from every failure path, and the container name
 * carries the pid so a crashed run cannot collide with the next one.
 */
import type { SpawnSyncReturns } from 'node:child_process';
import { spawnSync } from 'node:child_process';

/** D-2-16 pins `redis:7-alpine` for compose and CI; the fixture runs the same server. */
const REDIS_TEST_IMAGE = process.env.REDIS_TEST_IMAGE ?? 'redis:7-alpine';

/**
 * Loopback only, and a THIRD port: D-2-16 gives `docker-compose.yml`'s redis
 * `127.0.0.1:56379` and `docker-compose.test.yml`'s `127.0.0.1:56380`, so a fixture on
 * either would refuse to start whenever the developer's stack was up, a suite that fails
 * because something unrelated is running. `REDIS_TEST_PORT` overrides it for a machine where
 * even this one is taken.
 */
const HOST_PORT = Number(process.env.REDIS_TEST_PORT ?? 56_381);

/**
 * TASK-2-07 added the `hostPort` parameter below rather than a second copy of this file: the
 * redirect's own degradation suites break a server too, and two suites cannot share one
 * container when one of them stops it. They pass 56382. Files run one at a time
 * (`fileParallelism: false`), so today the ports need only differ from the two compose ones;
 * pinning one per suite is what keeps that true if the setting ever changes.
 */

const READY_ATTEMPTS = 120;
const READY_INTERVAL_MS = 250;

export interface ScratchRedis {
  /** The container name, for a message that has to say where to look. */
  readonly container: string;
  /** What `REDIS_URL` is set to. */
  readonly url: string;
  /** `docker exec … redis-cli <args>`, trimmed stdout. Throws on a non-zero exit. */
  cli(...args: readonly string[]): string;
  /** SIGSTOP: connected, reachable, and never answering (AC-2-30's hung server). */
  pause(): void;
  unpause(): void;
  /** SIGTERM: the server goes away and the socket closes (AC-2-29). */
  stopServer(): void;
  /** The SAME server comes back (AC-2-31). Waits for it to answer PING. */
  startServer(): void;
  /** Removes the container. Safe to call twice. */
  stop(): void;
}

function docker(args: readonly string[]): SpawnSyncReturns<string> {
  return spawnSync('docker', [...args], { encoding: 'utf8' });
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function startScratchRedis(label: string, hostPort: number = HOST_PORT): ScratchRedis {
  const container = `shortkit-scratch-redis-${label}-${String(process.pid)}-${Date.now().toString(36)}`;

  const started = docker([
    'run',
    '-d',
    '--name',
    container,
    '-p',
    `127.0.0.1:${String(hostPort)}:6379`,
    REDIS_TEST_IMAGE,
  ]);

  if (started.error !== undefined || started.status !== 0) {
    throw new Error(
      `could not start a scratch Redis (${REDIS_TEST_IMAGE}): ` +
        `${started.error?.message ?? started.stderr.trim()}. ` +
        'This suite stops and pauses its own server, so it cannot run against a shared ' +
        'instance. Make Docker available to the test run, or free 127.0.0.1:' +
        `${String(hostPort)}.`,
    );
  }

  const handle: ScratchRedis = {
    container,
    url: `redis://127.0.0.1:${String(hostPort)}`,

    cli(...args: readonly string[]): string {
      const result = docker(['exec', container, 'redis-cli', ...args]);

      if (result.error !== undefined) {
        throw new Error(`could not reach scratch container ${container}: ${result.error.message}`);
      }

      if (result.status !== 0) {
        throw new Error(
          `redis-cli exited ${String(result.status)} in ${container}:\n${result.stderr.trim()}`,
        );
      }

      return result.stdout.trim();
    },

    pause(): void {
      expectDocker(docker(['pause', container]), `pause ${container}`);
    },

    unpause(): void {
      expectDocker(docker(['unpause', container]), `unpause ${container}`);
    },

    stopServer(): void {
      // `-t 0` so the suite does not wait ten seconds for a graceful shutdown it does not
      // need; the point is that the socket closes.
      expectDocker(docker(['stop', '-t', '0', container]), `stop ${container}`);
    },

    startServer(): void {
      expectDocker(docker(['start', container]), `start ${container}`);
      waitForPing(handle);
    },

    stop(): void {
      docker(['rm', '-f', container]);
    },
  };

  try {
    waitForPing(handle);
  } catch (error) {
    handle.stop();
    throw error;
  }

  return handle;
}

function expectDocker(result: SpawnSyncReturns<string>, what: string): void {
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(`docker ${what} failed: ${result.error?.message ?? result.stderr.trim()}`);
  }
}

/**
 * Polled, never slept on. A container that is `running` is not a server that answers, and a
 * fixed sleep that is long enough on a warm machine is a flake on a cold one.
 */
function waitForPing(handle: ScratchRedis): void {
  for (let attempt = 0; attempt < READY_ATTEMPTS; attempt += 1) {
    const probe = spawnSync('docker', ['exec', handle.container, 'redis-cli', 'ping'], {
      encoding: 'utf8',
    });

    if (probe.status === 0 && probe.stdout.trim() === 'PONG') {
      return;
    }

    sleepSync(READY_INTERVAL_MS);
  }

  const logs = spawnSync('docker', ['logs', '--tail', '30', handle.container], { encoding: 'utf8' });

  throw new Error(
    `scratch Redis ${handle.container} never answered PING after ` +
      `${String((READY_ATTEMPTS * READY_INTERVAL_MS) / 1000)}s. Last logs:\n${logs.stdout}\n${logs.stderr}`,
  );
}
