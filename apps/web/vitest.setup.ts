import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// Vitest runs without global test APIs, so Testing Library's own auto-cleanup
// never registers. Unmount here instead.
afterEach(() => {
  cleanup();
});
