import { render, screen } from '@testing-library/react';
import { ERROR_CODE_STATUS } from '@shortkit/contracts';
import { describe, expect, it } from 'vitest';

import NotFound from './not-found';

describe('NotFound', () => {
  it('shows the status the shared contract assigns to not_found', () => {
    render(<NotFound />);

    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(
      String(ERROR_CODE_STATUS.not_found),
    );
  });

  it('explains what happened', () => {
    render(<NotFound />);

    expect(screen.getByText('No page lives at this address.')).toBeTruthy();
  });
});
