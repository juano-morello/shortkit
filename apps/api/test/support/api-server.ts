/**
 * Boots the API as the platform boots it — a built process, listening on a real
 * socket — and hands back its base URL.
 *
 * ⚠ THIS FILE IS sdlc-test-architect'S. `apps/api/test/support/**` appears in no
 * TASK's paths and belongs to it under routing rule 0. An implementer that needs
 * something here changed routes a finding rather than editing it.
 *
 * ## Why a child process rather than `Test.createTestingModule`
 *
 * `src/health/health.spec.ts` and `src/common/errors/exception-filter.spec.ts` both
 * assert over a real HTTP round trip against an application compiled from
 * `AppModule`, and that is the right shape for anything Nest routes. It is the wrong
 * shape for the auth surface. ADR-0013 mounts Better Auth's node handler on the
 * Express instance inside `main.ts`, ahead of the body parsers and **outside the Nest
 * module graph** — the ADR's own consequences say so: "the `/api/auth/*` mount sits
 * outside the Nest module graph, so AC-55's test cannot see it and no Nest guard,
 * interceptor or filter applies to it".
 *
 * An application built by `Test.createTestingModule({ imports: [AppModule] })` never
 * runs `main.ts`, so it would carry no auth route however correct the implementation
 * is. A suite written that way could not go green for the right reason, which is a
 * worse defect than one that cannot go red: it would report the auth mount broken
 * forever, and the repair would be to weaken the test.
 *
 * So this boots the composition root itself. The failure modes that only the real
 * boot sequence exposes — `bodyParser: false` missing, so Better Auth reads a stream
 * something else already consumed; `setGlobalPrefix` running before the mount;
 * a boot assertion refusing to start — are exactly the ones ADR-0013 warns are silent
 * or fatal, and none of them is visible to an in-graph test.
 *
 * ## Why it is built first
 *
 * `apps/api` compiles with `emitDecoratorMetadata` (ADR-0001), and Node's own type
 * stripping does not implement decorators, so `node src/main.ts` is not available.
 * `tsup` produces `dist/main.js` in well under a second; the build runs once per
 * suite in `startApiServer`.
 *
 * ## The environment it passes, and who owns those names
 *
 * `PORT` is the only variable `main.ts` reads today. Everything else a caller passes
 * through `env` is a name **this harness decides**, the same way
 * `src/health/health.spec.ts` decides `GIT_COMMIT_SHA` and records that it is doing
 * so: no ADR, contract, `.env.example` or workflow in this repository names the
 * variables the auth mount will read. If an implementer picks different names, the
 * caller's `env` callback is the single edit and no assertion weakens.
 */
import { execFileSync, spawn } from 'node:child_process';
import { createServer, connect } from 'node:net';
import { fileURLToPath } from 'node:url';

/** `apps/api`, the workspace whose `build` script produces the bundle below. */
const API_DIR = fileURLToPath(new URL('../../', import.meta.url));

/** The monorepo root, which is where `pnpm --filter` has to run from. */
const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

const BUNDLE = 'dist/main.js';

/** How long the process gets to accept a connection before the boot is called failed. */
const READY_TIMEOUT_MS = 20_000;
const READY_POLL_MS = 100;

/** How long a `SIGTERM` gets before the process is killed outright. */
const SHUTDOWN_TIMEOUT_MS = 5_000;

export interface ApiServer {
  /** `http://127.0.0.1:<port>`, with no trailing slash and no `/api` segment. */
  readonly baseUrl: string;
  /** Everything the process has written to stdout and stderr, for failure messages. */
  readonly output: () => string;
  readonly stop: () => Promise<void>;
}

export interface StartApiServerOptions {
  /**
   * Extra environment for the child, as a function of the base URL it will answer
   * on — the port is chosen here, and anything configured with an absolute URL
   * (an issuer, an audience, a trusted origin) needs to agree with it.
   */
  readonly env?: (baseUrl: string) => Readonly<Record<string, string>>;
}

/** A port the kernel has just confirmed is free. Bound and released, not guessed. */
async function freePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const probe = createServer();

    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();

      if (address === null || typeof address === 'string') {
        probe.close();
        reject(new Error('could not read a port from the probe socket'));
        return;
      }

      probe.close(() => {
        resolve(address.port);
      });
    });
  });
}

async function accepts(port: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = connect({ port, host: '127.0.0.1' });

    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => {
      socket.destroy();
      resolve(false);
    });
  });
}

/**
 * Builds `apps/api`, starts the bundle, and resolves once the port accepts a
 * connection.
 *
 * Readiness is a TCP accept rather than a `GET /health`: `/health` is TASK-003's and
 * 404s today, so probing it would make this harness depend on a route none of its
 * callers assert on.
 */
export async function startApiServer(options: StartApiServerOptions = {}): Promise<ApiServer> {
  execFileSync('pnpm', ['--filter', '@shortkit/api', 'build'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    stdio: 'pipe',
  });

  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${String(port)}`;

  const child = spawn(process.execPath, [BUNDLE], {
    cwd: API_DIR,
    env: { ...process.env, PORT: String(port), ...options.env?.(baseUrl) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let captured = '';
  child.stdout.on('data', (chunk: Buffer) => (captured += chunk.toString('utf8')));
  child.stderr.on('data', (chunk: Buffer) => (captured += chunk.toString('utf8')));

  let exited: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  child.once('exit', (code, signal) => {
    exited = { code, signal };
  });

  const stop = async (): Promise<void> => {
    if (exited !== undefined) {
      return;
    }

    child.kill('SIGTERM');

    await Promise.race([
      new Promise<void>((resolve) => child.once('exit', () => resolve())),
      new Promise<void>((resolve) =>
        setTimeout(() => {
          child.kill('SIGKILL');
          resolve();
        }, SHUTDOWN_TIMEOUT_MS),
      ),
    ]);
  };

  const deadline = Date.now() + READY_TIMEOUT_MS;

  for (;;) {
    if (exited !== undefined) {
      throw new Error(
        `the API exited before it accepted a connection (code ${String(exited.code)}, ` +
          `signal ${String(exited.signal)}). Its output was:\n${captured}`,
      );
    }

    if (await accepts(port)) {
      return { baseUrl, output: () => captured, stop };
    }

    if (Date.now() > deadline) {
      await stop();
      throw new Error(
        `the API did not accept a connection on ${baseUrl} within ` +
          `${String(READY_TIMEOUT_MS)}ms. Its output was:\n${captured}`,
      );
    }

    await new Promise<void>((resolve) => setTimeout(resolve, READY_POLL_MS));
  }
}
