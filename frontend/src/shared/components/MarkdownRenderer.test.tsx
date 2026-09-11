import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import MarkdownRenderer from '@/shared/components/MarkdownRenderer';
import { clearAuthSession, renderWithProviders } from '@/test/renderWithProviders';

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('MarkdownRenderer', () => {
  it('renders a markdown heading', () => {
    clearAuthSession();
    renderWithProviders(<MarkdownRenderer content="# Atlas Overview" />);
    expect(screen.getByRole('heading', { name: 'Atlas Overview' })).toBeTruthy();
  });

  it('renders paragraph content', () => {
    renderWithProviders(<MarkdownRenderer content="Hello **world**" />);
    expect(screen.getByText('world')).toBeTruthy();
  });

  it('renders lists, links, tables, and fenced code with copy', () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    renderWithProviders(
      <MarkdownRenderer
        content={`## Details

- one
- two

1. first

> quote

[Docs](https://example.com)

\`inline\`

\`\`\`ts
const x = 1;
\`\`\`

| Col |
| --- |
| A |

---
`}
      />,
    );

    expect(screen.getByRole('heading', { name: 'Details' })).toBeTruthy();
    expect(screen.getByText('one')).toBeTruthy();
    expect(screen.getByText('first')).toBeTruthy();
    expect(screen.getByText('quote')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Docs' })).toBeTruthy();
    expect(screen.getByText('inline')).toBeTruthy();
    expect(screen.getByText('const x = 1;')).toBeTruthy();
    expect(screen.getByText('A')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /Copy/i }));
    expect(writeText).toHaveBeenCalledWith('const x = 1;');
  });
});
