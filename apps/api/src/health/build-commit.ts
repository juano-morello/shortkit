/**
 * ADR: adr-0027-build-commit-provenance.md
 * Produced by: TASK-003
 *
 * THE ONE PLACE THE DEPLOYED COMMIT SHA IS READ, AND IT HAS NO FALLBACK.
 *
 * ADR-0027 settles three things this file implements: the variable is `GIT_COMMIT_SHA`,
 * its value is the full 40-character lowercase hexadecimal SHA of the commit that was
 * built, and its absence refuses. No `??`, no `||`, no default parameter and no sentinel
 * string: `commit: "unknown"` converts a broken build into a running service that lies
 * about its identity, and F-225 records that the spec cannot tell the difference because
 * the spec always sets the variable.
 *
 * Absence refuses at three layers and this is the third. The `Dockerfile`'s runtime stage
 * validates the build argument against the same regex and fails the build; `main.ts`
 * validates it during bootstrap and refuses to start; and this read throws.
 *
 * THE READ IS LAZY, and that is load-bearing rather than stylistic. `app.module.spec.ts`
 * and `common/errors/exception-filter.spec.ts` both compile `AppModule` with no
 * `GIT_COMMIT_SHA` set. A read at module import time or in a provider constructor turns
 * both of them red, and neither file belongs to this TASK.
 */

/**
 * Named here rather than inlined so `main.ts`'s boot refusal and this read cannot drift
 * onto two different variables.
 */
export const GIT_COMMIT_SHA_ENV = 'GIT_COMMIT_SHA';

/**
 * Full length, not abbreviated. One predicate then rejects `unknown`, the empty string, an
 * unexpanded `$(git rev-parse HEAD)`, a branch name, `HEAD`, an uppercase SHA and a
 * seven-character abbreviation. `git rev-parse HEAD` in this repository produces exactly
 * this form: `extensions.objectFormat` is unset, so objects are SHA-1.
 */
const FULL_COMMIT_SHA = /^[0-9a-f]{40}$/;

export function readBuildCommitSha(): string {
  const value = process.env[GIT_COMMIT_SHA_ENV];

  if (value === undefined || !FULL_COMMIT_SHA.test(value)) {
    throw new Error(
      `${GIT_COMMIT_SHA_ENV} must be the full 40-character lowercase hex git SHA of the ` +
        `commit this build was made from, got ${JSON.stringify(value)}. It is baked into ` +
        'the image as a Docker build argument by infra/deploy.sh; deploy through that ' +
        'script rather than through bare `fly deploy` (ADR-0027).',
    );
  }

  return value;
}
