import { afterEach, describe, expect, it, vi } from 'vitest';
import AbstainNotice from '@/shared/components/AbstainNotice';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { clearAuthSession, renderWithProviders } from '@tests/renderWithProviders';

afterEach(() => {
  cleanup();
  localStorage.clear();
});
describe('AbstainNotice', () => {
  it('renders the abstain title and missing items', () => {
    clearAuthSession();
    renderWithProviders(<AbstainNotice missing={['Auth module docs', 'Checkout flow']} />);
    expect(screen.getByText(/does not currently contain enough information/i)).toBeTruthy();
    expect(screen.getByText('Auth module docs')).toBeTruthy();
    expect(screen.getByText('Checkout flow')).toBeTruthy();
  });
  it('invokes retry and narrow callbacks', () => {
    const onRetry = vi.fn();
    const onNarrow = vi.fn();
    renderWithProviders(<AbstainNotice onRetry={onRetry} onNarrow={onNarrow} />);
    fireEvent.click(screen.getByRole('button', { name: /narrower question/i }));
    fireEvent.click(screen.getByRole('button', { name: /Retry/i }));
    expect(onNarrow).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
