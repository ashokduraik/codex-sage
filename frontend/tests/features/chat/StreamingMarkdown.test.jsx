/**
 * StreamingMarkdown partial fence handling.
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StreamingMarkdown, hasOpenCodeFence } from '@/features/chat/StreamingMarkdown.jsx';

describe('hasOpenCodeFence', () => {
  it('detects an unclosed fence', () => {
    expect(hasOpenCodeFence('```js\nconst x = 1')).toBe(true);
    expect(hasOpenCodeFence('```js\nconst x = 1\n```')).toBe(false);
  });
});

describe('StreamingMarkdown', () => {
  it('renders incomplete fences as plain pre', () => {
    const { container } = render(<StreamingMarkdown content={'```js\nconst x = 1'} />);
    expect(container.querySelector('pre')).toBeTruthy();
    expect(screen.getByText(/const x = 1/)).toBeTruthy();
  });

  it('renders complete markdown including a table', () => {
    render(
      <StreamingMarkdown
        content={`| A | B |
| --- | --- |
| 1 | 2 |`}
      />,
    );
    expect(screen.getByRole('table')).toBeTruthy();
  });
});
