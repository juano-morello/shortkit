import { ERROR_CODE_STATUS } from '@shortkit/contracts';

// ADR-0005: the status for a missing resource comes from the shared contract,
// so the dashboard and the API cannot disagree about what `not_found` means.
const NOT_FOUND_STATUS = ERROR_CODE_STATUS.not_found;

export default function NotFound() {
  return (
    <main>
      <h1>{NOT_FOUND_STATUS}</h1>
      <p>No page lives at this address.</p>
    </main>
  );
}
