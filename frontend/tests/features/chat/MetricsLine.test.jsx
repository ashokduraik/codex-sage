/**
 * MetricsLine renders only backend-provided fields.
 */
import { cleanup, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import MetricsLine from '@/features/chat/MetricsLine.jsx';
import { renderWithProviders } from '@tests/renderWithProviders';

afterEach(() => {
  cleanup();
});

describe('MetricsLine', () => {
  it('renders nothing for empty usage', () => {
    const { container } = renderWithProviders(<MetricsLine message={{ usage: {} }} />);
    expect(container.querySelector('[data-testid="metrics-line"]')).toBeNull();
  });

  it('formats duration and token fields when present', () => {
    renderWithProviders(<MetricsLine message={{ durationMs: 2500, usage: { inputTokens: 1000, outputTokens: 200 } }} />);
    const line = screen.getByTestId('metrics-line');
    expect(line.textContent).toMatch(/2\.5s/);
    expect(line.textContent).toMatch(/1,?000/);
    expect(line.textContent).toMatch(/200/);
  });
});
