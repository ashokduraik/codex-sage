/**
 * SupportLevelBanner trust chrome tests.
 */
import { cleanup, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import SupportLevelBanner from '@/features/chat/SupportLevelBanner.jsx';
import { renderWithProviders } from '@tests/renderWithProviders';

afterEach(() => {
  cleanup();
});

describe('SupportLevelBanner', () => {
  it('renders nothing for evidence_backed or missing level', () => {
    const { container, rerender } = renderWithProviders(<SupportLevelBanner supportLevel="evidence_backed" />);
    expect(container.querySelector('[data-support-level]')).toBeNull();
    rerender(<SupportLevelBanner />);
    expect(container.querySelector('[data-support-level]')).toBeNull();
  });

  it('maps abstained status to insufficient copy', () => {
    renderWithProviders(<SupportLevelBanner messageStatus="abstained" />);
    expect(screen.getByText(/Not enough project evidence/i)).toBeTruthy();
  });

  it('renders conflict and partial banners', () => {
    const { rerender } = renderWithProviders(<SupportLevelBanner supportLevel="conflict" />);
    expect(screen.getByText(/Sources disagree/i)).toBeTruthy();
    rerender(<SupportLevelBanner supportLevel="partial" />);
    expect(screen.getByText(/only partially supported/i)).toBeTruthy();
  });
});
