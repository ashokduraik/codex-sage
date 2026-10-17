/**
 * EvidenceList collapse / empty behavior.
 */
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import EvidenceList from '@/features/chat/EvidenceList.jsx';
import { renderWithProviders } from '@tests/renderWithProviders';

afterEach(() => {
  cleanup();
});

describe('EvidenceList', () => {
  it('renders nothing for empty evidence', () => {
    const { container } = renderWithProviders(<EvidenceList evidence={[]} projectId="p1" onPreview={() => undefined} />);
    expect(container.textContent).toBe('');
  });

  it('stays collapsed by default and expands on click', () => {
    const onPreview = vi.fn();
    renderWithProviders(
      <EvidenceList
        evidence={[
          {
            evidenceId: 'ev1',
            path: 'src/a.js',
            startLine: 1,
            endLine: 2,
            excerpt: 'const x = 1',
            excludedFromGraph: true,
          },
        ]}
        projectId="p1"
        conversationId="c1"
        onPreview={onPreview}
      />,
    );
    expect(screen.queryByText('const x = 1')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /1 source/i }));
    expect(screen.getByText('const x = 1')).toBeTruthy();
    expect(screen.getByText(/not in the code map/i)).toBeTruthy();
  });
});
