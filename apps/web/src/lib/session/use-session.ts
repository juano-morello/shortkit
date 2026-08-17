'use client';

/**
 * The client-side session hook, split into its own `'use client'` module (TASK-007). It
 * uses React on the client, so it cannot sit in `session.ts`: that module is imported by
 * the BFF route (a server component) for the cookie builders, and a `useState` import in a
 * server-component graph fails the build. `session.ts` RE-EXPORTS `useSession` from here, so
 * the stub's exported name still resolves from `./session`; the `'use client'` boundary
 * keeps the React code out of the server graph.
 *
 * Contract: docs/contracts/web-api-client.md ("Session"). NO token is ever exposed to the
 * client — this reads only the non-sensitive `{ user, status }` projection.
 */
import { useEffect, useState } from 'react';

import type { SessionStatus, SessionUser } from './session';

/** The projection `GET /api/bff/session` returns. */
export const BFF_SESSION_PATH = '/api/bff/session';

/**
 * Reads who is signed in from `GET /api/bff/session` (same-origin; the browser never holds
 * a token). Starts `loading`, then resolves `authenticated` with the user or
 * `unauthenticated`.
 */
export function useSession(): { user: SessionUser | null; status: SessionStatus } {
  const [state, setState] = useState<{ user: SessionUser | null; status: SessionStatus }>({
    user: null,
    status: 'loading',
  });

  useEffect(() => {
    // The in-flight fetch is aborted on unmount, so a late response never sets state on an
    // unmounted component and the request itself is cancelled rather than merely ignored.
    const controller = new AbortController();

    void (async () => {
      try {
        const response = await fetch(BFF_SESSION_PATH, {
          credentials: 'same-origin',
          redirect: 'error',
          signal: controller.signal,
        });

        if (!response.ok) {
          if (!controller.signal.aborted) {
            setState({ user: null, status: 'unauthenticated' });
          }

          return;
        }

        const user = sessionUserFromProjection(await response.json());

        if (!controller.signal.aborted) {
          setState(
            user === null
              ? { user: null, status: 'unauthenticated' }
              : { user, status: 'authenticated' },
          );
        }
      } catch {
        // An abort is the cleanup's doing, not a failure; nothing to render for it.
        if (!controller.signal.aborted) {
          setState({ user: null, status: 'unauthenticated' });
        }
      }
    })();

    return () => {
      controller.abort();
    };
  }, []);

  return state;
}

function sessionUserFromProjection(body: unknown): SessionUser | null {
  if (typeof body !== 'object' || body === null) {
    return null;
  }

  const user = (body as { user?: unknown }).user;

  if (typeof user !== 'object' || user === null) {
    return null;
  }

  const candidate = user as { id?: unknown; email?: unknown; emailVerified?: unknown };

  if (typeof candidate.id !== 'string' || typeof candidate.email !== 'string') {
    return null;
  }

  return {
    id: candidate.id,
    email: candidate.email,
    emailVerified: candidate.emailVerified === true,
  };
}
